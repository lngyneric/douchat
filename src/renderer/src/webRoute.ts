import type { AppView } from './components/AppRail'
import type { SettingsTab } from './components/SettingsPanel'

/**
 * Addresses for the web app, so reload, back/forward and shared links land on
 * the same chat or page. The desktop app has no address bar and ignores this.
 *
 *   /chat              chat list          /contacts            contacts
 *   /chat/<code>       one conversation   /settings/<tab>      settings
 *
 * A conversation appears by a short code derived from its id rather than the
 * id itself: ids are long compound keys that other records reference, and
 * every device has the same id, so every device derives the same code.
 *
 * On douchat.ai these live under /app; on app.douchat.ai at the root.
 */

const SETTINGS_TABS: readonly SettingsTab[] = ['memory', 'profile', 'general', 'usage', 'automation', 'agents', 'connections', 'models', 'scheduling', 'about', 'connectors']

export interface WebRoute {
  view: AppView
  /** In a route read from the address, the conversation's code, not its id. */
  conversationId?: string
  settingsTab?: SettingsTab
}

/** 53-bit cyrb53 hash in base 36: short, stable, and synchronous. */
export function conversationCode(id: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let index = 0; index < id.length; index++) {
    const char = id.charCodeAt(index)
    h1 = Math.imul(h1 ^ char, 2654435761)
    h2 = Math.imul(h2 ^ char, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** The conversation an address names; older links with the full id still work. */
export function resolveConversation(code: string | undefined, conversations: { id: string }[]): string | undefined {
  if (!code) return undefined
  return conversations.find((conversation) => conversation.id === code || conversationCode(conversation.id) === code)?.id
}

export const usesWebRoutes = (): boolean => window.douchat?.platform === 'web'

export function routeBase(pathname = window.location.pathname): string {
  if (typeof window !== 'undefined' && window.location.hostname.startsWith('app.')) return ''
  return pathname === '/app' || pathname.startsWith('/app/') ? '/app' : ''
}

export function readRoute(pathname = window.location.pathname): WebRoute {
  const parts = pathname.slice(routeBase(pathname).length).split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 'contacts') return { view: 'contacts' }
  if (parts[0] === 'settings') {
    const tab = SETTINGS_TABS.includes(parts[1] as SettingsTab) ? parts[1] as SettingsTab : 'profile'
    return { view: 'chats', settingsTab: tab }
  }
  return { view: 'chats', ...(parts[0] === 'chat' && parts[1] ? { conversationId: parts[1] } : {}) }
}

export function routePath(route: WebRoute, base = routeBase()): string {
  if (route.settingsTab) return `${base}/settings/${route.settingsTab}`
  if (route.view === 'contacts') return `${base}/contacts`
  return route.conversationId ? `${base}/chat/${conversationCode(route.conversationId)}` : `${base}/chat`
}

/**
 * Record the page in the address bar. Arriving at a chat from the bare chat
 * list (the app opening its first chat) replaces that entry instead of
 * adding one, so Back leaves the app rather than stepping through it.
 */
export function showRoute(route: WebRoute): void {
  const path = routePath(route)
  if (path === window.location.pathname) return
  const current = readRoute()
  // The address still names a chat the inbox has not loaded yet; keep it.
  if (current.conversationId && !route.conversationId && current.view === route.view && !route.settingsTab && !current.settingsTab) return
  // Opening the first chat, or rewriting an older full-id link to its code, is the same page.
  const settling = (!current.conversationId || current.conversationId === route.conversationId) && !current.settingsTab && current.view === route.view && Boolean(route.conversationId)
  window.history[settling ? 'replaceState' : 'pushState'](null, '', path)
}
