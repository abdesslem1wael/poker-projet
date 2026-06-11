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

  // Auth check (layout also handles this, but defense in depth).
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Use admin client for full data access (reads other players' profiles).
  const admin = createAdminClient()

  // Ensure this player has an active entry at this table.
  const { data: entryData } = await admin
    .from('table_players')
    .select('status, seat_number')
    .eq('table_id', tableId)
    .eq('player_id', user.id)
    .neq('status', 'left')
    .maybeSingle()

  if (!entryData) redirect('/lobby')

  const entry = entryData as {
    status: 'seated' | 'spectating'
    seat_number: number | null
  }

  // Get the full public table state.
  const state = await getTableState(admin, tableId)
  if (!state) redirect('/lobby')

  return (
    <TableRoom
      initialState={state}
      currentUserId={user.id}
      myStatus={entry.status}
      mySeatNumber={entry.seat_number}
    />
  )
}
