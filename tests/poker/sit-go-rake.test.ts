import { describe, it, expect, beforeEach } from 'vitest'
import { GameManager } from '../../src/lib/socket/game-manager'
import type { ActionResult } from '../../src/lib/socket/game-manager'

// ── Fixtures ───────────────────────────────────────────────────────────────

const P1 = 'player-1'
const P2 = 'player-2'
const P3 = 'player-3'
const TABLE = 'table-1'
const SB = 5
const BB = 10

const seated3 = [
  { playerId: P1, username: 'Alice', seatNumber: 1 },
  { playerId: P2, username: 'Bob', seatNumber: 2 },
  { playerId: P3, username: 'Charlie', seatNumber: 3 },
]

function makeSupabase(stacks: Record<string, number> = {}) {
  const defaultStack = 1000
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        in: (_col: string, ids: string[]) =>
          Promise.resolve({
            data: ids.map(id => ({ user_id: id, chips: stacks[id] ?? defaultStack })),
            error: null,
          }),
      }),
    }),
  }
}

// Drives a hand to the exact condition that earns automatic rake — a
// voluntary raise matched by >= 2 players — then folds it closed so the
// resulting tipAmount can be read straight off the handEnded payload.
async function playRakeEligibleHand(gm: GameManager, rakeEnabled?: boolean): Promise<number> {
  await gm.startHand(TABLE, seated3, makeSupabase(), SB, BB, undefined, rakeEnabled)

  // P1(UTG) raises to 30, P2(SB) calls (both land on roundContribution=30 —
  // the >=2 condition), P3(BB) folds. That completes the preflop round.
  gm.processAction(TABLE, P1, 'RAISE', 30)
  gm.processAction(TABLE, P2, 'CALL')
  gm.processAction(TABLE, P3, 'FOLD')

  // Two players remain on the flop — fold whoever's turn it is to end the
  // hand immediately.
  const nextActor = gm.getPublicHandState(TABLE)!.currentTurnPlayerId!
  const res: ActionResult = gm.processAction(TABLE, nextActor, 'FOLD')
  if (!('handEnded' in res) || !res.handEnded) throw new Error('Expected hand to end')
  return res.data.tipAmount
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('automatic rake — cash vs Sit & Go', () => {
  let gm: GameManager
  beforeEach(() => {
    gm = new GameManager()
  })

  it('collects rake by default (cash games — rakeEnabled defaults to true)', async () => {
    const tipAmount = await playRakeEligibleHand(gm)
    expect(tipAmount).toBeGreaterThan(0)
  })

  it('collects rake when rakeEnabled is explicitly true', async () => {
    const tipAmount = await playRakeEligibleHand(gm, true)
    expect(tipAmount).toBeGreaterThan(0)
  })

  it('collects zero rake for Sit & Go hands (rakeEnabled false) even though the raise/call pattern qualifies', async () => {
    const tipAmount = await playRakeEligibleHand(gm, false)
    expect(tipAmount).toBe(0)
  })
})
