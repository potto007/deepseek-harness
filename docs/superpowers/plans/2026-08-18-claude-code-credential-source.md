# Claude Code Credential Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let DeepSeek Harness resolve the Anthropic access token that Claude Code already stored on the machine, so a subscriber reaches Claude models without a second credential.

**Architecture:** The credential seam gains registered read-only sources that rank below every layer a provider answers itself. `CredentialProvider.resolve` and `describe` become concrete template methods over new abstract `resolveOwn` and `describeOwn`. A new plugin package registers one source that reads `~/.claude/.credentials.json` on every call.

**Tech Stack:** TypeScript (ESM, `strict`), vendored Cordis, schemastery, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-claude-code-credential-source-design.md`

## Global Constraints

- Node `^22.19 || >=24`; ESM everywhere; local relative imports end in `.ts`.
- Every package is `@deepseek-ai/dsh-<name>`; `@deepseek-ai/cordis` is a peerDependency and a devDependency.
- Registrations are effects: contributions go through `ctx.effect()`; a registry's `register` returns the disposer.
- `pnpm run test:coverage` enforces per-file 100% coverage on `packages/*/*/src`.
- No hardcoded tunables: deployment-varying values are validated schemastery `Config` fields.
- Every module and export carries JSDoc; function-like exports carry `@param` and `@returns` (`verify-export-jsdoc`).
- Files end with exactly one trailing newline.
- Trust TypeScript at typed same-process boundaries; validate at file and parser boundaries only.
- `tsconfig.base.json` needs no edit: `./packages/credentials/*/src` and `./packages/credentials/*/src/invariant.ts` already match new packages by wildcard.
- Conventional Commits, 50-character subject limit, imperative mood, no body.

---

### Task 1: Registered sources on the credential seam

**Files:**
- Modify: `packages/credentials/credentials/src/index.ts`
- Modify: `packages/credentials/credentials/tests/memory.ts`
- Test: `packages/credentials/credentials/tests/credentials.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CredentialSource` (`{ id: string; read(ref: CredentialRef): Promise<string | undefined> }`), `CredentialProvider.registerSource(source: CredentialSource): () => void`, and the protected abstract members `resolveOwn(ref: CredentialRef): Promise<ResolvedCredential | undefined>` and `describeOwn(ref: CredentialRef): Promise<CredentialInfo>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/credentials/credentials/tests/credentials.spec.ts`:

```ts
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
    ctx.credentials.registerSource({ id: 'first', read: () => { seen.push('first'); return Promise.resolve(undefined) } })
    ctx.credentials.registerSource({ id: 'second', read: () => { seen.push('second'); return Promise.resolve('sk-second') } })
    ctx.credentials.registerSource({ id: 'third', read: () => { seen.push('third'); return Promise.resolve('sk-third') } })

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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/credentials/credentials/tests/credentials.spec.ts`
Expected: FAIL — `ctx.credentials.registerSource is not a function`.

- [ ] **Step 3: Add the source type and the template methods**

In `packages/credentials/credentials/src/index.ts`, add after the `CredentialInfo` interface:

```ts
/**
 * One read-only credential source contributed by a plugin. Sources rank below
 * every layer the provider answers itself, so a source can never shadow the
 * writable store and `set` needs no rejection path for one.
 */
