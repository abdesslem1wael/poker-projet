'use client'

import { useEffect, useState, useTransition } from 'react'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'
import { getSeatedPlayersAction } from '@/app/actions/tables'

type SessionState = {
  tableId: string
  tableName: string
  secondsRemaining: number
  isExpired: boolean
  syncedAt: number
}

type SeatedPlayer = { playerId: string; username: string }

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s.toString().padStart(2, '0')}s`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function SessionCard({
  session,
  socket,
}: {
  session: SessionState
  socket: AppSocket | null
}) {
  const [elapsed, setElapsed] = useState(0)
  const [players, setPlayers] = useState<SeatedPlayer[] | null>(null)
  const [showKick, setShowKick] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - session.syncedAt) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [session.syncedAt])

  const secondsLeft = Math.max(0, session.secondsRemaining - elapsed)
  const isExpired = session.isExpired || secondsLeft === 0
  const isLow = !isExpired && secondsLeft < 300  // < 5 min

  function extend(minutes: number) {
    socket?.emit('extend_session', { tableId: session.tableId, additionalMinutes: minutes })
  }

  function kick(playerId: string) {
    socket?.emit('kick_player', { tableId: session.tableId, playerId })
    setPlayers(prev => prev ? prev.filter(p => p.playerId !== playerId) : prev)
  }

  function loadPlayers() {
    if (players !== null) { setShowKick(v => !v); return }
    startTransition(async () => {
      const list = await getSeatedPlayersAction(session.tableId)
      setPlayers(list)
      setShowKick(true)
    })
  }

  return (
    <div style={{
      background: '#0b111e',
      border: isExpired ? '1px solid #3f1010' : isLow ? '1px solid rgba(239,68,68,0.3)' : '1px solid #1e3a28',
      borderRadius: 12, padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: isExpired ? '#ef4444' : isLow ? '#f59e0b' : '#22c55e',
          boxShadow: isExpired ? 'none' : `0 0 6px ${isLow ? '#f59e0b' : '#22c55e'}`,
        }} />
        <span style={{ fontWeight: 700, color: '#f1f5f9', fontSize: 14, flex: 1 }}>{session.tableName}</span>
        {isExpired ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.12)', color: '#fca5a5', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Expired
          </span>
        ) : (
          <span style={{
            fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
            color: isLow ? '#f87171' : '#6ee7b7',
          }}>
            {formatTime(secondsLeft)}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={() => extend(30)}
          style={{ flex: 1, minWidth: 90, padding: '7px 6px', borderRadius: 7, border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.07)', color: '#6ee7b7', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.07)')}
        >
          +30 min
        </button>
        <button
          onClick={() => extend(60)}
          style={{ flex: 1, minWidth: 90, padding: '7px 6px', borderRadius: 7, border: '1px solid rgba(16,185,129,0.4)', background: 'rgba(16,185,129,0.1)', color: '#34d399', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.2)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.1)')}
        >
          +1 hour
        </button>
        <button
          onClick={loadPlayers}
          disabled={isPending}
          style={{ flex: 1, minWidth: 90, padding: '7px 6px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.25)', background: showKick ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.06)', color: '#fca5a5', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: isPending ? 0.6 : 1 }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = showKick ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.06)')}
        >
          {isPending ? 'Loading…' : 'Kick Player'}
        </button>
      </div>

      {showKick && players !== null && (
        <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
          {players.length === 0 ? (
            <p style={{ color: '#4b5563', fontSize: 12 }}>No seated players.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {players.map(p => (
                <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: '#94a3b8', fontSize: 13 }}>{p.username}</span>
                  <button
                    onClick={() => kick(p.playerId)}
                    style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SessionPanel() {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map())
  const [socket, setSocket] = useState<AppSocket | null>(null)

  useEffect(() => {
    let active = true

    getSocket().then(s => {
      if (!active) return
      setSocket(s)

      const onSessionUpdate = (p: { tableId: string; tableName: string; secondsRemaining: number; isExpired: boolean }) => {
        if (!active) return
        setSessions(prev => {
          const next = new Map(prev)
          next.set(p.tableId, { ...p, syncedAt: Date.now() })
          return next
        })
      }

      s.on('session_update', onSessionUpdate)
      return () => { s.off('session_update', onSessionUpdate) }
    })

    return () => { active = false }
  }, [])

  const list = Array.from(sessions.values())

  if (list.length === 0) return null

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-4">
        Live Sessions
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {list.map(s => (
          <SessionCard key={s.tableId} session={s} socket={socket} />
        ))}
      </div>
    </div>
  )
}
