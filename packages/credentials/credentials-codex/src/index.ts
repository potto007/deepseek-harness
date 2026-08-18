/**
 * Read-only credential source over the ChatGPT OAuth access token the Codex
 * CLI stores on this machine. The document is read on every resolution, so a
 * token the Codex CLI refreshes reaches the next harness request with no
 * cache to invalidate.
 *
 * The refresh token is never read. OpenAI's token endpoint rotates it, so a
 * harness refresh would either strand the Codex CLI with a superseded token
 * or race it for the same file; this package holds no refresh path at all. An
 * expired access token is reported absent, and one `codex` run is the remedy.
 *
 * The source serves the token only while the document's `auth_mode` is
 * `chatgpt`. A stored plain API key belongs in the ordinary credential
 * layers, so `apikey` mode is silent here rather than duplicated.
 *
 * The source registers below every layer the credentials provider answers
 * itself, so it never shadows an exported variable or a stored value.
 * @module @deepseek-ai/dsh-credentials-codex
 */

import type { Context, Disposable } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name. */
export const name = 'credentials-codex'

/** The credential service this source registers into. */
export const inject = ['credentials']

/** Source layer id this package reports through the seam. */
export const SOURCE_ID = 'codex'

/** Reference this source answers when configuration names none. */
export const DEFAULT_REF = 'CODEX_OAUTH_TOKEN'

/** Plugin config: where the Codex CLI's document is, and which reference it answers. */
export interface Config {
  /** The Codex CLI's credential document; defaults to `~/.codex/auth.json`. */
  path?: string
  /** The reference this source answers; defaults to `CODEX_OAUTH_TOKEN`. */
  ref?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  path: z.string(),
  ref: z.string().role('credential-ref'),
})

/** Fully resolved provider parameters; defaulting happens here, never inline. */
export interface ResolvedSpec {
  /** Absolute path of the Codex CLI's credential document. */
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
    filename: resolve(config.path ?? join(homedir(), '.codex', 'auth.json')),
    ref: credentialRef(config.ref ?? DEFAULT_REF),
  }
}

/** Permission bits outside the owner; a credential document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * The Codex CLI fields this package reads. `refresh_token` is deliberately
 * absent: naming it here is what would make a refresh path possible.
 */
interface CodexAuthDocument {
  auth_mode?: unknown
  tokens?: {
    access_token?: unknown
  }
}

/** Whether a caught error reports a missing file. */
function isENOENT(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/**
 * The `exp` claim of a JWT, in epoch milliseconds. The document records no
 * expiry of its own, so the claim is the only expiry there is. The payload is
 * decoded without verification — this is the client reading its own token,
 * not a verifier — and a token that does not decode yields no expiry rather
 * than an error: it is served as-is and left to the provider to reject.
 * @param token - the stored access token.
 * @returns the expiry in milliseconds, or `undefined` when the token carries none this reader can see.
 */
export function jwtExpiryMs(token: string): number | undefined {
  const [, claims] = token.split('.')
  if (claims === undefined) return undefined
  let payload: { exp?: unknown }
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { exp?: unknown }
  } catch {
    // Swallows the JSON/base64 decode failure alone: an opaque token has no
    // readable expiry, and serving it beats guessing.
    return undefined
  }
  return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
}

/**
 * Read the stored access token.
 * @param filename - absolute path of the Codex CLI's document.
 * @param reportExpiry - diagnostic sink for an expired token.
 * @returns the access token, or `undefined` when the document is absent, is not in `chatgpt` mode, holds no token, or holds an expired one.
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
      `credentials-codex: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  const text = await readFile(filename, 'utf8')
  let parsed: CodexAuthDocument
  try {
    parsed = JSON.parse(text) as CodexAuthDocument
  } catch (error) {
    throw new Error(`credentials-codex: ${filename} is not valid JSON`, { cause: error })
  }
  if (parsed.auth_mode !== 'chatgpt') return undefined
  const token = typeof parsed.tokens?.access_token === 'string' ? parsed.tokens.access_token : undefined
  if (token === undefined || token.length === 0) return undefined
  const expiresAt = jwtExpiryMs(token)
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    reportExpiry(
      `credentials-codex: the Codex CLI access token expired at ${new Date(expiresAt).toISOString()};`
      + ' run "codex" once to refresh it',
    )
    return undefined
  }
  return token
}

/**
 * Register the Codex CLI credential source.
 * @param ctx - Cordis context carrying the credentials service.
 * @param config - plugin config selecting the document and the reference.
 * @returns the registration disposer, awaitable like every other effect teardown.
 */
export function apply(ctx: Context, config: Config): Disposable<Promise<void>> {
  const spec = resolveSpec(config)
  // One expiry is reported once: resolution runs per request, and an expired
  // token stays expired until the user runs `codex`, so an unguarded warning
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
