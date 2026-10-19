/**
 * Records every Douchat client keeps in the cloud. The desktop store, the web
 * app and the iOS app read and write the same JSON shapes; fields that only
 * mean something on one computer (folders, file paths, local versions) stay
 * on that computer and are re-attached when a cloud copy is written locally.
 */

export type SyncKind = 'agent' | 'conversation' | 'message' | 'privateMessage' | 'routine'
/** Everything on the wire: stored records plus web send requests, which no device stores. */
export type SyncWireKind = SyncKind | 'request' | 'activity' | 'rpc' | 'device' | 'roomRead'
export type SyncRecord = Record<string, unknown>

/**
 * How far the person has read a shared room or friend chat. Those chats come
 * from the social service rather than cloud sync, so without this every
 * client would keep its own read state. One record per room, keyed by room
 * id; the later time wins.
 */
export interface RoomReadMark {
  roomId: string
  readAt: number
}

/** Parents before children, so a fresh device never writes an orphan. */
export const SYNC_KINDS: readonly SyncKind[] = ['agent', 'conversation', 'routine', 'message', 'privateMessage']

export interface SyncChange {
  kind: SyncWireKind
  id: string
  seq: number
  revision: number
  deleted: boolean
  data: SyncRecord | null
  deviceId: string | null
  updatedAt: number
}

export interface SyncOp {
  opId: string
  kind: SyncWireKind
  id: string
  baseRevision: number
  deleted?: boolean
  data?: SyncRecord
}

export type SyncPushResult =
  | { opId: string; status: 'applied'; revision: number; seq: number }
  | { opId: string; status: 'conflict'; current: SyncChange }
  /** The service will not store this write (sent only to clients that accept it). */
  | { opId: string; status: 'rejected'; error: string }

/** Sent with every push: this client handles a per-write rejection instead of a refused request. */
export const SYNC_PUSH_ACCEPTS = ['rejected'] as const

/** `revision` is each store's own edit counter, never a cloud version. */
const DEVICE_FIELDS: Record<SyncKind, readonly string[]> = {
  agent: ['revision', 'systemFilesDirectory'],
  conversation: ['revision', 'workspacePath', 'agentWorkspaces', 'allowedFolders'],
  routine: [],
  message: [],
  privateMessage: []
}
/** Skill resource files can be megabytes and live in a local directory. */
const SKILL_DEVICE_FIELDS = ['directory', 'files', 'filesOmitted'] as const

/** Human chats and shared groups already synchronize through the social service. */
export function isSocialConversation(conversation: SyncRecord | undefined): boolean {
  return Boolean(conversation && (conversation.person || conversation.remoteRoomId || conversation.socialRoom))
}

/** The cloud copy of a local record: device-only fields removed. */
export function cloudRecord(kind: SyncKind, record: SyncRecord): SyncRecord {
  const result: SyncRecord = { ...record }
  for (const field of DEVICE_FIELDS[kind]) delete result[field]
  if (kind === 'agent' && Array.isArray(result.skills)) {
    result.skills = (result.skills as SyncRecord[]).map((skill) => {
      const copy = { ...skill }
      for (const field of SKILL_DEVICE_FIELDS) delete copy[field]
      return copy
    })
  }
  return result
}

/** A cloud record as this computer stores it: its own device-only fields kept. */
export function localRecord(kind: SyncKind, cloud: SyncRecord, local?: SyncRecord): SyncRecord {
  const result: SyncRecord = { ...cloud }
  for (const field of DEVICE_FIELDS[kind]) {
    if (local && local[field] !== undefined) result[field] = local[field]
    else delete result[field]
  }
  if (kind === 'agent' && Array.isArray(result.skills)) {
    const localSkills = new Map(((local?.skills as SyncRecord[] | undefined) ?? []).map((skill) => [skill.id, skill]))
    result.skills = (result.skills as SyncRecord[]).map((skill) => {
      const previous = localSkills.get(skill.id)
      const copy = { ...skill }
      for (const field of SKILL_DEVICE_FIELDS) if (previous?.[field] !== undefined) copy[field] = previous[field]
      return copy
    })
  }
  return result
}

/** JSON with sorted keys, so equal records compare equal after a round trip. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as SyncRecord).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item)
}

export const sameRecord = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)

/**
 * Field-level three-way merge. A field this device changed since the last
 * cloud copy it saw keeps the local value; every other field takes the
 * cloud's. Without a base, the cloud copy wins except for fields it lacks.
 */
export function mergeRecords(base: SyncRecord | undefined, local: SyncRecord, remote: SyncRecord): SyncRecord {
  const result: SyncRecord = { ...remote }
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const changedHere = base ? !sameRecord(local[key], base[key]) : !(key in remote)
    if (!changedHere) continue
    if (local[key] === undefined) delete result[key]
    else result[key] = local[key]
  }
  return result
}

/** A conversation the user let support read; see douchat-tanstack sync/support.ts. */
export interface SupportShare {
  id: string
  conversationId: string
  note: string
  createdAt: number
  expiresAt: number
  status: 'active' | 'expired' | 'revoked'
  /** How many times support opened it. */
  views: number
  lastViewedAt: number | null
}
export const SUPPORT_SHARE_HOURS = [24, 72, 168] as const

/**
 * A message typed in the web app. The web app cannot run agents, so it writes
 * this request; one online desktop claims it (a revision-checked write, so
 * only one wins), sends it through its normal chat pipeline, and deletes the
 * request once the real message and reply exist.
 */
export interface WebSendRequest {
  id: string
  conversationId: string
  text: string
  createdAt: number
  state: 'pending' | 'claimed' | 'failed'
  deviceId?: string
  claimedAt?: number
  error?: string
}
/**
 * A reply in progress on a desktop (the "task submitted, starting…" line and
 * any streamed text), one record per conversation while it lasts. A desktop
 * refreshes it while working and deletes it when done; a copy that stopped
 * being refreshed belongs to a desktop that went away.
 */
export interface SyncedActivity {
  conversationId: string
  activity: import('./types').ConversationActivityState
  deviceId: string
  updatedAt: number
}
export const ACTIVITY_REFRESH_MS = 15_000
export const ACTIVITY_STALE_MS = 60_000

/** Requests nobody claimed within this long are not run any more. */
export const WEB_REQUEST_TTL_MS = 24 * 3600_000
