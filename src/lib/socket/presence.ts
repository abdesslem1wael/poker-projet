// In-memory presence: tableId → userId → set of socketIds.
// A player can have multiple tabs open (multiple socket IDs) per table.
// Only removed from a table's player list when all their sockets leave.

export class PresenceManager {
  private tables = new Map<string, Map<string, Set<string>>>()

  join(tableId: string, userId: string, socketId: string): void {
    let table = this.tables.get(tableId)
    if (!table) {
      table = new Map()
      this.tables.set(tableId, table)
    }
    let sockets = table.get(userId)
    if (!sockets) {
      sockets = new Set()
      table.set(userId, sockets)
    }
    sockets.add(socketId)
  }

  leave(tableId: string, userId: string, socketId: string): void {
    const table = this.tables.get(tableId)
    if (!table) return
    const sockets = table.get(userId)
    if (!sockets) return
    sockets.delete(socketId)
    if (sockets.size === 0) table.delete(userId)
    if (table.size === 0) this.tables.delete(tableId)
  }

  // Remove a socketId from every table on disconnect.
  // Returns the tableIds that were affected so callers can broadcast updates.
  removeSocket(socketId: string, userId: string): string[] {
    const affected: string[] = []
    for (const tableId of this.tables.keys()) {
      const sockets = this.tables.get(tableId)?.get(userId)
      if (!sockets?.has(socketId)) continue
      this.leave(tableId, userId, socketId)
      affected.push(tableId)
    }
    return affected
  }

  getPlayerIds(tableId: string): string[] {
    const table = this.tables.get(tableId)
    return table ? Array.from(table.keys()) : []
  }

  getCount(tableId: string): number {
    return this.tables.get(tableId)?.size ?? 0
  }
}
