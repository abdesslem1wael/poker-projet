// Pure seat-retention decision logic, extracted out of server.ts so it can be
// unit tested without a live socket.io server.
//
// Core rule: a seat is released ONLY by an explicit leave_table call (or going
// broke / an admin kick / Sit & Go elimination). A socket disconnect —
// phone lock, app switch, refresh, dropped connection — must never empty a
// seat. DisconnectedSeatTracker records who is currently offline so callers
// can keep them seated (and auto-act their turns) instead of evicting them.
//
// The one exception is a genuine "ghost" row: a table_players entry stuck as
// 'seated' from BEFORE this server process started (e.g. a crash/restart
// wiped all in-memory state, including this tracker). Those have no live
// socket AND were never seen disconnecting by this process, so they're
// distinguishable from a player who is merely offline right now.

export class DisconnectedSeatTracker {
  private byTable = new Map<string, Set<string>>()

  markDisconnected(tableId: string, userId: string): void {
    let set = this.byTable.get(tableId)
    if (!set) {
      set = new Set()
      this.byTable.set(tableId, set)
    }
    set.add(userId)
  }

  // Call on reconnect (join_table) and whenever a player's seat is
  // legitimately freed (leave_table, kick, going broke) — the tracker should
  // never keep stale entries around once they no longer apply.
  clear(tableId: string, userId: string): void {
    this.byTable.get(tableId)?.delete(userId)
  }

  isDisconnected(tableId: string, userId: string): boolean {
    return this.byTable.get(tableId)?.has(userId) ?? false
  }

  // Snapshot of currently-offline-but-still-seated users for a table.
  // Never returns the live internal Set — callers must not mutate it.
  getReserved(tableId: string): Set<string> {
    return new Set(this.byTable.get(tableId) ?? [])
  }
}

// Splits seated rows into those that must be kept (currently connected, or
// protected for some other reason — mid-hand, known-disconnected, etc.) and
// those that are genuinely stale (no live socket, no protection at all).
export function partitionByConnection<T extends { player_id: string }>(
  rows: T[],
  connectedUserIds: Set<string>,
  protectedUserIds: Set<string>,
): { keep: T[]; stale: T[] } {
  const keep: T[] = []
  const stale: T[] = []
  for (const r of rows) {
    if (connectedUserIds.has(r.player_id) || protectedUserIds.has(r.player_id)) {
      keep.push(r)
    } else {
      stale.push(r)
    }
  }
  return { keep, stale }
}
