# Agent Note: Registered credential sources, and reading Claude Code's token read-only

Status: proposed

English | [中文](2026-08-18-claude-code-credential-source.zh.md)

## Problem

A user with a Claude subscription logs in through Claude Code, which stores the resulting OAuth tokens on the machine. The Harness could not read them, so the same user had to obtain a separate Anthropic API key before reaching a Claude model.

Two facts made the change much smaller than it first appeared. The pinned `@earendil-works/pi-ai` (`^0.82.1`) already carries the whole Claude Code OAuth flow, and its `anthropic-messages` implementation already recognizes an `sk-ant-oat` token by prefix and switches that request to `Authorization: Bearer` with the `claude-code-20250219` and `oauth-2025-04-20` beta headers. Nothing on the model-request path needed writing. The gap was the one `packages/llm/llm-pi-ai/src/provider.ts` already named: the adapter resolves credentials through its own seam and held no store for a token that arrives any other way.

The obstacle was that `LocalCredentialProvider.resolve` was a closed layer chain and `ctx.credentials` holds exactly one provider, so a second source had nowhere to attach.

## Decision

Two parts.

**The seam takes registered read-only sources.** `CredentialProvider.registerSource` accepts `{ id, read }` and returns the Cordis effect disposer. `resolve` and `describe` became concrete template methods over new protected abstract `resolveOwn` and `describeOwn`, so composition lives in the base class and no provider can omit source support by accident.

Sources rank **last**, below every layer a provider answers itself. That single ordering choice is what keeps the change small: a source can never shadow the writable store, so `set` and `unset` keep their contracts and need no new rejection path. It is also correct on its own terms — an explicit `ANTHROPIC_OAUTH_TOKEN=… dsh` or a value written through the Models page is this run's stated intent, while a discovered external file is a fallback.

A duplicate id is ignored first-wins with a warning. An id in the provider's own `ownedSourceIds` is refused outright, because `resolve` would otherwise label a source's value with a layer that did not supply it.

**`dsh-credentials-claude-code` reads the token, and only reads it.** One source, id `claude-code`, answering one configurable reference from `claudeAiOauth.accessToken` in `~/.claude/.credentials.json`. It re-reads on every resolution: no cache, no watcher, and therefore nothing to invalidate when Claude Code refreshes.

## Why read-only

Anthropic's token endpoint rotates the refresh token on every refresh. A Harness refresh that did not write back would leave Claude Code holding a superseded token. One that did write back would race Claude Code, which owns the document and rewrites it on its own schedule; a lost update there invalidates the refresh token and signs the user out of both products.

Reading only removes that entire class of failure. The cost is one `claude` run when the access token expires, which the source's diagnostic names. `refreshToken` is not read, and the field is not mentioned anywhere in the package's source — the absence is the enforcement.

## Alternatives considered

- **An opt-in branch inside `credentials-local`** — the smallest diff, rejected because it writes another product's file format into the package whose stated purpose is its own document format, and because it serves this one case only.
- **A second provider subclassing `LocalCredentialProvider`** — avoids the seam change, rejected because this repository uses cross-package inheritance nowhere and it leaves two providers to keep in step.
- **A runtime invariant asserting the precedence** — rejected. The companion would have to read the provider's private source list to see it, and invariants here assert owned relationships over authoritative data. The registration-time `ownedSourceIds` refusal is self-contained and fails loud; precedence itself is pinned by unit tests.
- **Adopting pi-ai's own OAuth login flow** — deferred. It is a separate change with its own token store, and it does not serve the user who is already logged in to Claude Code.

## Consequences

A logged-in Claude Code user reaches Claude models with one `llm-pi-ai` settings route naming `apiKeyEnv: ANTHROPIC_OAUTH_TOKEN`, and no second credential.

Third-party harness usage on a Claude subscription draws from extra usage and is billed per token. It does not draw from the plan's included limits.

macOS is not covered. Claude Code's storage there was not established when this was written, and the source is a file reader rather than a guess; a Keychain-backed source belongs beside it as a sibling package.

The Harness now depends on a document another product owns and may relocate. The failure is contained: an absent or restructured document makes the source silent, and every other credential layer keeps working.
