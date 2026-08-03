// Pure targeting logic for the admin-only "see all hole cards" broadcast.
// Kept separate from server.ts (which owns real Socket.io instances) so the
// eligibility rule is unit-testable, mirroring seat-policy.ts.

export type AdminCardViewSocket = {
  role: string
  seatedAtTables: Set<string>
}

// An admin/super_admin socket qualifies for the admin card view UNLESS it is
// itself seated as an active player at this table — a playing admin must not
// see opponents' cards mid-hand. Every other role never qualifies, regardless
// of seating.
export function isEligibleForAdminCardView(socket: AdminCardViewSocket, tableId: string): boolean {
  if (socket.role !== 'admin' && socket.role !== 'super_admin') return false
  return !socket.seatedAtTables.has(tableId)
}
