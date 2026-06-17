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
import { SessionManager } from './src/lib/socket/session-manager'
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

// ── Module-level helpers ───────────────────────────────────────────────────

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
  const TURN_TIMEOUT_MS = 60_000  // 60 seconds per player turn
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
              startTurnTimer(tableId, next.currentTurnPlayerId)
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
    try {
      await persistHandResult(supabase, data, showdown)
    } catch (err) {
      console.error('[game] Failed to persist hand result:', err)
    }
    io.to(`table:${tableId}`).emit('showdown_result', showdown)
    scheduleAutoStart(tableId)
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

  async function doStartHand(tableId: string): Promise<null | 'too_few' | 'failed' | 'session_expired'> {
    if (gm.hasActiveHand(tableId)) return 'failed'

    // Block new hands when the session has expired.
    if (sm.isActive(tableId) && sm.isExpired(tableId)) return 'session_expired'

    const { data: tableData } = await supabase
      .from('poker_tables')
      .select('name, small_blind, big_blind, table_type, status')
      .eq('id', tableId)
      .single()

    if (!tableData || (tableData as { status: string }).status === 'closed') return 'failed'

    const { name: tableName, small_blind, big_blind, table_type } = tableData as {
      name: string; small_blind: number; big_blind: number; table_type: 'timer' | 'open'
    }

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

    const allSeated = rows.map(r => ({
      playerId: r.player_id,
      seatNumber: r.seat_number,
      username: usernameMap.get(r.player_id) ?? 'Unknown',
    }))

    // ── Remove zero-chip players before the hand starts ─────────────────────
    const { data: walletData } = await supabase
      .from('wallets')
      .select('user_id, chips')
      .in('user_id', allSeated.map(p => p.playerId))

    const walletChips = new Map<string, number>(
      ((walletData as Array<{ user_id: string; chips: number }> | null) ?? [])
        .map(w => [w.user_id, w.chips])
    )

    const broke = allSeated.filter(p => (walletChips.get(p.playerId) ?? 0) === 0)
    const seatedPlayers = allSeated.filter(p => (walletChips.get(p.playerId) ?? 0) > 0)

    if (broke.length > 0) {
      await Promise.all(broke.map(p =>
        supabase
          .from('table_players')
          .update({ status: 'spectating', seat_number: null })
          .eq('table_id', tableId)
          .eq('player_id', p.playerId)
          .eq('status', 'seated')
      ))
      console.log(`[game] demoted broke players to spectating: ${broke.map(p => p.username).join(', ')}  table=${tableId}`)
      // Broadcast updated seating so clients see the change before cards fly.
      const updated = await buildTableState(supabase, tableId)
      if (updated) io.to(`table:${tableId}`).emit('table_state', updated)
    }

    if (seatedPlayers.length < 2) return 'too_few'

    const result = await gm.startHand(tableId, seatedPlayers, supabase, small_blind, big_blind)
    if ('error' in result) return 'failed'

    // Start the 1-hour session on the very first hand.
    if (!sm.isActive(tableId)) {
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
    // Don't queue a new hand when the session has expired.
    if (sm.isActive(tableId) && sm.isExpired(tableId)) {
      console.log(`[session] expired — skipping auto-start  table=${tableId}`)
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

    // Admins get real-time session updates for all tables.
    if (socket.data.role === 'admin') {
      socket.join('admin_room')
      for (const session of sm.getAllSessions()) {
        socket.emit('session_update', {
          tableId: session.tableId,
          tableName: session.tableName,
          secondsRemaining: sm.getSecondsRemaining(session.tableId),
          isExpired: sm.isExpired(session.tableId),
        })
      }
    }

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
    })

    // ── leave_table ────────────────────────────────────────────────────────
    socket.on('leave_table', async ({ tableId }) => {
      // Block voluntary leaves while the session is running — 'open' tables never lock.
      if (sm.lockLeaving(tableId) && socket.data.role !== 'admin') {
        socket.emit('socket_error', { message: 'Session in progress — you cannot leave until the session ends.' })
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
          startTurnTimer(tableId, next.currentTurnPlayerId)
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
            if (next?.currentTurnPlayerId) startTurnTimer(tableId, next.currentTurnPlayerId)
          }
        }
      }
      await leaveTable(supabase, tableId, playerId)
      // Notify and eject the kicked player's sockets.
      const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
      for (const s of roomSockets) {
        if (s.data.userId === playerId) {
          s.emit('kicked_from_table', { tableId })
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
        // Keep seat when session is running (player is expected to reconnect)
        // or when a hand is in progress (hand-end logic handles seat cleanup).
        // 'open' tables never lock the seat this way.
        const sessionLocked = sm.lockLeaving(tableId)
        if (!gm.hasActiveHand(tableId) && !sessionLocked) {
          await leaveTable(supabase, tableId, userId)
        }
        const state = await buildTableState(supabase, tableId)
        if (state) io.to(`table:${tableId}`).emit('table_state', state)
      }
    })
  })

  // ── Session countdown broadcast ─────────────────────────────────────────
  // Every 5 s: push the current seconds-remaining to all table rooms + admin.
  setInterval(() => {
    for (const session of sm.getAllSessions()) {
      emitSessionUpdate(session.tableId)
    }
  }, 5_000)

  httpServer.listen(port, hostname, () => {
    console.log(
      `> Ready on http://${hostname}:${port} [${dev ? 'development' : 'production'}]`,
    )
  })
})
