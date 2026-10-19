/**
 * The web app is served at app.douchat.ai, its own origin, so its sign-in
 * token is out of reach of the rest of the site. Sign-in, payment and invite
 * pages belong to the main site (douchat.ai), where the person's site session
 * lives; the web app sends people there and they come back here.
 *
 * Locally, app.localhost:<port> stands in for app.douchat.ai.
 */
export const onAppHost = (): boolean => location.hostname.startsWith('app.')

/** The main site: douchat.ai for app.douchat.ai, and the page's own origin elsewhere. */
export function siteOrigin(): string {
  if (!onAppHost()) return location.origin
  const url = new URL(location.origin)
  url.hostname = url.hostname.slice('app.'.length)
  return url.origin
}

/**
 * On the app's own host its pages live at the root (/chat/…). The build and
 * the sign-in return are under /app, so fold those into root addresses before
 * the app reads its route.
 */
export function normalizeAppAddress(): void {
  if (!onAppHost()) {
    // Opened as douchat.ai/app (static files reach the browser before any
    // server redirect can): continue on the app's own host.
    const target = new URL(location.href)
    target.hostname = `app.${location.hostname}`
    target.pathname = location.pathname.replace(/^\/app(?=\/|$)/, '') || '/'
    location.replace(target.toString())
    throw new Error('Moving to the web app host')
  }
  if (!(location.pathname === '/app' || location.pathname.startsWith('/app/'))) return
  history.replaceState(null, '', `${location.pathname.slice('/app'.length) || '/'}${location.search}`)
}
