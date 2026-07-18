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
  game_mode: 'cash' | 'sit_go'
  prize_pool: number | null
  sit_go_status: 'registering' | 'ready' | 'running' | 'finished' | null
  blind_level: number
  last_hands_active: boolean
  last_hands_remaining: number | null
  buy_in: number | null
  starting_stack: number | null
}

type PlayerRow = {
  player_id: string
  seat_number: number | null
  status: 'seated' | 'spectating'
  is_sitting_out: boolean
}

type ProfileRow = { id: string; username: string; avatar_id: number | null }

// ── Read ───────────────────────────────────────────────────────────────────

export async function getTableState(
  supabase: DB,
  tableId: string
): Promise<TableStatePayload | null> {
  const { data: tableData } = await supabase
    .from('poker_tables')
    .select('id, name, small_blind, big_blind, max_players, table_type, status, game_mode, prize_pool, sit_go_status, blind_level, last_hands_active, last_hands_remaining, buy_in, starting_stack')
    .eq('id', tableId)
    .single()

  if (!tableData) return null
  const table = tableData as TableRow

  const { data: playersData } = await supabase
    .from('table_players')
    .select('player_id, seat_number, status, is_sitting_out')
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

  // Sit & Go only — lets seats show an "Eliminated" badge for busted players
  // who stay visually seated instead of being removed from table_players.
  const eliminatedIds = new Set<string>()
  if (table.game_mode === 'sit_go' && playerIds.length > 0) {
    const { data: eliminatedRows } = await supabase
      .from('sit_go_registrations')
      .select('player_id')
      .eq('table_id', tableId)
      .eq('status', 'eliminated')
      .in('player_id', playerIds)
    for (const r of (eliminatedRows as Array<{ player_id: string }> | null) ?? []) {
      eliminatedIds.add(r.player_id)
    }
  }

  const seatMap = new Map<number, { playerId: string; username: string; avatarId: number | null; sittingOut: boolean }>()
  const spectators: SpectatorInfo[] = []

  for (const p of players) {
    const prof = profileMap.get(p.player_id)
    const username = prof?.username ?? 'Unknown'
    const avatarId = prof?.avatarId ?? null
    if (p.status === 'seated' && p.seat_number != null) {
      seatMap.set(p.seat_number, { playerId: p.player_id, username, avatarId, sittingOut: p.is_sitting_out === true })
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
      eliminated: occupant != null && eliminatedIds.has(occupant.playerId),
      sittingOut: occupant?.sittingOut ?? false,
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
    gameMode: table.game_mode,
    prizePool: table.prize_pool,
    sitGoStatus: table.sit_go_status,
    blindLevel: table.game_mode === 'sit_go' ? table.blind_level : null,
    buyIn: table.buy_in,
    startingStack: table.starting_stack,
    // The DB row is the source of truth for Last Hands — this is what
    // reconnecting/joining sockets receive via table_state, independent of
    // the server's in-memory LastHandsManager cache.
    lastHandsRemaining: table.last_hands_active ? table.last_hands_remaining : null,
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
    .select('max_players, status, game_mode, sit_go_status')
    .eq('id', tableId)
    .single()

  if (!tableData) return { error: 'Table not found' }
  const table = tableData as {
    max_players: number
    status: string
    game_mode: 'cash' | 'sit_go'
    sit_go_status: 'registering' | 'ready' | 'running' | 'finished' | null
  }
  if (table.status === 'closed') return { error: 'Table is closed' }

  if (table.game_mode === 'sit_go') {
    if (table.sit_go_status === 'registering') {
      return { error: 'This Sit & Go has not started yet — register and wait for it to fill.' }
    }
    if (table.sit_go_status === 'finished') {
      return { error: 'This Sit & Go has already finished.' }
    }

    const { data: registrationData } = await supabase
      .from('sit_go_registrations')
      .select('id')
      .eq('table_id', tableId)
      .eq('player_id', userId)
      .maybeSingle()

    if (!registrationData) {
      return { error: 'You are not registered for this Sit & Go.' }
    }

    // First registered player to enter the table room starts the tournament
    // clock. Guarded on the current value so only that first transition
    // actually writes — later joins/rejoins see sit_go_status already
    // 'running' and this becomes a no-op.
    if (table.sit_go_status === 'ready') {
      await supabase
        .from('poker_tables')
        .update({ sit_go_status: 'running' })
        .eq('id', tableId)
        .eq('sit_go_status', 'ready')
    }
  }

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

  // First-time join: find an available seat and insert, retrying against a
  // freshly recomputed seat if a concurrent writer claims one first. This is
  // a real race — not just theoretical — for Sit & Go tables, where the bulk
  // auto-seat sweep (seatAllSitGoRegistrants) and every registered player's
  // own join_table call can all land within milliseconds of each other at
  // the moment the table fills up.
  const MAX_SEAT_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_SEAT_ATTEMPTS; attempt++) {
    const seat = await findFirstAvailableSeat(supabase, tableId, table.max_players)
    if (seat == null) return { error: 'Table is full' }

    console.log(`[join] userId=${userId} tableId=${tableId} inserting at seat=${seat} (attempt ${attempt + 1})`)

    const { error: insertError } = await supabase.from('table_players').insert({
      table_id: tableId,
      player_id: userId,
      seat_number: seat,
      status: 'seated',
    })

    if (!insertError) return { seatNumber: seat }

    // Unique constraint fired. Re-fetch THIS user's row only — never fall
    // back to any other player's row. This covers a concurrent join for the
    // exact same user completing first.
    console.log(`[join] insert conflict  userId=${userId} tableId=${tableId} — re-fetching own row  ${insertError.message}`)
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
    // Own row still doesn't exist — the conflict was over the seat itself,
    // claimed by a different player between our read and our insert. Loop
    // and pick another free seat instead of surfacing the raw DB error.
  }

  return { error: 'Could not find a seat — please try again.' }
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

// Sit & Go only: bulk-seats every registrant the moment the table fills up,
// so the tournament can start without anyone clicking "Enter Table". Assigns
// seats 1..N in registration order.
//
// Idempotent and race-safe by construction, because this can legitimately run
// more than once for the same table: the immediate trigger fired by
// registerSitGoAction and the 5s periodic sweep in server.ts can both observe
// the table as 'ready' before either finishes, and a stale client can still
// call join_table (the legacy manual-entry path in joinTable() below) at the
// same moment. So for every registrant:
//   - an existing row already properly seated (status 'seated', real
//     seat_number) is left untouched — never re-inserted;
//   - an existing active row that ISN'T a real seat (e.g. spectating) is
//     UPDATEd in place — inserting a second active row for the same player
//     would violate table_players' one-active-row-per-player unique index;
//   - only a genuinely absent player gets a fresh INSERT, one row at a time
//     (not a single bulk insert) so a conflict on one player can never abort
//     seating for everyone else in the same pass. A conflict there means a
//     concurrent caller won the race for that specific player — re-read their
//     row and move on, same recovery pattern joinTable() uses below.
export async function seatAllSitGoRegistrants(supabase: DB, tableId: string): Promise<void> {
  const { data: regRows } = await supabase
    .from('sit_go_registrations')
    .select('player_id')
    .eq('table_id', tableId)
    .order('registered_at', { ascending: true })

  const registrants = (regRows as Array<{ player_id: string }> | null) ?? []
  if (registrants.length === 0) return

  const { data: activeRows } = await supabase
    .from('table_players')
    .select('id, player_id, seat_number, status')
    .eq('table_id', tableId)
    .neq('status', 'left')

  type ActiveRow = { id: string; player_id: string; seat_number: number | null; status: string }
  const byPlayer = new Map<string, ActiveRow>()
  const occupiedSeats = new Set<number>()
  for (const r of (activeRows as ActiveRow[] | null) ?? []) {
    byPlayer.set(r.player_id, r)
    if (r.status === 'seated' && r.seat_number != null) occupiedSeats.add(r.seat_number)
  }

  const claimNextFreeSeat = (): number => {
    let seat = 1
    while (occupiedSeats.has(seat)) seat++
    occupiedSeats.add(seat)
    return seat
  }

  for (const r of registrants) {
    const existing = byPlayer.get(r.player_id)

    if (existing?.status === 'seated' && existing.seat_number != null) {
      continue  // already properly seated — nothing to do
    }

    if (existing) {
      // Active but not a real seat (spectating) — upgrade the existing row
      // in place instead of inserting a second one for the same player.
      const seat = claimNextFreeSeat()
      const { error } = await supabase
        .from('table_players')
        .update({ status: 'seated', seat_number: seat })
        .eq('id', existing.id)
      if (error) console.error(`[sitgo] seat upgrade failed  table=${tableId} player=${r.player_id}`, error)
      continue
    }

    const seat = claimNextFreeSeat()
    const { error: insertError } = await supabase
      .from('table_players')
      .insert({ table_id: tableId, player_id: r.player_id, seat_number: seat, status: 'seated' })

    if (insertError) {
      // A concurrent seat-assignment path won this player already — this
      // seat number was never actually claimed by us, so release it before
      // re-reading whichever row they landed in.
      occupiedSeats.delete(seat)
      console.log(`[sitgo] seat insert conflict, re-checking  table=${tableId} player=${r.player_id}  ${insertError.message}`)
      const { data: retryRow } = await supabase
        .from('table_players')
        .select('seat_number')
        .eq('table_id', tableId)
        .eq('player_id', r.player_id)
        .neq('status', 'left')
        .maybeSingle()
      const retrySeat = (retryRow as { seat_number: number | null } | null)?.seat_number
      if (retrySeat != null) occupiedSeats.add(retrySeat)
      // If still nothing landed, this registrant stays unseated for this
      // pass — the next sweep/retry call (this function is idempotent) will
      // pick them up.
    }
  }
}

// Counts active (status = 'seated') players at a table. Used by the Sit & Go
// auto-start flow to decide whether every registrant actually landed a real
// seat before starting the pre-first-hand countdown — full registration
// alone is not enough, since seatAllSitGoRegistrants can legitimately leave
// a registrant unseated for a pass if it lost a seat-assignment race.
export async function getSeatedPlayerCount(supabase: DB, tableId: string): Promise<number> {
  const { data } = await supabase
    .from('table_players')
    .select('id')
    .eq('table_id', tableId)
    .eq('status', 'seated')

  return ((data as Array<{ id: string }> | null) ?? []).length
}

// A Sit & Go is ready to deal its first hand only once every registered seat
// is actually occupied — not merely once registration filled up.
export function isSitGoFullySeated(seatedCount: number, maxPlayers: number): boolean {
  return seatedCount === maxPlayers
}

// ── Blind levels (wall-clock, not hand-count) ───────────────────────────────
// small_blind/big_blind on poker_tables are treated as the CURRENT blinds —
// doStartHand() reads them fresh at the start of every hand, so bumping them
// here is all that's needed; no change to GameManager or the hand-dealing flow.
// Multiplier schedule is 1-indexed by level (index 0 = level 1, unused level 0).
export const SIT_GO_BLIND_MULTIPLIERS = [1, 2, 3, 5, 8, 12, 20]
export const SIT_GO_BLIND_LEVEL_INTERVAL_MS = 7 * 60 * 1000  // 7 minutes per level

// Derives the level a Sit & Go should be at purely from elapsed wall-clock
// time since it started — no hand count, no in-memory timer. That makes the
// level always independently reconstructable from sit_go_started_at alone,
// so it can never reset on refresh/reconnect or drift after a server restart.
export function computeSitGoBlindLevel(startedAt: string, maxLevel: number): number {
  const elapsedMs = Math.max(0, Date.now() - new Date(startedAt).getTime())
  const level = Math.floor(elapsedMs / SIT_GO_BLIND_LEVEL_INTERVAL_MS) + 1
  return Math.min(level, maxLevel)
}

// Recomputes a running Sit & Go table's blind level from elapsed time since
// sit_go_started_at (set once, atomically, alongside the 'ready' → 'running'
// transition) and persists it if it has increased. Levels only ever move
// forward — a straggling reconnect or an out-of-order sweep pass can never
// roll one back.
export async function syncSitGoBlindLevel(
  supabase: DB,
  tableId: string,
): Promise<{ changed: boolean }> {
  const { data: tableRow } = await supabase
    .from('poker_tables')
    .select('sit_go_status, sit_go_started_at, blind_level, original_small_blind, original_big_blind')
    .eq('id', tableId)
    .single()

  const row = tableRow as {
    sit_go_status: string | null
    sit_go_started_at: string | null
    blind_level: number
    original_small_blind: number | null
    original_big_blind: number | null
  } | null

  if (
    !row ||
    row.sit_go_status !== 'running' ||
    !row.sit_go_started_at ||
    !row.original_small_blind ||
    !row.original_big_blind
  ) {
    return { changed: false }
  }

  const maxLevel = SIT_GO_BLIND_MULTIPLIERS.length
  const targetLevel = computeSitGoBlindLevel(row.sit_go_started_at, maxLevel)
  if (targetLevel <= row.blind_level) return { changed: false }

  const multiplier = SIT_GO_BLIND_MULTIPLIERS[targetLevel - 1]
  const smallBlind = row.original_small_blind * multiplier
  const bigBlind = row.original_big_blind * multiplier

  const { error } = await supabase
    .from('poker_tables')
    .update({ blind_level: targetLevel, small_blind: smallBlind, big_blind: bigBlind })
    .eq('id', tableId)

  if (error) {
    console.error(`[sitgo] blind level update failed  table=${tableId}`, error)
    return { changed: false }
  }

  console.log(`[sitgo] blind level up  table=${tableId} level=${targetLevel} blinds=${smallBlind}/${bigBlind}`)
  return { changed: true }
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
