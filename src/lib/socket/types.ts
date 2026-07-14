// Socket.io event protocol — shared between server.ts and browser client.
// No engine internals, no hidden card data, no DB row types.

// ── Card types ─────────────────────────────────────────────────────────────
// Inlined here (matches poker/types.ts structurally) so the client bundle does
// not pull in any server-side poker modules.
export type CardSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
export type Card = { suit: CardSuit; rank: CardRank }

// ── Betting ────────────────────────────────────────────────────────────────
export type BettingAction = 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN'

// ── Per-player public hand state ───────────────────────────────────────────
export type PlayerPhase = 'active' | 'folded' | 'all-in'

export type PublicPlayerHandState = {
  playerId: string
  seatNumber: number
  stack: number
  roundContribution: number   // chips put in during the current betting round
  totalContributed: number    // chips put in across all rounds this hand
  playerPhase: PlayerPhase
  hasActedThisRound: boolean
  // Hole cards are never included here — they arrive via the private deal_cards event.
}

// ── Public hand state ──────────────────────────────────────────────────────
export type PublicHandState = {
  handNumber: number
  phase: 'PRE_FLOP' | 'FLOP' | 'TURN' | 'RIVER'
  pot: number
  currentBet: number
  minRaise: number
  currentTurnPlayerId: string | null
  dealerSeatNumber: number
  smallBlindSeatNumber: number
  bigBlindSeatNumber: number
  communityCards: Card[]
  players: PublicPlayerHandState[]
}

// ── Live reactions (targeted, not persisted) ───────────────────────────────
export type ReactionType = 'trash' | 'tissue'

// ── Client → Server ────────────────────────────────────────────────────────
export interface ClientToServerEvents {
  join_table: (payload: { tableId: string }) => void
  spectate_table: (payload: { tableId: string }) => void
  leave_table: (payload: { tableId: string }) => void
  start_hand: (payload: { tableId: string }) => void
  player_action: (payload: {
    tableId: string
    action: BettingAction
    amount?: number  // for RAISE: the new total bet level; omitted for other actions
  }) => void
  // Voluntary tip sent by a player after winning a hand.
  send_tip: (payload: {
    tableId: string
    handNumber: number
    amount: number
  }) => void
  // Player voluntarily reveals their hole cards after folding.
  reveal_hand: (payload: {
    tableId: string
    handNumber: number
    cards: [Card, Card]
  }) => void
  // Admin: extend a table's active session.
  extend_session: (payload: { tableId: string; additionalMinutes: number }) => void
  // Admin: remove a seated player from a table.
  kick_player: (payload: { tableId: string; playerId: string }) => void
  // Admin: start a scheduled break for a table.
  start_break: (payload: { tableId: string }) => void
  // Admin: announce that only `count` more hands will be played, then the
  // (cash-only) table closes automatically after the final one finishes.
  // Acknowledged — the admin UI needs a definite success/failure response
  // rather than inferring it from a broadcast that might never arrive.
  start_last_hands: (
    payload: { tableId: string; count: number },
    callback: (response: { ok: true } | { ok: false; error: string }) => void
  ) => void
  // Admin/super_admin: top up an active Last Hands countdown (never resets it). Acknowledged.
  add_last_hands: (
    payload: { tableId: string; additional: number },
    callback: (response: { ok: true } | { ok: false; error: string }) => void
  ) => void
  // Live table chat — sender must be seated or spectating this table.
  table_chat_send: (payload: { tableId: string; message: string }) => void
  // Targeted live reaction (e.g. Trash / Tissue) flown from sender seat to a target
  // player's seat. Purely visual — never persisted, never touches game state.
  send_reaction: (payload: { tableId: string; toPlayerId: string; reactionType: ReactionType }) => void
}

// ── Public payload types ───────────────────────────────────────────────────
export type SeatInfo = {
  seatNumber: number
  playerId: string | null
  username: string | null
  avatarId: number | null
  eliminated: boolean  // Sit & Go only — always false for cash tables
}

export type SpectatorInfo = {
  playerId: string
  username: string
}

