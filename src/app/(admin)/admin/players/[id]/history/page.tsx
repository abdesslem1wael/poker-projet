import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import DeleteTransactionButton from './DeleteTransactionButton'

type TransactionRow = {
  id: string
  amount: number
  type: 'credit' | 'debit'
  note: string | null
  created_at: string
}

export default async function PlayerHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: playerId } = await params
  const adminClient = createAdminClient()

  const { data: profileData } = await adminClient
    .from('profiles')
    .select('id, username')
    .eq('id', playerId)
    .single()

  const profile = profileData as { id: string; username: string } | null
  if (!profile) notFound()

  const { data } = await adminClient
    .from('transactions')
    .select('id, amount, type, note, created_at')
    .eq('user_id', playerId)
    .in('type', ['credit', 'debit'])
    .order('created_at', { ascending: false })

  const history = (data as TransactionRow[] | null) ?? []

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight">
            {profile.username} — Chip History
          </h1>
          <Link
            href="/admin/players"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-200"
          >
            ← Players
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <h2 className="font-semibold text-zinc-100">
              Top-ups &amp; Deductions
              {history.length > 0 && (
                <span className="ml-2 text-sm font-normal text-zinc-500">
                  ({history.length})
                </span>
              )}
            </h2>
          </div>

          {history.length === 0 ? (
            <p className="px-5 py-6 text-sm text-zinc-500">
              No chip adjustments recorded for this player yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-800/60">
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Time</th>
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Type</th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">Amount</th>
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">Note</th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {history.map((tx) => (
                    <tr key={tx.id} className="transition-colors hover:bg-zinc-800/40">
                      <td className="px-5 py-3 text-zinc-400 whitespace-nowrap">
                        {new Date(tx.created_at).toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={
                            tx.type === 'credit'
                              ? 'rounded px-2 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-900/50 bg-emerald-900/20'
                              : 'rounded px-2 py-0.5 text-xs font-semibold text-red-400 border border-red-900/50 bg-red-900/20'
                          }
                        >
                          {tx.type === 'credit' ? 'Top-up' : 'Deduction'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-300">
                        {tx.type === 'credit' ? '+' : '-'}
                        {tx.amount.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-zinc-500">{tx.note ?? '—'}</td>
                      <td className="px-5 py-3 text-right">
                        <DeleteTransactionButton transactionId={tx.id} playerId={playerId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
