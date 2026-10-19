# dsh-plugin-deepseek-search

[中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that integrates the official **DeepSeek Search / Fetch API** (<https://api-docs.deepseek.com/zh-cn/guides/search/>) as two model-facing tools:

| Tool | Endpoint | What it does |
| --- | --- | --- |
| `deepseek_search` | `POST https://api.deepseek.com/v1/tools/search` | Structured web search powered by DeepSeek's in-house engine: title, URL, snippet/summary, publication date, authority, rerank score; optional full page content |
| `deepseek_fetch` | `POST https://api.deepseek.com/v1/tools/fetch` | Fetch one page and return its title plus Markdown body |

- Read-only, no cache, no telemetry, no writes to the workspace.
- Coexists with DSH's built-in `web_search` / `web_fetch`; it registers its own tools and does not touch the `ctx.web` provider selection.
- Authentication resolves the `DEEPSEEK_API_KEY` credential reference per call (DSH credentials → process environment → literal `apiKey`), so rotating the key needs no restart.

## Install

```powershell
# From GitHub source
dsh plugin --profile <profile-name> add github:lxyztmds/dsh-plugin-deepseek-search

# Or from npm once published
dsh plugin --profile <profile-name> add dsh-plugin-deepseek-search
```

Or open the DSH plugin market / plugin page and install the entry. The `desktop` profile is application-owned: use Plugins → Discover/Install instead of the standalone CLI.

## Configuration

Defaults come from the plugin's `Config` schema; override them with an id-targeted entry in the profile's `cordis.patch.yml`:

```yaml
- id: deepseek-search
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    count: 5
    needContent: false
    timeoutMs: 60000
    retries: 2
    maxOutputChars: 60000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | empty | Literal API key (secret role; prefer a credential reference) |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved per call; falls back to the launching environment |
| `baseURL` | `https://api.deepseek.com/v1/tools` | API base, including `/v1/tools`, without `/search` or `/fetch` |
| `count` | `10` | Default result count for `deepseek_search` (1–50) |
| `needContent` | `false` | Default `need_content` value |
| `timeoutMs` | `60000` | Whole-call budget in milliseconds, retries and backoff included |
| `retries` | `2` | Retries for 408 / 429 / 5xx / network failures; `Retry-After` is honored |
| `maxOutputChars` | `60000` | Model-facing output cap; truncation is labelled |
| `sendOriginalQuestion` | `true` | Send the triggering user question (≤128 chars) as `ori_question` |

## Behaviour notes

- `query` supports the documented operators: `site:`, `-site:`, `-`, `-"phrase"`, `"phrase"`, `lang:`, `after:`, `before:`.
- Errors are mapped to actionable text with the documented status codes; local codes (`MISSING_CREDENTIAL`, `TIMEOUT`, `ABORTED`, `INVALID_RESPONSE`, `INVALID_BASE_URL`) are prefixed as `[CODE]`.
- Every provider-controlled string is bounded before it reaches the model or persisted presentation metadata; titles are escaped so they cannot spoof Markdown links; upstream error bodies are redacted.
- Billing: Search/Fetch are charged per successful request (CNY 5 per 1,000 requests, per the official guide); QPS is 5 per account for each API.

## Development

```powershell
node --test test/client.test.mjs test/format.test.mjs   # 40 unit tests, offline
node test/live-smoke.mjs                                 # real API smoke test (needs a key)
```

See [中文 README](README.md) for the full manual-install/uninstall instructions, design notes and security details.

## License

MIT
