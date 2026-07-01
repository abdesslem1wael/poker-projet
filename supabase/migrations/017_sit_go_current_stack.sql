-- Sit & Go gameplay entry (Step 3). Registered players start a hand with the
-- table's starting_stack, tracked per-registration and updated after every
-- hand — mirroring how cash games persist stacks to `wallets`, but scoped to
-- the tournament instead of the wallet.
--
-- A new column (current_stack) is added rather than overwriting
-- starting_stack, because starting_stack is a historical/audit value (what
-- the player paid in for) while current_stack is the live in-tournament
-- stack the game engine reads and writes every hand. Keeping them separate
-- means we never lose the original buy-in record.

ALTER TABLE sit_go_registrations
  ADD COLUMN current_stack INTEGER;

UPDATE sit_go_registrations SET current_stack = starting_stack WHERE current_stack IS NULL;

ALTER TABLE sit_go_registrations
  ALTER COLUMN current_stack SET NOT NULL,
  ADD CONSTRAINT sit_go_registrations_current_stack_check CHECK (current_stack >= 0);

-- register_sit_go now also seeds current_stack at registration time.
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

  INSERT INTO sit_go_registrations (table_id, player_id, buy_in_paid, starting_stack, current_stack)
  VALUES (p_table_id, p_player_id, v_table.buy_in, v_table.starting_stack, v_table.starting_stack);

  v_registered_count := v_registered_count + 1;

  IF v_registered_count >= v_table.max_players THEN
    UPDATE poker_tables SET sit_go_status = 'ready' WHERE id = p_table_id;
  END IF;

  RETURN QUERY SELECT 'ok', 'Registered';
END;
$$;
