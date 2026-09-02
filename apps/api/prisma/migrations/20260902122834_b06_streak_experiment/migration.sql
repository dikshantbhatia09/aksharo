/*
  Warnings:

  - Added the required column `freezes_month` to the `streak_experiments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- `freezes_month` gets a throwaway default so this migration is safe against a
-- populated table too (the weekly rollover task treats any stale value as "not
-- this month" and resets it on the next tick, same as a brand-new row would).
ALTER TABLE "streak_experiments" ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "credits_only" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "freezes_month" TEXT NOT NULL DEFAULT '1970-01',
ADD COLUMN     "freezes_remaining" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "last_nudge_at" TIMESTAMPTZ(6),
ADD COLUMN     "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "streak_experiments" ALTER COLUMN "freezes_month" DROP DEFAULT;
