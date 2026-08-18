# Agent Note: The Codex CLI credential source

Status: proposed

English | [中文](2026-08-18-codex-credential-source.zh.md)

## Problem

The registered-source seam and the Claude Code source ([note](2026-08-18-claude-code-credential-source.md)) left one sibling obviously missing: a user logged in to OpenAI's Codex CLI holds a ChatGPT OAuth token at `~/.codex/auth.json` that the Harness could not read.

As with the Anthropic case, the model-request path needed nothing. The pinned pi-ai's `openai-codex` implementation takes the per-request api key, extracts the `chatgpt_account_id` claim from the JWT itself, and sends `Authorization: Bearer` with the `chatgpt-account-id` header. The harness's route construction already adds its own api-key method to an OAuth-only catalog provider when a profile names a credential — `openai-codex` is the provider that path was written for.

## Decision

`dsh-credentials-codex`: one registered source, id `codex`, answering `CODEX_OAUTH_TOKEN` from `tokens.access_token`, on the same terms as the Claude Code sibling — read per resolution, no cache, no watcher, never reading `refresh_token`, absent-file silent, world-readable and malformed-JSON loud.

Three decisions are this package's own rather than inherited:

**Expiry comes from the JWT `exp` claim.** The document records no expiry field, so the source decodes the token payload — without verification, as the client reading its own token — and treats a past `exp` as absent with the one-`codex`-run remedy. A payload that does not decode yields no expiry and the token is served as-is: refusing an opaque token would be a guess, and the provider's rejection is authoritative.

**Only `auth_mode: "chatgpt"` is served.** The document can instead hold a plain `OPENAI_API_KEY` (`apikey` mode). Serving that would duplicate the ordinary credential layers and give one key two competing sources, so the source is silent outside `chatgpt` mode.

**The live e2e stops at resolution.** `chatgpt.com/backend-api` is not a public API; a canned request there would pin another product's private wire format rather than this package's behavior. The test resolves the machine's real document and asserts the token decodes with the account claim the provider extracts.

## Standing difference from the Anthropic sibling

Anthropic sanctions subscription OAuth in third-party harnesses and meters it as per-token extra usage. OpenAI documents no equivalent: the backend is not a public API, usage draws on the subscription's own limits, and third-party use is unsanctioned rather than sanctioned-and-billed. The package README states this under "Terms of use"; the harness's role stops at reading a local file.

## Consequences

A logged-in Codex CLI user reaches the `openai-codex` catalog models with one `llm-pi-ai` settings route naming `apiKeyEnv: CODEX_OAUTH_TOKEN`.

The pattern is now demonstrably a template: seam unchanged, package shape identical, per-product logic confined to one `readAccessToken` and its tests. A third CLI's token store should follow this file's outline.
