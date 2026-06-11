export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
export type Suit = (typeof SUITS)[number]

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const
export type Rank = (typeof RANKS)[number]

export interface Card {
  suit: Suit
  rank: Rank
}
