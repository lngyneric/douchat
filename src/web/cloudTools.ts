import { normalizeAgentEmoji } from '../shared/avatar'
import { validateAgentFiles, type AgentFiles } from '../shared/agentCustomization'
import { editableIdentityFiles, identityFileSnapshot } from '../shared/agentFileEdits'
import type { AgentConfig, Conversation } from '../shared/types'
import { createCloudAgent, createGroup, updateAgent } from './agents'
import type { WebSync } from './webSync'

/**
 * Dr. Dou's contact management in the web app: the same create_agent,
 * update_agent, read_agent_configuration, create_group and update_group tools
 * the desktop runtime gives the account's system administrator, as OpenAI
 * function tools over the synced records. Attached-image avatars stay with the
 * desktop, since the web app does not send images.
 */

export interface ToolContext {
  sync: WebSync
  ownerId: string
  /** The administrator answering; it joins groups it creates. */
  self: AgentConfig
  /** A chat the tools created, so it can open with a greeting like one made by hand. */
  onCreated: (conversationId: string) => void
}

export function isSystemAdmin(agent: AgentConfig): boolean {
  return agent.systemRole === 'admin' && agent.capabilities?.includes('manage_agents') === true
}

export const agentManagementPrompt = [
  'You can manage the user’s Douchat agents. Treat 联系人、智能体、agent, and bot as equivalent names for a Douchat agent.',
  'When asked to configure a contact’s custom files, pass systemFiles to create_agent/update_agent: For a general request to set up or complete custom files, configure all three: IDENTITY.md for identity and responsibilities, SOUL.md for behavior principles, and BOOTSTRAP.md for first-task onboarding (how to gather missing inputs and begin work without requiring a greeting). Add AGENTS.md for workflows where useful. For a request naming specific files, edit only those. A description alone does not configure these files. Read existing files with read_agent_configuration and preserve unrelated content. Report only files actually saved.',
  'When the human asks to create one, call create_agent instead of explaining how to do it. If no name is provided, ask for a name before calling the tool. A description is optional and should remain empty unless the human supplies one.',
  'When asked to rename an existing group, change its emoji avatar, or add/remove agents, call update_group. Use addAgents/removeAgents for incremental membership changes; do not replace the group. Never create another group as a workaround. Confirm only after the update succeeds.',
  'When the human asks to create a group, call create_group with the requested name and existing agent nicknames. The human is included automatically; include yourself unless excluded. Use list_contacts to find exact names. Ask for clarification if a name is missing or ambiguous.',
  'When the human asks to rename an agent or change its nickname, emoji avatar, or description, call update_agent. Image avatars can only be set from the desktop app. Never claim that an agent or group was created or changed unless the corresponding tool succeeded.'
].join('\n')

const managedFiles = {
  type: 'object',
  description: 'Persistent Markdown instructions. IDENTITY.md defines role/responsibilities; SOUL.md defines behavior; AGENTS.md defines workflow. Not a profile description. Only supplied files change. Never include private user memory.',
  properties: Object.fromEntries(editableIdentityFiles.map((name) => [name, { type: 'string', maxLength: 100_000 }])),
  additionalProperties: false
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required } } })

