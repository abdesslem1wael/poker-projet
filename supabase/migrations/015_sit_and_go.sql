-- Adds Sit & Go as a second table mode alongside the existing cash game tables.
-- Step 1 only: schema + prize pool calculation. No registration, no payouts,
-- no gameplay changes — existing cash tables are unaffected because game_mode
-- defaults to 'cash' and the new columns stay NULL for them.

ALTER TABLE poker_tables
  ADD COLUMN game_mode         TEXT NOT NULL DEFAULT 'cash'
                                CHECK (game_mode IN ('cash', 'sit_go')),
  ADD COLUMN buy_in            INTEGER
                                CHECK (buy_in IS NULL OR buy_in > 0),
  ADD COLUMN starting_stack    INTEGER
                                CHECK (starting_stack IS NULL OR starting_stack > 0),
  ADD COLUMN sit_go_status     TEXT
                                CHECK (sit_go_status IS NULL OR sit_go_status IN ('registering', 'running', 'finished')),
  ADD COLUMN prize_pool        INTEGER
                                CHECK (prize_pool IS NULL OR prize_pool >= 0),
  ADD COLUMN house_fee_percent NUMERIC NOT NULL DEFAULT 10
                                CHECK (house_fee_percent >= 0 AND house_fee_percent <= 100);

-- A Sit & Go row must carry its own fields; a cash row leaves them NULL.
ALTER TABLE poker_tables
  ADD CONSTRAINT sit_go_fields_required CHECK (
    game_mode = 'cash'
    OR (
      buy_in IS NOT NULL
      AND starting_stack IS NOT NULL
      AND sit_go_status IS NOT NULL
      AND prize_pool IS NOT NULL
    )
  );
