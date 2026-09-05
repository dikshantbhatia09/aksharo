-- S05: a cloud export is a row from POST time; `rendering` covers queued+running.
ALTER TYPE "ExportStatus" ADD VALUE 'rendering';
