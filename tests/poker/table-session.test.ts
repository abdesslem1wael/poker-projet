import { describe, it, expect } from 'vitest'
import { cleanupTableSeats, joinTable, getTableState } from '../../src/lib/socket/table-session'

// ── In-memory Supabase mock ────────────────────────────────────────────────

type Row = Record<string, unknown>

// A minimal query builder that is also awaitable (thenable).
// Chains: .select().eq().neq().order() → { data, error } on await.
// Terminal: .single() / .maybySingle() return { data, error } directly.
class QueryBuilder {
  private _rows: Row[]
  private _filters: Array<(r: Row) => boolean> = []

  constructor(rows: Row[]) {
    this._rows = rows
  }

  select(_cols: string): this { return this }

  order(col: string, opts?: { ascending?: boolean }): this {
    const asc = opts?.ascending !== false
    this._rows.sort((a, b) => {
      const av = String(a[col] ?? '')
      const bv = String(b[col] ?? '')
      return asc ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return this
  }

  eq(col: string, val: unknown): this {
    this._filters.push(r => r[col] === val)
    return this
  }

  neq(col: string, val: unknown): this {
    this._filters.push(r => r[col] !== val)
    return this
  }

  in(col: string, vals: unknown[]): this {
    this._filters.push(r => vals.includes(r[col]))
    return this
  }

  private filtered(): Row[] {
    return this._rows.filter(r => this._filters.every(f => f(r)))
  }

  async single() { return { data: this.filtered()[0] ?? null, error: null } }
  async maybySingle() { return { data: this.filtered()[0] ?? null, error: null } }
  async maybeSingle() { return { data: this.filtered()[0] ?? null, error: null } }

  // Makes the builder thenable so `await builder` works without a terminal call.
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.filtered(), error: null })
  }
}

type UpdateBuilder = {
  eq: (col: string, val: unknown) => UpdateBuilder
  neq: (col: string, val: unknown) => UpdateBuilder
  in: (col: string, vals: unknown[]) => UpdateBuilder & Promise<{ error: null }>
  then: (resolve: (v: { error: null }) => void) => void
}

// Stateful in-memory Supabase mock.
class MockDB {
  private _tableRows: Row[] = []
  private _playerRows: Row[] = []
  private _profileRows: Row[] = []
  markedLeft: string[] = []   // ids passed to update({status:'left'})
  insertCalls: Row[] = []
  insertError: { message: string } | null = null

  seedTable(row: Row) { this._tableRows.push(row) }
  seedPlayer(row: Row) { this._playerRows.push(row) }
  seedProfile(row: Row) { this._profileRows.push(row) }

  from(table: string) {
    if (table === 'poker_tables') {
      return new QueryBuilder(this._tableRows)
    }
    if (table === 'profiles') {
      return new QueryBuilder(this._profileRows)
    }
    if (table === 'table_players') {
      const rows = this._playerRows
      const markedLeft = this.markedLeft
      const insertCalls = this.insertCalls
      const insertErr = () => this.insertError
      const pushPlayer = (row: Row) => this._playerRows.push(row)
      return {
        select: (cols: string) => new QueryBuilder(rows).select(cols),
        insert: (row: Row) => {
          const err = insertErr()
          if (err) return Promise.resolve({ error: err })
          insertCalls.push(row)
          pushPlayer({ id: `new-${Date.now()}`, joined_at: new Date().toISOString(), ...row })
          return Promise.resolve({ error: null })
        },
        update: (_fields: Row) => {
          const captured = _fields
          const updateFilters: Array<(r: Row) => boolean> = []
          const applyUpdate = () => {
            const matched = rows.filter(r => updateFilters.every(f => f(r)))
            for (const r of matched) {
              Object.assign(r, captured)
              if ('status' in captured && captured.status === 'left') {
                markedLeft.push(r.id as string)
              }
            }
          }
          const ub: UpdateBuilder = {
            eq: (col, val) => { updateFilters.push(r => r[col] === val); return ub },
            neq: (col, val) => { updateFilters.push(r => r[col] !== val); return ub },
            in: (col, vals) => {
              updateFilters.push(r => (vals as unknown[]).includes(r[col]))
              return Object.assign(ub, {
                then: (resolve: (v: { error: null }) => void) => {
                  applyUpdate()
                  resolve({ error: null })
                }
              }) as UpdateBuilder & Promise<{ error: null }>
            },
            then: (resolve: (v: { error: null }) => void) => {
              applyUpdate()
              resolve({ error: null })
            }
          } as UpdateBuilder
          return ub
        }
      }
    }
    return new QueryBuilder([])
  }
}

