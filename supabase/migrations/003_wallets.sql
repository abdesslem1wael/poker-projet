CREATE TABLE wallets (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  chips      BIGINT NOT NULL DEFAULT 0 CHECK (chips >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
