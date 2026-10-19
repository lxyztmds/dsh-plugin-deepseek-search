/**
 * DeepSeek Search & Fetch API client.
 *
 * Implements the two read-only endpoints documented at
 * https://api-docs.deepseek.com/zh-cn/guides/search/ :
 *
 *   POST {baseURL}/search   { query, count, need_content, ori_question }
 *   POST {baseURL}/fetch    { url }
 *
 * The client owns bearer authentication, cooperative cancellation, the documented
 * retry policy (HTTP 408 / 429 / 5xx and transport failures), one deadline covering
 * the whole operation, response validation, secret redaction, and the canonical JSON
 * values the tools expose. It performs no caching.
 *
 * @module dsh-plugin-deepseek-search/client
 */

/** Default Search/Fetch API base, including the `/v1/tools` prefix. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/tools'

/** Documented default result count of the Search API. */
export const DEFAULT_COUNT = 10

/** Smallest / largest accepted Search result count. */
export const MIN_COUNT = 1
export const MAX_COUNT = 50

/** Longest accepted `query` / `ori_question`, counted in Unicode characters. */
export const MAX_QUERY_CHARS = 128

/** Per-result page-body cap kept in the canonical value (model text is capped separately). */
export const MAX_RESULT_CONTENT_CHARS = 30_000

/** Whole-page cap kept in the canonical value for one Fetch call. */
export const MAX_FETCH_CONTENT_CHARS = 200_000

/** Page-title cap kept in the canonical Fetch value (a broken/hostile `<title>` must not flood the result). */
export const MAX_FETCH_TITLE_CHARS = 300

/** Default per-request timeout budget, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Default number of retries after the first attempt. */
export const DEFAULT_RETRIES = 2

/** Keep in sync with package.json "version"; asserted by the unit tests. */
export const PLUGIN_VERSION = '0.1.1'

/** Upstream statuses mapped to actionable, model-readable guidance. */
const STATUS_HINTS = {
  400: 'The request was rejected as invalid. A query must be 1-128 Unicode characters and not blank, count must be 1-50, and the body must be valid JSON.',
  401: 'The DeepSeek API key is missing or invalid. Store a valid key for the configured credential reference (by default DEEPSEEK_API_KEY), export it in the launching environment, or set the plugin "apiKey" option.',
  402: 'The DeepSeek account balance is insufficient. Recharge the account, then retry.',
  403: 'The Fetch request was rejected by the DeepSeek safety policy for this URL.',
  404: 'The Fetch API could not obtain usable page content for this URL: the URL may be unavailable, blocked by the target site, or have no extractable Markdown body.',
  408: 'DeepSeek timed out while reading the request body. Retry later.',
  413: 'The request body exceeded the DeepSeek API size limit.',
  429: 'The account-level Search/Fetch QPS limit (5 requests per second) was exceeded. Wait briefly, then retry.',
  500: 'The DeepSeek server reported an internal error.',
  502: 'A DeepSeek upstream service returned an invalid response (bad gateway).',
  503: 'The DeepSeek service is temporarily unavailable (service unavailable).',
  504: 'A downstream request timed out on the DeepSeek side.',
}

const USER_AGENT = `dsh-plugin-deepseek-search/${PLUGIN_VERSION}`

/**
 * One failure of a DeepSeek Search/Fetch operation.
 *
 * `code` carries a machine-routable class for local failures; local codes are also
 * prefixed into the model-facing message so the model (and host logs) can route on
 * them even though this plugin does not depend on the harness error base class.
 * `status` carries the upstream HTTP status when the failure came from a response.
 */
