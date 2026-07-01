-- Sit & Go hand-based blind levels (Step 6). We deliberately reuse the
-- existing poker_tables.small_blind/big_blind columns as the CURRENT blinds
-- (doStartHand() already reads them fresh on every hand, so no engine change
-- is needed) and add columns to remember the original level-1 blinds plus
-- the level/hand-count bookkeeping. Cash tables never touch these — they
-- default to blind_level 1, hands_completed 0, and NULL originals — so their
-- blinds never move.

ALTER TABLE poker_tables
  ADD COLUMN blind_level             INTEGER NOT NULL DEFAULT 1 CHECK (blind_level >= 1),
  ADD COLUMN sit_go_hands_completed  INTEGER NOT NULL DEFAULT 0 CHECK (sit_go_hands_completed >= 0),
  ADD COLUMN original_small_blind    INTEGER CHECK (original_small_blind IS NULL OR original_small_blind > 0),
  ADD COLUMN original_big_blind      INTEGER CHECK (original_big_blind IS NULL OR original_big_blind > 0);
