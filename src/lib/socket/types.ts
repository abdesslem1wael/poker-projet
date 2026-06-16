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
  // Live table chat — sender must be seated or spectating this table.
  table_chat_send: (payload: { tableId: string; message: string }) => void
}

// ── Public payload types ───────────────────────────────────────────────────
export type SeatInfo = {
  seatNumber: number
  playerId: string | null
  username: string | null
  avatarId: number | null
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
  status: 'waiting' | 'active' | 'closed'
  seats: SeatInfo[]       // length === maxPlayers; null playerId means empty seat
  spectators: SpectatorInfo[]
  handState: PublicHandState | null  // null when no hand is running
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

// ── Table chat (live-only, not persisted) ──────────────────────────────────
export type ChatMessage = {
  tableId: string
  playerId: string
  username: string
  message: string
  createdAt: string  // ISO timestamp
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
  // Emitted only to the socket(s) of a player who has been removed by admin.
  kicked_from_table: (payload: { tableId: string }) => void
  // Live table chat — broadcast to everyone (seated + spectating) in the table room.
  table_chat_message: (payload: ChatMessage) => void
}

// ── Per-socket server-side data ────────────────────────────────────────────
export interface SocketData {
  userId: string
  username: string
  role: string
  joinedTables: Set<string>   // tables this socket has joined (seated OR spectating)
  seatedAtTables: Set<string> // tables where this socket holds a seat (not spectating)
}
