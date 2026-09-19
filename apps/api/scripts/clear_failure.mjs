import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.repurposeRun.update({
    where: { id: "01M2TVQQBJNDEJSS7MYXCWSBPH" },
    data: { failureCode: null, status: "review_ready", currentStage: "review", progress: 85 },
  });
  console.log("Cleared failureCode and set status to review_ready");
  await prisma.$disconnect();
}

main().catch(console.error);
