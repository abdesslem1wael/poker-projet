import { describe, it, expect } from 'vitest'
import { calculatePots } from '../../src/lib/poker/pot'
import type { PlayerContribution } from '../../src/lib/poker/pot'

function p(playerId: string, contributed: number, hasFolded = false): PlayerContribution {
  return { playerId, contributed, hasFolded }
}

function sumPots(pots: ReturnType<typeof calculatePots>): number {
  return pots.reduce((acc, pot) => acc + pot.amount, 0)
}

function sumContributions(players: PlayerContribution[]): number {
  return players.reduce((acc, pl) => acc + pl.contributed, 0)
}

// ---------------------------------------------------------------------------
// 1. Simple heads-up pot
// ---------------------------------------------------------------------------
describe('calculatePots — simple heads-up pot', () => {
  it('creates one pot containing both players at the correct amount', () => {
    const pots = calculatePots([p('p1', 50), p('p2', 50)])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(100)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2'])
  })
})

// ---------------------------------------------------------------------------
// 2. Three players equal contribution
// ---------------------------------------------------------------------------
describe('calculatePots — three players, equal contributions', () => {
  it('creates one pot with all three players eligible', () => {
    const pots = calculatePots([p('p1', 30), p('p2', 30), p('p3', 30)])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(90)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3'])
  })
})

