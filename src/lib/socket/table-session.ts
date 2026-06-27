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
  table_type: 'timer' | 'open'
  status: string
}

type PlayerRow = {
  player_id: string
  seat_number: number | null
  status: 'seated' | 'spectating'
}

type ProfileRow = { id: string; username: string; avatar_id: number | null }

// ── Read ───────────────────────────────────────────────────────────────────

export async function getTableState(
  supabase: DB,
  tableId: string
): Promise<TableStatePayload | null> {
  const { data: tableData } = await supabase
    .from('poker_tables')
    .select('id, name, small_blind, big_blind, max_players, table_type, status')
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

  const profileMap = new Map<string, { username: string; avatarId: number | null }>()
  if (playerIds.length > 0) {
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, username, avatar_id')
      .in('id', playerIds)
    for (const p of (profilesData as ProfileRow[] | null) ?? []) {
      profileMap.set(p.id, { username: p.username, avatarId: p.avatar_id })
    }
  }

  const seatMap = new Map<number, { playerId: string; username: string; avatarId: number | null }>()
  const spectators: SpectatorInfo[] = []

  for (const p of players) {
    const prof = profileMap.get(p.player_id)
    const username = prof?.username ?? 'Unknown'
    const avatarId = prof?.avatarId ?? null
    if (p.status === 'seated' && p.seat_number != null) {
      seatMap.set(p.seat_number, { playerId: p.player_id, username, avatarId })
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
      avatarId: occupant?.avatarId ?? null,
    }
  })

  return {
    tableId: table.id,
    tableName: table.name,
    smallBlind: table.small_blind,
    bigBlind: table.big_blind,
    maxPlayers: table.max_players,
    tableType: table.table_type,
    status: table.status as TableStatePayload['status'],
    seats,
    spectators,
    handState: null,  // populated by GameManager in the socket server
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

// Safety net: removes duplicate active rows for the same player or same seat.
// DB unique constraints normally prevent this; this catches races or pre-existing bugs.
// Returns the number of rows marked left.
export async function cleanupTableSeats(supabase: DB, tableId: string): Promise<number> {
  const { data } = await supabase
    .from('table_players')
    .select('id, player_id, seat_number, status, joined_at')
    .eq('table_id', tableId)
    .neq('status', 'left')
    .order('joined_at', { ascending: false })

  if (!data || data.length === 0) return 0

  const rows = data as Array<{
    id: string
    player_id: string
    seat_number: number | null
    status: string
    joined_at: string
  }>

  const toMarkLeft = new Set<string>()

  // Deduplicate by player_id — rows ordered newest-first, so first seen wins.
  const seenPlayers = new Set<string>()
  for (const row of rows) {
    if (seenPlayers.has(row.player_id)) {
      toMarkLeft.add(row.id)
    } else {
      seenPlayers.add(row.player_id)
    }
  }

  // Deduplicate by seat_number — same tie-break, skip already-evicted rows.
  const seenSeats = new Set<number>()
  for (const row of rows) {
    if (toMarkLeft.has(row.id)) continue
    if (row.seat_number == null || row.status !== 'seated') continue
    if (seenSeats.has(row.seat_number)) {
      toMarkLeft.add(row.id)
    } else {
      seenSeats.add(row.seat_number)
    }
  }

  if (toMarkLeft.size === 0) return 0

  console.log(`[cleanup] deduplicating ${toMarkLeft.size} stale rows  table=${tableId}`)
  await supabase
    .from('table_players')
    .update({ status: 'left', left_at: new Date().toISOString() })
    .in('id', Array.from(toMarkLeft))

  return toMarkLeft.size
}

// ── Write ──────────────────────────────────────────────────────────────────

export async function joinTable(
  supabase: DB,
  tableId: string,
  userId: string
): Promise<{ seatNumber: number } | { error: string }> {
  const { data: profileData } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()
  if ((profileData as { role: string } | null)?.role === 'super_admin') {
    return { error: 'Super Admin accounts cannot join tables as players.' }
  }

  const { data: tableData } = await supabase
    .from('poker_tables')
    .select('max_players, status')
    .eq('id', tableId)
    .single()

  if (!tableData) return { error: 'Table not found' }
  const table = tableData as { max_players: number; status: string }
  if (table.status === 'closed') return { error: 'Table is closed' }

  // Check for an existing active entry for THIS user only — never reuse another player's row.
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
      console.log(`[join] userId=${userId} tableId=${tableId} already seated at seat=${existing.seat_number}`)
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
    console.log(`[join] userId=${userId} tableId=${tableId} upgraded spectator to seat=${seat}`)
    return { seatNumber: seat }
  }

  // First-time join: find an available seat and insert.
  const seat = await findFirstAvailableSeat(supabase, tableId, table.max_players)
  if (seat == null) return { error: 'Table is full' }

  console.log(`[join] userId=${userId} tableId=${tableId} inserting at seat=${seat}`)

  const { error: insertError } = await supabase.from('table_players').insert({
    table_id: tableId,
    player_id: userId,
    seat_number: seat,
    status: 'seated',
  })

  if (insertError) {
    // Unique constraint fired — a concurrent join for this exact user completed first.
    // Re-fetch THIS user's row only; never fall back to any other player's row.
    console.log(`[join] insert conflict  userId=${userId} tableId=${tableId} — re-fetching own row`)
    const { data: retryData } = await supabase
      .from('table_players')
      .select('status, seat_number')
      .eq('table_id', tableId)
      .eq('player_id', userId)
      .neq('status', 'left')
      .maybeSingle()
    if (retryData) {
      const retry = retryData as { status: string; seat_number: number | null }
      if (retry.status === 'seated' && retry.seat_number != null) {
        return { seatNumber: retry.seat_number }
      }
    }
    return { error: insertError.message }
  }

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
    .update({ status: 'left', seat_number: null, left_at: new Date().toISOString() })
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
