import { NestFactory } from "@nestjs/core";

import { AppModule } from "../dist/app.module.js";
import { RepurposeService } from "../dist/repurpose/repurpose.service.js";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  const repurpose = app.get(RepurposeService);

  const workspaceId = "01M1KFX35NJRD5N58H0J6YGAPC";
  const userId = "01M1KFX35N4KBEF21BM0HNWPB9";
  const runId = "01M2TVQQBJNDEJSS7MYXCWSBPH";
  const candidateId = "01M2TY0EBWTK4H02473V3Z0HSQ";

  console.log(`Triggering createClip for candidate ${candidateId}...`);
  const result = await repurpose.createClip(workspaceId, userId, runId, candidateId);
  console.log("createClip result:", result);

  await app.close();
}

main().catch((err) => {
  console.error("Error triggering clip:", err);
  process.exit(1);
});
