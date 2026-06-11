CREATE TABLE transactions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount     BIGINT NOT NULL CHECK (amount > 0),
  type       TEXT NOT NULL
             CHECK (type IN ('credit', 'debit', 'buyin', 'cashout', 'win', 'loss')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
