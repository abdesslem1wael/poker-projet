import { describe, it, expect, beforeEach } from 'vitest'
import { GameManager } from '../../src/lib/socket/game-manager'

const TABLE = 'table-test'
const P1 = 'player-1'
const P2 = 'player-2'
const SPECTATOR = 'spectator-99'
const SB = 5
const BB = 10

const seated2 = [
  { playerId: P1, username: 'Alice', seatNumber: 1 },
  { playerId: P2, username: 'Bob',   seatNumber: 2 },
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

describe('hole card privacy', () => {
  let gm: GameManager
  beforeEach(async () => {
    gm = new GameManager()
    await gm.startHand(TABLE, seated2, makeSupabase(), SB, BB)
  })

  it('returns null for a player not in the hand (spectator)', () => {
    expect(gm.getPlayerHoleCards(TABLE, SPECTATOR)).toBeNull()
  })

  it('returns null for an unknown table', () => {
    expect(gm.getPlayerHoleCards('no-such-table', P1)).toBeNull()
  })

  it('returns exactly 2 cards for a seated player', () => {
    const cards = gm.getPlayerHoleCards(TABLE, P1)
    expect(cards).not.toBeNull()
    expect(cards).toHaveLength(2)
  })

  it('each call returns the same cards (safe for reconnect re-fetch)', () => {
    const first  = gm.getPlayerHoleCards(TABLE, P1)
    const second = gm.getPlayerHoleCards(TABLE, P1)
    expect(first).toEqual(second)
  })

  it('P1 and P2 receive different hole cards', () => {
    const p1 = gm.getPlayerHoleCards(TABLE, P1)!
    const p2 = gm.getPlayerHoleCards(TABLE, P2)!
    const keyOf = (c: { rank: string; suit: string }) => `${c.rank}-${c.suit}`
    const p1Keys = new Set(p1.map(keyOf))
    for (const c of p2) {
      expect(p1Keys.has(keyOf(c))).toBe(false)
    }
  })

  it('public state never contains hole cards', () => {
    const pub = gm.getPublicHandState(TABLE)!
    for (const p of pub.players) {
      expect((p as Record<string, unknown>).holeCards).toBeUndefined()
    }
  })

  it('returns null after the hand ends', () => {
    // Play out the hand: P1 folds immediately (2-player: hand ends)
    gm.processAction(TABLE, P1, 'FOLD')
    expect(gm.getPlayerHoleCards(TABLE, P1)).toBeNull()
    expect(gm.getPlayerHoleCards(TABLE, P2)).toBeNull()
  })

  it('returns null before any hand has started', () => {
    const fresh = new GameManager()
    expect(fresh.getPlayerHoleCards(TABLE, P1)).toBeNull()
  })
})