// ── cleanupTableSeats ──────────────────────────────────────────────────────

const TABLE = 'table-abc'

describe('cleanupTableSeats', () => {
  it('does nothing when there are no duplicates', async () => {
    const db = new MockDB()
    db.seedPlayer({ id: '1', table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })
    db.seedPlayer({ id: '2', table_id: TABLE, player_id: 'p2', seat_number: 2, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })

    const cleaned = await cleanupTableSeats(db as never, TABLE)
    expect(cleaned).toBe(0)
    expect(db.markedLeft).toHaveLength(0)
  })

  it('marks the older duplicate player row as left', async () => {
    const db = new MockDB()
    // Same player_id appears twice (simulating a constraint bypass or pre-existing bug)
    db.seedPlayer({ id: 'old', table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'seated', joined_at: '2024-01-01T09:00:00Z' })
    db.seedPlayer({ id: 'new', table_id: TABLE, player_id: 'p1', seat_number: 2, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })

    const cleaned = await cleanupTableSeats(db as never, TABLE)
    expect(cleaned).toBe(1)
    // The older row should be evicted (rows ordered newest-first, so 'old' is second)
    expect(db.markedLeft).toContain('old')
    expect(db.markedLeft).not.toContain('new')
  })

  it('marks the older duplicate seat row as left', async () => {
    const db = new MockDB()
    // Two different players claim the same seat
    db.seedPlayer({ id: 'ghost', table_id: TABLE, player_id: 'p-ghost', seat_number: 1, status: 'seated', joined_at: '2024-01-01T09:00:00Z' })
    db.seedPlayer({ id: 'real',  table_id: TABLE, player_id: 'p-real',  seat_number: 1, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })

    const cleaned = await cleanupTableSeats(db as never, TABLE)
    expect(cleaned).toBe(1)
    expect(db.markedLeft).toContain('ghost')
    expect(db.markedLeft).not.toContain('real')
  })

  it('ignores already-left rows', async () => {
    const db = new MockDB()
    db.seedPlayer({ id: '1', table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'left', joined_at: '2024-01-01T09:00:00Z' })
    db.seedPlayer({ id: '2', table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })

    const cleaned = await cleanupTableSeats(db as never, TABLE)
    // The left row is excluded from the query; no conflict detected.
    expect(cleaned).toBe(0)
  })
})

// ── joinTable ──────────────────────────────────────────────────────────────

describe('joinTable', () => {
  function tableRow(overrides: Partial<Row> = {}): Row {
    return { id: TABLE, max_players: 6, status: 'waiting', ...overrides }
  }

  it('inserts a new row and returns the assigned seat', async () => {
    const db = new MockDB()
    db.seedTable(tableRow())
    // No existing players.

    const result = await joinTable(db as never, TABLE, 'user-1')
    expect(result).toEqual({ seatNumber: 1 })
    expect(db.insertCalls).toHaveLength(1)
    expect(db.insertCalls[0]).toMatchObject({ player_id: 'user-1', seat_number: 1 })
  })

  it('returns existing seat without a new insert when user is already seated', async () => {
    const db = new MockDB()
    db.seedTable(tableRow())
    db.seedPlayer({ id: 'row1', table_id: TABLE, player_id: 'user-1', seat_number: 3, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })

    const result = await joinTable(db as never, TABLE, 'user-1')
    expect(result).toEqual({ seatNumber: 3 })
    expect(db.insertCalls).toHaveLength(0)
  })

  it('never returns another users seat on insert conflict', async () => {
    const db = new MockDB()
    db.seedTable(tableRow())
    // Simulate unique-constraint failure on insert.
    db.insertError = { message: 'duplicate key value violates unique constraint' }
    // After the conflict the re-fetch finds THIS user's row (inserted by a parallel request).
    db.seedPlayer({ id: 'my-row', table_id: TABLE, player_id: 'user-1', seat_number: 2, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })

    const result = await joinTable(db as never, TABLE, 'user-1')
    expect(result).toEqual({ seatNumber: 2 })
  })

  it('returns error when the table is closed', async () => {
    const db = new MockDB()
    db.seedTable(tableRow({ status: 'closed' }))

    const result = await joinTable(db as never, TABLE, 'user-1')
    expect(result).toHaveProperty('error', 'Table is closed')
  })

  it('returns error when the table is full', async () => {
    const db = new MockDB()
    db.seedTable(tableRow({ max_players: 2 }))
    db.seedPlayer({ id: 'r1', table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'seated', joined_at: '2024-01-01' })
    db.seedPlayer({ id: 'r2', table_id: TABLE, player_id: 'p2', seat_number: 2, status: 'seated', joined_at: '2024-01-01' })

    const result = await joinTable(db as never, TABLE, 'user-new')
    expect(result).toHaveProperty('error', 'Table is full')
  })
})

