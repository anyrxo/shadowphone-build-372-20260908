import { useEffect, useRef } from 'react'

// Under nodeIntegration:true the renderer has access to Node require().
// We use a declare so TypeScript doesn't complain; the actual module is
// provided by Electron at runtime — never bundled by Vite.
declare const require: (mod: string) => any

function getIpcRenderer() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('electron').ipcRenderer
}

/** Typed invoke wrapper — use for request/response IPC calls */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return getIpcRenderer().invoke(channel, ...args) as Promise<T>
}

/** Listen to a push event from the main process. Cleans up on unmount. */
export function useIpcEvent(channel: string, handler: (...args: unknown[]) => void): void {
  // Keep the latest handler in a ref so the subscription registers once per
  // channel yet always calls the current closure (callers don't have to memoize).
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const ipc = getIpcRenderer()
    // Stable listener reference so cleanup removes ONLY this one — not every
    // other component's listener on the same channel (removeAllListeners did).
    const sub = (_event: unknown, ...args: unknown[]) => handlerRef.current(...args)
    ipc.on(channel, sub)
    return () => {
      ipc.removeListener(channel, sub)
    }
  }, [channel])
}
