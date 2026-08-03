'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getIo } from '@/lib/socket/io-access'

type Ok  = { ok: true }
type Err = { error: string }
export type ActionResult = Ok | Err

export async function updateUsernameAction(username: string): Promise<ActionResult> {
  const trimmed = username.trim()
  if (!trimmed || trimmed.length < 2 || trimmed.length > 20) {
    return { error: 'Username must be 2–20 characters' }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { error: 'Only letters, numbers, _ and - allowed' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase
    .from('profiles')
    .update({ username: trimmed })
    .eq('id', user.id)

  if (error) {
    if (error.message.includes('unique') || error.code === '23505') {
      return { error: 'That username is already taken' }
    }
    return { error: error.message }
  }

  revalidatePath('/lobby')
  return { ok: true }
}

export async function changePasswordAction(
  newPassword: string,
  confirmPassword: string,
): Promise<ActionResult> {
  if (!newPassword || newPassword.length < 6) {
    return { error: 'Password must be at least 6 characters' }
  }
  if (newPassword !== confirmPassword) {
    return { error: 'Passwords do not match' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error: pwError } = await supabase.auth.updateUser({ password: newPassword })
  if (pwError) return { error: pwError.message }

  await supabase
    .from('profiles')
    .update({ must_change_password: false, password_changed_at: new Date().toISOString() })
    .eq('id', user.id)

  // Clear the flag on this user's live socket(s) immediately — without this,
  // an already-connected session would stay blocked from join_table/
  // player_action until it happened to reconnect, since that check reads a
  // value cached on the socket at connect time, not a fresh DB read.
  const io = getIo()
  if (io) {
    const sockets = await io.fetchSockets()
    for (const s of sockets) {
      if (s.data.userId === user.id) s.data.mustChangePassword = false
    }
  }

  revalidatePath('/lobby')
  return { ok: true }
}
