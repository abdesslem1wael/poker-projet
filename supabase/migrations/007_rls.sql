-- profiles: players read their own row only
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "players_read_own_profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- wallets: players read their own row only
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "players_read_own_wallet"
  ON wallets FOR SELECT
  USING (auth.uid() = user_id);

-- transactions: players read their own rows only
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "players_read_own_transactions"
  ON transactions FOR SELECT
  USING (auth.uid() = user_id);

-- poker_tables: all authenticated users can read (lobby)
ALTER TABLE poker_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_tables"
  ON poker_tables FOR SELECT
  USING (auth.role() = 'authenticated');

-- game_history: all authenticated users can read
ALTER TABLE game_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_game_history"
  ON game_history FOR SELECT
  USING (auth.role() = 'authenticated');
