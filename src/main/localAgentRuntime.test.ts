import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexThreadId, localAgentExecutable, localAgentArgs, localAgentEnvironment, localAgentExitError, localAgentReply, localAgentText, shouldRetryClaudeWithAccountLogin } from './localAgentRuntime'
describe('local agent output', () => {
  it('trusts only the Gemini child workspace without mutating the parent environment', () => {
    const env = { PATH: '/bin' }
    expect(localAgentEnvironment('gemini', env)).toEqual({ PATH: '/bin', GEMINI_CLI_TRUST_WORKSPACE: 'true' })
    expect(env).toEqual({ PATH: '/bin' })
    expect(localAgentEnvironment('claude', env)).toBe(env)
    expect(localAgentArgs('gemini', 'Hello', '/tmp/output')).not.toContain('--yolo')
  })

  it('retries the specific Claude connector conflict with account-login credentials', () => {
    const env = {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'secret-api-key',
      ANTHROPIC_AUTH_TOKEN: 'secret-auth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth-token',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      SAFE_VALUE: 'kept'
    }
    const conflict = new Error(
      'Claude Code: claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set'
    )

    expect(shouldRetryClaudeWithAccountLogin('claude', conflict, env)).toBe(true)
    expect(localAgentEnvironment('claude', env, true)).toEqual({ PATH: '/bin', SAFE_VALUE: 'kept' })
    expect(env.ANTHROPIC_API_KEY).toBe('secret-api-key')
    expect(shouldRetryClaudeWithAccountLogin('claude', new Error('Credit balance is too low'), env)).toBe(true)
    expect(shouldRetryClaudeWithAccountLogin('codex', conflict, env)).toBe(false)
  })
  it('only retries an explicit Claude API credit rejection with a conflicting API key', () => {
    const error = new Error('Claude Code: Credit balance is too low')
    expect(shouldRetryClaudeWithAccountLogin('claude', error, { ANTHROPIC_API_KEY: 'test' })).toBe(true)
    expect(shouldRetryClaudeWithAccountLogin('claude', error, {})).toBe(false)
    expect(shouldRetryClaudeWithAccountLogin('codex', error, { ANTHROPIC_API_KEY: 'test' })).toBe(false)
    expect(shouldRetryClaudeWithAccountLogin('claude', new Error('Tool failed: Credit balance is too low'), { ANTHROPIC_API_KEY: 'test' })).toBe(false)
  })
  it('extracts final replies without leaking CLI metadata', () => {
    expect(localAgentText('claude', '{"result":"Hello","session_id":"private"}')).toBe('Hello')
    expect(localAgentText('gemini', '{"response":"Hello","stats":{}}')).toBe('Hello')
    expect(localAgentText('grok', '{"text":"Hello","sessionId":"private","usage":{"input_tokens":3}}')).toBe('Hello')
    expect(localAgentText('cursor', '{"result":"Hello"}')).toBe('Hello')
    expect(localAgentText('opencode', '{"type":"step_start"}\n{"type":"text","part":{"text":"Hello"}}\n')).toBe('Hello')
    expect(localAgentText('openclaw', '{"ok":true,"status":"ok","final":"Hello"}')).toBe('Hello')
    for (const id of ['fastclaw', 'hermes', 'omp', 'codebuddy', 'agenttars']) expect(localAgentText(id, 'Hello\n')).toBe('Hello')
  })
  it('reports authentication or agent failures instead of treating errors as replies', () => {
    expect(() => localAgentText('claude', '{"is_error":true,"result":"Log in first"}')).toThrow('Log in first')
    expect(() => localAgentText('gemini', '{"error":{"message":"Missing credentials"}}')).toThrow('Missing credentials')
    expect(() => localAgentText('grok', '{"error":"Authentication required"}')).toThrow('Authentication required')
    expect(() => localAgentText('opencode', '{"type":"error","error":{"data":{"message":"No model"}}}')).toThrow('No model')
    expect(() => localAgentText('openclaw', '{"ok":false,"status":"error","error":{"message":"Log in first"}}')).toThrow('Log in first')
  })
  it('prioritizes the OpenClaw result error over unrelated startup warnings', () => {
    const cause = 'No route-compatible authentication source is configured for openai.'
    const warning = '[skills] Skill precedence collision: skill="skill-creator"'
    expect(localAgentExitError({ id: 'openclaw', name: 'OpenClaw' }, 1,
      JSON.stringify({ ok: false, status: 'error', error: { message: cause } }), warning).message
    ).toBe(`OpenClaw: ${cause}\n${warning}`)
    expect(localAgentExitError({ id: 'openclaw', name: 'OpenClaw' }, 1, 'not json', cause).message).toBe(`OpenClaw: ${cause}`)
  })
  it('keeps useful structured stdout when a CLI exits non-zero', () => {
    expect(localAgentExitError(
      { id: 'claude', name: 'Claude Code' },
      1,
      '{"is_error":true,"result":"Please run /login"}',
      ''
    ).message).toBe('Claude Code: Please run /login')
    expect(localAgentExitError({ id: 'claude', name: 'Claude Code' }, 1, '', '').message).toBe(
      'Claude Code: Exited with status 1'
    )
  })
  it('allows built-in web research without bypassing shell permissions', () => {
    expect(localAgentArgs('claude', 'Research', '/tmp/output')).toContain('WebSearch,WebFetch')
    expect(localAgentArgs('codex', 'Research', '/tmp/output')).toContain('web_search="live"')
    expect(localAgentArgs('codex', 'Research', '/tmp/output')).toContain('workspace-write')
    expect(localAgentArgs('codex', 'Research', '/tmp/output')).toContain('sandbox_workspace_write.network_access=true')
    expect(localAgentArgs('codex', 'Research', '/tmp/output')).toContain('--json')
    expect(localAgentArgs('grok', 'Research', '/tmp/output')).toEqual(expect.arrayContaining([
      '--output-format', 'streaming-json', '--permission-mode', 'dontAsk', '--sandbox', 'strict',
      '--allow', 'Read', 'Grep', 'WebFetch', 'WebSearch', 'image_gen', 'image_edit'
    ]))
    expect(localAgentArgs('grok', 'Research', '/tmp/output')).not.toContain('--always-approve')
    expect(localAgentArgs('fastclaw', 'hi', '/tmp/output')).toEqual(['chat', '--query', 'hi'])
    expect(localAgentArgs('fastclaw', 'hi', '/tmp/output', true, 'douchat-1')).toEqual(['chat', '--resume', 'douchat-1', '--query', 'hi'])
    // Grok ends the whole turn as `cancelled` when a dontAsk call is denied, so it
    // must only see the tools it may run (no terminal, writes or MCP meta tools).
    const grok = localAgentArgs('grok', 'Research', '/tmp/output')
    expect(grok.at(grok.indexOf('--tools') + 1)?.split(',').sort()).toEqual(['grep', 'image_edit', 'image_gen', 'list_dir', 'read_file', 'web_fetch', 'web_search'])
    expect(grok.at(grok.indexOf('--disallowed-tools') + 1)).toBe('search_tool,use_tool')
  })
  it('links Codex image output to the exact CLI thread', () => {
    expect(codexThreadId([
      '{"type":"thread.started","thread_id":"01a0af4f-0611-78f0-971f-52b8749140a0"}',
      '{"type":"item.completed"}'
    ].join('\n'))).toBe('01a0af4f-0611-78f0-971f-52b8749140a0')
    expect(codexThreadId('{"type":"thread.started","thread_id":"../../escape"}')).toBeUndefined()
  })
  it('accepts an image-only Codex reply and rejects a truly empty reply', () => {
    const image = { name: 'cat.png', mimeType: 'image/png' as const, data: Uint8Array.from([137, 80, 78, 71]) }
    expect(localAgentReply('Codex', '', [image])).toEqual({ text: '', images: [image] })
    expect(() => localAgentReply('Codex', '', [])).toThrow(
      'Codex finished without a text or image response. Check its local login and configuration.'
    )
  })
  it('passes prompts as data and does not bypass CLI permissions', () => {
    const prompt = '$(touch /tmp/should-not-exist); --force'
    for (const id of ['claude', 'gemini', 'grok', 'cursor', 'opencode', 'kimi', 'fastclaw', 'hermes', 'omp', 'codebuddy', 'agenttars']) {
      const args = localAgentArgs(id, prompt, '/tmp/output')
      expect(args).toContain(prompt)
      expect(args.join(' ')).not.toContain('--dangerously')
    }
    expect(localAgentArgs('codex', prompt, '/tmp/output')).toContain('workspace-write')
    expect(localAgentArgs('openclaw', prompt, '/tmp/output')).toEqual(expect.arrayContaining(['agent', 'exec', '--message-file', '-', '--json']))
    expect(localAgentArgs('omp', prompt, '/tmp/output')).toContain('--no-tools')
    expect(localAgentArgs('codebuddy', prompt, '/tmp/output')).toEqual(['-p', '--output-format', 'text', '--', prompt])
    expect(localAgentArgs('agenttars', prompt, '/tmp/output')).toEqual(['--headless', '--quiet', '--format', 'text', '--input', prompt])
  })
})

