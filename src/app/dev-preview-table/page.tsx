'use client'

// TEMPORARY: local-only screenshot harness for the LAYOUT_PREVIEW_ENABLED
// mock in TableRoom.tsx. Not linked from anywhere, bypasses auth/DB. Delete
// after use.

import TableRoom from '../(player)/table/[id]/TableRoom'
import type { TableStatePayload } from '@/lib/socket/types'

const fakeState: TableStatePayload = {
  tableId: 'preview',
  tableName: 'Preview Table',
  smallBlind: 50,
  bigBlind: 100,
  maxPlayers: 9,
  tableType: 'open',
  status: 'active',
  seats: [],
  spectators: [],
  // Only read once on mount to seed the community-card reveal animation count;
  // actual rendering uses the LAYOUT_PREVIEW_ENABLED mock in TableRoom.tsx.
  handState: {
    handNumber: 0,
    phase: 'RIVER',
    pot: 300,
    currentBet: 200,
    minRaise: 200,
    currentTurnPlayerId: null,
    dealerSeatNumber: 9,
    smallBlindSeatNumber: 2,
    bigBlindSeatNumber: 3,
    communityCards: [
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: 'K' },
      { suit: 'spades', rank: 'Q' },
      { suit: 'spades', rank: 'J' },
      { suit: 'spades', rank: '10' },
    ],
    players: [],
  },
  gameMode: 'cash',
  prizePool: null,
  sitGoStatus: null,
  blindLevel: null,
  buyIn: null,
  startingStack: null,
  lastHandsRemaining: null,
}

export default function DevPreviewTablePage() {
  return (
    <TableRoom
      initialState={fakeState}
      currentUserId="preview-hero"
      myStatus="seated"
      mySeatNumber={1}
      isAdmin={false}
    />
  )
}
