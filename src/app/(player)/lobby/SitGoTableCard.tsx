'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { registerSitGoAction, unregisterSitGoAction } from '@/app/actions/sitgo'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'

type SitGoPlayerRow = {
  playerId: string
  username: string
  status: 'registered' | 'eliminated' | 'winner'
  rank: number | null
}

type SitGoTableRow = {
  id: string
  name: string
  buy_in: number
  starting_stack: number
  small_blind: number
  big_blind: number
  max_players: number
  prize_pool: number
  sit_go_status: 'registering' | 'ready' | 'running' | 'finished'
  registeredCount: number
  isRegistered: boolean
  blind_level: number
  players: SitGoPlayerRow[]
}

const statusLabel: Record<SitGoTableRow['sit_go_status'], string> = {
  registering: 'Registering',
  ready: 'Ready',
  running: 'In Progress',
  finished: 'Finished',
}

export default function SitGoTableCard({
  table,
  canRegister,
  playerChips,
}: {
  table: SitGoTableRow
  canRegister: boolean
  playerChips: number
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isUnregistering, startUnregisterTransition] = useTransition()
  const [entering, setEntering] = useState<'enter' | 'watch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [justRegistered, setJustRegistered] = useState(false)
  const [justUnregistered, setJustUnregistered] = useState(false)
  const [showJoinScreen, setShowJoinScreen] = useState(false)

  const isFull = table.registeredCount >= table.max_players
  const isRegistered = (table.isRegistered || justRegistered) && !justUnregistered
  const notEnoughChips = playerChips < table.buy_in
  const busy = isPending || isUnregistering || entering !== null

  function handleRegister() {
    setError(null)
    startTransition(async () => {
      const res = await registerSitGoAction(table.id)
      if ('error' in res) {
        setError(res.error)
        return
      }
      setJustUnregistered(false)
      setJustRegistered(true)
    })
  }

  function handleUnregister() {
    setError(null)
    startUnregisterTransition(async () => {
      const res = await unregisterSitGoAction(table.id)
      if ('error' in res) {
        setError(res.error)
        return
      }
      setJustRegistered(false)
      setJustUnregistered(true)
    })
  }

  function withListeners(socket: AppSocket, onSuccess: () => void) {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      socket.off('table_joined', onJoined)
      socket.off('spectator_joined', onSpectated)
      socket.off('socket_error', onError)
    }
    const onJoined = ({ tableId: tid }: { tableId: string; seatNumber: number }) => {
      if (tid !== table.id) return
      settle(); setEntering(null); onSuccess()
    }
    const onSpectated = ({ tableId: tid }: { tableId: string }) => {
      if (tid !== table.id) return
      settle(); setEntering(null); onSuccess()
    }
    const onError = ({ message }: { message: string }) => {
      settle(); setEntering(null); setShowJoinScreen(false); setError(message)
    }
    socket.on('table_joined', onJoined)
    socket.on('spectator_joined', onSpectated)
    socket.on('socket_error', onError)
  }

  function handleEnter() {
    setError(null); setEntering('enter'); setShowJoinScreen(true)
    const minWait = new Promise<void>(r => setTimeout(r, 2000))

    getSocket().then((socket) => {
      const joined = new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void) => {
          if (settled) return; settled = true
          socket.off('table_joined', onJoined)
          socket.off('socket_error', onError)
          fn()
        }
        const onJoined = ({ tableId: tid }: { tableId: string }) => {
          if (tid !== table.id) return
          settle(resolve)
        }
        const onError = ({ message }: { message: string }) => {
          settle(() => reject(new Error(message)))
        }
        socket.on('table_joined', onJoined)
        socket.on('socket_error', onError)
      })

      socket.emit('join_table', { tableId: table.id })

      Promise.all([minWait, joined])
        .then(() => { router.push(`/table/${table.id}`) })
        .catch((err: Error) => { setShowJoinScreen(false); setEntering(null); setError(err.message) })
    })
  }

  // Sit & Go auto-start: the server only emits this to registered players'
  // sockets, the instant the table fills up and everyone is auto-seated —
  // no "Enter Table" click required. Reuses the same join+navigate flow as
  // the manual button so a missed event (e.g. this card unmounted mid-fill)
  // still leaves "Enter Table"/"Rejoin" as a working fallback.
  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket) => {
      if (!active) return
      const onTableReady = ({ tableId: tid }: { tableId: string }) => {
        if (tid !== table.id || entering !== null) return
        handleEnter()
      }
      socket.on('sit_go_table_ready', onTableReady)
      cleanup = () => socket.off('sit_go_table_ready', onTableReady)
    })

    return () => { active = false; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.id])

  function handleWatch() {
    setError(null); setEntering('watch')
    getSocket().then((socket) => {
      withListeners(socket, () => router.push(`/table/${table.id}`))
      socket.emit('spectate_table', { tableId: table.id })
    })
  }

  type ButtonState = { label: string; disabled: boolean; onClick: (() => void) | null }

  // Registration is only open while sit_go_status is 'registering' — the moment the
  // table fills up, register_sit_go() flips it to 'ready' in the same transaction,
  // so this also correctly excludes a full table (matches the "can unregister
  // unless the table is full" requirement without a separate capacity check).
  const canUnregister = isRegistered && table.sit_go_status === 'registering'

  function getButtonState(): ButtonState {
    if (table.sit_go_status === 'finished') {
      return { label: 'Finished', disabled: true, onClick: null }
    }

    if (table.sit_go_status === 'registering') {
      if (isRegistered) return { label: 'Registered', disabled: true, onClick: null }
      if (!canRegister) return { label: 'Admin accounts can watch only', disabled: true, onClick: null }
      if (isFull) return { label: 'Full', disabled: true, onClick: null }
      if (notEnoughChips) return { label: 'Not enough chips', disabled: true, onClick: null }
      return { label: isPending ? 'Registering…' : 'Register', disabled: busy, onClick: handleRegister }
    }

    // sit_go_status is 'ready' or 'running'
    if (isRegistered) {
      const label = table.sit_go_status === 'running' ? 'Rejoin' : 'Enter Table'
      return { label: entering === 'enter' ? 'Entering…' : label, disabled: busy, onClick: handleEnter }
    }
    return { label: entering === 'watch' ? '…' : 'Watch', disabled: busy, onClick: handleWatch }
  }

  const button = getButtonState()

  return (
    <>
    {showJoinScreen && (
      <div className="fixed inset-0 z-[9999]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/join-loading.png"
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-black/50" />
      </div>
    )}
    <div className="w-full min-w-0 rounded-2xl border border-zinc-800/80 bg-gradient-to-b from-zinc-900 to-zinc-950 p-3.5 shadow-lg shadow-black/20 ring-1 ring-amber-500/[0.06]">
      <div className="mb-2.5 flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold text-zinc-100">{table.name}</h3>
        <span className="shrink-0 rounded-full bg-amber-900/30 px-2.5 py-0.5 text-[10px] font-semibold text-amber-400 ring-1 ring-amber-700/40">
          {statusLabel[table.sit_go_status]}
        </span>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-1.5 text-sm sm:grid-cols-4">
        <div className="rounded-lg bg-black/30 px-2.5 py-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Buy-in</p>
          <p className="mt-0.5 truncate font-bold tabular-nums text-zinc-200">{table.buy_in.toLocaleString('en-US')}</p>
        </div>
        <div className="rounded-lg bg-black/30 px-2.5 py-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Registered</p>
          <p className="mt-0.5 truncate font-bold tabular-nums text-zinc-200">
            {Math.min(Math.max(
              table.registeredCount
                + (justRegistered && !table.isRegistered ? 1 : 0)
                - (justUnregistered && table.isRegistered ? 1 : 0),
              0,
            ), table.max_players)}/{table.max_players}
          </p>
        </div>
        <div className="rounded-lg bg-black/30 px-2.5 py-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Blinds · L{table.blind_level}</p>
          <p className="mt-0.5 truncate font-bold tabular-nums text-zinc-200">
            {table.small_blind.toLocaleString('en-US')}/{table.big_blind.toLocaleString('en-US')}
          </p>
        </div>
        <div className="rounded-lg bg-black/30 px-2.5 py-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Stack</p>
          <p className="mt-0.5 truncate font-bold tabular-nums text-zinc-200">{table.starting_stack.toLocaleString('en-US')}</p>
        </div>
        <div className="col-span-2 rounded-lg bg-amber-900/10 px-2.5 py-2 ring-1 ring-amber-800/30 sm:col-span-4">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-amber-600">Prize Pool</p>
          <p className="mt-0.5 font-bold tabular-nums text-amber-400">{table.prize_pool.toLocaleString('en-US')}</p>
        </div>
      </div>

      {table.players.length > 0 && (
        <div className="mb-3 rounded-lg bg-black/20 px-2.5 py-2">
          <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Players</p>
          <ul className="flex flex-col gap-1">
            {table.players.map((p) => (
              <li key={p.playerId} className="flex items-center gap-1.5 text-xs">
                {p.rank === 1 && <span title="Winner">🏆</span>}
                <span className="min-w-0 flex-1 truncate font-semibold text-zinc-300">{p.username}</span>
                {p.rank != null && (
                  <span className="shrink-0 text-[10px] font-bold text-zinc-500">
                    {p.rank === 1 ? 'Winner' : `#${p.rank}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="mb-2.5 rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-400 ring-1 ring-red-800/50">
          {error}
        </p>
      )}

      {canUnregister ? (
        <div className="flex gap-2">
          <button
            disabled
            className="flex-1 cursor-not-allowed rounded-xl border border-zinc-700 bg-zinc-800/60 py-2.5 text-sm font-bold text-zinc-500"
          >
            {button.label}
          </button>
          <button
            onClick={handleUnregister}
            disabled={busy}
            className="shrink-0 rounded-xl border border-red-800/50 px-4 py-2.5 text-sm font-semibold text-red-400 transition-colors hover:border-red-700 hover:bg-red-950/30 active:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUnregistering ? 'Unregistering…' : 'Unregister'}
          </button>
        </div>
      ) : (
        <button
          onClick={button.onClick ?? undefined}
          disabled={button.disabled || button.onClick === null}
          className={[
            'w-full rounded-xl py-2.5 text-sm font-bold transition-colors',
            button.disabled || button.onClick === null
              ? 'cursor-not-allowed border border-zinc-700 bg-zinc-800/60 text-zinc-500'
              : 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700',
          ].join(' ')}
        >
          {button.label}
        </button>
      )}
    </div>
    </>
  )
}
