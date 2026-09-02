-- B08: Agency client separation extends to folders, not only projects.
--
-- `projects.client_tag` already exists (A06 seeded it per 06 §ERD); a folder had
-- no equivalent column, so an agency workspace could tag a project but not the
-- folder holding several of a client's projects. Free-text, exactly like
-- `projects.client_tag` -- there is no `clients` table in 06 to foreign-key to.

ALTER TABLE "folders"
  ADD COLUMN "client_tag" TEXT;

CREATE INDEX "folders_workspace_id_client_tag_idx"
  ON "folders" ("workspace_id", "client_tag");
