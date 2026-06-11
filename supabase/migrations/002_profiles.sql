CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT UNIQUE NOT NULL,
  role       TEXT NOT NULL DEFAULT 'player'
             CHECK (role IN ('admin', 'player')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
