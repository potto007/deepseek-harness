# dsh-credentials-claude-code

English | [中文](README.zh.md)

Read-only [credentials](../credentials/README.md) source over the Anthropic OAuth access token Claude Code already stored on this machine. A user who is logged in to Claude Code reaches Claude models from the Harness without obtaining a second credential.

The package registers one source with the seam. It owns no service, writes nothing, and refreshes nothing.

| Fact | Value |
|---|---|
| Source id | `claude-code` |
| Reference answered | `ANTHROPIC_OAUTH_TOKEN` (configurable) |
| Document read | `~/.claude/.credentials.json` (configurable) |
| Precedence | below every layer the credentials provider answers itself |
| Writability | `set` still succeeds and outranks this source |

## Config

| Field | Default | Meaning |
|---|---|---|
| `path` | `~/.claude/.credentials.json` | Claude Code's credential document. |
| `ref` | `ANTHROPIC_OAUTH_TOKEN` | The one reference this source answers. |

## Precedence

Registered sources rank last, so this source answers only when nothing above it does:

```text
inherited process environment      (env)
> $DSH_HOME/.credentials.yaml      (file)
> <invocation cwd>/.env            (project-env)
> $DSH_HOME/.env                   (user-env)
> this source                      (claude-code)
```

`ANTHROPIC_OAUTH_TOKEN=… dsh` therefore still wins, and a key written through the Models page still wins. Because the writable store outranks it, `describe()` reports `writable: true` while this source supplies the value: storing a key replaces it as the effective source.

## Reaching a Claude model

The source only supplies the token. One `llm-pi-ai` settings route consumes it:

```yaml
llm-pi-ai:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_OAUTH_TOKEN
```

Naming no `api` keeps the route on pi-ai's catalog Anthropic provider. pi-ai's `anthropic-messages` implementation recognizes an `sk-ant-oat` token by prefix and switches that request to `Authorization: Bearer` with the `claude-code-20250219` and `oauth-2025-04-20` beta headers, so no adapter configuration expresses the OAuth path.

## Read behaviour

The document is read on every resolution. There is no cache and no watcher: the seam contracts resolution as per-operation, the document is small, and reading each time is what makes a token Claude Code refreshes reach the next Harness request with nothing to invalidate.

The value served is `claudeAiOauth.accessToken`.

## What this package will not do

It never reads `refreshToken`, and the field is not named anywhere in its source.

Anthropic's token endpoint rotates the refresh token on every refresh. A Harness that refreshed and did not write back would leave Claude Code holding a superseded token; one that wrote back would race Claude Code, which owns the document and rewrites it on its own schedule. A lost update there invalidates the refresh token and signs the user out of both products. Reading only is what removes that class of failure, and the cost is one `claude` run when a token expires.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Document absent | Silent `undefined`; a host without Claude Code is a normal state, and the remaining layers answer as before. |
| Token expired | `undefined`, plus one warning naming the expiry time and the `claude` run that refreshes it. Repeats of the same expiry stay quiet. |
| No `claudeAiOauth`, or a non-string or empty token | Silent `undefined`. |
| Document readable beyond its owner | Fails loud, naming the `chmod 600` repair. A secret out of a world-readable file is not served just because another product wrote it. |
| Malformed JSON | Fails loud, naming the path. |
| Any other `stat` failure | Propagates; only a missing file reads as "not installed". |

No clock-skew margin is applied to the expiry. With no refresh path here, an early cutoff would only shorten a usable token without changing the remedy.

## Model Experience

Indirectly, through the consuming LLM adapter: the resolved token authorizes its provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **macOS is not covered** — this source reads a file. Claude Code's storage on macOS was not established when this package was written, so no path is guessed at; a Keychain-backed source belongs beside this one as a sibling.
- **An expired token needs Claude Code** — the Harness cannot refresh, by design (see above). Until `claude` runs, the reference resolves unconfigured.
- **The document belongs to another product** — its location and field names are Claude Code's to change. The failure is contained: an absent or restructured document makes this source silent, and every other credential layer keeps working.
- **A same-UID process can read the document** — the same limit the sibling file provider carries; file permissions stop other OS users, not the model's tool processes.
