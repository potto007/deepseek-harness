import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import { apply, Config, inject, name } from '../src/index.ts'

/**
 * The live check for this package: pi-ai's `anthropic-messages` implementation
 * selects Bearer auth and the Claude Code beta headers from the `sk-ant-oat`
 * prefix alone, so what a real request proves is that the token this source
 * serves is one Anthropic accepts on that path. The request is deliberately
 * tiny; it still draws from the account's extra usage.
 */
const DOCUMENT = join(homedir(), '.claude', '.credentials.json')
const REF = credentialRef('ANTHROPIC_OAUTH_TOKEN')
const plugin = { name, inject: [...inject], Config, apply }

describe.skipIf(!existsSync(DOCUMENT))('the Claude Code token against the live Anthropic API', () => {
  it('resolves a token the Messages API accepts', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    await ctx.plugin(plugin, {})

    const resolved = await ctx.credentials.resolve(REF)
    // An expired token is this source's normal absent answer, and one `claude`
    // run is the remedy; it is not a regression this test can assert against.
    if (resolved === undefined) return

    expect(resolved.source).toBe('claude-code')
    expect(resolved.value.startsWith('sk-ant-oat')).toBe(true)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${resolved.value}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
    })

    expect(response.status).toBe(200)
  })
})
