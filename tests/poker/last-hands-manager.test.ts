import { describe, it, expect } from 'vitest'
import { LastHandsManager } from '../../src/lib/socket/last-hands-manager'

// LastHandsManager is a pure in-memory MIRROR of poker_tables' last_hands_*
// columns — the DB is the source of truth (server.ts does every read/write
// and calls setRemaining()/end() to keep this cache in sync). These tests
// only cover the cache's own bookkeeping.

const TABLE = 'table-1'

describe('LastHandsManager', () => {
  it('is inactive for a table until the cache is populated', () => {
    const lhm = new LastHandsManager()
    expect(lhm.get(TABLE)).toBeUndefined()
    expect(lhm.isActive(TABLE)).toBe(false)
    expect(lhm.toPayload(TABLE)).toEqual({ tableId: TABLE, remaining: null })
  })

  it('setRemaining upserts the cached count (mirrors a DB write)', () => {
    const lhm = new LastHandsManager()
    lhm.setRemaining(TABLE, 10)
    expect(lhm.isActive(TABLE)).toBe(true)
    expect(lhm.get(TABLE)?.remaining).toBe(10)
    expect(lhm.toPayload(TABLE)).toEqual({ tableId: TABLE, remaining: 10 })
  })

  it('setRemaining overwrites the previous value rather than accumulating', () => {
    const lhm = new LastHandsManager()
    lhm.setRemaining(TABLE, 10)
    lhm.setRemaining(TABLE, 9)
    lhm.setRemaining(TABLE, 4)
    expect(lhm.get(TABLE)?.remaining).toBe(4)
  })

  it('mirrors a top-up (4 remaining +5 => 9) as a plain overwrite', () => {
    const lhm = new LastHandsManager()
    lhm.setRemaining(TABLE, 4)
    lhm.setRemaining(TABLE, 4 + 5)
    expect(lhm.get(TABLE)?.remaining).toBe(9)
  })

  it('end() clears the cache entry (mirrors the table closing)', () => {
    const lhm = new LastHandsManager()
    lhm.setRemaining(TABLE, 3)
    lhm.end(TABLE)
    expect(lhm.get(TABLE)).toBeUndefined()
    expect(lhm.isActive(TABLE)).toBe(false)
    expect(lhm.toPayload(TABLE)).toEqual({ tableId: TABLE, remaining: null })
  })

  it('end() on a table with no cached entry is a harmless no-op', () => {
    const lhm = new LastHandsManager()
    expect(() => lhm.end(TABLE)).not.toThrow()
    expect(lhm.isActive(TABLE)).toBe(false)
  })

  it('tracks independent countdowns per table via getAllActive', () => {
    const lhm = new LastHandsManager()
    lhm.setRemaining('table-a', 10)
    lhm.setRemaining('table-b', 3)
    const all = lhm.getAllActive().map(e => e.tableId).sort()
    expect(all).toEqual(['table-a', 'table-b'])
  })

  it('getAllActive omits tables that were ended', () => {
    const lhm = new LastHandsManager()
    lhm.setRemaining('table-a', 10)
    lhm.setRemaining('table-b', 3)
    lhm.end('table-a')
    expect(lhm.getAllActive().map(e => e.tableId)).toEqual(['table-b'])
  })
})
