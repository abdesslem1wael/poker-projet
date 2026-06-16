'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSocket } from '@/lib/socket/client'

export type LiveTable = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  status: 'waiting' | 'active'
}

export default function WatchTablesPanel({ tables }: { tables: LiveTable[] }) {
  const router = useRouter()
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function watch(tableId: string) {
    setLoadingId(tableId)
    setError(null)
    getSocket().then((socket) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        socket.off('spectator_joined', onJoined)
        socket.off('socket_error', onErr)
      }
      const onJoined = ({ tableId: tid }: { tableId: string }) => {
        if (tid !== tableId) return
        settle()
        setLoadingId(null)
        router.push(`/table/${tableId}`)
      }
      const onErr = ({ message }: { message: string }) => {
        settle()
        setLoadingId(null)
        setError(message)
      }
      socket.on('spectator_joined', onJoined)
      socket.on('socket_error', onErr)
      socket.emit('spectate_table', { tableId })
    })
  }

  if (tables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 py-12 text-center">
        <p className="text-zinc-500 text-sm">No active tables right now.</p>
        <p className="mt-1 text-xs text-zinc-600">Create one in Tables management below.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-red-900/50 bg-red-900/20 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tables.map((t) => {
          const isActive = t.status === 'active'
          return (
            <div
              key={t.id}
              className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-zinc-100 truncate">{t.name}</h3>
                <span className={[
                  'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                  isActive
                    ? 'bg-green-900/60 text-green-400 ring-1 ring-green-700/50'
                    : 'bg-amber-900/60 text-amber-400 ring-1 ring-amber-700/50',
                ].join(' ')}>
                  {isActive ? 'In Progress' : 'Open'}
                </span>
              </div>

              <div className="rounded-lg bg-zinc-800/60 px-3 py-2 text-sm">
                <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Blinds</p>
                <p className="mt-0.5 font-semibold tabular-nums text-zinc-200">
                  {t.small_blind.toLocaleString()} / {t.big_blind.toLocaleString()}
                </p>
              </div>

              <button
                onClick={() => watch(t.id)}
                disabled={loadingId !== null}
                className="w-full rounded-lg border border-zinc-700 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingId === t.id ? 'Connecting…' : 'Watch Table'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
