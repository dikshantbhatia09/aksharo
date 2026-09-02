import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

const execFileAsync = promisify(execFile);

/**
 * Zips `sourceDir` into `destZip` with no external dependency: Node has no built-in zip
 * writer, and adding a native zip package is unnecessary weight for a dry-run CLI, so we
 * shell out to a platform zip tool the way `.ccx`/`.zxp` packaging tools do. Falls back to a
 * manual STORE-only ZIP writer when no system zip tool is present (CI/dry-run fixtures).
 */
export async function zipDirectory(sourceDir: string, destZip: string): Promise<void> {
  if (process.platform === "win32") {
    const ps = `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${destZip}' -Force`;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      return;
    } catch {
      // fall through to manual writer
    }
  } else {
    try {
      await execFileAsync("zip", ["-r", "-X", destZip, "."], { cwd: sourceDir });
      return;
    } catch {
      // fall through to manual writer
    }
  }
  await writeStoreZip(sourceDir, destZip);
}

// --- Minimal STORE-only ZIP writer (no compression) as a dependency-free fallback ---------

interface ZipEntryRecord {
  name: string;
  offset: number;
  crc: number;
  size: number;
}

async function writeStoreZip(sourceDir: string, destZip: string): Promise<void> {
  const files = await listFilesRelative(sourceDir);
  await fs.mkdir(path.dirname(destZip), { recursive: true });
  const out = createWriteStream(destZip);
  const records: ZipEntryRecord[] = [];
  let offset = 0;

  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  for (const rel of files) {
    const abs = path.join(sourceDir, rel);
    const data = await fs.readFile(abs);
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(rel.split(path.sep).join("/"), "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    records.push({ name: rel.split(path.sep).join("/"), offset, crc, size: data.length });
    await write(local);
    await write(nameBuf);
    await write(data);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  for (const rec of records) {
    const nameBuf = Buffer.from(rec.name, "utf8");
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(rec.crc, 16);
    central.writeUInt32LE(rec.size, 20);
    central.writeUInt32LE(rec.size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(rec.offset, 42);
    await write(central);
    await write(nameBuf);
  }
  const centralEnd = offset + sumCentralSize(records);
  const centralSize = centralEnd - centralStart;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  await write(end);

  await new Promise<void>((resolve, reject) => {
    out.end((err: unknown) => (err ? reject(err) : resolve()));
  });
}

function sumCentralSize(records: ZipEntryRecord[]): number {
  return records.reduce((sum, r) => sum + 46 + Buffer.byteLength(r.name, "utf8"), 0);
}

async function listFilesRelative(dir: string, base = dir): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRelative(full, base)));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}