it('uses an installed macOS Grok compatibility binary while keeping strict sandboxing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'douchat-grok-test-'))
  const official = '/official/grok'
  const compatible = join(home, '.douchat', 'local-tools', 'grok', process.arch, 'grok')
  try {
    expect(await localAgentExecutable('grok', official, 'darwin', home)).toBe(official)
    await mkdir(join(compatible, '..'), { recursive: true })
    await writeFile(compatible, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(await localAgentExecutable('grok', official, 'darwin', home)).toBe(compatible)
    expect(await localAgentExecutable('grok', official, 'win32', home)).toBe(official)
    expect(await localAgentExecutable('claude', official, 'darwin', home)).toBe(official)
    expect(localAgentArgs('grok', 'hello', '/tmp/reply')).toEqual(expect.arrayContaining(['--sandbox', 'strict', '--permission-mode', 'dontAsk']))
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('trusts Cursor only when launching in an application-owned workspace', () => {
  expect(localAgentArgs('cursor', 'hello', '/tmp/reply')).not.toContain('--trust')
  const args = localAgentArgs('cursor', 'hello', '/tmp/reply', true)
  expect(args).toContain('--trust')
  expect(args).toEqual(expect.arrayContaining(['--mode', 'ask']))
  expect(args).not.toContain('--force')
})

 it('reads Kimi structured replies without terminal bullets or tool output and preserves Markdown', () => {
  expect(localAgentArgs('kimi', 'hello', '/tmp/out')).toEqual(['--prompt', 'hello', '--output-format', 'stream-json'])
  const output = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1' }] },
    { role: 'tool', content: 'private tool output' },
    { role: 'meta', content: 'session resumed' },
    { role: 'assistant', content: 'Kimi 到，6 ✅' },
    { role: 'assistant', content: [{ type: 'think', text: 'private thinking' }, { type: 'text', text: '• Actual list item\n\n```python\n  indented()\n```' }] }
  ].map(message => JSON.stringify(message)).join('\n')
  expect(localAgentText('kimi', output)).toBe('Kimi 到，6 ✅\n\n• Actual list item\n\n```python\n  indented()\n```')
})
