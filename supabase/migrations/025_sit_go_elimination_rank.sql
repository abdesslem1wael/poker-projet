-- Tracks when each Sit & Go registration was eliminated so the lobby can show
-- a finishing rank per player (1st = winner, then reverse elimination order)
-- instead of just a bare "registered/eliminated" status. Without a timestamp,
-- there'd be no way to order two eliminated players against each other once
-- both rows just say status = 'eliminated'.
ALTER TABLE sit_go_registrations
  ADD COLUMN eliminated_at TIMESTAMPTZ;

-- rebuy_sit_go must clear eliminated_at along with the status/stack reset --
-- a rebought player is back in and no longer has a locked-in finishing
-- position, same reasoning as the rebuy_decision_deadline reset it already
-- does (see 024_sit_go_rebuy_decision_deadline.sql).
CREATE OR REPLACE FUNCTION rebuy_sit_go(p_table_id UUID, p_player_id UUID)
RETURNS TABLE (result_status TEXT, result_message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_table poker_tables%ROWTYPE;
  v_registration sit_go_registrations%ROWTYPE;
  v_wallet_chips BIGINT;
  v_pool_addition INTEGER;
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

  IF v_table.status = 'closed' THEN
    RETURN QUERY SELECT 'error', 'Table is closed';
    RETURN;
  END IF;

  -- sit_go_status flips to 'finished' the moment only one active player
  -- remains (handleSitGoElimination), so gating on 'running' here is
  -- equivalent to "more than one player remains".
  IF v_table.sit_go_status IS DISTINCT FROM 'running' THEN
    RETURN QUERY SELECT 'error', 'Rebuy is not available for this table';
    RETURN;
  END IF;

  SELECT * INTO v_registration
  FROM sit_go_registrations
  WHERE table_id = p_table_id AND player_id = p_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'error', 'You are not registered for this table';
    RETURN;
  END IF;

  IF v_registration.status != 'eliminated' THEN
    RETURN QUERY SELECT 'error', 'You are not eliminated from this table';
    RETURN;
  END IF;

  SELECT chips INTO v_wallet_chips FROM wallets WHERE user_id = p_player_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'error', 'Wallet not found';
    RETURN;
  END IF;

  IF v_wallet_chips < v_table.buy_in THEN
    RETURN QUERY SELECT 'error', 'Not enough chips to rebuy.';
    RETURN;
  END IF;

  UPDATE wallets
  SET chips = chips - v_table.buy_in, updated_at = now()
  WHERE user_id = p_player_id;

  INSERT INTO transactions (user_id, amount, type, note)
  VALUES (p_player_id, v_table.buy_in, 'buyin', 'Sit & Go rebuy: ' || v_table.name);

  UPDATE sit_go_registrations
  SET status = 'registered', current_stack = v_table.starting_stack,
      rebuy_decision_deadline = NULL, eliminated_at = NULL
  WHERE id = v_registration.id;

  v_pool_addition := round(v_table.buy_in * (1 - v_table.house_fee_percent / 100.0));

  UPDATE poker_tables
  SET prize_pool = prize_pool + v_pool_addition
  WHERE id = p_table_id;

  RETURN QUERY SELECT 'ok', 'Rebought';
END;
$$;
