'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type ActionState = { error: string } | undefined

async function requireAdmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  return profile?.role === 'admin' || profile?.role === 'super_admin' ? user : null
}

export async function createTableAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const name = (formData.get('name') as string).trim()
  const smallBlind = parseInt(formData.get('smallBlind') as string, 10)
  const maxPlayers = parseInt(formData.get('maxPlayers') as string, 10)
  const tableType = formData.get('tableType') as string

  if (!name) return { error: 'Table name is required' }
  if (isNaN(smallBlind) || smallBlind <= 0) {
    return { error: 'Small blind must be greater than 0' }
  }
  if (isNaN(maxPlayers) || maxPlayers < 2 || maxPlayers > 9) {
    return { error: 'Max players must be between 2 and 9' }
  }
  if (tableType !== 'timer' && tableType !== 'open') {
    return { error: 'Table type must be either timer or open' }
  }

  const bigBlind = smallBlind * 2

  const adminClient = createAdminClient()
  const { error } = await adminClient.from('poker_tables').insert({
    name,
    small_blind: smallBlind,
    big_blind: bigBlind,
    max_players: maxPlayers,
    table_type: tableType,
    status: 'waiting',
    created_by: admin.id,
  })

  if (error) return { error: error.message }

  revalidatePath('/admin/tables')
  redirect('/admin/tables')
}

// Uses .bind(null, tableId) at the call site — Next.js appends formData as last arg.
export async function closeTableAction(
  tableId: string,
  _formData: FormData
): Promise<void> {
  const admin = await requireAdmin()
  if (!admin) return

  const adminClient = createAdminClient()
  await adminClient
    .from('poker_tables')
    .update({ status: 'closed' })
    .eq('id', tableId)
    .neq('status', 'closed')

  revalidatePath('/admin/tables')
  redirect('/admin/tables')
}

export async function getSeatedPlayersAction(
  tableId: string
): Promise<Array<{ playerId: string; username: string }>> {
  const adminUser = await requireAdmin()
  if (!adminUser) return []

  const adminClient = createAdminClient()

  const { data: playersData } = await adminClient
    .from('table_players')
    .select('player_id')
    .eq('table_id', tableId)
    .eq('status', 'seated')

  const playerIds = ((playersData as Array<{ player_id: string }> | null) ?? []).map(p => p.player_id)
  if (playerIds.length === 0) return []

  const { data: profilesData } = await adminClient
    .from('profiles')
    .select('id, username')
    .in('id', playerIds)

  return ((profilesData as Array<{ id: string; username: string }> | null) ?? []).map(p => ({
    playerId: p.id,
    username: p.username,
  }))
}

export async function reopenTableAction(
  tableId: string,
  _formData: FormData
): Promise<void> {
  const admin = await requireAdmin()
  if (!admin) return

  const adminClient = createAdminClient()
  await adminClient
    .from('poker_tables')
    .update({ status: 'waiting' })
    .eq('id', tableId)
    .eq('status', 'closed')

  revalidatePath('/admin/tables')
  redirect('/admin/tables')
}
