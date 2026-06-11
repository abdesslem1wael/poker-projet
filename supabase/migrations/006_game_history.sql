CREATE TABLE game_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id         UUID NOT NULL REFERENCES poker_tables(id),
  hand_number      INTEGER NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  result_json      JSONB,
  chip_deltas_json JSONB
);
