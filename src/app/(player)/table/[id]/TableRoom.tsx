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

type Props = {
  initialState: TableStatePayload
  currentUserId: string
  myStatus: 'seated' | 'spectating'
  mySeatNumber: number | null
}

// ── Card helpers ─────────────────────────────────────────────────────────────

const SUIT_SYMBOL: Record<string, string> = {
  clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠',
}
const RED_SUITS = new Set(['diamonds', 'hearts'])

function CardFace({ card, size = 'md' }: { card: Card; size?: 'sm' | 'md' | 'lg' }) {
  const red = RED_SUITS.has(card.suit)
  const cls =
    size === 'sm'
      ? 'inline-flex h-9 w-6 items-center justify-center rounded text-xs font-bold border'
      : size === 'lg'
      ? 'inline-flex h-16 w-11 flex-col items-center justify-center rounded-lg border-2 text-lg font-bold leading-none gap-0'
      : 'inline-flex h-12 w-8 items-center justify-center rounded border text-sm font-bold'
  return (
    <span
      className={[
        cls,
        red
          ? 'border-red-300 bg-white text-red-600'
          : 'border-zinc-400 bg-white text-zinc-900',
      ].join(' ')}
    >
      {size === 'lg' ? (
        <>
          <span>{card.rank}</span>
          <span>{SUIT_SYMBOL[card.suit]}</span>
        </>
      ) : (
        `${card.rank}${SUIT_SYMBOL[card.suit]}`
      )}
    </span>
  )
}