export const agentManagementTools = [
  fn('list_contacts', 'List the account’s agents and group chats with their exact names and IDs.', {}),
  fn('read_agent_configuration', 'Read a managed contact’s current custom instructions before editing. Excludes personal user files and memory.',
    { agent: { type: 'string', description: 'Exact agent nickname or id' } }, ['agent']),
  fn('create_agent', 'Create a new Douchat contact/agent/bot. Use this whenever the human asks to create or add one.', {
    name: { type: 'string', description: 'Nickname for the new Douchat agent' },
    description: { type: 'string', description: 'Optional behavior description supplied by the human. Omit it to keep the description blank.' },
    emoji: { type: 'string', description: 'Exactly one emoji to use as the avatar. Choose a suitable emoji if the human asks for an emoji avatar without naming one.' },
    systemFiles: managedFiles
  }, ['name']),
  fn('update_agent', 'Change an existing Douchat agent’s nickname, emoji avatar, description, or persistent custom files. Read existing files with read_agent_configuration before modifying them.', {
    agent: { type: 'string', description: 'Exact current agent nickname or agent id' },
    name: { type: 'string', description: 'New nickname' },
    description: { type: 'string', description: 'New description. Use an empty string to clear it.' },
    emoji: { type: 'string', description: 'Exactly one emoji for the new avatar.' },
    removeAvatar: { type: 'boolean', description: 'Remove the custom avatar and emoji.' },
    systemFiles: managedFiles
  }, ['agent']),
  fn('create_group', 'Create a Douchat group with existing agents owned by the current account. Resolve exact names; never invent contacts. The current human joins automatically.', {
    name: { type: 'string', description: 'Group name requested by the human' },
    agents: { type: 'array', items: { type: 'string' }, description: 'Exact nicknames or IDs of existing agents to invite. The human is included automatically.' },
    includeSelf: { type: 'boolean', description: 'Include yourself; defaults to true. Set false only when the human excludes you.' }
  }, ['name', 'agents']),
  fn('update_group', 'Rename an existing group, set its emoji avatar, or add/remove agent members. Preserve its ID and history, and keep all members not explicitly removed.', {
    group: { type: 'string', description: 'Exact existing group ID or unambiguous group name.' },
    addAgents: { type: 'array', items: { type: 'string' }, description: 'Exact names or IDs of owned existing agents to add.' },
    removeAgents: { type: 'array', items: { type: 'string' }, description: 'Exact names or IDs of group agents to remove. Does not delete their contacts or history.' },
    name: { type: 'string', description: 'New group name, 1–100 characters.' },
    emoji: { type: 'string', description: 'One emoji for the group avatar.' }
  }, ['group'])
]

type Args = Record<string, unknown>
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function agents(context: ToolContext): AgentConfig[] {
  return context.sync.all<AgentConfig>('agent').filter((agent) => agent.ownerId === context.ownerId)
}

function resolveAgent(context: ToolContext, reference: string): AgentConfig {
  const all = agents(context)
  const exact = all.find((agent) => agent.id === reference.trim())
  if (exact) return exact
  const matches = all.filter((agent) => agent.name.trim().toLocaleLowerCase() === reference.trim().toLocaleLowerCase())
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`Several agents are named “${reference}”: ${matches.map((agent) => agent.id).join(', ')}. Use an ID.`)
  throw new Error(`No agent named “${reference}”. Use list_contacts for exact names.`)
}

function managed(files: unknown): AgentFiles | undefined {
  if (files === undefined) return undefined
  const validated = validateAgentFiles(files as AgentFiles)
  if (Object.keys(validated).some((name) => !(editableIdentityFiles as readonly string[]).includes(name))) {
    throw new Error('Personal user files cannot be changed through agent management.')
  }
  return validated
}

function emoji(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const normalized = normalizeAgentEmoji(text(value) ?? '')
  if (!normalized) throw new Error('The emoji avatar must contain exactly one emoji.')
  return normalized
}

