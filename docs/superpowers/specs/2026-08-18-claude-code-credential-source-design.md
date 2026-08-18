# Claude Code credential source

Status: approved design, not implemented.
Date: 2026-08-18.

## Problem

A user with a Claude subscription logs in through Claude Code. Claude Code stores the resulting OAuth tokens on the machine. DeepSeek Harness cannot read them, so the same user must obtain a separate Anthropic API key before the harness can call a Claude model.

This design lets the harness read the access token that Claude Code already stored. It does not add a login flow.

## What already works

Three facts decide the size of this change. Each one is verified against the pinned dependency and the current tree.

The pinned `@earendil-works/pi-ai` version (`^0.82.1`) contains the complete Claude Code OAuth flow at `dist/auth/oauth/anthropic.js`. The built-in `anthropic` provider declares it through `auth.oauth = lazyOAuth({ load: loadAnthropicOAuth })`.

The same package's `anthropic-messages` implementation detects an access token that contains `sk-ant-oat`. For such a token it sends `Authorization: Bearer` instead of `x-api-key`, and it adds the `claude-code-20250219` and `oauth-2025-04-20` beta headers.

Claude Code on Linux stores the tokens at `~/.claude/.credentials.json` with mode `0600`. The `claudeAiOauth` object holds `accessToken`, `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`, and `rateLimitTier`. The access token starts with `sk-ant-oat01`, and the scope list includes `user:inference`.

Therefore the model-request path needs no new code. A route that resolves this access token as its api key reaches Claude with the correct headers. The one missing piece is a way to move the token from Claude Code's file into `ctx.credentials`.

## Obstacle

`LocalCredentialProvider.resolve` consults three layers in a fixed order: the inherited process environment, the managed `$DSH_HOME/.credentials.yaml` document, then a `.env` fallback. The chain is closed. The layers come from `launchEnvironmentOf(ctx)` under the fixed source ids `process`, `project-env`, and `user-env`.

`ctx.credentials` also holds exactly one provider. A second `CredentialProvider` cannot mount beside the local one.

## Decision

Open the credential seam to registered read-only sources. Add the Claude Code reader as one such source in its own package.

Two alternatives were considered and rejected. Adding an opt-in branch inside `credentials-local` produces the smallest change, but it writes another product's file format into the package whose stated purpose is its own credential document. Subclassing `LocalCredentialProvider` from a second package avoids the seam change, but this repository uses cross-package inheritance nowhere, and it leaves two providers to keep in step.

The chosen approach is the only one of the three that serves the next credential source as well as this one.

## Seam change

`CredentialProvider` gains one registration method. It follows the `skills.register()` idiom: it returns the Cordis effect disposer, it orders sources by insertion, and a duplicate id is first-wins.

```ts
/** One read-only credential source contributed by a plugin. */
export interface CredentialSource {
  /** Source layer id reported by resolve() and describe(); unique per provider. */
  id: string
  /** This source's answer for one reference, or undefined when it has none. */
  read(ref: CredentialRef): Promise<string | undefined>
}

registerSource(source: CredentialSource): () => void
```

Registered sources rank last. Every layer a provider answers itself outranks them.

This precedence is the decision that keeps the change small. A registered source can never shadow the writable store, so `set` and `unset` need no new rejection path and their contracts do not change. It is also the correct order on its own terms: an explicit `ANTHROPIC_OAUTH_TOKEN=… dsh` and a value written through the Models page are this run's stated intent, while a discovered external file is a fallback.

The base class owns composition. `resolve` and `describe` become concrete methods on `CredentialProvider`. Each one consults the provider's own layers first, then falls through to registered sources in registration order. The abstract methods that a provider implements are renamed `resolveOwn` and `describeOwn`. A provider therefore cannot omit registered-source support by accident.

The seam-wide empty-value rule extends unchanged. A registered source that returns an empty string is absent: `resolve` skips it and `describe` reports the reference unconfigured.

`credentials-local` is the only implementation in the tree, so the rename touches one package.

### Resulting precedence

| Rank | Layer | Source id | `set` succeeds |
| --- | --- | --- | --- |
| 1 | inherited process environment | `env` | no |
| 2 | `$DSH_HOME/.credentials.yaml` | `file` | yes |
| 3 | invocation `cwd` `.env` | `project-env` | yes |
| 4 | `$DSH_HOME/.env` | `user-env` | yes |
| 5 | registered sources, in registration order | source-defined | yes |

The last column is `CredentialInfo.writable`, which records whether `set` would currently succeed rather than whether the layer itself is editable. Only the inherited environment answers no, because it is the one layer that outranks the managed document. A registered source reports `configured: true`, its own `id` as the source, and `writable: true`: the writable store outranks it, so storing a value does replace it as the effective one.

