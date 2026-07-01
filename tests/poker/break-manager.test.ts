import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BreakManager, BREAK_COUNTDOWN_MS, BREAK_DURATION_MS } from '../../src/lib/socket/break-manager'

const TABLE = 'table-1'

describe('BreakManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  it('has no break for a table until one is started', () => {
    const bm = new BreakManager()
    expect(bm.get(TABLE)).toBeUndefined()
    expect(bm.isActive(TABLE)).toBe(false)
    expect(bm.toPayload(TABLE)).toEqual({
      tableId: TABLE, phase: null, countdownSecondsRemaining: 0, breakSecondsRemaining: 0,
    })
  })

  it('starts in the countdown phase and rejects a second concurrent start', () => {
    const bm = new BreakManager()
    expect(bm.startBreak(TABLE)).toBe(true)
    expect(bm.get(TABLE)?.phase).toBe('countdown')
    expect(bm.getCountdownSecondsRemaining(TABLE)).toBe(BREAK_COUNTDOWN_MS / 1000)
    expect(bm.startBreak(TABLE)).toBe(false)
  })

  it('counts down the countdown phase toward zero', () => {
    const bm = new BreakManager()
    bm.startBreak(TABLE)
    vi.advanceTimersByTime(45_000)
    expect(bm.getCountdownSecondsRemaining(TABLE)).toBe(15)
  })

  it('moves to awaiting_hand_end and back does not regress once counted down', () => {
    const bm = new BreakManager()
    bm.startBreak(TABLE)
    bm.setAwaitingHandEnd(TABLE)
    expect(bm.get(TABLE)?.phase).toBe('awaiting_hand_end')
    // Calling it again once already in a later phase is a no-op (no accidental phase reset).
    bm.setAwaitingHandEnd(TABLE)
    expect(bm.get(TABLE)?.phase).toBe('awaiting_hand_end')
  })

  it('activates the break with a fresh 10-minute window and counts it down', () => {
    const bm = new BreakManager()
    bm.startBreak(TABLE)
    bm.activate(TABLE)
    expect(bm.get(TABLE)?.phase).toBe('active')
    expect(bm.isActive(TABLE)).toBe(true)
    expect(bm.getBreakSecondsRemaining(TABLE)).toBe(BREAK_DURATION_MS / 1000)
    vi.advanceTimersByTime(60_000)
    expect(bm.getBreakSecondsRemaining(TABLE)).toBe(BREAK_DURATION_MS / 1000 - 60)
  })

  it('removes all state once ended', () => {
    const bm = new BreakManager()
    bm.startBreak(TABLE)
    bm.activate(TABLE)
    bm.end(TABLE)
    expect(bm.get(TABLE)).toBeUndefined()
    expect(bm.isActive(TABLE)).toBe(false)
    expect(bm.toPayload(TABLE).phase).toBeNull()
  })

  it('tracks independent breaks per table via getAllBreaks', () => {
    const bm = new BreakManager()
    bm.startBreak('table-a')
    bm.startBreak('table-b')
    const all = bm.getAllBreaks().map(b => b.tableId).sort()
    expect(all).toEqual(['table-a', 'table-b'])
  })
})