function CardBack({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const cls =
    size === 'sm'
      ? 'inline-flex h-9 w-6 items-center justify-center rounded text-[9px] border'
      : size === 'lg'
      ? 'inline-flex h-16 w-11 items-center justify-center rounded-lg border-2 text-sm'
      : 'inline-flex h-12 w-8 items-center justify-center rounded border text-xs'
  return (
    <span className={[cls, 'border-blue-500 bg-blue-900 text-blue-400'].join(' ')}>??</span>
  )
}

// ── Seat layout math ──────────────────────────────────────────────────────────
// Seat 1 renders at the bottom-center (angle 180°); seats increase clockwise.
// We rotate the view so the current player's seat always occupies slot 1.

function toVisualSeat(actualSeat: number, anchor: number, maxPlayers: number): number {
  return ((actualSeat - anchor + maxPlayers) % maxPlayers) + 1
}

function getSeatStyle(visualSeat: number, maxPlayers: number): React.CSSProperties {
  const angleDeg = 180 - (visualSeat - 1) * (360 / maxPlayers)
  const angleRad = (angleDeg * Math.PI) / 180
  return {
    position: 'absolute',
    left: `${(50 + 43 * Math.sin(angleRad)).toFixed(1)}%`,
    top: `${(50 - 38 * Math.cos(angleRad)).toFixed(1)}%`,
    transform: 'translate(-50%, -50%)',
  }
}

function getChipStyle(visualSeat: number, maxPlayers: number): React.CSSProperties {
  const angleDeg = 180 - (visualSeat - 1) * (360 / maxPlayers)
  const angleRad = (angleDeg * Math.PI) / 180
  // Placed halfway between seat edge and table center
  return {
    position: 'absolute',
    left: `${(50 + 24 * Math.sin(angleRad)).toFixed(1)}%`,
    top: `${(50 - 21 * Math.cos(angleRad)).toFixed(1)}%`,
    transform: 'translate(-50%, -50%)',
  }
}

// ── Phase badge colours ───────────────────────────────────────────────────────

const PHASE_COLOUR: Record<string, string> = {
  PRE_FLOP: 'bg-violet-900/70 text-violet-300',
  FLOP: 'bg-blue-900/70 text-blue-300',
  TURN: 'bg-cyan-900/70 text-cyan-300',
  RIVER: 'bg-orange-900/70 text-orange-300',
}

// ── Component ─────────────────────────────────────────────────────────────────

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
  const [myHoleCards, setMyHoleCards] = useState<[Card, Card] | null>(null)
  const [raiseAmount, setRaiseAmount] = useState(0)
  const [showdownResult, setShowdownResult] = useState<ShowdownPayload | null>(null)
  const [turnTimerInfo, setTurnTimerInfo] = useState<{ playerId: string; endsAt: number } | null>(
    null,
  )
  const [timeLeft, setTimeLeft] = useState(0)
  const [nextHandIn, setNextHandIn] = useState<number | null>(null)

  // Refs for cleanup
  const nextHandTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const hand: PublicHandState | null = state.handState
  const maxPlayers = state.maxPlayers
  // Perspective anchor: my actual seat number (or 1 for spectators / no seat)
  const anchor = mySeatNumber ?? 1

  const isMyTurn = hand?.currentTurnPlayerId === currentUserId
  const myHandPlayer = hand?.players.find(p => p.playerId === currentUserId)
  const callAmount = isMyTurn
    ? Math.max(0, (hand?.currentBet ?? 0) - (myHandPlayer?.roundContribution ?? 0))
    : 0
  const canCheck = isMyTurn && callAmount === 0
  const minRaiseTarget = (hand?.currentBet ?? 0) + (hand?.minRaise ?? 0)
  const seatedCount = state.seats.filter(s => s.playerId !== null).length
  const canStartHand =
    myStatus === 'seated' && !hand && seatedCount >= 2 && nextHandIn === null

  // Reset raise input when the actor changes.
  const prevActorRef = useRef<string | null>(null)
  useEffect(() => {
    if (hand?.currentTurnPlayerId !== prevActorRef.current) {
      prevActorRef.current = hand?.currentTurnPlayerId ?? null
      if (hand) setRaiseAmount(minRaiseTarget)
    }
  })

  // Countdown tick for the turn timer.
  useEffect(() => {
    if (!turnTimerInfo) { setTimeLeft(0); return }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((turnTimerInfo.endsAt - Date.now()) / 1000))
      setTimeLeft(remaining)
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [turnTimerInfo])

  // Socket setup.
  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket: AppSocket) => {
      if (!active) return
      setConnected(socket.connected)

      // ── Connect / reconnect ─────────────────────────────────────────────
      const onConnect = () => {
        if (!active) return
        setConnected(true)
        socket.emit(myStatus === 'seated' ? 'join_table' : 'spectate_table', {
          tableId: initialState.tableId,
        })
      }

      const onDisconnect = () => {
        if (active) setConnected(false)
      }

      // ── Table state ─────────────────────────────────────────────────────
      // IMPORTANT: myHoleCards is NEVER touched here.
      // Hole cards are managed exclusively by deal_cards and showdown_result events.
      const onTableState = (payload: TableStatePayload) => {
        if (!active || payload.tableId !== initialState.tableId) return
        setState(payload)
        // Safeguard: when no active hand, no turn timer should be shown
        if (!payload.handState) {
          setTurnTimerInfo(null)
        }
      }

      // ── Private hole cards ──────────────────────────────────────────────
      // This is the ONLY place myHoleCards is set.
      // Receiving deal_cards signals a new hand has started — clear previous round state.
      const onDealCards = (payload: { tableId: string; holeCards: [Card, Card] }) => {
        if (!active || payload.tableId !== initialState.tableId) return
        setMyHoleCards(payload.holeCards)
        setShowdownResult(null)   // dismiss old showdown; new hand is starting
        setTurnTimerInfo(null)    // reset timer for new hand
        // Clear the next-hand countdown
        if (nextHandTimerRef.current) {
          clearInterval(nextHandTimerRef.current)
          nextHandTimerRef.current = null
        }
        setNextHandIn(null)
      }

      // ── Showdown result ─────────────────────────────────────────────────
      const onShowdownResult = (payload: ShowdownPayload) => {
        if (!active || payload.tableId !== initialState.tableId) return
        setShowdownResult(payload)
        setTurnTimerInfo(null)
        // myHoleCards intentionally NOT cleared — keep visible through showdown
      }

      // ── Action result (next player's timer will follow via turn_timer_start) ──
      const onActionResult = () => {
        setTurnTimerInfo(null)
      }

      // ── Turn timer ──────────────────────────────────────────────────────
      const onTurnTimerStart = (payload: {
        tableId: string
        playerId: string
        seconds: number
      }) => {
        if (!active || payload.tableId !== initialState.tableId) return
        setTurnTimerInfo({
          playerId: payload.playerId,
          endsAt: Date.now() + payload.seconds * 1000,
        })
      }

      // ── Auto-start countdown ────────────────────────────────────────────
      const onNextHandCountdown = (payload: { tableId: string; seconds: number }) => {
        if (!active || payload.tableId !== initialState.tableId) return
        if (nextHandTimerRef.current) {
          clearInterval(nextHandTimerRef.current)
          nextHandTimerRef.current = null
        }
        setNextHandIn(payload.seconds)
        const id = setInterval(() => {
          setNextHandIn(prev => {
            if (prev === null || prev <= 1) {
              clearInterval(id)
              nextHandTimerRef.current = null
              return null
            }
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

      // If socket is already connected when this effect runs, join the table room now.
      // The socket may have been created from the lobby — 'connect' won't re-fire.
      if (socket.connected) {
        socket.emit(myStatus === 'seated' ? 'join_table' : 'spectate_table', {
          tableId: initialState.tableId,
        })
      }

      cleanup = () => {
        socket.off('connect', onConnect)
        socket.off('disconnect', onDisconnect)
        socket.off('table_state', onTableState)
        socket.off('deal_cards', onDealCards)
        socket.off('showdown_result', onShowdownResult)
        socket.off('action_result', onActionResult)
        socket.off('turn_timer_start', onTurnTimerStart)
        socket.off('next_hand_countdown', onNextHandCountdown)
        if (nextHandTimerRef.current) {
          clearInterval(nextHandTimerRef.current)
          nextHandTimerRef.current = null
        }
      }
    })

    return () => {
      active = false
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialState.tableId, myStatus])

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
    getSocket().then((s) => s.emit('start_hand', { tableId: initialState.tableId }))
  }

  function sendAction(action: BettingAction, amount?: number) {
    getSocket().then((s) =>
      s.emit('player_action', {
        tableId: initialState.tableId,
        action,
        ...(amount != null ? { amount } : {}),
      }),
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">

      {/* ── Top bar ── */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/90 px-4 py-2.5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate font-semibold">{state.tableName}</h1>
          <span className={[
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
            state.status === 'active'
              ? 'bg-green-900/60 text-green-400'
              : state.status === 'waiting'
              ? 'bg-amber-900/60 text-amber-400'
              : 'bg-zinc-700 text-zinc-400',
          ].join(' ')}>
            {state.status}
          </span>
          {hand && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PHASE_COLOUR[hand.phase] ?? ''}`}>
              {hand.phase.replace('_', ' ')}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-xs text-zinc-500 sm:inline">
            Blinds <span className="text-zinc-300">{state.smallBlind}/{state.bigBlind}</span>
          </span>
          {myStatus === 'seated' && mySeatNumber != null && (
            <span className="hidden text-xs text-zinc-500 sm:inline">
              Seat <span className="text-zinc-300">{mySeatNumber}</span>
            </span>
          )}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
            <span className="hidden sm:inline">{connected ? 'Live' : 'Reconnecting…'}</span>
          </div>
          <button
            onClick={handleLeave}
            disabled={leaving}
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 disabled:opacity-50"
          >
            {leaving ? 'Leaving…' : 'Leave'}
          </button>
        </div>
      </header>

      {/* ── Oval poker table ── */}
      <div className="flex flex-1 items-center justify-center overflow-hidden p-2 sm:p-4">
        <div className="w-full max-w-4xl">
          {/* Outer container — seats + chips are positioned relative to this */}
          <div className="relative" style={{ paddingBottom: '58%' }}>

            {/* Green felt oval */}
            <div
              className="absolute rounded-[50%]"
              style={{
                top: '8%', left: '4%', right: '4%', bottom: '8%',
                background: 'radial-gradient(ellipse at 50% 40%, #1e6b2a 0%, #0f3d15 100%)',
                border: '10px solid #0a2410',
                boxShadow:
                  '0 0 0 3px #1a4a0f, 0 8px 60px rgba(0,0,0,0.9), inset 0 0 50px rgba(0,0,0,0.4)',
              }}
            />

            {/* Center: pot + community cards */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                {hand && (
                  <>
                    {/* Pot with chip icon */}
                    <div className="flex items-center gap-2">
                      <div className="flex items-center">
                        <span className="inline-block h-4 w-4 rounded-full border-2 border-amber-600 bg-amber-500 shadow-md" />
                        <span className="-ml-2 inline-block h-4 w-4 rounded-full border-2 border-amber-600 bg-amber-400 shadow-md" />
                      </div>
                      <div className="rounded-full border border-amber-700/50 bg-black/60 px-3 py-0.5 text-sm font-semibold text-amber-300">
                        {hand.pot.toLocaleString()}
                      </div>
                    </div>

                    {/* Community cards */}
                    <div className="flex gap-1">
                      {hand.communityCards.map((c, i) => (
                        <CardFace key={i} card={c} size="sm" />
                      ))}
                      {Array.from({ length: 5 - hand.communityCards.length }).map((_, i) => (
                        <span
                          key={i}
                          className="inline-flex h-9 w-6 items-center justify-center rounded border border-zinc-700/30 bg-black/20"
                        />
                      ))}
                    </div>

                    {hand.currentBet > 0 && (
                      <div className="text-[10px] text-zinc-400">
                        Bet: <span className="text-zinc-200">{hand.currentBet}</span>
                      </div>
                    )}
                  </>
                )}

                {/* Between hands: previous community cards during showdown */}
                {!hand && showdownResult && showdownResult.communityCards.length > 0 && (
                  <div className="flex gap-1">
                    {showdownResult.communityCards.map((c, i) => (
                      <CardFace key={i} card={c} size="sm" />
                    ))}
                  </div>
                )}

                {!hand && !showdownResult && (
                  <div className="text-sm text-zinc-600">
                    {nextHandIn != null
                      ? `Next hand in ${nextHandIn}…`
                      : 'Waiting for next hand'}
                  </div>
                )}
              </div>
            </div>

            {/* Seats + bet chip stacks */}
            {state.seats.map((seat) => {
              const vs = toVisualSeat(seat.seatNumber, anchor, maxPlayers)
              const isMe = seat.playerId === currentUserId
              const occupied = seat.playerId !== null
              const hp = hand?.players.find(p => p.seatNumber === seat.seatNumber)
              const isCurrentTurn =
                !!hand?.currentTurnPlayerId && hand.currentTurnPlayerId === seat.playerId
              const isDealer = hand?.dealerSeatNumber === seat.seatNumber && occupied
              const isSB = hand?.smallBlindSeatNumber === seat.seatNumber && occupied
              const isBB = hand?.bigBlindSeatNumber === seat.seatNumber && occupied
              const isFolded = hp?.playerPhase === 'folded'
              const isAllIn = hp?.playerPhase === 'all-in'
              const sdPlayer = showdownResult?.players.find(p => p.seatNumber === seat.seatNumber)
              const showTimer =
                isCurrentTurn &&
                turnTimerInfo?.playerId === seat.playerId &&
                timeLeft > 0

              return (
                <div key={seat.seatNumber}>
                  {/* Chip stack between seat and table center */}
                  {occupied && hp && hp.roundContribution > 0 && (
                    <div style={getChipStyle(vs, maxPlayers)} className="pointer-events-none z-10">
                      <div className="flex flex-col items-center gap-0.5">
                        <div className="flex -space-x-1">
                          <span className="inline-block h-3.5 w-3.5 rounded-full border border-amber-600 bg-amber-500 shadow" />
                          <span className="inline-block h-3.5 w-3.5 rounded-full border border-amber-600 bg-amber-400 shadow" />
                        </div>
                        <span className="rounded bg-black/60 px-1 text-[9px] font-semibold tabular-nums text-amber-300">
                          {hp.roundContribution}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Seat card */}
                  <div style={getSeatStyle(vs, maxPlayers)}>
                    {!occupied ? (
                      <div className="flex h-14 w-20 items-center justify-center rounded-lg border-2 border-dashed border-zinc-800/60 bg-black/10">
                        <span className="text-[10px] text-zinc-700">#{seat.seatNumber}</span>
                      </div>
                    ) : (
                      <div
                        className={[
                          'w-24 select-none rounded-xl border px-1.5 py-1.5 text-center text-[11px] transition-all duration-200',
                          isCurrentTurn
                            ? 'border-yellow-500/70 bg-yellow-950/90 shadow-[0_0_20px_rgba(234,179,8,0.35)]'
                            : isMe
                            ? 'border-blue-500/50 bg-blue-950/80'
                            : 'border-zinc-700/50 bg-zinc-900/90',
                          isFolded ? 'opacity-40' : '',
                        ].join(' ')}
                      >
                        {/* Position badges */}
                        <div className="flex flex-wrap justify-center gap-0.5 min-h-[14px]">
                          {isDealer && (
                            <span className="rounded-full bg-zinc-600 px-1.5 text-[9px] font-bold text-white">
                              D
                            </span>
                          )}
                          {isSB && (
                            <span className="rounded-full bg-blue-700 px-1 text-[9px] font-bold text-blue-100">
                              SB
                            </span>
                          )}
                          {isBB && (
                            <span className="rounded-full bg-violet-700 px-1 text-[9px] font-bold text-violet-100">
                              BB
                            </span>
                          )}
                          {isAllIn && (
                            <span className="rounded-full bg-red-700 px-1 text-[9px] font-bold text-red-100">
                              ALL IN
                            </span>
                          )}
                          {isFolded && (
                            <span className="rounded-full bg-zinc-700 px-1 text-[9px] font-bold text-zinc-400">
                              FOLD
                            </span>
                          )}
                        </div>

                        {/* Username */}
                        <div className="mt-0.5 truncate font-semibold leading-tight text-zinc-100">
                          {seat.username}
                        </div>
                        {isMe && (
                          <div className="text-[9px] leading-tight text-blue-400">(you)</div>
                        )}

                        {/* Stack */}
                        <div className="mt-0.5 font-semibold tabular-nums text-amber-300">
                          {hp
                            ? hp.stack.toLocaleString()
                            : sdPlayer
                            ? sdPlayer.finalStack.toLocaleString()
                            : '—'}
                        </div>

                        {/* Showdown: other players' hole cards revealed */}
                        {sdPlayer?.holeCards && (
                          <div className="mt-1 flex justify-center gap-0.5">
                            <CardFace size="sm" card={sdPlayer.holeCards[0]} />
                            <CardFace size="sm" card={sdPlayer.holeCards[1]} />
                          </div>
                        )}

                        {/* Face-down cards for other players during a hand */}
                        {hand && !isFolded && hp && !isMe && !sdPlayer?.holeCards && (
                          <div className="mt-1 flex justify-center gap-0.5">
                            <CardBack size="sm" />
                            <CardBack size="sm" />
                          </div>
                        )}

                        {/* Turn timer (in seat card) */}
                        {showTimer && (
                          <>
                            <div
                              className={[
                                'mt-1 font-mono text-[11px] font-bold tabular-nums',
                                timeLeft <= 10 ? 'text-red-400' : 'text-yellow-300',
                              ].join(' ')}
                            >
                              {timeLeft}s
                            </div>
                            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-zinc-700">
                              <div
                                className={`h-full rounded-full transition-all ${timeLeft <= 10 ? 'bg-red-500' : 'bg-yellow-400'}`}
                                style={{ width: `${Math.min(100, (timeLeft / 30) * 100)}%` }}
                              />
                            </div>
                          </>
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

      {/* ── Bottom panel ── */}
      <div className="border-t border-zinc-800 bg-zinc-900/80 backdrop-blur">

        {/* My hole cards — visible when set (active hand or showdown) */}
        {myStatus === 'seated' && myHoleCards && (
          <div className="border-b border-zinc-800/60 px-4 py-3">
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-zinc-500">Your hand</span>
              <div className="flex gap-2">
                <CardFace card={myHoleCards[0]} size="lg" />
                <CardFace card={myHoleCards[1]} size="lg" />
              </div>
              {/* Net chip change during showdown */}
              {showdownResult &&
                (() => {
                  const me = showdownResult.players.find(p => p.playerId === currentUserId)
                  if (!me) return null
                  return (
                    <span
                      className={[
                        'ml-2 text-sm font-bold tabular-nums',
                        me.netChipChange > 0
                          ? 'text-green-400'
                          : me.netChipChange < 0
                          ? 'text-red-400'
                          : 'text-zinc-500',
                      ].join(' ')}
                    >
                      {me.netChipChange > 0 ? '+' : ''}
                      {me.netChipChange.toLocaleString()}
                    </span>
                  )
                })()}
            </div>
          </div>
        )}

        <div className="space-y-3 p-4">

          {/* Showdown results */}
          {!hand && showdownResult && (
            <div className="rounded-lg border border-green-800/50 bg-green-950/30 p-3 space-y-2">
              <div className="text-sm font-semibold text-green-400">
                {showdownResult.reason === 'all_folded' ? 'All players folded' : 'Showdown'}
              </div>
              {showdownResult.pots.map((pot, i) => {
                const winnerNames = showdownResult.players
                  .filter(p => pot.winners.includes(p.playerId))
                  .map(p => p.username)
                return (
                  <div key={i} className="text-sm text-zinc-200">
                    <span className="font-semibold text-green-300">{winnerNames.join(' & ')}</span>
                    {' wins '}
                    <span className="font-semibold tabular-nums text-amber-300">
                      {pot.amount.toLocaleString()}
                    </span>
                    {pot.winnerHandName !== 'Last Standing' && (
                      <span className="ml-1 text-xs text-zinc-400">({pot.winnerHandName})</span>
                    )}
                  </div>
                )
              })}

              {/* Next hand countdown */}
              {nextHandIn != null && nextHandIn > 0 && (
                <div className="pt-1 text-xs text-zinc-500">
                  Next hand in{' '}
                  <span className="font-semibold text-zinc-300">{nextHandIn}</span>…
                </div>
              )}

              {/* Per-player chip changes */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-green-900/40 pt-2">
                {showdownResult.players.map(p => (
                  <span key={p.playerId} className="tabular-nums text-xs text-zinc-400">
                    {p.username}:{' '}
                    <span
                      className={[
                        'font-medium',
                        p.netChipChange > 0
                          ? 'text-green-400'
                          : p.netChipChange < 0
                          ? 'text-red-400'
                          : 'text-zinc-500',
                      ].join(' ')}
                    >
                      {p.netChipChange > 0 ? '+' : ''}
                      {p.netChipChange.toLocaleString()}
                    </span>{' '}
                    <span className="text-zinc-600">({p.finalStack.toLocaleString()})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Action panel — my turn */}
          {myStatus === 'seated' && isMyTurn && myHandPlayer?.playerPhase === 'active' && (
            <div className="rounded-lg border border-yellow-700/50 bg-yellow-950/30 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-yellow-300">Your turn</p>
                {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-700">
                      <div
                        className={`h-full rounded-full transition-all ${
                          timeLeft <= 10 ? 'bg-red-500' : 'bg-yellow-400'
                        }`}
                        style={{ width: `${Math.min(100, (timeLeft / 30) * 100)}%` }}
                      />
                    </div>
                    <span
                      className={[
                        'w-8 text-right font-mono text-sm font-bold tabular-nums',
                        timeLeft <= 10 ? 'text-red-400' : 'text-yellow-400',
                      ].join(' ')}
                    >
                      {timeLeft}s
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => sendAction('FOLD')}
                  className="rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2.5 text-sm font-semibold text-zinc-200 transition-colors hover:bg-zinc-700 active:bg-zinc-600"
                >
                  Fold
                </button>

                {canCheck ? (
                  <button
                    onClick={() => sendAction('CHECK')}
                    className="rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white active:bg-zinc-200"
                  >
                    Check
                  </button>
                ) : (
                  <button
                    onClick={() => sendAction('CALL')}
                    className="rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white active:bg-zinc-200"
                  >
                    Call {callAmount.toLocaleString()}
                  </button>
                )}

                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={minRaiseTarget}
                    max={(myHandPlayer?.stack ?? 0) + (myHandPlayer?.roundContribution ?? 0)}
                    value={raiseAmount}
                    onChange={e => setRaiseAmount(Number(e.target.value))}
                    className="w-24 rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-2.5 text-sm tabular-nums text-zinc-100 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    onClick={() => sendAction('RAISE', raiseAmount)}
                    disabled={raiseAmount < minRaiseTarget}
                    className="rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Raise
                  </button>
                </div>

                <button
                  onClick={() => sendAction('ALL_IN')}
                  className="rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-600 active:bg-red-800"
                >
                  All In ({(myHandPlayer?.stack ?? 0).toLocaleString()})
                </button>
              </div>
            </div>
          )}

          {/* Manual Start Hand (fallback when auto-start is not running) */}
          {canStartHand && (
            <div className="flex justify-center">
              <button
                onClick={handleStartHand}
                className="rounded-lg bg-green-700 px-8 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-600 active:bg-green-800"
              >
                Start Hand
              </button>
            </div>
          )}

          {/* Waiting / countdown status message */}
          {!hand && !canStartHand && !showdownResult && (
            <div className="py-2 text-center text-sm text-zinc-600">
              {seatedCount < 2
                ? 'Waiting for more players to join…'
                : nextHandIn != null && nextHandIn > 0
                ? `Next hand starting in ${nextHandIn}…`
                : 'Waiting for a player to start the hand…'}
            </div>
          )}

          {/* Spectators */}
          {state.spectators.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="text-xs text-zinc-600">Watching:</span>
              {state.spectators.map(s => (
                <span key={s.playerId} className="text-xs text-zinc-500">
                  {s.username}
                  {s.playerId === currentUserId ? ' (you)' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
