-- CreateTable
CREATE TABLE IF NOT EXISTS "workspace_brand_kits" (
    "id" VARCHAR(36) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "logo_url" TEXT,
    "logo_position" TEXT NOT NULL DEFAULT 'TOP_LEFT',
    "logo_scale_pct" INTEGER NOT NULL DEFAULT 15,
    "logo_opacity" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "social_handle" TEXT,
    "intro_video_url" TEXT,
    "outro_video_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_brand_kits_workspace_id_key" ON "workspace_brand_kits"("workspace_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workspace_brand_kits_workspace_id_fkey'
    ) THEN
        ALTER TABLE "workspace_brand_kits" ADD CONSTRAINT "workspace_brand_kits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
