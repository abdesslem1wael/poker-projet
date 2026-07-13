import { describe, it, expect } from 'vitest'
import { seatAllSitGoRegistrants } from '../../src/lib/socket/table-session'

// ── Minimal Supabase mock tailored to seatAllSitGoRegistrants ──────────────
//
// Distinct from the shared MockDB in table-session.test.ts because this
// needs per-player insert-conflict simulation (to reproduce the exact
// concurrent-seating race that caused the reported duplicate-key crash),
// which the shared bulk-insert-oriented mock doesn't support.

type Row = Record<string, unknown>

class TablePlayersBuilder {
  private filters: Array<(r: Row) => boolean> = []
  constructor(private rows: Row[]) {}

  eq(col: string, val: unknown): this { this.filters.push(r => r[col] === val); return this }
  neq(col: string, val: unknown): this { this.filters.push(r => r[col] !== val); return this }

  private filtered(): Row[] { return this.rows.filter(r => this.filters.every(f => f(r))) }

  async maybeSingle() { return { data: this.filtered()[0] ?? null, error: null } }

  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.filtered(), error: null })
  }
}

class MockDB {
  registrations: Row[] = []
  players: Row[] = []
  insertCalls: Row[] = []
  updateCalls: Row[] = []
  private nextRowId = 1

  // player_id -> simulates a concurrent process winning the insert race for
  // that player: the insert this function attempts fails with a unique-
  // constraint error, AND a "concurrently inserted" row (as if a different
  // process committed first) appears for the retry-read to find.
  raceWinnerSeat = new Map<string, number>()

  seedRegistration(playerId: string, registeredAt: string) {
    this.registrations.push({ table_id: TABLE, player_id: playerId, registered_at: registeredAt })
  }

  seedPlayer(row: Row) {
    this.players.push({ id: `seed-${this.nextRowId++}`, ...row })
  }

  from(table: string) {
    if (table === 'sit_go_registrations') {
      const rows = this.registrations
      return {
        select: (_cols: string) => ({
          eq: (col: string, val: unknown) => ({
            order: async (sortCol: string) => {
              const filtered = rows.filter(r => r[col] === val)
              filtered.sort((a, b) => String(a[sortCol]).localeCompare(String(b[sortCol])))
              return { data: filtered, error: null }
            },
          }),
        }),
      }
    }

    if (table === 'table_players') {
      const self = this
      return {
        select: (_cols: string) => new TablePlayersBuilder(self.players),
        insert: (row: Row) => {
          const playerId = row.player_id as string
          if (self.raceWinnerSeat.has(playerId)) {
            const seat = self.raceWinnerSeat.get(playerId)!
            self.raceWinnerSeat.delete(playerId)
            // Simulate the concurrent winner's row landing in the DB.
            self.players.push({ id: `race-${self.nextRowId++}`, table_id: TABLE, player_id: playerId, seat_number: seat, status: 'seated' })
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint "table_players_active_seat"' } })
          }
          self.insertCalls.push(row)
          self.players.push({ id: `row-${self.nextRowId++}`, ...row })
          return Promise.resolve({ error: null })
        },
        update: (fields: Row) => ({
          eq: (col: string, val: unknown) => {
            const matched = self.players.filter(r => r[col] === val)
            for (const r of matched) Object.assign(r, fields)
            self.updateCalls.push({ ...fields, _matchedRowId: matched[0]?.id })
            return Promise.resolve({ error: null })
          },
        }),
      }
    }

    throw new Error(`Unexpected table in mock: ${table}`)
  }
}

const TABLE = 'sitgo-table-1'

function seatedRows(db: MockDB) {
  return db.players.filter(r => r.status === 'seated' && r.table_id === TABLE)
}

