'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  TableStatePayload,
  Card,
  BettingAction,
  ShowdownPayload,
  PublicHandState,
} from '@/lib/socket/types'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  initialState: TableStatePayload
  currentUserId: string
  myStatus: 'seated' | 'spectating'
  mySeatNumber: number | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual constants
// ─────────────────────────────────────────────────────────────────────────────

const SUIT_SYM: Record<string, string> = {
  clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠',
}
const RED_SUITS = new Set(['diamonds', 'hearts'])

const AVATAR_COLORS = [
  '#2563eb', '#7c3aed', '#059669', '#d97706',
  '#db2777', '#0891b2', '#dc2626', '#4f46e5', '#0d9488',
]

function avatarBg(username: string): string {
  const n = username.split('').reduce((s, c) => s + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

function initials(username: string): string {
  return (username?.[0] ?? '?').toUpperCase()
}

// ─────────────────────────────────────────────────────────────────────────────
// Seat position math
// Seat 1 = bottom-centre (angle 180°); seats go clockwise.
// We rotate so the current player's actual seat becomes visual seat 1.
// ─────────────────────────────────────────────────────────────────────────────

function toVisual(actual: number, anchor: number, max: number): number {
  return ((actual - anchor + max) % max) + 1
}

function seatPos(vs: number, max: number): React.CSSProperties {
  const rad = ((180 - (vs - 1) * (360 / max)) * Math.PI) / 180
  return {
    position: 'absolute',
    left: `${(50 + 43 * Math.sin(rad)).toFixed(2)}%`,
    top:  `${(50 - 38 * Math.cos(rad)).toFixed(2)}%`,
    transform: 'translate(-50%,-50%)',
  }
}

function chipPos(vs: number, max: number): React.CSSProperties {
  const rad = ((180 - (vs - 1) * (360 / max)) * Math.PI) / 180
  return {
    position: 'absolute',
    left: `${(50 + 26 * Math.sin(rad)).toFixed(2)}%`,
    top:  `${(50 - 23 * Math.cos(rad)).toFixed(2)}%`,
    transform: 'translate(-50%,-50%)',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI atoms
// ─────────────────────────────────────────────────────────────────────────────

/** Face-up playing card */
function Card({ c, size }: { c: Card; size: 'xs' | 'sm' | 'lg' }) {
  const red = RED_SUITS.has(c.suit)
  const color = red
    ? 'border-red-300 bg-white text-red-600'
    : 'border-zinc-400 bg-white text-zinc-900'

  if (size === 'xs')
    return (
      <span className={`inline-flex h-8 w-[21px] items-center justify-center rounded text-[10px] font-bold border ${color}`}>
        {c.rank}{SUIT_SYM[c.suit]}
      </span>
    )
  if (size === 'sm')
    return (
      <span className={`inline-flex h-10 w-[26px] items-center justify-center rounded border text-xs font-bold ${color}`}>
        {c.rank}{SUIT_SYM[c.suit]}
      </span>
    )
  // lg — two-line layout for my bottom-bar cards
  return (
    <span className={`inline-flex h-[68px] w-11 flex-col items-center justify-center gap-0 rounded-xl border-2 text-xl font-bold leading-none ${color}`}>
      <span>{c.rank}</span>
      <span>{SUIT_SYM[c.suit]}</span>
    </span>
  )
}

/** Face-down card back */
function Back({ size }: { size: 'xs' | 'sm' }) {
  const cls =
    size === 'xs'
      ? 'inline-flex h-8 w-[21px] items-center justify-center rounded border border-blue-600 bg-[#0f2040] text-[8px] text-blue-500'
      : 'inline-flex h-10 w-[26px] items-center justify-center rounded border border-blue-600 bg-[#0f2040] text-[10px] text-blue-500'
  return <span className={cls}>♠♥</span>
}

/** Circular countdown ring drawn as SVG around the avatar */
function TimerRing({ t }: { t: number }) {
  const r = 19
  const circ = 2 * Math.PI * r
  const dash = Math.max(0, (t / 30) * circ)
  const low = t <= 10
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      className="absolute inset-0 h-full w-full"
      style={{ transform: 'rotate(-90deg)' }}
    >
      <circle cx="20" cy="20" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" />
      <circle
        cx="20" cy="20" r={r}
        stroke={low ? '#ef4444' : '#eab308'}
        strokeWidth="2.5"
        strokeDasharray={`${dash.toFixed(2)} ${circ.toFixed(2)}`}
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Stacked chip pile for bets-on-table */
function Chips({ amount }: { amount: number }) {
  const colors = ['#b45309', '#d97706', '#f59e0b']
  return (
    <div className="flex flex-col items-center gap-[2px]">
      <div className="relative h-5 w-5">
        {colors.map((bg, i) => (
          <span
            key={i}
            className="absolute left-0 rounded-full border border-amber-700 shadow-sm"
            style={{
              width: 18 - i, height: 18 - i,
              top: -i * 3, left: i,
              background: bg,
            }}
          />
        ))}
      </div>
      <span className="rounded bg-black/75 px-1 text-[9px] font-semibold tabular-nums text-amber-300">
        {amount.toLocaleString()}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function TableRoom({ initialState, currentUserId, myStatus, mySeatNumber }: Props) {
  const router = useRouter()

  const [state, setState]               = useState<TableStatePayload>(initialState)
  const [leaving, setLeaving]           = useState(false)
  const [connected, setConnected]       = useState(false)
  const [myHoleCards, setMyHoleCards]   = useState<[Card, Card] | null>(null)
  const [raiseAmount, setRaiseAmount]   = useState(0)
  const [showdownResult, setShowdownResult] = useState<ShowdownPayload | null>(null)
  const [turnTimerInfo, setTurnTimerInfo]   = useState<{ playerId: string; endsAt: number } | null>(null)
  const [timeLeft, setTimeLeft]         = useState(0)
  const [nextHandIn, setNextHandIn]     = useState<number | null>(null)

  const nextHandTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Derived values ──────────────────────────────────────────────────────────
  const hand: PublicHandState | null = state.handState
  const max   = state.maxPlayers
  const anchor = mySeatNumber ?? 1

  const isMyTurn   = hand?.currentTurnPlayerId === currentUserId
  const myHP       = hand?.players.find(p => p.playerId === currentUserId)
  const callAmt    = isMyTurn ? Math.max(0, (hand?.currentBet ?? 0) - (myHP?.roundContribution ?? 0)) : 0
  const canCheck   = isMyTurn && callAmt === 0
  const minRaiseTo = (hand?.currentBet ?? 0) + (hand?.minRaise ?? 0)
  const myMaxBet   = (myHP?.stack ?? 0) + (myHP?.roundContribution ?? 0)
  const seatedCnt  = state.seats.filter(s => s.playerId !== null).length
  const canStart   = myStatus === 'seated' && !hand && seatedCnt >= 2 && nextHandIn === null

  // Reset raise input when actor changes
  const prevActorRef = useRef<string | null>(null)
  useEffect(() => {
    if (hand?.currentTurnPlayerId !== prevActorRef.current) {
      prevActorRef.current = hand?.currentTurnPlayerId ?? null
      if (hand) setRaiseAmount(minRaiseTo)
    }
  })

  // Turn-timer countdown
  useEffect(() => {
    if (!turnTimerInfo) { setTimeLeft(0); return }
    const tick = () => setTimeLeft(Math.max(0, Math.ceil((turnTimerInfo.endsAt - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [turnTimerInfo])

  // ── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket: AppSocket) => {
      if (!active) return
      setConnected(socket.connected)

      const onConnect = () => {
        if (!active) return
        setConnected(true)
        socket.emit(myStatus === 'seated' ? 'join_table' : 'spectate_table', { tableId: initialState.tableId })
      }
      const onDisconnect = () => { if (active) setConnected(false) }

      // IMPORTANT: myHoleCards is NEVER touched here.
      const onTableState = (p: TableStatePayload) => {
        if (!active || p.tableId !== initialState.tableId) return
        setState(p)
        if (!p.handState) setTurnTimerInfo(null)
      }

      // deal_cards is the ONLY place myHoleCards is set
      const onDealCards = (p: { tableId: string; holeCards: [Card, Card] }) => {
        if (!active || p.tableId !== initialState.tableId) return
        setMyHoleCards(p.holeCards)
        setShowdownResult(null)
        setTurnTimerInfo(null)
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
        setNextHandIn(null)
      }

      const onShowdownResult = (p: ShowdownPayload) => {
        if (!active || p.tableId !== initialState.tableId) return
        setShowdownResult(p)
        setTurnTimerInfo(null)
      }

      const onActionResult = () => setTurnTimerInfo(null)

      const onTurnTimerStart = (p: { tableId: string; playerId: string; seconds: number }) => {
        if (!active || p.tableId !== initialState.tableId) return
        setTurnTimerInfo({ playerId: p.playerId, endsAt: Date.now() + p.seconds * 1000 })
      }

      const onNextHandCountdown = (p: { tableId: string; seconds: number }) => {
        if (!active || p.tableId !== initialState.tableId) return
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
        setNextHandIn(p.seconds)
        const id = setInterval(() => {
          setNextHandIn(prev => {
            if (prev === null || prev <= 1) { clearInterval(id); nextHandTimerRef.current = null; return null }
            return prev - 1
          })
        }, 1000)
        nextHandTimerRef.current = id
      }

      socket.on('connect', onConnect)
      socket.on('disconnect', onDisconnect)
      socket.on('table_state', onTableState)
      socket.on('deal_cards', onDealCards)
      socket.on('showdown_result', onShowdownResult)
      socket.on('action_result', onActionResult)
      socket.on('turn_timer_start', onTurnTimerStart)
      socket.on('next_hand_countdown', onNextHandCountdown)

      if (socket.connected) {
        socket.emit(myStatus === 'seated' ? 'join_table' : 'spectate_table', { tableId: initialState.tableId })
      }

      cleanup = () => {
        socket.off('connect', onConnect); socket.off('disconnect', onDisconnect)
        socket.off('table_state', onTableState); socket.off('deal_cards', onDealCards)
        socket.off('showdown_result', onShowdownResult); socket.off('action_result', onActionResult)
        socket.off('turn_timer_start', onTurnTimerStart); socket.off('next_hand_countdown', onNextHandCountdown)
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
      }
    })

    return () => { active = false; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialState.tableId, myStatus])

  // ── Handlers ────────────────────────────────────────────────────────────────

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

  function handleStartHand() {
    getSocket().then(s => s.emit('start_hand', { tableId: initialState.tableId }))
  }

  function sendAction(action: BettingAction, amount?: number) {
    getSocket().then(s =>
      s.emit('player_action', {
        tableId: initialState.tableId,
        action,
        ...(amount != null ? { amount } : {}),
      }),
    )
  }

  // Quick-bet: set raise input to a pot-relative amount
  function quickBet(fraction: number) {
    if (!hand || !myHP) return
    const potAfterCall = hand.pot + callAmt
    const total = hand.currentBet + Math.round(potAfterCall * fraction)
    setRaiseAmount(Math.min(Math.max(total, minRaiseTo), myMaxBet))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  const PHASE_LABEL: Record<string, string> = {
    PRE_FLOP: 'Pre-Flop', FLOP: 'Flop', TURN: 'Turn', RIVER: 'River',
  }
  const PHASE_COLOR: Record<string, string> = {
    PRE_FLOP: '#7c3aed', FLOP: '#1d4ed8', TURN: '#0891b2', RIVER: '#c2410c',
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: '#070b14' }}>

      {/* ═══════════════════════════════════════════════════════ TOP BAR ══ */}
      <header
        className="flex h-10 flex-none items-center justify-between gap-3 px-4"
        style={{ background: '#0b1120', borderBottom: '1px solid #1a2540' }}
      >
        {/* Left */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-bold text-white">{state.tableName}</span>
          {hand && (
            <span
              className="shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
              style={{ background: PHASE_COLOR[hand.phase] ?? '#374151' }}
            >
              {PHASE_LABEL[hand.phase] ?? hand.phase}
            </span>
          )}
          {nextHandIn != null && !hand && (
            <span className="shrink-0 rounded bg-amber-900/60 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
              Next hand in {nextHandIn}…
            </span>
          )}
        </div>

        {/* Right */}
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-xs text-slate-500 sm:inline">
            {state.smallBlind}/{state.bigBlind}
          </span>
          {myStatus === 'seated' && mySeatNumber != null && (
            <span className="hidden text-xs text-slate-500 sm:inline">
              Seat <span className="text-slate-300">{mySeatNumber}</span>
            </span>
          )}
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'animate-pulse bg-red-500'}`}
            title={connected ? 'Live' : 'Reconnecting…'}
          />
        </div>
      </header>

      {/* ════════════════════════════════════════ CONTENT (table + panel) ══ */}
      <div className="flex min-h-0 flex-1">

        {/* ──────────────────────────────────────── TABLE + ACTION PANEL ─ */}
        <div className="flex min-h-0 flex-1 flex-col">

          {/* ═══════════════════════════════════════════════ TABLE AREA ══ */}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 sm:p-3">
            <div className="w-full max-w-[920px]">
              {/* Aspect-ratio container; seats are absolutely positioned inside */}
              <div className="relative" style={{ paddingBottom: '54%' }}>

                {/* ── Ambient outer glow ────────────────────────────────── */}
                <div
                  className="pointer-events-none absolute rounded-[50%] opacity-25"
                  style={{
                    top: '-3%', left: '-3%', right: '-3%', bottom: '-3%',
                    background: 'radial-gradient(ellipse, rgba(20,120,60,0.9) 0%, transparent 70%)',
                    filter: 'blur(18px)',
                  }}
                />

                {/* ── Gold rim ──────────────────────────────────────────── */}
                <div
                  className="absolute rounded-[50%]"
                  style={{
                    top: '7%', left: '2.5%', right: '2.5%', bottom: '7%',
                    background: 'linear-gradient(145deg,#92701a 0%,#e0b840 30%,#b8892a 55%,#e0b840 80%,#7a5e14 100%)',
                    boxShadow: '0 6px 40px rgba(0,0,0,0.9)',
                  }}
                />

                {/* ── Green felt surface ────────────────────────────────── */}
                <div
                  className="absolute rounded-[50%]"
                  style={{
                    top: '10%', left: '4%', right: '4%', bottom: '10%',
                    background: 'radial-gradient(ellipse at 50% 38%, #1a7040 0%, #0d4a22 52%, #06280e 100%)',
                    boxShadow: 'inset 0 0 70px rgba(0,0,0,0.55), inset 0 0 20px rgba(0,0,0,0.3)',
                  }}
                />

                {/* ── Center: pot + community cards ────────────────────── */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-2">

                    {hand && (
                      <>
                        {/* Pot */}
                        <div className="flex items-center gap-1.5">
                          {/* Stacked chip icon */}
                          <div className="flex flex-col items-center">
                            {[0, 1, 2].map(i => (
                              <span
                                key={i}
                                className="block rounded-full border border-amber-600"
                                style={{
                                  width: 10, height: 10,
                                  marginTop: i === 0 ? 0 : -6,
                                  background: i === 0 ? '#92400e' : i === 1 ? '#d97706' : '#f59e0b',
                                }}
                              />
                            ))}
                          </div>
                          <span
                            className="rounded-full px-3 py-0.5 text-sm font-bold tabular-nums text-amber-200"
                            style={{ background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(251,191,36,0.25)' }}
                          >
                            {hand.pot.toLocaleString()}
                          </span>
                        </div>

                        {/* Community cards */}
                        <div className="flex gap-1">
                          {hand.communityCards.map((c, i) => <Card key={i} c={c} size="sm" />)}
                          {Array.from({ length: 5 - hand.communityCards.length }).map((_, i) => (
                            <span
                              key={i}
                              className="inline-flex h-10 w-[26px] items-center justify-center rounded border border-white/10"
                              style={{ background: 'rgba(0,0,0,0.25)' }}
                            />
                          ))}
                        </div>

                        {hand.currentBet > 0 && (
                          <div className="text-[10px] text-white/40">
                            Bet <span className="text-white/70">{hand.currentBet}</span>
                          </div>
                        )}
                      </>
                    )}

                    {/* Between hands: board from last showdown */}
                    {!hand && showdownResult && showdownResult.communityCards.length > 0 && (
                      <div className="flex gap-1 opacity-60">
                        {showdownResult.communityCards.map((c, i) => <Card key={i} c={c} size="sm" />)}
                      </div>
                    )}

                    {!hand && !showdownResult && (
                      <p className="text-xs text-white/25">
                        {nextHandIn != null ? `Next hand in ${nextHandIn}…` : 'Waiting…'}
                      </p>
                    )}
                  </div>
                </div>

                {/* ── Seats + chip bets ─────────────────────────────────── */}
                {state.seats.map(seat => {
                  const vs      = toVisual(seat.seatNumber, anchor, max)
                  const isMe    = seat.playerId === currentUserId
                  const occ     = seat.playerId !== null
                  const hp      = hand?.players.find(p => p.seatNumber === seat.seatNumber)
                  const sdP     = showdownResult?.players.find(p => p.seatNumber === seat.seatNumber)
                  const isTurn  = occ && hand?.currentTurnPlayerId === seat.playerId
                  const isD     = occ && hand?.dealerSeatNumber === seat.seatNumber
                  const isSB    = occ && hand?.smallBlindSeatNumber === seat.seatNumber
                  const isBB    = occ && hand?.bigBlindSeatNumber === seat.seatNumber
                  const folded  = hp?.playerPhase === 'folded'
                  const allIn   = hp?.playerPhase === 'all-in'
                  const showTmr = isTurn && turnTimerInfo?.playerId === seat.playerId && timeLeft > 0

                  return (
                    <div key={seat.seatNumber}>
                      {/* Bet chip stack between seat and center */}
                      {occ && hp && hp.roundContribution > 0 && (
                        <div style={chipPos(vs, max)} className="pointer-events-none z-10">
                          <Chips amount={hp.roundContribution} />
                        </div>
                      )}

                      {/* Seat card */}
                      <div style={seatPos(vs, max)}>
                        {!occ ? (
                          /* Empty seat */
                          <div
                            className="flex h-12 w-[74px] items-center justify-center rounded-xl text-[9px] text-white/20"
                            style={{ border: '1px dashed rgba(255,255,255,0.1)' }}
                          >
                            #{seat.seatNumber}
                          </div>
                        ) : (
                          /* Occupied seat */
                          <div
                            className={`flex w-[90px] flex-col items-center gap-1 rounded-2xl px-1.5 py-1.5 transition-all duration-200 ${folded ? 'opacity-35' : ''}`}
                            style={{
                              background: isTurn
                                ? 'rgba(30,20,0,0.92)'
                                : isMe
                                ? 'rgba(8,20,50,0.92)'
                                : 'rgba(8,14,28,0.88)',
                              border: isTurn
                                ? '1.5px solid rgba(234,179,8,0.9)'
                                : isMe
                                ? '1.5px solid rgba(59,130,246,0.7)'
                                : '1px solid rgba(255,255,255,0.1)',
                              boxShadow: isTurn
                                ? '0 0 18px rgba(234,179,8,0.35), 0 0 6px rgba(234,179,8,0.2)'
                                : isMe
                                ? '0 0 10px rgba(59,130,246,0.2)'
                                : 'none',
                            }}
                          >
                            {/* Avatar with optional timer ring */}
                            <div className="relative h-9 w-9">
                              {showTmr && <TimerRing t={timeLeft} />}
                              <div
                                className="absolute inset-[3px] flex items-center justify-center rounded-full text-sm font-bold text-white"
                                style={{ background: avatarBg(seat.username ?? '?') }}
                              >
                                {initials(seat.username ?? '?')}
                              </div>
                            </div>

                            {/* Position badges */}
                            <div className="flex flex-wrap justify-center gap-[3px]">
                              {isD && (
                                <span className="rounded-full bg-white/90 px-[5px] text-[8px] font-black text-zinc-900">D</span>
                              )}
                              {isSB && (
                                <span className="rounded-full bg-blue-600 px-[4px] text-[8px] font-bold text-white">SB</span>
                              )}
                              {isBB && (
                                <span className="rounded-full bg-violet-600 px-[4px] text-[8px] font-bold text-white">BB</span>
                              )}
                              {allIn && (
                                <span className="rounded-full bg-red-700 px-[4px] text-[8px] font-bold text-white">ALL IN</span>
                              )}
                              {folded && (
                                <span className="rounded-full bg-zinc-700 px-[4px] text-[8px] font-semibold text-zinc-400">FOLD</span>
                              )}
                            </div>

                            {/* Username */}
                            <div className="w-full truncate text-center text-[10px] font-semibold leading-tight text-white">
                              {seat.username}
                            </div>
                            {isMe && (
                              <div className="text-[8px] leading-none text-blue-400">(you)</div>
                            )}

                            {/* Stack */}
                            <div className="text-[11px] font-bold tabular-nums text-amber-300">
                              {hp
                                ? hp.stack.toLocaleString()
                                : sdP
                                ? sdP.finalStack.toLocaleString()
                                : seat.username !== null ? '—' : ''}
                            </div>

                            {/* Cards at seat */}
                            {hand && !folded && hp && (
                              <div className="flex gap-[3px]">
                                {isMe && myHoleCards ? (
                                  <>
                                    <Card c={myHoleCards[0]} size="xs" />
                                    <Card c={myHoleCards[1]} size="xs" />
                                  </>
                                ) : (
                                  <>
                                    <Back size="xs" />
                                    <Back size="xs" />
                                  </>
                                )}
                              </div>
                            )}

                            {/* Showdown: revealed opponent cards */}
                            {sdP?.holeCards && (
                              <div className="flex gap-[3px]">
                                <Card c={sdP.holeCards[0]} size="xs" />
                                <Card c={sdP.holeCards[1]} size="xs" />
                              </div>
                            )}

                            {/* Timer seconds label */}
                            {showTmr && (
                              <div className={`text-[10px] font-mono font-bold ${timeLeft <= 10 ? 'text-red-400' : 'text-yellow-300'}`}>
                                {timeLeft}s
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* ══════════════════════════════════════════ BOTTOM PANEL ══════ */}
          <div
            className="flex-none"
            style={{ background: '#0a0f1e', borderTop: '1px solid #1a2540' }}
          >
            <div className="flex items-stretch">

              {/* ── Left: cards + action ────────────────────────────────── */}
              <div className="min-w-0 flex-1 space-y-2 p-3">

                {/* My hole cards (lg, always visible when set) */}
                {myStatus === 'seated' && myHoleCards && (
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Your hand
                    </span>
                    <div className="flex gap-2">
                      <Card c={myHoleCards[0]} size="lg" />
                      <Card c={myHoleCards[1]} size="lg" />
                    </div>
                    {/* Net change badge during showdown */}
                    {showdownResult && (() => {
                      const me = showdownResult.players.find(p => p.playerId === currentUserId)
                      if (!me) return null
                      return (
                        <span className={`ml-1 text-base font-bold tabular-nums ${me.netChipChange > 0 ? 'text-emerald-400' : me.netChipChange < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                          {me.netChipChange > 0 ? '+' : ''}{me.netChipChange.toLocaleString()}
                        </span>
                      )
                    })()}
                  </div>
                )}

                {/* Showdown result summary */}
                {!hand && showdownResult && (
                  <div
                    className="rounded-lg p-2.5 space-y-1.5"
                    style={{ background: '#071a10', border: '1px solid #14532d' }}
                  >
                    <p className="text-xs font-bold text-emerald-400">
                      {showdownResult.reason === 'all_folded' ? 'All players folded' : 'Showdown'}
                    </p>
                    {showdownResult.pots.map((pot, i) => {
                      const names = showdownResult.players
                        .filter(p => pot.winners.includes(p.playerId))
                        .map(p => p.username)
                      return (
                        <div key={i} className="text-sm text-white/80">
                          <span className="font-semibold text-emerald-300">{names.join(' & ')}</span>
                          {' wins '}
                          <span className="font-bold tabular-nums text-amber-300">{pot.amount.toLocaleString()}</span>
                          {pot.winnerHandName !== 'Last Standing' && (
                            <span className="ml-1 text-[11px] text-white/40">({pot.winnerHandName})</span>
                          )}
                        </div>
                      )
                    })}
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 border-t border-emerald-900/40">
                      {showdownResult.players.map(p => (
                        <span key={p.playerId} className="text-[11px] tabular-nums text-slate-400">
                          {p.username}:{' '}
                          <span className={`font-semibold ${p.netChipChange > 0 ? 'text-emerald-400' : p.netChipChange < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                            {p.netChipChange > 0 ? '+' : ''}{p.netChipChange.toLocaleString()}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action panel — only when it's my turn */}
                {myStatus === 'seated' && isMyTurn && myHP?.playerPhase === 'active' && (
                  <div className="space-y-2">
                    {/* Timer bar + label */}
                    {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 flex-1 overflow-hidden rounded-full"
                          style={{ background: '#1e293b' }}
                        >
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${Math.min(100, (timeLeft / 30) * 100)}%`,
                              background: timeLeft <= 10 ? '#ef4444' : '#eab308',
                            }}
                          />
                        </div>
                        <span className={`w-8 text-right font-mono text-xs font-bold tabular-nums ${timeLeft <= 10 ? 'text-red-400' : 'text-yellow-400'}`}>
                          {timeLeft}s
                        </span>
                      </div>
                    )}

                    {/* Quick-bet row */}
                    <div className="flex flex-wrap gap-1.5">
                      {[{ l: '¼ Pot', f: 0.25 }, { l: '½ Pot', f: 0.5 }, { l: '¾ Pot', f: 0.75 }, { l: 'Pot', f: 1.0 }].map(q => (
                        <button
                          key={q.l}
                          onClick={() => quickBet(q.f)}
                          className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 transition-colors"
                          style={{ background: '#161e30', border: '1px solid #2a3a58' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#1e2e48')}
                          onMouseLeave={e => (e.currentTarget.style.background = '#161e30')}
                        >
                          {q.l}
                        </button>
                      ))}
                    </div>

                    {/* Main action row */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Fold */}
                      <button
                        onClick={() => sendAction('FOLD')}
                        className="rounded-lg px-5 py-2.5 text-sm font-bold text-white transition-colors"
                        style={{ background: '#7f1d1d', border: '1px solid #991b1b' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#991b1b')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#7f1d1d')}
                      >
                        Fold
                      </button>

                      {/* Check / Call */}
                      {canCheck ? (
                        <button
                          onClick={() => sendAction('CHECK')}
                          className="rounded-lg px-5 py-2.5 text-sm font-bold text-emerald-300 transition-colors"
                          style={{ background: '#052e16', border: '1px solid #166534' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#064e23')}
                          onMouseLeave={e => (e.currentTarget.style.background = '#052e16')}
                        >
                          Check
                        </button>
                      ) : (
                        <button
                          onClick={() => sendAction('CALL')}
                          className="rounded-lg px-5 py-2.5 text-sm font-bold text-emerald-300 transition-colors"
                          style={{ background: '#052e16', border: '1px solid #166534' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#064e23')}
                          onMouseLeave={e => (e.currentTarget.style.background = '#052e16')}
                        >
                          Call {callAmt.toLocaleString()}
                        </button>
                      )}

                      {/* Raise input + button */}
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={raiseAmount}
                          min={minRaiseTo}
                          max={myMaxBet}
                          onChange={e => setRaiseAmount(Number(e.target.value))}
                          className="w-20 rounded-lg px-2 py-2.5 text-sm tabular-nums text-slate-100 focus:outline-none"
                          style={{ background: '#0e1828', border: '1px solid #2a3a58' }}
                          onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                          onBlur={e => (e.currentTarget.style.borderColor = '#2a3a58')}
                        />
                        <button
                          onClick={() => sendAction('RAISE', raiseAmount)}
                          disabled={raiseAmount < minRaiseTo || raiseAmount > myMaxBet}
                          className="rounded-lg px-3 py-2.5 text-sm font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ background: '#1d4ed8', border: '1px solid #2563eb' }}
                          onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#2563eb' }}
                          onMouseLeave={e => (e.currentTarget.style.background = '#1d4ed8')}
                        >
                          Raise
                        </button>
                      </div>

                      {/* All-in */}
                      <button
                        onClick={() => sendAction('ALL_IN')}
                        className="rounded-lg px-3 py-2.5 text-sm font-bold text-white transition-colors"
                        style={{ background: '#5b21b6', border: '1px solid #6d28d9' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#6d28d9')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#5b21b6')}
                      >
                        All-In ({(myHP?.stack ?? 0).toLocaleString()})
                      </button>
                    </div>
                  </div>
                )}

                {/* Manual start hand */}
                {canStart && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleStartHand}
                      className="rounded-lg px-8 py-2.5 text-sm font-bold text-white transition-colors"
                      style={{ background: '#065f46', border: '1px solid #047857' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#047857')}
                      onMouseLeave={e => (e.currentTarget.style.background = '#065f46')}
                    >
                      Start Hand
                    </button>
                  </div>
                )}

                {/* Waiting message */}
                {!hand && !canStart && !showdownResult && !isMyTurn && (
                  <p className="py-1 text-xs text-slate-600">
                    {seatedCnt < 2
                      ? 'Waiting for more players…'
                      : nextHandIn != null
                      ? `Next hand starting in ${nextHandIn}…`
                      : 'Waiting for hand to start…'}
                  </p>
                )}

                {/* Spectators */}
                {state.spectators.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <span className="text-[10px] text-slate-600">Watching:</span>
                    {state.spectators.map(s => (
                      <span key={s.playerId} className="text-[10px] text-slate-500">
                        {s.username}{s.playerId === currentUserId ? ' (you)' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Right controls ───────────────────────────────────────── */}
              <div
                className="flex w-16 flex-none flex-col items-center justify-start gap-2 p-2 pt-3 sm:w-20"
                style={{ borderLeft: '1px solid #1a2540' }}
              >
                {/* Exit to lobby */}
                <button
                  onClick={handleLeave}
                  disabled={leaving}
                  className="w-full rounded-lg py-2 text-center text-[10px] font-semibold text-red-400 transition-colors disabled:opacity-40"
                  style={{ background: '#1a0a0a', border: '1px solid #3f1010' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#2a1010')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#1a0a0a')}
                >
                  {leaving ? '…' : '↩ Exit'}
                </button>

                {/* Leave seat */}
                <button
                  onClick={handleLeave}
                  disabled={leaving || myStatus !== 'seated'}
                  className="w-full rounded-lg py-2 text-center text-[10px] font-semibold text-slate-400 transition-colors disabled:opacity-30"
                  style={{ background: '#0e1828', border: '1px solid #1a2540' }}
                  onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#162038' }}
                  onMouseLeave={e => (e.currentTarget.style.background = '#0e1828')}
                >
                  Stand Up
                </button>

                {/* Placeholders */}
                <button
                  disabled
                  className="w-full cursor-not-allowed rounded-lg py-2 text-center text-[10px] font-semibold text-slate-600 opacity-30"
                  style={{ background: '#0e1828', border: '1px solid #1a2540' }}
                  title="Coming soon"
                >
                  ≡ More
                </button>

                <button
                  disabled
                  className="w-full cursor-not-allowed rounded-lg py-2 text-center text-[10px] font-semibold text-slate-600 opacity-30"
                  style={{ background: '#0e1828', border: '1px solid #1a2540' }}
                  title="Coming soon"
                >
                  + Chips
                </button>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
