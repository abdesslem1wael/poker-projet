'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  status: 'waiting' | 'active'
}

export default function TableCard({ table }: { table: TableRow }) {
  const router = useRouter()
  const [loading, setLoading] = useState<'join' | 'spectate' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function withListeners(
    socket: AppSocket,
    tableId: string,
    onSuccess: () => void,
  ) {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      socket.off('table_joined', onJoined)
      socket.off('spectator_joined', onSpectated)
      socket.off('socket_error', onError)
    }
    const onJoined = ({ tableId: tid }: { tableId: string; seatNumber: number }) => {
      if (tid !== tableId) return
      settle(); setLoading(null); onSuccess()
    }
    const onSpectated = ({ tableId: tid }: { tableId: string }) => {
      if (tid !== tableId) return
      settle(); setLoading(null); onSuccess()
    }
    const onError = ({ message }: { message: string }) => {
      settle(); setLoading(null); setError(message)
    }
    socket.on('table_joined', onJoined)
    socket.on('spectator_joined', onSpectated)
    socket.on('socket_error', onError)
  }

  function handleJoin() {
    setLoading('join'); setError(null)
    getSocket().then((socket) => {
      withListeners(socket, table.id, () => router.push(`/table/${table.id}`))
      socket.emit('join_table', { tableId: table.id })
    })
  }

  function handleSpectate() {
    setLoading('spectate'); setError(null)
    getSocket().then((socket) => {
      withListeners(socket, table.id, () => router.push(`/table/${table.id}`))
      socket.emit('spectate_table', { tableId: table.id })
    })
  }

  const isActive = table.status === 'active'

  return (
    <div className="group flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-5 transition-colors hover:border-zinc-600 hover:bg-zinc-900">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-zinc-100 truncate">{table.name}</h3>
        <span className={[
          'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
          isActive
            ? 'bg-green-900/60 text-green-400 ring-1 ring-green-700/50'
            : 'bg-amber-900/60 text-amber-400 ring-1 ring-amber-700/50',
        ].join(' ')}>
          {isActive ? 'In Progress' : 'Open'}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-zinc-800/60 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Blinds</p>
          <p className="mt-0.5 font-semibold tabular-nums text-zinc-200">
            {table.small_blind.toLocaleString()} / {table.big_blind.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg bg-zinc-800/60 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Max Seats</p>
          <p className="mt-0.5 font-semibold text-zinc-200">{table.max_players}</p>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-950/40 px-3 py-1.5 text-xs text-red-400 ring-1 ring-red-800/50">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleJoin}
          disabled={loading !== null}
          className="flex-1 rounded-lg bg-green-700 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading === 'join' ? 'Joining…' : 'Join Table'}
        </button>
        <button
          onClick={handleSpectate}
          disabled={loading !== null}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading === 'spectate' ? '…' : 'Watch'}
        </button>
      </div>
    </div>
  )
}
