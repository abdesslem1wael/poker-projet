// In-memory per-table break scheduling.
// An admin starts a break, which runs a 1-minute warning countdown ('countdown')
// while play continues normally. Once that countdown elapses, if a hand is still
// running the break waits for it to finish ('awaiting_hand_end') rather than
// interrupting it; once no hand is active the break becomes 'active' for
// BREAK_DURATION_MS, during which no new hand may start. server.ts owns the
// actual setTimeout scheduling — this class only tracks phase/timing state.
import type { BreakPhase, BreakStatePayload } from './types'

export const BREAK_COUNTDOWN_MS = 60_000        // 1 minute "Break starts in…"
export const BREAK_DURATION_MS = 10 * 60_000    // 10 minute break

export interface BreakInfo {
  tableId: string
  phase: BreakPhase
  countdownEndsAt: number       // epoch ms — valid while phase === 'countdown'
  breakEndsAt: number | null    // epoch ms — set once phase becomes 'active'
}

export class BreakManager {
  private breaks = new Map<string, BreakInfo>()

  // Returns false if a break is already scheduled/running for this table.
  startBreak(tableId: string): boolean {
    if (this.breaks.has(tableId)) return false
    this.breaks.set(tableId, {
      tableId,
      phase: 'countdown',
      countdownEndsAt: Date.now() + BREAK_COUNTDOWN_MS,
      breakEndsAt: null,
    })
    return true
  }

  setAwaitingHandEnd(tableId: string): void {
    const b = this.breaks.get(tableId)
    if (b && b.phase === 'countdown') b.phase = 'awaiting_hand_end'
  }

  activate(tableId: string): void {
    const b = this.breaks.get(tableId)
    if (!b) return
    b.phase = 'active'
    b.breakEndsAt = Date.now() + BREAK_DURATION_MS
  }

  end(tableId: string): void {
    this.breaks.delete(tableId)
  }

  get(tableId: string): BreakInfo | undefined {
    return this.breaks.get(tableId)
  }

  isActive(tableId: string): boolean {
    return this.breaks.get(tableId)?.phase === 'active'
  }

  getCountdownSecondsRemaining(tableId: string): number {
    const b = this.breaks.get(tableId)
    if (!b) return 0
    return Math.max(0, Math.ceil((b.countdownEndsAt - Date.now()) / 1000))
  }

  getBreakSecondsRemaining(tableId: string): number {
    const b = this.breaks.get(tableId)
    if (!b || b.breakEndsAt == null) return 0
    return Math.max(0, Math.ceil((b.breakEndsAt - Date.now()) / 1000))
  }

  getAllBreaks(): BreakInfo[] {
    return Array.from(this.breaks.values())
  }

  toPayload(tableId: string): BreakStatePayload {
    const b = this.breaks.get(tableId)
    return {
      tableId,
      phase: b?.phase ?? null,
      countdownSecondsRemaining: b ? this.getCountdownSecondsRemaining(tableId) : 0,
      breakSecondsRemaining: b ? this.getBreakSecondsRemaining(tableId) : 0,
    }
  }
}
