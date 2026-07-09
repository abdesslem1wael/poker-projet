import { describe, it, expect } from 'vitest'
import { didNewHandStart } from '../../src/lib/socket/hand-transition'

// This predicate decides when TableRoom.tsx clears per-hand-only "last
// action" labels (Folded/Called/Raised/etc. shown under a seat). It's keyed
// off handNumber from table_state — broadcast to EVERY socket in the room —
// rather than the private deal_cards event, which only reaches players
// actually dealt into that specific hand (never spectators, excluded/
// eliminated players, or a player who reconnects between hands).

describe('didNewHandStart', () => {
  it('is true the first time a hand starts (no previous hand seen yet)', () => {
    expect(didNewHandStart(null, 1)).toBe(true)
  })

  it('is false for repeated table_state broadcasts within the same hand', () => {
    expect(didNewHandStart(1, 1)).toBe(false)
  })

  it('is true when the hand number advances to the next hand', () => {
    expect(didNewHandStart(1, 2)).toBe(true)
    // after a fold from hand 1, hand 2 starting must be detected regardless
    // of how many hands have already been played
    expect(didNewHandStart(41, 42)).toBe(true)
  })

  it('is false between hands, when no hand is currently running', () => {
    // handState is null between hands — previous-hand action labels are
    // deliberately left alone until the next hand actually deals in, not
    // wiped the instant the current hand ends.
    expect(didNewHandStart(5, null)).toBe(false)
  })

  it('is true for a reconnecting/spectating client seeing this table for the first time mid-hand', () => {
    // A client that never saw a previous hand (prevHandNumber starts null —
    // e.g. a spectator who just joined, or a reconnect after a server
    // restart) must still detect "hand in progress" as new so it never
    // shows stale labels it could not possibly have valid data for.
    expect(didNewHandStart(null, 7)).toBe(true)
  })
})
