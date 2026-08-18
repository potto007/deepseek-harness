import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '../src/index.ts'
import type { CredentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('the credentials seam through the memory provider', () => {
  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-seeded', source: 'memory' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'memory', writable: true })
  })

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
  })

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await ctx.credentials.set(REF, 'sk-live')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-live', source: 'memory' })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(events).toEqual([REF, REF])
  })

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await ctx.credentials.unset(REF)
    expect(events).toEqual([])
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})

describe('registered credential sources', () => {
  it('answers only when no provider-owned layer does', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-stored' })
    ctx.credentials.registerSource({ id: 'external', read: () => Promise.resolve('sk-external') })

    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-stored', source: 'memory' })

    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-external', source: 'external' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'external', writable: true })
  })

  it('treats an empty source answer as absent', async () => {
    const ctx = await boot()
    ctx.credentials.registerSource({ id: 'external', read: () => Promise.resolve('') })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
  })

  it('consults sources in registration order and stops at the first answer', async () => {
    const ctx = await boot()
    const seen: string[] = []
    ctx.credentials.registerSource({
      id: 'first',
      read: () => { seen.push('first'); return Promise.resolve(undefined) },
    })
    ctx.credentials.registerSource({
      id: 'second',
      read: () => { seen.push('second'); return Promise.resolve('sk-second') },
    })
    ctx.credentials.registerSource({
      id: 'third',
      read: () => { seen.push('third'); return Promise.resolve('sk-third') },
    })

    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-second', source: 'second' })
    expect(seen).toEqual(['first', 'second'])
  })

  it('ignores a duplicate id and hands back a no-op disposer', async () => {
    const ctx = await boot()
    ctx.credentials.registerSource({ id: 'external', read: () => Promise.resolve('sk-winner') })
    const undo = ctx.credentials.registerSource({ id: 'external', read: () => Promise.resolve('sk-loser') })
    undo()
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-winner', source: 'external' })
  })

  it('removes a source when its registration disposes', async () => {
    const ctx = await boot()
    const undo = ctx.credentials.registerSource({ id: 'external', read: () => Promise.resolve('sk-external') })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-external', source: 'external' })
    undo()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('refuses a source that reuses a provider-owned layer id', async () => {
    const ctx = await boot()
    expect(() => ctx.credentials.registerSource({ id: 'memory', read: () => Promise.resolve('sk-x') }))
      .toThrow(/"memory" is a provider-owned layer id/)
  })
})
