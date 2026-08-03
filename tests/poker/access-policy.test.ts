import { describe, it, expect } from 'vitest'
import { mustCompletePasswordChange } from '../../src/lib/socket/access-policy'

describe('mustCompletePasswordChange', () => {
  it('blocks a player who still owes a password change', () => {
    expect(mustCompletePasswordChange({ role: 'player', mustChangePassword: true })).toBe(true)
  })

  it('allows a player who has already changed their password', () => {
    expect(mustCompletePasswordChange({ role: 'player', mustChangePassword: false })).toBe(false)
  })

  it('exempts an admin even if the flag is still set', () => {
    expect(mustCompletePasswordChange({ role: 'admin', mustChangePassword: true })).toBe(false)
  })

  it('exempts a super_admin even if the flag is still set', () => {
    expect(mustCompletePasswordChange({ role: 'super_admin', mustChangePassword: true })).toBe(false)
  })
})
