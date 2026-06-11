'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  TableStatePayload,
  Card,
  BettingAction,
  ShowdownPayload,
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

function CardFace({ card, size = 'md' }: { card: Card; size?: 'sm' | 'md' }) {
  const red = RED_SUITS.has(card.suit)
  const cls = size === 'sm'
    ? 'inline-flex h-9 w-6 items-center justify-center rounded text-xs font-bold'
    : 'inline-flex h-12 w-8 items-center justify-center rounded border text-sm font-bold'
  return (
    <span className={[
      cls,
      red
        ? 'border-red-400 bg-white text-red-600'
        : 'border-zinc-400 bg-white text-zinc-900',
    ].join(' ')}>
      {card.rank}{SUIT_SYMBOL[card.suit]}
    </span>
  )
}

function CardBack({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const cls = size === 'sm'
    ? 'inline-flex h-9 w-6 items-center justify-center rounded text-[10px]'
    : 'inline-flex h-12 w-8 items-center justify-center rounded border text-xs'
  return (
    <span className={[
      cls,
      'border-blue-500 bg-blue-900 text-blue-400',
    ].join(' ')}>
      ??
    </span>
  )
}

// ── Seat position formula ─────────────────────────────────────────────────────
// Seats are distributed evenly around an oval, seat 1 at bottom-center,
// going clockwise. The oval has radii rx (% of container width) and ry
// (% of container height). Each seat card is centered on these coordinates.

function getSeatStyle(
  seatNumber: number,
  maxPlayers: number,
): React.CSSProperties {
  const angleDeg = 180 - (seatNumber - 1) * (360 / maxPlayers)
  const angleRad = (angleDeg * Math.PI) / 180
  const left = 50 + 43 * Math.sin(angleRad)
  const top = 50 - 38 * Math.cos(angleRad)
  return {
    position: 'absolute',
    left: `${left.toFixed(1)}%`,
    top: `${top.toFixed(1)}%`,
    transform: 'translate(-50%, -50%)',
  }
}

// ── Phase badge colours ───────────────────────────────────────────────────────

const PHASE_COLOUR: Record<string, string> = {
  PRE_FLOP: 'bg-violet-900/70 text-violet-300',
  FLOP:     'bg-blue-900/70 text-blue-300',
  TURN:     'bg-cyan-900/70 text-cyan-300',
  RIVER:    'bg-orange-900/70 text-orange-300',
}

// ── Main component ────────────────────────────────────────────────────────────

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
  const [turnTimerInfo, setTurnTimerInfo] = useState<{
    playerId: string
    endsAt: number
  } | null>(null)
  const [timeLeft, setTimeLeft] = useState(0)

  const hand = state.handState
  const isMyTurn = hand?.currentTurnPlayerId === currentUserId
  const myHandPlayer = hand?.players.find(p => p.playerId === currentUserId)
  const callAmount = isMyTurn
    ? Math.max(0, (hand?.currentBet ?? 0) - (myHandPlayer?.roundContribution ?? 0))
    : 0
  const canCheck = isMyTurn && callAmount === 0
  const minRaiseTarget = (hand?.currentBet ?? 0) + (hand?.minRaise ?? 0)
  const seatedCount = state.seats.filter(s => s.playerId !== null).length
  const canStartHand = myStatus === 'seated' && !hand && seatedCount >= 2

  // Reset raise input when the actor changes.
  const prevActorRef = useRef<string | null>(null)
  useEffect(() => {
    if (hand?.currentTurnPlayerId !== prevActorRef.current) {
      prevActorRef.current = hand?.currentTurnPlayerId ?? null
      if (hand) setRaiseAmount(minRaiseTarget)
    }
  })

  // Countdown tick.
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

      const onConnect = () => {
        if (!active) return
        setConnected(true)
        socket.emit(
          myStatus === 'seated' ? 'join_table' : 'spectate_table',
          { tableId: initialState.tableId },
        )
      }
      const onDisconnect = () => { if (active) setConnected(false) }

      const onTableState = (payload: TableStatePayload) => {
        if (!active || payload.tableId !== initialState.tableId) return
        setState(payload)
        if (payload.handState) {
          // New hand started — clear previous round artifacts.
          setShowdownResult(null)
          setMyHoleCards(null)
          setTurnTimerInfo(null)
        }
      }

      const onDealCards = (payload: { tableId: string; holeCards: [Card, Card] }) => {
        if (active && payload.tableId === initialState.tableId) {
          setMyHoleCards(payload.holeCards)
        }
      }

      const onShowdownResult = (payload: ShowdownPayload) => {
        if (!active || payload.tableId !== initialState.tableId) return
        setShowdownResult(payload)
        setTurnTimerInfo(null)
      }

      const onActionResult = () => {
        // Clear the displayed timer; a new turn_timer_start will follow for the next player.
        setTurnTimerInfo(null)
      }

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

      socket.on('connect', onConnect)
      socket.on('disconnect', onDisconnect)
      socket.on('table_state', onTableState)
      socket.on('deal_cards', onDealCards)
      socket.on('showdown_result', onShowdownResult)
      socket.on('action_result', onActionResult)
      socket.on('turn_timer_start', onTurnTimerStart)

      cleanup = () => {
        socket.off('connect', onConnect)
        socket.off('disconnect', onDisconnect)
        socket.off('table_state', onTableState)
        socket.off('deal_cards', onDealCards)
        socket.off('showdown_result', onShowdownResult)
        socket.off('action_result', onActionResult)
        socket.off('turn_timer_start', onTurnTimerStart)
      }
    })

    return () => { active = false; cleanup?.() }
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
        <div className="flex items-center gap-3 min-w-0">
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
      <div className="flex flex-1 items-center justify-center overflow-hidden p-4 pb-0">
        <div className="w-full max-w-4xl">
          {/* Outer container — seats are positioned relative to this */}
          <div className="relative" style={{ paddingBottom: '58%' }}>

            {/* Green felt oval */}
            <div
              className="absolute rounded-[50%] shadow-[0_0_80px_rgba(0,0,0,0.8),inset_0_0_60px_rgba(0,0,0,0.4)]"
              style={{
                top: '8%', left: '4%', right: '4%', bottom: '8%',
                background: 'radial-gradient(ellipse at center, #1e5c2a 0%, #143d1a 100%)',
                border: '10px solid #0a2410',
                boxShadow: '0 0 0 3px #1a4a0f, 0 0 80px rgba(0,0,0,0.8), inset 0 0 60px rgba(0,0,0,0.3)',
              }}
            />

            {/* Center content: pot + community cards */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                {hand && (
                  <>
                    <div className="rounded-full border border-amber-700/50 bg-black/50 px-4 py-1 text-sm font-semibold text-amber-300 backdrop-blur">
                      Pot: {hand.pot.toLocaleString()}
                    </div>
                    <div className="flex gap-1.5">
                      {hand.communityCards.map((c, i) => (
                        <CardFace key={i} card={c} />
                      ))}
                      {Array.from({ length: 5 - hand.communityCards.length }).map((_, i) => (
                        <span
                          key={i}
                          className="inline-flex h-12 w-8 items-center justify-center rounded border border-zinc-700/40 bg-black/20"
                        />
                      ))}
                    </div>
                    {hand.currentBet > 0 && (
                      <div className="text-xs text-zinc-400">
                        Bet: <span className="text-zinc-200">{hand.currentBet}</span>
                      </div>
                    )}
                  </>
                )}
                {!hand && showdownResult && (
                  <div className="text-center">
                    <div className="text-xs text-green-400 font-medium">Hand Complete</div>
                    {showdownResult.communityCards.length > 0 && (
                      <div className="mt-1 flex gap-1">
                        {showdownResult.communityCards.map((c, i) => (
                          <CardFace key={i} card={c} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!hand && !showdownResult && (
                  <div className="text-center">
                    <div className="text-sm text-zinc-600">Waiting for next hand</div>
                  </div>
                )}
              </div>
            </div>

            {/* Seats */}
            {state.seats.map((seat) => {
              const isMe = seat.playerId === currentUserId
              const occupied = seat.playerId !== null
              const hp = hand?.players.find(p => p.seatNumber === seat.seatNumber)
              const isCurrentTurn = hand?.currentTurnPlayerId === seat.playerId && occupied
              const isDealer = hand?.dealerSeatNumber === seat.seatNumber && occupied
              const isSB = hand?.smallBlindSeatNumber === seat.seatNumber && occupied
              const isBB = hand?.bigBlindSeatNumber === seat.seatNumber && occupied
              const isFolded = hp?.playerPhase === 'folded'
              const isAllIn = hp?.playerPhase === 'all-in'
              const sdPlayer = showdownResult?.players.find(p => p.seatNumber === seat.seatNumber)

              // Timer for this seat
              const showTimer =
                isCurrentTurn &&
                turnTimerInfo?.playerId === seat.playerId &&
                timeLeft > 0

              return (
                <div
                  key={seat.seatNumber}
                  style={getSeatStyle(seat.seatNumber, state.maxPlayers)}
                >
                  {!occupied ? (
                    // Empty seat
                    <div className="flex h-14 w-24 items-center justify-center rounded-lg border-2 border-dashed border-zinc-800/80 bg-black/20">
                      <span className="text-[10px] text-zinc-700">#{seat.seatNumber}</span>
                    </div>
                  ) : (
                    // Occupied seat
                    <div
                      className={[
                        'w-24 select-none rounded-lg px-1.5 py-1 text-center text-[11px] transition-all',
                        isCurrentTurn
                          ? 'bg-yellow-950/80 ring-2 ring-yellow-400 shadow-[0_0_14px_rgba(250,204,21,0.4)]'
                          : isMe
                          ? 'bg-blue-950/80 ring-1 ring-blue-500'
                          : 'bg-zinc-900/90 ring-1 ring-zinc-700/60',
                        isFolded ? 'opacity-40' : '',
                      ].join(' ')}
                    >
                      {/* Position badges */}
                      <div className="flex flex-wrap justify-center gap-0.5">
                        {isDealer && (
                          <span className="rounded-full bg-zinc-700 px-1 text-[9px] font-bold text-zinc-200">D</span>
                        )}
                        {isSB && (
                          <span className="rounded-full bg-blue-800 px-1 text-[9px] font-bold text-blue-200">SB</span>
                        )}
                        {isBB && (
                          <span className="rounded-full bg-violet-800 px-1 text-[9px] font-bold text-violet-200">BB</span>
                        )}
                        {isAllIn && (
                          <span className="rounded-full bg-red-800 px-1 text-[9px] font-bold text-red-200">ALL IN</span>
                        )}
                        {isFolded && (
                          <span className="rounded-full bg-zinc-700 px-1 text-[9px] font-bold text-zinc-400">FOLD</span>
                        )}
                      </div>

                      {/* Username */}
                      <div className="mt-0.5 truncate font-medium leading-tight">
                        {seat.username}
                      </div>
                      {isMe && (
                        <div className="text-[9px] text-blue-400 leading-tight">you</div>
                      )}

                      {/* Stack */}
                      {hp ? (
                        <div className="mt-0.5 font-semibold tabular-nums text-amber-300">
                          {hp.stack.toLocaleString()}
                        </div>
                      ) : sdPlayer ? (
                        <div className="mt-0.5 font-semibold tabular-nums text-amber-300">
                          {sdPlayer.finalStack.toLocaleString()}
                        </div>
                      ) : null}

                      {/* Current bet */}
                      {hp?.roundContribution != null && hp.roundContribution > 0 && (
                        <div className="text-[9px] tabular-nums text-zinc-400">
                          bet {hp.roundContribution}
                        </div>
                      )}

                      {/* Showdown hole cards revealed */}
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

                      {/* Turn timer */}
                      {showTimer && (
                        <div className={[
                          'mt-0.5 font-mono text-[10px] tabular-nums font-semibold',
                          timeLeft <= 10 ? 'text-red-400' : 'text-yellow-400',
                        ].join(' ')}>
                          {timeLeft}s
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Bottom panel ── */}
      <div className="border-t border-zinc-800 bg-zinc-900/80 p-4 space-y-3 backdrop-blur">

        {/* My hole cards */}
        {myStatus === 'seated' && myHoleCards && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">Your cards</span>
            <div className="flex gap-2">
              <CardFace card={myHoleCards[0]} />
              <CardFace card={myHoleCards[1]} />
            </div>
          </div>
        )}

        {/* Showdown results */}
        {!hand && showdownResult && (
          <div className="rounded-lg border border-green-800/50 bg-green-950/40 p-3 space-y-2">
            <div className="text-sm font-semibold text-green-400">
              {showdownResult.reason === 'all_folded' ? 'All folded' : 'Showdown'}
            </div>
            {showdownResult.pots.map((pot, i) => {
              const winnerNames = showdownResult.players
                .filter(p => pot.winners.includes(p.playerId))
                .map(p => p.username)
              return (
                <div key={i} className="text-sm text-zinc-200">
                  <span className="font-semibold text-green-300">{winnerNames.join(' & ')}</span>
                  {' wins '}
                  <span className="font-semibold tabular-nums text-amber-300">{pot.amount.toLocaleString()}</span>
                  {pot.winnerHandName !== 'Last Standing' && (
                    <span className="ml-1 text-xs text-zinc-400">({pot.winnerHandName})</span>
                  )}
                </div>
              )
            })}
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 border-t border-green-900/40">
              {showdownResult.players.map(p => (
                <span key={p.playerId} className="text-xs text-zinc-400 tabular-nums">
                  {p.username}:{' '}
                  <span className={[
                    'font-medium',
                    p.netChipChange > 0 ? 'text-green-400' :
                    p.netChipChange < 0 ? 'text-red-400' : 'text-zinc-500',
                  ].join(' ')}>
                    {p.netChipChange > 0 ? '+' : ''}{p.netChipChange.toLocaleString()}
                  </span>
                  {' '}
                  <span className="text-zinc-600">({p.finalStack.toLocaleString()})</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Action panel */}
        {myStatus === 'seated' && isMyTurn && myHandPlayer?.playerPhase === 'active' && (
          <div className="rounded-lg border border-yellow-700/60 bg-yellow-950/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-yellow-300">Your turn</p>
              {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                <span className={[
                  'font-mono text-sm font-semibold tabular-nums',
                  timeLeft <= 10 ? 'text-red-400' : 'text-yellow-400',
                ].join(' ')}>
                  {timeLeft}s
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => sendAction('FOLD')}
                className="rounded-md border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
              >
                Fold
              </button>

              {canCheck ? (
                <button
                  onClick={() => sendAction('CHECK')}
                  className="rounded-md bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
                >
                  Check
                </button>
              ) : (
                <button
                  onClick={() => sendAction('CALL')}
                  className="rounded-md bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
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
                  className="w-24 rounded-md border border-zinc-600 bg-zinc-800 px-2 py-2 text-sm tabular-nums text-zinc-100 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={() => sendAction('RAISE', raiseAmount)}
                  disabled={raiseAmount < minRaiseTarget}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Raise to {raiseAmount.toLocaleString()}
                </button>
              </div>

              <button
                onClick={() => sendAction('ALL_IN')}
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                All In ({(myHandPlayer?.stack ?? 0).toLocaleString()})
              </button>
            </div>
          </div>
        )}

        {/* Start hand button */}
        {canStartHand && (
          <div className="flex justify-center">
            <button
              onClick={handleStartHand}
              className="rounded-md bg-green-700 px-8 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-600"
            >
              Start Hand
            </button>
          </div>
        )}

        {/* Waiting notice */}
        {!hand && !canStartHand && !showdownResult && (
          <div className="py-2 text-center text-sm text-zinc-600">
            {seatedCount < 2
              ? 'Waiting for more players…'
              : 'Waiting for a player to start the hand…'}
          </div>
        )}

        {/* Spectators */}
        {state.spectators.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            <span className="text-xs text-zinc-600">Watching:</span>
            {state.spectators.map((s) => (
              <span key={s.playerId} className="text-xs text-zinc-500">
                {s.username}{s.playerId === currentUserId ? ' (you)' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
