'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getIo } from '@/lib/socket/io-access'

export type ActionResult = { ok: true } | { error: string }

export async function registerSitGoAction(tableId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const adminClient = createAdminClient()

  const { data, error } = await adminClient.rpc('register_sit_go', {
    p_table_id: tableId,
    p_player_id: user.id,
  })

  if (error) return { error: error.message }

  const row = (data as Array<{ result_status: string; result_message: string }> | null)?.[0]
  if (!row || row.result_status !== 'ok') {
    return { error: row?.result_message ?? 'Registration failed' }
  }

  const { data: wallet } = await adminClient
    .from('wallets')
    .select('chips')
    .eq('user_id', user.id)
    .single()

  const newChips = (wallet as { chips: number } | null)?.chips
  if (newChips != null) {
    const io = getIo()
    if (io) {
      const sockets = await io.fetchSockets()
      for (const s of sockets) {
        if (s.data.userId === user.id) {
          s.emit('wallet_update', { chips: newChips })
        }
      }
    }
  }

  revalidatePath('/lobby')
  return { ok: true }
}

export async function unregisterSitGoAction(tableId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const adminClient = createAdminClient()

  const { data, error } = await adminClient.rpc('unregister_sit_go', {
    p_table_id: tableId,
    p_player_id: user.id,
  })

  if (error) return { error: error.message }

  const row = (data as Array<{ result_status: string; result_message: string }> | null)?.[0]
  if (!row || row.result_status !== 'ok') {
    return { error: row?.result_message ?? 'Unregistration failed' }
  }

  const { data: wallet } = await adminClient
    .from('wallets')
    .select('chips')
    .eq('user_id', user.id)
    .single()

  const newChips = (wallet as { chips: number } | null)?.chips
  if (newChips != null) {
    const io = getIo()
    if (io) {
      const sockets = await io.fetchSockets()
      for (const s of sockets) {
        if (s.data.userId === user.id) {
          s.emit('wallet_update', { chips: newChips })
        }
      }
    }
  }

  revalidatePath('/lobby')
  return { ok: true }
}
