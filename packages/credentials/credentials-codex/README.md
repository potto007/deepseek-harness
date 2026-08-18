# dsh-credentials-codex

English | [中文](README.zh.md)

Read-only [credentials](../credentials/README.md) source over the ChatGPT OAuth access token the Codex CLI already stored on this machine. A user who is logged in to the Codex CLI reaches its models from the Harness without obtaining a second credential.

The package registers one source with the seam. It owns no service, writes nothing, and refreshes nothing. It is the Codex sibling of [`dsh-credentials-claude-code`](../credentials-claude-code/README.md) and holds to the same terms throughout.

| Fact | Value |
|---|---|
| Source id | `codex` |
| Reference answered | `CODEX_OAUTH_TOKEN` (configurable) |
| Document read | `~/.codex/auth.json` (configurable) |
| Served only while | the document's `auth_mode` is `chatgpt` |
| Precedence | below every layer the credentials provider answers itself |
| Writability | `set` still succeeds and outranks this source |

## Config

| Field | Default | Meaning |
|---|---|---|
| `path` | `~/.codex/auth.json` | The Codex CLI's credential document. |
| `ref` | `CODEX_OAUTH_TOKEN` | The one reference this source answers. |

## Reaching a Codex model

The source only supplies the token. One `llm-pi-ai` settings route consumes it:

```yaml
llm-pi-ai:
  providers:
    openai-codex:
      apiKeyEnv: CODEX_OAUTH_TOKEN
```

Naming no `api` keeps the route on pi-ai's catalog `openai-codex` provider. That implementation extracts the `chatgpt_account_id` claim from the JWT it is handed and sends `Authorization: Bearer` with the `chatgpt-account-id` header per request, so no adapter configuration expresses the OAuth path. The catalog provider declares OAuth-only auth; the harness's route construction adds its own api-key method beside it exactly when a profile names a credential, which is what lets this token arrive per request.

## Read behaviour

The document is read on every resolution — no cache, no watcher — so a token the Codex CLI refreshes reaches the next Harness request with nothing to invalidate.

The value served is `tokens.access_token`, and only while `auth_mode` is `"chatgpt"`. A stored plain `OPENAI_API_KEY` (auth mode `apikey`) is deliberately not served: an API key belongs in the ordinary credential layers, and duplicating them from another product's file would give one key two competing sources.

## Expiry

The document records no expiry; the JWT's `exp` claim is the only one there is. The source decodes the payload without verification — it is the client reading its own token, not a verifier — and treats a past `exp` as absent, warning once with the expiry time and the one `codex` run that refreshes it. A token whose payload does not decode is served as-is and left to the provider to reject, because refusing it would be a guess.

## What this package will not do

It never reads `refresh_token`, and the field is not named anywhere in its source. OpenAI's token endpoint rotates the refresh token; a Harness refresh would either strand the Codex CLI with a superseded token or race it for the same file. Reading only removes that class of failure, and the cost is one `codex` run when a token expires.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Document absent | Silent `undefined`; a host without the Codex CLI is a normal state. |
| `auth_mode` not `chatgpt` | Silent `undefined`. |
| Token expired (JWT `exp` past) | `undefined`, plus one warning naming the expiry and the `codex` remedy. Repeats stay quiet. |
| Missing, non-string, or empty token | Silent `undefined`. |
| Document readable beyond its owner | Fails loud, naming the `chmod 600` repair. |
| Malformed JSON | Fails loud, naming the path. |
| Any other `stat` failure | Propagates; only a missing file reads as "not installed". |

## Terms of use

The endpoint this token authorizes, `chatgpt.com/backend-api`, is the ChatGPT backend rather than a public API, and OpenAI documents no supported path for third-party harnesses to use ChatGPT subscription tokens. Usage draws on the subscription's own limits. Whether to route through it is the deployment's decision; this package only reads a local file.

## Model Experience

Indirectly, through the consuming LLM adapter: the resolved token authorizes its provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **An expired token needs the Codex CLI** — the Harness cannot refresh, by design (see above). Until `codex` runs, the reference resolves unconfigured.
- **The document belongs to another product** — its location, `auth_mode` values, and field names are the Codex CLI's to change. The failure is contained: an absent or restructured document makes this source silent, and every other credential layer keeps working.
- **`apikey` mode is not bridged** — a stored plain API key is ignored here; configure it through the ordinary credential layers instead.
- **A same-UID process can read the document** — the same limit every file-backed credential surface carries; file permissions stop other OS users, not the model's tool processes.
