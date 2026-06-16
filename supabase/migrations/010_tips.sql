-- Voluntary dealer tips sent by players after winning a hand.
-- Automatic 2% rake is stored in game_history.result_json.tipAmount.
CREATE TABLE dealer_tips (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id     UUID        NOT NULL REFERENCES poker_tables(id) ON DELETE CASCADE,
  hand_number  INTEGER     NOT NULL,
  player_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount       INTEGER     NOT NULL CHECK (amount > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX dealer_tips_table_idx ON dealer_tips (table_id);
