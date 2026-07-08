import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import SessionPanel from './SessionPanel'
import WatchTablesPanel from './WatchTablesPanel'
import DeleteTipsButton from './DeleteTipsButton'
import type { LiveTable } from './WatchTablesPanel'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  status: 'waiting' | 'active' | 'closed'
}

type GameHistoryRow = {
  table_id: string
  result_json: { tipAmount?: number } | null
}

type DealerTipRow = {
  table_id: string | null
  amount: number
  archived: boolean
  deleted_table_id: string | null
  deleted_table_name: string | null
}

type TipSummary = {
  groupKey: string
  tableName: string
  tableStatus: TableRow['status'] | null
  isDeleted: boolean
  autoTips: number
  dealerTips: number
  total: number
}

async function fetchDashboardData() {
  const adminClient = createAdminClient()

  const [tablesRes, historyRes, dealerTipsRes] = await Promise.all([
    adminClient
      .from('poker_tables')
      .select('id, name, small_blind, big_blind, status')
      .order('created_at', { ascending: false }),
    adminClient.from('game_history').select('table_id, result_json'),
    adminClient
      .from('dealer_tips')
      .select('table_id, amount, archived, deleted_table_id, deleted_table_name'),
  ])

  const tables = (tablesRes.data as TableRow[] | null) ?? []

  const liveTables: LiveTable[] = tables
    .filter((t) => t.status === 'waiting' || t.status === 'active')
    .map((t) => ({
      id: t.id,
      name: t.name,
      small_blind: t.small_blind,
      big_blind: t.big_blind,
      status: t.status as 'waiting' | 'active',
    }))

  const autoTipsMap = new Map<string, number>()
  for (const row of (historyRes.data as GameHistoryRow[] | null) ?? []) {
    const tip = Number(row.result_json?.tipAmount ?? 0)
    if (tip > 0) autoTipsMap.set(row.table_id, (autoTipsMap.get(row.table_id) ?? 0) + tip)
  }

  // Tips are grouped by table_id while the table still exists; once a table
  // is deleted its dealer_tips rows are archived (table_id -> NULL,
  // deleted_table_id/name captured), so they're grouped by that instead.
  const dealerTipsMap = new Map<string, number>()
  const archivedNames = new Map<string, string>()
  for (const row of (dealerTipsRes.data as DealerTipRow[] | null) ?? []) {
    const key = row.table_id ?? row.deleted_table_id
    if (!key) continue
    dealerTipsMap.set(key, (dealerTipsMap.get(key) ?? 0) + row.amount)
    if (row.archived && row.deleted_table_name) archivedNames.set(key, row.deleted_table_name)
  }

  const tipSummaries: TipSummary[] = tables.map((t) => {
    const autoTips = autoTipsMap.get(t.id) ?? 0
    const dealerTips = dealerTipsMap.get(t.id) ?? 0
    return {
      groupKey: t.id,
      tableName: t.name,
      tableStatus: t.status,
      isDeleted: false,
      autoTips,
      dealerTips,
      total: autoTips + dealerTips,
    }
  })

  // Archived groups belong to tables that no longer exist in poker_tables.
  const liveKeys = new Set(tables.map((t) => t.id))
  for (const [key, name] of archivedNames) {
    if (liveKeys.has(key)) continue
    const dealerTips = dealerTipsMap.get(key) ?? 0
    tipSummaries.push({
      groupKey: key,
      tableName: name,
      tableStatus: null,
      isDeleted: true,
      autoTips: 0,
      dealerTips,
      total: dealerTips,
    })
  }

  return { liveTables, tipSummaries }
}

const statusDot: Record<TableRow['status'], string> = {
  waiting: '#f59e0b',
  active:  '#22c55e',
  closed:  '#52525b',
}

