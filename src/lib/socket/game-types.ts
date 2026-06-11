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
}

export interface TableGame {
  tableId: string
  dealerSeatNumber: number    // 0 = first hand not yet dealt
  handState: HandState | null
}
