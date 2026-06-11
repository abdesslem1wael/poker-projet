import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logoutAction } from '@/app/actions/auth'
import SocketStatus from './SocketStatus'
import TableCard from './TableCard'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  status: 'waiting' | 'active'
}

type Profile = {
  username: string
  role: 'admin' | 'player'
}

type Wallet = {
  chips: number
}

export default async function LobbyPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const [{ data: profileData }, { data: walletData }, { data: tablesData }] =
    await Promise.all([
      supabase.from('profiles').select('username, role').eq('id', user.id).single(),
      supabase.from('wallets').select('chips').eq('user_id', user.id).single(),
      supabase
        .from('poker_tables')
        .select('id, name, small_blind, big_blind, max_players, status')
        .in('status', ['waiting', 'active'])
        .order('created_at', { ascending: false }),
    ])

  const profile = profileData as Profile | null
  const wallet = walletData as Wallet | null
  const tables = (tablesData as TableRow[] | null) ?? []

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top nav */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold tracking-tight">Poker</span>
            <SocketStatus />
          </div>
          <div className="flex items-center gap-4">
            {profile?.role === 'admin' && (
              <Link
                href="/admin/dashboard"
                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
              >
                Admin →
              </Link>
            )}
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        {/* Player card */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Your Account
          </h2>
          <div className="flex flex-wrap gap-8">
            <div>
              <p className="text-xs text-zinc-500">Username</p>
              <p className="mt-1 text-lg font-bold text-zinc-100">
                {profile?.username ?? '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Chip Balance</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-amber-400">
                {wallet != null ? wallet.chips.toLocaleString() : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Role</p>
              <p className="mt-1 text-lg font-bold capitalize text-zinc-100">
                {profile?.role ?? '—'}
              </p>
            </div>
          </div>
        </section>

        {/* Tables */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-zinc-100">Available Tables</h2>

          {tables.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 py-20 text-center">
              <p className="text-zinc-500">No tables are open right now.</p>
              <p className="mt-1 text-sm text-zinc-600">Ask an admin to create one.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tables.map((t) => (
                <TableCard key={t.id} table={t} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
