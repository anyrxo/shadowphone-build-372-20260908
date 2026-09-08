// Registry data shapes from fleet:get-registry IPC response

export interface AccountCounts {
  images: number
  videos: number
  reels: number
  stories: number
  remaining: number
  posted: number
  lowContent: boolean
}

export interface RegistryAccount {
  handle?: string
  scheduleActive?: boolean
  statsAt?: string | null
  statsError?: string
  counts?: AccountCounts
}

export interface RegistryProfile {
  profileId?: number
  name?: string
  model?: string
  scannedAt?: string | number | null
  switchFailed?: boolean
  accounts: Record<string, RegistryAccount>
}

export interface RegistryDevice {
  serial?: string
  profiles: Record<string, RegistryProfile>
}

export interface Registry {
  devices: Record<string, RegistryDevice>
}

// A single posting slot for an account (from buildOverviewModel).
// Declared here so both CommandCenter.tsx and exceptions.ts share one definition.
export interface Slot {
  time: string
  content_type: string
  status: string
  nextFireMs: number | null
  jitterMin: number
}

// Normalized shapes after groupByModel()
export interface NormalizedAccount {
  handle: string
  scheduleActive: boolean
  statsAt: string | null
  statsError?: string
  counts: AccountCounts
  userId: string
  serial: string
  key: string  // buildAccountKey(serial, userId, handle) — unique across fleet
}

export interface NormalizedProfile {
  serial: string
  profileId: number
  name: string
  accounts: NormalizedAccount[]
  // meta from raw registry (not in groupByModel output)
  scannedAt?: string | number | null
  switchFailed?: boolean
}

export interface ModelGroup {
  model: string
  accountCount: number
  profiles: NormalizedProfile[]
}

// profMeta Map value
export interface ProfMeta {
  scannedAt: string | number | null
  switchFailed: boolean
}

// Fleet insights aggregate — real follower/view totals + day-over-day trend +
// freshness, summed from the per-account insights series (insights:get-all-series).
export interface InsightsSeriesPoint {
  ts?: number | string
  followers?: number | null
  views?: number | null
}

export interface InsightsAgg {
  followers: number            // fleet-wide total followers (latest snapshot per account)
  views: number                // fleet-wide total views (latest snapshot per account)
  followersDelta: number | null // net follower change vs ~24h ago, null if no prior history
  newestTs: number | null      // most-recent snapshot ts across the fleet
  fetchedCount: number         // accounts with ≥1 insights snapshot
  totalCount: number           // total accounts in the fleet
}

// Pulse stats
export interface PulseStats {
  live: number
  idle: number
  low: number
  fail: number
  total: number
  models: number
  profiles: number
  followers: string
  views: string
  ready: string
  noDevices: boolean
}

export type SortKey = 'model' | 'content' | 'low' | 'scanned'

export type LoadState = 'loading' | 'loaded' | 'error' | 'timeout'

// ── Bulk Create types ──────────────────────────────────────────────────────

export interface BulkStatusResult {
  ok: boolean
  error?: string
  active: boolean
  interrupted: boolean
  totals: { created: number; cooled: number; fail: number; skipped?: number } | null
  current: string | null
  reason?: string | null
  recoveryUserId?: number | null
}

export interface BulkPreviewResult {
  ok: boolean
  estCount: number
  estSpend: number
  balance: number | null
  qualifying: unknown[]
  cooled: unknown[]
}

export type BulkProgressPhase =
  | 'switching' | 'creating' | 'created' | 'has-account'
  | 'flagged' | 'scaffold-failed' | 'cooled' | 'aborted'
  | 'manual-reconciliation-required'

export type BulkProgressEvent =
  | { ev: 'profile'; serial: string; userId: string | number; name?: string; phase: BulkProgressPhase; handle?: string; username?: string; error?: string }
  | { ev: 'run-complete'; serial: string; reason: string; recoveryUserId?: number | null; totals: { created: number; cooled: number; fail: number; skipped?: number } }
  | { ev: 'run-error'; serial: string; error: string }