export type TableStatePayload = {
  tableId: string
  tableName: string
  smallBlind: number
  bigBlind: number
  maxPlayers: number
  tableType: 'timer' | 'open'
  status: 'waiting' | 'active' | 'closed'
  seats: SeatInfo[]       // length === maxPlayers; null playerId means empty seat
  spectators: SpectatorInfo[]
  handState: PublicHandState | null  // null when no hand is running
  // ── Sit & Go (Step 3) ──────────────────────────────────────────────────
  gameMode: 'cash' | 'sit_go'
  prizePool: number | null       // null for cash tables
  sitGoStatus: 'registering' | 'ready' | 'running' | 'finished' | null  // null for cash tables
  // ── Sit & Go blind levels (Step 6) ──────────────────────────────────────
  // smallBlind/bigBlind above are already the CURRENT blinds for the table —
  // blindLevel is purely informational for the "Level N" badge/card display.
  blindLevel: number | null      // null for cash tables
  // ── Sit & Go rebuy display (Step 7) ──────────────────────────────────────
  buyIn: number | null           // null for cash tables
  startingStack: number | null   // null for cash tables
  // ── Last Hands (admin countdown to auto-close) ──────────────────────────
  // Sourced straight from poker_tables (the source of truth) — never from
  // the server's in-memory cache — so reconnecting/joining sockets always
  // see the persisted value, even right after a server restart.
  lastHandsRemaining: number | null   // null when not active (cash tables only)
}

// ── Showdown result (broadcast when a hand ends) ───────────────────────────

export type ShowdownPotResult = {
  amount: number
  winners: string[]         // playerIds
  winnerHandRank: number    // HandRank enum value (0 = no evaluation, e.g. all_folded)
  winnerHandName: string
}

export type ShowdownPlayerResult = {
  playerId: string
  username: string
  seatNumber: number
  finalStack: number        // stack after pot distribution
  chipDelta: number         // chips received from all pots (≥ 0)
  netChipChange: number     // chipDelta − totalContributed (positive = profit, negative = loss)
  hasFolded: boolean
  holeCards: [Card, Card] | null  // null when all_folded (no showdown reveal)
  bestHand: [Card, Card, Card, Card, Card] | null  // exact 5-card winning combination; null for folded/all_folded
  handName: string | null   // e.g. "Flush" — null for folded or all_folded scenarios
}

export type ShowdownPayload = {
  tableId: string
  handNumber: number
  reason: 'all_folded' | 'showdown'
  pots: ShowdownPotResult[]
  players: ShowdownPlayerResult[]
  communityCards: Card[]
  tipAmount: number  // automatic rake — admin-only display, not sent to regular players
}

// ── Break scheduling ────────────────────────────────────────────────────────
export type BreakPhase = 'countdown' | 'awaiting_hand_end' | 'active'

export type BreakStatePayload = {
  tableId: string
  phase: BreakPhase | null   // null = no break in progress (used to explicitly clear client state)
  countdownSecondsRemaining: number  // meaningful while phase === 'countdown'
  breakSecondsRemaining: number      // meaningful while phase === 'active'
}

// ── Last Hands (admin-triggered countdown to a cash table's auto-close) ────
export type LastHandsStatePayload = {
  tableId: string
  remaining: number | null   // null = not active (or the table has since closed)
}

// ── Table chat (live-only, not persisted) ──────────────────────────────────
export type ChatMessage = {
  tableId: string
  playerId: string
  username: string
  message: string
  createdAt: string  // ISO timestamp
}

// ── Sit & Go rebuy/leave decision window (Fix 5) ────────────────────────────
// Sit & Go only. When a hand eliminates one or more registered players and
// the tournament isn't over, the next hand is paused until every player in
// pendingPlayerIds has rebought, left, or their individual 65s decision
// window has timed out (auto-treated as Leave). All players eliminated in
// the same hand share one deadline, hence a single secondsRemaining here.
export type SitGoRebuyStatePayload = {
  tableId: string
  pendingPlayerIds: string[]   // empty = no decision pending, next hand may proceed
  secondsRemaining: number     // 0 when pendingPlayerIds is empty
}

