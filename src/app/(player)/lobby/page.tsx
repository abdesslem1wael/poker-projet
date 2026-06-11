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
      supabase
        .from('profiles')
        .select('username, role')
        .eq('id', user.id)
        .single(),
      supabase
        .from('wallets')
        .select('chips')
        .eq('user_id', user.id)
        .single(),
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
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Lobby</h1>
          <SocketStatus />
        </div>
        <div className="flex items-center gap-3">
          {profile?.role === 'admin' && (
            <Link
              href="/admin/dashboard"
              className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Admin Dashboard →
            </Link>
          )}
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {/* Player info */}
      <section className="rounded-lg border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Your Account
        </h2>
        <div className="flex flex-wrap gap-8">
          <div>
            <p className="text-xs text-zinc-500">Username</p>
            <p className="mt-0.5 font-semibold">{profile?.username ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Chips</p>
            <p className="mt-0.5 font-semibold tabular-nums">
              {wallet != null ? wallet.chips.toLocaleString() : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Role</p>
            <p className="mt-0.5 font-semibold capitalize">
              {profile?.role ?? '—'}
            </p>
          </div>
        </div>
      </section>

      {/* Available tables */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Available Tables</h2>

        {tables.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 py-16 text-center dark:border-zinc-700">
            <p className="text-zinc-500">No tables are open right now.</p>
            <p className="mt-1 text-sm text-zinc-400">
              Ask an admin to create one.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {tables.map((t) => (
              <TableCard key={t.id} table={t} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
