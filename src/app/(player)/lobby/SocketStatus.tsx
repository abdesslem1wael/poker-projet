'use client'

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'

type Status = 'connecting' | 'connected' | 'disconnected'

const dot: Record<Status, string> = {
  connecting:   'bg-amber-400 animate-pulse',
  connected:    'bg-green-400',
  disconnected: 'bg-red-400',
}

const label: Record<Status, string> = {
  connecting:   'Connecting…',
  connected:    'Connected',
  disconnected: 'Disconnected',
}

export default function SocketStatus() {
  const [status, setStatus] = useState<Status>('connecting')

  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket: AppSocket) => {
      if (!active) return

      if (socket.connected) setStatus('connected')

      const onConnect    = () => { if (active) setStatus('connected') }
      const onDisconnect = () => { if (active) setStatus('disconnected') }
      const onError      = () => { if (active) setStatus('disconnected') }

      socket.on('connect',       onConnect)
      socket.on('disconnect',    onDisconnect)
      socket.on('connect_error', onError)

      cleanup = () => {
        socket.off('connect',       onConnect)
        socket.off('disconnect',    onDisconnect)
        socket.off('connect_error', onError)
      }
    })

    return () => { active = false; cleanup?.() }
  }, [])

  return (
    // shrink-0 so the dot never gets squashed inside the header flex row.
    // Label is hidden on phones (< sm) — the dot alone communicates status
    // and prevents header overflow on 320 px screens like iPhone SE.
    <div className="flex shrink-0 items-center gap-1.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot[status]}`} />
      <span className="hidden text-xs text-zinc-500 sm:inline">{label[status]}</span>
    </div>
  )
}
