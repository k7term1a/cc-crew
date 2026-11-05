import { describe, expect, test } from 'claude-code/testing'

import { buildForkPrompt } from '../hooks/answer'
import { parseTitleSummary } from '../hooks/digest'
import { callJev, JEV_MODEL, JEV_URL, type JevRequest } from '../hooks/jev'

const request: JevRequest = { state: '[new prompt]\n為什麼 TCP 要三次握手？', questions: { kind: { type: 'noul', instructions: 'x' } } }

describe('jev transport', () => {
  test('without a key it reports no-key and never fetches', async () => {
    let fetched = 0
    const r = await callJev({ key: undefined, fetch: async () => { fetched++; throw new Error('no') }, now: async () => 0 }, request)
    expect(r).toMatchObject({ ok: false, reason: 'no-key' })
    expect(fetched).toBe(0)
  })

  test('POSTs the model, the state and the questions with a bearer key, and hands back the parsed body', async () => {
    let url = ''
    let auth = ''
    let sent: unknown = null
    const r = await callJev(
      {
        key: 'k',
        fetch: async (u, init) => {
          url = u
          auth = (init?.headers as Record<string, string>).authorization ?? ''
          sent = JSON.parse(String(init?.body))
          return { status: 200, ok: true, headers: {}, text: '{"answers":{"kind":{"type":"noul","noul":0.8}}}' }
        },
        now: async () => 0,
      },
      request,
    )
    expect(url).toBe(JEV_URL)
    expect(auth).toBe('Bearer k')
    expect(sent).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
    expect(r).toMatchObject({ ok: true, body: { answers: { kind: { noul: 0.8 } } } })
  })

  test('maps a 403 to http, a body that is not JSON to bad-response, a throw to network', async () => {
    const via = (fetch: () => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>) => callJev({ key: 'k', fetch, now: async () => 0 }, request)
    expect(await via(async () => ({ status: 403, ok: false, headers: {}, text: '{"detail":{}}' }))).toMatchObject({ ok: false, reason: 'http', status: 403 })
    expect(await via(async () => ({ status: 200, ok: true, headers: {}, text: 'nope' }))).toMatchObject({ ok: false, reason: 'bad-response', status: 200 })
    expect(
      await via(async () => {
        throw new Error('offline')
      }),
    ).toMatchObject({ ok: false, reason: 'network' })
  })
})

describe('summary + fork prompts', () => {
  test('title/summary JSON, fenced or bare', () => {
    expect(parseTitleSummary('```json\n{"title":"TCP 背壓","summary":"a. b. c."}\n```')).toEqual({ title: 'TCP 背壓', summary: 'a. b. c.' })
    expect(parseTitleSummary('nope')).toBeNull()
  })

  test('the fork prompt carries the side thread as text', () => {
    const p = buildForkPrompt([{ question: 'Q?', answer: 'A.' }], 'Next?')
    expect(p).toContain('Q1: Q?\nA1: A.')
    expect(p.endsWith('[question]\nNext?')).toBe(true)
  })
})
