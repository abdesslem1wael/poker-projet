import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import CreatePlayerForm from './CreatePlayerForm'
import AdjustChipsForm from './AdjustChipsForm'
import DeletePlayerButton from './DeletePlayerButton'
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
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight">Players</h1>
          <Link
            href="/admin/dashboard"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-200"
          >
            ← Dashboard
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        {/* Player list */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <h2 className="font-semibold text-zinc-100">
              All Players
              {players.length > 0 && (
                <span className="ml-2 text-sm font-normal text-zinc-500">
                  ({players.length})
                </span>
              )}
            </h2>
          </div>

          {players.length === 0 ? (
            <p className="px-5 py-6 text-sm text-zinc-500">No players yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-800/60">
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">
                      Username
                    </th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">
                      Chips
                    </th>
                    <th className="px-5 py-3 text-left font-medium text-zinc-400">
                      Member Since
                    </th>
                    <th className="px-5 py-3 text-right font-medium text-zinc-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {players.map((p) => (
                    <tr
                      key={p.id}
                      className="transition-colors hover:bg-zinc-800/40"
                    >
                      <td className="px-5 py-3 font-medium text-zinc-100">
                        {p.username}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-300">
                        {getChips(p.wallets).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-zinc-500">
                        {new Date(p.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <DeletePlayerButton
                          playerId={p.id}
                          username={p.username}
                        />
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
      </div>
    </main>
  )
}
