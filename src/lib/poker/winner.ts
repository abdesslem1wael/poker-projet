import { Card } from './types'
import { HandRank, compareHands, evaluateBestHand } from './evaluator'
import { PlayerContribution, calculatePots } from './pot'

export interface ShowdownPlayer {
  playerId: string
  holeCards: [Card, Card]
  contributed: number
  hasFolded: boolean
}

export interface PotDistribution {
  amount: number
  eligiblePlayerIds: string[]
  winners: string[]        // tied winners, ordered by original input position
  winnerHandRank: HandRank
  perWinner: number        // chips each winner receives (floor division)
  remainder: number        // chips not evenly divisible (0 when pot splits cleanly)
}

export interface DistributionResult {
  pots: PotDistribution[]
  /**
   * Total chips received from all pots per player (non-negative).
   * Net change per player = chipDeltas[id] − player.contributed.
   * Invariant: Σ chipDeltas === Σ player.contributed (no chips created or lost).
   *
   * Remainder rule: when a pot cannot be divided evenly among tied winners,
   * the extra chip(s) are given one-per-winner to the winner(s) who appear
   * earliest in the original `players` input array.  This rule is deterministic
   * and position-independent (no reliance on seat numbers or random tiebreaks).
   */
  chipDeltas: Record<string, number>
}

export function distributeWinnings(
  communityCards: Card[],
  players: ShowdownPlayer[]
): DistributionResult {
  const chipDeltas: Record<string, number> = {}
  for (const pl of players) chipDeltas[pl.playerId] = 0

  const contributions: PlayerContribution[] = players.map(p => ({
    playerId: p.playerId,
    contributed: p.contributed,
    hasFolded: p.hasFolded,
  }))

  const pots = calculatePots(contributions)
  const playerMap = new Map(players.map(p => [p.playerId, p]))

  const potDistributions: PotDistribution[] = []

  for (const pot of pots) {
    const eligiblePlayers = pot.eligiblePlayerIds
      .map(id => playerMap.get(id))
      .filter((p): p is ShowdownPlayer => p !== undefined)

    // Degenerate case: pot has no claimants (shouldn't occur in valid play)
    if (eligiblePlayers.length === 0) {
      potDistributions.push({
        amount: pot.amount,
        eligiblePlayerIds: pot.eligiblePlayerIds,
        winners: [],
        winnerHandRank: HandRank.HighCard,
        perWinner: 0,
        remainder: pot.amount,
      })
      continue
    }

    // Evaluate every eligible player's best 5-card hand from 7
    const evaluated = eligiblePlayers.map(p => ({
      playerId: p.playerId,
      result: evaluateBestHand([...p.holeCards, ...communityCards]),
    }))

    // Find the single best result across all evaluated hands
    const best = evaluated.reduce((champion, challenger) =>
      compareHands(challenger.result, champion.result) > 0 ? challenger : champion
    )

    // Collect every player who matches the best hand exactly (ties)
    const winners = evaluated
      .filter(e => compareHands(e.result, best.result) === 0)
      .map(e => e.playerId)
      // Order by position in the original players array for deterministic remainder distribution
      .sort(
        (a, b) =>
          players.findIndex(p => p.playerId === a) -
          players.findIndex(p => p.playerId === b)
      )

    const perWinner = Math.floor(pot.amount / winners.length)
    const remainder = pot.amount % winners.length

    // First `remainder` winners each receive one extra chip
    for (let i = 0; i < winners.length; i++) {
      chipDeltas[winners[i]] += perWinner + (i < remainder ? 1 : 0)
    }

    potDistributions.push({
      amount: pot.amount,
      eligiblePlayerIds: pot.eligiblePlayerIds,
      winners,
      winnerHandRank: best.result.rank,
      perWinner,
      remainder,
    })
  }

  return { pots: potDistributions, chipDeltas }
}
