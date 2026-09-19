import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.R2_ENDPOINT || "http://127.0.0.1:9000",
  region: "auto",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY || "montaj-local",
    secretAccessKey: process.env.R2_SECRET_KEY || "montaj-local-secret",
  },
  forcePathStyle: true,
});

async function main() {
  const bucket = process.env.STORAGE_DERIVED_BUCKET || "montaj-derived";
  const key =
    "ws/01M1KFX35NJRD5N58H0J6YGAPC/p/01M2TVQQBTH5VM14XD8A5GESDJ/repurpose/01M2TVQQBJNDEJSS7MYXCWSBPH/clips/01M2TY0EBWTK4H02473V3Z0HSQ/master.mp4";

  console.log(`Fetching ${key} from ${bucket}...`);
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const outPath = path.resolve("../../scratch/downloaded_clip_master.mp4");
  const fileStream = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    resp.Body.pipe(fileStream);
    resp.Body.on("error", reject);
    fileStream.on("finish", resolve);
  });
  console.log(`Saved to ${outPath}, size:`, fs.statSync(outPath).size);

  const probe = execSync(
    `ffprobe -v error -show_entries stream=width,height,duration,codec_name -of json "${outPath}"`,
    { encoding: "utf8" },
  );
  console.log("=== FFPROBE OUTPUT ===");
  console.log(probe);

  const framePath = path.resolve("../../scratch/clip_frame_with_caption.png");
  execSync(`ffmpeg -y -ss 00:00:03.500 -i "${outPath}" -vframes 1 "${framePath}"`);
  console.log(`Extracted frame ${framePath}`);
}

main().catch(console.error);
