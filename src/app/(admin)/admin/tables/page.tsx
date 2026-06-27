import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import CreateTableForm from './CreateTableForm'
import DeleteTableButton from './DeleteTableButton'
import { closeTableAction, reopenTableAction } from '@/app/actions/tables'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  table_type: 'timer' | 'open'
  status: 'waiting' | 'active' | 'closed'
  created_at: string
}

const statusBadge: Record<TableRow['status'], string> = {
  waiting:
    'inline-flex items-center rounded-full bg-amber-900/40 px-2.5 py-0.5 text-xs font-semibold text-amber-400 border border-amber-800/50',
  active:
    'inline-flex items-center rounded-full bg-emerald-900/40 px-2.5 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-800/50',
  closed:
    'inline-flex items-center rounded-full bg-zinc-800/60 px-2.5 py-0.5 text-xs font-semibold text-zinc-500 border border-zinc-700/50',
}

const typeBadge: Record<TableRow['table_type'], string> = {
  timer:
    'inline-flex items-center rounded-full bg-sky-900/40 px-2.5 py-0.5 text-xs font-semibold text-sky-400 border border-sky-800/50',
  open:
    'inline-flex items-center rounded-full bg-violet-900/40 px-2.5 py-0.5 text-xs font-semibold text-violet-400 border border-violet-800/50',
}

export default async function AdminTablesPage() {
  const adminClient = createAdminClient()

  const { data } = await adminClient
    .from('poker_tables')
    .select('id, name, small_blind, big_blind, max_players, table_type, status, created_at')
    .order('created_at', { ascending: false })

  const tables = (data as TableRow[] | null) ?? []

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight">Tables</h1>
          <Link
            href="/admin/dashboard"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-200"
          >
            ← Dashboard
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <h2 className="font-semibold text-zinc-100">
              All Tables
              {tables.length > 0 && (
                <span className="ml-2 text-sm font-normal text-zinc-500">
                  ({tables.length})
                </span>
              )}
            </h2>
          </div>

          {tables.length === 0 ? (
            <p className="px-5 py-6 text-sm text-zinc-500">No tables yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-800/60">
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Name</th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">Blinds</th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">Max</th>
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Type</th>
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Status</th>
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Created</th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {tables.map((t) => {
                    const closeAction = closeTableAction.bind(null, t.id)
                    const reopenAction = reopenTableAction.bind(null, t.id)
                    return (
                      <tr
                        key={t.id}
                        className="transition-colors hover:bg-zinc-800/40"
                      >
                        <td className="px-5 py-3 font-medium text-zinc-100">{t.name}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-300">
                          {t.small_blind}/{t.big_blind}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-300">
                          {t.max_players}
                        </td>
                        <td className="px-5 py-3">
                          <span className={typeBadge[t.table_type]}>{t.table_type}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className={statusBadge[t.status]}>{t.status}</span>
                        </td>
                        <td className="px-5 py-3 text-zinc-500">
                          {new Date(t.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="inline-flex items-center gap-2">
                            {t.status !== 'closed' ? (
                              <form action={closeAction} className="inline">
                                <button
                                  type="submit"
                                  className="rounded px-2.5 py-1 text-xs font-semibold text-zinc-400 border border-zinc-700/60 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                                >
                                  Close
                                </button>
                              </form>
                            ) : (
                              <form action={reopenAction} className="inline">
                                <button
                                  type="submit"
                                  className="rounded px-2.5 py-1 text-xs font-semibold text-emerald-400 border border-emerald-900/50 transition-colors hover:bg-emerald-900/30"
                                >
                                  Reopen
                                </button>
                              </form>
                            )}
                            <DeleteTableButton tableId={t.id} tableName={t.name} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <CreateTableForm />
      </div>
    </main>
  )
}