export class DeepSeekApiError extends Error {
  /**
   * @param message - model-readable failure text, including recovery guidance.
   * @param options - failure classification.
   * @param options.status - upstream HTTP status, when one was received.
   * @param options.code - stable local code (`MISSING_CREDENTIAL`, `ABORTED`, `TIMEOUT`, `INVALID_RESPONSE`, `INVALID_BASE_URL`).
   * @param options.retryable - whether the documentation says a retry may succeed.
   * @param options.cause - underlying error, when one exists.
   */
  constructor(message, options = {}) {
    super(options.code === undefined ? message : `[${options.code}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DeepSeekApiError'
    this.status = options.status
    this.code = options.code
    this.retryable = options.retryable === true
  }
}

/**
 * Create the Search/Fetch API client used by the plugin's tools.
 *
 * @param options - injected ports, so the client is testable without the network.
 * @param options.resolveSettings - reads the current plugin settings snapshot.
 * @param options.resolveApiKey - resolves the bearer token, or throws a `MISSING_CREDENTIAL` error.
 * @param options.fetchImpl - `fetch`-compatible function.
 * @param options.sleep - abortable delay used between retries: `(ms, signal, operation) => Promise<void>`.
 * @returns The two documented API operations.
 */
export function createDeepSeekApi(options) {
  const {
    resolveSettings,
    resolveApiKey,
    fetchImpl = (...args) => globalThis.fetch(...args),
    sleep = sleepAbortable,
  } = options

  /**
   * Dispatch one JSON request with the documented retry policy.
   *
   * @param operation - `Search` or `Fetch`, used in diagnostics.
   * @param pathname - `/search` or `/fetch`.
   * @param body - request JSON.
   * @param signal - caller cancellation signal.
   * @returns Parsed JSON body of a successful response.
   */
  async function request(operation, pathname, body, signal) {
    const settings = resolveSettings()
    const endpoint = resolveEndpoint(settings.baseURL, pathname)
    // Never print userinfo or an echoed key; the endpoint is user-configured.
    const shownEndpoint = redactUrlCredentials(endpoint)
    const retries = clampInteger(settings.retries, 0, 5, DEFAULT_RETRIES)
    const timeoutMs = clampInteger(settings.timeoutMs, 1_000, 600_000, DEFAULT_TIMEOUT_MS)
    // One deadline covers the whole operation, including every retry and its backoff,
    // so `timeoutMs` bounds how long a single tool call can occupy the agent loop.
    const deadline = AbortSignal.timeout(timeoutMs)
    let lastError

    /**
     * Wait between attempts without escaping the operation deadline or the caller's
     * cancellation. A deadline abort while waiting is a TIMEOUT, never a retry.
     *
     * @param ms - delay in milliseconds.
     */
    async function pause(ms) {
      const waitSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
      try {
        await sleep(ms, waitSignal, operation)
      } catch (error) {
        throwIfAborted(signal, operation)
        if (deadline.aborted) throw timeoutError(operation, shownEndpoint, timeoutMs)
        throw error
      }
      throwIfAborted(signal, operation)
      if (deadline.aborted) throw timeoutError(operation, shownEndpoint, timeoutMs)
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      throwIfAborted(signal, operation)
      if (deadline.aborted) throw timeoutError(operation, shownEndpoint, timeoutMs)
      const apiKey = await resolveApiKey()

      const signalForAttempt = signal === undefined ? deadline : AbortSignal.any([signal, deadline])

      let response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: signalForAttempt,
        })
      } catch (error) {
        throwIfAborted(signal, operation)
        if (deadline.aborted) throw timeoutError(operation, shownEndpoint, timeoutMs)
        lastError = new DeepSeekApiError(
          `DeepSeek ${operation} API request failed before a response: ${redactSecrets(describeError(error), apiKey)} (endpoint: ${shownEndpoint}). Check network access and the plugin "baseURL" option.`,
          { retryable: true, cause: error },
        )
        if (attempt < retries) {
          await pause(backoffMs(attempt))
          continue
        }
        throw lastError
      }

      if (!response.ok) {
        const detail = redactSecrets(await readErrorDetail(response), apiKey)
        if (deadline.aborted) throw timeoutError(operation, shownEndpoint, timeoutMs)
        lastError = new DeepSeekApiError(
          httpErrorMessage(operation, shownEndpoint, response.status, detail),
          { status: response.status, retryable: isRetryableStatus(response.status) },
        )
        if (lastError.retryable && attempt < retries) {
          await pause(retryDelayMs(response, attempt))
          continue
        }
        throw lastError
      }

      try {
        return await response.json()
      } catch (error) {
        throwIfAborted(signal, operation)
        if (deadline.aborted) throw timeoutError(operation, shownEndpoint, timeoutMs)
        throw new DeepSeekApiError(
          `DeepSeek ${operation} API returned a response that is not valid JSON (endpoint: ${shownEndpoint}).`,
          { status: response.status, code: 'INVALID_RESPONSE', cause: error },
        )
      }
    }

    throw lastError ?? new DeepSeekApiError(`DeepSeek ${operation} API request failed.`)
  }

  /**
   * Run one documented Search request and project the response into the canonical value.
   *
   * @param requestShape - query, result count, body toggle, optional triggering question, cancellation.
   * @returns Canonical search value (`{ query, results }`).
   */
  async function search(requestShape) {
    const { query, count, needContent, oriQuestion, signal } = requestShape
    const payload = await request(
      'Search',
      '/search',
      {
        query,
        count: clampInteger(count, MIN_COUNT, MAX_COUNT, DEFAULT_COUNT),
        need_content: needContent === true,
        ...(oriQuestion === undefined || oriQuestion.length === 0 ? {} : { ori_question: oriQuestion }),
      },
      signal,
    )
    return mapSearchPayload(payload, query)
  }

  /**
   * Run one documented Fetch request and project the page Markdown into the canonical value.
   *
   * @param requestShape - target URL and cancellation.
   * @returns Canonical fetch value (`{ url, title?, content }`).
   */
  async function fetchPage(requestShape) {
    const { url, signal } = requestShape
    const payload = await request('Fetch', '/fetch', { url }, signal)
    return mapFetchPayload(payload, url)
  }

  return { search, fetchPage }
}

/**
 * Validate a Search API response and project it into the tool's canonical value.
 *
 * @param payload - untrusted JSON returned by the Search endpoint.
 * @param query - the query that produced it.
 * @returns Canonical search value.
 * @throws {DeepSeekApiError} `INVALID_RESPONSE` when the body is not the documented shape.
 */
export function mapSearchPayload(payload, query) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw invalidResponse('Search')
  return { query, results: payload.results.map((item) => mapSearchResult(item)) }
}

/**
 * Validate a Fetch API response and project it into the tool's canonical value.
 *
 * @param payload - untrusted JSON returned by the Fetch endpoint.
 * @param url - the requested URL.
 * @returns Canonical fetch value.
 * @throws {DeepSeekApiError} `INVALID_RESPONSE` when the body is not the documented shape.
 */
export function mapFetchPayload(payload, url) {
  if (!isRecord(payload) || typeof payload.content !== 'string') throw invalidResponse('Fetch')
  const content = clipText(payload.content, MAX_FETCH_CONTENT_CHARS)
  const title = typeof payload.title === 'string' ? clipText(payload.title.trim(), MAX_FETCH_TITLE_CHARS) : undefined
  return {
    url,
    ...(title !== undefined && title.text.length > 0 ? { title: title.text } : {}),
    content: content.text,
    ...(content.truncated ? { contentTruncated: true } : {}),
  }
}

/**
 * Project one Search result item, keeping only fields the canonical schema declares.
 *
 * @param item - untrusted result entry.
 * @returns Canonical result entry.
 * @throws {DeepSeekApiError} `INVALID_RESPONSE` when `url` is missing.
 */
function mapSearchResult(item) {
  if (!isRecord(item) || typeof item.url !== 'string' || item.url.length === 0) throw invalidResponse('Search')
  const result = { url: item.url }
  if (typeof item.title === 'string' && item.title.length > 0) result.title = item.title
  if (typeof item.snippet === 'string' && item.snippet.length > 0) result.snippet = item.snippet
  if (typeof item.summary === 'string' && item.summary.length > 0) result.summary = item.summary
  if (typeof item.site_name === 'string' && item.site_name.length > 0) result.siteName = item.site_name
  if (typeof item.date === 'string' && item.date.length > 0) result.date = item.date
  if (Number.isInteger(item.authority) && item.authority >= -1 && item.authority <= 4) result.authority = item.authority
  if (typeof item.rerank_score === 'number' && Number.isFinite(item.rerank_score)) result.rerankScore = item.rerank_score
  if (typeof item.content === 'string' && item.content.length > 0) {
    const content = clipText(item.content, MAX_RESULT_CONTENT_CHARS)
    result.content = content.text
    if (content.truncated) result.contentTruncated = true
  }
  return result
}

/**
 * Whether the documentation says a status is worth retrying: 408, 429, or any 5xx.
 *
 * @param status - upstream HTTP status.
 * @returns True for retryable statuses.
 */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Build the endpoint for one operation, validating the configured base URL.
 *
 * Requires an absolute http(s) URL with a host and rejects embedded credentials so
 * the bearer key can never travel to an unparseable origin or leak through userinfo.
 *
 * @param baseURL - configured base such as `https://api.deepseek.com/v1/tools`.
 * @param pathname - `/search` or `/fetch`.
 * @returns Absolute endpoint URL.
 * @throws {DeepSeekApiError} `INVALID_BASE_URL` when the base is unusable.
 */
function resolveEndpoint(baseURL, pathname) {
  const raw = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/u, '') : ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    parsed = undefined
  }
  const problem = raw.length === 0
    ? 'is empty'
    : parsed === undefined
      ? 'is not a valid URL'
      : parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
        ? 'must use the http or https scheme'
        : parsed.hostname.length === 0
          ? 'must include a host'
          : parsed.username.length > 0 || parsed.password.length > 0
            ? 'must not carry a username or password'
            : undefined
  if (problem !== undefined) {
    const shown = raw.length === 0 ? '' : ` (${JSON.stringify(redactUrlCredentials(raw))})`
    throw new DeepSeekApiError(
      `The DeepSeek Search/Fetch API "baseURL" ${problem}${shown}. Set it to a trusted endpoint such as ${DEFAULT_BASE_URL}.`,
      { code: 'INVALID_BASE_URL' },
    )
  }
  return `${raw}${pathname}`
}

/**
 * Remove URL userinfo before a URL reaches a model-facing message.
 *
 * @param value - URL or text containing URLs.
 * @returns The same text with `scheme://user:pass@` replaced by `scheme://[redacted]@`.
 */
function redactUrlCredentials(value) {
  return String(value).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
}

/**
 * Remove a resolved API key (and URL userinfo) from untrusted upstream text.
 *
 * @param text - candidate text, possibly echoed by an upstream/proxy.
 * @param apiKey - resolved bearer key for this operation.
 * @returns Text safe to show the model and write to logs.
 */
function redactSecrets(text, apiKey) {
  if (typeof text !== 'string') return text
  let redacted = text
  if (typeof apiKey === 'string' && apiKey.length >= 6) redacted = redacted.split(apiKey).join('[redacted]')
  return redactUrlCredentials(redacted)
}

/**
 * Compose the actionable HTTP failure text for the model.
 *
 * @param operation - `Search` or `Fetch`.
 * @param endpoint - dispatched endpoint (already redacted).
 * @param status - upstream HTTP status.
 * @param detail - upstream error message, when the body carried one.
 * @returns Failure text naming the status, detail, hint, and endpoint.
 */
function httpErrorMessage(operation, endpoint, status, detail) {
  const hint = STATUS_HINTS[status]
    ?? (status >= 500 && status <= 599
      ? 'The DeepSeek service reported a server-side error; retry later.'
      : 'The DeepSeek API rejected the request.')
  const upstream = detail === undefined || detail.length === 0
    ? ''
    : `: ${detail.replace(/[.\s]+$/u, '')}.`
  return `DeepSeek ${operation} API error (HTTP ${status})${upstream} ${hint} (endpoint: ${endpoint})`
}

/**
 * Read the documented OpenAI-compatible error detail from a failed response.
 *
 * @param response - failed fetch response.
 * @returns The upstream message, or undefined when the body carries none.
 */
async function readErrorDetail(response) {
  try {
    const payload = await response.json()
    if (!isRecord(payload)) return undefined
    if (typeof payload.error === 'string' && payload.error.length > 0) return payload.error
    if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.length > 0) return payload.error.message
    if (typeof payload.message === 'string' && payload.message.length > 0) return payload.message
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Delay between retries: the `Retry-After` response header when present, otherwise
 * exponential backoff with jitter, capped well below the QPS window.
 *
 * @param response - failed fetch response, when one exists.
 * @param attempt - zero-based retry attempt.
 * @returns Delay in milliseconds.
 */
function retryDelayMs(response, attempt) {
  const header = response.headers?.get?.('retry-after')
  if (typeof header === 'string' && header.length > 0) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, Math.round(seconds * 1_000))
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - Date.now()))
  }
  return backoffMs(attempt)
}

