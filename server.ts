// Custom server: Next.js + Socket.io on one HTTP server.
// Run with: npm run dev:socket
// Next.js loads .env.local during app.prepare() — no dotenv import needed.

import { createServer } from 'node:http'
import next from 'next'
import { Server as SocketServer, type DefaultEventsMap } from 'socket.io'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import {
  getTableState,
  joinTable,
  spectateTable,
  leaveTable,
  cleanupTableSeats,
} from './src/lib/socket/table-session'
import { GameManager } from './src/lib/socket/game-manager'
import { SessionManager } from './src/lib/socket/session-manager'
import { BreakManager, BREAK_COUNTDOWN_MS, BREAK_DURATION_MS } from './src/lib/socket/break-manager'
import { computeShowdown } from './src/lib/socket/showdown-helper'
import type { HandEndedData } from './src/lib/socket/game-types'
import type {
  BettingAction,
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  TableStatePayload,
  ShowdownPayload,
} from './src/lib/socket/types'

const port = parseInt(process.env.PORT ?? '3000', 10)
const dev = process.env.NODE_ENV !== 'production'
const hostname = '0.0.0.0'

const nextApp = next({ dev, hostname, port })
const handle = nextApp.getRequestHandler()

// Single game manager instance — lives for the lifetime of the process.
const gm = new GameManager()
const sm = new SessionManager()
const bm = new BreakManager()

// ── Module-level helpers ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildTableState(supabase: any, tableId: string): Promise<TableStatePayload | null> {
  const base = await getTableState(supabase, tableId)
  if (!base) return null
  return { ...base, handState: gm.getPublicHandState(tableId) }
}

// Returns whether the table is a Sit & Go, so the caller (handleHandEnd) can
// branch its post-hand elimination logic without a second game_mode lookup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persistHandResult(supabase: any, data: HandEndedData, showdown: ShowdownPayload): Promise<boolean> {
  const { data: tableRow } = await supabase
    .from('poker_tables')
    .select('game_mode')
    .eq('id', showdown.tableId)
    .single()
  const isSitGo = (tableRow as { game_mode?: string } | null)?.game_mode === 'sit_go'

  if (isSitGo) {
    // Tournament stacks live in sit_go_registrations.current_stack, never the
    // wallet — the buy-in was already deducted at registration (Step 2) and no
    // real money moves hand-to-hand, so wallets/transactions stay untouched.
    for (const p of showdown.players) {
      const { error } = await supabase
        .from('sit_go_registrations')
        .update({ current_stack: p.finalStack })
        .eq('table_id', showdown.tableId)
        .eq('player_id', p.playerId)
      if (error) console.error(`[persist] sit_go stack update failed  user=${p.playerId}`, error)
    }
  } else {
    // 1. Update each player's wallet to their final stack.
    for (const p of showdown.players) {
      const { error } = await supabase
        .from('wallets')
        .update({ chips: p.finalStack, updated_at: new Date().toISOString() })
        .eq('user_id', p.playerId)
      if (error) console.error(`[persist] wallet update failed  user=${p.playerId}`, error)
    }

    // 2. Insert win/loss transactions (amount > 0 constraint — skip break-even).
    for (const p of showdown.players) {
      const contribution = data.players.find(hp => hp.playerId === p.playerId)!.totalContributed
      const netGain = p.chipDelta - contribution
      if (netGain === 0) continue

      const { error } = await supabase.from('transactions').insert({
        user_id: p.playerId,
        amount: Math.abs(netGain),
        type: netGain > 0 ? 'win' : 'loss',
        note: `Hand #${data.handNumber}`,
      })
      if (error) console.error(`[persist] transaction insert failed  user=${p.playerId}`, error)
    }
  }

  // 3. Save hand history (tip amount stored in result_json for admin review).
  const chipDeltasJson: Record<string, number> = {}
  for (const p of showdown.players) {
    const contribution = data.players.find(hp => hp.playerId === p.playerId)!.totalContributed
    chipDeltasJson[p.playerId] = p.chipDelta - contribution
  }

  const { error: histErr } = await supabase.from('game_history').insert({
    table_id: showdown.tableId,
    hand_number: data.handNumber,
    started_at: data.startedAt.toISOString(),
    ended_at: new Date().toISOString(),
    result_json: {
      reason: showdown.reason,
      tipAmount: data.tipAmount,
      pots: showdown.pots,
      players: showdown.players.map(p => ({
        playerId: p.playerId,
        username: p.username,
        finalStack: p.finalStack,
        chipDelta: p.chipDelta,
        hasFolded: p.hasFolded,
      })),
    },
    chip_deltas_json: chipDeltasJson,
  })
  if (histErr) console.error('[persist] game_history insert failed', histErr)

  return isSitGo
}

type SitGoEliminationResult = {
  tournamentFinished: boolean
  payout?: { winnerId: string; newChips: number }
}

