import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function check() {
  console.log("=== MONTAJ DATABASE AUDIT & HEALTH CHECK ===\n");
  try {
    // Repurpose runs
    const allRepurpose = await prisma.repurposeRun.findMany({
      take: 25,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        workspaceId: true,
        sourceKind: true,
        sourceDisplay: true,
        status: true,
        currentStage: true,
        failureCode: true,
        progress: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    console.log(`\n--- ALL REPURPOSE RUNS (Found ${allRepurpose.length}) ---`);
    console.log(JSON.stringify(allRepurpose, null, 2));

    // Feature flags check
    const flags = await prisma.featureFlag.findMany();
    console.log(`\n--- FEATURE FLAGS (${flags.length}) ---`);
    console.log(
      JSON.stringify(
        flags.map((f) => ({
          name: f.name,
          enabled: f.enabled,
          rolloutPercentage: f.rolloutPercentage,
        })),
        null,
        2,
      ),
    );

    // Access logs: check recent 4xx/5xx errors
    const errorAccessLogs = await prisma.accessLog.findMany({
      where: { statusCode: { gte: 400 } },
      take: 25,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        method: true,
        route: true,
        statusCode: true,
        errorCode: true,
        clientIp: true,
        createdAt: true,
      },
    });
    console.log(`\n--- RECENT 4XX/5XX ACCESS LOGS (Found ${errorAccessLogs.length}) ---`);
    console.log(JSON.stringify(errorAccessLogs, null, 2));

    // Audit logs: check recent actions
    const auditLogs = await prisma.auditLog.findMany({
      take: 20,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        action: true,
        actorType: true,
        targetType: true,
        targetId: true,
        details: true,
        createdAt: true,
      },
    });
    console.log(`\n--- RECENT AUDIT LOGS (Found ${auditLogs.length}) ---`);
    console.log(JSON.stringify(auditLogs, null, 2));
  } catch (err) {
    console.error("Error during DB audit:", err);
  } finally {
    await prisma.$disconnect();
  }
}

check();