export default async function AdminDashboardPage() {
  const { liveTables, tipSummaries } = await fetchDashboardData()
  const grandTotal = tipSummaries.reduce((sum, t) => sum + t.total, 0)
  const tablesWithTips = tipSummaries.filter((t) => t.total > 0)

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight">Management</h1>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-10 px-6 py-8">

        {/* ── Watch Live Tables ──────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Live Tables
          </h2>
          <p className="mb-4 text-sm text-zinc-600">Watch any active table as a spectator.</p>
          <WatchTablesPanel tables={liveTables} />
        </section>

        {/* ── Live session management ────────────────────────────────────── */}
        <SessionPanel />

        {/* ── Navigation cards ──────────────────────────────────────────── */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Management
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Link
              href="/admin/players"
              className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
            >
              <div className="mb-3 text-2xl">👤</div>
              <h3 className="font-semibold text-zinc-100 group-hover:text-white">Players</h3>
              <p className="mt-1 text-sm text-zinc-500">View profiles, adjust chip balances, manage roles.</p>
            </Link>
            <Link
              href="/admin/tables"
              className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
            >
              <div className="mb-3 text-2xl">🃏</div>
              <h3 className="font-semibold text-zinc-100 group-hover:text-white">Tables</h3>
              <p className="mt-1 text-sm text-zinc-500">Create, configure, and close poker tables.</p>
            </Link>
          </div>
        </section>

        {/* ── Tips Summary ──────────────────────────────────────────────── */}
        <section>
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Tips Collected
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Automatic rake (5.5%) + voluntary dealer tips, per table.
              </p>
            </div>
            {grandTotal > 0 && (
              <div
                className="rounded-xl px-5 py-3 text-right"
                style={{ background: '#0d2011', border: '1px solid #14532d' }}
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-emerald-600">
                  All Tables
                </p>
                <p className="mt-0.5 text-2xl font-extrabold tabular-nums text-emerald-400">
                  {grandTotal.toLocaleString()}
                </p>
                <p className="text-xs text-zinc-600">total chips</p>
              </div>
            )}
          </div>

          {tipSummaries.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-600">No tables found.</p>
          ) : tablesWithTips.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-600">No tips collected yet.</p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tipSummaries.map((t) => (
                <div
                  key={t.groupKey}
                  className="rounded-xl p-5"
                  style={{
                    background: '#0b111e',
                    border: t.total > 0 ? '1px solid #1e3a28' : '1px solid #1e293b',
                  }}
                >
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: t.isDeleted ? '#71717a' : statusDot[t.tableStatus!],
                          flexShrink: 0,
                        }}
                      />
                      <span className="truncate font-semibold text-zinc-100">{t.tableName}</span>
                    </div>
                    {t.isDeleted ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-red-900/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400 border border-red-900/50">
                        Table deleted
                      </span>
                    ) : (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-800/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 border border-zinc-700/50">
                        {t.tableStatus === 'closed' ? 'Closed table' : 'Active table'}
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-500">Auto rake (3%)</span>
                      <span className="tabular-nums font-medium text-zinc-300">
                        {t.autoTips > 0 ? t.autoTips.toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-500">Dealer tips</span>
                      <span className="tabular-nums font-medium text-zinc-300">
                        {t.dealerTips > 0 ? t.dealerTips.toLocaleString() : '—'}
                      </span>
                    </div>
                    <div
                      className="mt-3 flex items-center justify-between rounded-lg px-3 py-2"
                      style={{ background: t.total > 0 ? '#0d2011' : '#111827' }}
                    >
                      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Total
                      </span>
                      <span
                        className="text-lg font-extrabold tabular-nums"
                        style={{ color: t.total > 0 ? '#4ade80' : '#374151' }}
                      >
                        {t.total > 0 ? t.total.toLocaleString() : '0'}
                      </span>
                    </div>
                    {t.dealerTips > 0 && (
                      <div className="flex justify-end pt-1">
                        <DeleteTipsButton
                          groupKey={t.groupKey}
                          archived={t.isDeleted}
                          tableName={t.tableName}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tipSummaries.some((t) => t.total === 0) && tablesWithTips.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-zinc-700">
                No tips yet:{' '}
                {tipSummaries
                  .filter((t) => t.total === 0)
                  .map((t) => t.tableName)
                  .join(', ')}
              </p>
            </div>
          )}
        </section>

      </div>
    </main>
  )
}
