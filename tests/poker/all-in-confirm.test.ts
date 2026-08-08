import { describe, it, expect } from 'vitest'
import {
  allInConfirmReducer,
  canSubmitAllIn,
  initialAllInConfirmState,
  type AllInConfirmState,
} from '../../src/lib/socket/all-in-confirm'

// This state machine drives the All-in confirmation step in TableRoom.tsx.
// The button click must only ever open a confirmation, never emit the
// `player_action` socket event itself — that emit is gated by
// `canSubmitAllIn`, checked by the caller immediately before sending.

describe('allInConfirmReducer', () => {
  it('starts closed and not sending', () => {
    expect(initialAllInConfirmState).toEqual({ open: false, sending: false })
  })

  it('REQUEST opens the confirmation without marking it as sending', () => {
    const next = allInConfirmReducer(initialAllInConfirmState, { type: 'REQUEST' })
    expect(next).toEqual({ open: true, sending: false })
  })

  it('CANCEL closes the confirmation and clears sending', () => {
    const opened: AllInConfirmState = { open: true, sending: false }
    expect(allInConfirmReducer(opened, { type: 'CANCEL' })).toEqual({ open: false, sending: false })
  })

  it('CONFIRM marks the confirmation as sending', () => {
    const opened: AllInConfirmState = { open: true, sending: false }
    expect(allInConfirmReducer(opened, { type: 'CONFIRM' })).toEqual({ open: true, sending: true })
  })

  it('CONFIRM while already sending is a no-op (prevents a second dispatch from changing state)', () => {
    const sending: AllInConfirmState = { open: true, sending: true }
    expect(allInConfirmReducer(sending, { type: 'CONFIRM' })).toBe(sending)
  })

  it('ERROR re-enables Confirm (clears sending) but leaves the confirmation open', () => {
    const sending: AllInConfirmState = { open: true, sending: true }
    expect(allInConfirmReducer(sending, { type: 'ERROR' })).toEqual({ open: true, sending: false })
  })

  it('ERROR while not sending is a no-op', () => {
    expect(allInConfirmReducer(initialAllInConfirmState, { type: 'ERROR' })).toBe(initialAllInConfirmState)
  })

  it('ACTION_UNAVAILABLE closes the confirmation from any open/sending state', () => {
    expect(allInConfirmReducer({ open: true, sending: false }, { type: 'ACTION_UNAVAILABLE' }))
      .toEqual({ open: false, sending: false })
    expect(allInConfirmReducer({ open: true, sending: true }, { type: 'ACTION_UNAVAILABLE' }))
      .toEqual({ open: false, sending: false })
  })

  it('ACTION_UNAVAILABLE while already closed is a no-op', () => {
    expect(allInConfirmReducer(initialAllInConfirmState, { type: 'ACTION_UNAVAILABLE' }))
      .toBe(initialAllInConfirmState)
  })
})

describe('canSubmitAllIn', () => {
  it('is false before the All-in button has been clicked', () => {
    expect(canSubmitAllIn(initialAllInConfirmState)).toBe(false)
  })

  it('is true once the confirmation is open and not already sending', () => {
    expect(canSubmitAllIn({ open: true, sending: false })).toBe(true)
  })

  it('is false while a confirm is already in flight — this is what makes a double-click send exactly once', () => {
    const opened: AllInConfirmState = { open: true, sending: false }
    // First click: allowed, then the caller immediately dispatches CONFIRM.
    expect(canSubmitAllIn(opened)).toBe(true)
    const afterConfirm = allInConfirmReducer(opened, { type: 'CONFIRM' })
    // Second click (e.g. a fast double-click) must be rejected.
    expect(canSubmitAllIn(afterConfirm)).toBe(false)
  })

  it('is false once the confirmation has been closed', () => {
    expect(canSubmitAllIn({ open: false, sending: false })).toBe(false)
  })
})
