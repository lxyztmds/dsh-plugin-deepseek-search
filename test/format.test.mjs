import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  UNTRUSTED_NOTICE,
  fetchOutputSchema,
  makeFetchPresentation,
  makeFetchRender,
  makeSearchPresentation,
  makeSearchRender,
  searchOutputSchema,
} from '../lib/format.js'

const SETTINGS = { maxOutputChars: 60_000 }

const SEARCH_VALUE = {
  query: 'DeepSeek 发布',
  results: [
    {
      url: 'https://example.com/a',
      title: 'DeepSeek V4 发布',
      summary: 'DeepSeek 发布了 V4 模型。',
      snippet: '短摘要',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
      rerankScore: 2.4,
      siteName: 'Example News',
    },
    { url: 'https://example.com/b' },
  ],
}

test('search render labels provider text as untrusted and lists title, URL, summary and facts', () => {
  const blocks = makeSearchRender(SETTINGS)({}, SEARCH_VALUE)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  const text = blocks[0].text
  assert.ok(text.startsWith(UNTRUSTED_NOTICE))
  assert.match(text, /Search results for "DeepSeek 发布" \(2 results\)/u)
  assert.match(text, /1\. \[DeepSeek V4 发布\]\(<https:\/\/example\.com\/a>\)/u)
  assert.match(text, /Summary: DeepSeek 发布了 V4 模型。/u)
  assert.match(text, /Published: 2026-06-01T00:00:00\+00:00 · Authority: 3\/4 · Rerank score: 2\.4 · Site: Example News/u)
  assert.match(text, /2\. https:\/\/example\.com\/b/u)
  assert.match(text, /Cite the relevant URLs above as markdown links/u)
})

test('search render rounds rank scores and escapes spoofed link labels', () => {
  const text = makeSearchRender(SETTINGS)({}, {
    query: 'q',
    results: [{ url: 'https://example.com/real', title: 'evil](https://evil.example)', rerankScore: 2.257854461669922 }],
  })[0].text
  assert.match(text, /Rerank score: 2\.26/u)
  assert.match(text, /evil\\\]\(https:\/\/evil\.example\)/u)
  assert.match(text, /\]\(<https:\/\/example\.com\/real>\)/u)
})

test('search render reports an empty result set explicitly', () => {
  const blocks = makeSearchRender(SETTINGS)({}, { query: 'nothing', results: [] })
  assert.match(blocks[0].text, /\(no results\)/u)
  assert.match(blocks[0].text, /No matching web pages were found/u)
})

test('search render caps the whole model-facing output and says how many results were shown', () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    url: `https://example.com/${index}`,
    title: `Result ${index}`,
    summary: 's'.repeat(500),
  }))
  const blocks = makeSearchRender({ maxOutputChars: 3_000 })({}, { query: 'q', results })
  const text = blocks[0].text
  assert.ok(text.length <= 3_500, `expected a capped body, got ${text.length} chars`)
  assert.match(text, /Showing the first \d+ of 20 results/u)
  assert.match(text, /capped at 3000 characters/u)
  assert.match(text, /Cite the relevant URLs above/u)
})

test('search render caps a single long summary so later results stay visible', () => {
  const value = {
    query: 'q',
    results: [
      { url: 'https://e/1', title: 'One', summary: 's'.repeat(5_000) },
      { url: 'https://e/2', title: 'Two', summary: 'short second result' },
    ],
  }
  const text = makeSearchRender(SETTINGS)({}, value)[0].text
  assert.match(text, /Summary: s{1500}…/u)
  assert.match(text, /2\. \[Two\]\(<https:\/\/e\/2>\)/u)
  assert.match(text, /Summary: short second result/u)
})

test('search render includes page content and tells the model when it was cut', () => {
  const value = {
    query: 'q',
    results: [
      { url: 'https://e/x', title: 'X', content: 'line one\nline two' },
      { url: 'https://e/y', title: 'Y', content: 'z'.repeat(10_000), contentTruncated: true },
    ],
  }
  const text = makeSearchRender(SETTINGS)({}, value)[0].text
  assert.match(text, /Content:/u)
  assert.match(text, /line one\nline two/u)
  assert.match(text, /\(Page content truncated; call deepseek_fetch with this URL for the full text\.\)/u)
})

