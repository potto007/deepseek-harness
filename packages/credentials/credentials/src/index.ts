/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — environment-variable names — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Disposable } from '@deepseek-ai/cordis'
import type { CredentialRef } from './types.ts'

export type { CredentialRef } from './types.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}

/** Source and writability facts for one reference, safe for configuration UIs — never the value. */
export interface CredentialInfo {
  /** Whether {@link CredentialProvider.resolve} would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
}

/**
 * One read-only credential source contributed by a plugin. Sources rank below
 * every layer the provider answers itself, so a source can never shadow the
 * writable store and `set` needs no rejection path for one.
 */
export interface CredentialSource {
  /** Source layer id reported through {@link ResolvedCredential.source}; unique per provider. */
  id: string
  /**
   * This source's answer for one reference.
   * @param ref - the reference to read.
   * @returns the value, or `undefined` when this source has none; an empty string is absent.
   */
  read(ref: CredentialRef): Promise<string | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials: CredentialProvider
  }
}

/**
 * Abstract credential service. Providers implement `resolveOwn`,
 * `describeOwn`, `set`, and `unset` over their source layers, and this class
 * composes them with the sources plugins register through
 * {@link CredentialProvider.registerSource}. One seam-wide rule binds every
 * layer: an empty stored value is absent everywhere — `resolve` skips it,
 * `describe` reports it unconfigured — so a blank never masquerades as a
 * configured secret.
 */
export abstract class CredentialProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /** Registered read-only sources, consulted after the provider's own layers, in registration order. */
  private readonly sources: CredentialSource[] = []

  /**
   * Layer ids this provider reports as its own. A registered source may not
   * reuse one: `resolve` would then label a source's value with a layer that
   * did not supply it, and nothing downstream could tell the two apart.
   */
  protected readonly ownedSourceIds: readonly string[] = []

  /**
   * Register one read-only source below every provider-owned layer. A
   * duplicate id is ignored first-wins, so a late registration can neither
   * displace the winner nor remove it through its own disposer.
   * @param source - the source to consult during fall-through.
   * @returns the Cordis effect disposer, awaitable like every other effect teardown, or a no-op disposer for a duplicate id.
   * @throws Error when the id names one of this provider's own layers.
   */
  registerSource(source: CredentialSource): Disposable<Promise<void>> {
    if (this.ownedSourceIds.includes(source.id)) {
      throw new Error(`credentials: "${source.id}" is a provider-owned layer id and cannot be registered as a source`)
    }
    if (this.sources.some(existing => existing.id === source.id)) {
      this.ctx.logger.warn('credentials: source "%s" ignored because that id is already registered', source.id)
      return () => Promise.resolve()
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
   * Resolve one reference to its current value: this provider's own layers
   * first, then registered sources in registration order. Resolution is per
   * call: consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return await this.resolveOwn(ref) ?? await this.resolveSources(ref)
  }

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value. Writability stays this provider's answer even when a registered
   * source supplies the value: sources rank below the writable store, so
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

  /**
   * Durably store one value in the provider-managed writable source. Rejects
   * while a read-only source shadows the reference — the write would appear
   * to succeed while resolution keeps returning the shadowing value — and
   * rejects an empty value (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Rejects while a read-only source shadows
   * the reference, like {@link set}.
   * @param ref - the reference to remove.
   */
  abstract unset(ref: CredentialRef): Promise<void>

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /**
   * Fan `credentials/updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran (the rethrow reaches the
   * caller only from synchronous listeners, so invariant checks on this event
   * must not be async functions). Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    let invariantFailure: unknown
    const args = ['credentials/updated', ref]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(ref)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ref, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ref, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ref: CredentialRef, error: unknown): void {
    this.ctx.logger.warn('credentials: a credentials/updated listener for "%s" failed', ref)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider
