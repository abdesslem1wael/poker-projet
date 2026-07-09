'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'
import type { BreakStatePayload, LastHandsStatePayload } from '@/lib/socket/types'

export type LiveTable = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  status: 'waiting' | 'active'
  game_mode: 'cash' | 'sit_go'
}

type BreakState = BreakStatePayload & { syncedAt: number }

const LAST_HANDS_COUNT = 10
const LAST_HANDS_TOPUP = 5

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
  const [info, setInfo] = useState<string | null>(null)
  const [socket, setSocket] = useState<AppSocket | null>(null)
  // socket.connected is a mutable field on the socket.io-client instance —
  // reading it directly does NOT trigger a re-render when it flips (e.g. once
  // the initial connection finishes after this component already rendered
  // with the socket in a not-yet-connected state). Mirror it into React state
  // via connect/disconnect listeners so button `disabled` checks and click
  // handlers always see the current value, not whatever it was on first render.
  const [socketConnected, setSocketConnected] = useState(false)
  const [breaks, setBreaks] = useState<Map<string, BreakState>>(new Map())
  const [breakStartingId, setBreakStartingId] = useState<string | null>(null)
  const [lastHands, setLastHands] = useState<Map<string, number>>(new Map())
  const [closedTables, setClosedTables] = useState<Set<string>>(new Set())
  const [lastHandsStartingId, setLastHandsStartingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let active = true

    getSocket().then((s) => {
      if (!active) return
      setSocket(s)
      // Set the initial value from whatever the socket already is — it may
      // already be connected (e.g. reused from a prior mount) or still
      // mid-handshake (freshly created by getSocket()).
      setSocketConnected(s.connected)

      // Defensive kick: getSocket() always creates its sockets with
      // autoConnect: true, so this should normally be a no-op — but if
      // anything ever left this instance in a non-connecting disconnected
      // state, make sure we actually try instead of sitting there forever.
      if (!s.connected) s.connect()

      const onConnect = () => {
        if (!active) return
        console.log('[last-hands] admin socket connected', { socketId: s.id })
        setSocketConnected(true)
        // A fresh connection means any previous "disconnected"/timeout error
        // is now stale — clear it so the banner disappears automatically.
        setError(null)
      }
      const onDisconnect = (reason: string) => {
        if (!active) return
        console.log('[last-hands] admin socket disconnected', { socketId: s.id, reason })
        setSocketConnected(false)
      }
      const onConnectError = (err: Error) => {
        if (!active) return
        console.error('[last-hands] admin socket connect_error', err)
        setError(`Socket connection error: ${err.message}`)
      }

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
      const onLastHandsUpdate = (p: LastHandsStatePayload) => {
        if (!active) return
        if (p.remaining === null) {
          // Either never started, or — if we already had an entry — the table
          // just closed after its final hand.
          setLastHands((prev) => {
            if (!prev.has(p.tableId)) return prev
            const next = new Map(prev)
            next.delete(p.tableId)
            return next
          })
          setClosedTables((prev) => (prev.has(p.tableId) ? prev : new Set(prev).add(p.tableId)))
        } else {
          setLastHands((prev) => new Map(prev).set(p.tableId, p.remaining as number))
          setLastHandsStartingId((id) => (id === p.tableId ? null : id))
        }
      }
      const onSocketError = ({ message }: { message: string }) => {
        if (!active) return
        setBreakStartingId(null)
        setLastHandsStartingId(null)
        setError(message)
      }

      s.on('connect', onConnect)
      s.on('disconnect', onDisconnect)
      s.on('connect_error', onConnectError)
      s.on('break_update', onBreakUpdate)
      s.on('last_hands_update', onLastHandsUpdate)
      s.on('socket_error', onSocketError)
      return () => {
        s.off('connect', onConnect)
        s.off('disconnect', onDisconnect)
        s.off('connect_error', onConnectError)
        s.off('break_update', onBreakUpdate)
        s.off('last_hands_update', onLastHandsUpdate)
        s.off('socket_error', onSocketError)
      }
    }).catch((err) => {
      // getSocket() itself rejected (e.g. supabase.auth.getSession() threw)
      // before a socket was ever created — without this, `socket` and
      // `socketConnected` would stay stuck at their initial null/false
      // forever with zero indication why.
      if (!active) return
      console.error('[last-hands] getSocket failed', err)
      setError(`Failed to obtain a socket connection: ${err instanceof Error ? err.message : String(err)}`)
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
    if (!socket || !socketConnected) return
    setError(null)
    setBreakStartingId(tableId)
    socket.emit('start_break', { tableId })
    // The break_update broadcast (and thus the disappearance of the "Start
    // Break" button) is what actually clears the loading state; this is just
    // a safety timeout in case the server never responds.
    setTimeout(() => setBreakStartingId((id) => (id === tableId ? null : id)), 4000)
  }

  function startLastHands(tableId: string) {
    console.log('[last-hands] "Last 10 Hands" button clicked', { tableId, hasSocket: !!socket, socketConnected })

    if (!socket) {
      console.warn('[last-hands] no socket instance yet — cannot emit start_last_hands')
      setError('Not connected to the server yet — wait a moment and try again.')
      return
    }
    // Use the reactive socketConnected state, not socket.connected read
    // directly — the latter can be stale relative to this render (see the
    // comment on the socketConnected declaration above).
    if (!socketConnected) {
      console.warn('[last-hands] socket exists but is disconnected', { socketId: socket.id })
      setError('Socket is disconnected — waiting to reconnect. Try again shortly.')
      return
    }

    setError(null)
    setInfo(null)
    setLastHandsStartingId(tableId)

    console.log('[last-hands] emitting start_last_hands', { tableId, count: LAST_HANDS_COUNT })
    socket.timeout(6000).emit('start_last_hands', { tableId, count: LAST_HANDS_COUNT }, (err, response) => {
      console.log('[last-hands] start_last_hands ack', { tableId, err, response })
      setLastHandsStartingId((id) => (id === tableId ? null : id))
      if (err) {
        setError('No response from server (timed out) — check the server logs.')
        return
      }
      if (!response.ok) {
        setError(response.error)
        return
      }
      setInfo(`Last Hands started (${LAST_HANDS_COUNT} hands) for this table.`)
    })
  }

  function addLastHands(tableId: string) {
    console.log('[last-hands] "+5 Hands" button clicked', { tableId, hasSocket: !!socket, socketConnected })

    if (!socket) {
      console.warn('[last-hands] no socket instance yet — cannot emit add_last_hands')
      setError('Not connected to the server yet — wait a moment and try again.')
      return
    }
    if (!socketConnected) {
      console.warn('[last-hands] socket exists but is disconnected', { socketId: socket.id })
      setError('Socket is disconnected — waiting to reconnect. Try again shortly.')
      return
    }

    setError(null)
    setInfo(null)

    console.log('[last-hands] emitting add_last_hands', { tableId, additional: LAST_HANDS_TOPUP })
    socket.timeout(6000).emit('add_last_hands', { tableId, additional: LAST_HANDS_TOPUP }, (err, response) => {
      console.log('[last-hands] add_last_hands ack', { tableId, err, response })
      if (err) {
        setError('No response from server (timed out) — check the server logs.')
        return
      }
      if (!response.ok) {
        setError(response.error)
        return
      }
      setInfo(`Added ${LAST_HANDS_TOPUP} more hands.`)
    })
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
      {info && (
        <p className="rounded-lg border border-emerald-900/50 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-400">
          {info}
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
                  disabled={breakStartingId !== null || !socketConnected}
                  title="Start a break for this table"
                  className="w-full rounded-lg border border-amber-800/50 py-2 text-sm font-semibold text-amber-400 transition-colors hover:bg-amber-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {breakStartingId === t.id ? 'Starting…' : 'Start Break'}
                </button>
              )}

              {closedTables.has(t.id) ? (
                <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-center text-xs font-semibold text-zinc-500">
                  Table closed
                </div>
              ) : lastHands.has(t.id) ? (
                <>
                  <div className="rounded-lg border border-blue-800/50 bg-blue-900/20 px-3 py-2 text-xs font-semibold text-blue-400">
                    🏁 Last hands: {lastHands.get(t.id)} remaining
                  </div>
                  <button
                    onClick={() => addLastHands(t.id)}
                    disabled={!socketConnected}
                    title="Add 5 more hands before this table closes"
                    className="w-full rounded-lg border border-blue-800/50 py-2 text-sm font-semibold text-blue-400 transition-colors hover:bg-blue-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    +5 Hands
                  </button>
                </>
              ) : (
                // Every table in this list is already non-closed (filtered in
                // page.tsx) — poker_tables.status never actually transitions
                // to 'active' anywhere in this codebase (it's waiting/closed
                // only), so gating on it would make this button unreachable.
                t.game_mode === 'cash' && (
                  <button
                    onClick={() => startLastHands(t.id)}
                    disabled={lastHandsStartingId !== null || !socketConnected}
                    title="Play 10 more hands, then close this table automatically"
                    className="w-full rounded-lg border border-blue-800/50 py-2 text-sm font-semibold text-blue-400 transition-colors hover:bg-blue-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {lastHandsStartingId === t.id ? 'Starting…' : 'Last 10 Hands'}
                  </button>
                )
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