test('search presentation carries faithful sources and a web result card', () => {
  const presentation = makeSearchPresentation(SETTINGS)
  const meta = presentation.presentationMeta({}, SEARCH_VALUE)
  assert.equal(meta.kind, 'search')
  assert.deepEqual(meta.sources, [
    {
      url: 'https://example.com/a',
      title: 'DeepSeek V4 发布',
      snippet: '短摘要',
      publishedAt: '2026-06-01T00:00:00+00:00',
    },
    { url: 'https://example.com/b' },
  ])
  const view = presentation.presentResult({}, { content: [], isError: false, meta })
  assert.deepEqual(view, { card: 'web', kind: 'search', sources: meta.sources, truncated: false })
})

test('search presentation bounds persisted metadata and skips error results', () => {
  const presentation = makeSearchPresentation(SETTINGS)
  const meta = presentation.presentationMeta({}, {
    query: 'q',
    results: [{ url: 'https://e/x', title: 't'.repeat(500_000), snippet: 's'.repeat(500_000) }],
  })
  assert.ok(meta.sources[0].title.length <= 310)
  assert.ok(meta.sources[0].snippet.length <= 410)
  assert.equal(presentation.presentResult({}, { content: [], isError: true, meta }), undefined)
})

test('search presentation falls back to the generic card for an obsolete meta shape', () => {
  const presentation = makeSearchPresentation(SETTINGS)
  assert.equal(presentation.presentResult({}, { content: [], isError: false }), undefined)
  assert.equal(presentation.presentResult({}, { content: [], isError: false, meta: { kind: 'search', sources: 'bad' } }), undefined)
})

test('fetch render emits title, untrusted notice and Markdown body', () => {
  const text = makeFetchRender(SETTINGS)({}, {
    url: 'https://example.com/article',
    title: 'Example article',
    content: '# Example article\n\nArticle content.',
  })[0].text
  assert.match(text, /^Fetched https:\/\/example\.com\/article through the DeepSeek Fetch API\./u)
  assert.ok(text.includes(UNTRUSTED_NOTICE))
  assert.match(text, /Example article\n\n# Example article/u)
  assert.doesNotMatch(text, /Content truncated/u)
})

test('fetch render truncates an oversized body with a visible footer', () => {
  const text = makeFetchRender({ maxOutputChars: 2_000 })({}, {
    url: 'https://example.com/big',
    content: 'z'.repeat(10_000),
  })[0].text
  assert.ok(text.length <= 2_000, `expected a capped body, got ${text.length} chars`)
  assert.match(text, /Content truncated\. Fetch a more specific URL/u)
})

test('fetch render bounds a hostile page title inside the output cap', () => {
  const text = makeFetchRender({ maxOutputChars: 2_000 })({}, {
    url: 'https://example.com/big',
    title: 'T'.repeat(100_000),
    content: 'z'.repeat(10_000),
  })[0].text
  assert.ok(text.length <= 2_000, `expected a capped body, got ${text.length} chars`)
})

test('fetch presentation reports the requested URL and truncation consistent with the rendered text', () => {
  const presentation = makeFetchPresentation({ maxOutputChars: 2_000 })
  // 1,800 content + a 500-char title exceeds the 2,000 cap only once the header counts:
  // the metadata must agree with the renderer instead of comparing content alone.
  const value = { url: 'https://e/x', title: 't'.repeat(500), content: 'z'.repeat(1_800) }
  const rendered = makeFetchRender({ maxOutputChars: 2_000 })({}, value)[0].text
  assert.match(rendered, /Content truncated/u)
  const meta = presentation.presentationMeta({}, value)
  assert.equal(meta.kind, 'fetch')
  assert.equal(meta.truncated, true)
  assert.equal(presentation.presentResult({}, { content: [], isError: false, meta }).truncated, true)
})

test('fetch presentation skips error results', () => {
  const presentation = makeFetchPresentation({ maxOutputChars: 2_000 })
  const meta = presentation.presentationMeta({}, { url: 'https://e/x', content: 'ok' })
  assert.equal(presentation.presentResult({}, { content: [], isError: true, meta }), undefined)
})

test('declared output schemas match the canonical values the client produces', () => {
  assert.equal(searchOutputSchema.type, 'object')
  assert.equal(searchOutputSchema.additionalProperties, false)
  assert.equal(searchOutputSchema.properties.results.items.properties.siteIcon, undefined)
  assert.deepEqual(fetchOutputSchema.properties.url, { type: 'string', required: true })
  assert.equal(fetchOutputSchema.properties.content.type, 'string')
})
