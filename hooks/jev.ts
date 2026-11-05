// TypeSafe Jev client: the transport only. The only file that knows Jev's URL and
// request envelope. Schema source: third-party write-up (apidog.com/blog/what-is-jev),
// NOT yet checked against console.typesafe.ai — see PROBE.md. Endpoint reachability
// is verified (403 "Must supply an API key!" without a key).
//
// 11/05 (PLAN.md「11/05 改版」): the per-prompt routing questions are gone; Jev will be
// asked about a new session's first prompt only, with questions built by that caller.
import type { HttpInit, HttpResponse } from 'claude-code'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

export type JevDeps = {
  key: string | undefined
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  now(): Promise<number>
}

/** One Jev request: the `state` text it reads, and the questions (choice / noul) it answers. */
export type JevRequest = { state: string; questions: Record<string, unknown> }

export type JevCall =
  | { ok: true; body: unknown; ms: number }
  | { ok: false; reason: 'no-key' | 'http' | 'bad-response' | 'network'; status?: number; ms: number }

/** POSTs one request and hands back the parsed body. Never throws; without a key it never fetches. */
export async function callJev(d: JevDeps, request: JevRequest): Promise<JevCall> {
  const t0 = await d.now()
  const ms = async () => (await d.now()) - t0
  const key = d.key
  if (!key) return { ok: false, reason: 'no-key', ms: 0 }
  try {
    const r = await d.fetch(JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: JEV_MODEL, state: request.state, questions: request.questions }),
    })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, ms: await ms() }
    try {
      return { ok: true, body: JSON.parse(r.text) as unknown, ms: await ms() }
    } catch {
      return { ok: false, reason: 'bad-response', status: r.status, ms: await ms() }
    }
  } catch {
    return { ok: false, reason: 'network', ms: await ms() }
  }
}
