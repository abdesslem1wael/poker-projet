-- Cash-game "sit out" mode: after a player times out on their turn once, they
-- stay seated (cards, blinds, seat all continue as normal) but every future
-- turn is auto-checked/auto-folded instantly instead of running the normal
-- countdown timer, until they explicitly click Rejoin. Sit & Go never sets
-- this — its timeout behavior is unchanged.
ALTER TABLE table_players
  ADD COLUMN is_sitting_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sitting_out_since TIMESTAMPTZ;
