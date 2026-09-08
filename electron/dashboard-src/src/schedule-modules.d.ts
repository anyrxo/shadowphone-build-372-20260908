// Ambient types for the pure-ESM schedule helper modules under electron/renderer/.
// They are plain .js with no .d.ts; ScheduleOverlay imports them as real ES
// modules so Vite bundles them at build time (a runtime require() of their
// `export` syntax crashes Electron's CJS loader). The wildcard `*/` matches the
// relative specifier (e.g. ../../renderer/schedule-overview-model.js).
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module '*/schedule-overview-model.js' {
  export const MIN_FIRE_GAP_MS: number
  export function slotNextFire(row: any, slot: any, fromMs: number): number
  export function slotStatus(row: any, slot: any, nowMs: number): string
  export function buildOverviewModel(rows: any[], nowMs: number): any
  export function detectCollisions(accountsOnPhone: any[], nowMs: number): any
}
declare module '*/schedule-overview-edit.js' {
  export function normTime(t: any): string
  export function buildPatch(row: any, slots: any, isActive: boolean): any
  export function makeCoalescedSaver(saveFn: any): any
  export function openScheduleEditor(host: any, ctx: any, deps: any): Promise<any>
}
