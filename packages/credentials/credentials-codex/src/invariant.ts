/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials-codex`.
 * @module @deepseek-ai/dsh-credentials-codex/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials-codex'

/** Cordis companion plugin name. */
export const name = 'credentials-codex-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers one read-only source and
 * mutates nothing. It emits no cordis event, and the file it reads belongs to
 * another product, so no relation here is the harness's to hold. Precedence
 * against the provider's own layers is the seam's relation and is pinned in
 * `@deepseek-ai/dsh-credentials`; token selection, expiry, and the refusal
 * paths are asserted directly by this package's behavior specs.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
