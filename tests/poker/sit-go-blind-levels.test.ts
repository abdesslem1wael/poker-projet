import { describe, it, expect } from 'vitest'
import {
  computeSitGoBlindLevel,
  syncSitGoBlindLevel,
  SIT_GO_BLIND_MULTIPLIERS,
} from '../../src/lib/socket/table-session'

// ── Minimal poker_tables-only Supabase mock ─────────────────────────────────
// syncSitGoBlindLevel only ever touches poker_tables (select-by-id then
// update-by-id), so a single-row mock is enough to exercise it.

type Row = Record<string, unknown>

class PokerTableMockDB {
  row: Row
  updateCalls: Row[] = []

  constructor(row: Row) {
    this.row = row
  }

  from(table: string) {
    if (table !== 'poker_tables') throw new Error(`Unexpected table in mock: ${table}`)
    return {
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          single: async () => ({ data: { ...this.row }, error: null }),
        }),
      }),
      update: (fields: Row) => ({
        eq: (_col: string, _val: unknown) => {
          this.updateCalls.push(fields)
          Object.assign(this.row, fields)
          return Promise.resolve({ error: null })
        },
      }),
    }
  }
}

const TABLE = 'sitgo-table-1'
const SEVEN_MIN_MS = 7 * 60 * 1000

function startedAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

// ── computeSitGoBlindLevel ───────────────────────────────────────────────────

describe('computeSitGoBlindLevel', () => {
  const maxLevel = SIT_GO_BLIND_MULTIPLIERS.length

  it('is level 1 the instant the tournament starts', () => {
    expect(computeSitGoBlindLevel(startedAgo(0), maxLevel)).toBe(1)
  })

  it('is still level 1 a second before the 7-minute mark', () => {
    expect(computeSitGoBlindLevel(startedAgo(SEVEN_MIN_MS - 1000), maxLevel)).toBe(1)
  })

  it('is level 2 once 7 minutes have elapsed', () => {
    expect(computeSitGoBlindLevel(startedAgo(SEVEN_MIN_MS), maxLevel)).toBe(2)
  })

  it('is level 3 after another 7 minutes (14 total)', () => {
    expect(computeSitGoBlindLevel(startedAgo(2 * SEVEN_MIN_MS), maxLevel)).toBe(3)
  })

  it('never exceeds the highest defined level', () => {
    expect(computeSitGoBlindLevel(startedAgo(100 * SEVEN_MIN_MS), maxLevel)).toBe(maxLevel)
  })
})

// ── syncSitGoBlindLevel ──────────────────────────────────────────────────────

describe('syncSitGoBlindLevel', () => {
  function baseRow(overrides: Row = {}): Row {
    return {
      sit_go_status: 'running',
      sit_go_started_at: startedAgo(0),
      blind_level: 1,
      original_small_blind: 10,
      original_big_blind: 20,
      ...overrides,
    }
  }

  it('does nothing for a table that is not running (e.g. still registering)', async () => {
    const db = new PokerTableMockDB(baseRow({ sit_go_status: 'registering', sit_go_started_at: null }))

    const result = await syncSitGoBlindLevel(db as never, TABLE)
    expect(result.changed).toBe(false)
    expect(db.updateCalls).toHaveLength(0)
  })

  it('does not advance before 7 minutes have elapsed', async () => {
    const db = new PokerTableMockDB(baseRow({ sit_go_started_at: startedAgo(60_000) }))

    const result = await syncSitGoBlindLevel(db as never, TABLE)
    expect(result.changed).toBe(false)
    expect(db.row.blind_level).toBe(1)
  })

  it('advances to level 2 and scales blinds off the original values once 7 minutes have elapsed', async () => {
    const db = new PokerTableMockDB(baseRow({ sit_go_started_at: startedAgo(SEVEN_MIN_MS) }))

    const result = await syncSitGoBlindLevel(db as never, TABLE)
    expect(result.changed).toBe(true)
    expect(db.row.blind_level).toBe(2)
    expect(db.row.small_blind).toBe(10 * SIT_GO_BLIND_MULTIPLIERS[1])
    expect(db.row.big_blind).toBe(20 * SIT_GO_BLIND_MULTIPLIERS[1])
  })

  it('is idempotent: calling it again at the same elapsed time does not re-write or move the level backward', async () => {
    const db = new PokerTableMockDB(baseRow({ sit_go_started_at: startedAgo(SEVEN_MIN_MS) }))

    const first = await syncSitGoBlindLevel(db as never, TABLE)
    const second = await syncSitGoBlindLevel(db as never, TABLE)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(db.updateCalls).toHaveLength(1)
    expect(db.row.blind_level).toBe(2)
  })

  it('a reconnect/refresh (re-reading the persisted row) reports the current level without resetting the clock', async () => {
    // Simulates a player reconnecting well after the table already advanced:
    // the level is derived purely from sit_go_started_at, so nothing here
    // depends on any in-memory/per-connection timer.
    const db = new PokerTableMockDB(baseRow({
      sit_go_started_at: startedAgo(8 * 60 * 1000),
      blind_level: 2,
      small_blind: 20,
      big_blind: 40,
    }))

    const result = await syncSitGoBlindLevel(db as never, TABLE)
    expect(result.changed).toBe(false)
    expect(db.row.blind_level).toBe(2)
    expect(db.updateCalls).toHaveLength(0)
  })

  it('does nothing when original blinds were never recorded (cash tables never populate these)', async () => {
    const db = new PokerTableMockDB(baseRow({
      sit_go_started_at: startedAgo(SEVEN_MIN_MS),
      original_small_blind: null,
      original_big_blind: null,
    }))

    const result = await syncSitGoBlindLevel(db as never, TABLE)
    expect(result.changed).toBe(false)
    expect(db.updateCalls).toHaveLength(0)
  })
})
