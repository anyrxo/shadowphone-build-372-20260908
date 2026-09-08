import { createContext, useContext } from 'react'

// ── New-profile registry: profileId → expiry timestamp (60s) ──────────────
// Used by CreateIgModal to set isNewProfile=true for recently created profiles
// (their GrapheneOS first-boot init takes ~25-30s; am switch-user returns 0/Owner during it).
const _newProfiles = new Map<string, number>()

export function markNewProfile(_serial: string, userId: string | number): void {
  _newProfiles.set(String(userId), Date.now() + 60_000)
}

export function isNewProfile(_serial: string, userId: string | number): boolean {
  const exp = _newProfiles.get(String(userId))
  if (!exp) return false
  if (Date.now() > exp) { _newProfiles.delete(String(userId)); return false }
  return true
}

// ── Profile modal context — passed down from App to profile-level components ──
export interface ProfileCtx {
  serial: string
  userId: string   // string for IPC compat
  name: string
  accountCount: number
}

interface DashContextValue {
  /** Trigger a quiet background registry refresh (mirrors load(true)) */
  refresh: () => void
  /** Open the Create IG modal for a given profile */
  openCreateIg: (ctx: ProfileCtx) => void
  /** Open the Delete modal for a given profile */
  openDelete: (ctx: ProfileCtx) => void
  /** Open the Add Profile modal */
  openAddProfile: () => void
  /** Open the Bulk Create modal */
  openBulkCreate: () => void
  /** First serial for the current scoped registry — needed for Add Profile / Bulk */
  firstSerial: () => string | null
}

export const DashContext = createContext<DashContextValue>({
  refresh: () => {},
  openCreateIg: () => {},
  openDelete: () => {},
  openAddProfile: () => {},
  openBulkCreate: () => {},
  firstSerial: () => null,
})

export function useDash(): DashContextValue {
  return useContext(DashContext)
}
