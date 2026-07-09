-- Last Hands: admin-triggered countdown to a cash table's auto-close after N
-- more completed hands. Persisted here (not just in-memory) so the countdown
-- survives a server restart/redeploy — server.ts hydrates its in-memory
-- LastHandsManager cache from these columns on boot, and every mutation
-- (start / +5 / decrement-after-hand / auto-close) writes here first.
ALTER TABLE poker_tables
  ADD COLUMN last_hands_active     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN last_hands_remaining  INTEGER CHECK (last_hands_remaining IS NULL OR last_hands_remaining >= 0),
  ADD COLUMN last_hands_started_at TIMESTAMPTZ,
  ADD COLUMN last_hands_started_by UUID REFERENCES profiles(id);
