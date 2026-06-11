import { describe, it, expect } from 'vitest'
import { distributeWinnings } from '../../src/lib/poker/winner'
import { HandRank } from '../../src/lib/poker/evaluator'
import type { ShowdownPlayer } from '../../src/lib/poker/winner'
import type { Card } from '../../src/lib/poker/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function c(rank: Card['rank'], suit: Card['suit']): Card {
  return { rank, suit }
}

function player(
  id: string,
  holeCards: [Card, Card],
  contributed: number,
  hasFolded = false
): ShowdownPlayer {
  return { playerId: id, holeCards, contributed, hasFolded }
}

function totalDelta(chipDeltas: Record<string, number>): number {
  return Object.values(chipDeltas).reduce((a, b) => a + b, 0)
}

function totalContributed(players: ShowdownPlayer[]): number {
  return players.reduce((a, p) => a + p.contributed, 0)
}

// ---------------------------------------------------------------------------
// 1. Single winner wins the full pot
// ---------------------------------------------------------------------------
describe('distributeWinnings — single winner takes full pot', () => {
  // Community: 2♦ 7♣ J♠ Q♥ 4♣ — no flush, no straight possible
  const community = [c('2','diamonds'), c('7','clubs'), c('J','spades'), c('Q','hearts'), c('4','clubs')]

  it('winner receives 100 % of chips', () => {
    const players = [
      player('p1', [c('A','hearts'), c('A','diamonds')], 100),  // Pair of Aces
      player('p2', [c('K','clubs'),  c('9','spades')],   100),  // High Card
    ]
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(200)
    expect(chipDeltas['p2']).toBe(0)
  })

  it('winning hand is recorded on the pot distribution', () => {
    const players = [
      player('p1', [c('A','hearts'), c('A','diamonds')], 100),
      player('p2', [c('K','clubs'),  c('9','spades')],   100),
    ]
    const { pots } = distributeWinnings(community, players)
    expect(pots[0].winners).toEqual(['p1'])
    expect(pots[0].winnerHandRank).toBe(HandRank.Pair)
  })
})

// ---------------------------------------------------------------------------
// 2. Pair beats High Card
// ---------------------------------------------------------------------------
describe('distributeWinnings — Pair beats High Card', () => {
  const community = [c('2','diamonds'), c('7','clubs'), c('J','spades'), c('Q','hearts'), c('4','clubs')]

  it('pair of fives beats ace-high', () => {
    const players = [
      player('p1', [c('5','hearts'), c('5','diamonds')], 50),  // Pair of Fives
      player('p2', [c('A','clubs'),  c('9','spades')],   50),  // Ace-high
    ]
    const { pots } = distributeWinnings(community, players)
    expect(pots[0].winners).toEqual(['p1'])
    expect(pots[0].winnerHandRank).toBe(HandRank.Pair)
  })
})

