import { describe, it, expect, beforeEach } from 'vitest'
import { GameManager } from '../../src/lib/socket/game-manager'

// ── Test fixtures ──────────────────────────────────────────────────────────

const P1 = 'player-1'
const P2 = 'player-2'
const P3 = 'player-3'
const TABLE = 'table-1'
const SB = 5
const BB = 10

const seated2 = [
  { playerId: P1, username: 'Alice', seatNumber: 1 },
  { playerId: P2, username: 'Bob',   seatNumber: 2 },
]

const seated3 = [
  { playerId: P1, username: 'Alice',   seatNumber: 1 },
  { playerId: P2, username: 'Bob',     seatNumber: 2 },
  { playerId: P3, username: 'Charlie', seatNumber: 3 },
]

// Minimal Supabase mock that returns wallet stacks.
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

// ── Helpers ────────────────────────────────────────────────────────────────

function cardKey(c: { suit: string; rank: string }) {
  return `${c.rank}-${c.suit}`
}

async function startHand2(gm: GameManager, supabase = makeSupabase()) {
  return gm.startHand(TABLE, seated2, supabase, SB, BB)
}

async function startHand3(gm: GameManager, supabase = makeSupabase()) {
  return gm.startHand(TABLE, seated3, supabase, SB, BB)
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('startHand', () => {
  let gm: GameManager
  beforeEach(() => { gm = new GameManager() })

  it('rejects fewer than 2 players', async () => {
    const res = await gm.startHand(TABLE, [seated2[0]], makeSupabase(), SB, BB)
    expect(res).toHaveProperty('error')
  })

  it('rejects a player with 0 chips', async () => {
    const res = await gm.startHand(TABLE, seated2, makeSupabase({ [P1]: 0 }), SB, BB)
    expect(res).toHaveProperty('error')
  })

  it('returns ok for a valid 2-player hand', async () => {
    expect(await startHand2(gm)).toEqual({ ok: true })
  })

  it('each seated player gets exactly 2 hole cards', async () => {
    await startHand3(gm)
    const state = gm.getPublicHandState(TABLE)!
    for (const p of state.players) {
      const cards = gm.getPlayerHoleCards(TABLE, p.playerId)
      expect(cards).toHaveLength(2)
    }
  })

  it('no duplicate hole cards across all players', async () => {
    await startHand3(gm)
    const allCards = seated3
      .flatMap(p => gm.getPlayerHoleCards(TABLE, p.playerId) ?? [])
    const keys = allCards.map(cardKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('public state does not expose hole cards', async () => {
    await startHand2(gm)
    const state = gm.getPublicHandState(TABLE)!
    for (const p of state.players) {
      expect((p as Record<string, unknown>).holeCards).toBeUndefined()
    }
  })

  it('posts small and big blinds correctly (2 players)', async () => {
    await startHand2(gm)
    const state = gm.getPublicHandState(TABLE)!

    // Heads-up: SB = dealer = P1, BB = P2.
    const sb = state.players.find(p => p.seatNumber === state.smallBlindSeatNumber)!
    const bb = state.players.find(p => p.seatNumber === state.bigBlindSeatNumber)!

    expect(sb.roundContribution).toBe(SB)
    expect(sb.totalContributed).toBe(SB)
    expect(sb.stack).toBe(1000 - SB)

    expect(bb.roundContribution).toBe(BB)
    expect(bb.totalContributed).toBe(BB)
    expect(bb.stack).toBe(1000 - BB)

    expect(state.pot).toBe(SB + BB)
    expect(state.currentBet).toBe(BB)
    expect(state.phase).toBe('PRE_FLOP')
  })

  it('posts blinds correctly (3 players)', async () => {
    await startHand3(gm)
    const state = gm.getPublicHandState(TABLE)!

    const sb = state.players.find(p => p.seatNumber === state.smallBlindSeatNumber)!
    const bb = state.players.find(p => p.seatNumber === state.bigBlindSeatNumber)!

    expect(sb.roundContribution).toBe(SB)
    expect(bb.roundContribution).toBe(BB)
    expect(state.pot).toBe(SB + BB)
  })

  it('sets first actor correctly (2-player heads-up: SB acts first)', async () => {
    await startHand2(gm)
    const state = gm.getPublicHandState(TABLE)!
    // Heads-up: dealer = SB = seat 1 = P1 (first hand, dealer index 0).
    expect(state.currentTurnPlayerId).toBe(P1)
  })

  it('sets first actor correctly (3 players: UTG = player after BB)', async () => {
    await startHand3(gm)
    const state = gm.getPublicHandState(TABLE)!
    // First hand: dealer=seat1(P1), SB=seat2(P2), BB=seat3(P3), UTG=seat1(P1).
    expect(state.currentTurnPlayerId).toBe(P1)
  })

  it('starts with PRE_FLOP phase', async () => {
    await startHand2(gm)
    expect(gm.getPublicHandState(TABLE)!.phase).toBe('PRE_FLOP')
  })

  it('community cards are empty at start', async () => {
    await startHand2(gm)
    expect(gm.getPublicHandState(TABLE)!.communityCards).toHaveLength(0)
  })
})

describe('processAction', () => {
  let gm: GameManager
  beforeEach(() => {
    gm = new GameManager()
  })

  it('rejects action when no hand is active', () => {
    expect(gm.processAction(TABLE, P1, 'FOLD')).toHaveProperty('error')
  })

  it('rejects action from wrong player (out of turn)', async () => {
    await startHand2(gm) // P1 acts first
    const res = gm.processAction(TABLE, P2, 'FOLD')
    expect(res).toHaveProperty('error')
  })

  it('FOLD removes player from hand', async () => {
    await startHand3(gm) // P1 is UTG and acts first
    const res = gm.processAction(TABLE, P1, 'FOLD')
    expect(res).toEqual({ ok: true })
    const state = gm.getPublicHandState(TABLE)!
    const p1State = state.players.find(p => p.playerId === P1)!
    expect(p1State.playerPhase).toBe('folded')
  })

  it('FOLD with only 2 players ends the hand', async () => {
    await startHand2(gm)
    const res = gm.processAction(TABLE, P1, 'FOLD')
    expect(res).toMatchObject({ ok: true, handEnded: true, data: { reason: 'all_folded' } })
    expect(gm.getPublicHandState(TABLE)).toBeNull()
  })

  it('CHECK fails when there is a bet to call', async () => {
    await startHand3(gm) // currentBet=BB=10, P1.roundContribution=0
    const res = gm.processAction(TABLE, P1, 'CHECK')
    expect(res).toHaveProperty('error')
  })

  it('BB can CHECK after everyone calls (BB option)', async () => {
    await startHand3(gm)
    // P1(UTG) calls, P2(SB) calls, P3(BB) checks.
    gm.processAction(TABLE, P1, 'CALL')
    gm.processAction(TABLE, P2, 'CALL')
    const res = gm.processAction(TABLE, P3, 'CHECK')
    expect(res).toEqual({ ok: true })
  })

  it('CALL deducts correct amount and updates pot', async () => {
    await startHand3(gm)
    // P1 is UTG, roundContribution=0, needs to call BB=10.
    gm.processAction(TABLE, P1, 'CALL')
    const state = gm.getPublicHandState(TABLE)!
    const p1 = state.players.find(p => p.playerId === P1)!
    expect(p1.roundContribution).toBe(BB)
    expect(p1.stack).toBe(1000 - BB)
    expect(state.pot).toBe(SB + BB + BB) // SB(5) + BB(10) + P1 call(10)
  })

  it('CALL rejects when nothing to call', async () => {
    await startHand3(gm)
    // Give P3(BB) the turn and try to CALL when roundContribution == currentBet.
    gm.processAction(TABLE, P1, 'CALL') // UTG calls
    gm.processAction(TABLE, P2, 'CALL') // SB calls
    // Now P3(BB) has roundContribution=10 == currentBet=10 → CALL invalid.
    const res = gm.processAction(TABLE, P3, 'CALL')
    expect(res).toHaveProperty('error')
  })

  it('RAISE updates currentBet, minRaise, and pot', async () => {
    await startHand3(gm)
    // P1(UTG) raises to 30: raiseBy=20 >= minRaise(10).
    const res = gm.processAction(TABLE, P1, 'RAISE', 30)
    expect(res).toEqual({ ok: true })
    const state = gm.getPublicHandState(TABLE)!
    expect(state.currentBet).toBe(30)
    expect(state.minRaise).toBe(20)
    const p1 = state.players.find(p => p.playerId === P1)!
    expect(p1.roundContribution).toBe(30)
    expect(state.pot).toBe(SB + BB + 30) // 5+10+30=45
  })

  it('RAISE rejects raise below minimum', async () => {
    await startHand3(gm)
    // minRaise=10, currentBet=10; raising to 15 means raiseBy=5 < 10.
    const res = gm.processAction(TABLE, P1, 'RAISE', 15)
    expect(res).toHaveProperty('error')
  })

  it('RAISE resets hasActedThisRound for other active players', async () => {
    await startHand3(gm)
    gm.processAction(TABLE, P1, 'CALL')
    gm.processAction(TABLE, P2, 'CALL')
    // P3(BB) acts next; at this point P1 and P2 have acted.
    gm.processAction(TABLE, P3, 'RAISE', 30)
    // Now P1 and P2 must act again.
    const state = gm.getPublicHandState(TABLE)!
    const p1 = state.players.find(p => p.playerId === P1)!
    const p2 = state.players.find(p => p.playerId === P2)!
    expect(p1.hasActedThisRound).toBe(false)
    expect(p2.hasActedThisRound).toBe(false)
  })

  it('ALL_IN sets player status to all-in', async () => {
    await startHand3(gm)
    const res = gm.processAction(TABLE, P1, 'ALL_IN')
    expect(res).toEqual({ ok: true })
    const state = gm.getPublicHandState(TABLE)!
    const p1 = state.players.find(p => p.playerId === P1)!
    expect(p1.playerPhase).toBe('all-in')
    expect(p1.stack).toBe(0)
  })

  it('folded players are skipped when advancing turn', async () => {
    await startHand3(gm)
    // P1 folds, turn goes to P2.
    gm.processAction(TABLE, P1, 'FOLD')
    const state = gm.getPublicHandState(TABLE)!
    expect(state.currentTurnPlayerId).toBe(P2)
  })

  it('all-in players are skipped when advancing turn', async () => {
    await startHand3(gm)
    // P1 goes all-in, turn goes to P2 (next active).
    gm.processAction(TABLE, P1, 'ALL_IN')
    const state = gm.getPublicHandState(TABLE)!
    expect(state.currentTurnPlayerId).toBe(P2)
  })

  it('pot contributions update correctly across multiple actions', async () => {
    await startHand3(gm)
    gm.processAction(TABLE, P1, 'CALL')  // +10
    gm.processAction(TABLE, P2, 'CALL')  // +5 (SB posted 5, needs 5 more)
    gm.processAction(TABLE, P3, 'CHECK') // no change (BB already matched)
    const state = gm.getPublicHandState(TABLE)!
    // pot = SB(5) + BB(10) + P1call(10) + P2extra(5) = 30
    expect(state.pot).toBe(30)
  })

  it('advances to FLOP after PRE_FLOP betting completes', async () => {
    await startHand2(gm)
    // Heads-up: P1(SB/dealer) acts first, P2(BB).
    gm.processAction(TABLE, P1, 'CALL')  // P1 calls BB
    gm.processAction(TABLE, P2, 'CHECK') // BB checks → round done
    const state = gm.getPublicHandState(TABLE)!
    expect(state.phase).toBe('FLOP')
    expect(state.communityCards).toHaveLength(3)
  })

  it('advances through all streets when everyone is all-in (runout path)', async () => {
    await startHand2(gm)
    gm.processAction(TABLE, P1, 'ALL_IN')
    // P2 calls all-in → both all-in → server must deal remaining streets via dealNextRunoutStreet.
    const res = gm.processAction(TABLE, P2, 'ALL_IN')
    expect(res).toMatchObject({ ok: true, runout: true })
    // FLOP already dealt (3 cards visible).
    expect(gm.getPublicHandState(TABLE)?.communityCards).toHaveLength(3)
    // Deal TURN.
    const turnRes = gm.dealNextRunoutStreet(TABLE)
    expect(turnRes).toMatchObject({ ok: true, handEnded: false, phase: 'TURN' })
    // Deal RIVER.
    const riverRes = gm.dealNextRunoutStreet(TABLE)
    expect(riverRes).toMatchObject({ ok: true, handEnded: false, phase: 'RIVER' })
    // End hand.
    const endRes = gm.dealNextRunoutStreet(TABLE)
    expect(endRes).toMatchObject({ ok: true, handEnded: true, data: { reason: 'showdown' } })
    expect(gm.getPublicHandState(TABLE)).toBeNull()
  })

  it('HandEndedData includes players, hole cards, pot, and community cards', async () => {
    await startHand2(gm)
    gm.processAction(TABLE, P1, 'ALL_IN')
    gm.processAction(TABLE, P2, 'ALL_IN')
    // Deal remaining streets via runout path.
    gm.dealNextRunoutStreet(TABLE)  // TURN
    gm.dealNextRunoutStreet(TABLE)  // RIVER
    const endRes = gm.dealNextRunoutStreet(TABLE)
    if (!('handEnded' in endRes) || !endRes.handEnded) throw new Error('Expected hand to end')
    const { data } = endRes
    expect(data.players).toHaveLength(2)
    expect(data.pot).toBeGreaterThan(0)
    expect(data.communityCards).toHaveLength(5)
    for (const p of data.players) {
      expect(p.holeCards).toHaveLength(2)
      expect(p.totalContributed).toBeGreaterThan(0)
    }
    // Chip conservation: sum(finalStacks) == sum(initialStacks)
    const sumInitial = data.players.reduce((s, p) => s + p.stackAtEnd + p.totalContributed, 0)
    expect(sumInitial).toBe(2000) // 2 players × 1000 default stack
  })

  it('no duplicate cards in hole cards + community cards (post-flop)', async () => {
    await startHand2(gm)
    gm.processAction(TABLE, P1, 'CALL')
    gm.processAction(TABLE, P2, 'CHECK')
    const state = gm.getPublicHandState(TABLE)!
    expect(state.phase).toBe('FLOP')

    const p1Cards = gm.getPlayerHoleCards(TABLE, P1) ?? []
    const p2Cards = gm.getPlayerHoleCards(TABLE, P2) ?? []
    const allCards = [...p1Cards, ...p2Cards, ...state.communityCards]
    const keys = allCards.map(cardKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('cash sit-out mode', () => {
  let gm: GameManager
  beforeEach(() => { gm = new GameManager() })

  it('marks players from sittingOutPlayerIds as sitting out, others not', async () => {
    await gm.startHand(TABLE, seated3, makeSupabase(), SB, BB, undefined, true, new Set([P2]))
    expect(gm.isPlayerSittingOut(TABLE, P2)).toBe(true)
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
    expect(gm.isPlayerSittingOut(TABLE, P3)).toBe(false)
  })

  it('isPlayerSittingOut is false when no hand is active', () => {
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
  })

  it('never reports sitting out for a Sit & Go hand (rakeEnabled false), even if requested', async () => {
    await gm.startHand(TABLE, seated3, makeSupabase(), SB, BB, undefined, false, new Set([P1]))
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
  })

  it('isCashGame reflects rakeEnabled for the active hand', async () => {
    await gm.startHand(TABLE, seated2, makeSupabase(), SB, BB, undefined, true)
    expect(gm.isCashGame(TABLE)).toBe(true)
  })

  it('isCashGame is false for a Sit & Go hand', async () => {
    await gm.startHand(TABLE, seated2, makeSupabase(), SB, BB, undefined, false)
    expect(gm.isCashGame(TABLE)).toBe(false)
  })

  it('isCashGame is false when no hand is active', () => {
    expect(gm.isCashGame(TABLE)).toBe(false)
  })

  it('setSittingOut(true) marks a player mid-hand (timeout path)', async () => {
    await startHand3(gm)
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
    gm.setSittingOut(TABLE, P1, true)
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(true)
  })

  it('setSittingOut(false) clears sitting-out mid-hand (rejoin path)', async () => {
    await gm.startHand(TABLE, seated3, makeSupabase(), SB, BB, undefined, true, new Set([P1]))
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(true)
    gm.setSittingOut(TABLE, P1, false)
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
  })

  it('setSittingOut is a no-op when no hand is active', () => {
    expect(() => gm.setSittingOut(TABLE, P1, true)).not.toThrow()
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
  })

  it('a manual FOLD never sets sittingOut', async () => {
    await startHand3(gm) // P1 (UTG) acts first
    gm.processAction(TABLE, P1, 'FOLD')
    expect(gm.isPlayerSittingOut(TABLE, P1)).toBe(false)
  })

  it('a sitting-out player is still dealt cards and posts blinds normally', async () => {
    // seated3, first hand: dealer=seat1(P1), SB=seat2(P2), BB=seat3(P3).
    await gm.startHand(TABLE, seated3, makeSupabase(), SB, BB, undefined, true, new Set([P2]))
    expect(gm.getPlayerHoleCards(TABLE, P2)).toHaveLength(2)
    const state = gm.getPublicHandState(TABLE)!
    const p2 = state.players.find(p => p.playerId === P2)!
    expect(p2.roundContribution).toBe(SB)
  })
})
