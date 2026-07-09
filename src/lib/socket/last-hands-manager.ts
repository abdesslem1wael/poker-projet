// In-memory cache mirroring poker_tables' last_hands_* columns — the DATABASE
// is the source of truth (it's what survives a server restart/redeploy and
// what reconnecting sockets are sent). server.ts is responsible for every DB
// read/write; this class only holds a fast local copy of "remaining" for
// tables currently in Last Hands mode, hydrated from the DB at boot and kept
// in sync after each write, so hot paths (broadcasts, admin snapshots) don't
// need to round-trip to Postgres.
import type { LastHandsStatePayload } from './types'

export interface LastHandsInfo {
  tableId: string
  remaining: number
}

export class LastHandsManager {
  private entries = new Map<string, LastHandsInfo>()

  // Upserts the cached remaining count for a table — call this right after
  // every successful DB write (start / +5 / decrement) to keep the cache
  // in sync with the source of truth.
  setRemaining(tableId: string, remaining: number): void {
    this.entries.set(tableId, { tableId, remaining })
  }

  isActive(tableId: string): boolean {
    return this.entries.has(tableId)
  }

  get(tableId: string): LastHandsInfo | undefined {
    return this.entries.get(tableId)
  }

  getAllActive(): LastHandsInfo[] {
    return Array.from(this.entries.values())
  }

  // Stops tracking — call this once the DB row has actually been cleared
  // (last_hands_active set back to false), i.e. once the table closes.
  end(tableId: string): void {
    this.entries.delete(tableId)
  }

  toPayload(tableId: string): LastHandsStatePayload {
    const e = this.entries.get(tableId)
    return { tableId, remaining: e?.remaining ?? null }
  }
}
