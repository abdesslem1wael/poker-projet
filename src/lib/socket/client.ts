'use client'

import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from './types'
import { createClient as createSupabaseClient } from '@/lib/supabase/browser'

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>

// Module-level singleton — one socket per browser tab.
let socket: AppSocket | null = null

export async function getSocket(): Promise<AppSocket> {
  const supabase = createSupabaseClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const token = session?.access_token ?? ''

  // If the cached socket belongs to a different user (e.g. after logout + login in the
  // same tab without a full page reload), tear it down so we reconnect with the current
  // user's credentials.  Next.js App Router keeps module-level state alive across
  // client-side navigations, so this guard is necessary.
  if (socket && (socket.auth as { token?: string }).token !== token) {
    socket.disconnect()
    socket = null
  }

  if (socket?.connected) return socket
  // Tear down a stale disconnected socket before creating a new one.
  if (socket) {
    socket.disconnect()
    socket = null
  }

  socket = io({
    // Connect to the same origin — custom server serves Next.js + Socket.io on one port.
    auth: { token },
    autoConnect: true,
  })

  return socket
}

export function disconnectSocket(): void {
  socket?.disconnect()
  socket = null
}
