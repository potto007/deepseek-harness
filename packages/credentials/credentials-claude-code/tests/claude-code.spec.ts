import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import { apply, Config, inject, name, resolveSpec, SOURCE_ID } from '../src/index.ts'

const REF = credentialRef('ANTHROPIC_OAUTH_TOKEN')
const HOUR = 3_600_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-code-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Claude Code writes its document owner-only; the tests seed it the same way. */
async function documentAt(content: string, mode = 0o600): Promise<string> {
  const filename = join(await tempDir(), '.credentials.json')
  await writeFile(filename, content, { mode })
  await chmod(filename, mode)
  return filename
}

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-token',
      refreshToken: 'sk-ant-ort01-secret',
      expiresAt: Date.now() + HOUR,
      ...overrides,
    },
  })
}

/** The plugin exactly as the loader assembles it from the module namespace. */
const plugin = { name, inject: [...inject], Config, apply }

async function boot(path: string, ref?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, {})
  await ctx.plugin(plugin, { path, ...ref === undefined ? {} : { ref } })
  return ctx
}

describe('resolveSpec', () => {
  it('defaults the document to the Claude Code home path and the reference to the Anthropic token', () => {
    const spec = resolveSpec({})
    expect(spec.filename.endsWith(join('.claude', '.credentials.json'))).toBe(true)
    expect(spec.ref).toBe('ANTHROPIC_OAUTH_TOKEN')
  })

  it('takes an explicit path and reference', () => {
    expect(resolveSpec({ path: '/tmp/x.json', ref: 'CLAUDE_TOKEN' }))
      .toEqual({ filename: '/tmp/x.json', ref: 'CLAUDE_TOKEN' })
  })

  it('refuses a reference that is not a POSIX shell identifier', () => {
    expect(() => resolveSpec({ ref: 'not a ref' })).toThrow(TypeError)
  })
})

describe('the Claude Code credential source', () => {
  it('serves the stored access token for the configured reference', async () => {
    const ctx = await boot(await documentAt(document()))
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-token', source: SOURCE_ID })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: SOURCE_ID, writable: true })
  })

  it('answers no other reference', async () => {
    const ctx = await boot(await documentAt(document()))
    expect(await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))).toBeUndefined()
  })

  it('answers a reference the configuration renames', async () => {
    const ctx = await boot(await documentAt(document()), 'CLAUDE_TOKEN')
    expect(await ctx.credentials.resolve(credentialRef('CLAUDE_TOKEN')))
      .toEqual({ value: 'sk-ant-oat01-token', source: SOURCE_ID })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('stays silent when the document is absent', async () => {
    const ctx = await boot(join(await tempDir(), 'absent', '.credentials.json'))
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('reports an expired token as absent and names the remedy once', async () => {
    const ctx = await boot(await documentAt(document({ expiresAt: Date.now() - HOUR })))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/run "claude" once to refresh it/)
  })

  it('serves a token whose document records no expiry', async () => {
    const ctx = await boot(await documentAt(document({ expiresAt: null })))
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-token', source: SOURCE_ID })
  })

  it('re-reads the document on every resolve', async () => {
    const filename = await documentAt(document())
    const ctx = await boot(filename)
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-token', source: SOURCE_ID })

    await writeFile(filename, document({ accessToken: 'sk-ant-oat01-rotated' }), { mode: 0o600 })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-rotated', source: SOURCE_ID })
  })

  it('refuses a document readable beyond its owner', async () => {
    const ctx = await boot(await documentAt(document(), 0o644))
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/readable beyond its owner/)
  })

  it('refuses malformed JSON and names the path', async () => {
    const filename = await documentAt('{ not json')
    const ctx = await boot(filename)
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(filename)
  })

  it('treats a document without claudeAiOauth as absent', async () => {
    const ctx = await boot(await documentAt(JSON.stringify({ mcpOAuth: {} })))
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('treats a non-string or empty access token as absent', async () => {
    for (const accessToken of [42, '']) {
      const ctx = await boot(await documentAt(document({ accessToken })))
      expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    }
  })

  it('unregisters the source when the plugin disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    const fiber = ctx.plugin(plugin, { path: await documentAt(document()) })
    await fiber
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-token', source: SOURCE_ID })

    await fiber.dispose()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })
})
