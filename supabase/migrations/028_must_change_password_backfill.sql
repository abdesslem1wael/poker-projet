-- must_change_password was originally added in 011_avatar_password.sql, but
-- some environments (e.g. production) never received that migration, so the
-- column is missing there. Re-add both password-change-tracking columns
-- idempotently, then explicitly backfill existing player accounts so the
-- blocking "change your password" modal reliably appears for them --
-- whether the column above was just created (already defaults to TRUE) or
-- already existed with stale/false values in this database.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

UPDATE profiles
SET must_change_password = TRUE
WHERE role = 'player';