// ---------------------------------------------------------------------------
// 3. One short-stack all-in → main pot + one side pot
// ---------------------------------------------------------------------------
describe('calculatePots — one short-stack all-in', () => {
  it('creates a main pot all three can win and a side pot only two can win', () => {
    const pots = calculatePots([
      p('p1', 10),   // all-in
      p('p2', 50),
      p('p3', 50),
    ])
    expect(pots).toHaveLength(2)

    const [main, side] = pots
    expect(main.amount).toBe(30)                              // 10 × 3
    expect(main.eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3'])

    expect(side.amount).toBe(80)                              // 40 × 2
    expect(side.eligiblePlayerIds.sort()).toEqual(['p2', 'p3'])
    expect(side.eligiblePlayerIds).not.toContain('p1')
  })

  it('total pot equals total contributions', () => {
    const players = [p('p1', 10), p('p2', 50), p('p3', 50)]
    expect(sumPots(calculatePots(players))).toBe(sumContributions(players))
  })
})

// ---------------------------------------------------------------------------
// 4. Multiple all-ins → multiple side pots
// ---------------------------------------------------------------------------
describe('calculatePots — multiple all-in players', () => {
  it('creates a separate pot tier for each distinct all-in level', () => {
    const pots = calculatePots([
      p('p1', 10),    // smallest stack
      p('p2', 20),
      p('p3', 40),
      p('p4', 100),   // deepest stack
    ])
    expect(pots).toHaveLength(4)

    // Tier 1: 10 × 4 = 40 — all four eligible
    expect(pots[0].amount).toBe(40)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4'])

    // Tier 2: 10 × 3 = 30 — p2, p3, p4 eligible (p1 capped out)
    expect(pots[1].amount).toBe(30)
    expect(pots[1].eligiblePlayerIds.sort()).toEqual(['p2', 'p3', 'p4'])

    // Tier 3: 20 × 2 = 40 — p3, p4 eligible
    expect(pots[2].amount).toBe(40)
    expect(pots[2].eligiblePlayerIds.sort()).toEqual(['p3', 'p4'])

    // Tier 4: 60 × 1 = 60 — only p4 eligible
    expect(pots[3].amount).toBe(60)
    expect(pots[3].eligiblePlayerIds).toEqual(['p4'])
  })

  it('total equals sum of all contributions', () => {
    const players = [p('p1', 10), p('p2', 20), p('p3', 40), p('p4', 100)]
    expect(sumPots(calculatePots(players))).toBe(sumContributions(players))
  })

  it('two players all-in at the same level produce one shared tier', () => {
    // p1 and p2 both all-in at 20; p3 active at 60
    const pots = calculatePots([p('p1', 20), p('p2', 20), p('p3', 60)])
    expect(pots).toHaveLength(2)
    expect(pots[0].amount).toBe(60)   // 20 × 3
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p3'])
    expect(pots[1].amount).toBe(40)   // 40 × 1
    expect(pots[1].eligiblePlayerIds).toEqual(['p3'])
  })
})

// ---------------------------------------------------------------------------
// 5. Folded player contributes chips but is not eligible to win
// ---------------------------------------------------------------------------
describe('calculatePots — folded player', () => {
  it('chips from a folded player go into the pot but the player is excluded', () => {
    const pots = calculatePots([
      p('p1', 20, true),  // folded
      p('p2', 20),
      p('p3', 20),
    ])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(60)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p2', 'p3'])
    expect(pots[0].eligiblePlayerIds).not.toContain('p1')
  })

  it('folded short-stack chips merge into the pot the remaining players contest', () => {
    // p1 folded with 10 chips in; p2 all-in at 20; p3 active at 50
    const pots = calculatePots([
      p('p1', 10, true),  // folded
      p('p2', 20),        // all-in
      p('p3', 50),
    ])
    // Raw tiers: [30,[p2,p3]] + [20,[p2,p3]] merge → [50,[p2,p3]], then [30,[p3]]
    expect(pots).toHaveLength(2)
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p2', 'p3'])
    expect(pots[1].eligiblePlayerIds).toEqual(['p3'])
    expect(pots[0].eligiblePlayerIds).not.toContain('p1')
    expect(pots[1].eligiblePlayerIds).not.toContain('p1')
  })

  it('a folded player who is also all-in is eligible for no pot', () => {
    const pots = calculatePots([
      p('p1', 30, true),  // folded all-in
      p('p2', 50),
      p('p3', 50),
    ])
    for (const pot of pots) {
      expect(pot.eligiblePlayerIds).not.toContain('p1')
    }
  })
})

// ---------------------------------------------------------------------------
// 6. No chip loss — total pot amount always equals total contributions
// ---------------------------------------------------------------------------
describe('calculatePots — no chip loss invariant', () => {
  it('holds for a complex multi-all-in scenario with a folded player', () => {
    const players = [
      p('p1',  5, true),   // folded early
      p('p2', 15),
      p('p3', 30),
      p('p4', 30),
      p('p5', 75),
    ]
    expect(sumPots(calculatePots(players))).toBe(sumContributions(players))
  })

  it('holds for a simple three-way equal pot', () => {
    const players = [p('p1', 100), p('p2', 100), p('p3', 100)]
    expect(sumPots(calculatePots(players))).toBe(300)
  })

  it('holds when every player folds except one', () => {
    const players = [
      p('p1', 40, true),
      p('p2', 40, true),
      p('p3', 40),
    ]
    expect(sumPots(calculatePots(players))).toBe(sumContributions(players))
  })
})

// ---------------------------------------------------------------------------
// 7. Zero contribution does not create fake pots
// ---------------------------------------------------------------------------
describe('calculatePots — zero contribution players', () => {
  it('does not create a pot entry for a player who contributed nothing', () => {
    const pots = calculatePots([p('p1', 0), p('p2', 50), p('p3', 50)])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(100)
    expect(pots[0].eligiblePlayerIds).not.toContain('p1')
  })

  it('returns an empty array when all contributions are zero', () => {
    expect(calculatePots([p('p1', 0), p('p2', 0)])).toHaveLength(0)
  })

  it('returns an empty array for an empty player list', () => {
    expect(calculatePots([])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Eligibility is correct in every scenario
// ---------------------------------------------------------------------------
describe('calculatePots — eligibility correctness', () => {
  it('all-in player is in the main pot but not the side pot', () => {
    const pots = calculatePots([
      p('p1', 20),    // all-in
      p('p2', 100),
      p('p3', 100),
    ])
    expect(pots[0].eligiblePlayerIds).toContain('p1')
    expect(pots[1].eligiblePlayerIds).not.toContain('p1')
  })

  it('when all others fold, the last active player is sole winner of full pot', () => {
    const pots = calculatePots([
      p('p1', 50, true),
      p('p2', 50, true),
      p('p3', 50),
    ])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(150)
    expect(pots[0].eligiblePlayerIds).toEqual(['p3'])
  })

  it('each pot tier contains exactly the players who covered that level and stayed in', () => {
    const pots = calculatePots([
      p('p1', 10),
      p('p2', 30),
      p('p3', 30, true),  // folded at 30
      p('p4', 60),
    ])

    // Tier 10×4=40: everyone covered 10; p3 folded → eligible [p1,p2,p4]
    expect(pots[0].eligiblePlayerIds.sort()).toEqual(['p1', 'p2', 'p4'])

    // p1 capped at 10; next tiers only [p2,p4] (p3 folded)
    // verify p1 not in any subsequent pot
    for (let i = 1; i < pots.length; i++) {
      expect(pots[i].eligiblePlayerIds).not.toContain('p1')
      expect(pots[i].eligiblePlayerIds).not.toContain('p3')
    }
  })

  it('total contributions equal total pots in every tier scenario', () => {
    const players = [
      p('p1', 10),
      p('p2', 30),
      p('p3', 30, true),
      p('p4', 60),
    ]
    expect(sumPots(calculatePots(players))).toBe(sumContributions(players))
  })
})