// Marks any Sit & Go registration that just busted (current_stack already
// persisted as 0 by persistHandResult) as 'eliminated', then checks whether
// one registered, non-eliminated player remains. If so the tournament is
// over: flip sit_go_status to 'finished', mark that registration 'winner',
// and pay the table's prize_pool straight into their wallet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleSitGoElimination(supabase: any, tableId: string, showdown: ShowdownPayload): Promise<SitGoEliminationResult> {
  const eliminatedIds = showdown.players.filter(p => p.finalStack <= 0).map(p => p.playerId)

  if (eliminatedIds.length > 0) {
    const { error } = await supabase
      .from('sit_go_registrations')
      .update({ status: 'eliminated' })
      .eq('table_id', tableId)
      .in('player_id', eliminatedIds)
      .eq('status', 'registered')
    if (error) console.error(`[sitgo] elimination update failed  table=${tableId}`, error)
    else console.log(`[sitgo] eliminated: ${eliminatedIds.join(', ')}  table=${tableId}`)
  }

  const { data: regRows } = await supabase
    .from('sit_go_registrations')
    .select('player_id, status, current_stack')
    .eq('table_id', tableId)

  const regs = (regRows as Array<{ player_id: string; status: string; current_stack: number }> | null) ?? []
  const remaining = regs.filter(r => r.status === 'registered' && r.current_stack > 0)

  if (remaining.length > 1) return { tournamentFinished: false }

  // Guarded on the current value so only the first hand to detect the finish
  // actually flips it — a second call (should never happen; hands are
  // processed sequentially per table) would see zero rows returned here and
  // skip paying out again.
  const { data: finishedRows } = await supabase
    .from('poker_tables')
    .update({ sit_go_status: 'finished' })
    .eq('id', tableId)
    .neq('sit_go_status', 'finished')
    .select('prize_pool, name')

  const finishedRow = ((finishedRows as Array<{ prize_pool: number; name: string }> | null) ?? [])[0]
  if (!finishedRow) {
    // Already finished by an earlier hand — payout (if any) already happened.
    return { tournamentFinished: true }
  }

  console.log(`[sitgo] tournament finished  table=${tableId} remaining=${remaining.length}`)

  if (remaining.length !== 1) {
    // Chip-conservation makes this practically unreachable (someone always
    // holds the chips that were in play), but never guess at a winner.
    console.error(`[sitgo] finished with ${remaining.length} eligible winners — skipping payout  table=${tableId}`)
    return { tournamentFinished: true }
  }

  const winnerId = remaining[0].player_id
  const prizePool = finishedRow.prize_pool

  if (!prizePool || prizePool <= 0) {
    return { tournamentFinished: true }
  }

  // Guarded the same way — only the transition to 'winner' actually pays.
  const { data: winnerRows } = await supabase
    .from('sit_go_registrations')
    .update({ status: 'winner' })
    .eq('table_id', tableId)
    .eq('player_id', winnerId)
    .eq('status', 'registered')
    .select('id')

  if (!((winnerRows as Array<{ id: string }> | null) ?? []).length) {
    console.log(`[sitgo] winner already paid  table=${tableId} winner=${winnerId}`)
    return { tournamentFinished: true }
  }

  const { data: walletRow } = await supabase
    .from('wallets')
    .select('chips')
    .eq('user_id', winnerId)
    .single()

  const currentChips = (walletRow as { chips: number } | null)?.chips ?? 0
  const newChips = currentChips + prizePool

  const { error: walletErr } = await supabase
    .from('wallets')
    .update({ chips: newChips, updated_at: new Date().toISOString() })
    .eq('user_id', winnerId)

  if (walletErr) {
    console.error(`[sitgo] prize payout wallet update failed  table=${tableId} winner=${winnerId}`, walletErr)
    return { tournamentFinished: true }
  }

  const { error: txError } = await supabase.from('transactions').insert({
    user_id: winnerId,
    amount: prizePool,
    type: 'win',
    note: `Sit & Go prize pool: ${finishedRow.name}`,
  })
  if (txError) console.error(`[sitgo] prize payout transaction insert failed  table=${tableId} winner=${winnerId}`, txError)

  console.log(`[sitgo] paid prize pool  table=${tableId} winner=${winnerId} amount=${prizePool}`)

  return { tournamentFinished: true, payout: { winnerId, newChips } }
}

// Hand-based blind levels for Sit & Go tables (Step 6). small_blind/big_blind
// on poker_tables are treated as the CURRENT blinds — doStartHand() already
// reads them fresh at the start of every hand, so bumping them here is all
// that's needed; no change to GameManager or the hand-dealing flow.
// Multiplier schedule is 1-indexed by level (index 0 = level 1, unused level 0).
const SIT_GO_BLIND_MULTIPLIERS = [1, 2, 3, 5, 8, 12, 20]
const SIT_GO_HANDS_PER_LEVEL = 5

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function advanceSitGoBlinds(supabase: any, tableId: string): Promise<void> {
  const { data: tableRow } = await supabase
    .from('poker_tables')
    .select('sit_go_hands_completed, blind_level, original_small_blind, original_big_blind')
    .eq('id', tableId)
    .single()

  if (!tableRow) return
  const row = tableRow as {
    sit_go_hands_completed: number
    blind_level: number
    original_small_blind: number | null
    original_big_blind: number | null
  }

  const handsCompleted = row.sit_go_hands_completed + 1
  const maxLevel = SIT_GO_BLIND_MULTIPLIERS.length
  const newLevel = Math.min(Math.floor(handsCompleted / SIT_GO_HANDS_PER_LEVEL) + 1, maxLevel)

  const update: Record<string, unknown> = { sit_go_hands_completed: handsCompleted }

  if (newLevel !== row.blind_level && row.original_small_blind && row.original_big_blind) {
    const multiplier = SIT_GO_BLIND_MULTIPLIERS[newLevel - 1]
    update.blind_level = newLevel
    update.small_blind = row.original_small_blind * multiplier
    update.big_blind = row.original_big_blind * multiplier
    console.log(`[sitgo] blind level up  table=${tableId} level=${newLevel} blinds=${update.small_blind}/${update.big_blind}`)
  }

  const { error } = await supabase.from('poker_tables').update(update).eq('id', tableId)
  if (error) console.error(`[sitgo] blind level update failed  table=${tableId}`, error)
}