/** Run one tool call; failures come back as text so the model can recover or explain. */
export async function runAgentManagementTool(context: ToolContext, name: string, args: Args): Promise<string> {
  try {
    return await run(context, name, args)
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function run(context: ToolContext, name: string, args: Args): Promise<string> {
  const { sync, ownerId, self } = context
  const groups = () => sync.all<Conversation>('conversation').filter((item) => item.type === 'group' && item.ownerId === ownerId && !item.remoteRoomId)
  switch (name) {
    case 'list_contacts':
      return JSON.stringify({
        agents: agents(context).map((agent) => ({ id: agent.id, name: agent.name, description: agent.instructions || agent.role || '' })),
        groups: groups().map((group) => ({ id: group.id, name: group.name, members: group.agentIds.map((id) => sync.get<AgentConfig>('agent', id)?.name ?? id) }))
      })
    case 'read_agent_configuration': {
      const agent = resolveAgent(context, text(args.agent) ?? '')
      return JSON.stringify({ agentId: agent.id, name: agent.name, systemFiles: identityFileSnapshot(agent.systemFiles) })
    }
    case 'create_agent': {
      const agentName = (text(args.name) ?? '').trim().slice(0, 80)
      if (!agentName) return 'An agent name is required. Ask the human what to call it.'
      const duplicate = agents(context).find((agent) => agent.name.trim().toLocaleLowerCase() === agentName.toLocaleLowerCase())
      if (duplicate) return `An agent named “${duplicate.name}” already exists (${duplicate.id}).`
      const created = await createCloudAgent(sync, ownerId, {
        name: agentName, avatar: '', avatarEmoji: emoji(args.emoji) ?? '', role: 'Assistant',
        instructions: text(args.description)?.trim().slice(0, 4000) ?? '', labels: '', color: '',
        ...(args.systemFiles !== undefined ? { systemFiles: managed(args.systemFiles) } : {})
      })
      context.onCreated(`direct-${created.id}`)
      return `Created the agent “${created.name}”. Saved custom files: ${Object.keys(created.systemFiles ?? {}).join(', ') || 'none'}. It is available in the contact and message lists.`
    }
    case 'update_agent': {
      const agent = resolveAgent(context, text(args.agent) ?? '')
      const update: Parameters<typeof updateAgent>[2] = {}
      const files = managed(args.systemFiles)
      if (files) update.systemFiles = files
      if (args.name !== undefined) {
        const nextName = (text(args.name) ?? '').trim().slice(0, 80)
        if (!nextName) return 'The new nickname cannot be blank.'
        const duplicate = agents(context).find((other) => other.id !== agent.id && other.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase())
        if (duplicate) return `Another agent is already named “${duplicate.name}”.`
        update.name = nextName
      }
      if (args.description !== undefined) update.instructions = (text(args.description) ?? '').trim().slice(0, 4000)
      if (args.emoji !== undefined) update.avatarEmoji = emoji(args.emoji)
      if (args.removeAvatar === true) { update.avatar = ''; update.avatarEmoji = '' }
      if (!Object.keys(update).length) return 'No nickname, avatar, description, or custom-file change was provided.'
      await updateAgent(sync, agent.id, update)
      return `Updated the agent “${update.name ?? agent.name}”. Saved custom files: ${Object.keys(files ?? {}).join(', ') || 'none changed'}.`
    }
    case 'create_group': {
      const groupName = (text(args.name) ?? '').trim()
      if (!groupName || groupName.length > 100) return 'Please provide a group name of 1–100 characters.'
      const ids = args.includeSelf === false ? [] : [self.id]
      for (const reference of list(args.agents)) ids.push(resolveAgent(context, reference).id)
      const agentIds = [...new Set(ids)]
      if (!agentIds.length) return 'Choose at least one existing agent.'
      const group = await createGroup(sync, ownerId, { name: groupName, agentIds, leadAgentId: agentIds.includes(self.id) ? self.id : agentIds[0] })
      context.onCreated(group.id)
      return `Created group “${group.name}” with ${agentIds.map((id) => sync.get<AgentConfig>('agent', id)?.name ?? id).join(', ')}. It is available in the message list.`
    }
    case 'update_group': {
      const reference = text(args.group) ?? ''
      const exact = groups().find((group) => group.id === reference)
      const matches = exact ? [exact] : groups().filter((group) => group.name === reference)
      if (matches.length !== 1) return 'Select one existing group by exact ID or unambiguous name. Never create a replacement group.'
      const target = matches[0]
      const nextName = args.name !== undefined ? (text(args.name) ?? '').trim() : undefined
      if (nextName !== undefined && (!nextName || nextName.length > 100)) return 'Group name must be 1–100 characters.'
      const avatarEmoji = emoji(args.emoji)
      const added = list(args.addAgents).map((item) => resolveAgent(context, item).id)
      const removed = new Set(list(args.removeAgents).map((item) => resolveAgent(context, item).id))
      if (added.some((id) => removed.has(id))) return 'Cannot add and remove the same member in one operation.'
      const agentIds = added.length || removed.size ? [...new Set([...target.agentIds.filter((id) => !removed.has(id)), ...added])] : undefined
      if (agentIds && !agentIds.length) return 'Keep at least one agent in the group.'
      if (nextName === undefined && !avatarEmoji && !agentIds) return 'Provide a name, emoji, or members to add/remove.'
      let result = target
      await sync.mutate([{ kind: 'conversation', id: target.id, apply: (current) => {
        if (!current) throw new Error('Group not found')
        const next = structuredClone(current) as unknown as Conversation
        if (nextName) { next.name = nextName; next.autoNamed = false }
        if (avatarEmoji) { next.avatarEmoji = avatarEmoji; next.avatar = '' }
        if (agentIds) {
          next.agentIds = agentIds
          if (!next.leadAgentId || !agentIds.includes(next.leadAgentId)) next.leadAgentId = agentIds[0]
        }
        next.updatedAt = Date.now()
        result = next
        return next as unknown as typeof current
      } }])
      return `Updated group “${result.name}”. Its message history is preserved. Current agent members: ${result.agentIds.map((id) => sync.get<AgentConfig>('agent', id)?.name ?? id).join(', ')}.`
    }
    default:
      return `Error: unknown tool ${name}.`
  }
}
