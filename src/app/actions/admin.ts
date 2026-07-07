'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getIo } from '@/lib/socket/io-access'

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

export async function createPlayerAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const email = (formData.get('email') as string).trim()
  const password = formData.get('password') as string
  const username = (formData.get('username') as string).trim()
  const startingChips = parseInt(formData.get('startingChips') as string, 10)

  if (!email || !password || !username) {
    return { error: 'Email, password, and username are required' }
  }
  if (password.length < 6) {
    return { error: 'Password must be at least 6 characters' }
  }
  if (isNaN(startingChips) || startingChips < 0) {
    return { error: 'Starting chips must be 0 or more' }
  }

  const adminClient = createAdminClient()

  // Create auth user — DB triggers auto-create profile (with username + role)
  // and wallet (with 0 chips) inside the same Postgres transaction.
  const { data: newUser, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      user_metadata: { username, role: 'player' },
      email_confirm: true, // skip email verification for admin-created accounts
    })

  if (createError || !newUser.user) {
    return { error: createError?.message ?? 'User creation failed' }
  }

  const userId = newUser.user.id

  if (startingChips > 0) {
    const { error: walletError } = await adminClient
      .from('wallets')
      .update({ chips: startingChips, updated_at: new Date().toISOString() })
      .eq('user_id', userId)

    if (walletError) {
      return {
        error: `Player created but chip assignment failed: ${walletError.message}`,
      }
    }

    const { error: txError } = await adminClient.from('transactions').insert({
      user_id: userId,
      amount: startingChips,
      type: 'credit',
      note: 'Starting chips on account creation',
    })

    if (txError) {
      return {
        error: `Player created but transaction record failed: ${txError.message}`,
      }
    }
  }

  revalidatePath('/admin/players')
  redirect('/admin/players')
}

export async function adjustChipsAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const playerId = (formData.get('playerId') as string).trim()
  const amount = parseInt(formData.get('amount') as string, 10)
  // form values: 'admin_topup' | 'admin_deduction'
  // mapped to DB types: 'credit' | 'debit'
  const formType = formData.get('type') as string
  const note = ((formData.get('note') as string) ?? '').trim() || null

  if (!playerId) return { error: 'Select a player' }
  if (isNaN(amount) || amount <= 0) return { error: 'Amount must be greater than 0' }
  if (formType !== 'admin_topup' && formType !== 'admin_deduction') {
    return { error: 'Invalid adjustment type' }
  }

  const dbType = formType === 'admin_topup' ? 'credit' : 'debit'
  const adminClient = createAdminClient()

  const { data: wallet, error: fetchError } = await adminClient
    .from('wallets')
    .select('chips')
    .eq('user_id', playerId)
    .single()

  if (fetchError || !wallet) return { error: 'Player wallet not found' }

  const currentChips = (wallet as { chips: number }).chips
  const newChips = dbType === 'credit' ? currentChips + amount : currentChips - amount

  if (newChips < 0) {
    return {
      error: `Cannot deduct ${amount.toLocaleString()} chips — player only has ${currentChips.toLocaleString()}`,
    }
  }

  const { error: updateError } = await adminClient
    .from('wallets')
    .update({ chips: newChips, updated_at: new Date().toISOString() })
    .eq('user_id', playerId)

  if (updateError) return { error: updateError.message }

  const { error: txError } = await adminClient.from('transactions').insert({
    user_id: playerId,
    amount,
    type: dbType,
    note,
  })

  if (txError) return { error: txError.message }

  // Push the updated balance to the player's active socket(s) immediately.
  const io = getIo()
  if (io) {
    const sockets = await io.fetchSockets()
    for (const s of sockets) {
      if (s.data.userId === playerId) {
        s.emit('wallet_update', { chips: newChips })
      }
    }
  }

  revalidatePath('/admin/players')
  redirect('/admin/players')
}

export async function deleteTransactionAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const transactionId = (formData.get('transactionId') as string).trim()
  const playerId = (formData.get('playerId') as string).trim()
  if (!transactionId || !playerId) return { error: 'Transaction ID required' }

  const adminClient = createAdminClient()

  // Log-only delete: removes the history row without touching the wallet
  // balance — the chip count reflects live state, not a replay of the ledger.
  // Scoped to credit/debit (admin top-up/deduction) rows only — hand win/loss
  // and other transaction types aren't editable from this history view.
  const { error } = await adminClient
    .from('transactions')
    .delete()
    .eq('id', transactionId)
    .eq('user_id', playerId)
    .in('type', ['credit', 'debit'])

  if (error) return { error: error.message }

  revalidatePath(`/admin/players/${playerId}/history`)
}

export async function deletePlayerAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const admin = await requireAdmin()
  if (!admin) return { error: 'Unauthorized' }

  const playerId = (formData.get('playerId') as string).trim()
  if (!playerId) return { error: 'Player ID required' }

  const adminClient = createAdminClient()
  const { error } = await adminClient.auth.admin.deleteUser(playerId)
  if (error) return { error: error.message }

  revalidatePath('/admin/players')
  redirect('/admin/players')
}
