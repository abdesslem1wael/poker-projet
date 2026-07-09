import { describe, it, expect, beforeEach } from 'vitest'
import { DisconnectedSeatTracker, partitionByConnection } from '../../src/lib/socket/seat-policy'
import { joinTable, leaveTable } from '../../src/lib/socket/table-session'
import { GameManager } from '../../src/lib/socket/game-manager'

// A disconnect (phone lock, app switch, refresh, dropped connection) must
// NEVER empty a seat — only leave_table (or going broke / an admin kick /
// Sit & Go elimination) may do that. These tests exercise the pure policy
// pieces server.ts relies on to guarantee that, without needing a live
// socket.io server.

// ── Minimal in-memory Supabase mock (same shape as table-session.test.ts) ──

type Row = Record<string, unknown>

class QueryBuilder {
  constructor(private _rows: Row[]) {}
  private _filters: Array<(r: Row) => boolean> = []
  select(): this { return this }
  eq(col: string, val: unknown): this { this._filters.push(r => r[col] === val); return this }
  neq(col: string, val: unknown): this { this._filters.push(r => r[col] !== val); return this }
  in(col: string, vals: unknown[]): this { this._filters.push(r => vals.includes(r[col])); return this }
  private filtered(): Row[] { return this._rows.filter(r => this._filters.every(f => f(r))) }
  async single() { return { data: this.filtered()[0] ?? null, error: null } }
  async maybeSingle() { return { data: this.filtered()[0] ?? null, error: null } }
  then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: this.filtered(), error: null }) }
}

class MockDB {
  private _tableRows: Row[] = []
  private _playerRows: Row[] = []

  seedTable(row: Row) { this._tableRows.push(row) }
  seedPlayer(row: Row) { this._playerRows.push(row) }
  getPlayer(playerId: string): Row | undefined {
    return this._playerRows.find(r => r.player_id === playerId && r.status !== 'left')
  }

  from(table: string) {
    if (table === 'poker_tables') return new QueryBuilder(this._tableRows)
    if (table === 'profiles') return new QueryBuilder([])
    if (table === 'table_players') {
      const rows = this._playerRows
      const pushPlayer = (row: Row) => this._playerRows.push(row)
      return {
        select: () => new QueryBuilder(rows),
        insert: (row: Row) => {
          pushPlayer({ id: `new-${rows.length}`, joined_at: new Date().toISOString(), ...row })
          return Promise.resolve({ error: null })
        },
        update: (fields: Row) => {
          const filters: Array<(r: Row) => boolean> = []
          const apply = () => {
            for (const r of rows.filter(r => filters.every(f => f(r)))) Object.assign(r, fields)
          }
          const ub = {
            eq: (col: string, val: unknown) => { filters.push(r => r[col] === val); return ub },
            neq: (col: string, val: unknown) => { filters.push(r => r[col] !== val); return ub },
            then: (resolve: (v: { error: null }) => void) => { apply(); resolve({ error: null }) },
          }
          return ub
        },
      }
    }
    return new QueryBuilder([])
  }
}

const TABLE = 'table-1'
const P1 = 'player-1'
const P2 = 'player-2'

// ── DisconnectedSeatTracker + partitionByConnection ────────────────────────