nextApp.prepare().then(() => {
  // Next.js has loaded .env.local by this point.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  // One service-role client shared across all socket handlers (stateless, safe).
  const supabase = createSupabaseClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const httpServer = createServer((req, res) => {
    handle(req, res)
  })

  const io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    DefaultEventsMap,
    SocketData
  >(httpServer, {
    cors: { origin: false },
  })

  // Expose io to Next.js server actions (same Node.js process, different module graph).
  ;(global as Record<string, unknown>).__socketIo = io

  // ── Turn timer ─────────────────────────────────────────────────────────────
  const TURN_TIMEOUT_MS = 60_000  // 60 seconds per player turn
  const turnTimers = new Map<string, NodeJS.Timeout>()
  const turnTimerStartedAt = new Map<string, number>()  // tableId → epoch ms
  // Timer-table players who are seated in the DB but have no live socket.
  // They pay blinds and are auto-acted instead of waiting for the timer.
  const disconnectedSeats = new Map<string, Set<string>>()  // tableId → Set<userId>

  function clearTurnTimer(tableId: string): void {
    const t = turnTimers.get(tableId)
    if (t !== undefined) { clearTimeout(t); turnTimers.delete(tableId) }
    turnTimerStartedAt.delete(tableId)
  }

  function startTurnTimer(tableId: string, playerId: string): void {
    clearTurnTimer(tableId)

    const startedAt = Date.now()
    turnTimerStartedAt.set(tableId, startedAt)

    io.to(`table:${tableId}`).emit('turn_timer_start', {
      tableId, playerId, seconds: TURN_TIMEOUT_MS / 1000,
    })

    const t = setTimeout(() => {
      turnTimers.delete(tableId)
      turnTimerStartedAt.delete(tableId)

      void (async () => {
        try {
          // Try CHECK first (costs nothing), fall back to FOLD.
          let result = gm.processAction(tableId, playerId, 'CHECK')
          let autoAction: BettingAction = 'CHECK'

          if ('error' in result) {
            result = gm.processAction(tableId, playerId, 'FOLD')
            autoAction = 'FOLD'
            if ('error' in result) return
          }

          console.log(`[game] timeout auto-${autoAction}  table=${tableId} user=${playerId}`)

          io.to(`table:${tableId}`).emit('action_result', {
            tableId, playerId, action: autoAction, amount: 0,
          })

          if (result.handEnded) {
            await handleHandEnd(tableId, result.data)
          } else if ('runout' in result && result.runout) {
            const state = await buildTableState(supabase, tableId)
            if (state) io.to(`table:${tableId}`).emit('table_state', state)
            handleAllInRunout(tableId)
          } else {
            const next = gm.getPublicHandState(tableId)
            if (next?.currentTurnPlayerId) {
              await handleTurnStart(tableId, next.currentTurnPlayerId)
            }
          }

          const state = await buildTableState(supabase, tableId)
          if (state) io.to(`table:${tableId}`).emit('table_state', state)
        } catch (err) {
          console.error('[game] turn timer action crashed:', err)
        }
      })()
    }, TURN_TIMEOUT_MS)

    turnTimers.set(tableId, t)
  }

  // If the next actor is a disconnected timer-table player, auto-acts them
  // immediately (CHECK if free, else FOLD) and chains through consecutive
  // disconnected players.  Connected players get the normal turn timer.
  async function handleTurnStart(tableId: string, playerId: string): Promise<void> {
    const tableDisconnected = disconnectedSeats.get(tableId)
    if (!tableDisconnected?.has(playerId)) {
      startTurnTimer(tableId, playerId)
      return
    }

    let result = gm.processAction(tableId, playerId, 'CHECK')
    let autoAction: BettingAction = 'CHECK'
    if ('error' in result) {
      result = gm.processAction(tableId, playerId, 'FOLD')
      autoAction = 'FOLD'
      if ('error' in result) return
    }

    console.log(`[game] disconnected auto-${autoAction}  table=${tableId} user=${playerId}`)
    io.to(`table:${tableId}`).emit('action_result', {
      tableId, playerId, action: autoAction, amount: 0,
    })

    if (result.handEnded) {
      await handleHandEnd(tableId, result.data)
      return
    }

    if ('runout' in result && result.runout) {
      const allHoleCards = gm.getAllHoleCards(tableId)
      io.to(`table:${tableId}`).emit('runout_cards_revealed', { tableId, players: allHoleCards })
      const runoutState = await buildTableState(supabase, tableId)
      if (runoutState) io.to(`table:${tableId}`).emit('table_state', runoutState)
      handleAllInRunout(tableId)
      return
    }

    const state = await buildTableState(supabase, tableId)
    if (state) io.to(`table:${tableId}`).emit('table_state', state)

    const next = gm.getPublicHandState(tableId)
    if (next?.currentTurnPlayerId) {
      await handleTurnStart(tableId, next.currentTurnPlayerId)
    }
  }

  // ── All-in runout: deal remaining streets with 2s delays ──────────────────
  const RUNOUT_STREET_DELAY_MS = 2_000
  const runoutTimers = new Map<string, NodeJS.Timeout>()

  function handleAllInRunout(tableId: string): void {
    // Cancel any existing runout timer for safety.
    const existing = runoutTimers.get(tableId)
    if (existing !== undefined) { clearTimeout(existing); runoutTimers.delete(tableId) }

    const t = setTimeout(() => {
      runoutTimers.delete(tableId)

      void (async () => {
        try {
          const result = gm.dealNextRunoutStreet(tableId)

          if ('error' in result) {
            console.error(`[game] runout deal error  table=${tableId}  ${result.error}`)
            return
          }

          if (result.handEnded) {
            // Emit final state before showdown.
            const state = await buildTableState(supabase, tableId)
            if (state) io.to(`table:${tableId}`).emit('table_state', state)
            await handleHandEnd(tableId, result.data)
          } else {
            console.log(`[game] runout street dealt  table=${tableId} phase=${result.phase}`)
            const state = await buildTableState(supabase, tableId)
            if (state) io.to(`table:${tableId}`).emit('table_state', state)
            // Schedule the next street.
            handleAllInRunout(tableId)
          }
        } catch (err) {
          console.error('[game] runout deal crashed:', err)
        }
      })()
    }, RUNOUT_STREET_DELAY_MS)

    runoutTimers.set(tableId, t)
  }

  // ── Shared hand-end logic ─────────────────────────────────────────────────
  async function handleHandEnd(tableId: string, data: HandEndedData): Promise<void> {
    const showdown = computeShowdown(tableId, data)
    console.log(
      `[game] hand ended  table=${tableId} reason=${data.reason} hand=${data.handNumber} tip=${data.tipAmount}`,
    )

    let isSitGo = false
    try {
      isSitGo = await persistHandResult(supabase, data, showdown)
    } catch (err) {
      console.error('[game] Failed to persist hand result:', err)
    }

    let tournamentFinished = false
    let brokePlayers: typeof showdown.players = []

    if (isSitGo) {
      // Sit & Go: broke players are marked 'eliminated' in sit_go_registrations
      // but stay seated at the table (they can keep watching) — no kick, no
      // redirect. doStartHand() excludes them from future hands by registration
      // status, not by table_players seat status.
      try {
        const result = await handleSitGoElimination(supabase, tableId, showdown)
        tournamentFinished = result.tournamentFinished
        if (result.payout) {
          const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
          for (const s of roomSockets) {
            if (s.data.userId === result.payout.winnerId) {
              s.emit('wallet_update', { chips: result.payout.newChips })
            }
          }
        }
      } catch (err) {
        console.error('[game] Sit & Go elimination check failed:', err)
      }

      // Blind levels only advance for hands that complete a still-running
      // tournament — never mid-hand (this runs after showdown) and never
      // once the tournament has finished.
      if (!tournamentFinished) {
        try {
          await advanceSitGoBlinds(supabase, tableId)
        } catch (err) {
          console.error('[game] Sit & Go blind level advance failed:', err)
        }
      }
    } else {
      // Cash games: mark broke players' seats 'left' immediately (never rely on
      // the wallet re-read in doStartHand, which would miss a failed wallet
      // write) so they can't be dealt into the next hand — but keep their
      // sockets in the room until AFTER showdown_result is broadcast below,
      // otherwise they'd be kicked out before ever seeing the final board/cards.
      brokePlayers = showdown.players.filter(p => p.finalStack === 0)
      if (brokePlayers.length > 0) {
        await Promise.all(brokePlayers.map(p =>
          supabase
            .from('table_players')
            .update({ status: 'left', seat_number: null, left_at: new Date().toISOString() })
            .eq('table_id', tableId)
            .eq('player_id', p.playerId)
            .neq('status', 'left')
        ))
        console.log(`[game] kicked broke players: ${brokePlayers.map(p => p.username).join(', ')}  table=${tableId}`)
        for (const p of brokePlayers) {
          disconnectedSeats.get(tableId)?.delete(p.playerId)
        }
      }
    }

    const state = await buildTableState(supabase, tableId)
    if (state) io.to(`table:${tableId}`).emit('table_state', state)

    io.to(`table:${tableId}`).emit('showdown_result', showdown)

    // Only now remove broke players' sockets from the room — they've already
    // received table_state and showdown_result above, so their client can
    // still render the final board and everyone's revealed cards.
    if (brokePlayers.length > 0) {
      const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
      for (const s of roomSockets) {
        if (brokePlayers.some(p => p.playerId === s.data.userId)) {
          s.emit('kicked_from_table', { tableId, reason: 'out_of_chips' })
          s.data.seatedAtTables.delete(tableId)
          s.leave(`table:${tableId}`)
        }
      }
    }

    if (!tournamentFinished) {
      scheduleAutoStart(tableId)
    } else {
      console.log(`[sitgo] no further hands — tournament finished  table=${tableId}`)
    }
  }

  // ── Auto-start next hand ───────────────────────────────────────────────────
  // Long enough for the showdown cards to be readable and for the pot → winner
  // chip flight (which the client delays a few seconds after showdown_result,
  // see WINNER_FLIGHT_DELAY_MS in TableRoom.tsx) to land before the felt resets.
  const AUTO_START_DELAY_MS = 7_000
  const autoStartTimers = new Map<string, NodeJS.Timeout>()

  function emitSessionUpdate(tableId: string): void {
    const session = sm.getSession(tableId)
    if (!session) return
    const payload = {
      tableId,
      tableName: session.tableName,
      secondsRemaining: sm.getSecondsRemaining(tableId),
      isExpired: sm.isExpired(tableId),
    }
    io.to(`table:${tableId}`).emit('session_update', payload)
    io.to('admin_room').emit('session_update', payload)
  }

  // ── Break scheduling ───────────────────────────────────────────────────────
  const breakCountdownTimers = new Map<string, NodeJS.Timeout>()
  const breakDurationTimers = new Map<string, NodeJS.Timeout>()

  function emitBreakUpdate(tableId: string): void {
    const payload = bm.toPayload(tableId)
    io.to(`table:${tableId}`).emit('break_update', payload)
    io.to('admin_room').emit('break_update', payload)
  }

  function startBreakFlow(tableId: string): boolean {
    const started = bm.startBreak(tableId)
    if (!started) return false
    emitBreakUpdate(tableId)
    const t = setTimeout(() => {
      breakCountdownTimers.delete(tableId)
      onBreakCountdownElapsed(tableId)
    }, BREAK_COUNTDOWN_MS)
    breakCountdownTimers.set(tableId, t)
    return true
  }

  function onBreakCountdownElapsed(tableId: string): void {
    if (gm.hasActiveHand(tableId)) {
      bm.setAwaitingHandEnd(tableId)
      emitBreakUpdate(tableId)
      // scheduleAutoStart() picks this up and activates the break once the hand ends.
    } else {
      activateBreak(tableId)
    }
  }

  function activateBreak(tableId: string): void {
    // A hand may have ended between hands right as the countdown hit 0 — cancel
    // any pending next-hand auto-start so the break actually takes effect.
    const existingAutoStart = autoStartTimers.get(tableId)
    if (existingAutoStart !== undefined) { clearTimeout(existingAutoStart); autoStartTimers.delete(tableId) }

    bm.activate(tableId)
    emitBreakUpdate(tableId)
    console.log(`[break] active  table=${tableId}`)

    const t = setTimeout(() => {
      breakDurationTimers.delete(tableId)
      endBreak(tableId)
    }, BREAK_DURATION_MS)
    breakDurationTimers.set(tableId, t)
  }

  function endBreak(tableId: string): void {
    bm.end(tableId)
    emitBreakUpdate(tableId)
    console.log(`[break] ended  table=${tableId}`)
    if (!gm.hasActiveHand(tableId)) {
      scheduleAutoStart(tableId)
    }
  }

  async function doStartHand(tableId: string): Promise<null | 'too_few' | 'failed' | 'session_expired' | 'on_break'> {
    if (gm.hasActiveHand(tableId)) return 'failed'

    // Block new hands when the session has expired.
    if (sm.isActive(tableId) && sm.isExpired(tableId)) return 'session_expired'

    // Block new hands once the break has moved past the "still playing" countdown phase.
    const breakPhase = bm.get(tableId)?.phase
    if (breakPhase === 'awaiting_hand_end' || breakPhase === 'active') return 'on_break'

    const { data: tableData } = await supabase
      .from('poker_tables')
      .select('name, small_blind, big_blind, table_type, status, game_mode')
      .eq('id', tableId)
      .single()

    if (!tableData || (tableData as { status: string }).status === 'closed') return 'failed'

    const { name: tableName, small_blind, big_blind, table_type, game_mode } = tableData as {
      name: string; small_blind: number; big_blind: number; table_type: 'timer' | 'open'; game_mode: 'cash' | 'sit_go'
    }

    const { data: playersData } = await supabase
      .from('table_players')
      .select('player_id, seat_number')
      .eq('table_id', tableId)
      .eq('status', 'seated')

    const allSeatedRows = (playersData as Array<{ player_id: string; seat_number: number }> | null) ?? []

    let rows: typeof allSeatedRows

    if (table_type === 'open' || !sm.isActive(tableId)) {
      // Open tables: always filter to connected players only.
      // Timer tables with no active session (first hand or after server restart):
      // also filter — ghost seats from a dead session must not be dealt in.
      // Once a session is running, timer tables keep ALL seated players (even
      // disconnected ones — they are auto-acted via handleTurnStart).
      const preHandSockets = await io.in(`table:${tableId}`).fetchSockets()
      const connectedUserIds = new Set(preHandSockets.map(s => s.data.userId))

      const staleRows = allSeatedRows.filter(r => !connectedUserIds.has(r.player_id))
      rows = allSeatedRows.filter(r => connectedUserIds.has(r.player_id))

      if (staleRows.length > 0) {
        console.log(`[game] removing stale seats before hand  table=${tableId} count=${staleRows.length} type=${table_type}`)
        await Promise.all(staleRows.map(r =>
          supabase
            .from('table_players')
            .update({ status: 'left', seat_number: null, left_at: new Date().toISOString() })
            .eq('table_id', tableId)
            .eq('player_id', r.player_id)
            .neq('status', 'left')
        ))
        if (rows.length < 2) {
          const updatedState = await buildTableState(supabase, tableId)
          if (updatedState) io.to(`table:${tableId}`).emit('table_state', updatedState)
          return 'too_few'
        }
      }
    } else {
      // Active timer-table session: include all seated players regardless of connection.
      // Disconnected players will be auto-acted via handleTurnStart.
      rows = allSeatedRows
    }

    if (rows.length < 2) return 'too_few'

    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, username, role')
      .in('id', rows.map(r => r.player_id))

    const profiles = (profilesData as Array<{ id: string; username: string; role: string }> | null) ?? []

    // Evict any super_admin who somehow ended up seated.
    const superAdminIds = profiles.filter(p => p.role === 'super_admin').map(p => p.id)
    if (superAdminIds.length > 0) {
      console.log(`[game] evicting super_admin from hand  table=${tableId} count=${superAdminIds.length}`)
      await Promise.all(superAdminIds.map(id =>
        supabase
          .from('table_players')
          .update({ status: 'left', seat_number: null, left_at: new Date().toISOString() })
          .eq('table_id', tableId)
          .eq('player_id', id)
          .neq('status', 'left')
      ))
      rows = rows.filter(r => !superAdminIds.includes(r.player_id))
      if (rows.length < 2) {
        const updatedState = await buildTableState(supabase, tableId)
        if (updatedState) io.to(`table:${tableId}`).emit('table_state', updatedState)
        return 'too_few'
      }
    }

    const usernameMap = new Map<string, string>(
      profiles.filter(p => p.role !== 'super_admin').map(p => [p.id, p.username]),
    )

    let allSeated = rows.map(r => ({
      playerId: r.player_id,
      seatNumber: r.seat_number,
      username: usernameMap.get(r.player_id) ?? 'Unknown',
    }))

    if (allSeated.length < 2) return 'too_few'

    let stackOverrides: Map<string, number> | undefined
    if (game_mode === 'sit_go') {
      const { data: regRows } = await supabase
        .from('sit_go_registrations')
        .select('player_id, current_stack, status')
        .eq('table_id', tableId)
        .in('player_id', allSeated.map(p => p.playerId))

      const regs = (regRows as Array<{ player_id: string; current_stack: number; status: string }> | null) ?? []
      stackOverrides = new Map(regs.map(r => [r.player_id, r.current_stack]))

      // Eliminated players stay seated (so they can keep watching) but must
      // never be dealt into a new hand, post blinds, or affect turn order.
      const eligibleIds = new Set(
        regs.filter(r => r.status === 'registered' && r.current_stack > 0).map(r => r.player_id),
      )
      const excluded = allSeated.filter(p => !eligibleIds.has(p.playerId))
      if (excluded.length > 0) {
        console.log(`[sitgo] excluding eliminated players from hand: ${excluded.map(p => p.username).join(', ')}  table=${tableId}`)
      }
      allSeated = allSeated.filter(p => eligibleIds.has(p.playerId))

      if (allSeated.length < 2) return 'too_few'
    }

    const result = await gm.startHand(tableId, allSeated, supabase, small_blind, big_blind, stackOverrides)
    if ('error' in result) return 'failed'

    // Start the 1-hour session on the very first hand — timer tables only.
    // Open tables have no time limit so they never get a session.
    if (table_type !== 'open' && !sm.isActive(tableId)) {
      sm.startSession(tableId, tableName, table_type)
      emitSessionUpdate(tableId)
      console.log(`[session] started  table=${tableId}`)
    }

    console.log(`[game] hand started  table=${tableId}`)

    // Send each seated socket its private hole cards.
    const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
    for (const s of roomSockets) {
      const cards = gm.getPlayerHoleCards(tableId, s.data.userId)
      if (cards) s.emit('deal_cards', { tableId, holeCards: cards })
    }

    // Start the turn (or auto-act disconnected players) for the first actor.
    const firstState = gm.getPublicHandState(tableId)
    if (firstState?.currentTurnPlayerId) {
      await handleTurnStart(tableId, firstState.currentTurnPlayerId)
    }

    const state = await buildTableState(supabase, tableId)
    if (state) io.to(`table:${tableId}`).emit('table_state', state)

    return null
  }

  function scheduleAutoStart(tableId: string): void {
    // Don't queue a new hand when the session has expired.
    if (sm.isActive(tableId) && sm.isExpired(tableId)) {
      console.log(`[session] expired — skipping auto-start  table=${tableId}`)
      return
    }

    // The hand that just ended was the last one before the break — activate it
    // now instead of queuing the next hand.
    const breakPhase = bm.get(tableId)?.phase
    if (breakPhase === 'awaiting_hand_end') {
      activateBreak(tableId)
      return
    }
    if (breakPhase === 'active') {
      return
    }

    const existing = autoStartTimers.get(tableId)
    if (existing !== undefined) { clearTimeout(existing); autoStartTimers.delete(tableId) }

    io.to(`table:${tableId}`).emit('next_hand_countdown', {
      tableId,
      seconds: AUTO_START_DELAY_MS / 1000,
    })

    const t = setTimeout(() => {
      autoStartTimers.delete(tableId)
      void doStartHand(tableId)
        .then(err => {
          if (err === 'too_few') {
            console.log(`[game] auto-start skipped — not enough players  table=${tableId}`)
          } else if (err === 'session_expired') {
            console.log(`[game] auto-start skipped — session expired  table=${tableId}`)
          }
        })
        .catch(err => console.error('[game] auto-start crashed:', err))
    }, AUTO_START_DELAY_MS)
    autoStartTimers.set(tableId, t)
  }

  // ── Stale-seat cleanup ────────────────────────────────────────────────────
  // Marks seated rows as left for any player with no live socket in the table room.
  // Called before join and before starting the first hand of a session, so ghost
  // players from a previous server run are evicted before they can affect state.
  async function cleanupStaleSeats(tableId: string): Promise<void> {
    const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
    const connectedUserIds = new Set(roomSockets.map(s => s.data.userId))

    const { data: seatedRows } = await supabase
      .from('table_players')
      .select('id, player_id, seat_number')
      .eq('table_id', tableId)
      .eq('status', 'seated')

    const stale = (
      (seatedRows as Array<{ id: string; player_id: string; seat_number: number | null }> | null) ?? []
    ).filter(r => !connectedUserIds.has(r.player_id))

    if (stale.length === 0) return

    console.log(`[cleanup] removing ${stale.length} stale seats (no live socket)  table=${tableId}  players=${stale.map(r => r.player_id).join(',')}`)
    await Promise.all(stale.map(r =>
      supabase
        .from('table_players')
        .update({ status: 'left', seat_number: null, left_at: new Date().toISOString() })
        .eq('id', r.id)
    ))

    // DB-level dedup safety net: any constraint-surviving duplicates.
    await cleanupTableSeats(supabase, tableId)
  }

  // ── Auth middleware ────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined
    if (!token) return next(new Error('Authentication required'))

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token)

    if (error || !user) return next(new Error('Invalid or expired token'))

    const { data: profileData } = await supabase
      .from('profiles')
      .select('username, role')
      .eq('id', user.id)
      .single()

    const profile = profileData as { username?: string; role?: string } | null

    socket.data.userId = user.id
    socket.data.username = profile?.username ?? 'Unknown'
    socket.data.role = profile?.role ?? 'player'
    socket.data.joinedTables = new Set()
    socket.data.seatedAtTables = new Set()

    next()
  })

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const { userId, username } = socket.data

    console.log(`[socket] connected  user=${username} socket=${socket.id}`)

    socket.emit('socket_ready', { userId, username })

    // Admins get real-time session/break updates for all tables.
    if (socket.data.role === 'admin' || socket.data.role === 'super_admin') {
      socket.join('admin_room')
      for (const session of sm.getAllSessions()) {
        socket.emit('session_update', {
          tableId: session.tableId,
          tableName: session.tableName,
          secondsRemaining: sm.getSecondsRemaining(session.tableId),
          isExpired: sm.isExpired(session.tableId),
        })
      }
      for (const brk of bm.getAllBreaks()) {
        socket.emit('break_update', bm.toPayload(brk.tableId))
      }
    }

    // ── join_table ─────────────────────────────────────────────────────────
    socket.on('join_table', async ({ tableId }) => {
      // When no session is active, evict ghost seats before reserving a new one.
      // This catches stale rows left behind by a server restart or crash.
      if (!sm.isActive(tableId)) {
        await cleanupStaleSeats(tableId)
      }

      const result = await joinTable(supabase, tableId, userId)

      if ('error' in result) {
        socket.emit('socket_error', { message: result.error })
        return
      }

      socket.data.joinedTables.add(tableId)
      socket.data.seatedAtTables.add(tableId)
      socket.join(`table:${tableId}`)
      disconnectedSeats.get(tableId)?.delete(userId)

      socket.emit('table_joined', { tableId, seatNumber: result.seatNumber })

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)

      // Reconnect: resend private hole cards if a hand is in progress.
      const cards = gm.getPlayerHoleCards(tableId, userId)
      if (cards) socket.emit('deal_cards', { tableId, holeCards: cards })

      // Reconnect: resend current turn timer state with accurate remaining seconds.
      const timerStart = turnTimerStartedAt.get(tableId)
      const handState = gm.getPublicHandState(tableId)
      if (handState?.currentTurnPlayerId && timerStart !== undefined) {
        const elapsed = Date.now() - timerStart
        const remaining = Math.max(1, Math.ceil((TURN_TIMEOUT_MS - elapsed) / 1000))
        socket.emit('turn_timer_start', {
          tableId,
          playerId: handState.currentTurnPlayerId,
          seconds: remaining,
        })
      }

      // Reconnect: resend current session state.
      if (sm.isActive(tableId)) {
        const session = sm.getSession(tableId)!
        socket.emit('session_update', {
          tableId,
          tableName: session.tableName,
          secondsRemaining: sm.getSecondsRemaining(tableId),
          isExpired: sm.isExpired(tableId),
        })
      }

      // Reconnect: resend current break state (phase:null when no break is running).
      socket.emit('break_update', bm.toPayload(tableId))
    })

    // ── spectate_table ─────────────────────────────────────────────────────
    socket.on('spectate_table', async ({ tableId }) => {
      const result = await spectateTable(supabase, tableId, userId)

      if ('error' in result) {
        socket.emit('socket_error', { message: result.error })
        return
      }

      socket.data.joinedTables.add(tableId)
      socket.join(`table:${tableId}`)

      socket.emit('spectator_joined', { tableId })

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)

      socket.emit('break_update', bm.toPayload(tableId))
    })

    // ── leave_table ────────────────────────────────────────────────────────
    socket.on('leave_table', async ({ tableId }) => {
      // Block voluntary leaves while the session is running — 'open' tables never lock.
      if (sm.lockLeaving(tableId) && socket.data.role !== 'admin') {
        socket.emit('socket_error', { message: 'Session in progress — you cannot leave until the session ends.' })
        return
      }

      // Block voluntary leaves while the break is active — players must stay seated.
      if (bm.isActive(tableId) && socket.data.role !== 'admin') {
        socket.emit('socket_error', { message: 'Break in progress — you must stay seated until it ends.' })
        return
      }

      await leaveTable(supabase, tableId, userId)

      socket.data.joinedTables.delete(tableId)
      socket.data.seatedAtTables.delete(tableId)
      socket.leave(`table:${tableId}`)

      socket.emit('table_left', { tableId })

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── start_hand ─────────────────────────────────────────────────────────
    socket.on('start_hand', async ({ tableId }) => {
      if (!socket.data.seatedAtTables.has(tableId)) {
        socket.emit('socket_error', { message: 'You must be seated to start a hand' })
        return
      }

      if (gm.hasActiveHand(tableId)) {
        socket.emit('socket_error', { message: 'A hand is already in progress' })
        return
      }

      const err = await doStartHand(tableId)
      if (err === 'too_few') {
        socket.emit('socket_error', { message: 'Need at least 2 seated players to start' })
      } else if (err === 'failed') {
        socket.emit('socket_error', { message: 'Unable to start hand' })
      } else if (err === 'session_expired') {
        socket.emit('socket_error', { message: 'Session has ended — no more hands can be dealt' })
      } else if (err === 'on_break') {
        socket.emit('socket_error', { message: 'Table is on break' })
      }
    })

    // ── player_action ──────────────────────────────────────────────────────
    socket.on('player_action', async ({ tableId, action, amount }) => {
      if (!socket.data.seatedAtTables.has(tableId)) {
        socket.emit('socket_error', { message: 'You must be seated to act' })
        return
      }

      clearTurnTimer(tableId)

      const result = gm.processAction(tableId, userId, action, amount)

      if ('error' in result) {
        const current = gm.getPublicHandState(tableId)
        if (current?.currentTurnPlayerId) {
          startTurnTimer(tableId, current.currentTurnPlayerId)
        }
        socket.emit('socket_error', { message: result.error })
        return
      }

      console.log(
        `[game] action  table=${tableId} user=${username} action=${action}${amount != null ? ` amount=${amount}` : ''}`,
      )

      io.to(`table:${tableId}`).emit('action_result', {
        tableId,
        playerId: userId,
        action,
        amount: amount ?? 0,
      })

      if (result.handEnded) {
        await handleHandEnd(tableId, result.data)
      } else if ('runout' in result && result.runout) {
        // Reveal all non-folded hole cards before the auto-deal begins.
        const allHoleCards = gm.getAllHoleCards(tableId)
        io.to(`table:${tableId}`).emit('runout_cards_revealed', { tableId, players: allHoleCards })
        // Emit current state (with the first street already dealt) then start timed dealing.
        const state = await buildTableState(supabase, tableId)
        if (state) io.to(`table:${tableId}`).emit('table_state', state)
        handleAllInRunout(tableId)
        return  // skip the extra table_state emit below
      } else {
        const next = gm.getPublicHandState(tableId)
        if (next?.currentTurnPlayerId) {
          await handleTurnStart(tableId, next.currentTurnPlayerId)
        }
      }

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── reveal_hand ────────────────────────────────────────────────────────
    socket.on('reveal_hand', ({ tableId, cards }) => {
      io.to(`table:${tableId}`).emit('hand_revealed', {
        tableId,
        playerId: userId,
        cards,
      })
    })

    // ── table_chat_send ───────────────────────────────────────────────────
    socket.on('table_chat_send', ({ tableId, message }) => {
      if (!socket.data.joinedTables.has(tableId)) return
      if (typeof message !== 'string') return

      const trimmed = message.trim()
      if (trimmed.length === 0 || trimmed.length > 200) return

      io.to(`table:${tableId}`).emit('table_chat_message', {
        tableId,
        playerId: userId,
        username,
        message: trimmed,
        createdAt: new Date().toISOString(),
      })
    })

    // ── send_reaction ─────────────────────────────────────────────────────
    // Targeted live reaction (Trash / Tissue) — purely visual, never persisted.
    socket.on('send_reaction', ({ tableId, toPlayerId, reactionType }) => {
      console.debug('[reaction] server received send_reaction', { tableId, fromPlayerId: userId, toPlayerId, reactionType })

      if (!socket.data.joinedTables.has(tableId)) {
        console.debug('[reaction] rejected — sender has not joined this table', { tableId, userId })
        return
      }
      if (reactionType !== 'trash' && reactionType !== 'tissue') {
        console.debug('[reaction] rejected — invalid reactionType', { reactionType })
        return
      }
      if (typeof toPlayerId !== 'string' || toPlayerId === userId) {
        console.debug('[reaction] rejected — invalid toPlayerId', { toPlayerId })
        return
      }

      console.debug('[reaction] broadcasting reaction_sent', { tableId, fromPlayerId: userId, toPlayerId, reactionType })
      io.to(`table:${tableId}`).emit('reaction_sent', {
        tableId,
        fromPlayerId: userId,
        toPlayerId,
        reactionType,
      })
    })

    // ── send_tip ───────────────────────────────────────────────────────────
    socket.on('send_tip', async ({ tableId, handNumber, amount }) => {
      if (amount <= 0) return
      const { error } = await supabase.from('dealer_tips').insert({
        table_id: tableId,
        hand_number: handNumber,
        player_id: userId,
        amount,
      })
      if (error) console.error(`[tip] dealer_tip insert failed  user=${userId}`, error)
      else console.log(`[tip] dealer tip  table=${tableId} hand=${handNumber} user=${username} amount=${amount}`)
    })

    // ── extend_session ─────────────────────────────────────────────────────
    socket.on('extend_session', async ({ tableId, additionalMinutes }) => {
      if (socket.data.role !== 'admin') {
        socket.emit('socket_error', { message: 'Admin only' })
        return
      }
      if (!sm.isActive(tableId)) {
        socket.emit('socket_error', { message: 'No active session for that table' })
        return
      }
      sm.extendSession(tableId, additionalMinutes * 60_000)
      emitSessionUpdate(tableId)
      console.log(`[session] extended  table=${tableId}  +${additionalMinutes}m  by=${username}`)
      // Resume dealing if the session had expired and no hand is currently active.
      if (!gm.hasActiveHand(tableId)) {
        scheduleAutoStart(tableId)
      }
    })

    // ── start_break ────────────────────────────────────────────────────────
    socket.on('start_break', ({ tableId }) => {
      if (socket.data.role !== 'admin' && socket.data.role !== 'super_admin') {
        socket.emit('socket_error', { message: 'Admin only' })
        return
      }
      const started = startBreakFlow(tableId)
      if (!started) {
        socket.emit('socket_error', { message: 'Break already scheduled for this table' })
        return
      }
      console.log(`[break] scheduled  table=${tableId} by=${username}`)
    })

    // ── kick_player ────────────────────────────────────────────────────────
    socket.on('kick_player', async ({ tableId, playerId }) => {
      if (socket.data.role !== 'admin') {
        socket.emit('socket_error', { message: 'Admin only' })
        return
      }
      // If it is the kicked player's turn, auto-fold them first.
      const handState = gm.getPublicHandState(tableId)
      if (handState?.currentTurnPlayerId === playerId) {
        clearTurnTimer(tableId)
        const result = gm.processAction(tableId, playerId, 'FOLD')
        if (!('error' in result)) {
          io.to(`table:${tableId}`).emit('action_result', {
            tableId, playerId, action: 'FOLD', amount: 0,
          })
          if (result.handEnded) {
            await handleHandEnd(tableId, result.data)
          } else {
            const next = gm.getPublicHandState(tableId)
            if (next?.currentTurnPlayerId) await handleTurnStart(tableId, next.currentTurnPlayerId)
          }
        }
      }
      await leaveTable(supabase, tableId, playerId)
      disconnectedSeats.get(tableId)?.delete(playerId)
      // Notify and eject the kicked player's sockets.
      const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
      for (const s of roomSockets) {
        if (s.data.userId === playerId) {
          s.emit('kicked_from_table', { tableId, reason: 'admin_kicked' })
          s.data.joinedTables.delete(tableId)
          s.data.seatedAtTables.delete(tableId)
          s.leave(`table:${tableId}`)
        }
      }
      const kickedState = await buildTableState(supabase, tableId)
      if (kickedState) io.to(`table:${tableId}`).emit('table_state', kickedState)
      console.log(`[session] player kicked  table=${tableId} player=${playerId} by=${username}`)
    })

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`[socket] disconnected  user=${username} socket=${socket.id}`)

      for (const tableId of socket.data.joinedTables) {
        // An active break locks seats in the same way a locked session does —
        // players must stay seated for the duration of the break.
        const seatLocked = sm.lockLeaving(tableId) || bm.isActive(tableId)

        if (seatLocked && socket.data.seatedAtTables.has(tableId)) {
          // Timer table with an active session (or an active break): keep the seat reserved.
          // Only flag as disconnected if this was their last socket in the room
          // (the socket has already left all rooms before 'disconnect' fires).
          const remainingSockets = await io.in(`table:${tableId}`).fetchSockets()
          const stillConnected = remainingSockets.some(s => s.data.userId === userId)
          if (!stillConnected) {
            if (!disconnectedSeats.has(tableId)) disconnectedSeats.set(tableId, new Set())
            disconnectedSeats.get(tableId)!.add(userId)
            console.log(`[socket] seat reserved for disconnected player  user=${username} table=${tableId}`)
          }
        } else if (!gm.hasActiveHand(tableId) && !seatLocked) {
          // Open table (or timer table with no session/break): release the seat.
          await leaveTable(supabase, tableId, userId)
        }

        const state = await buildTableState(supabase, tableId)
        if (state) io.to(`table:${tableId}`).emit('table_state', state)
      }
    })
  })

  // ── Session / break countdown broadcast ───────────────────────────────────
  // Every 5 s: push the current seconds-remaining to all table rooms + admin.
  setInterval(() => {
    for (const session of sm.getAllSessions()) {
      emitSessionUpdate(session.tableId)
    }
    for (const brk of bm.getAllBreaks()) {
      emitBreakUpdate(brk.tableId)
    }
  }, 5_000)

  httpServer.listen(port, hostname, () => {
    console.log(
      `> Ready on http://${hostname}:${port} [${dev ? 'development' : 'production'}]`,
    )
  })
})
