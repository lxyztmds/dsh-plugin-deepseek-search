/**
 * Live smoke test against the real DeepSeek Search / Fetch API.
 *
 * Resolves the key from DEEPSEEK_API_KEY or from the DSH credentials file, runs one
 * small search and one fetch, and prints a short summary. Nothing is written.
 *
 * Usage:
 *   node test/live-smoke.mjs
 *   DEEPSEEK_API_KEY=sk-... node test/live-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BASE_URL, createDeepSeekApi } from '../lib/client.js'

/** Read a DeepSeek API key from the environment or the local DSH credential store. */
function readApiKey() {
  const ambient = process.env.DEEPSEEK_API_KEY
  if (typeof ambient === 'string' && ambient.trim().length > 0) return ambient.trim()
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/mu.exec(text)
    if (match !== null) return match[1]
  } catch {
    // No local credential store; the caller can still pass the key through the environment.
  }
  return undefined
}

const apiKey = readApiKey()
if (apiKey === undefined) {
  console.log('[skip] no DEEPSEEK_API_KEY in the environment or ~/.dsh/.credentials.yaml')
  process.exit(0)
}

const baseURL = process.env.DEEPSEEK_SEARCH_API_BASE_URL ?? DEFAULT_BASE_URL
const api = createDeepSeekApi({
  resolveSettings: () => ({ baseURL, timeoutMs: 60_000, retries: 1 }),
  resolveApiKey: async () => apiKey,
})

const started = Date.now()
const search = await api.search({ query: 'DeepSeek V4 模型 发布', count: 3, needContent: false })
console.log(`[search] ${search.results.length} results in ${Date.now() - started} ms via ${baseURL}/search`)
for (const [index, result] of search.results.entries()) {
  console.log(`  ${index + 1}. ${result.title ?? '(no title)'} | ${result.url} | score=${result.rerankScore ?? '?'} | date=${result.date ?? '?'}`)
}

const fetchStarted = Date.now()
const page = await api.fetchPage({ url: 'https://api-docs.deepseek.com/zh-cn/guides/search/' })
console.log(`[fetch] ${page.title ?? '(no title)'} | ${page.content.length} markdown chars in ${Date.now() - fetchStarted} ms via ${baseURL}/fetch`)
console.log(page.content.slice(0, 160).replace(/\s+/gu, ' '))
