import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import { apply, Config, inject, jwtExpiryMs, name, resolveSpec, SOURCE_ID } from '../src/index.ts'

const REF = credentialRef('CODEX_OAUTH_TOKEN')
const HOUR = 3_600_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** The Codex CLI writes its document owner-only; the tests seed it the same way. */
async function documentAt(content: string, mode = 0o600): Promise<string> {
  const filename = join(await tempDir(), 'auth.json')
  await writeFile(filename, content, { mode })
  await chmod(filename, mode)
  return filename
}

/** An unsigned JWT whose payload carries the given claims — decode-compatible, never verifiable. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}

function freshToken(): string {
  return jwt({ exp: Math.floor((Date.now() + HOUR) / 1000) })
}

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: freshToken(),
      refresh_token: 'rt.1.secret',
      account_id: 'account-1',
    },
    ...overrides,
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
  it('defaults the document to the Codex home path and the reference to the Codex token', () => {
    const spec = resolveSpec({})
    expect(spec.filename.endsWith(join('.codex', 'auth.json'))).toBe(true)
    expect(spec.ref).toBe('CODEX_OAUTH_TOKEN')
  })

  it('takes an explicit path and reference', () => {
    expect(resolveSpec({ path: '/tmp/x.json', ref: 'CHATGPT_TOKEN' }))
      .toEqual({ filename: '/tmp/x.json', ref: 'CHATGPT_TOKEN' })
  })

  it('refuses a reference that is not a POSIX shell identifier', () => {
    expect(() => resolveSpec({ ref: 'not a ref' })).toThrow(TypeError)
  })
})

describe('jwtExpiryMs', () => {
  it('reads the exp claim in milliseconds', () => {
    expect(jwtExpiryMs(jwt({ exp: 1_000 }))).toBe(1_000_000)
  })

  it('reads no expiry from a token without segments, without decodable JSON, or without a numeric exp', () => {
    expect(jwtExpiryMs('opaque-token')).toBeUndefined()
    expect(jwtExpiryMs('a.%%%not-base64-json%%%.c')).toBeUndefined()
    expect(jwtExpiryMs(jwt({ exp: 'soon' }))).toBeUndefined()
    expect(jwtExpiryMs(jwt({}))).toBeUndefined()
  })
})

describe('the Codex credential source', () => {
  it('serves the stored access token for the configured reference', async () => {
    const token = freshToken()
    const ctx = await boot(await documentAt(document({ tokens: { access_token: token } })))
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: token, source: SOURCE_ID })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: SOURCE_ID, writable: true })
  })

  it('answers no other reference', async () => {
    const ctx = await boot(await documentAt(document()))
    expect(await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))).toBeUndefined()
  })

  it('answers a reference the configuration renames', async () => {
    const ctx = await boot(await documentAt(document()), 'CHATGPT_TOKEN')
    expect(await ctx.credentials.resolve(credentialRef('CHATGPT_TOKEN'))).toBeDefined()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('stays silent when the document is absent', async () => {
    const ctx = await boot(join(await tempDir(), 'absent', 'auth.json'))
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('stays silent outside chatgpt auth mode', async () => {
    for (const auth_mode of ['apikey', undefined]) {
      const ctx = await boot(await documentAt(document({ auth_mode })))
      expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    }
  })

  it('reports an expired token as absent and names the remedy once', async () => {
    const expired = jwt({ exp: Math.floor((Date.now() - HOUR) / 1000) })
    const ctx = await boot(await documentAt(document({ tokens: { access_token: expired } })))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/run "codex" once to refresh it/)
  })

  it('serves a token whose payload this reader cannot date', async () => {
    const opaque = 'opaque-token'
    const ctx = await boot(await documentAt(document({ tokens: { access_token: opaque } })))
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: opaque, source: SOURCE_ID })
  })

  it('re-reads the document on every resolve', async () => {
    const filename = await documentAt(document())
    const ctx = await boot(filename)
    const first = await ctx.credentials.resolve(REF)
    expect(first?.source).toBe(SOURCE_ID)

    const rotated = freshToken() + 'x'
    await writeFile(filename, document({ tokens: { access_token: rotated } }), { mode: 0o600 })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: rotated, source: SOURCE_ID })
  })

  it('propagates a stat failure that is not a missing file', async () => {
    // A regular file standing where a directory must be: stat reports ENOTDIR,
    // which is a real fault rather than "the Codex CLI is not installed".
    const notADirectory = await documentAt(document())
    const ctx = await boot(join(notADirectory, 'auth.json'))
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/ENOTDIR/)
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

  it('treats a missing tokens object or a non-string or empty token as absent', async () => {
    for (const tokens of [undefined, {}, { access_token: 42 }, { access_token: '' }]) {
      const ctx = await boot(await documentAt(document({ tokens })))
      expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    }
  })

  it('unregisters the source when the plugin disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    const fiber = ctx.plugin(plugin, { path: await documentAt(document()) })
    await fiber
    expect(await ctx.credentials.resolve(REF)).toBeDefined()

    await fiber.dispose()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })
})
