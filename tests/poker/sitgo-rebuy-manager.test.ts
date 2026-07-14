import { describe, it, expect, beforeEach } from 'vitest'
import { SitGoRebuyManager, SIT_GO_REBUY_DECISION_MS } from '../../src/lib/socket/sitgo-rebuy-manager'

const TABLE = 'table-1'

describe('SitGoRebuyManager', () => {
  let mgr: SitGoRebuyManager

  beforeEach(() => {
    mgr = new SitGoRebuyManager()
  })

  it('has nothing pending before start() is called', () => {
    expect(mgr.hasPending(TABLE)).toBe(false)
    expect(mgr.getPendingPlayerIds(TABLE)).toEqual([])
    expect(mgr.getSecondsRemaining(TABLE)).toBe(0)
  })

  it('start() with an empty list is a no-op', () => {
    mgr.start(TABLE, [])
    expect(mgr.hasPending(TABLE)).toBe(false)
  })

  it('tracks every player passed to start() as pending', () => {
    mgr.start(TABLE, ['p1', 'p2'])
    expect(mgr.hasPending(TABLE)).toBe(true)
    expect(mgr.isPending(TABLE, 'p1')).toBe(true)
    expect(mgr.isPending(TABLE, 'p2')).toBe(true)
    expect(new Set(mgr.getPendingPlayerIds(TABLE))).toEqual(new Set(['p1', 'p2']))
  })

  it('reports ~65s remaining right after start()', () => {
    mgr.start(TABLE, ['p1'])
    const secs = mgr.getSecondsRemaining(TABLE)
    expect(secs).toBeGreaterThan(SIT_GO_REBUY_DECISION_MS / 1000 - 2)
    expect(secs).toBeLessThanOrEqual(SIT_GO_REBUY_DECISION_MS / 1000)
  })

  it('resolve() removes one player without clearing the others (multiple eliminations in one hand)', () => {
    mgr.start(TABLE, ['p1', 'p2', 'p3'])

    const wasLast = mgr.resolve(TABLE, 'p1')

    expect(wasLast).toBe(false)
    expect(mgr.hasPending(TABLE)).toBe(true)
    expect(mgr.isPending(TABLE, 'p1')).toBe(false)
    expect(mgr.isPending(TABLE, 'p2')).toBe(true)
    expect(mgr.isPending(TABLE, 'p3')).toBe(true)
  })

  it('resolve() returns true only when it clears the LAST pending player', () => {
    mgr.start(TABLE, ['p1', 'p2'])

    expect(mgr.resolve(TABLE, 'p1')).toBe(false)
    expect(mgr.resolve(TABLE, 'p2')).toBe(true)
    expect(mgr.hasPending(TABLE)).toBe(false)
  })

  it('resolve() is a safe no-op for a player who is not pending (never double-triggers)', () => {
    mgr.start(TABLE, ['p1'])
    mgr.resolve(TABLE, 'p1')  // first resolution — clears it

    // A stale timeout firing again for the same player must not report
    // "last resolved" a second time.
    expect(mgr.resolve(TABLE, 'p1')).toBe(false)
    expect(mgr.resolve(TABLE, 'unknown-player')).toBe(false)
  })

  it('resolve() for a table with nothing pending is a safe no-op', () => {
    expect(mgr.resolve(TABLE, 'p1')).toBe(false)
  })

  it('different tables track independent pending sets', () => {
    mgr.start('table-A', ['p1'])
    mgr.start('table-B', ['p2'])

    expect(mgr.isPending('table-A', 'p1')).toBe(true)
    expect(mgr.isPending('table-A', 'p2')).toBe(false)
    expect(mgr.isPending('table-B', 'p2')).toBe(true)

    mgr.resolve('table-A', 'p1')
    expect(mgr.hasPending('table-A')).toBe(false)
    expect(mgr.hasPending('table-B')).toBe(true)
  })

  it('toPayload reflects pending players and remaining seconds, and clears to empty once resolved', () => {
    mgr.start(TABLE, ['p1', 'p2'])
    const mid = mgr.toPayload(TABLE)
    expect(mid.tableId).toBe(TABLE)
    expect(new Set(mid.pendingPlayerIds)).toEqual(new Set(['p1', 'p2']))
    expect(mid.secondsRemaining).toBeGreaterThan(0)

    mgr.resolve(TABLE, 'p1')
    mgr.resolve(TABLE, 'p2')
    const after = mgr.toPayload(TABLE)
    expect(after.pendingPlayerIds).toEqual([])
    expect(after.secondsRemaining).toBe(0)
  })

  it('a fresh decision window after the previous one fully resolved starts a new independent deadline', () => {
    mgr.start(TABLE, ['p1'])
    mgr.resolve(TABLE, 'p1')
    expect(mgr.hasPending(TABLE)).toBe(false)

    mgr.start(TABLE, ['p2'])
    expect(mgr.hasPending(TABLE)).toBe(true)
    expect(mgr.isPending(TABLE, 'p2')).toBe(true)
    expect(mgr.getSecondsRemaining(TABLE)).toBeGreaterThan(0)
  })

  // ── Restoring a persisted deadline (rehydration after a server restart) ──

  it('start() accepts an explicit deadline — used to restore a decision persisted before a restart', () => {
    const persistedDeadline = Date.now() + 30_000  // e.g. 35s already elapsed of the original 65s
    mgr.start(TABLE, ['p1'], persistedDeadline)

    expect(mgr.isPending(TABLE, 'p1')).toBe(true)
    expect(mgr.getSecondsRemaining(TABLE)).toBeGreaterThan(28)
    expect(mgr.getSecondsRemaining(TABLE)).toBeLessThanOrEqual(30)
  })

  it('restoring an already-past deadline reports 0 seconds remaining, not negative', () => {
    const pastDeadline = Date.now() - 5_000  // process was down longer than the window
    mgr.start(TABLE, ['p1'], pastDeadline)

    expect(mgr.isPending(TABLE, 'p1')).toBe(true)
    expect(mgr.getSecondsRemaining(TABLE)).toBe(0)
  })

  it('restoring multiple players independently (rehydration loops one row at a time) still groups them under the same table', () => {
    const deadline1 = Date.now() + 10_000
    const deadline2 = Date.now() + 40_000
    mgr.start(TABLE, ['p1'], deadline1)
    mgr.start(TABLE, ['p2'], deadline2)

    expect(new Set(mgr.getPendingPlayerIds(TABLE))).toEqual(new Set(['p1', 'p2']))
    // getSecondsRemaining reports the latest of the two — never lets the
    // banner disappear before the slower-restored player's window is done.
    expect(mgr.getSecondsRemaining(TABLE)).toBeGreaterThan(38)
  })
})
