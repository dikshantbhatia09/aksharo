/*
  Warnings:

  - You are about to drop the column `caps` on the `export_manifests` table. All the data in the column will be lost.
  - You are about to drop the column `codec_ladder` on the `export_manifests` table. All the data in the column will be lost.
  - You are about to drop the column `signature` on the `export_manifests` table. All the data in the column will be lost.
  - You are about to drop the column `watermark` on the `export_manifests` table. All the data in the column will be lost.
  - Added the required column `workspace_id` to the `exports` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('pending_browser', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "export_manifests" DROP COLUMN "caps",
DROP COLUMN "codec_ladder",
DROP COLUMN "signature",
DROP COLUMN "watermark",
ADD COLUMN     "consumes_nine_pass" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consumes_signup_gift" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manifest" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "exports" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "status" "ExportStatus" NOT NULL DEFAULT 'pending_browser',
ADD COLUMN     "workspace_id" CHAR(26) NOT NULL;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "signup_gift_consumed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "brand_assets" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'watermark',
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_assets_workspace_id_idx" ON "brand_assets"("workspace_id");

-- CreateIndex
CREATE INDEX "exports_workspace_id_idx" ON "exports"("workspace_id");

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
