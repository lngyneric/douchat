import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { decodeRpcValue, DESKTOP_RPC, encodeRpcValue, withoutSnapshots, type DesktopRpcCall } from '../shared/desktopRpc'

/**
 * Runs the web app's calls on this desktop through the very handlers its own
 * window uses, so the web app can do everything the desktop window can, with
 * the same checks. Only methods in DESKTOP_RPC are reachable.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

/** Stands in for a window's webContents in calls that came from the web app. */
export const REMOTE_SENDER = Object.freeze({ id: -1, isDestroyed: () => false }) as unknown as Electron.WebContents

/** Must run before any handler is registered. */
export function captureIpcHandlers(): void {
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: Handler) => {
    handlers.set(channel, listener)
    return register(channel, listener as Parameters<typeof register>[1])
  }) as typeof ipcMain.handle
}

export async function runDesktopRpc(call: Pick<DesktopRpcCall, 'method' | 'args'>): Promise<unknown> {
  const channel = (DESKTOP_RPC as Record<string, string>)[call.method]
  const handler = channel ? handlers.get(channel) : undefined
  if (!handler) throw new Error('This desktop cannot do that from the web app. Update Douchat on the desktop.')
  if (!Array.isArray(call.args)) throw new Error('Invalid call')
  const event = { sender: REMOTE_SENDER } as IpcMainInvokeEvent
  return encodeRpcValue(withoutSnapshots(await handler(event, ...(decodeRpcValue(call.args) as unknown[]))))
}
