import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getTableState } from '@/lib/socket/table-session'
import TableRoom from './TableRoom'

export default async function TablePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: tableId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()

  const [entryRes, profileRes] = await Promise.all([
    admin
      .from('table_players')
      .select('status, seat_number')
      .eq('table_id', tableId)
      .eq('player_id', user.id)
      .neq('status', 'left')
      .maybeSingle(),
    admin
      .from('profiles')
      .select('role, must_change_password')
      .eq('id', user.id)
      .single(),
  ])

  const profile = profileRes.data as { role?: string; must_change_password?: boolean } | null
  const role = profile?.role
  const isAdmin = role === 'admin' || role === 'super_admin'
  const exitRoute = isAdmin ? '/admin/dashboard' : '/lobby'

  // A player who still owes a password change can't reach the table by
  // navigating here directly — the blocking modal lives on /lobby.
  if (!isAdmin && profile?.must_change_password) redirect('/lobby')

  if (!entryRes.data) redirect(exitRoute)

  const entry = entryRes.data as {
    status: 'seated' | 'spectating'
    seat_number: number | null
  }

  const state = await getTableState(admin, tableId)
  if (!state) redirect(exitRoute)

  return (
    <TableRoom
      initialState={state}
      currentUserId={user.id}
      myStatus={entry.status}
      mySeatNumber={entry.seat_number}
      isAdmin={isAdmin}
    />
  )
}