// ── Server → Client ────────────────────────────────────────────────────────
export interface ServerToClientEvents {
  socket_ready: (payload: { userId: string; username: string }) => void
  table_state: (payload: TableStatePayload) => void
  table_joined: (payload: { tableId: string; seatNumber: number }) => void
  table_left: (payload: { tableId: string }) => void
  spectator_joined: (payload: { tableId: string }) => void
  socket_error: (payload: { message: string }) => void
  // ── Hand events ──────────────────────────────────────────────────────────
  deal_cards: (payload: {
    tableId: string
    holeCards: [Card, Card]   // sent only to the player whose cards these are
  }) => void
  action_result: (payload: {
    tableId: string
    playerId: string
    action: BettingAction
    amount: number
  }) => void
  showdown_result: (payload: ShowdownPayload) => void
  // Emitted when the acting player changes. Client starts a countdown;
  // server auto-acts (check or fold) when the timer expires.
  turn_timer_start: (payload: {
    tableId: string
    playerId: string   // whose turn it is
    seconds: number    // time remaining (may be < full timeout on reconnect)
  }) => void
  // Emitted after a hand ends; clients show a countdown then the next hand auto-starts.
  next_hand_countdown: (payload: {
    tableId: string
    seconds: number
  }) => void
  // Sit & Go: emitted to every registered player's socket(s) the instant the
  // table fills up and is auto-seated — the lobby client should navigate to
  // the table without waiting for a click.
  sit_go_table_ready: (payload: { tableId: string }) => void
  // Sit & Go: emitted to the table room when the pre-first-hand countdown
  // begins, and re-emitted with the accurate remaining time to any socket
  // that joins/reconnects mid-countdown.
  sit_go_starting_countdown: (payload: { tableId: string; seconds: number }) => void
  // Emitted when all players are all-in and the remaining streets will be auto-dealt.
  runout_cards_revealed: (payload: {
    tableId: string
    players: Array<{ playerId: string; cards: [Card, Card] }>
  }) => void
  // Emitted when a player voluntarily shows their folded hole cards.
  hand_revealed: (payload: {
    tableId: string
    playerId: string
    cards: [Card, Card]
  }) => void
  // Emitted every ~5 s to all table members and the admin room.
  session_update: (payload: {
    tableId: string
    tableName: string
    secondsRemaining: number
    isExpired: boolean
  }) => void
  // Emitted only to the socket(s) of a player who has been removed from a table.
  kicked_from_table: (payload: { tableId: string; reason: 'out_of_chips' | 'admin_kicked' | 'rebuy_timeout' }) => void
  // Sit & Go only: broadcast to the whole table whenever the pending rebuy/
  // leave decision set changes (started, a player resolves, or a reconnect
  // needs the current state resent). Empty pendingPlayerIds clears it.
  sit_go_rebuy_update: (payload: SitGoRebuyStatePayload) => void
  // Emitted on break state changes and periodically while a break is scheduled/running.
  break_update: (payload: BreakStatePayload) => void
  // Persistent Last Hands countdown state — drives the "Last hands: X" badge.
  // Sent on every change and replayed to reconnecting/joining sockets.
  last_hands_update: (payload: LastHandsStatePayload) => void
  // One-shot announcement text for Last Hands events (e.g. "Last 10 hands
  // announced", "9 hands remaining") — shown as a toast, not persisted state.
  last_hands_announcement: (payload: { tableId: string; message: string }) => void
  // Live table chat — broadcast to everyone (seated + spectating) in the table room.
  table_chat_message: (payload: ChatMessage) => void
  // Emitted directly to a player's socket(s) when an admin adjusts their chip balance.
  wallet_update: (payload: { chips: number }) => void
  // Broadcast to everyone at the table when a player sends a targeted live reaction.
  // Purely visual — never persisted, never touches game state.
  reaction_sent: (payload: {
    tableId: string
    fromPlayerId: string
    toPlayerId: string
    reactionType: ReactionType
  }) => void
}

// ── Per-socket server-side data ────────────────────────────────────────────
export interface SocketData {
  userId: string
  username: string
  role: string
  joinedTables: Set<string>   // tables this socket has joined (seated OR spectating)
  seatedAtTables: Set<string> // tables where this socket holds a seat (not spectating)
}
