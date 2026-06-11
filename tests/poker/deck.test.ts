import { describe, it, expect } from 'vitest'
import { createDeck, shuffle } from '../../src/lib/poker/deck'
import { SUITS, RANKS } from '../../src/lib/poker/types'

const cardKey = (c: { suit: string; rank: string }) => `${c.rank}-${c.suit}`

describe('createDeck', () => {
  it('creates exactly 52 cards', () => {
    expect(createDeck()).toHaveLength(52)
  })

  it('contains no duplicate cards', () => {
    const deck = createDeck()
    const keys = new Set(deck.map(cardKey))
    expect(keys.size).toBe(52)
  })

  it('contains every suit', () => {
    const suits = new Set(createDeck().map(c => c.suit))
    expect(suits.size).toBe(SUITS.length)
    for (const suit of SUITS) {
      expect(suits.has(suit)).toBe(true)
    }
  })

  it('contains every rank', () => {
    const ranks = new Set(createDeck().map(c => c.rank))
    expect(ranks.size).toBe(RANKS.length)
    for (const rank of RANKS) {
      expect(ranks.has(rank)).toBe(true)
    }
  })

  it('has exactly 13 cards per suit', () => {
    const deck = createDeck()
    for (const suit of SUITS) {
      expect(deck.filter(c => c.suit === suit)).toHaveLength(13)
    }
  })
})

describe('shuffle', () => {
  it('returns a deck of the same size', () => {
    expect(shuffle(createDeck())).toHaveLength(52)
  })

  it('contains exactly the same cards as the original (is a permutation)', () => {
    const deck = createDeck()
    const shuffled = shuffle(deck)
    expect(shuffled.map(cardKey).sort()).toEqual(deck.map(cardKey).sort())
  })

  it('does not mutate the original deck', () => {
    const deck = createDeck()
    const snapshot = deck.map(cardKey).join(',')
    shuffle(deck)
    expect(deck.map(cardKey).join(',')).toBe(snapshot)
  })

  it('changes the order of cards', () => {
    // Run 5 independent shuffles. The probability that all 5 produce the
    // identical unshuffled sequence is (1/52!)^5 ≈ 0.
    const deck = createDeck()
    const original = deck.map(cardKey).join(',')
    let orderChanged = false
    for (let i = 0; i < 5; i++) {
      if (shuffle(deck).map(cardKey).join(',') !== original) {
        orderChanged = true
        break
      }
    }
    expect(orderChanged).toBe(true)
  })
})
