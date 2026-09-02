-- B13 — admin roles + step-up TOTP (CONTRACTS §5, amended 2026-09-03).
--
-- `kind: "admin"` joins ClientKind: minted only by `POST /admin/auth/step-up`,
-- 30-minute lifetime, never refreshable, never issued to API keys or
-- plugin/bridge clients. `admin_roles` is the platform-staff permission grant
-- `AdminGuard` re-checks on every `/admin/**` request (immediate revocation,
-- independent of the token's own 30-minute lifetime). `admin_totp` is the only
-- TOTP secret store in the platform — nothing else uses TOTP.

ALTER TYPE "ClientKind" ADD VALUE 'admin';

CREATE TYPE "AdminRoleName" AS ENUM ('support', 'finance', 'ops', 'content', 'superadmin');

CREATE TABLE "admin_roles" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "role" "AdminRoleName" NOT NULL,
    "granted_by" CHAR(26),
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" CHAR(26),

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_roles_user_id_role_key" ON "admin_roles"("user_id", "role");
CREATE INDEX "admin_roles_user_id_revoked_at_idx" ON "admin_roles"("user_id", "revoked_at");

ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_totp" (
    "user_id" CHAR(26) NOT NULL,
    "secret" TEXT NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "verified_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "admin_totp_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "admin_totp" ADD CONSTRAINT "admin_totp_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
