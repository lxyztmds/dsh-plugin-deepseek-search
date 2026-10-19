# Changelog

## 0.1.1 — 2026-10-19

- Bound every provider-controlled string (fetch page title/URL/body, search title/summary/body and presentation metadata) so a hostile or broken page cannot exceed `maxOutputChars` or bloat persisted tool results.
- Fetch result cards now derive `truncated` from the same computation that renders the model-facing text.
- A timeout while reading a success body or an upstream error body now reports `TIMEOUT` instead of `INVALID_RESPONSE`.
- `need_content` page bodies that were cut are now labelled for the model.
- Retry policy follows the guide: 408, 429 and any 5xx, with `Retry-After` support; 502/503 have dedicated hints.
- Retry backoff now counts against the per-call deadline and reports cancellation as the correct operation (`Search`/`Fetch`).
- `baseURL` must be an absolute http(s) URL with a host and without embedded credentials.
- Upstream error details are redacted (API key and URL userinfo) before reaching the model or logs.
- Local error codes are prefixed into messages (`[MISSING_CREDENTIAL]`, `[TIMEOUT]`, `[ABORTED]`, `[INVALID_RESPONSE]`, `[INVALID_BASE_URL]`).
- Presentation results are suppressed for failed calls; markdown link labels are escaped; rank scores are rounded; the unused `siteIcon` canonical field was removed.
- Added English README, CI workflow and the `scripts/install-bundle-entry.mjs` helper.

## 0.1.0 — 2026-10-19

- Initial release: `deepseek_search` and `deepseek_fetch` tools over the DeepSeek Search / Fetch API, credential-reference authentication, documented retries and error mapping, output caps, web result cards, 30 unit tests and a live smoke test.
