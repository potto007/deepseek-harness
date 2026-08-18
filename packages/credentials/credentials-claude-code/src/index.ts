/**
 * Read-only credential source over the Anthropic OAuth access token Claude
 * Code stores on this machine. The document is read on every resolution, so a
 * token Claude Code refreshes reaches the next harness request with no cache
 * to invalidate.
 *
 * The refresh token is never read. Anthropic's token endpoint rotates it, so a
 * harness refresh would either strand Claude Code with a superseded token or
 * race Claude Code for the same file; this package holds no refresh path at
 * all. An expired access token is reported absent, and one `claude` run is the
 * remedy.
 *
 * The source registers below every layer the credentials provider answers
 * itself, so it never shadows an exported variable or a stored value.
 * @module @deepseek-ai/dsh-credentials-claude-code
 */

import type { Context, Disposable } from '@deepseek-ai/cordis'
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

/** Reference this source answers when configuration names none. */
export const DEFAULT_REF = 'ANTHROPIC_OAUTH_TOKEN'

/** Plugin config: where Claude Code's document is, and which reference it answers. */
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

/** Fully resolved provider parameters; defaulting happens here, never inline. */
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
    ref: credentialRef(config.ref ?? DEFAULT_REF),
  }
}

/** Permission bits outside the owner; a credential document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * The Claude Code fields this package reads. `refreshToken` is deliberately
 * absent: naming it here is what would make a refresh path possible.
 */
interface ClaudeAiOAuth {
  accessToken?: unknown
  expiresAt?: unknown
}

/** Whether a caught error reports a missing file. */
function isENOENT(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/**
 * Read the stored access token.
 * @param filename - absolute path of Claude Code's document.
 * @param reportExpiry - diagnostic sink for an expired token.
 * @returns the access token, or `undefined` when the document is absent, holds no Claude token, or holds an expired one.
 * @throws Error when the document is readable beyond its owner, or is not valid JSON.
 */
async function readAccessToken(
  filename: string,
  reportExpiry: (message: string) => void,
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
    reportExpiry(
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
 * @returns the registration disposer, awaitable like every other effect teardown.
 */
export function apply(ctx: Context, config: Config): Disposable<Promise<void>> {
  const spec = resolveSpec(config)
  // One expiry is reported once: resolution runs per request, and an expired
  // token stays expired until the user runs `claude`, so an unguarded warning
  // would repeat on every turn.
  let reported: string | undefined
  return ctx.credentials.registerSource({
    id: SOURCE_ID,
    read: async (ref) => {
      if (ref !== spec.ref) return undefined
      return await readAccessToken(spec.filename, (message) => {
        if (message === reported) return
        reported = message
        ctx.logger.warn(message)
      })
    },
  })
}
