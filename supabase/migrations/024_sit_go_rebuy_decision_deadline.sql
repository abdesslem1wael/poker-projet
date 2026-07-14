-- Persists the Sit & Go rebuy/leave decision deadline so it survives a
-- server restart (Railway deploys, crashes, etc.) mid-decision. Without
-- this, the in-memory-only SitGoRebuyManager would simply forget any
-- pending decision on restart -- and since the next hand only ever resumes
-- via the resolve-callback path (resolveSitGoRebuyDecision seeing the last
-- pending player clear), forgetting it would leave the tournament paused
-- forever with no recovery path (Sit & Go has no manual "start hand").
--
-- On boot, server.ts rehydrates every still-open decision from this column
-- and re-arms its timer with the correct remaining time -- same recompute-
-- from-a-persisted-timestamp approach already used for blind levels
-- (sit_go_started_at, see 023_sit_go_time_based_blinds.sql).
ALTER TABLE sit_go_registrations
  ADD COLUMN rebuy_decision_deadline TIMESTAMPTZ;

-- rebuy_sit_go also clears the deadline directly, atomic with the stack/
-- status reset. server.ts's resolveSitGoRebuyDecision clears it too (the
-- authoritative path, covering leave/timeout/admin-kick as well, none of
-- which change status away from 'eliminated' the way a rebuy does) -- this
-- is belt-and-suspenders in case that fire-and-forget Server Action bridge
-- call is ever missed.
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
  SET status = 'registered', current_stack = v_table.starting_stack, rebuy_decision_deadline = NULL
  WHERE id = v_registration.id;

  v_pool_addition := round(v_table.buy_in * (1 - v_table.house_fee_percent / 100.0));

  UPDATE poker_tables
  SET prize_pool = prize_pool + v_pool_addition
  WHERE id = p_table_id;

  RETURN QUERY SELECT 'ok', 'Rebought';
END;
$$;
