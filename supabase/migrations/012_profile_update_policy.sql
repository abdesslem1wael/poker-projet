-- Allow players to update their own profile row (avatar_id, username, must_change_password).
-- WITH CHECK prevents role escalation: the role column must stay the same value it had
-- before the update (the subquery reads the pre-update committed row under Read Committed).
CREATE POLICY "players_update_own_profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id AND
    role = (SELECT p.role FROM profiles p WHERE p.id = auth.uid())
  );
