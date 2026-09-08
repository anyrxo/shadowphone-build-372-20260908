export interface EditProfileContext {
  serial: string
  userId: string
  account: string
}

export interface EditProfileForm {
  name: string
  username: string
  bio: string
  changePicture: boolean
  convertToBusiness: boolean
  category: string
}

export interface EditProfilePayload extends EditProfileContext {
  name?: string
  username?: string
  bio?: string
  change_picture?: boolean
  switch_to_professional?: boolean
  account_type?: 'business'
  professional_category?: string
}

export interface EditProfileSuccess {
  status?: string
  account?: string
  completed?: string[]
  warnings?: string[]
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase()
}

export function buildEditProfilePayload(
  context: EditProfileContext,
  form: EditProfileForm,
): EditProfilePayload {
  const payload: EditProfilePayload = { ...context }
  const name = form.name.trim()
  const username = normalizeUsername(form.username)
  const currentUsername = normalizeUsername(context.account)

  if (name) payload.name = name
  if (username && username !== currentUsername) payload.username = username
  if (form.bio.trim()) payload.bio = form.bio
  if (form.changePicture) payload.change_picture = true
  if (form.convertToBusiness) {
    payload.switch_to_professional = true
    payload.account_type = 'business'
    if (form.category.trim()) payload.professional_category = form.category.trim()
  }

  return payload
}

export function describeEditProfileSuccess(result: EditProfileSuccess, requestedCount: number) {
  const account = result.account || 'account'
  if (result.status === 'partial_sync') {
    const warning = result.warnings?.[0] || 'The cloud account mapping could not be updated.'
    return {
      status: `Instagram saved the change, but cloud sync needs attention: ${warning}`,
      toast: `@${account} updated; cloud sync pending`,
      toastKind: 'warn' as const,
      autoClose: false,
    }
  }

  const completed = result.completed?.length || requestedCount
  return {
    status: `Saved ${completed} verified change${completed === 1 ? '' : 's'}.`,
    toast: `@${account} profile updated`,
    toastKind: 'ok' as const,
    autoClose: true,
  }
}
