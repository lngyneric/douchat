import { normalizeAgentEmoji } from '../shared/avatar'
import type { SyncRecord } from '../shared/cloudSync'
import type { AgentConfig, ChatMessage, Conversation, CreateAgentInput, CreateGroupInput, Routine, Topic, UpdateAgentInput } from '../shared/types'
import type { Mutation, WebSync } from './webSync'

/**
 * Cloud agents created and edited in the web app. A cloud agent is only a
 * synced record (name, role, instructions, model), so the web app can manage
 * it exactly as a desktop would; records match what a desktop writes. Agents
 * that run a CLI on a computer are set up from the desktop app.
 */

export const DESKTOP_AGENT_SETUP = 'Agents that run on your computer are set up in the Douchat desktop app.'
const AGENT_COLORS = ['#14B8A6', '#FF5DA8', '#7C6CF2', '#F59E42', '#3B82F6', '#84A737']
const GATEWAY_PROVIDER_ID = 'gateway'
const record = (value: unknown) => value as SyncRecord

export function agentId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'}-${crypto.randomUUID()}`
}

/** A new cloud agent and its direct chat, like a desktop's createAgent. */
export async function createCloudAgent(sync: WebSync, ownerId: string, input: CreateAgentInput): Promise<AgentConfig> {
  if (input.localAgentId || input.customModel) throw new Error(DESKTOP_AGENT_SETUP)
  const name = input.name.trim().slice(0, 80)
  if (!name) throw new Error('An agent name is required.')
  const now = Date.now()
  const avatar = /^data:image\/(png|jpeg|webp);base64,/.test(input.avatar?.trim() ?? '') && input.avatar!.length <= 1_500_000 ? input.avatar!.trim() : ''
  const agents = sync.all<AgentConfig>('agent')
  const agent: AgentConfig = {
    id: agentId(name), ownerId, name, role: input.role?.trim() ?? '', instructions: input.instructions?.trim().slice(0, 4000) ?? '',
    labels: input.labels?.trim() ?? '', color: input.color || AGENT_COLORS[agents.length % AGENT_COLORS.length],
    avatar, avatarEmoji: avatar ? '' : normalizeAgentEmoji(input.avatarEmoji), avatarSeed: crypto.randomUUID(),
    provider: GATEWAY_PROVIDER_ID, model: input.cloudModel?.model || 'douchat-default',
    ...(input.thinkingLevel && input.thinkingLevel !== 'default' ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.systemFiles ? { systemFiles: input.systemFiles } : {}),
    createdAt: now
  }
  const topic: Topic = { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now }
  const conversation: Conversation = {
    ownerId, id: `direct-${agent.id}`, type: 'direct', name, agentIds: [agent.id], topics: [topic],
    activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now
  }
  await sync.mutate([
    { kind: 'agent', id: agent.id, apply: () => record(agent) },
    { kind: 'conversation', id: conversation.id, apply: () => record(conversation) }
  ])
  return agent
}

/** Profile edits; how an agent runs (its CLI, arguments, custom model) stays with the desktop. */
export async function updateAgent(sync: WebSync, id: string, input: UpdateAgentInput): Promise<void> {
  if (input.startupArgs || input.customModel) throw new Error(DESKTOP_AGENT_SETUP)
  await sync.mutate([{
    kind: 'agent',
    id,
    apply: (current) => {
      if (!current) throw new Error('Contact not found')
      const next = structuredClone(current) as unknown as AgentConfig
      const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K] | undefined) => {
        if (value === undefined) return
        next[key] = value
        // A built-in agent keeps the person's edits as overrides over its template.
        if (next.systemRole === 'admin' && ['name', 'role', 'instructions', 'labels', 'avatar', 'avatarEmoji'].includes(key)) {
          next.userOverrides = { ...next.userOverrides, [key]: value }
        }
      }
      set('name', input.name?.trim() || undefined)
      set('role', input.role?.trim())
      set('instructions', input.instructions?.trim().slice(0, 4000))
      set('labels', input.labels?.trim())
      if (input.avatar !== undefined) { set('avatar', input.avatar); if (input.avatar) set('avatarEmoji', '') }
      if (input.avatarEmoji !== undefined) { const emoji = normalizeAgentEmoji(input.avatarEmoji); set('avatarEmoji', emoji); if (emoji) set('avatar', '') }
      if (input.thinkingLevel !== undefined) { if (input.thinkingLevel === 'default') delete next.thinkingLevel; else next.thinkingLevel = input.thinkingLevel }
      if (input.cloudModel?.model && !next.localAgentId) next.model = input.cloudModel.model
      if (input.systemFiles) next.systemFiles = { ...next.systemFiles, ...input.systemFiles }
      return record(next)
    }
  }])
}

/** Remove an agent, its direct chats, and its place in groups, as a desktop does. */
export async function deleteAgent(sync: WebSync, id: string): Promise<void> {
  const agent = sync.get<AgentConfig>('agent', id)
  if (!agent) return
  if (agent.systemRole === 'admin') throw new Error('The system administrator cannot be deleted')
  const mutations: Mutation[] = [{ kind: 'agent', id, apply: () => null }]
  const removed = new Set<string>()
  for (const conversation of sync.all<Conversation>('conversation')) {
    if (conversation.type === 'direct' && conversation.agentIds.includes(id)) {
      removed.add(conversation.id)
      mutations.push({ kind: 'conversation', id: conversation.id, apply: () => null })
    } else if (conversation.agentIds.includes(id)) {
      mutations.push({ kind: 'conversation', id: conversation.id, apply: (current) => {
        if (!current) return null
        const next = structuredClone(current) as unknown as Conversation
        next.agentIds = next.agentIds.filter((member) => member !== id)
        if (next.leadAgentId === id) next.leadAgentId = next.agentIds[0]
        return record(next)
      } })
    }
  }
  for (const message of sync.all<ChatMessage>('message')) if (removed.has(message.conversationId)) mutations.push({ kind: 'message', id: message.id, apply: () => null })
  for (const routine of sync.all<Routine>('routine')) if (routine.agentId === id || removed.has(routine.conversationId)) mutations.push({ kind: 'routine', id: routine.id, apply: () => null })
  await sync.mutate(mutations)
}

/** A group of the account's agents, like a desktop's createGroup. */
export async function createGroup(sync: WebSync, ownerId: string, input: CreateGroupInput): Promise<Conversation> {
  const agents = new Map(sync.all<AgentConfig>('agent').map((agent) => [agent.id, agent]))
  const agentIds = [...new Set(input.agentIds)].filter((id) => agents.has(id))
  const now = Date.now()
  const topic: Topic = { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now }
  const conversation: Conversation = {
    ownerId, id: `group-${crypto.randomUUID()}`, type: 'group', autoNamed: !input.name.trim(),
    name: input.name.trim() || agentIds.map((id) => agents.get(id)?.name).filter(Boolean).join(', ') || 'New group',
    description: input.description?.trim() || undefined, agentIds,
    leadAgentId: agentIds.includes(input.leadAgentId ?? '') ? input.leadAgentId : agentIds[0],
    topics: [topic], activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now
  }
  await sync.mutate([{ kind: 'conversation', id: conversation.id, apply: () => record(conversation) }])
  return conversation
}
