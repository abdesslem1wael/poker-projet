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

  // Reuse the existing instance whenever one exists — whether it's already
  // connected OR still mid-handshake. Do NOT treat "not connected yet" as
  // "stale and needs replacing": pages that mount multiple components which
  // each call getSocket() on mount (e.g. the admin dashboard's
  // WatchTablesPanel + SessionPanel), or React Strict Mode's duplicate
  // effect invoke in development, call this function concurrently. The
  // previous logic disconnected+recreated the socket on every call that
  // observed `connected === false`, which — since a fresh socket takes a
  // real network round-trip to connect — meant concurrent callers kept
  // killing each other's not-yet-connected socket before any of them ever
  // finished the handshake, so the socket never actually connected at all.
  // Socket.IO's own built-in reconnection logic (on by default) already
  // handles retries; we only need a genuinely new instance on an auth change.
  if (socket) return socket

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
