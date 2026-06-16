// Server-side only — never import from client code.
// Pure function: computes the showdown result from a completed hand snapshot.
// No side effects, no DB access — testable in isolation.
import { distributeWinnings } from '../poker/winner'
import { HandRank, evaluateBestHand } from '../poker/evaluator'
import type { HandEndedData } from './game-types'
import type { ShowdownPayload, ShowdownPotResult, ShowdownPlayerResult, Card as SocketCard } from './types'

const HAND_RANK_NAMES: Record<number, string> = {
  [HandRank.HighCard]:      'High Card',
  [HandRank.Pair]:          'Pair',
  [HandRank.TwoPair]:       'Two Pair',
  [HandRank.ThreeOfAKind]:  'Three of a Kind',
  [HandRank.Straight]:      'Straight',
  [HandRank.Flush]:         'Flush',
  [HandRank.FullHouse]:     'Full House',
  [HandRank.FourOfAKind]:   'Four of a Kind',
  [HandRank.StraightFlush]: 'Straight Flush',
  [HandRank.RoyalFlush]:    'Royal Flush',
}

export function computeShowdown(tableId: string, data: HandEndedData): ShowdownPayload {
  let chipDeltas: Record<string, number>
  let pots: ShowdownPotResult[]

  if (data.reason === 'all_folded') {
    const winner = data.players.find(p => !p.hasFolded)!
    chipDeltas = {}
    for (const p of data.players) chipDeltas[p.playerId] = 0
    chipDeltas[winner.playerId] = data.pot
    pots = [{
      amount: data.pot,
      winners: [winner.playerId],
      winnerHandRank: 0,
      winnerHandName: 'Last Standing',
    }]
  } else {
    // Full showdown: let the engine evaluate hands and split pots.
    const { pots: rawPots, chipDeltas: rawDeltas } = distributeWinnings(
      data.communityCards,
      data.players.map(p => ({
        playerId: p.playerId,
        holeCards: p.holeCards,
        contributed: p.totalContributed,
        hasFolded: p.hasFolded,
      })),
    )
    chipDeltas = rawDeltas
    pots = rawPots.map(pot => ({
      amount: pot.amount,
      winners: pot.winners,
      winnerHandRank: pot.winnerHandRank,
      winnerHandName: HAND_RANK_NAMES[pot.winnerHandRank] ?? 'Unknown',
    }))
  }

  // Deduct automatic tip from the main pot winner(s).
  if (data.tipAmount > 0 && pots.length > 0) {
    const mainWinners = pots[0].winners
    const tipPerWinner = Math.floor(data.tipAmount / mainWinners.length)
    for (const winnerId of mainWinners) {
      chipDeltas[winnerId] = Math.max(0, (chipDeltas[winnerId] ?? 0) - tipPerWinner)
    }
  }

  const players: ShowdownPlayerResult[] = data.players.map(p => {
    const delta = chipDeltas[p.playerId] ?? 0
    const revealsCards = data.reason === 'showdown' && !p.hasFolded
    const bestHandResult = revealsCards
      ? evaluateBestHand([...p.holeCards, ...data.communityCards])
      : null
    return {
      playerId: p.playerId,
      username: p.username,
      seatNumber: p.seatNumber,
      finalStack: p.stackAtEnd + delta,
      chipDelta: delta,
      netChipChange: delta - p.totalContributed,
      hasFolded: p.hasFolded,
      holeCards: revealsCards ? p.holeCards : null,
      bestHand: bestHandResult
        ? (bestHandResult.cards as unknown as [SocketCard, SocketCard, SocketCard, SocketCard, SocketCard])
        : null,
      handName: bestHandResult ? (HAND_RANK_NAMES[bestHandResult.rank] ?? null) : null,
    }
  })

  return {
    tableId,
    handNumber: data.handNumber,
    reason: data.reason,
    pots,
    players,
    communityCards: data.communityCards,
    tipAmount: data.tipAmount,
  }
}
