// Toast singleton — mirrors models-dashboard.html setToast()
// The React renderer appends a #toast div to document.body; this module
// operates on it directly so any component can fire a toast without prop-drilling.

let _toastEl: HTMLElement | null = null
let _retryFn: (() => void) | null = null

function getToast(): HTMLElement {
  if (_toastEl) return _toastEl
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast'
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    el.textContent = 'ready'
    document.body.appendChild(el)
    el.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('.toast-retry')) return
      const fn = _retryFn
      _retryFn = null
      if (fn) fn()
    })
  }
  _toastEl = el
  return el
}

function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

export function setToast(
  text: string,
  kind: '' | 'ok' | 'err' | 'warn' = '',
  opts?: { busy?: boolean; onRetry?: () => void } | null
): void {
  const toast = getToast()
  _retryFn = (opts && typeof opts.onRetry === 'function') ? opts.onRetry : null
  const busy = !!(opts && opts.busy)
  toast.className = 'toast' + (kind ? ' ' + kind : '') + (busy ? ' busy' : '')
  const safe = escHtml(String(text).slice(0, 200))
  toast.innerHTML =
    (busy ? '<span class="toast-spin" aria-hidden="true"></span>' : '') +
    '<span class="toast-msg">' + safe + '</span>' +
    (_retryFn ? '<button type="button" class="toast-retry" title="Retry the last action">&#8635; Retry</button>' : '')
  toast.classList.remove('md-toast-ping')
  void toast.offsetWidth
  toast.classList.add('md-toast-ping')
}