describe('seatAllSitGoRegistrants', () => {
  it('seats all registered players when none are seated yet', async () => {
    const db = new MockDB()
    db.seedRegistration('p1', '2024-01-01T10:00:00Z')
    db.seedRegistration('p2', '2024-01-01T10:01:00Z')
    db.seedRegistration('p3', '2024-01-01T10:02:00Z')

    await seatAllSitGoRegistrants(db as never, TABLE)

    const seats = seatedRows(db)
    expect(seats).toHaveLength(3)
    expect(new Set(seats.map(r => r.seat_number))).toEqual(new Set([1, 2, 3]))
    expect(new Set(seats.map(r => r.player_id))).toEqual(new Set(['p1', 'p2', 'p3']))
  })

  it('keeps an already-seated player\'s seat and seats the rest', async () => {
    const db = new MockDB()
    db.seedRegistration('p1', '2024-01-01T10:00:00Z')
    db.seedRegistration('p2', '2024-01-01T10:01:00Z')
    db.seedRegistration('p3', '2024-01-01T10:02:00Z')
    // p2 is already seated at seat 5 (e.g. the legacy manual "Enter Table" path landed first).
    db.seedPlayer({ table_id: TABLE, player_id: 'p2', seat_number: 5, status: 'seated' })

    await seatAllSitGoRegistrants(db as never, TABLE)

    const seats = seatedRows(db)
    expect(seats).toHaveLength(3)
    const p2 = seats.find(r => r.player_id === 'p2')
    expect(p2?.seat_number).toBe(5)  // untouched — no re-insert, no reassignment
    // p1 and p3 get real seats, neither colliding with p2's seat 5.
    const others = seats.filter(r => r.player_id !== 'p2').map(r => r.seat_number)
    expect(others).not.toContain(5)
    expect(new Set(others).size).toBe(2)
    // Only p1 and p3 triggered an insert — p2 was reused, not re-created.
    expect(db.insertCalls.map(r => r.player_id).sort()).toEqual(['p1', 'p3'])
  })

  it('upgrades an active-but-not-seated registrant (e.g. spectating) instead of inserting a second row', async () => {
    const db = new MockDB()
    db.seedRegistration('p1', '2024-01-01T10:00:00Z')
    db.seedRegistration('p2', '2024-01-01T10:01:00Z')
    db.seedPlayer({ table_id: TABLE, player_id: 'p1', seat_number: null, status: 'spectating' })

    await seatAllSitGoRegistrants(db as never, TABLE)

    // p1's existing row was updated in place, not duplicated.
    const p1Rows = db.players.filter(r => r.player_id === 'p1')
    expect(p1Rows).toHaveLength(1)
    expect(p1Rows[0].status).toBe('seated')
    expect(p1Rows[0].seat_number).toEqual(expect.any(Number))
    expect(db.insertCalls.map(r => r.player_id)).not.toContain('p1')
    expect(db.updateCalls).toHaveLength(1)
  })

  it('running twice does not crash or duplicate seats (idempotent)', async () => {
    const db = new MockDB()
    db.seedRegistration('p1', '2024-01-01T10:00:00Z')
    db.seedRegistration('p2', '2024-01-01T10:01:00Z')
    db.seedRegistration('p3', '2024-01-01T10:02:00Z')

    await seatAllSitGoRegistrants(db as never, TABLE)
    const afterFirst = seatedRows(db).length
    expect(afterFirst).toBe(3)

    await expect(seatAllSitGoRegistrants(db as never, TABLE)).resolves.not.toThrow()

    const afterSecond = seatedRows(db)
    expect(afterSecond).toHaveLength(3)  // no new rows, nothing duplicated
    expect(db.insertCalls).toHaveLength(3)  // still only the original 3 inserts ever happened
  })

  it('never produces a duplicate seat_number among seated rows', async () => {
    const db = new MockDB()
    for (let i = 1; i <= 6; i++) db.seedRegistration(`p${i}`, `2024-01-01T10:0${i}:00Z`)
    // p3 already holds seat 2 from an earlier manual join.
    db.seedPlayer({ table_id: TABLE, player_id: 'p3', seat_number: 2, status: 'seated' })

    await seatAllSitGoRegistrants(db as never, TABLE)

    const seats = seatedRows(db).map(r => r.seat_number)
    expect(seats).toHaveLength(6)
    expect(new Set(seats).size).toBe(6)  // no duplicates
  })

  it('never produces a duplicate active row for the same player', async () => {
    const db = new MockDB()
    db.seedRegistration('p1', '2024-01-01T10:00:00Z')
    db.seedRegistration('p2', '2024-01-01T10:01:00Z')
    db.seedPlayer({ table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'seated' })

    await seatAllSitGoRegistrants(db as never, TABLE)
    await seatAllSitGoRegistrants(db as never, TABLE)

    for (const playerId of ['p1', 'p2']) {
      const active = db.players.filter(r => r.player_id === playerId && r.status !== 'left')
      expect(active).toHaveLength(1)
    }
  })

  it('recovers from a concurrent insert conflict without crashing or losing other seats', async () => {
    const db = new MockDB()
    db.seedRegistration('p1', '2024-01-01T10:00:00Z')
    db.seedRegistration('p2', '2024-01-01T10:01:00Z')
    db.seedRegistration('p3', '2024-01-01T10:02:00Z')
    // Simulate a concurrent caller (periodic sweep, or the legacy manual
    // join path) winning the race to seat p2 at seat 9, in between this
    // call's read of existing rows and its insert attempt.
    db.raceWinnerSeat.set('p2', 9)

    await expect(seatAllSitGoRegistrants(db as never, TABLE)).resolves.not.toThrow()

    const seats = seatedRows(db)
    // p1 and p3 still get seated by this call; p2 ends up seated exactly
    // once, at the concurrent winner's seat — never duplicated or dropped.
    expect(seats.filter(r => r.player_id === 'p2')).toHaveLength(1)
    expect(seats.find(r => r.player_id === 'p2')?.seat_number).toBe(9)
    expect(seats.map(r => r.player_id).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(new Set(seats.map(r => r.seat_number)).size).toBe(3)
  })
})
