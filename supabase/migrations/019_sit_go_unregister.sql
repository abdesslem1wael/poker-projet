-- Lets a registered player back out of a Sit & Go before it fills up. Once
-- the table reaches max_players, register_sit_go() flips sit_go_status to
-- 'ready' in the same transaction that seats the last player — so gating on
-- sit_go_status = 'registering' here is equivalent to "not full" and needs
-- no separate capacity check. Refunds the buy-in and deletes the
-- registration row. Same FOR UPDATE locking strategy as register_sit_go so
-- an unregister can't race a concurrent registration for the same table.
CREATE OR REPLACE FUNCTION unregister_sit_go(p_table_id UUID, p_player_id UUID)
RETURNS TABLE (result_status TEXT, result_message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_table poker_tables%ROWTYPE;
  v_registration sit_go_registrations%ROWTYPE;
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

  SELECT * INTO v_registration
  FROM sit_go_registrations
  WHERE table_id = p_table_id AND player_id = p_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'error', 'You are not registered for this table';
    RETURN;
  END IF;

  IF v_table.sit_go_status IS DISTINCT FROM 'registering' THEN
    RETURN QUERY SELECT 'error', 'This table is full — you can no longer unregister';
    RETURN;
  END IF;

  UPDATE wallets
  SET chips = chips + v_registration.buy_in_paid, updated_at = now()
  WHERE user_id = p_player_id;

  INSERT INTO transactions (user_id, amount, type, note)
  VALUES (p_player_id, v_registration.buy_in_paid, 'credit', 'Sit & Go unregister refund: ' || v_table.name);

  DELETE FROM sit_go_registrations WHERE id = v_registration.id;

  RETURN QUERY SELECT 'ok', 'Unregistered';
END;
$$;
