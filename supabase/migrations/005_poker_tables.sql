CREATE TABLE poker_tables (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  small_blind INTEGER NOT NULL CHECK (small_blind > 0),
  big_blind   INTEGER NOT NULL CHECK (big_blind = small_blind * 2),
  max_players INTEGER NOT NULL DEFAULT 9 CHECK (max_players BETWEEN 2 AND 9),
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'active', 'closed')),
  created_by  UUID NOT NULL REFERENCES profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