/**
 * Exponential backoff with jitter for transport failures.
 *
 * @param attempt - zero-based retry attempt.
 * @returns Delay in milliseconds.
 */
function backoffMs(attempt) {
  return Math.min(5_000, 300 * 2 ** attempt + Math.floor(Math.random() * 100))
}

/**
 * Await an abortable delay so cancellation never waits out a retry timer.
 *
 * @param ms - delay in milliseconds.
 * @param signal - cancellation signal for the wait (caller signal fused with the deadline).
 * @param operation - `Search` or `Fetch`, used in the cancellation message.
 * @returns Resolves after the delay.
 * @throws {DeepSeekApiError} `ABORTED` when the wait is cancelled.
 */
function sleepAbortable(ms, signal, operation = 'Search') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortedError(signal, operation))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError(signal, operation))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Throw the local cancellation error when the caller's signal already fired.
 *
 * @param signal - caller cancellation signal.
 * @param operation - `Search` or `Fetch`.
 */
function throwIfAborted(signal, operation) {
  if (signal?.aborted === true) throw abortedError(signal, operation)
}

/**
 * Build the local timeout error for one operation.
 *
 * @param operation - `Search` or `Fetch`.
 * @param endpoint - dispatched endpoint (already redacted).
 * @param timeoutMs - the operation budget that elapsed.
 * @returns The `TIMEOUT` error.
 */
