import { describe, it, expect } from 'vitest'
import { computeShowdown } from '../../src/lib/socket/showdown-helper'
import type { HandEndedData } from '../../src/lib/socket/game-types'
import type { Card } from '../../src/lib/poker/types'

// ── Fixtures ───────────────────────────────────────────────────────────────

const TABLE = 'table-1'

function c(rank: string, suit: string): Card {
  return { rank: rank as Card['rank'], suit: suit as Card['suit'] }
}

// Five community cards (low board — no player is helped by the board alone).
const BOARD: Card[] = [
  c('2', 'diamonds'), c('7', 'clubs'), c('J', 'spades'),
  c('Q', 'hearts'),   c('4', 'clubs'),
]

// Three-player board for side-pot test.
// P1: contributed 10 (all-in), P2+P3: contributed 50 each.
// P1 has AA (wins main pot), P2 has KK (beats P3's QQ, wins side pot).
const SIDE_POT_BOARD: Card[] = [
  c('2', 'clubs'), c('3', 'spades'), c('4', 'diamonds'),
  c('7', 'hearts'), c('8', 'spades'),
]

// Board for tie test: everyone makes the same full house from the board.
const FULL_BOARD_STRAIGHT: Card[] = [
  c('5', 'hearts'), c('6', 'clubs'), c('7', 'diamonds'),
  c('8', 'spades'), c('9', 'hearts'),
]

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAllFolded(winnerContributed: number, otherContributed: number): HandEndedData {
  const pot = winnerContributed + otherContributed
  return {
    reason: 'all_folded',
    handNumber: 1,
    startedAt: new Date(),
    communityCards: [],
    pot,
    tipAmount: 0,
    players: [
      {
        playerId: 'p1', username: 'Alice', seatNumber: 1,
        stackAtEnd: 1000 - winnerContributed, totalContributed: winnerContributed,
        hasFolded: false,
        holeCards: [c('A', 'spades'), c('A', 'hearts')],
      },
      {
        playerId: 'p2', username: 'Bob', seatNumber: 2,
        stackAtEnd: 1000 - otherContributed, totalContributed: otherContributed,
        hasFolded: true,
        holeCards: [c('K', 'clubs'), c('K', 'diamonds')],
      },
    ],
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('computeShowdown — all_folded', () => {
  it('winner receives the full pot', () => {
    const data = makeAllFolded(50, 50)
    const result = computeShowdown(TABLE, data)
    const winner = result.players.find(p => p.playerId === 'p1')!
    expect(winner.chipDelta).toBe(100)
    expect(winner.finalStack).toBe(950 + 100) // stackAtEnd(950) + pot(100)
    expect(winner.netChipChange).toBe(50) // 100 received - 50 contributed
  })

  it('loser receives nothing', () => {
    const data = makeAllFolded(50, 50)
    const result = computeShowdown(TABLE, data)
    const loser = result.players.find(p => p.playerId === 'p2')!
    expect(loser.chipDelta).toBe(0)
    expect(loser.finalStack).toBe(950) // stackAtEnd only
    expect(loser.netChipChange).toBe(-50)
  })

  it('pot has exactly one winner', () => {
    const data = makeAllFolded(50, 50)
    const result = computeShowdown(TABLE, data)
    expect(result.pots[0].winners).toEqual(['p1'])
  })

  it('hole cards are NOT revealed', () => {
    const data = makeAllFolded(50, 50)
    const result = computeShowdown(TABLE, data)
    for (const p of result.players) {
      expect(p.holeCards).toBeNull()
    }
  })

  it('chip conservation: sum(finalStacks) == sum(initialStacks)', () => {
    const data = makeAllFolded(50, 100)
    const result = computeShowdown(TABLE, data)
    const sumFinal = result.players.reduce((s, p) => s + p.finalStack, 0)
    const sumInitial = data.players.reduce((s, p) => s + p.stackAtEnd + p.totalContributed, 0)
    expect(sumFinal).toBe(sumInitial)
  })
})

describe('computeShowdown — showdown (single winner)', () => {
  const data: HandEndedData = {
    reason: 'showdown',
    handNumber: 2,
    startedAt: new Date(),
    communityCards: BOARD,
    pot: 200,
    tipAmount: 0,
    players: [
      {
        playerId: 'p1', username: 'Alice', seatNumber: 1,
        stackAtEnd: 900, totalContributed: 100,
        hasFolded: false,
        holeCards: [c('A', 'hearts'), c('A', 'diamonds')],  // pair of aces (best)
      },
      {
        playerId: 'p2', username: 'Bob', seatNumber: 2,
        stackAtEnd: 900, totalContributed: 100,
        hasFolded: false,
        holeCards: [c('K', 'clubs'), c('9', 'spades')],     // king high
      },
    ],
  }

  it('correct winner receives the pot', () => {
    const result = computeShowdown(TABLE, data)
    const winner = result.players.find(p => p.playerId === 'p1')!
    expect(result.pots[0].winners).toEqual(['p1'])
    expect(winner.chipDelta).toBe(200)
    expect(winner.finalStack).toBe(1100)  // 900 + 200
    expect(winner.netChipChange).toBe(100)
  })

  it('loser gets nothing', () => {
    const result = computeShowdown(TABLE, data)
    const loser = result.players.find(p => p.playerId === 'p2')!
    expect(loser.chipDelta).toBe(0)
    expect(loser.finalStack).toBe(900)
    expect(loser.netChipChange).toBe(-100)
  })

  it('hole cards ARE revealed for non-folded players', () => {
    const result = computeShowdown(TABLE, data)
    for (const p of result.players) {
      expect(p.holeCards).not.toBeNull()
      expect(p.holeCards).toHaveLength(2)
    }
  })

  it('chip conservation', () => {
    const result = computeShowdown(TABLE, data)
    const sumFinal = result.players.reduce((s, p) => s + p.finalStack, 0)
    const sumInitial = data.players.reduce((s, p) => s + p.stackAtEnd + p.totalContributed, 0)
    expect(sumFinal).toBe(sumInitial)
  })
})

describe('computeShowdown — folded player cannot win', () => {
  it('folded player receives 0 chips even with strong cards', () => {
    const data: HandEndedData = {
      reason: 'showdown',
      handNumber: 3,
      startedAt: new Date(),
      communityCards: BOARD,
      pot: 150,
    tipAmount: 0,
      players: [
        {
          playerId: 'p1', username: 'Alice', seatNumber: 1,
          stackAtEnd: 900, totalContributed: 100,
          hasFolded: false,
          holeCards: [c('2', 'hearts'), c('3', 'spades')],  // low hand
        },
        {
          playerId: 'p2', username: 'Bob', seatNumber: 2,
          stackAtEnd: 950, totalContributed: 50,
          hasFolded: true,
          holeCards: [c('A', 'spades'), c('A', 'clubs')],   // would be best, but folded
        },
      ],
    }
    const result = computeShowdown(TABLE, data)
    const folded = result.players.find(p => p.playerId === 'p2')!
    expect(folded.chipDelta).toBe(0)
    expect(folded.finalStack).toBe(950)
    expect(result.pots[0].winners).toEqual(['p1'])
  })

  it('hole cards are NOT revealed for folded players', () => {
    const data: HandEndedData = {
      reason: 'showdown',
      handNumber: 4,
      startedAt: new Date(),
      communityCards: BOARD,
      pot: 150,
    tipAmount: 0,
      players: [
        {
          playerId: 'p1', username: 'Alice', seatNumber: 1,
          stackAtEnd: 900, totalContributed: 100,
          hasFolded: false,
          holeCards: [c('A', 'hearts'), c('A', 'diamonds')],
        },
        {
          playerId: 'p2', username: 'Bob', seatNumber: 2,
          stackAtEnd: 950, totalContributed: 50,
          hasFolded: true,
          holeCards: [c('K', 'spades'), c('K', 'clubs')],
        },
      ],
    }
    const result = computeShowdown(TABLE, data)
    const folded = result.players.find(p => p.playerId === 'p2')!
    expect(folded.holeCards).toBeNull()
  })
})

describe('computeShowdown — side pots', () => {
  // P1 all-in for 10, P2+P3 contribute 50 each.
  // Main pot = 30 (10 from each), side pot = 80 (40 from P2 + 40 from P3).
  // P1 has AA (wins main), P2 has KK (beats P3's QQ, wins side).
  const data: HandEndedData = {
    reason: 'showdown',
    handNumber: 5,
    startedAt: new Date(),
    communityCards: SIDE_POT_BOARD,
    pot: 110,
    tipAmount: 0,
    players: [
      {
        playerId: 'p1', username: 'Alice', seatNumber: 1,
        stackAtEnd: 0, totalContributed: 10,
        hasFolded: false,
        holeCards: [c('A', 'spades'), c('A', 'hearts')],
      },
      {
        playerId: 'p2', username: 'Bob', seatNumber: 2,
        stackAtEnd: 0, totalContributed: 50,
        hasFolded: false,
        holeCards: [c('K', 'clubs'), c('K', 'diamonds')],
      },
      {
        playerId: 'p3', username: 'Charlie', seatNumber: 3,
        stackAtEnd: 0, totalContributed: 50,
        hasFolded: false,
        holeCards: [c('Q', 'clubs'), c('Q', 'diamonds')],
      },
    ],
  }

  it('main pot winner differs from side pot winner', () => {
    const result = computeShowdown(TABLE, data)
    expect(result.pots).toHaveLength(2)
    const mainPot = result.pots[0]
    const sidePot = result.pots[1]
    expect(mainPot.winners).toEqual(['p1'])
    expect(sidePot.winners).toEqual(['p2'])
  })

  it('chip conservation across side pots', () => {
    const result = computeShowdown(TABLE, data)
    const sumFinal = result.players.reduce((s, p) => s + p.finalStack, 0)
    const sumInitial = data.players.reduce((s, p) => s + p.stackAtEnd + p.totalContributed, 0)
    expect(sumFinal).toBe(sumInitial)
  })

  it('p1 receives only the main pot, not the side pot', () => {
    const result = computeShowdown(TABLE, data)
    const p1 = result.players.find(p => p.playerId === 'p1')!
    expect(p1.chipDelta).toBe(30)   // main pot only
    expect(p1.finalStack).toBe(30)
  })

  it('p2 receives the side pot', () => {
    const result = computeShowdown(TABLE, data)
    const p2 = result.players.find(p => p.playerId === 'p2')!
    expect(p2.chipDelta).toBe(80)   // side pot
    expect(p2.finalStack).toBe(80)
  })
})

describe('computeShowdown — tie (pot split)', () => {
  // Both players make a straight from the board (5-6-7-8-9).
  // Neither player can improve on the board straight with their hole cards.
  const data: HandEndedData = {
    reason: 'showdown',
    handNumber: 6,
    startedAt: new Date(),
    communityCards: FULL_BOARD_STRAIGHT,
    pot: 200,
    tipAmount: 0,
    players: [
      {
        playerId: 'p1', username: 'Alice', seatNumber: 1,
        stackAtEnd: 900, totalContributed: 100,
        hasFolded: false,
        holeCards: [c('2', 'clubs'), c('3', 'hearts')],  // best 5 = board straight 5-9
      },
      {
        playerId: 'p2', username: 'Bob', seatNumber: 2,
        stackAtEnd: 900, totalContributed: 100,
        hasFolded: false,
        holeCards: [c('2', 'diamonds'), c('4', 'hearts')],  // same board straight 5-9
      },
    ],
  }

  it('pot is split equally between tied players', () => {
    const result = computeShowdown(TABLE, data)
    expect(result.pots[0].winners).toHaveLength(2)
    expect(result.pots[0].winners).toContain('p1')
    expect(result.pots[0].winners).toContain('p2')

    const p1 = result.players.find(p => p.playerId === 'p1')!
    const p2 = result.players.find(p => p.playerId === 'p2')!
    expect(p1.chipDelta).toBe(100)
    expect(p2.chipDelta).toBe(100)
  })

  it('both players break even on a tied pot', () => {
    const result = computeShowdown(TABLE, data)
    const p1 = result.players.find(p => p.playerId === 'p1')!
    const p2 = result.players.find(p => p.playerId === 'p2')!
    expect(p1.netChipChange).toBe(0)
    expect(p2.netChipChange).toBe(0)
  })

  it('chip conservation for tied pot', () => {
    const result = computeShowdown(TABLE, data)
    const sumFinal = result.players.reduce((s, p) => s + p.finalStack, 0)
    const sumInitial = data.players.reduce((s, p) => s + p.stackAtEnd + p.totalContributed, 0)
    expect(sumFinal).toBe(sumInitial)
  })
})

describe('computeShowdown — chip conservation invariant', () => {
  it('sum(chipDelta) == pot for all scenarios', () => {
    const scenarios: HandEndedData[] = [
      makeAllFolded(50, 75),
      {
        reason: 'showdown',
        handNumber: 7,
        startedAt: new Date(),
        communityCards: BOARD,
        pot: 300,
    tipAmount: 0,
        players: [
          {
            playerId: 'p1', username: 'Alice', seatNumber: 1,
            stackAtEnd: 700, totalContributed: 100,
            hasFolded: false,
            holeCards: [c('A', 'spades'), c('A', 'clubs')],
          },
          {
            playerId: 'p2', username: 'Bob', seatNumber: 2,
            stackAtEnd: 700, totalContributed: 100,
            hasFolded: true,
            holeCards: [c('3', 'hearts'), c('4', 'spades')],
          },
          {
            playerId: 'p3', username: 'Charlie', seatNumber: 3,
            stackAtEnd: 700, totalContributed: 100,
            hasFolded: false,
            holeCards: [c('K', 'hearts'), c('K', 'spades')],
          },
        ],
      },
    ]

    for (const data of scenarios) {
      const result = computeShowdown(TABLE, data)
      const sumDeltas = result.players.reduce((s, p) => s + p.chipDelta, 0)
      expect(sumDeltas).toBe(data.pot)
    }
  })
})
