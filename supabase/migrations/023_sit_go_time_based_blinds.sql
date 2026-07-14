-- Sit & Go blind levels now advance on a wall-clock schedule (every 7
-- minutes) instead of after a fixed number of hands. sit_go_started_at
-- records the moment the tournament actually begins -- set once, atomically,
-- alongside the sit_go_status 'ready' -> 'running' transition in server.ts --
-- so the current level can always be recomputed from elapsed real time (on a
-- reconnect, a fresh table_state fetch, a server restart, or the periodic
-- sweep) instead of depending on an in-memory/per-connection timer that could
-- reset.
ALTER TABLE poker_tables
  ADD COLUMN sit_go_started_at TIMESTAMPTZ;

-- Hand-count-based leveling is retired in favor of the timer above.
ALTER TABLE poker_tables
  DROP COLUMN sit_go_hands_completed;
