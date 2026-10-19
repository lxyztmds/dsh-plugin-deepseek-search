import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  DeepSeekApiError,
  PLUGIN_VERSION,
  createDeepSeekApi,
  mapFetchPayload,
  mapSearchPayload,
} from '../lib/client.js'

const BASE = 'https://api.deepseek.com/v1/tools'
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Build a fetch-shaped JSON response. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Settings snapshot used by most tests. */
function settings(overrides = {}) {
  return { baseURL: BASE, timeoutMs: 60_000, retries: 0, ...overrides }
}

/** Build a client with a captured fetch and a literal key. */
function makeApi(fetchImpl, options = {}) {
  const calls = []
  const api = createDeepSeekApi({
    resolveSettings: () => settings(options.settings),
    resolveApiKey: options.resolveApiKey ?? (async () => 'sk-test'),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return fetchImpl(url, init)
    },
    // Tests default to a no-op delay so retry loops stay fast; pass realSleep for
    // cases that must observe cancellation/timeout inside the wait itself.
    ...(options.realSleep === true ? {} : { sleep: options.sleep ?? (async () => {}) }),
  })
  return { api, calls }
}

const SEARCH_ITEM = {
  rerank_score: 2.4,
  title: 'DeepSeek V4 模型发布',
  url: 'https://example.com/deepseek-v4',
  snippet: 'DeepSeek V4 已上线，支持工具调用与长上下文。',
  summary: 'DeepSeek 发布了 V4 模型。',
  content: '',
  site_name: 'Example News',
  site_icon: null,
  date: '2026-06-01T00:00:00+00:00',
  authority: 3,
}

test('the user-agent version stays in sync with package.json', () => {
  assert.equal(PLUGIN_VERSION, PACKAGE_JSON.version)
})

