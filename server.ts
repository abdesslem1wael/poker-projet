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
} from './src/lib/socket/table-session'
import { GameManager } from './src/lib/socket/game-manager'
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
const hostname = 'localhost'

const nextApp = next({ dev, hostname, port })
const handle = nextApp.getRequestHandler()

// Single game manager instance — lives for the lifetime of the process.
const gm = new GameManager()

// ── Module-level helpers (take supabase as param so they can be called anywhere) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildTableState(supabase: any, tableId: string): Promise<TableStatePayload | null> {
  const base = await getTableState(supabase, tableId)
  if (!base) return null
  return { ...base, handState: gm.getPublicHandState(tableId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persistHandResult(supabase: any, data: HandEndedData, showdown: ShowdownPayload): Promise<void> {
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

  // 3. Save hand history.
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

  // ── Turn timer ─────────────────────────────────────────────────────────────
  const TURN_TIMEOUT_MS = 30_000
  const turnTimers = new Map<string, NodeJS.Timeout>()
  const turnTimerStartedAt = new Map<string, number>()  // tableId → epoch ms

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
        // Try CHECK first (costs nothing), fall back to FOLD.
        let result = gm.processAction(tableId, playerId, 'CHECK')
        let autoAction: BettingAction = 'CHECK'

        if ('error' in result) {
          result = gm.processAction(tableId, playerId, 'FOLD')
          autoAction = 'FOLD'
          if ('error' in result) return  // hand already ended or player state changed
        }

        console.log(`[game] timeout auto-${autoAction}  table=${tableId} user=${playerId}`)

        io.to(`table:${tableId}`).emit('action_result', {
          tableId, playerId, action: autoAction, amount: 0,
        })

        if (result.handEnded) {
          const showdown = computeShowdown(tableId, result.data)
          console.log(
            `[game] hand ended (timeout)  table=${tableId} reason=${result.data.reason}`,
          )
          try { await persistHandResult(supabase, result.data, showdown) } catch (err) {
            console.error('[game] Failed to persist hand result:', err)
          }
          io.to(`table:${tableId}`).emit('showdown_result', showdown)
          scheduleAutoStart(tableId)
        } else {
          const next = gm.getPublicHandState(tableId)
          if (next?.currentTurnPlayerId) {
            startTurnTimer(tableId, next.currentTurnPlayerId)
          }
        }

        const state = await buildTableState(supabase, tableId)
        if (state) io.to(`table:${tableId}`).emit('table_state', state)
      })()
    }, TURN_TIMEOUT_MS)

    turnTimers.set(tableId, t)
  }

  // ── Auto-start next hand ───────────────────────────────────────────────────
  const AUTO_START_DELAY_MS = 5_000
  const autoStartTimers = new Map<string, NodeJS.Timeout>()

  // Core hand-start logic shared by manual start_hand and auto-start.
  // Returns null on success, or an error string on failure.
  async function doStartHand(tableId: string): Promise<null | 'too_few' | 'failed'> {
    if (gm.hasActiveHand(tableId)) return 'failed'

    const { data: tableData } = await supabase
      .from('poker_tables')
      .select('small_blind, big_blind, status')
      .eq('id', tableId)
      .single()

    if (!tableData || (tableData as { status: string }).status === 'closed') return 'failed'

    const { small_blind, big_blind } = tableData as { small_blind: number; big_blind: number }

    const { data: playersData } = await supabase
      .from('table_players')
      .select('player_id, seat_number')
      .eq('table_id', tableId)
      .eq('status', 'seated')

    const rows = (playersData as Array<{ player_id: string; seat_number: number }> | null) ?? []
    if (rows.length < 2) return 'too_few'

    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, username')
      .in('id', rows.map(r => r.player_id))

    const usernameMap = new Map<string, string>(
      ((profilesData as Array<{ id: string; username: string }> | null) ?? []).map(
        p => [p.id, p.username],
      ),
    )

    const seatedPlayers = rows.map(r => ({
      playerId: r.player_id,
      seatNumber: r.seat_number,
      username: usernameMap.get(r.player_id) ?? 'Unknown',
    }))

    const result = await gm.startHand(tableId, seatedPlayers, supabase, small_blind, big_blind)
    if ('error' in result) return 'failed'

    console.log(`[game] hand started  table=${tableId}`)

    // Send each seated socket its private hole cards.
    const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
    for (const s of roomSockets) {
      const cards = gm.getPlayerHoleCards(tableId, s.data.userId)
      if (cards) s.emit('deal_cards', { tableId, holeCards: cards })
    }

    // Start the turn timer for the first actor.
    const firstState = gm.getPublicHandState(tableId)
    if (firstState?.currentTurnPlayerId) {
      startTurnTimer(tableId, firstState.currentTurnPlayerId)
    }

    const state = await buildTableState(supabase, tableId)
    if (state) io.to(`table:${tableId}`).emit('table_state', state)

    return null
  }

  function scheduleAutoStart(tableId: string): void {
    // Cancel any existing pending auto-start for this table.
    const existing = autoStartTimers.get(tableId)
    if (existing !== undefined) { clearTimeout(existing); autoStartTimers.delete(tableId) }

    // Tell clients to show the countdown.
    io.to(`table:${tableId}`).emit('next_hand_countdown', {
      tableId,
      seconds: AUTO_START_DELAY_MS / 1000,
    })

    const t = setTimeout(() => {
      autoStartTimers.delete(tableId)
      void doStartHand(tableId).then(err => {
        if (err === 'too_few') {
          console.log(`[game] auto-start skipped — not enough players  table=${tableId}`)
        }
      })
    }, AUTO_START_DELAY_MS)
    autoStartTimers.set(tableId, t)
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

    // ── join_table ─────────────────────────────────────────────────────────
    socket.on('join_table', async ({ tableId }) => {
      const result = await joinTable(supabase, tableId, userId)

      if ('error' in result) {
        socket.emit('socket_error', { message: result.error })
        return
      }

      socket.data.joinedTables.add(tableId)
      socket.data.seatedAtTables.add(tableId)
      socket.join(`table:${tableId}`)

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
    })

    // ── spectate_table ─────────────────────────────────────────────────────
    socket.on('spectate_table', async ({ tableId }) => {
      const result = await spectateTable(supabase, tableId, userId)

      if ('error' in result) {
        socket.emit('socket_error', { message: result.error })
        return
      }

      socket.data.joinedTables.add(tableId)
      // Note: spectators do NOT go into seatedAtTables
      socket.join(`table:${tableId}`)

      socket.emit('spectator_joined', { tableId })

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── leave_table ────────────────────────────────────────────────────────
    socket.on('leave_table', async ({ tableId }) => {
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
      // Only seated players may start a hand.
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
      }
      // On success doStartHand already broadcast deal_cards + table_state.
    })

    // ── player_action ──────────────────────────────────────────────────────
    socket.on('player_action', async ({ tableId, action, amount }) => {
      // Reject actions from spectators and players not at this table.
      if (!socket.data.seatedAtTables.has(tableId)) {
        socket.emit('socket_error', { message: 'You must be seated to act' })
        return
      }

      // Clear the turn timer immediately — player acted in time.
      clearTurnTimer(tableId)

      const result = gm.processAction(tableId, userId, action, amount)

      if ('error' in result) {
        // Restart timer: player sent an invalid action but it's still their turn.
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
        const showdown = computeShowdown(tableId, result.data)
        console.log(
          `[game] hand ended  table=${tableId} reason=${result.data.reason} hand=${result.data.handNumber}`,
        )
        try {
          await persistHandResult(supabase, result.data, showdown)
        } catch (err) {
          console.error('[game] Failed to persist hand result:', err)
        }
        io.to(`table:${tableId}`).emit('showdown_result', showdown)
        scheduleAutoStart(tableId)
      } else {
        // Start timer for the next actor.
        const next = gm.getPublicHandState(tableId)
        if (next?.currentTurnPlayerId) {
          startTurnTimer(tableId, next.currentTurnPlayerId)
        }
      }

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`[socket] disconnected  user=${username} socket=${socket.id}`)

      for (const tableId of socket.data.joinedTables) {
        // Keep the seat if a hand is active — the turn timer handles timeouts.
        // Only free the seat immediately when no hand is running.
        if (!gm.hasActiveHand(tableId)) {
          await leaveTable(supabase, tableId, userId)
        }
        // Broadcast so other clients see the updated table state.
        const state = await buildTableState(supabase, tableId)
        if (state) io.to(`table:${tableId}`).emit('table_state', state)
      }
    })
  })

  httpServer.listen(port, hostname, () => {
    console.log(
      `> Ready on http://${hostname}:${port} [${dev ? 'development' : 'production'}]`,
    )
  })
})
