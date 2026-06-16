// In-memory per-table session tracking.
// A session starts when the first hand of a table is dealt and runs for 1 hour.
// Admin can extend after expiry; players cannot leave while the session is active.

const SESSION_DURATION_MS = 60 * 60 * 1000  // 1 hour

export interface SessionInfo {
  tableId: string
  tableName: string
  startedAt: number  // epoch ms
  expiresAt: number  // epoch ms
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()

  startSession(tableId: string, tableName: string): void {
    if (this.sessions.has(tableId)) return
    const now = Date.now()
    this.sessions.set(tableId, { tableId, tableName, startedAt: now, expiresAt: now + SESSION_DURATION_MS })
  }

  // Extend from current expiry (or now, if already expired).
  extendSession(tableId: string, additionalMs: number): boolean {
    const s = this.sessions.get(tableId)
    if (!s) return false
    s.expiresAt = Math.max(Date.now(), s.expiresAt) + additionalMs
    return true
  }

  isActive(tableId: string): boolean {
    return this.sessions.has(tableId)
  }

  isExpired(tableId: string): boolean {
    const s = this.sessions.get(tableId)
    if (!s) return false
    return Date.now() >= s.expiresAt
  }

  getSecondsRemaining(tableId: string): number {
    const s = this.sessions.get(tableId)
    if (!s) return 0
    return Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000))
  }

  getSession(tableId: string): SessionInfo | undefined {
    return this.sessions.get(tableId)
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
  }
}
