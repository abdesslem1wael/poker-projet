// Pure gating logic for the forced first-login password change, extracted out
// of server.ts so it's unit-testable without a live socket.io server —
// mirrors admin-card-view.ts and seat-policy.ts.

export type AccessPolicySocket = {
  role: string
  mustChangePassword: boolean
}

// Admin/super_admin are exempt; a player who still owes a password change
// cannot join a seat or act.
export function mustCompletePasswordChange(socket: AccessPolicySocket): boolean {
  if (socket.role === 'admin' || socket.role === 'super_admin') return false
  return socket.mustChangePassword
}