test('search posts the documented body to /search and normalizes the response', async () => {
  const { api, calls } = makeApi(() => jsonResponse({ results: [SEARCH_ITEM] }))
  const result = await api.search({ query: 'DeepSeek V4', count: 5, needContent: true, oriQuestion: 'V4 发布了吗' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/search`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: 'DeepSeek V4',
    count: 5,
    need_content: true,
    ori_question: 'V4 发布了吗',
  })
  assert.deepEqual(result.results, [{
    url: 'https://example.com/deepseek-v4',
    title: 'DeepSeek V4 模型发布',
    snippet: 'DeepSeek V4 已上线，支持工具调用与长上下文。',
    summary: 'DeepSeek 发布了 V4 模型。',
    siteName: 'Example News',
    date: '2026-06-01T00:00:00+00:00',
    authority: 3,
    rerankScore: 2.4,
  }])
})

test('search omits ori_question when no question is available and defaults need_content false', async () => {
  const { api, calls } = makeApi(() => jsonResponse({ results: [] }))
  const result = await api.search({ query: 'q' })

  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'q', count: 10, need_content: false })
  assert.deepEqual(result, { query: 'q', results: [] })
})

test('search clamps an out-of-range count to the documented 1-50 window', async () => {
  const { api, calls } = makeApi(() => jsonResponse({ results: [] }))
  await api.search({ query: 'q', count: 500 })
  assert.equal(JSON.parse(calls[0].init.body).count, 50)
  await api.search({ query: 'q', count: 0 })
  assert.equal(JSON.parse(calls[1].init.body).count, 1)
})

test('need_content caps the retained page body and flags the truncation', async () => {
  const longContent = 'x'.repeat(40_000)
  const { api } = makeApi(() => jsonResponse({ results: [{ ...SEARCH_ITEM, content: longContent }] }))
  const result = await api.search({ query: 'q', count: 1, needContent: true })
  const item = result.results[0]
  assert.equal(item.contentTruncated, true)
  assert.ok(item.content.length < longContent.length)
  assert.match(item.content, /content truncated at 30000 characters/u)
})

test('retryable 429 responses are retried with the Retry-After delay', async () => {
  let attempt = 0
  const delays = []
  const { api, calls } = makeApi(
    () => (++attempt < 3
      ? jsonResponse({ error: { message: 'rate limited', type: 'invalid_request_error', param: null, code: '429' } }, { status: 429, headers: { 'retry-after': '0' } })
      : jsonResponse({ results: [] })),
    { settings: { retries: 2 }, sleep: async (ms) => { delays.push(ms) } },
  )
  const result = await api.search({ query: 'q' })
  assert.equal(calls.length, 3)
  assert.deepEqual(delays, [0, 0])
  assert.deepEqual(result.results, [])
})

test('any 5xx status is retried, including 501 and 503', async () => {
  for (const status of [501, 503]) {
    let attempt = 0
    const { api, calls } = makeApi(
      () => (++attempt === 1
        ? jsonResponse({ error: { message: 'server side' } }, { status, headers: { 'retry-after': '0' } })
        : jsonResponse({ results: [] })),
      { settings: { retries: 1 } },
    )
    const result = await api.search({ query: 'q' })
    assert.equal(calls.length, 2, `HTTP ${status} should be retried`)
    assert.deepEqual(result.results, [])
  }
})

test('a 503 hint names the unavailable service when retries are exhausted', async () => {
  const { api } = makeApi(
    () => jsonResponse({ error: { message: 'maintenance' } }, { status: 503, headers: { 'retry-after': '0' } }),
    { settings: { retries: 0 } },
  )
  await assert.rejects(api.search({ query: 'q' }), /temporarily unavailable/u)
})

test('a non-retryable 401 surfaces the status and the credential guidance', async () => {
  const { api, calls } = makeApi(
    () => jsonResponse({ error: { message: 'Authentication failed', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } }, { status: 401 }),
    { settings: { retries: 2 } },
  )
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.ok(error instanceof DeepSeekApiError)
    assert.equal(error.status, 401)
    assert.equal(error.retryable, false)
    assert.match(error.message, /HTTP 401/u)
    assert.match(error.message, /Authentication failed/u)
    assert.match(error.message, /API key/i)
    assert.match(error.message, /v1\/tools\/search/u)
    return true
  })
  assert.equal(calls.length, 1, '401 must not be retried')
})

test('an echoed API key in an upstream error is redacted', async () => {
  const { api } = makeApi(
    () => jsonResponse({ error: { message: 'invalid Authorization: Bearer sk-test' } }, { status: 401 }),
    { settings: { retries: 0 } },
  )
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.doesNotMatch(error.message, /sk-test/u)
    assert.match(error.message, /\[redacted\]/u)
    return true
  })
})

test('a 429 that keeps failing reports the QPS guidance after exhausting retries', async () => {
  const { api, calls } = makeApi(
    () => jsonResponse({ error: { message: 'too many requests' } }, { status: 429, headers: { 'retry-after': '0' } }),
    { settings: { retries: 1 } },
  )
  await assert.rejects(api.search({ query: 'q' }), /QPS/u)
  assert.equal(calls.length, 2)
})

test('transport failures are retried and then reported as an API error', async () => {
  let attempt = 0
  const { api, calls } = makeApi(
    () => {
      attempt += 1
      if (attempt === 1) throw new TypeError('fetch failed')
      return jsonResponse({ results: [] })
    },
    { settings: { retries: 1 } },
  )
  const result = await api.search({ query: 'q' })
  assert.equal(calls.length, 2)
  assert.deepEqual(result.results, [])
})

test('an exhausted transport failure names the endpoint and baseURL option', async () => {
  const { api } = makeApi(() => { throw new TypeError('getaddrinfo ENOTFOUND api.deepseek.com') }, { settings: { retries: 1 } })
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.match(error.message, /failed before a response/u)
    assert.match(error.message, /baseURL/u)
    return true
  })
})

test('a malformed success body is rejected as INVALID_RESPONSE', async () => {
  const { api } = makeApi(() => jsonResponse({ nope: true }))
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE')
    assert.match(error.message, /^\[INVALID_RESPONSE\]/u)
    return true
  })
})

test('a malformed JSON body is rejected as INVALID_RESPONSE', async () => {
  const { api } = makeApi(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }))
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE')
    return true
  })
})

test('a missing key fails before any request is dispatched and exposes its code', async () => {
  let dispatched = 0
  const { api } = makeApi(() => { dispatched += 1; return jsonResponse({ results: [] }) }, {
    resolveApiKey: async () => {
      throw new DeepSeekApiError('DeepSeek API key "DEEPSEEK_API_KEY" is not configured.', { code: 'MISSING_CREDENTIAL' })
    },
  })
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /^\[MISSING_CREDENTIAL\]/u)
    return true
  })
  assert.equal(dispatched, 0)
})

test('cancellation before dispatch is reported as ABORTED', async () => {
  const { api } = makeApi(() => jsonResponse({ results: [] }))
  const controller = new AbortController()
  controller.abort(new Error('user cancelled'))
  await assert.rejects(api.search({ query: 'q', signal: controller.signal }), (error) => {
    assert.equal(error.code, 'ABORTED')
    return true
  })
})

test('cancelling a Fetch during retry backoff names the Fetch operation', async () => {
  const { api } = makeApi(
    () => jsonResponse({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '5' } }),
    { settings: { retries: 2 }, realSleep: true },
  )
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(api.fetchPage({ url: 'https://example.com/x', signal: controller.signal }), (error) => {
    assert.equal(error.code, 'ABORTED')
    assert.match(error.message, /DeepSeek Fetch API request was cancelled/u)
    return true
  })
})

test('a call that overruns the timeout budget fails as TIMEOUT', async () => {
  const { api } = makeApi(
    (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    }),
    { settings: { timeoutMs: 1_000 } },
  )
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.match(error.message, /1000 ms budget/u)
    assert.match(error.message, /^\[TIMEOUT\]/u)
    return true
  })
})

test('a timeout while reading a success body is TIMEOUT, not INVALID_RESPONSE', async () => {
  const { api } = makeApi(
    (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      }),
    }),
    { settings: { timeoutMs: 1_000 } },
  )
  await assert.rejects(api.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
})

test('fetch posts the documented body to /fetch and returns page Markdown', async () => {
  const { api, calls } = makeApi(() => jsonResponse({ title: 'Example article', content: '# Example article\n\nArticle content.' }))
  const page = await api.fetchPage({ url: 'https://example.com/article' })

  assert.equal(calls[0].url, `${BASE}/fetch`)
  assert.deepEqual(JSON.parse(calls[0].init.body), { url: 'https://example.com/article' })
  assert.deepEqual(page, {
    url: 'https://example.com/article',
    title: 'Example article',
    content: '# Example article\n\nArticle content.',
  })
})

test('fetch rejects a body without Markdown content', async () => {
  const { api } = makeApi(() => jsonResponse({ title: 'no body' }))
  await assert.rejects(api.fetchPage({ url: 'https://example.com/x' }), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE')
    return true
  })
})

test('mapSearchPayload accepts a null date and unknown authority and drops nulls', () => {
  const value = mapSearchPayload({ results: [{ url: 'https://a', title: '', snippet: '', summary: '', content: '', site_name: null, site_icon: null, date: null, authority: -1, rerank_score: 0 }] }, 'q')
  assert.deepEqual(value.results, [{ url: 'https://a', authority: -1, rerankScore: 0 }])
})

test('mapFetchPayload caps a hostile page title and very large pages', () => {
  const value = mapFetchPayload({ title: 't'.repeat(100_000), content: 'y'.repeat(210_000) }, 'https://example.com/big')
  assert.ok(value.title.length <= 400, `title should be capped, got ${value.title.length}`)
  assert.equal(value.contentTruncated, true)
  assert.ok(value.content.length <= 200_000 + 100)
})

test('an invalid, non-http, or credential-bearing baseURL fails with INVALID_BASE_URL', async () => {
  for (const baseURL of ['not a url', 'ftp://api.deepseek.com/v1/tools', 'https://user:pass@api.deepseek.com/v1/tools']) {
    const { api } = makeApi(() => jsonResponse({ results: [] }), { settings: { baseURL } })
    await assert.rejects(api.search({ query: 'q' }), (error) => {
      assert.equal(error.code, 'INVALID_BASE_URL')
      assert.match(error.message, /^\[INVALID_BASE_URL\]/u)
      return true
    }, baseURL)
  }
})
