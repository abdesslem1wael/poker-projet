import { describe, it, expect, beforeEach } from 'vitest'
import { GameManager } from '../../src/lib/socket/game-manager'
import { isEligibleForAdminCardView } from '../../src/lib/socket/admin-card-view'

const TABLE = 'table-test'
const OTHER_TABLE = 'table-other'
const P1 = 'player-1'
const P2 = 'player-2'
const P3 = 'player-3'
const SPECTATOR = 'spectator-99'
const SB = 5
const BB = 10

const seated3 = [
  { playerId: P1, username: 'Alice', seatNumber: 1 },
  { playerId: P2, username: 'Bob',   seatNumber: 2 },
  { playerId: P3, username: 'Carl',  seatNumber: 3 },
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

describe('admin card view — GameManager data', () => {
  let gm: GameManager
  beforeEach(async () => {
    gm = new GameManager()
    await gm.startHand(TABLE, seated3, makeSupabase(), SB, BB)
  })

  it('returns every seated player, including a folded one', () => {
    // Dealer (P1, seat 1) acts first pre-flop in a 3-handed hand.
    gm.processAction(TABLE, P1, 'FOLD')
    const hands = gm.getAllHoleCardsForAdmin(TABLE)
    const ids = hands.map(h => h.playerId).sort()
    expect(ids).toEqual([P1, P2, P3].sort())
  })

  it('each entry has exactly 2 cards', () => {
    const hands = gm.getAllHoleCardsForAdmin(TABLE)
    for (const h of hands) expect(h.cards).toHaveLength(2)
  })

  it('matches what each player individually receives via getPlayerHoleCards', () => {
    const hands = gm.getAllHoleCardsForAdmin(TABLE)
    for (const playerId of [P1, P2, P3]) {
      const solo = gm.getPlayerHoleCards(TABLE, playerId)
      const fromAdminView = hands.find(h => h.playerId === playerId)?.cards
      expect(fromAdminView).toEqual(solo)
    }
  })

  it('is empty for a spectator-only lookup — spectators are simply absent from the hand', () => {
    const hands = gm.getAllHoleCardsForAdmin(TABLE)
    expect(hands.some(h => h.playerId === SPECTATOR)).toBe(false)
  })

  it('is empty for an unknown table', () => {
    expect(gm.getAllHoleCardsForAdmin('no-such-table')).toEqual([])
  })

  it('returns nothing once the hand has ended', () => {
    gm.processAction(TABLE, P1, 'FOLD') // dealer acts first
    gm.processAction(TABLE, P2, 'FOLD') // only P3 left standing — hand ends
    expect(gm.getAllHoleCardsForAdmin(TABLE)).toEqual([])
  })

  it('is stable across repeated calls (safe to resend on reconnect)', () => {
    const first = gm.getAllHoleCardsForAdmin(TABLE)
    const second = gm.getAllHoleCardsForAdmin(TABLE)
    expect(first).toEqual(second)
  })

  it('the public hand state never carries the admin hole-card data', () => {
    const pub = gm.getPublicHandState(TABLE)!
    for (const p of pub.players) {
      expect((p as unknown as { holeCards?: unknown }).holeCards).toBeUndefined()
    }
    expect(JSON.stringify(pub).includes('"holeCards"')).toBe(false)
  })
})

describe('admin card view — eligibility targeting', () => {
  it('an admin not seated at the table is eligible', () => {
    expect(isEligibleForAdminCardView({ role: 'admin', seatedAtTables: new Set() }, TABLE)).toBe(true)
  })

  it('a super_admin not seated at the table is eligible', () => {
    expect(isEligibleForAdminCardView({ role: 'super_admin', seatedAtTables: new Set() }, TABLE)).toBe(true)
  })

  it('an admin seated as a player AT THIS TABLE is not eligible', () => {
    expect(isEligibleForAdminCardView({ role: 'admin', seatedAtTables: new Set([TABLE]) }, TABLE)).toBe(false)
  })

  it('an admin seated at a different table is still eligible for this one', () => {
    expect(isEligibleForAdminCardView({ role: 'admin', seatedAtTables: new Set([OTHER_TABLE]) }, TABLE)).toBe(true)
  })

  it('a regular player is never eligible, even though they are not "seated" per this flag set', () => {
    expect(isEligibleForAdminCardView({ role: 'player', seatedAtTables: new Set() }, TABLE)).toBe(false)
  })

  it('a spectator (non-admin role) is never eligible', () => {
    expect(isEligibleForAdminCardView({ role: 'spectator', seatedAtTables: new Set() }, TABLE)).toBe(false)
  })

  it('is deterministic across repeated calls with the same input (safe for reconnect resend)', () => {
    const socket = { role: 'admin', seatedAtTables: new Set<string>() }
    expect(isEligibleForAdminCardView(socket, TABLE)).toBe(isEligibleForAdminCardView(socket, TABLE))
  })
})
