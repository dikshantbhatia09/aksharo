import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const clips = await prisma.repurposeClip.findMany();
  console.log("=== REPURPOSE CLIPS ===");
  console.log(JSON.stringify(clips, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  const jobs = await prisma.job.findMany({
    where: { type: "media.clip" },
    orderBy: { queuedAt: "desc" },
    take: 5,
  });
  console.log("=== RECENT MEDIA.CLIP JOBS ===");
  console.log(JSON.stringify(jobs, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  const run = await prisma.repurposeRun.findUnique({
    where: { id: "01M2TVQQBJNDEJSS7MYXCWSBPH" },
  });
  console.log("=== RUN ===");
  console.log(JSON.stringify(run, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  if (run && run.sourceProjectId) {
    const assets = await prisma.mediaAsset.findMany({
      where: { projectId: run.sourceProjectId },
    });
    console.log("=== SOURCE MEDIA ASSETS ===");
    console.log(JSON.stringify(assets, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }

  await prisma.$disconnect();
}

main().catch(console.error);
