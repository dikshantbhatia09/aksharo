import { describe, expect, it } from "vitest";

import { MediaJobError } from "../errors.js";
import { HTTP_INPUT_ARGS, inputArgs, run } from "./run.js";

/** Node itself is the one binary guaranteed to exist wherever this suite runs. */
const NODE = process.execPath;

describe("inputArgs", () => {
  it("adds HTTP reconnect options for a URL, and nothing for a path", () => {
    // ffmpeg re-opens a presigned URL for every seek; a dropped connection two
    // thirds through an encode would otherwise throw the whole job away.
    expect(inputArgs("https://store.test/x.mp4")).toEqual([
      ...HTTP_INPUT_ARGS,
      "-i",
      "https://store.test/x.mp4",
    ]);
    expect(inputArgs("http://store.test/x.mp4")).toContain("-reconnect_on_network_error");
    expect(inputArgs("/tmp/x.mp4")).toEqual(["-i", "/tmp/x.mp4"]);
    expect(inputArgs("C:\\tmp\\x.mp4")).toEqual(["-i", "C:\\tmp\\x.mp4"]);
  });
});

describe("run", () => {
  it("captures stdout and the exit code", async () => {
    const result = await run(NODE, ["-e", "process.stdout.write('hello')"], {
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("resolves for a non-zero exit rather than throwing", async () => {
    // ffprobe exits 1 on a file it cannot read, and that is a `media/*` answer for
    // the caller to interpret, not a crash.
    const result = await run(NODE, ["-e", "process.exit(3)"], { timeoutMs: 10_000 });
    expect(result.code).toBe(3);
  });

  it("returns the redacted tail of stderr", async () => {
    const script =
      "process.stderr.write('one\\ntwo\\nfailed https://s.test/o?X-Amz-Signature=abc\\n')";
    const result = await run(NODE, ["-e", script], { timeoutMs: 10_000 });
    expect(result.stderr).toContain("two");
    expect(result.stderr).not.toContain("X-Amz-Signature=abc");
  });

  it("streams stderr to onStderr as it arrives, for progress parsing", async () => {
    const chunks: string[] = [];
    await run(NODE, ["-e", "process.stderr.write('out_time_us=1000000\\n')"], {
      timeoutMs: 10_000,
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join("")).toContain("out_time_us=1000000");
  });

  it("kills a process that overruns its timeout, and says so", async () => {
    const error = await run(NODE, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 150 }).catch(
      (caught: unknown) => caught as MediaJobError,
    );
    expect(error).toBeInstanceOf(MediaJobError);
    if (!(error instanceof MediaJobError)) throw error;
    expect(error.code).toBe("media/tool_timeout");
    // Retryable: a wedged encode is a host problem, not the file's.
    expect(error.retryable).toBe(true);
  });

  it("kills a process when the shutdown signal aborts", async () => {
    const controller = new AbortController();
    const promise = run(NODE, ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    const error = await promise.catch((caught: unknown) => caught as MediaJobError);
    expect(error.code).toBe("media/cancelled");
  });

  it("rejects when the binary does not exist", async () => {
    const error = await run("montaj-definitely-not-a-binary", [], { timeoutMs: 5_000 }).catch(
      (caught: unknown) => caught as MediaJobError,
    );
    expect(error).toBeInstanceOf(MediaJobError);
    expect(error.code).toBe("media/tool_spawn");
  });

  it("passes arguments through without a shell, so a hostile filename is just a name", async () => {
    // No shell means no reinterpretation of `;`, `"` or a space (THREAT-MODEL T7).
    const nasty = 'a" ; echo pwned #';
    const result = await run(NODE, ["-e", "process.stdout.write(process.argv[1])", nasty], {
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe(nasty);
  });
});
