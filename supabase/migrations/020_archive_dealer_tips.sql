-- Cleanup: tournament_*, and archived_table_tips are leftovers from a
-- tournament/tips feature that was built then reverted in code, but never
-- cleaned up in the database. Nothing in the current codebase references
-- them (verified: no "tournament_players" / "archived_table_tips" hits
-- anywhere in src/, server.ts, or other migrations). dealer_tips itself
-- (defined in 010_tips.sql) was apparently swept up in that same cleanup
-- and no longer exists live, even though the app still writes tips to it
-- (see server.ts's send_tip handler) — so tip collection has been silently
-- failing. This migration removes the orphaned tables and (re)creates
-- dealer_tips with archiving support built in from the start.
DROP TABLE IF EXISTS tournament_payouts CASCADE;
DROP TABLE IF EXISTS tournament_players CASCADE;
DROP TABLE IF EXISTS tournament_blind_levels CASCADE;
DROP TABLE IF EXISTS tournaments CASCADE;
DROP TABLE IF EXISTS archived_table_tips CASCADE;

-- Voluntary dealer tips sent by players after winning a hand. Automatic
-- rake is stored separately in game_history.result_json.tipAmount.
--
-- table_id is nullable and ON DELETE SET NULL (not CASCADE): deleting a
-- table must never destroy its tip history. When a table is deleted, the
-- trigger below archives the affected rows first (capturing the table's id
-- and name) before the FK nulls out table_id. Tips are only ever
-- hard-deleted via an explicit admin action on the tips themselves
-- (see deleteDealerTipsAction), never as a side effect of table deletion.
CREATE TABLE IF NOT EXISTS dealer_tips (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id            UUID        REFERENCES poker_tables(id) ON DELETE SET NULL,
  hand_number         INTEGER     NOT NULL,
  player_id           UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount              INTEGER     NOT NULL CHECK (amount > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived            BOOLEAN     NOT NULL DEFAULT false,
  archived_at         TIMESTAMPTZ,
  deleted_table_id    UUID,
  deleted_table_name  TEXT
);

CREATE INDEX IF NOT EXISTS dealer_tips_table_idx ON dealer_tips (table_id);

-- In case dealer_tips already existed (e.g. 010_tips.sql ran previously in
-- this environment) with the old NOT NULL / CASCADE shape, bring it up to
-- the same shape as the CREATE TABLE above.
ALTER TABLE dealer_tips ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dealer_tips ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE dealer_tips ADD COLUMN IF NOT EXISTS deleted_table_id UUID;
ALTER TABLE dealer_tips ADD COLUMN IF NOT EXISTS deleted_table_name TEXT;
ALTER TABLE dealer_tips ALTER COLUMN table_id DROP NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dealer_tips_table_id_fkey'
  ) THEN
    ALTER TABLE dealer_tips DROP CONSTRAINT dealer_tips_table_id_fkey;
  END IF;

  ALTER TABLE dealer_tips
    ADD CONSTRAINT dealer_tips_table_id_fkey
    FOREIGN KEY (table_id) REFERENCES poker_tables(id) ON DELETE SET NULL;
END $$;

-- Runs BEFORE poker_tables' row is removed (and before the FK's ON DELETE
-- SET NULL fires), so it's the only place that still has both OLD.id and
-- OLD.name available. Trigger-level rather than relying solely on
-- application code, so any deletion path (not just deleteTableAction)
-- archives tips instead of losing the table's identity.
CREATE OR REPLACE FUNCTION archive_dealer_tips_on_table_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE dealer_tips
  SET archived = true,
      archived_at = now(),
      deleted_table_id = OLD.id,
      deleted_table_name = OLD.name
  WHERE table_id = OLD.id AND archived = false;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_archive_dealer_tips_on_table_delete ON poker_tables;
CREATE TRIGGER trg_archive_dealer_tips_on_table_delete
  BEFORE DELETE ON poker_tables
  FOR EACH ROW
  EXECUTE FUNCTION archive_dealer_tips_on_table_delete();
