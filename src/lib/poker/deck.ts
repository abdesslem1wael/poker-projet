import { Card, SUITS, RANKS } from './types'

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank })
    }
  }
  return deck
}

// Returns a new shuffled copy — does not mutate the input.
// Uses Fisher-Yates with crypto.getRandomValues for uniform distribution.
export function shuffle(cards: Card[]): Card[] {
  const result = [...cards]
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// Rejection sampling eliminates modulo bias for any max ≤ 2^32.
function secureRandomInt(max: number): number {
  const limit = 2 ** 32 - (2 ** 32 % max)
  const buf = new Uint32Array(1)
  do {
    globalThis.crypto.getRandomValues(buf)
  } while (buf[0] >= limit)
  return buf[0] % max
}
