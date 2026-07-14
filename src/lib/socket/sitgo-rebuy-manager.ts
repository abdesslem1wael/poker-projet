// In-memory tracking of pending Sit & Go rebuy/leave decisions. When a hand
// eliminates one or more registered players and the tournament isn't over,
// server.ts pauses the next hand until every eliminated player from that
// hand has rebought, left, or their 65s decision window has elapsed (see
// startSitGoRebuyDecisions()/resolveSitGoRebuyDecision() in server.ts, which
// own the actual setTimeout scheduling and DB writes — this class only
// tracks who's still pending and when their shared deadline is).
import type { SitGoRebuyStatePayload } from './types'

export const SIT_GO_REBUY_DECISION_MS = 65_000

export class SitGoRebuyManager {
  // tableId -> playerId -> deadline (epoch ms)
  private pending = new Map<string, Map<string, number>>()

  // Starts a decision window for each given player at this table. All
  // players eliminated in the same hand share one deadline by default
  // (now + 65s). No-op for an empty list.
  //
  // `deadline` can be passed explicitly to restore a decision that was
  // already persisted to the DB before a restart (see server.ts's boot-time
  // rehydration) — in that case it's whatever remains of the original 65s
  // window, not a fresh one.
  start(tableId: string, playerIds: string[], deadline: number = Date.now() + SIT_GO_REBUY_DECISION_MS): void {
    if (playerIds.length === 0) return
    let table = this.pending.get(tableId)
    if (!table) {
      table = new Map()
      this.pending.set(tableId, table)
    }
    for (const playerId of playerIds) table.set(playerId, deadline)
  }

  // Clears one player's pending decision (rebought, left, or timed out).
  // Returns true only when this call was the one that cleared the LAST
  // pending decision for the table — i.e. the caller should now let the next
  // hand proceed. Calling this for a player who isn't actually pending (e.g.
  // already resolved) is a safe no-op that returns false, so it can never
  // double-trigger the next-hand resume.
  resolve(tableId: string, playerId: string): boolean {
    const table = this.pending.get(tableId)
    if (!table || !table.has(playerId)) return false
    table.delete(playerId)
    if (table.size === 0) {
      this.pending.delete(tableId)
      return true
    }
    return false
  }

  isPending(tableId: string, playerId: string): boolean {
    return this.pending.get(tableId)?.has(playerId) ?? false
  }

  hasPending(tableId: string): boolean {
    return (this.pending.get(tableId)?.size ?? 0) > 0
  }

  getPendingPlayerIds(tableId: string): string[] {
    return Array.from(this.pending.get(tableId)?.keys() ?? [])
  }

  // All entries for a table share one deadline (see start()); Math.max is
  // just a defensive read in case that ever stops being true.
  getSecondsRemaining(tableId: string): number {
    const table = this.pending.get(tableId)
    if (!table || table.size === 0) return 0
    const deadline = Math.max(...table.values())
    return Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  }

  toPayload(tableId: string): SitGoRebuyStatePayload {
    return {
      tableId,
      pendingPlayerIds: this.getPendingPlayerIds(tableId),
      secondsRemaining: this.getSecondsRemaining(tableId),
    }
  }
}