// ---------------------------------------------------------------------------
// 3. Flush beats Straight
// ---------------------------------------------------------------------------
describe('distributeWinnings — Flush beats Straight', () => {
  // Community: 9♥ 8♥ 7♥ 6♦ 2♣
  // p1: A♥ 3♥ → five hearts → Flush A-9-8-7-3
  // p2: 10♣ 5♦ → 6-7-8-9-10 Straight (off-suit)
  const community = [c('9','hearts'), c('8','hearts'), c('7','hearts'), c('6','diamonds'), c('2','clubs')]

  it('flush beats straight', () => {
    const players = [
      player('p1', [c('A','hearts'), c('3','hearts')], 100),
      player('p2', [c('10','clubs'), c('5','diamonds')], 100),
    ]
    const { pots, chipDeltas } = distributeWinnings(community, players)
    expect(pots[0].winners).toEqual(['p1'])
    expect(pots[0].winnerHandRank).toBe(HandRank.Flush)
    expect(chipDeltas['p1']).toBe(200)
    expect(chipDeltas['p2']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Full House beats Flush
// ---------------------------------------------------------------------------
describe('distributeWinnings — Full House beats Flush', () => {
  // Community: A♣ A♦ K♦ Q♦ 3♦
  // p1: A♥ K♥ → AAA over KK (Full House)
  // p2: 2♦ 5♦ → six diamonds available → Flush (A-K-Q-5-3 diamonds)
  const community = [c('A','clubs'), c('A','diamonds'), c('K','diamonds'), c('Q','diamonds'), c('3','diamonds')]

  it('full house beats flush', () => {
    const players = [
      player('p1', [c('A','hearts'), c('K','hearts')], 100),
      player('p2', [c('2','diamonds'), c('5','diamonds')], 100),
    ]
    const { pots, chipDeltas } = distributeWinnings(community, players)
    expect(pots[0].winners).toEqual(['p1'])
    expect(pots[0].winnerHandRank).toBe(HandRank.FullHouse)
    expect(chipDeltas['p1']).toBe(200)
    expect(chipDeltas['p2']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Best hand is selected from all 7 cards
// ---------------------------------------------------------------------------
describe('distributeWinnings — best 5 chosen from 7 cards', () => {
  // Community: 4♠ 5♠ 6♠ 7♠ 8♠  (straight flush on board)
  // p1: 9♠ 2♣ → uses 5♠-6♠-7♠-8♠-9♠ → 9-high Straight Flush
  // p2: A♦ K♦ → stuck with 4♠-5♠-6♠-7♠-8♠ → 8-high Straight Flush
  // 9-high SF beats 8-high SF only if the 9♠ hole card is correctly included
  const community = [c('4','spades'), c('5','spades'), c('6','spades'), c('7','spades'), c('8','spades')]

  it('hole card improves community straight flush to a higher one', () => {
    const players = [
      player('p1', [c('9','spades'), c('2','clubs')],  100),
      player('p2', [c('A','diamonds'), c('K','diamonds')], 100),
    ]
    const { pots } = distributeWinnings(community, players)
    expect(pots[0].winners).toEqual(['p1'])
    expect(pots[0].winnerHandRank).toBe(HandRank.StraightFlush)
  })
})

// ---------------------------------------------------------------------------
// 6. Folded player cannot win
// ---------------------------------------------------------------------------
describe('distributeWinnings — folded player', () => {
  // Community: 2♦ 7♣ J♠ Q♥ 4♣
  // p1: Pair AA (active), p2: High Card (folded), p3: Pair 55 (active)
  const community = [c('2','diamonds'), c('7','clubs'), c('J','spades'), c('Q','hearts'), c('4','clubs')]

  const players = [
    player('p1', [c('A','hearts'), c('A','diamonds')], 100),
    player('p2', [c('K','clubs'),  c('9','spades')],    50, true),  // folded
    player('p3', [c('5','clubs'),  c('5','diamonds')], 100),
  ]

  it('folded player receives zero chips', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p2']).toBe(0)
  })

  it('folded player chips go to winner — p1 Pair AA wins total pot', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(250)  // 100+50+100
    expect(chipDeltas['p3']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Side-pot winner can differ from main-pot winner
// ---------------------------------------------------------------------------
describe('distributeWinnings — side pot winner differs from main pot winner', () => {
  // Community: 2♣ 3♠ 4♣ 7♦ 8♠ — no flush, no straight
  // p1 (all-in 10): Pair AA — best overall, wins main pot only
  // p2 (50): Pair KK — wins side pot
  // p3 (50): Pair QQ — loses both
  const community = [c('2','clubs'), c('3','spades'), c('4','clubs'), c('7','diamonds'), c('8','spades')]
  const players = [
    player('p1', [c('A','spades'), c('A','clubs')],   10),
    player('p2', [c('K','diamonds'), c('K','clubs')], 50),
    player('p3', [c('Q','diamonds'), c('Q','clubs')], 50),
  ]

  it('all-in player wins the main pot', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(30)   // main pot: 10×3
  })

  it('second-best hand wins the side pot', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p2']).toBe(80)   // side pot: 40×2
  })

  it('loser receives nothing', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p3']).toBe(0)
  })

  it('total distributed equals total contributed', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(totalDelta(chipDeltas)).toBe(totalContributed(players))
  })
})

// ---------------------------------------------------------------------------
// 8. Multiple all-ins create multiple pots with different winners
// ---------------------------------------------------------------------------
describe('distributeWinnings — multiple all-in players, different pot winners', () => {
  // Community: A♠ A♥ A♣ A♦ 2♠  (four aces on board)
  // All players have Four Aces; winner per pot decided by kicker.
  // p1(K kicker) > p2(J kicker) > p3(9 kicker) > p4(7 kicker)
  // Pot tiers: 10×4=40, 20×3=60, 30×2=60
  const community = [c('A','spades'), c('A','hearts'), c('A','clubs'), c('A','diamonds'), c('2','spades')]
  const players = [
    player('p1', [c('K','diamonds'), c('Q','clubs')],  10),
    player('p2', [c('J','diamonds'), c('10','clubs')], 30),
    player('p3', [c('9','diamonds'), c('8','clubs')],  60),
    player('p4', [c('7','diamonds'), c('6','clubs')],  60),
  ]

  it('shortest-stack wins only the main pot (K kicker)', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(40)
  })

  it('second stack wins tier-2 side pot (J kicker)', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p2']).toBe(60)
  })

  it('third stack wins tier-3 side pot (9 kicker)', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p3']).toBe(60)
  })

  it('deepest stack with weakest kicker wins nothing', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p4']).toBe(0)
  })

  it('total distributed equals total contributed', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(totalDelta(chipDeltas)).toBe(totalContributed(players))
  })
})

// ---------------------------------------------------------------------------
// 9. Tied pot is split equally
// ---------------------------------------------------------------------------
describe('distributeWinnings — tied pot split', () => {
  // Community: A♠ K♠ Q♠ J♠ 10♠ — Royal Flush on board; all active players tie
  const community = [c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'), c('10','spades')]

  it('two-way tie: each player receives half the pot', () => {
    const players = [
      player('p1', [c('2','hearts'), c('3','clubs')],  100),
      player('p2', [c('4','diamonds'), c('5','clubs')], 100),
    ]
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(100)
    expect(chipDeltas['p2']).toBe(100)
  })

  it('three-way tie: each player receives one third of the pot', () => {
    const players = [
      player('p1', [c('2','hearts'), c('3','clubs')],   90),
      player('p2', [c('4','diamonds'), c('5','clubs')],  90),
      player('p3', [c('6','hearts'), c('7','clubs')],    90),
    ]
    const { chipDeltas, pots } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(90)
    expect(chipDeltas['p2']).toBe(90)
    expect(chipDeltas['p3']).toBe(90)
    expect(pots[0].remainder).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. Uneven split — remainder chip goes to earliest input-order winner
// ---------------------------------------------------------------------------
describe('distributeWinnings — uneven split remainder', () => {
  // Community: Royal Flush on board → active players all tie
  // p1 folded with 34 chips → pot = 34+50+50+50 = 184
  // 184 ÷ 3 = 61 rem 1 → p2 (first by input order) gets the extra chip
  const community = [c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'), c('10','spades')]
  const players = [
    player('p1', [c('2','hearts'), c('3','diamonds')],  34, true),  // folded
    player('p2', [c('4','clubs'),  c('5','diamonds')],  50),
    player('p3', [c('6','hearts'), c('7','clubs')],     50),
    player('p4', [c('8','diamonds'), c('9','clubs')],   50),
  ]

  it('first winner by input order receives the extra chip', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p2']).toBe(62)  // 61 + 1 extra
  })

  it('remaining tied winners receive floor division', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p3']).toBe(61)
    expect(chipDeltas['p4']).toBe(61)
  })

  it('folded player receives nothing', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(chipDeltas['p1']).toBe(0)
  })

  it('remainder field on pot is 1', () => {
    const { pots } = distributeWinnings(community, players)
    expect(pots[0].remainder).toBe(1)
  })

  it('total distributed equals total contributed despite odd remainder', () => {
    const { chipDeltas } = distributeWinnings(community, players)
    expect(totalDelta(chipDeltas)).toBe(totalContributed(players))  // 184
  })
})

// ---------------------------------------------------------------------------
// 11. Total distributed chips always equals total contributions
// ---------------------------------------------------------------------------
describe('distributeWinnings — no chip loss invariant', () => {
  // Royal Flush on board → everyone ties → equal redistribution per contribution tier
  const community = [c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'), c('10','spades')]

  it('holds for multiple all-in tiers where all players tie', () => {
    // Each player gets back exactly what they contributed (they all tie)
    const players = [
      player('p1', [c('2','hearts'), c('3','clubs')],   10),
      player('p2', [c('4','diamonds'), c('5','clubs')], 30),
      player('p3', [c('6','hearts'), c('7','clubs')],   60),
      player('p4', [c('8','diamonds'), c('9','clubs')], 60),
    ]
    const { chipDeltas } = distributeWinnings(community, players)
    expect(totalDelta(chipDeltas)).toBe(totalContributed(players))
    // Each player wins exactly their own contribution back when all tie
    expect(chipDeltas['p1']).toBe(10)
    expect(chipDeltas['p2']).toBe(30)
    expect(chipDeltas['p3']).toBe(60)
    expect(chipDeltas['p4']).toBe(60)
  })

  it('holds for a complex scenario with folds, all-ins and a clear winner', () => {
    // Community: 2♦ 7♣ J♠ Q♥ 4♣ (from earlier tests)
    const mixedCommunity = [c('2','diamonds'), c('7','clubs'), c('J','spades'), c('Q','hearts'), c('4','clubs')]
    const players = [
      player('p1', [c('A','hearts'),   c('A','diamonds')], 100),
      player('p2', [c('K','clubs'),    c('9','spades')],    50, true),
      player('p3', [c('5','clubs'),    c('5','diamonds')], 100),
      player('p4', [c('3','hearts'),   c('3','diamonds')],  40),
    ]
    const { chipDeltas } = distributeWinnings(mixedCommunity, players)
    expect(totalDelta(chipDeltas)).toBe(totalContributed(players))
  })
})