export interface CredentialSource {
  /** Source layer id this reports through {@link ResolvedCredential.source}; unique per provider. */
  id: string
  /**
   * This source's answer for one reference.
   * @param ref - the reference to read.
   * @returns the value, or `undefined` when this source has none; an empty string is absent.
   */
  read(ref: CredentialRef): Promise<string | undefined>
}
```

Replace the abstract `resolve` and `describe` declarations with concrete implementations, and rename the abstract members. Inside `CredentialProvider`:

```ts
  /** Registered read-only sources, consulted after the provider's own layers, in registration order. */
  private readonly sources: CredentialSource[] = []

  /**
   * Register one read-only source below every provider-owned layer. A
   * duplicate id is ignored first-wins so a late registration cannot displace
   * or remove the winner.
   * @param source - the source to consult during fall-through.
   * @returns the Cordis effect disposer, or a no-op disposer for a duplicate id.
   */
  registerSource(source: CredentialSource): () => void {
    if (this.sources.some(existing => existing.id === source.id)) {
      this.ctx.logger.warn('credentials: source "%s" ignored because that id is already registered', source.id)
      return () => {}
    }
    return this.ctx.effect(() => {
      this.sources.push(source)
      return () => {
        const index = this.sources.indexOf(source)
        if (index >= 0) this.sources.splice(index, 1)
      }
    }, 'credentials.registerSource()')
  }

  /**
   * The first registered source with a non-empty answer.
   * @param ref - the reference to resolve.
   * @returns the value and its source id, or `undefined` when no source answers.
   */
  private async resolveSources(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    for (const source of this.sources) {
      const value = await source.read(ref)
      if (value !== undefined && value.length > 0) return { value, source: source.id }
    }
    return undefined
  }

  /**
   * Resolve one reference: the provider's own layers first, then registered
   * sources in registration order. Resolution is per call, so a changed
   * credential reaches the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return await this.resolveOwn(ref) ?? await this.resolveSources(ref)
  }

  /**
   * Describe one reference without exposing the value. Writability stays the
   * provider's answer: registered sources rank below the writable store, so
   * storing a value always replaces a source's answer as the effective one.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const own = await this.describeOwn(ref)
    if (own.configured) return own
    const fromSource = await this.resolveSources(ref)
    if (fromSource === undefined) return own
    return { configured: true, source: fromSource.source, writable: own.writable }
  }

  /**
   * Resolve one reference from this provider's own source layers, ignoring
   * registered sources.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` when no owned layer holds it.
   */
  protected abstract resolveOwn(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * Describe one reference against this provider's own source layers,
   * ignoring registered sources.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  protected abstract describeOwn(ref: CredentialRef): Promise<CredentialInfo>
```

Export the new type from the module's type re-exports.

- [ ] **Step 4: Rename the memory provider's methods**

In `packages/credentials/credentials/tests/memory.ts`, change `override resolve(` to `protected override resolveOwn(` and `override describe(` to `protected override describeOwn(`. Leave the bodies unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/credentials/credentials/tests/credentials.spec.ts`
Expected: PASS, including the pre-existing seam tests.

- [ ] **Step 6: Commit**

```bash
git add packages/credentials/credentials/src/index.ts packages/credentials/credentials/tests/memory.ts packages/credentials/credentials/tests/credentials.spec.ts
git commit -m "feat(credentials): register read-only credential sources"
```

---

### Task 2: Migrate the local provider to the template methods

**Files:**
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Test: `packages/credentials/credentials-local/tests/local.spec.ts`

**Interfaces:**
- Consumes: `resolveOwn` and `describeOwn` from Task 1.
- Produces: a `LocalCredentialProvider` whose four layers fall through to registered sources.

- [ ] **Step 1: Write the failing test**

Append to `packages/credentials/credentials-local/tests/local.spec.ts`, matching that file's existing boot helper and reference constant:

```ts
it('ranks a registered source below the managed document and the .env fallbacks', async () => {
  const ctx = await boot()
  ctx.credentials.registerSource({ id: 'external', read: () => Promise.resolve('sk-external') })

  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-external', source: 'external' })
  expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'external', writable: true })

  await ctx.credentials.set(REF, 'sk-stored')
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-stored', source: 'file' })

  await ctx.credentials.unset(REF)
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-external', source: 'external' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/credentials/credentials-local/tests/local.spec.ts`
Expected: FAIL — the provider still declares `resolve`/`describe`, so TypeScript reports the abstract members unimplemented and the source is never consulted.

- [ ] **Step 3: Rename the two overrides**

In `packages/credentials/credentials-local/src/index.ts`, change `override resolve(ref: CredentialRef)` to `protected override resolveOwn(ref: CredentialRef)` and `override describe(ref: CredentialRef)` to `protected override describeOwn(ref: CredentialRef)`. Bodies and layer order stay exactly as they are.

Update the module JSDoc layer diagram to add the fifth rank:

```text
 * > registered sources                (read-only, in registration order)
```

- [ ] **Step 4: Run the package tests to verify they pass**

Run: `pnpm vitest run packages/credentials/credentials-local`
Expected: PASS across `local.spec.ts`, `drain.spec.ts`, `watcher.spec.ts`, and `review-fixes.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials/credentials-local/src/index.ts packages/credentials/credentials-local/tests/local.spec.ts
git commit -m "refactor(credentials-local): adopt resolveOwn and describeOwn"
```

---

### Task 3: Reserve the provider-owned layer ids

**Files:**
- Modify: `packages/credentials/credentials/src/index.ts`
- Modify: `packages/credentials/credentials/tests/memory.ts`
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Test: `packages/credentials/credentials/tests/credentials.spec.ts`
- Test: `packages/credentials/credentials-local/tests/local.spec.ts`

**Interfaces:**
- Consumes: `registerSource` from Task 1.
- Produces: `protected readonly ownedSourceIds: readonly string[]` on `CredentialProvider`, defaulting to `[]`, overridden by each provider.

A source that reuses a provider-owned layer id makes `resolve` report a value under a
label that names a different layer, and no test downstream can tell the two apart.
The check belongs at registration, where it is self-contained and can fail loud, rather
than in the invariant companion: the companion would have to read the provider's private
source list to see it, and this repository's rule is that invariants assert owned
relationships over authoritative data, not over internals.

- [ ] **Step 1: Write the failing tests**

Append to `packages/credentials/credentials/tests/credentials.spec.ts`:

```ts
it('refuses a source that reuses a provider-owned layer id', async () => {
  const ctx = await boot()
  expect(() => ctx.credentials.registerSource({ id: 'memory', read: () => Promise.resolve('sk-x') }))
    .toThrow(/"memory" is a provider-owned layer id/)
})
```

Append to `packages/credentials/credentials-local/tests/local.spec.ts`:

```ts
it('refuses a source that reuses one of its own layer ids', async () => {
  const ctx = await boot()
  for (const id of ['env', 'file', 'project-env', 'user-env']) {
    expect(() => ctx.credentials.registerSource({ id, read: () => Promise.resolve('sk-x') }))
      .toThrow(/provider-owned layer id/)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/credentials`
Expected: FAIL — `registerSource` currently accepts any id.

- [ ] **Step 3: Add the declaration and the guard**

In `packages/credentials/credentials/src/index.ts`, inside `CredentialProvider`:

```ts
  /**
   * Layer ids this provider reports as its own. A registered source may not
   * reuse one: `resolve` would then label a source's value with a layer that
   * did not supply it, and nothing downstream could tell the two apart.
   */
  protected readonly ownedSourceIds: readonly string[] = []
```

At the top of `registerSource`, before the duplicate check:

```ts
    if (this.ownedSourceIds.includes(source.id)) {
      throw new Error(`credentials: "${source.id}" is a provider-owned layer id and cannot be registered as a source`)
    }
```

- [ ] **Step 4: Declare each provider's own ids**

In `packages/credentials/credentials/tests/memory.ts`, inside `MemoryCredentials`:

```ts
  protected override readonly ownedSourceIds = ['memory']
```

In `packages/credentials/credentials-local/src/index.ts`, inside `LocalCredentialProvider`:

```ts
  protected override readonly ownedSourceIds = ['env', 'file', 'project-env', 'user-env']
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/credentials`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/credentials/credentials/src/index.ts packages/credentials/credentials/tests/memory.ts packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials-local/src/index.ts packages/credentials/credentials-local/tests/local.spec.ts
git commit -m "feat(credentials): reserve provider-owned layer ids"
```

---

### Task 4: Scaffold the Claude Code source package

**Files:**
- Create: `packages/credentials/credentials-claude-code/package.json`
- Create: `packages/credentials/credentials-claude-code/tsconfig.json`
- Create: `packages/credentials/credentials-claude-code/src/index.ts`

**Interfaces:**
- Consumes: `CredentialSource` and `registerSource` from Task 1.
- Produces: default-exported plugin with `Config { path?: string; ref?: string }`, `name = 'credentials-claude-code'`, `inject = ['credentials']`, and exported `resolveSpec(config: Config): { filename: string; ref: CredentialRef }`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@deepseek-ai/dsh-credentials-claude-code",
  "description": "Read-only credential source over the Anthropic OAuth access token Claude Code stores on this machine",
  "version": "0.1.0-rc.7",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/credentials/credentials-claude-code"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^"
  },
  "dependencies": { "@deepseek-ai/schemastery": "workspace:^" },
  "devDependencies": {
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cosmokit" },
    { "path": "../../../vendor/cordis" },
    { "path": "../../../vendor/schemastery" },
    { "path": "../credentials" }
  ]
}
```

- [ ] **Step 3: Install and verify the workspace picks the package up**

Run: `pnpm install`
Expected: the new workspace member resolves; `pnpm run typecheck` reports no error for the empty `src`.

- [ ] **Step 4: Commit**

```bash
git add packages/credentials/credentials-claude-code
git commit -m "chore(credentials-claude-code): scaffold the package"
```

---

### Task 5: Read the Claude Code token

**Files:**
- Modify: `packages/credentials/credentials-claude-code/src/index.ts`
- Test: `packages/credentials/credentials-claude-code/tests/claude-code.spec.ts`

**Interfaces:**
- Consumes: `resolveSpec` and the plugin from Task 4.
- Produces: source id `claude-code`, answering the configured `ref` from `claudeAiOauth.accessToken`.

- [ ] **Step 1: Write the failing tests**

Create `packages/credentials/credentials-claude-code/tests/claude-code.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import ClaudeCodeCredentials from '../src/index.ts'

const REF = credentialRef('ANTHROPIC_OAUTH_TOKEN')
const HOUR = 3_600_000

async function documentAt(content: string, mode = 0o600): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-code-'))
  const filename = join(dir, '.credentials.json')
  await writeFile(filename, content, { mode })
  await chmod(filename, mode)
  return filename
}

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, {})
  await ctx.plugin(ClaudeCodeCredentials, { path })
  return ctx
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

describe('the Claude Code credential source', () => {
  it('serves the stored access token for the configured reference', async () => {
    const ctx = await boot(await documentAt(document()))
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-token', source: 'claude-code' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'claude-code', writable: true })
  })

  it('answers no other reference', async () => {
    const ctx = await boot(await documentAt(document()))
    expect(await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))).toBeUndefined()
  })

  it('stays silent when the document is absent', async () => {
    const ctx = await boot(join(tmpdir(), 'dsh-claude-code-absent', '.credentials.json'))
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('reports an expired token as absent', async () => {
    const ctx = await boot(await documentAt(document({ expiresAt: Date.now() - HOUR })))
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('re-reads the document on every resolve', async () => {
    const filename = await documentAt(document())
    const ctx = await boot(filename)
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-token', source: 'claude-code' })
    await writeFile(filename, document({ accessToken: 'sk-ant-oat01-rotated' }), { mode: 0o600 })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-ant-oat01-rotated', source: 'claude-code' })
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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/credentials/credentials-claude-code`
Expected: FAIL — the plugin module has no default export yet.

- [ ] **Step 3: Implement the source**

Write `packages/credentials/credentials-claude-code/src/index.ts`:

```ts
/**
 * Read-only credential source over the Anthropic OAuth access token Claude
 * Code stores on this machine. The source reads the document on every
 * resolution, so a token Claude Code refreshes reaches the next harness
 * request with no cache to invalidate.
 *
 * The refresh token is never read. Anthropic's token endpoint rotates it, so a
 * harness refresh would either strand Claude Code with a stale token or race
 * Claude Code for the same file; this package holds no refresh path at all.
 * An expired access token is reported absent, and the remedy is one `claude`
 * run.
 * @module @deepseek-ai/dsh-credentials-claude-code
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name. */
export const name = 'credentials-claude-code'

/** The credential service this source registers into. */
export const inject = ['credentials']

/** Source layer id this package reports through the seam. */
export const SOURCE_ID = 'claude-code'

/** Plugin config: where Claude Code's document is and which reference it answers. */
export interface Config {
  /** Claude Code's credential document; defaults to `~/.claude/.credentials.json`. */
  path?: string
  /** The reference this source answers; defaults to `ANTHROPIC_OAUTH_TOKEN`. */
  ref?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  path: z.string(),
  ref: z.string().role('credential-ref'),
})

/** Fully resolved parameters; defaulting happens here, never inline. */
export interface ResolvedSpec {
  /** Absolute path of Claude Code's credential document. */
  filename: string
  /** Validated reference this source answers. */
  ref: CredentialRef
}

/**
 * Resolve the runtime spec from plugin config.
 * @param config - raw plugin config.
 * @returns the absolute document path and the validated reference.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    filename: resolve(config.path ?? join(homedir(), '.claude', '.credentials.json')),
    ref: credentialRef(config.ref ?? 'ANTHROPIC_OAUTH_TOKEN'),
  }
}

/** Permission bits outside the owner; a credential document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/** The one field this package reads out of Claude Code's document. */
interface ClaudeAiOAuth {
  accessToken?: unknown
  expiresAt?: unknown
}

/** True when the error is a missing-file error. */
function isENOENT(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/**
 * Read the stored access token, or `undefined` when the document is absent,
 * holds no Claude token, or holds an expired one.
 * @param filename - absolute path of Claude Code's document.
 * @param warn - diagnostic sink for an expired token.
 * @returns the access token, or `undefined`.
 * @throws when the document is readable beyond its owner or is not valid JSON.
 */
async function readAccessToken(
  filename: string,
  warn: (message: string) => void,
): Promise<string | undefined> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native Windows coverage does. */
  if (process.platform !== 'win32' && (mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(
      `credentials-claude-code: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  const text = await readFile(filename, 'utf8')
  let parsed: { claudeAiOauth?: ClaudeAiOAuth }
  try {
    parsed = JSON.parse(text) as { claudeAiOauth?: ClaudeAiOAuth }
  } catch (error) {
    throw new Error(`credentials-claude-code: ${filename} is not valid JSON`, { cause: error })
  }
  const stored = parsed.claudeAiOauth
  if (stored === undefined) return undefined
  const token = typeof stored.accessToken === 'string' ? stored.accessToken : undefined
  if (token === undefined || token.length === 0) return undefined
  const expiresAt = typeof stored.expiresAt === 'number' ? stored.expiresAt : undefined
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    warn(
      `credentials-claude-code: the Claude Code access token expired at ${new Date(expiresAt).toISOString()};`
      + ' run "claude" once to refresh it',
    )
    return undefined
  }
  return token
}

/**
 * Register the Claude Code credential source.
 * @param ctx - Cordis context carrying the credentials service.
 * @param config - plugin config selecting the document and the reference.
 * @returns the registration disposer.
 */
export function apply(ctx: Context, config: Config): () => void {
  const spec = resolveSpec(config)
  let reportedExpiry: string | undefined
  return ctx.credentials.registerSource({
    id: SOURCE_ID,
    read: async (ref) => {
      if (ref !== spec.ref) return undefined
      return await readAccessToken(spec.filename, (message) => {
        if (message === reportedExpiry) return
        reportedExpiry = message
        ctx.logger.warn(message)
      })
    },
  })
}

export default apply
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/credentials/credentials-claude-code`
Expected: PASS, all eight cases.

- [ ] **Step 5: Confirm per-file coverage**

Run: `pnpm run test:coverage -- packages/credentials`
Expected: 100% for `packages/credentials/credentials-claude-code/src/index.ts`. Add a case for any uncovered line rather than an ignore comment.

- [ ] **Step 6: Commit**

```bash
git add packages/credentials/credentials-claude-code/src/index.ts packages/credentials/credentials-claude-code/tests/claude-code.spec.ts
git commit -m "feat(credentials-claude-code): serve Claude Code's token"
```

---

### Task 6: Real-API end-to-end check

**Files:**
- Create: `packages/credentials/credentials-claude-code/tests/anthropic.e2e.ts`

**Interfaces:**
- Consumes: the plugin from Task 5.
- Produces: no exported surface; a self-skipping regression.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import ClaudeCodeCredentials from '../src/index.ts'

const DOCUMENT = join(homedir(), '.claude', '.credentials.json')
const REF = credentialRef('ANTHROPIC_OAUTH_TOKEN')

describe.skipIf(!existsSync(DOCUMENT))('the Claude Code token against the live Anthropic API', () => {
  it('resolves a token the Messages API accepts', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    await ctx.plugin(ClaudeCodeCredentials, {})
    const resolved = await ctx.credentials.resolve(REF)
    if (resolved === undefined) return // expired; `claude` refreshes it

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
```

- [ ] **Step 2: Run it**

Run: `pnpm run test:e2e -- packages/credentials/credentials-claude-code`
Expected: PASS where the document exists, SKIP where it does not.

- [ ] **Step 3: Commit**

```bash
git add packages/credentials/credentials-claude-code/tests/anthropic.e2e.ts
git commit -m "test(credentials-claude-code): add live Anthropic check"
```

---

### Task 7: Composition, documentation, and gates

**Files:**
- Modify: `packages/bundle/base/cordis.patch.yml`
- Create: `packages/credentials/credentials-claude-code/README.md`
- Create: `.agents/notes/proposed/2026-08-18-claude-code-credential-source.md`
- Modify: `docs/capability-seams.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code surface.

- [ ] **Step 1: Mount the plugin beside the local provider**

In `packages/bundle/base/cordis.patch.yml`, after the `credentials` entry:

```yaml
    # The Anthropic OAuth access token Claude Code stored on this machine,
    # offered read-only below every layer credentials-local answers itself.
    # Silent where Claude Code is not installed.
    - id: credentials-claude-code
      name: '@deepseek-ai/dsh-credentials-claude-code'
```

- [ ] **Step 2: Write the package README**

Cover: what the source serves, the precedence rank, the `path` and `ref` config fields, the three failure behaviours, the read-only stance and why, and the `llm-pi-ai` settings route that consumes it:

```yaml
llm-pi-ai:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_OAUTH_TOKEN
```

- [ ] **Step 3: Record the seam change in the capability-seam documentation**

Add registered sources and the five-rank precedence table from the spec to the credentials section of `docs/capability-seams.md`.

- [ ] **Step 4: Write the Agent Note**

Record the decision, the two rejected alternatives, the read-only choice and the refresh-token rotation reasoning, and the macOS gap.

- [ ] **Step 5: Run the gates**

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run hygiene
pnpm run doc-sync
```

Expected: `doc-sync` FAILS on bilingual pairing for the new `README.md`, the Agent Note, and the changed `docs/capability-seams.md`. This is correct and expected: those counterparts require `dsh-translate-docs`, which only the user may invoke. Stop here and report.

- [ ] **Step 6: Commit the English side**

```bash
git add packages/bundle/base/cordis.patch.yml packages/credentials/credentials-claude-code/README.md docs/capability-seams.md .agents/notes/proposed/2026-08-18-claude-code-credential-source.md
git commit -m "docs(credentials-claude-code): document the source"
```
