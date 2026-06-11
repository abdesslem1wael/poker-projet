export interface PlayerContribution {
  playerId: string
  contributed: number   // total chips this player has committed to the pot
  hasFolded: boolean
}

export interface Pot {
  amount: number
  eligiblePlayerIds: string[]   // players who may win this pot (sorted)
}

/**
 * Calculates the main pot and any side pots from player contributions.
 *
 * Algorithm:
 *   1. Collect the unique contribution levels in ascending order.
 *   2. For each level, compute the chips each player contributes to that
 *      tier (capped at the level, minus the previous level).
 *   3. Eligible players are those who contributed at least the cap AND
 *      have not folded.
 *   4. Merge adjacent pots that share the same eligible player set
 *      (e.g. a folded short-stack creates a raw boundary that is
 *      indistinguishable from the pot above it for live players).
 *
 * Invariant: sum of output pot amounts === sum of input contributions.
 */
export function calculatePots(players: PlayerContribution[]): Pot[] {
  if (players.length === 0) return []

  // Unique cap levels, ascending, zero is not a real level
  const levels = [...new Set(players.map(p => p.contributed))]
    .filter(v => v > 0)
    .sort((a, b) => a - b)

  if (levels.length === 0) return []

  const raw: Pot[] = []
  let prevCap = 0

  for (const cap of levels) {
    // Chips flowing into this tier from every player
    let amount = 0
    for (const p of players) {
      amount += Math.min(p.contributed, cap) - Math.min(p.contributed, prevCap)
    }

    if (amount > 0) {
      const eligiblePlayerIds = players
        .filter(p => !p.hasFolded && p.contributed >= cap)
        .map(p => p.playerId)
        .sort()

      raw.push({ amount, eligiblePlayerIds })
    }

    prevCap = cap
  }

  return mergeAdjacentSameEligible(raw)
}

// Combine consecutive pots whose eligible sets are identical.
// This collapses the artificial boundary a folded player's lower
// contribution creates between two otherwise-identical pots.
function mergeAdjacentSameEligible(pots: Pot[]): Pot[] {
  if (pots.length === 0) return []

  const result: Pot[] = [{
    amount: pots[0].amount,
    eligiblePlayerIds: pots[0].eligiblePlayerIds,
  }]

  for (let i = 1; i < pots.length; i++) {
    const last = result[result.length - 1]
    if (sameSet(last.eligiblePlayerIds, pots[i].eligiblePlayerIds)) {
      last.amount += pots[i].amount
    } else {
      result.push({ amount: pots[i].amount, eligiblePlayerIds: pots[i].eligiblePlayerIds })
    }
  }

  return result
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every(id => setA.has(id))
}
