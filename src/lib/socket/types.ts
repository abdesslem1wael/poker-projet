// Socket.io event protocol — shared between server.ts and browser client.
// No engine internals, no hidden card data, no DB row types.

// ── Client → Server ────────────────────────────────────────────────────────
export interface ClientToServerEvents {
  join_table: (payload: { tableId: string }) => void
  spectate_table: (payload: { tableId: string }) => void
  leave_table: (payload: { tableId: string }) => void
}

// ── Public payload types ───────────────────────────────────────────────────
export type SeatInfo = {
  seatNumber: number
  playerId: string | null
  username: string | null
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
}

// ── Server → Client ────────────────────────────────────────────────────────
export interface ServerToClientEvents {
  socket_ready: (payload: { userId: string; username: string }) => void
  table_state: (payload: TableStatePayload) => void
  table_joined: (payload: { tableId: string; seatNumber: number }) => void
  table_left: (payload: { tableId: string }) => void
  spectator_joined: (payload: { tableId: string }) => void
  socket_error: (payload: { message: string }) => void
}

// ── Per-socket server-side data ────────────────────────────────────────────
export interface SocketData {
  userId: string
  username: string
  role: string
  joinedTables: Set<string>
}
