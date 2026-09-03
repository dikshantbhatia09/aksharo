-- D08: eval harness runs/results and the routing-freeze switch.

CREATE TABLE "eval_runs" (
    "id" CHAR(26) NOT NULL,
    "trigger" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "routing_frozen" BOOLEAN NOT NULL DEFAULT false,
    "git_sha" TEXT,
    "summary" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "eval_runs_created_at_idx" ON "eval_runs"("created_at");

CREATE TABLE "eval_results" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "dataset" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "provider" TEXT,
    "metric_name" TEXT NOT NULL,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "item_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "eval_results_dataset_language_metric_name_created_at_idx"
    ON "eval_results"("dataset", "language", "metric_name", "created_at");
CREATE INDEX "eval_results_run_id_idx" ON "eval_results"("run_id");

ALTER TABLE "eval_results"
    ADD CONSTRAINT "eval_results_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "eval_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "routing_freeze" (
    "id" VARCHAR(16) NOT NULL DEFAULT 'singleton',
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "updated_by" CHAR(26),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_freeze_pkey" PRIMARY KEY ("id")
);
