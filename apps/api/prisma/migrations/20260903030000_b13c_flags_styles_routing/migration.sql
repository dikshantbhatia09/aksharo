-- B13c — style catalogue publish/unpublish, routing weight overrides.

ALTER TABLE "style_presets" ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "routing_weight_overrides" (
    "id" CHAR(26) NOT NULL,
    "lane_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "updated_by" CHAR(26) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "routing_weight_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "routing_weight_overrides_lane_id_provider_key" ON "routing_weight_overrides"("lane_id", "provider");
