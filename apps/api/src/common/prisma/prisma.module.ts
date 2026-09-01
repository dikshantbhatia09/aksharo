import { Global, Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service.js";

/**
 * Global so that feature modules do not each have to import it. There is exactly
 * one connection pool per process; a second `PrismaClient` would double the
 * connection count against the same Postgres.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
