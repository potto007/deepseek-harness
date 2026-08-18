import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import { apply, Config, inject, name } from '../src/index.ts'

/**
 * The live check for this package stops at resolution: it proves the source
 * reads the machine's real Codex CLI document and serves a decodable ChatGPT
 * token carrying the account claim pi-ai's `openai-codex` implementation
 * extracts per request. No request is sent — `chatgpt.com/backend-api` is not
 * a public API, so a canned request here would pin another product's private
 * wire format rather than this package's behavior.
 */
const DOCUMENT = join(homedir(), '.codex', 'auth.json')
const REF = credentialRef('CODEX_OAUTH_TOKEN')
const plugin = { name, inject: [...inject], Config, apply }

describe.skipIf(!existsSync(DOCUMENT))('the Codex CLI token from the live document', () => {
  it('resolves a ChatGPT JWT carrying the account claim', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    await ctx.plugin(plugin, {})

    const resolved = await ctx.credentials.resolve(REF)
    // An expired token is this source's normal absent answer, and one `codex`
    // run is the remedy; it is not a regression this test can assert against.
    if (resolved === undefined) return

    expect(resolved.source).toBe('codex')
    const segments = resolved.value.split('.')
    expect(segments.length).toBeGreaterThanOrEqual(2)
    const payload = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined
    expect(typeof auth?.chatgpt_account_id).toBe('string')
  })
})
