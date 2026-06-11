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
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from './src/lib/socket/types'

const port = parseInt(process.env.PORT ?? '3000', 10)
const dev = process.env.NODE_ENV !== 'production'
const hostname = 'localhost'

const nextApp = next({ dev, hostname, port })
const handle = nextApp.getRequestHandler()

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

      const state = await getTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
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

      const state = await getTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── leave_table ────────────────────────────────────────────────────────
    socket.on('leave_table', async ({ tableId }) => {
      await leaveTable(supabase, tableId, userId)

      socket.data.joinedTables.delete(tableId)
      socket.leave(`table:${tableId}`)

      socket.emit('table_left', { tableId })

      const state = await getTableState(supabase, tableId)
      if (state) io.to(`table:${tableId}`).emit('table_state', state)
    })

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`[socket] disconnected user=${username} socket=${socket.id}`)

      for (const tableId of socket.data.joinedTables) {
        await leaveTable(supabase, tableId, userId)
        const state = await getTableState(supabase, tableId)
        if (state) io.to(`table:${tableId}`).emit('table_state', state)
      }
    })
  })

  httpServer.listen(port, hostname, () => {
    console.log(
      `> Ready on http://${hostname}:${port} [${dev ? 'development' : 'production'}]`
    )
  })
})
