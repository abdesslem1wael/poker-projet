// Server-side only — never import from client code.
// Contains private game state (hole cards, deck) that must never reach the client.
import type { Card } from '../poker/types'

export type Phase = 'PRE_FLOP' | 'FLOP' | 'TURN' | 'RIVER'
export type PlayerStatus = 'active' | 'folded' | 'all-in'

export interface PlayerHandState {
  playerId: string
  username: string
  seatNumber: number
  stack: number               // chips remaining this hand
  roundContribution: number   // chips put in during the current betting round
  totalContributed: number    // chips put in across all rounds of this hand
  status: PlayerStatus
  hasActedThisRound: boolean
  holeCards: [Card, Card]     // NEVER sent to the client
}

export interface HandState {
  phase: Phase
  bigBlind: number            // stored to reset minRaise at each new street
  handNumber: number          // monotonically increasing per table
  startedAt: Date
  deckRemaining: Card[]       // cards still in the deck — NEVER sent to the client
  communityCards: Card[]      // revealed board cards (publicly visible)
  players: PlayerHandState[]  // sorted by seatNumber ascending, fixed for the hand
  dealerSeatNumber: number
  smallBlindSeatNumber: number
  bigBlindSeatNumber: number
  pot: number                 // total chips across all streets
  currentBet: number          // current bet level in this street
  minRaise: number            // minimum raise increment
  currentActorIndex: number   // index into players[]; -1 when nobody to act
  tipPool: number             // accumulated automatic tips for this hand
  voluntaryRaiseLevel: number // last voluntary raise level for tip tracking (0 = none yet)
  rakeEnabled: boolean        // false for Sit & Go — the house fee is already taken from the buy-in
}

export interface TableGame {
  tableId: string
  dealerSeatNumber: number    // 0 = first hand not yet dealt
  handCount: number           // incremented each time startHand succeeds
  handState: HandState | null
}

// ── Snapshot returned when a hand ends ────────────────────────────────────────
// Contains all data needed to compute distribution and persist results.
// Hole cards are included because server.ts needs them for game_history and
// for computing distributeWinnings; they must NEVER be forwarded to clients raw.
export interface HandEndedData {
  reason: 'all_folded' | 'showdown'
  handNumber: number
  startedAt: Date
  communityCards: Card[]
  pot: number
  tipAmount: number           // automatic rake/tip accumulated during betting
  players: ReadonlyArray<{
    playerId: string
    username: string
    seatNumber: number
    stackAtEnd: number       // stack after betting, before pot distribution
    totalContributed: number
    hasFolded: boolean
    holeCards: [Card, Card]  // always present — server uses for history + eval
  }>
}