## Source plugin

New package `packages/credentials/credentials-claude-code`, published as `@deepseek-ai/dsh-credentials-claude-code`. It registers one `CredentialSource` with id `claude-code`.

### Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `path` | `~/.claude/.credentials.json` | Claude Code's credential document |
| `ref` | `ANTHROPIC_OAUTH_TOKEN` | the reference this source answers |

Both are validated schemastery fields. Neither is a `DEFAULT_*` constant reachable only from code.

### Read behaviour

`read(ref)` returns `undefined` immediately unless `ref` equals the configured reference.

It then reads the configured file on every call. There is no cache and no watcher. The seam contracts resolution as per-operation, and the document is about 4 KB. This is also what makes Claude Code's own token refresh reach the next harness request with no invalidation logic.

The value served is `claudeAiOauth.accessToken`.

The source never reads `refreshToken`. The read-only decision is enforced by the code not naming that field, so the refresh token is never parsed, never held in memory, and never written.

### Failure behaviour

An absent file returns `undefined` without a diagnostic. A machine without Claude Code is a normal state, and the remaining credential layers answer as they do today.

An expired token returns `undefined`. The source logs once per observed expiry: the time the token expired, and the instruction to run `claude` once to refresh it. No clock-skew margin is applied. With no refresh path in the harness, an early cutoff would shorten a usable token without changing the remedy.

A file with group or other permission bits set fails loud, with the diagnostic style `credentials-local` already uses for its own document. The harness does not serve a secret out of a world-readable file because another product wrote it.

Malformed JSON fails loud and names the path.

## Wiring

The plugin mounts beside `credentials-local`, not in place of it.

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

- id: credentials-claude-code
  name: '@deepseek-ai/dsh-credentials-claude-code'
```

The Anthropic model route needs no composition change. `packages/bundle/base` already mounts `llm-pi-ai` dormant, and its routes arrive from an `llm-pi-ai:` settings section. A route keyed `anthropic`, with `apiKeyEnv: ANTHROPIC_OAUTH_TOKEN` and no `api` override, reuses pi-ai's catalog Anthropic provider. `routeAuth` in `packages/llm/llm-pi-ai/src/provider.ts` returns the catalog auth unchanged because that provider declares an api-key method, and pi-ai's `resolveProviderAuth` honours the harness-supplied api key as a request override.

## Testing

Unit tests in both packages meet the per-file 100% `test:coverage` gate. They cover registration and disposal, duplicate-id first-wins, precedence against each existing layer, empty-value absence, token expiry, an absent file, a world-readable file, and malformed JSON.

`registerSource` refuses an id that the provider declares as one of its own layers, through a `ownedSourceIds` list each provider overrides. The check sits at registration because it is self-contained and can fail loud there. It does not sit in the invariant companion, which would have to read the provider's private source list to see it; invariants in this repository assert owned relationships over authoritative data rather than over internals. Precedence itself stays pinned by the unit tests above.

The `credentials-local` tests move to the `resolveOwn` and `describeOwn` names.

A real-API end-to-end test resolves the live token and makes one Anthropic request. It skips itself wherever the credential file is absent, so CI stays green.

No snapshot test is expected. This change alters credential resolution, not any assembled transcript. If implementation shows that a configuration surface renders source labels, that surface gains a snapshot in the same change.

## Documentation

The new package carries a bilingual README. The `credentials` seam documentation gains the registered-source layer and the precedence table above. An Agent Note accompanies the change, because it is not a mechanical edit.

`docs/superpowers/` is added to the `excluded` list in `scripts/translation-pairing.manifest.json`. Design specs are working material rather than product documentation, which is the same reason `docs/i18n/` and `docs/AGENTS.md` sit in that list.

## Out of scope

The macOS Keychain. Claude Code's storage on macOS was not verified during this design, and the file reader is not designed against a guess. Covering it is a second source and a separate change.

Any refresh or write-back. Anthropic's token endpoint rotates the refresh token. A harness refresh that did not write back would leave Claude Code holding a stale token, and one that did write back would race Claude Code for the same file. A lost update there invalidates the refresh token and logs the user out of both products.

An OAuth login flow inside the harness. The pinned pi-ai version already carries one; adopting it is a separate change with its own token store.

## Consequences

A user who is logged in to Claude Code reaches Claude models from the harness with one settings route and no second credential.

Third-party harness usage on a Claude subscription draws from extra usage and is billed per token. It does not draw from the plan's included limits.

The harness depends on a file that another product owns and may relocate. The failure is contained: an absent or changed file makes the source silent, and every other credential layer keeps working.
