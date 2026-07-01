-- Sit & Go registration tracking (Step 2). Adds the minimum structure needed
-- to know who has registered and how much they paid. No seating or gameplay
-- wiring yet — that is Step 3.

-- Allow the table to flip to 'ready' once registration fills every seat,
-- alongside the existing 'registering' | 'running' | 'finished' values.
ALTER TABLE poker_tables
  DROP CONSTRAINT IF EXISTS poker_tables_sit_go_status_check;

ALTER TABLE poker_tables
  ADD CONSTRAINT poker_tables_sit_go_status_check
  CHECK (sit_go_status IS NULL OR sit_go_status IN ('registering', 'ready', 'running', 'finished'));

CREATE TABLE sit_go_registrations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id       UUID NOT NULL REFERENCES poker_tables(id) ON DELETE CASCADE,
  player_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  buy_in_paid    INTEGER NOT NULL CHECK (buy_in_paid > 0),
  starting_stack INTEGER NOT NULL CHECK (starting_stack > 0),
  status         TEXT NOT NULL DEFAULT 'registered'
                 CHECK (status IN ('registered', 'eliminated', 'winner'))
);

-- A player can only hold one registration per Sit & Go table.
CREATE UNIQUE INDEX sit_go_registrations_unique_player
  ON sit_go_registrations (table_id, player_id);

ALTER TABLE sit_go_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_sit_go_registrations"
  ON sit_go_registrations FOR SELECT
  USING (auth.role() = 'authenticated');

-- Registers a player for a Sit & Go table in one transaction: validates
-- status/capacity/duplicate registration, deducts the buy-in from their
-- wallet, logs the transaction, inserts the registration row, and flips the
-- table to 'ready' once the last seat fills. The row lock on poker_tables
-- serializes concurrent registration attempts for the same table so two
-- simultaneous clicks (or two devices) can't both grab the last seat or
-- double-spend a wallet.
CREATE OR REPLACE FUNCTION register_sit_go(p_table_id UUID, p_player_id UUID)
RETURNS TABLE (result_status TEXT, result_message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_table poker_tables%ROWTYPE;
  v_registered_count INTEGER;
  v_wallet_chips BIGINT;
BEGIN
  SELECT * INTO v_table FROM poker_tables WHERE id = p_table_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'error', 'Table not found';
    RETURN;
  END IF;

  IF v_table.game_mode != 'sit_go' THEN
    RETURN QUERY SELECT 'error', 'Not a Sit & Go table';
    RETURN;
  END IF;

  IF v_table.sit_go_status IS DISTINCT FROM 'registering' THEN
    RETURN QUERY SELECT 'error', 'Registration is closed for this table';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM sit_go_registrations
    WHERE table_id = p_table_id AND player_id = p_player_id
  ) THEN
    RETURN QUERY SELECT 'error', 'You are already registered for this table';
    RETURN;
  END IF;

  SELECT count(*) INTO v_registered_count
  FROM sit_go_registrations
  WHERE table_id = p_table_id;

  IF v_registered_count >= v_table.max_players THEN
    RETURN QUERY SELECT 'error', 'This table is full';
    RETURN;
  END IF;

  SELECT chips INTO v_wallet_chips FROM wallets WHERE user_id = p_player_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'error', 'Wallet not found';
    RETURN;
  END IF;

  IF v_wallet_chips < v_table.buy_in THEN
    RETURN QUERY SELECT 'error', 'Not enough chips to register.';
    RETURN;
  END IF;

  UPDATE wallets
  SET chips = chips - v_table.buy_in, updated_at = now()
  WHERE user_id = p_player_id;

  INSERT INTO transactions (user_id, amount, type, note)
  VALUES (p_player_id, v_table.buy_in, 'buyin', 'Sit & Go registration: ' || v_table.name);

  INSERT INTO sit_go_registrations (table_id, player_id, buy_in_paid, starting_stack)
  VALUES (p_table_id, p_player_id, v_table.buy_in, v_table.starting_stack);

  v_registered_count := v_registered_count + 1;

  IF v_registered_count >= v_table.max_players THEN
    UPDATE poker_tables SET sit_go_status = 'ready' WHERE id = p_table_id;
  END IF;

  RETURN QUERY SELECT 'ok', 'Registered';
END;
$$;
