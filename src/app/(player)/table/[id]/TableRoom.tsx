'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { TableStatePayload, Card, BettingAction } from '@/lib/socket/types'
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

function CardFace({ card }: { card: Card }) {
  const red = RED_SUITS.has(card.suit)
  return (
    <span
      className={[
        'inline-flex h-10 w-7 items-center justify-center rounded border text-sm font-bold',
        red
          ? 'border-red-300 bg-white text-red-600 dark:border-red-700 dark:bg-zinc-900 dark:text-red-400'
          : 'border-zinc-300 bg-white text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100',
      ].join(' ')}
    >
      {card.rank}{SUIT_SYMBOL[card.suit]}
    </span>
  )
}

function CardBack() {
  return (
    <span className="inline-flex h-10 w-7 items-center justify-center rounded border border-blue-300 bg-blue-100 text-xs text-blue-400 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-500">
      ??
    </span>
  )
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

  const hand = state.handState
  const isMyTurn = hand?.currentTurnPlayerId === currentUserId
  const myHandPlayer = hand?.players.find(p => p.playerId === currentUserId)
  const callAmount = isMyTurn
    ? Math.max(0, (hand?.currentBet ?? 0) - (myHandPlayer?.roundContribution ?? 0))
    : 0
  const canCheck = isMyTurn && callAmount === 0
  const minRaiseTarget = (hand?.currentBet ?? 0) + (hand?.minRaise ?? 0)
  const canStartHand =
    myStatus === 'seated' &&
    !hand &&
    state.seats.filter(s => s.playerId !== null).length >= 2

  // Reset raise input whenever the acting player changes.
  useEffect(() => {
    if (hand) setRaiseAmount(minRaiseTarget)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hand?.currentTurnPlayerId])

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
        // Re-join the room on reconnect so broadcasts reach this tab.
        socket.emit(
          myStatus === 'seated' ? 'join_table' : 'spectate_table',
          { tableId: initialState.tableId },
        )
      }
      const onDisconnect = () => { if (active) setConnected(false) }

      const onTableState = (payload: TableStatePayload) => {
        if (active && payload.tableId === initialState.tableId) setState(payload)
      }

      const onDealCards = (payload: { tableId: string; holeCards: [Card, Card] }) => {
        if (active && payload.tableId === initialState.tableId) {
          setMyHoleCards(payload.holeCards)
        }
      }

      socket.on('connect', onConnect)
      socket.on('disconnect', onDisconnect)
      socket.on('table_state', onTableState)
      socket.on('deal_cards', onDealCards)

      cleanup = () => {
        socket.off('connect', onConnect)
        socket.off('disconnect', onDisconnect)
        socket.off('table_state', onTableState)
        socket.off('deal_cards', onDealCards)
      }
    })

    return () => {
      active = false
      cleanup?.()
    }
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
    getSocket().then((socket) => {
      socket.emit('start_hand', { tableId: initialState.tableId })
    })
  }

  function sendAction(action: BettingAction, amount?: number) {
    getSocket().then((socket) => {
      socket.emit('player_action', {
        tableId: initialState.tableId,
        action,
        ...(amount != null ? { amount } : {}),
      })
    })
  }

  const tableStatusBadge = {
    waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    active:  'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    closed:  'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  }[state.status]

  const phaseBadge = {
    PRE_FLOP: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400',
    FLOP:     'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    TURN:     'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400',
    RIVER:    'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{state.tableName}</h1>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${tableStatusBadge}`}>
            {state.status}
          </span>
          {hand && (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${phaseBadge[hand.phase]}`}>
              {hand.phase.replace('_', ' ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
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

      {/* ── Table meta ── */}
      <div className="flex flex-wrap gap-6 text-sm text-zinc-500">
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
        {hand && (
          <>
            <span>
              Pot:{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                {hand.pot}
              </span>
            </span>
            {hand.currentBet > 0 && (
              <span>
                Bet:{' '}
                <span className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                  {hand.currentBet}
                </span>
              </span>
            )}
          </>
        )}
      </div>

      {/* ── Community cards ── */}
      {hand && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-500">Board</h2>
          <div className="flex gap-2">
            {hand.communityCards.length === 0 ? (
              <span className="text-xs text-zinc-400">No cards dealt yet</span>
            ) : (
              hand.communityCards.map((c, i) => <CardFace key={i} card={c} />)
            )}
          </div>
        </section>
      )}

      {/* ── My hole cards ── */}
      {myStatus === 'seated' && myHoleCards && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-500">Your Cards</h2>
          <div className="flex gap-2">
            <CardFace card={myHoleCards[0]} />
            <CardFace card={myHoleCards[1]} />
          </div>
        </section>
      )}

      {/* ── Seat grid ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-500">
          Seats ({state.seats.filter(s => s.playerId !== null).length}/{state.maxPlayers})
        </h2>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
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

            return (
              <div
                key={seat.seatNumber}
                className={[
                  'flex flex-col items-center rounded-lg border p-3 text-center relative',
                  isCurrentTurn
                    ? 'border-yellow-400 bg-yellow-50 ring-2 ring-yellow-300 dark:border-yellow-500 dark:bg-yellow-950/20 dark:ring-yellow-600'
                    : isMe
                    ? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/30'
                    : isFolded
                    ? 'border-zinc-200 bg-zinc-50 opacity-50 dark:border-zinc-800 dark:bg-zinc-950'
                    : occupied
                    ? 'border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900'
                    : 'border-dashed border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950',
                ].join(' ')}
              >
                {/* Seat number */}
                <span className="text-xs text-zinc-400">#{seat.seatNumber}</span>

                {/* Indicators row */}
                {occupied && (
                  <div className="mt-0.5 flex gap-0.5 flex-wrap justify-center">
                    {isDealer && (
                      <span className="rounded-full bg-white border border-zinc-400 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 px-1 text-[10px] font-bold leading-tight">
                        D
                      </span>
                    )}
                    {isSB && (
                      <span className="rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-1 text-[10px] font-bold leading-tight">
                        SB
                      </span>
                    )}
                    {isBB && (
                      <span className="rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 px-1 text-[10px] font-bold leading-tight">
                        BB
                      </span>
                    )}
                    {isAllIn && (
                      <span className="rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 px-1 text-[10px] font-bold leading-tight">
                        ALL IN
                      </span>
                    )}
                    {isFolded && (
                      <span className="rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-700 px-1 text-[10px] font-bold leading-tight">
                        FOLD
                      </span>
                    )}
                  </div>
                )}

                {/* Username */}
                {occupied ? (
                  <span className="mt-1 text-sm font-medium truncate w-full">
                    {seat.username}
                    {isMe && (
                      <span className="block text-xs font-normal text-blue-500">(you)</span>
                    )}
                  </span>
                ) : (
                  <span className="mt-1 text-xs text-zinc-400">Empty</span>
                )}

                {/* Stack + contribution (when hand is active) */}
                {hp && (
                  <div className="mt-1 space-y-0.5">
                    <span className="block text-xs font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
                      {hp.stack.toLocaleString()}
                    </span>
                    {hp.roundContribution > 0 && (
                      <span className="block text-[10px] tabular-nums text-zinc-400">
                        bet {hp.roundContribution}
                      </span>
                    )}
                  </div>
                )}

                {/* Face-down cards for other seated players in-hand */}
                {hand && occupied && !isMe && !isFolded && hp && (
                  <div className="mt-1 flex gap-0.5 justify-center">
                    <CardBack />
                    <CardBack />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Action panel ── */}
      {myStatus === 'seated' && isMyTurn && myHandPlayer?.playerPhase === 'active' && (
        <section className="space-y-3 rounded-lg border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-700 dark:bg-yellow-950/20">
          <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
            Your turn to act
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => sendAction('FOLD')}
              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Fold
            </button>

            {canCheck ? (
              <button
                onClick={() => sendAction('CHECK')}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Check
              </button>
            ) : (
              <button
                onClick={() => sendAction('CALL')}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Call {callAmount}
              </button>
            )}

            <div className="flex items-center gap-1">
              <input
                type="number"
                min={minRaiseTarget}
                max={(myHandPlayer?.stack ?? 0) + (myHandPlayer?.roundContribution ?? 0)}
                value={raiseAmount}
                onChange={e => setRaiseAmount(Number(e.target.value))}
                className="w-24 rounded-md border border-zinc-300 px-2 py-2 text-sm tabular-nums dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <button
                onClick={() => sendAction('RAISE', raiseAmount)}
                disabled={raiseAmount < minRaiseTarget}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Raise to {raiseAmount}
              </button>
            </div>

            <button
              onClick={() => sendAction('ALL_IN')}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
            >
              All In ({(myHandPlayer?.stack ?? 0).toLocaleString()})
            </button>
          </div>
        </section>
      )}

      {/* ── Start hand button ── */}
      {canStartHand && (
        <div className="flex justify-center">
          <button
            onClick={handleStartHand}
            className="rounded-md bg-green-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-700"
          >
            Start Hand
          </button>
        </div>
      )}

      {/* ── Waiting notice (no hand, not enough players) ── */}
      {!hand && !canStartHand && (
        <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-400 dark:border-zinc-800">
          {state.seats.filter(s => s.playerId !== null).length < 2
            ? 'Waiting for more players to join…'
            : 'Waiting for a player to start the hand…'}
        </div>
      )}

      {/* ── Spectators ── */}
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
    </main>
  )
}