// ── getTableState ──────────────────────────────────────────────────────────

describe('getTableState', () => {
  it('does not include left rows in table state', async () => {
    const db = new MockDB()
    db.seedTable({ id: TABLE, name: 'Test', small_blind: 5, big_blind: 10, max_players: 6, table_type: 'open', status: 'waiting' })
    db.seedPlayer({ id: 'r1', table_id: TABLE, player_id: 'ghost', seat_number: 1, status: 'left' })
    db.seedPlayer({ id: 'r2', table_id: TABLE, player_id: 'real',  seat_number: 2, status: 'seated' })
    db.seedProfile({ id: 'ghost', username: 'Ghost', avatar_id: null })
    db.seedProfile({ id: 'real',  username: 'Real',  avatar_id: null })

    const state = await getTableState(db as never, TABLE)
    const occupiedSeats = state!.seats.filter(s => s.playerId != null)
    expect(occupiedSeats).toHaveLength(1)
    expect(occupiedSeats[0].playerId).toBe('real')
  })

  it('after cleanupTableSeats, duplicate player rows produce a clean state', async () => {
    const db = new MockDB()
    db.seedTable({ id: TABLE, name: 'Test', small_blind: 5, big_blind: 10, max_players: 6, table_type: 'open', status: 'waiting' })
    // Ghost row (older) + real row (newer) for the same player at different seats.
    db.seedPlayer({ id: 'ghost-row', table_id: TABLE, player_id: 'p1', seat_number: 1, status: 'seated', joined_at: '2024-01-01T09:00:00Z' })
    db.seedPlayer({ id: 'real-row',  table_id: TABLE, player_id: 'p1', seat_number: 2, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })
    db.seedProfile({ id: 'p1', username: 'Wael', avatar_id: null })

    // cleanupTableSeats marks the older duplicate as left.
    await cleanupTableSeats(db as never, TABLE)

    const state = await getTableState(db as never, TABLE)
    const occupiedSeats = state!.seats.filter(s => s.playerId != null)
    // Only the newer row (seat 2) should remain.
    expect(occupiedSeats).toHaveLength(1)
    expect(occupiedSeats[0].seatNumber).toBe(2)
    expect(occupiedSeats[0].playerId).toBe('p1')
  })

  it('does not include duplicate seat numbers after cleanup', async () => {
    const db = new MockDB()
    db.seedTable({ id: TABLE, name: 'Test', small_blind: 5, big_blind: 10, max_players: 6, table_type: 'open', status: 'waiting' })
    db.seedPlayer({ id: 'old', table_id: TABLE, player_id: 'p-ghost', seat_number: 1, status: 'seated', joined_at: '2024-01-01T09:00:00Z' })
    db.seedPlayer({ id: 'new', table_id: TABLE, player_id: 'p-real',  seat_number: 1, status: 'seated', joined_at: '2024-01-01T10:00:00Z' })
    db.seedProfile({ id: 'p-ghost', username: 'Ghost', avatar_id: null })
    db.seedProfile({ id: 'p-real',  username: 'Real',  avatar_id: null })

    await cleanupTableSeats(db as never, TABLE)

    const state = await getTableState(db as never, TABLE)
    const occupiedSeats = state!.seats.filter(s => s.playerId != null)
    expect(occupiedSeats).toHaveLength(1)
    expect(occupiedSeats[0].playerId).toBe('p-real')
  })
})
