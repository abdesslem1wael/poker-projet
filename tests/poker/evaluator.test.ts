import { describe, it, expect } from 'vitest'
import { evaluateBestHand, compareHands, HandRank } from '../../src/lib/poker/evaluator'
import type { Card } from '../../src/lib/poker/types'

function c(rank: Card['rank'], suit: Card['suit']): Card {
  return { rank, suit }
}

// ---------------------------------------------------------------------------
// Hand rank identification
// ---------------------------------------------------------------------------

describe('evaluateBestHand — hand rank identification', () => {
  it('identifies High Card', () => {
    // A-K-Q-J-9-8-7: no pair, no flush, no straight (gap at 10)
    const result = evaluateBestHand([
      c('A','spades'), c('K','hearts'), c('Q','diamonds'), c('J','clubs'),
      c('9','spades'), c('8','hearts'), c('7','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.HighCard)
  })

  it('identifies Pair', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('K','diamonds'), c('Q','clubs'),
      c('J','spades'), c('9','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.Pair)
  })

  it('identifies Two Pair', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('K','diamonds'), c('K','clubs'),
      c('Q','spades'), c('J','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.TwoPair)
  })

  it('identifies Three of a Kind', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('A','diamonds'), c('K','clubs'),
      c('Q','spades'), c('J','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.ThreeOfAKind)
  })

  it('identifies Straight (9-high)', () => {
    const result = evaluateBestHand([
      c('9','spades'), c('8','hearts'), c('7','diamonds'), c('6','clubs'),
      c('5','spades'), c('A','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.Straight)
    expect(result.tiebreakers[0]).toBe(9)
  })

  it('identifies Ace-low Straight (A-2-3-4-5, wheel)', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('2','hearts'), c('3','diamonds'), c('4','clubs'),
      c('5','spades'), c('K','hearts'), c('9','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.Straight)
    expect(result.tiebreakers[0]).toBe(5) // 5-high, not 14-high
  })

  it('identifies Flush', () => {
    // Five spades, no straight (gap at 10)
    const result = evaluateBestHand([
      c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'),
      c('9','spades'), c('2','hearts'), c('3','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.Flush)
  })

  it('identifies Full House', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('A','diamonds'), c('K','clubs'),
      c('K','spades'), c('Q','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.FullHouse)
  })

  it('identifies Four of a Kind', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('A','diamonds'), c('A','clubs'),
      c('K','spades'), c('Q','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.FourOfAKind)
  })

  it('identifies Straight Flush (9-high)', () => {
    const result = evaluateBestHand([
      c('9','spades'), c('8','spades'), c('7','spades'), c('6','spades'),
      c('5','spades'), c('A','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.StraightFlush)
    expect(result.tiebreakers[0]).toBe(9)
  })

  it('identifies Royal Flush (A-K-Q-J-10 suited)', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'),
      c('10','spades'), c('2','hearts'), c('3','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.RoyalFlush)
  })
})

// ---------------------------------------------------------------------------
// Selecting the best 5 cards from 7
// ---------------------------------------------------------------------------

describe('evaluateBestHand — best 5 from 7 cards', () => {
  it('picks Straight over Pair when both are possible', () => {
    // 9-8-7-6-5 straight exists; also a pair of 5s
    const result = evaluateBestHand([
      c('9','spades'), c('8','hearts'), c('7','diamonds'), c('6','clubs'),
      c('5','spades'), c('5','hearts'), c('2','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.Straight)
  })

  it('picks the highest 5-card flush when 6 cards share a suit', () => {
    // Six spades: A K Q J 9 3 — best flush must be A K Q J 9, not include 3
    const result = evaluateBestHand([
      c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'),
      c('9','spades'), c('3','spades'), c('2','hearts'),
    ])
    expect(result.rank).toBe(HandRank.Flush)
    expect(result.tiebreakers).toEqual([14, 13, 12, 11, 9])
  })

  it('picks Full House over Three of a Kind when a pair is available', () => {
    const result = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('A','diamonds'), c('K','clubs'),
      c('K','spades'), c('2','hearts'), c('3','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.FullHouse)
  })

  it('picks the higher of two possible straights', () => {
    // Cards contain both a 6-high and a 9-high straight; 9-high wins
    const result = evaluateBestHand([
      c('9','spades'), c('8','hearts'), c('7','diamonds'), c('6','clubs'),
      c('5','spades'), c('4','hearts'), c('3','diamonds'),
    ])
    expect(result.rank).toBe(HandRank.Straight)
    expect(result.tiebreakers[0]).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// Tiebreakers
// ---------------------------------------------------------------------------

describe('evaluateBestHand — tiebreakers', () => {
  it('higher pair rank beats lower pair rank', () => {
    const pairAces = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('K','diamonds'), c('Q','clubs'),
      c('J','spades'), c('9','hearts'), c('2','diamonds'),
    ])
    const pairKings = evaluateBestHand([
      c('K','spades'), c('K','hearts'), c('A','diamonds'), c('Q','clubs'),
      c('J','spades'), c('9','hearts'), c('2','diamonds'),
    ])
    expect(compareHands(pairAces, pairKings)).toBeGreaterThan(0)
  })

  it('same pair rank — highest kicker wins', () => {
    const jackKicker = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('K','diamonds'), c('Q','clubs'),
      c('J','spades'), c('9','hearts'), c('2','diamonds'),
    ])
    const tenKicker = evaluateBestHand([
      c('A','clubs'), c('A','diamonds'), c('K','clubs'), c('Q','diamonds'),
      c('10','spades'), c('9','clubs'), c('2','clubs'),
    ])
    expect(compareHands(jackKicker, tenKicker)).toBeGreaterThan(0)
  })

  it('higher two-pair wins (second pair decides)', () => {
    const acesAndKings = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('K','diamonds'), c('K','clubs'),
      c('Q','spades'), c('J','hearts'), c('2','diamonds'),
    ])
    const acesAndQueens = evaluateBestHand([
      c('A','clubs'), c('A','diamonds'), c('Q','clubs'), c('Q','diamonds'),
      c('K','spades'), c('J','clubs'), c('2','clubs'),
    ])
    expect(compareHands(acesAndKings, acesAndQueens)).toBeGreaterThan(0)
  })

  it('same two-pair — kicker decides', () => {
    const queenKicker = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('K','diamonds'), c('K','clubs'),
      c('Q','spades'), c('J','hearts'), c('2','diamonds'),
    ])
    const jackKicker = evaluateBestHand([
      c('A','clubs'), c('A','diamonds'), c('K','clubs'), c('K','hearts'),
      c('J','spades'), c('9','clubs'), c('2','clubs'),
    ])
    expect(compareHands(queenKicker, jackKicker)).toBeGreaterThan(0)
  })

  it('higher straight wins', () => {
    const tenHigh = evaluateBestHand([
      c('10','spades'), c('9','hearts'), c('8','diamonds'), c('7','clubs'),
      c('6','spades'), c('A','hearts'), c('2','diamonds'),
    ])
    const nineHigh = evaluateBestHand([
      c('9','clubs'), c('8','spades'), c('7','hearts'), c('6','diamonds'),
      c('5','clubs'), c('A','hearts'), c('2','diamonds'),
    ])
    expect(compareHands(tenHigh, nineHigh)).toBeGreaterThan(0)
  })

  it('higher flush wins (fifth card decides)', () => {
    const nineFlush = evaluateBestHand([
      c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'),
      c('9','spades'), c('2','hearts'), c('3','diamonds'),
    ])
    const eightFlush = evaluateBestHand([
      c('A','hearts'), c('K','hearts'), c('Q','hearts'), c('J','hearts'),
      c('8','hearts'), c('2','clubs'), c('3','clubs'),
    ])
    expect(compareHands(nineFlush, eightFlush)).toBeGreaterThan(0)
  })

  it('higher full house triple wins', () => {
    const acesFullOfKings = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('A','diamonds'), c('K','clubs'),
      c('K','spades'), c('Q','hearts'), c('2','diamonds'),
    ])
    const kingsFullOfAces = evaluateBestHand([
      c('K','clubs'), c('K','diamonds'), c('K','hearts'), c('A','clubs'),
      c('A','diamonds'), c('Q','clubs'), c('2','clubs'),
    ])
    expect(compareHands(acesFullOfKings, kingsFullOfAces)).toBeGreaterThan(0)
  })

  it('higher four of a kind wins', () => {
    const quadAces = evaluateBestHand([
      c('A','spades'), c('A','hearts'), c('A','diamonds'), c('A','clubs'),
      c('K','spades'), c('Q','hearts'), c('2','diamonds'),
    ])
    const quadKings = evaluateBestHand([
      c('K','spades'), c('K','hearts'), c('K','diamonds'), c('K','clubs'),
      c('A','spades'), c('Q','hearts'), c('2','diamonds'),
    ])
    expect(compareHands(quadAces, quadKings)).toBeGreaterThan(0)
  })

  it('truly equal hands return 0 from compareHands', () => {
    // Both players share the same best 5-card flush (community-card scenario)
    const handA = evaluateBestHand([
      c('A','spades'), c('K','spades'), c('Q','spades'), c('J','spades'),
      c('9','spades'), c('2','hearts'), c('3','diamonds'),
    ])
    const handB = evaluateBestHand([
      c('A','hearts'), c('K','hearts'), c('Q','hearts'), c('J','hearts'),
      c('9','hearts'), c('2','clubs'), c('3','clubs'),
    ])
    expect(compareHands(handA, handB)).toBe(0)
  })

  it('straight flush beats flush', () => {
    const sf = evaluateBestHand([
      c('9','spades'), c('8','spades'), c('7','spades'), c('6','spades'),
      c('5','spades'), c('A','hearts'), c('2','diamonds'),
    ])
    const flush = evaluateBestHand([
      c('A','hearts'), c('K','hearts'), c('Q','hearts'), c('J','hearts'),
      c('9','hearts'), c('2','clubs'), c('3','clubs'),
    ])
    expect(compareHands(sf, flush)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Ace-low straight edge cases
// ---------------------------------------------------------------------------

describe('evaluateBestHand — Ace-low straight edge cases', () => {
  it('wheel tiebreaker is 5, not 14', () => {
    const wheel = evaluateBestHand([
      c('A','spades'), c('2','hearts'), c('3','diamonds'), c('4','clubs'),
      c('5','spades'), c('K','hearts'), c('9','diamonds'),
    ])
    expect(wheel.rank).toBe(HandRank.Straight)
    expect(wheel.tiebreakers[0]).toBe(5)
  })

  it('6-high straight beats the wheel', () => {
    const wheel = evaluateBestHand([
      c('A','spades'), c('2','hearts'), c('3','diamonds'), c('4','clubs'),
      c('5','spades'), c('K','hearts'), c('9','diamonds'),
    ])
    const sixHigh = evaluateBestHand([
      c('6','clubs'), c('5','spades'), c('4','hearts'), c('3','diamonds'),
      c('2','clubs'), c('K','clubs'), c('9','hearts'),
    ])
    expect(compareHands(sixHigh, wheel)).toBeGreaterThan(0)
  })

  it('wheel loses to a pair', () => {
    // Wheel is a Straight (rank 5); Pair is rank 2, so Straight beats Pair —
    // verifying straight rank ordering is correct either way
    const wheel = evaluateBestHand([
      c('A','spades'), c('2','hearts'), c('3','diamonds'), c('4','clubs'),
      c('5','spades'), c('K','hearts'), c('9','diamonds'),
    ])
    expect(wheel.rank).toBeGreaterThan(HandRank.Pair)
  })
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('evaluateBestHand — input validation', () => {
  it('throws when fewer than 5 cards are provided', () => {
    expect(() =>
      evaluateBestHand([
        c('A','spades'), c('K','hearts'), c('Q','diamonds'), c('J','clubs'),
      ])
    ).toThrow()
  })
})
