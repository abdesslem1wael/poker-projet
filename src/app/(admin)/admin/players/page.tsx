import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import CreatePlayerForm from './CreatePlayerForm'
import AdjustChipsForm from './AdjustChipsForm'
import type { PlayerSummary } from './AdjustChipsForm'

type WalletRow = { chips: number }

type PlayerRow = {
  id: string
  username: string
  created_at: string
  wallets: WalletRow | WalletRow[] | null
}

function getChips(wallets: WalletRow | WalletRow[] | null): number {
  if (!wallets) return 0
  if (Array.isArray(wallets)) return wallets[0]?.chips ?? 0
  return wallets.chips
}

export default async function AdminPlayersPage() {
  const adminClient = createAdminClient()

  const { data } = await adminClient
    .from('profiles')
    .select('id, username, created_at, wallets(chips)')
    .eq('role', 'player')
    .order('username')

  const players = (data as PlayerRow[] | null) ?? []

  const summaries: PlayerSummary[] = players.map((p) => ({
    id: p.id,
    username: p.username,
    chips: getChips(p.wallets),
  }))

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Players</h1>
        <Link
          href="/admin/dashboard"
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Dashboard
        </Link>
      </div>

      {/* Player list */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">All Players</h2>
        {players.length === 0 ? (
          <p className="text-sm text-zinc-500">No players yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Username
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-zinc-600 dark:text-zinc-400">
                    Chips
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Member Since
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {players.map((p) => (
                  <tr
                    key={p.id}
                    className="transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-3 font-medium">{p.username}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {getChips(p.wallets).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CreatePlayerForm />
      <AdjustChipsForm players={summaries} />
    </main>
  )
}
