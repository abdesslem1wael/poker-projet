-- Avatar selection per player (1–20) + first-login password change flag.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_id INTEGER CHECK (avatar_id BETWEEN 1 AND 20);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;

-- Enforce global avatar uniqueness (no two players share the same avatar).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_avatar_unique ON profiles (avatar_id) WHERE avatar_id IS NOT NULL;
