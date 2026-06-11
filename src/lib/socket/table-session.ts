// DO NOT import 'server-only' here — this file is imported by server.ts (plain
// Node/tsx), which runs outside the Next.js module graph.  The service-role
// Supabase client is created in server.ts and passed in as an argument, so no
// secret is exposed to the client bundle.
import type { TableStatePayload, SeatInfo, SpectatorInfo } from './types'

// Accept any Supabase client (generics differ between createClient call sites).
// Functions cast to `any` internally; return types are still fully typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  status: string
}

type PlayerRow = {
  player_id: string
  seat_number: number | null
  status: 'seated' | 'spectating'
}

type ProfileRow = { id: string; username: string }

// ── Read ───────────────────────────────────────────────────────────────────

export async function getTableState(
  supabase: DB,
  tableId: string
): Promise<TableStatePayload | null> {
  const { data: tableData } = await supabase
    .from('poker_tables')
    .select('id, name, small_blind, big_blind, max_players, status')
    .eq('id', tableId)
    .single()

  if (!tableData) return null
  const table = tableData as TableRow

  const { data: playersData } = await supabase
    .from('table_players')
    .select('player_id, seat_number, status')
    .eq('table_id', tableId)
    .neq('status', 'left')

  const players = (playersData as PlayerRow[] | null) ?? []
  const playerIds = players.map((p) => p.player_id)

  const usernameMap = new Map<string, string>()
  if (playerIds.length > 0) {
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, username')
      .in('id', playerIds)
    for (const p of (profilesData as ProfileRow[] | null) ?? []) {
      usernameMap.set(p.id, p.username)
    }
  }

  const seatMap = new Map<number, { playerId: string; username: string }>()
  const spectators: SpectatorInfo[] = []

  for (const p of players) {
    const username = usernameMap.get(p.player_id) ?? 'Unknown'
    if (p.status === 'seated' && p.seat_number != null) {
      seatMap.set(p.seat_number, { playerId: p.player_id, username })
    } else if (p.status === 'spectating') {
      spectators.push({ playerId: p.player_id, username })
    }
  }

  const seats: SeatInfo[] = Array.from({ length: table.max_players }, (_, i) => {
    const n = i + 1
    const occupant = seatMap.get(n)
    return {
      seatNumber: n,
      playerId: occupant?.playerId ?? null,
      username: occupant?.username ?? null,
    }
  })

  return {
    tableId: table.id,
    tableName: table.name,
    smallBlind: table.small_blind,
    bigBlind: table.big_blind,
    maxPlayers: table.max_players,
    status: table.status as TableStatePayload['status'],
    seats,
    spectators,
  }
}

// ── Write ──────────────────────────────────────────────────────────────────

export async function joinTable(
  supabase: DB,
  tableId: string,
  userId: string
): Promise<{ seatNumber: number } | { error: string }> {
  const { data: tableData } = await supabase
    .from('poker_tables')
    .select('max_players, status')
    .eq('id', tableId)
    .single()

  if (!tableData) return { error: 'Table not found' }
  const table = tableData as { max_players: number; status: string }
  if (table.status === 'closed') return { error: 'Table is closed' }

  // Check for an existing active entry.
  const { data: existingData } = await supabase
    .from('table_players')
    .select('status, seat_number')
    .eq('table_id', tableId)
    .eq('player_id', userId)
    .neq('status', 'left')
    .maybeSingle()

  if (existingData) {
    const existing = existingData as { status: string; seat_number: number | null }
    if (existing.status === 'seated' && existing.seat_number != null) {
      return { seatNumber: existing.seat_number }
    }
    // Currently spectating — upgrade to seated.
    const seat = await findFirstAvailableSeat(supabase, tableId, table.max_players)
    if (seat == null) return { error: 'Table is full' }
    await supabase
      .from('table_players')
      .update({ status: 'seated', seat_number: seat })
      .eq('table_id', tableId)
      .eq('player_id', userId)
      .neq('status', 'left')
    return { seatNumber: seat }
  }

  // First-time join.
  const seat = await findFirstAvailableSeat(supabase, tableId, table.max_players)
  if (seat == null) return { error: 'Table is full' }

  const { error: insertError } = await supabase.from('table_players').insert({
    table_id: tableId,
    player_id: userId,
    seat_number: seat,
    status: 'seated',
  })

  if (insertError) return { error: insertError.message }
  return { seatNumber: seat }
}

export async function spectateTable(
  supabase: DB,
  tableId: string,
  userId: string
): Promise<{ ok: true } | { error: string }> {
  const { data: tableData } = await supabase
    .from('poker_tables')
    .select('status')
    .eq('id', tableId)
    .single()

  if (!tableData) return { error: 'Table not found' }
  if ((tableData as { status: string }).status === 'closed') return { error: 'Table is closed' }

  const { data: existingData } = await supabase
    .from('table_players')
    .select('id')
    .eq('table_id', tableId)
    .eq('player_id', userId)
    .neq('status', 'left')
    .maybeSingle()

  if (existingData) return { ok: true }

  const { error: insertError } = await supabase.from('table_players').insert({
    table_id: tableId,
    player_id: userId,
    seat_number: null,
    status: 'spectating',
  })

  if (insertError) return { error: insertError.message }
  return { ok: true }
}

export async function leaveTable(
  supabase: DB,
  tableId: string,
  userId: string
): Promise<void> {
  await supabase
    .from('table_players')
    .update({ status: 'left', left_at: new Date().toISOString() })
    .eq('table_id', tableId)
    .eq('player_id', userId)
    .neq('status', 'left')
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function findFirstAvailableSeat(
  supabase: DB,
  tableId: string,
  maxPlayers: number
): Promise<number | null> {
  const { data } = await supabase
    .from('table_players')
    .select('seat_number')
    .eq('table_id', tableId)
    .eq('status', 'seated')

  const occupied = new Set(
    ((data as Array<{ seat_number: number | null }> | null) ?? [])
      .map((r) => r.seat_number)
      .filter((n): n is number => n != null)
  )

  for (let i = 1; i <= maxPlayers; i++) {
    if (!occupied.has(i)) return i
  }
  return null
}
