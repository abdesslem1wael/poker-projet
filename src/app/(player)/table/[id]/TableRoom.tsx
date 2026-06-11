'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { TableStatePayload } from '@/lib/socket/types'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'

type Props = {
  initialState: TableStatePayload
  currentUserId: string
  myStatus: 'seated' | 'spectating'
  mySeatNumber: number | null
}

export default function TableRoom({
  initialState,
  currentUserId,
  myStatus,
  mySeatNumber,
}: Props) {
  const router = useRouter()
  const [state, setState] = useState<TableStatePayload>(initialState)
  const [leaving, setLeaving] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket: AppSocket) => {
      if (!active) return

      setConnected(socket.connected)

      const onConnect = () => { if (active) setConnected(true) }
      const onDisconnect = () => { if (active) setConnected(false) }
      const onTableState = (payload: TableStatePayload) => {
        if (active && payload.tableId === initialState.tableId) {
          setState(payload)
        }
      }

      socket.on('connect', onConnect)
      socket.on('disconnect', onDisconnect)
      socket.on('table_state', onTableState)

      cleanup = () => {
        socket.off('connect', onConnect)
        socket.off('disconnect', onDisconnect)
        socket.off('table_state', onTableState)
      }
    })

    return () => {
      active = false
      cleanup?.()
    }
  }, [initialState.tableId])

  function handleLeave() {
    setLeaving(true)
    getSocket().then((socket) => {
      const onLeft = ({ tableId }: { tableId: string }) => {
        if (tableId !== initialState.tableId) return
        socket.off('table_left', onLeft)
        router.push('/lobby')
      }
      socket.on('table_left', onLeft)
      socket.emit('leave_table', { tableId: initialState.tableId })
    })
  }

  const tableStatusBadge = {
    waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    closed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  }[state.status]

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{state.tableName}</h1>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${tableStatusBadge}`}
          >
            {state.status}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span
              className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`}
            />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
          <button
            onClick={handleLeave}
            disabled={leaving}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {leaving ? 'Leaving…' : 'Leave Table'}
          </button>
        </div>
      </div>

      {/* Table info */}
      <div className="flex gap-6 text-sm text-zinc-500">
        <span>
          Blinds:{' '}
          <span className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
            {state.smallBlind}/{state.bigBlind}
          </span>
        </span>
        <span>
          {myStatus === 'spectating' ? (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              Spectating
            </span>
          ) : (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
              Seat {mySeatNumber}
            </span>
          )}
        </span>
      </div>

      {/* Seat grid */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-500">
          Seats ({state.seats.filter((s) => s.playerId !== null).length}/{state.maxPlayers})
        </h2>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
          {state.seats.map((seat) => {
            const isMe = seat.playerId === currentUserId
            const occupied = seat.playerId !== null

            return (
              <div
                key={seat.seatNumber}
                className={[
                  'flex flex-col items-center rounded-lg border p-3 text-center',
                  isMe
                    ? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/30'
                    : occupied
                    ? 'border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900'
                    : 'border-dashed border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950',
                ].join(' ')}
              >
                <span className="text-xs text-zinc-400">#{seat.seatNumber}</span>
                {occupied ? (
                  <span className="mt-1 text-sm font-medium truncate w-full">
                    {seat.username}
                    {isMe && (
                      <span className="block text-xs font-normal text-blue-500">
                        (you)
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="mt-1 text-xs text-zinc-400">Empty</span>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Spectators */}
      {state.spectators.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-500">
            Spectators ({state.spectators.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {state.spectators.map((s) => (
              <span
                key={s.playerId}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
              >
                {s.username}
                {s.playerId === currentUserId && (
                  <span className="text-zinc-400">(you)</span>
                )}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* No gameplay yet notice */}
      <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-400 dark:border-zinc-800">
        Gameplay coming soon. Waiting for all players…
      </div>
    </main>
  )
}
