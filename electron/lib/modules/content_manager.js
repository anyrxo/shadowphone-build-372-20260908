// electron/lib/modules/content_manager.js
// ── Handler: content_manager ──────────────────────────────────────
// This module ID has no content-management implementation.

module.exports = async () => ({
    success: false,
    code: 'MODULE_NOT_IMPLEMENTED',
    error: 'Content management is not implemented by this automation module.',
})
