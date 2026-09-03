-- AlterTable
ALTER TABLE "prompted_edit_plans" ADD COLUMN     "current_job_id" CHAR(26),
ADD COLUMN     "remaining_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[];
