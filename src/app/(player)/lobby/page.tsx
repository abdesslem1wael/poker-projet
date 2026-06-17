import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logoutAction } from '@/app/actions/auth'
import SocketStatus from './SocketStatus'
import TableCard from './TableCard'
import SettingsModal from './SettingsModal'
import PasswordChangeModal from './PasswordChangeModal'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  table_type: 'timer' | 'open'
  status: 'waiting' | 'active'
}

type Profile = {
  username: string
  role: 'admin' | 'player'
  must_change_password: boolean
}

type Wallet = {
  chips: number
}

export default async function LobbyPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { data: profileData },
    { data: walletData },
    { data: tablesData },
  ] = await Promise.all([
    supabase.from('profiles').select('username, role, must_change_password').eq('id', user.id).single(),
    supabase.from('wallets').select('chips').eq('user_id', user.id).single(),
    supabase.from('poker_tables')
      .select('id, name, small_blind, big_blind, max_players, table_type, status')
      .in('status', ['waiting', 'active'])
      .order('created_at', { ascending: false }),
  ])

  const profile = profileData as Profile | null
  const wallet  = walletData  as Wallet  | null
  const tables  = (tablesData as TableRow[] | null) ?? []

  if (profile?.role === 'admin') redirect('/admin/dashboard')

  return (
    // overflow-x-hidden guards against any child accidentally stretching the viewport
    <main className="min-h-screen overflow-x-hidden bg-zinc-950 text-zinc-100">
      {profile?.must_change_password && <PasswordChangeModal />}

      {/*
        Header — sticky so it stays visible while scrolling.

        padding-top: env(safe-area-inset-top) pushes the content row below the
        iOS status bar (clock / battery / signal) when the app runs as a PWA
        with viewportFit=cover + statusBarStyle=black-translucent.

        Layout: left section (logo + dot indicator) flex-1 min-w-0 so it can
        compress if needed; right section shrink-0 so buttons never wrap or
        disappear.  The SocketStatus label is hidden below sm to keep the total
        header width under 288 px on iPhone SE (320 px viewport).
      */}
      <header
        className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/90 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">

          {/* Left — logo + connection dot */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span className="shrink-0 text-base font-black tracking-tight text-zinc-100">
              ♠ Poker
            </span>
            <SocketStatus />
          </div>

          {/* Right — actions; shrink-0 so they never get crushed */}
          <div className="flex shrink-0 items-center gap-2">
            <SettingsModal currentUsername={profile?.username ?? ''} />
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors active:bg-zinc-800"
              >
                {/* Full label on ≥ sm, abbreviated on phones */}
                <span className="hidden sm:inline">Sign out</span>
                <span className="sm:hidden">Out</span>
              </button>
            </form>
          </div>

        </div>
      </header>

      {/*
        Content — px-4 gives 16 px gutters on each side (safe on 320 px screens).
        padding-bottom uses env(safe-area-inset-bottom) so content clears the
        iOS home indicator; falls back to 40 px on devices without it.
      */}
      <div
        className="space-y-5 px-4 py-5"
        style={{ paddingBottom: 'max(40px, env(safe-area-inset-bottom, 0px))' }}
      >

        {/* Player chip card */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 rounded-xl bg-zinc-800/60 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Player</p>
              <p className="mt-1 truncate text-lg font-bold text-zinc-100">
                {profile?.username ?? '—'}
              </p>
            </div>
            <div className="rounded-xl bg-zinc-800/60 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Chips</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-amber-400">
                {wallet != null ? wallet.chips.toLocaleString() : '—'}
              </p>
            </div>
          </div>
        </section>

        {/* Tables list */}
        <section>
          <h2 className="mb-3 text-base font-bold text-zinc-100">Available Tables</h2>

          {tables.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 py-16 text-center">
              <p className="text-zinc-500">No tables open right now.</p>
              <p className="mt-1 text-sm text-zinc-600">Ask an admin to create one.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
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
