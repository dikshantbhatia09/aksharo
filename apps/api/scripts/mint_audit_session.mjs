import crypto from "node:crypto";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function sha256Hex(val) {
  return crypto.createHash("sha256").update(val).digest("hex");
}

async function mint() {
  const user = await prisma.user.findFirst({
    where: { email: "dikshantbhatia36@gmail.com" },
  });
  if (!user) {
    console.log("User not found");
    return;
  }
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
  });

  const refreshToken = crypto.randomBytes(32).toString("base64url");
  const hash = sha256Hex(refreshToken);

  const session = await prisma.session.create({
    data: {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase(),
      userId: user.id,
      workspaceId: membership.workspaceId,
      kind: "web",
      familyId: crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase(),
      refreshTokenHash: hash,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      ip: "127.0.0.1",
      ua: "AksharoAuditPlaywright/1.0",
    },
  });

  console.log("MINTED_SESSION:", {
    sessionId: session.id,
    userId: user.id,
    workspaceId: membership.workspaceId,
    refreshToken,
  });

  await prisma.$disconnect();
}

mint().catch(console.error);
