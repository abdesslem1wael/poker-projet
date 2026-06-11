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

const statusBadge: Record<TableRow['status'], string> = {
  waiting:
    'inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  active:
    'inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400',
}

export default function TableCard({ table }: { table: TableRow }) {
  const router = useRouter()
  const [loading, setLoading] = useState<'join' | 'spectate' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function withListeners(
    socket: AppSocket,
    tableId: string,
    onSuccess: () => void
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
      settle()
      setLoading(null)
      onSuccess()
    }

    const onSpectated = ({ tableId: tid }: { tableId: string }) => {
      if (tid !== tableId) return
      settle()
      setLoading(null)
      onSuccess()
    }

    const onError = ({ message }: { message: string }) => {
      settle()
      setLoading(null)
      setError(message)
    }

    socket.on('table_joined', onJoined)
    socket.on('spectator_joined', onSpectated)
    socket.on('socket_error', onError)
  }

  function handleJoin() {
    setLoading('join')
    setError(null)

    getSocket().then((socket) => {
      withListeners(socket, table.id, () => {
        router.push(`/table/${table.id}`)
      })
      socket.emit('join_table', { tableId: table.id })
    })
  }

  function handleSpectate() {
    setLoading('spectate')
    setError(null)

    getSocket().then((socket) => {
      withListeners(socket, table.id, () => {
        router.push(`/table/${table.id}`)
      })
      socket.emit('spectate_table', { tableId: table.id })
    })
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold">{table.name}</h3>
        <span className={statusBadge[table.status]}>{table.status}</span>
      </div>

      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-zinc-500">Blinds</dt>
          <dd className="tabular-nums">
            {table.small_blind}/{table.big_blind}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Max players</dt>
          <dd>{table.max_players}</dd>
        </div>
      </dl>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleJoin}
          disabled={loading !== null}
          className="flex-1 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {loading === 'join' ? 'Joining…' : 'Join Table'}
        </button>
        <button
          onClick={handleSpectate}
          disabled={loading !== null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {loading === 'spectate' ? 'Joining…' : 'Spectate'}
        </button>
      </div>
    </div>
  )
}
