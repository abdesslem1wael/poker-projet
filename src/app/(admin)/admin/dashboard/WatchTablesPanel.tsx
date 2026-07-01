'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'
import type { BreakStatePayload } from '@/lib/socket/types'

export type LiveTable = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  status: 'waiting' | 'active'
}

type BreakState = BreakStatePayload & { syncedAt: number }

function formatBreakStatus(b: BreakState | undefined, now: number): string | null {
  if (!b || b.phase === null) return null
  const elapsed = Math.floor((now - b.syncedAt) / 1000)
  if (b.phase === 'countdown') {
    const secs = Math.max(0, b.countdownSecondsRemaining - elapsed)
    return `Break starts in ${secs}s`
  }
  if (b.phase === 'awaiting_hand_end') {
    return 'Break starts after current hand'
  }
  // active
  const secs = Math.max(0, b.breakSecondsRemaining - elapsed)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `Break active ${m}:${s.toString().padStart(2, '0')} remaining`
}

export default function WatchTablesPanel({ tables }: { tables: LiveTable[] }) {
  const router = useRouter()
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [socket, setSocket] = useState<AppSocket | null>(null)
  const [breaks, setBreaks] = useState<Map<string, BreakState>>(new Map())
  const [breakStartingId, setBreakStartingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let active = true

    getSocket().then((s) => {
      if (!active) return
      setSocket(s)

      const onBreakUpdate = (p: BreakStatePayload) => {
        if (!active) return
        setBreaks((prev) => {
          const next = new Map(prev)
          if (p.phase === null) {
            next.delete(p.tableId)
          } else {
            next.set(p.tableId, { ...p, syncedAt: Date.now() })
          }
          return next
        })
      }
      const onSocketError = ({ message }: { message: string }) => {
        if (!active) return
        setBreakStartingId(null)
        setError(message)
      }

      s.on('break_update', onBreakUpdate)
      s.on('socket_error', onSocketError)
      return () => {
        s.off('break_update', onBreakUpdate)
        s.off('socket_error', onSocketError)
      }
    })

    return () => { active = false }
  }, [])

  // Local 1s tick so countdowns stay live between server syncs.
  useEffect(() => {
    if (breaks.size === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [breaks.size])

  function startBreak(tableId: string) {
    if (!socket) return
    setError(null)
    setBreakStartingId(tableId)
    socket.emit('start_break', { tableId })
    // The break_update broadcast (and thus the disappearance of the "Start
    // Break" button) is what actually clears the loading state; this is just
    // a safety timeout in case the server never responds.
    setTimeout(() => setBreakStartingId((id) => (id === tableId ? null : id)), 4000)
  }

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

              {(() => {
                const breakStatus = formatBreakStatus(breaks.get(t.id), now)
                return breakStatus ? (
                  <div className="rounded-lg border border-amber-800/50 bg-amber-900/20 px-3 py-2 text-xs font-semibold text-amber-400">
                    ⏸ {breakStatus}
                  </div>
                ) : null
              })()}

              <button
                onClick={() => watch(t.id)}
                disabled={loadingId !== null}
                className="w-full rounded-lg border border-zinc-700 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingId === t.id ? 'Connecting…' : 'Watch Table'}
              </button>

              {!breaks.has(t.id) && (
                <button
                  onClick={() => startBreak(t.id)}
                  disabled={breakStartingId !== null || !socket}
                  title="Start a break for this table"
                  className="w-full rounded-lg border border-amber-800/50 py-2 text-sm font-semibold text-amber-400 transition-colors hover:bg-amber-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {breakStartingId === t.id ? 'Starting…' : 'Start Break'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
