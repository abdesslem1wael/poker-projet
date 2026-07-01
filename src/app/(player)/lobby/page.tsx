import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logoutAction } from '@/app/actions/auth'
import LobbyTabs from './LobbyTabs'
import PasswordChangeModal from './PasswordChangeModal'
import ChipsDisplay from './ChipsDisplay'
import SettingsModal from './SettingsModal'
import SocketStatus from './SocketStatus'

type TableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  table_type: 'timer' | 'open'
  status: 'waiting' | 'active'
  game_mode: 'cash' | 'sit_go'
  buy_in: number | null
  starting_stack: number | null
  prize_pool: number | null
  sit_go_status: 'registering' | 'ready' | 'running' | 'finished' | null
  blind_level: number
}

type RegistrationRow = {
  table_id: string
  player_id: string
}

type Profile = {
  username: string
  role: 'admin' | 'player' | 'super_admin'
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
      .select('id, name, small_blind, big_blind, max_players, table_type, status, game_mode, buy_in, starting_stack, prize_pool, sit_go_status, blind_level')
      .in('status', ['waiting', 'active'])
      .order('created_at', { ascending: false }),
  ])

  const profile = profileData as Profile | null
  const wallet  = walletData  as Wallet  | null
  const tables  = (tablesData as TableRow[] | null) ?? []

  if (profile?.role === 'admin') redirect('/admin/dashboard')

  const cashTables = tables.filter((t) => t.game_mode !== 'sit_go')
  const sitGoIds = tables.filter((t) => t.game_mode === 'sit_go').map((t) => t.id)

  const { data: registrationsData } = sitGoIds.length > 0
    ? await supabase.from('sit_go_registrations').select('table_id, player_id').in('table_id', sitGoIds)
    : { data: [] as RegistrationRow[] }

  const registrations = (registrationsData as RegistrationRow[] | null) ?? []
  const countByTable = new Map<string, number>()
  const registeredByUser = new Set<string>()
  for (const r of registrations) {
    countByTable.set(r.table_id, (countByTable.get(r.table_id) ?? 0) + 1)
    if (r.player_id === user.id) registeredByUser.add(r.table_id)
  }

  const sitGoTables = tables
    .filter((t) => t.game_mode === 'sit_go')
    .map((t) => ({
      id: t.id,
      name: t.name,
      buy_in: t.buy_in ?? 0,
      starting_stack: t.starting_stack ?? 0,
      small_blind: t.small_blind,
      big_blind: t.big_blind,
      max_players: t.max_players,
      prize_pool: t.prize_pool ?? 0,
      sit_go_status: t.sit_go_status ?? 'registering',
      registeredCount: countByTable.get(t.id) ?? 0,
      isRegistered: registeredByUser.has(t.id),
      blind_level: t.blind_level,
    }))

  return (
    // overflow-x-hidden guards against any child accidentally stretching the viewport
    <main className="min-h-screen overflow-x-hidden bg-zinc-950 text-zinc-100">
      {profile?.must_change_password && <PasswordChangeModal />}

      {/*
        Top bar — sticky so it stays visible while scrolling. padding-top pushes
        content below the iOS status bar when running as a PWA. Deliberately
        minimal: logo, connection dot, settings, sign out. No player identity.
      */}
      <header
        className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="shrink-0 text-lg font-black tracking-tight text-emerald-500">♠</span>
            <span className="shrink-0 truncate text-base font-black tracking-tight text-zinc-100">
              Poker
            </span>
            <SocketStatus />
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <SettingsModal currentUsername={profile?.username ?? ''} />
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs font-semibold text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 active:bg-zinc-800"
              >
                Sign out
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
        className="mx-auto max-w-2xl space-y-5 px-4 py-5"
        style={{ paddingBottom: 'max(40px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-black tracking-tight text-zinc-100">Poker Lobby</h1>

          {/* Small chips balance card */}
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 px-3.5 py-2 ring-1 ring-amber-500/10">
            <span className="text-base leading-none">🪙</span>
            <div className="text-right leading-tight">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Chips</p>
              <ChipsDisplay initialChips={wallet?.chips ?? null} />
            </div>
          </div>
        </div>

        <LobbyTabs
          cashTables={cashTables}
          sitGoTables={sitGoTables}
          canJoin={profile?.role !== 'super_admin'}
          playerChips={wallet?.chips ?? 0}
        />
      </div>
    </main>
  )
}
