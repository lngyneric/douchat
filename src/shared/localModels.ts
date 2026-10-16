export interface LocalModel { id: string; name: string }
export interface LocalModelList { models: LocalModel[]; source: 'agent' | 'manual'; configurable: boolean }
export const configurableLocalAgents = ['codex', 'claude', 'opencode', 'cursor', 'grok', 'gemini', 'kimi', 'hermes', 'omp', 'openclaw', 'codebuddy']
export function localModelId(value?: string): string | undefined {
  if (!value || value === 'default') return undefined
  const model = value.trim()
  if (!model || model.length > 256 || /[\r\n\0]/.test(model) || model.startsWith('-')) throw new Error('Invalid model ID')
  return model
}
export function withLocalModel(id: string, args: string[], value?: string): string[] {
  const model = localModelId(value)
  if (!model) return args
  if (!configurableLocalAgents.includes(id)) throw new Error('This local agent does not support a model override')
  // Insert before the argument terminator, keeping prompts and IDs as separate argv values.
  const separator = args.indexOf('--')
  const index = separator >= 0 ? separator : ['codex', 'opencode'].includes(id) ? 1 : id === 'openclaw' ? 2 : 0
  return [...args.slice(0, index), '--model', model, ...args.slice(index)]
}
