import { Card, Rank } from './types'

export enum HandRank {
  HighCard      = 1,
  Pair          = 2,
  TwoPair       = 3,
  ThreeOfAKind  = 4,
  Straight      = 5,
  Flush         = 6,
  FullHouse     = 7,
  FourOfAKind   = 8,
  StraightFlush = 9,
  RoyalFlush    = 10,
}

export interface HandResult {
  rank: HandRank
  /**
   * Ordered values used to break ties within the same HandRank.
   * Layout by rank:
   *   HighCard/Flush        → [c1, c2, c3, c4, c5] descending
   *   Pair                  → [pairRank, k1, k2, k3]
   *   TwoPair               → [highPair, lowPair, kicker]
   *   ThreeOfAKind          → [tripleRank, k1, k2]
   *   Straight/StraightFlush→ [highCard]  (wheel = 5)
   *   FullHouse             → [tripleRank, pairRank]
   *   FourOfAKind           → [quadRank, kicker]
   *   RoyalFlush            → [14]
   */
  tiebreakers: number[]
  cards: Card[]
}

const RANK_VALUES: Record<Rank, number> = {
  '2': 2,  '3': 3,  '4': 4,  '5': 5,  '6': 6,
  '7': 7,  '8': 8,  '9': 9,  '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14,
}

/** Positive → a beats b, negative → b beats a, 0 → tie. */
export function compareHands(a: HandResult, b: HandResult): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const diff = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function evaluate5(cards: Card[]): HandResult {
  const vals = cards.map(c => RANK_VALUES[c.rank]).sort((a, b) => b - a)
  const suits = cards.map(c => c.suit)

  const isFlush = suits.every(s => s === suits[0])

  const isNormalStraight = vals.every((v, i) => i === 0 || v === vals[i - 1] - 1)
  // Ace-low straight: A-2-3-4-5 sorts to [14,5,4,3,2]
  const isWheel =
    vals[0] === 14 && vals[1] === 5 && vals[2] === 4 && vals[3] === 3 && vals[4] === 2
  const isStraight = isNormalStraight || isWheel
  const straightHigh = isWheel ? 5 : vals[0]

  // Group by rank value; sort by frequency desc, then rank value desc
  const freq = new Map<number, number>()
  for (const v of vals) freq.set(v, (freq.get(v) ?? 0) + 1)
  const groups = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const counts   = groups.map(g => g[1])
  const groupVals = groups.map(g => g[0])

  if (isFlush && isStraight) {
    return straightHigh === 14
      ? { rank: HandRank.RoyalFlush,    tiebreakers: [14],           cards }
      : { rank: HandRank.StraightFlush, tiebreakers: [straightHigh], cards }
  }
  if (counts[0] === 4)                      return { rank: HandRank.FourOfAKind,   tiebreakers: groupVals,         cards }
  if (counts[0] === 3 && counts[1] === 2)   return { rank: HandRank.FullHouse,     tiebreakers: groupVals,         cards }
  if (isFlush)                              return { rank: HandRank.Flush,         tiebreakers: vals,              cards }
  if (isStraight)                           return { rank: HandRank.Straight,      tiebreakers: [straightHigh],    cards }
  if (counts[0] === 3)                      return { rank: HandRank.ThreeOfAKind,  tiebreakers: groupVals,         cards }
  if (counts[0] === 2 && counts[1] === 2)   return { rank: HandRank.TwoPair,       tiebreakers: groupVals,         cards }
  if (counts[0] === 2)                      return { rank: HandRank.Pair,          tiebreakers: groupVals,         cards }
  return                                           { rank: HandRank.HighCard,       tiebreakers: vals,              cards }
}

function combinations(cards: Card[], k: number): Card[][] {
  if (k === 0) return [[]]
  if (cards.length < k) return []
  const [head, ...tail] = cards
  return [
    ...combinations(tail, k - 1).map(combo => [head, ...combo]),
    ...combinations(tail, k),
  ]
}

/**
 * Evaluates the best 5-card Texas Hold'em hand from 5–7 cards.
 * The frontend must never call this — it belongs to the server engine only.
 */
export function evaluateBestHand(cards: Card[]): HandResult {
  if (cards.length < 5) {
    throw new Error(`evaluateBestHand requires at least 5 cards, received ${cards.length}`)
  }
  return combinations(cards, 5)
    .map(evaluate5)
    .reduce((best, curr) => (compareHands(curr, best) > 0 ? curr : best))
}
