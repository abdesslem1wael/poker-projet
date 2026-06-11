import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import CreateTableForm from './CreateTableForm'
import { closeTableAction, reopenTableAction } from '@/app/actions/tables'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  status: 'waiting' | 'active' | 'closed'
  created_at: string
}

const statusBadge: Record<TableRow['status'], string> = {
  waiting:
    'inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  active:
    'inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400',
  closed:
    'inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
}

export default async function AdminTablesPage() {
  const adminClient = createAdminClient()

  const { data } = await adminClient
    .from('poker_tables')
    .select('id, name, small_blind, big_blind, max_players, status, created_at')
    .order('created_at', { ascending: false })

  const tables = (data as TableRow[] | null) ?? []

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tables</h1>
        <Link
          href="/admin/dashboard"
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Dashboard
        </Link>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">All Tables</h2>
        {tables.length === 0 ? (
          <p className="text-sm text-zinc-500">No tables yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Name
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-zinc-600 dark:text-zinc-400">
                    Blinds
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-zinc-600 dark:text-zinc-400">
                    Max
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Created
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-zinc-600 dark:text-zinc-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {tables.map((t) => {
                  const closeAction = closeTableAction.bind(null, t.id)
                  const reopenAction = reopenTableAction.bind(null, t.id)
                  return (
                    <tr
                      key={t.id}
                      className="transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    >
                      <td className="px-4 py-3 font-medium">{t.name}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        {t.small_blind}/{t.big_blind}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        {t.max_players}
                      </td>
                      <td className="px-4 py-3">
                        <span className={statusBadge[t.status]}>{t.status}</span>
                      </td>
                      <td className="px-4 py-3 text-zinc-500">
                        {new Date(t.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {t.status !== 'closed' ? (
                          <form action={closeAction} className="inline">
                            <button
                              type="submit"
                              className="rounded px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                            >
                              Close
                            </button>
                          </form>
                        ) : (
                          <form action={reopenAction} className="inline">
                            <button
                              type="submit"
                              className="rounded px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                            >
                              Reopen
                            </button>
                          </form>
                        )}
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
    </main>
  )
}
