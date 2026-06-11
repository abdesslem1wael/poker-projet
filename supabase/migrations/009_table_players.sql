-- table_players: tracks who is at each poker table and their role.
CREATE TABLE table_players (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id    UUID NOT NULL REFERENCES poker_tables(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seat_number INTEGER CHECK (seat_number BETWEEN 1 AND 9),
  status      TEXT NOT NULL DEFAULT 'seated'
              CHECK (status IN ('seated', 'spectating', 'left')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ
);

-- One active (seated or spectating) entry per player per table.
CREATE UNIQUE INDEX table_players_active_player
  ON table_players (table_id, player_id)
  WHERE status != 'left';

-- One active player per seat per table.
CREATE UNIQUE INDEX table_players_active_seat
  ON table_players (table_id, seat_number)
  WHERE status = 'seated' AND seat_number IS NOT NULL;

-- All authenticated users can read table state.
ALTER TABLE table_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_table_players"
  ON table_players FOR SELECT
  USING (auth.role() = 'authenticated');

-- Players need to see each other's usernames at the table.
-- Adds alongside the existing own-row policy (Postgres ORs multiple policies).
CREATE POLICY "authenticated_read_all_profiles"
  ON profiles FOR SELECT
  USING (auth.role() = 'authenticated');
