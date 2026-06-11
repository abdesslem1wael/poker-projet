'use client'

import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from './types'
import { createClient as createSupabaseClient } from '@/lib/supabase/browser'

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>

// Module-level singleton — one socket per browser tab.
let socket: AppSocket | null = null

export async function getSocket(): Promise<AppSocket> {
  if (socket?.connected) return socket
  // Tear down a stale disconnected socket before creating a new one.
  if (socket) {
    socket.disconnect()
    socket = null
  }

  const supabase = createSupabaseClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()

  socket = io({
    // Connect to the same origin — custom server serves Next.js + Socket.io on one port.
    auth: { token: session?.access_token ?? '' },
    autoConnect: true,
  })

  return socket
}

export function disconnectSocket(): void {
  socket?.disconnect()
  socket = null
}