function timeoutError(operation, endpoint, timeoutMs) {
  return new DeepSeekApiError(
    `DeepSeek ${operation} API call did not finish within the ${timeoutMs} ms budget (endpoint: ${endpoint}). Retry with a smaller count or need_content=false, or raise the plugin "timeoutMs" option.`,
    { code: 'TIMEOUT' },
  )
}

/**
 * Build the local cancellation error, keeping the caller's reason as the cause.
 *
 * @param signal - caller cancellation signal.
 * @param operation - `Search` or `Fetch`.
 * @returns The `ABORTED` error.
 */
function abortedError(signal, operation = 'Search') {
  return new DeepSeekApiError(`DeepSeek ${operation} API request was cancelled.`, {
    code: 'ABORTED',
    cause: signal?.reason,
  })
}

/**
 * Build the strict invalid-response error for one operation.
 *
 * @param operation - `Search` or `Fetch`.
 * @returns The `INVALID_RESPONSE` error.
 */
function invalidResponse(operation) {
  return new DeepSeekApiError(
    `DeepSeek ${operation} API returned an unexpected response body. The configured endpoint may not implement the documented Search/Fetch API; check the plugin "baseURL" option.`,
    { code: 'INVALID_RESPONSE' },
  )
}

/**
 * Clip text to a hard character budget, leaving a visible truncation marker.
 *
 * @param text - source text.
 * @param maxChars - maximum retained characters.
 * @returns Clipped text and whether clipping happened.
 */
function clipText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n\n[content truncated at ${maxChars} characters]`,
    truncated: true,
  }
}

/**
 * Clamp a numeric setting or argument to an integer in range.
 *
 * @param value - candidate value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the candidate is not a finite number.
 * @returns Clamped integer.
 */
function clampInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Test for a plain JSON record.
 *
 * @param value - candidate value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render an unknown thrown value as a short message.
 *
 * @param error - thrown value.
 * @returns Short human-readable description.
 */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
