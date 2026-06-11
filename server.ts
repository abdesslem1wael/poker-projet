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

// ── Helpers ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildTableState(supabase: any, tableId: string): Promise<TableStatePayload | null> {
  const base = await getTableState(supabase, tableId)
  if (!base) return null
  return { ...base, handState: gm.getPublicHandState(tableId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persistHandResult(supabase: any, data: HandEndedData, showdown: ShowdownPayload): Promise<void> {
  // 1. Update each player's wallet to their final stack.
  //    We use individual updates rather than a batch RPC because the service-role
  //    client bypasses RLS and each call is fast; a transaction-level RPC would
  //    require a new migration.
  for (const p of showdown.players) {
    const { error } = await supabase
      .from('wallets')
      .update({ chips: p.finalStack, updated_at: new Date().toISOString() })
      .eq('user_id', p.playerId)
    if (error) console.error(`[persist] wallet update failed  user=${p.playerId}`, error)
  }

  // 2. Insert win/loss transactions.
  //    The transactions table requires amount > 0, so skip net-zero outcomes.
  for (const p of showdown.players) {
    const contribution = data.players.find(hp => hp.playerId === p.playerId)!.totalContributed
    const netGain = p.chipDelta - contribution
    if (netGain === 0) continue  // no transaction for break-even (e.g. returned partial blind)

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
    chipDeltasJson[p.playerId] = p.chipDelta - contribution  // net gain/loss
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
        // Hole cards omitted from history JSON — they are derivable from game_history
        // result_json only if we choose to add them later. For now we keep it clean.
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
      socket.join(`table:${tableId}`)

      socket.emit('table_joined', { tableId, seatNumber: result.seatNumber })

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)

      // Send existing hole cards if a hand is in progress.
      const cards = gm.getPlayerHoleCards(tableId, userId)
      if (cards) socket.emit('deal_cards', { tableId, holeCards: cards })
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
      await leaveTable(supabase, tableId, userId)

      socket.data.joinedTables.delete(tableId)
      socket.leave(`table:${tableId}`)

      socket.emit('table_left', { tableId })

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── start_hand ─────────────────────────────────────────────────────────
    socket.on('start_hand', async ({ tableId }) => {
      if (!socket.data.joinedTables.has(tableId)) {
        socket.emit('socket_error', { message: 'You are not at this table' })
        return
      }

      if (gm.hasActiveHand(tableId)) {
        socket.emit('socket_error', { message: 'A hand is already in progress' })
        return
      }

      // Load table config (blinds, status).
      const { data: tableData } = await supabase
        .from('poker_tables')
        .select('small_blind, big_blind, status')
        .eq('id', tableId)
        .single()

      if (!tableData || (tableData as { status: string }).status === 'closed') {
        socket.emit('socket_error', { message: 'Table not found or is closed' })
        return
      }

      const { small_blind, big_blind } = tableData as {
        small_blind: number
        big_blind: number
      }

      // Load currently seated players.
      const { data: playersData } = await supabase
        .from('table_players')
        .select('player_id, seat_number')
        .eq('table_id', tableId)
        .eq('status', 'seated')

      const rows = (playersData as Array<{ player_id: string; seat_number: number }> | null) ?? []

      if (rows.length < 2) {
        socket.emit('socket_error', { message: 'Need at least 2 seated players to start' })
        return
      }

      // Resolve usernames.
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

      if ('error' in result) {
        socket.emit('socket_error', { message: result.error })
        return
      }

      console.log(`[game] hand started  table=${tableId}`)

      // Send each seated socket its private hole cards.
      const roomSockets = await io.in(`table:${tableId}`).fetchSockets()
      for (const s of roomSockets) {
        const cards = gm.getPlayerHoleCards(tableId, s.data.userId)
        if (cards) s.emit('deal_cards', { tableId, holeCards: cards })
      }

      // Broadcast the full public state.
      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── player_action ──────────────────────────────────────────────────────
    socket.on('player_action', async ({ tableId, action, amount }) => {
      if (!socket.data.joinedTables.has(tableId)) {
        socket.emit('socket_error', { message: 'You are not at this table' })
        return
      }

      const result = gm.processAction(tableId, userId, action, amount)

      if ('error' in result) {
        socket.emit('socket_error', { message: result.error })
        return
      }

      console.log(
        `[game] action  table=${tableId} user=${username} action=${action}${amount != null ? ` amount=${amount}` : ''}`,
      )

      // Broadcast the action to the room.
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
      }

      const state = await buildTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`[socket] disconnected user=${username} socket=${socket.id}`)

      for (const tableId of socket.data.joinedTables) {
        await leaveTable(supabase, tableId, userId)
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
