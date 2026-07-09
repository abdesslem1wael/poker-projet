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

const HOUSE_FEE_PERCENT = 10

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
  const gameMode = (formData.get('gameMode') as string) || 'cash'

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
  if (gameMode !== 'cash' && gameMode !== 'sit_go') {
    return { error: 'Game mode must be either cash or sit_go' }
  }

  const bigBlind = smallBlind * 2

  const insertRow: Record<string, unknown> = {
    name,
    small_blind: smallBlind,
    big_blind: bigBlind,
    max_players: maxPlayers,
    table_type: tableType,
    game_mode: gameMode,
    status: 'waiting',
    created_by: admin.id,
  }

  if (gameMode === 'sit_go') {
    const buyIn = parseInt(formData.get('buyIn') as string, 10)
    const startingStack = parseInt(formData.get('startingStack') as string, 10)

    if (isNaN(buyIn) || buyIn <= 0) {
      return { error: 'Buy-in must be greater than 0' }
    }
    if (isNaN(startingStack) || startingStack <= 0) {
      return { error: 'Starting stack must be greater than 0' }
    }

    const totalBuyIns = buyIn * maxPlayers
    const houseFee = totalBuyIns * (HOUSE_FEE_PERCENT / 100)
    const prizePool = totalBuyIns - houseFee

    insertRow.buy_in = buyIn
    insertRow.starting_stack = startingStack
    insertRow.sit_go_status = 'registering'
    insertRow.house_fee_percent = HOUSE_FEE_PERCENT
    insertRow.prize_pool = Math.round(prizePool)
    // Remembered so blind levels (Step 6) can always compute back from level 1,
    // even after small_blind/big_blind have been scaled up by later levels.
    insertRow.original_small_blind = smallBlind
    insertRow.original_big_blind = bigBlind
  }

  const adminClient = createAdminClient()
  const { error } = await adminClient.from('poker_tables').insert(insertRow)

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
    // Clear any in-progress Last Hands countdown too — otherwise a stale
    // countdown could resurrect after a reopen or a server restart (the
    // in-memory cache is hydrated straight from these columns on boot).
    .update({ status: 'closed', last_hands_active: false, last_hands_remaining: null })
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

export async function deleteTableAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const tableId = (formData.get('tableId') as string | null)?.trim()
  if (!tableId) return { error: 'Table ID required' }

  const adminClient = createAdminClient()

  // dealer_tips is intentionally left alone here — a DB trigger archives it
  // (table_id -> NULL, name/id preserved) as part of the poker_tables delete.
  await adminClient.from('game_history').delete().eq('table_id', tableId)
  await adminClient.from('table_players').delete().eq('table_id', tableId)
  const { error } = await adminClient.from('poker_tables').delete().eq('id', tableId)

  if (error) return { error: error.message }

  revalidatePath('/admin/tables')
  revalidatePath('/admin/dashboard')
  redirect('/admin/tables')
}

// Permanently removes collected tips. This is the ONLY path that hard-deletes
// dealer_tips rows — deleting a table never does (see deleteTableAction).
// Accepts either a live table_id or, for tips whose table has already been
// deleted, the archived deleted_table_id.
export async function deleteDealerTipsAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const groupKey = (formData.get('groupKey') as string | null)?.trim()
  const archived = formData.get('archived') === 'true'
  if (!groupKey) return { error: 'Missing tip group' }

  const adminClient = createAdminClient()
  const column = archived ? 'deleted_table_id' : 'table_id'
  const { error } = await adminClient.from('dealer_tips').delete().eq(column, groupKey)

  if (error) return { error: error.message }

  revalidatePath('/admin/dashboard')
  return undefined
}
