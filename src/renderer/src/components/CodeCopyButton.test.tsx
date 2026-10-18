// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeCopyButton } from './CodeCopyButton'
import { MessageMarkdown } from './MessageMarkdown'
vi.mock('../preferences', () => ({ t: (text: string) => text }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
const root = createRoot(container)
afterEach(() => vi.useRealTimers())
it('copies the raw code through the desktop bridge and shows success or failure', async () => {
  vi.useFakeTimers()
  const copyText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'douchat', { configurable: true, value: { copyText } })
  const code = '<div>hello</div>\n  indented\n'
  await act(async () => root.render(<CodeCopyButton code={code} />))
  await act(async () => container.querySelector('button')!.click())
  expect(copyText).toHaveBeenCalledWith(code)
  expect(container.textContent).toBe('Copied')
  expect(container.querySelector('button')!.dataset.copyState).toBe('copied')
  await act(async () => vi.advanceTimersByTime(2500))
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Copy code')
  copyText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toBe('Could not copy code')
  expect(container.querySelector('button')!.dataset.copyState).toBe('failed')
  await act(async () => root.unmount())
})

it.each(['', 'text', 'plaintext', 'unrecognized-language', 'html'])('copies a %s fence through the native clipboard with visible feedback', async (language) => {
  const element = document.createElement('div')
  const mounted = createRoot(element)
  const copyText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'douchat', { configurable: true, value: { copyText } })
  const code = 'first line\n  indented <text> & content'
  try {
    await act(async () => mounted.render(<MessageMarkdown text={'Surrounding prose\n\n```' + language + '\n' + code + '\n```'} />))
    const button = element.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')!
    expect(button).not.toBeNull()
    await act(async () => button.click())
    expect(copyText).toHaveBeenCalledWith(code + '\n')
    expect(button.textContent).toBe('Copied')
    expect(button.dataset.copyState).toBe('copied')
  } finally {
    await act(async () => mounted.unmount())
  }
})