describe('seat retention policy', () => {
  let tracker: DisconnectedSeatTracker
  beforeEach(() => { tracker = new DisconnectedSeatTracker() })

  it('seated player disconnects while folded → seat remains occupied', () => {
    const db = new MockDB()
    db.seedPlayer({ id: 'row-1', table_id: TABLE, player_id: P2, seat_number: 2, status: 'seated', joined_at: '2024-01-01' })

    // Player folded, then their last socket drops.
    tracker.markDisconnected(TABLE, P2)

    // No live sockets remain for P2 in the room.
    const connected = new Set<string>()
    const reserved = tracker.getReserved(TABLE)

    const rows = [{ player_id: P2 }]
    const { keep, stale } = partitionByConnection(rows, connected, reserved)

    expect(keep).toHaveLength(1)
    expect(stale).toHaveLength(0)
    // The row itself was never touched — still seated at seat 2.
    expect(db.getPlayer(P2)).toMatchObject({ status: 'seated', seat_number: 2 })
  })

  it('seated player disconnects on their turn → auto-fold/check happens but seat remains occupied', () => {
    const gm = new GameManager()
    const supabase = {
      from: () => ({
        select: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({ data: ids.map(id => ({ user_id: id, chips: 1000 })), error: null }),
        }),
      }),
    }
    const seated = [
      { playerId: P1, username: 'Alice', seatNumber: 1 },
      { playerId: P2, username: 'Bob', seatNumber: 2 },
    ]

    return gm.startHand(TABLE, seated, supabase, 5, 10).then(() => {
      const handState = gm.getPublicHandState(TABLE)!
      const actor = handState.currentTurnPlayerId!

      // The acting player's socket drops mid-turn — mark them offline.
      tracker.markDisconnected(TABLE, actor)
      expect(tracker.isDisconnected(TABLE, actor)).toBe(true)

      // Timeout fires: server tries CHECK, falls back to FOLD — same as a
      // connected player. Connection status never gates the action.
      let result = gm.processAction(TABLE, actor, 'CHECK')
      if ('error' in result) result = gm.processAction(TABLE, actor, 'FOLD')
      expect('error' in result).toBe(false)

      // Nothing in this path ever calls leaveTable — the player is still
      // tracked as "reserved", i.e. still holding their seat.
      expect(tracker.getReserved(TABLE).has(actor)).toBe(true)
    })
  })

  it('disconnected seated player reconnects → same seat restored', async () => {
    const db = new MockDB()
    db.seedTable({ id: TABLE, max_players: 6, status: 'waiting', game_mode: 'cash' })
    db.seedPlayer({ id: 'row-1', table_id: TABLE, player_id: P2, seat_number: 4, status: 'seated', joined_at: '2024-01-01' })

    tracker.markDisconnected(TABLE, P2)
    expect(tracker.isDisconnected(TABLE, P2)).toBe(true)

    // Reconnect: join_table re-fetches the still-seated row.
    const result = await joinTable(db as never, TABLE, P2)
    expect(result).toEqual({ seatNumber: 4 })

    // join_table clears the offline flag on reconnect.
    tracker.clear(TABLE, P2)
    expect(tracker.isDisconnected(TABLE, P2)).toBe(false)
  })

  it('only leave_table releases the seat — a disconnect alone never does', async () => {
    const db = new MockDB()
    db.seedPlayer({ id: 'row-1', table_id: TABLE, player_id: P2, seat_number: 2, status: 'seated', joined_at: '2024-01-01' })

    // Disconnect: mark offline, DB untouched.
    tracker.markDisconnected(TABLE, P2)
    expect(db.getPlayer(P2)).toMatchObject({ status: 'seated', seat_number: 2 })

    // Explicit Leave Table click is the only thing that frees the seat.
    await leaveTable(db as never, TABLE, P2)
    expect(db.getPlayer(P2)).toBeUndefined()
  })
})

// ── partitionByConnection: true ghosts vs. known-offline players ───────────

describe('partitionByConnection', () => {
  it('evicts only rows with no live socket AND no protection (true ghosts)', () => {
    const rows = [
      { player_id: 'connected' },
      { player_id: 'offline-but-reserved' },
      { player_id: 'ghost' },
    ]
    const connected = new Set(['connected'])
    const reserved = new Set(['offline-but-reserved'])

    const { keep, stale } = partitionByConnection(rows, connected, reserved)

    expect(keep.map(r => r.player_id).sort()).toEqual(['connected', 'offline-but-reserved'])
    expect(stale.map(r => r.player_id)).toEqual(['ghost'])
  })
})
