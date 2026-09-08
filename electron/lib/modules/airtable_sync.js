// electron/lib/modules/airtable_sync.js
// ── Handler: airtable_sync ───────────────────────────────────────
// This module ID has no synchronization implementation.

module.exports = async () => ({
    success: false,
    code: 'MODULE_NOT_IMPLEMENTED',
    error: 'Airtable synchronization is not implemented by this automation module.',
})
