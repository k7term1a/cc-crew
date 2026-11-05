import { describe, expect, test } from 'claude-code/testing'
import type { HttpInit, HttpResponse, SessionMessage } from 'claude-code'

import type { Tree } from '../types'
import { runCommand } from '../hooks/commands'
import { notionServer, projectName } from '../hooks/notion'
import { applyOptionOverrides, confirmDelete, deleteNote, dropReason, prepare, syncPull, syncPushAll, plainPreview, readOptions, startNote, summaryProvider } from '../hooks/notes'
import { addUsage, claudeDelta, fetchDelta, readUsage, shortCount, usageKey, usageLine } from '../hooks/usage'
import type { KV, Ports } from '../hooks/ports'
import { loadTree } from '../hooks/tree'

const ROOT = '/repo'

type Fake = {
  ports: Ports
  kv: KV
  jevCalls: unknown[]
  openaiCalls: number
  openaiBodies: string[]
  selected(): string | null
  options: Record<string, unknown>
  forkPrompts: string[]
  toasts: string[]
  logs: string[]
  asked: () => number
  lastAsk: () => { question: string; options: string[] } | null
  asks: () => { question: string; options: string[] }[]
  opened: () => number
  runLater(): Promise<void>
  tree(): Promise<Tree>
  setSession(id: string): void
}

/** A Ports with everything in memory; any request that is not OpenAI's is counted as Jev's, the fork echoes. */
/** A Notion database in memory, shared by fakes that stand for two computers. */
type FakeNotion = { rows: Record<string, unknown>[]; bodies: Map<string, string> }
const newNotion = (): FakeNotion => ({ rows: [], bodies: new Map() })

function fake(opts: { typesafeKey?: string; openaiKey?: string; askAnswer?: string | string[]; notion?: FakeNotion; machine?: string; remote?: string | null; messages?: SessionMessage[] } = {}): Fake {
  const mem = new Map<string, string>()
  const kv: KV = {
    get: async k => (mem.has(k) ? JSON.parse(mem.get(k)!) : undefined),
    set: async (k, v) => void mem.set(k, JSON.stringify(v)),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
  const jevCalls: unknown[] = []
  const forkPrompts: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const queue: (() => void)[] = []
  let session = 'S1'
  let asked = 0
  let lastAsk: { question: string; options: string[] } | null = null
  const asks: { question: string; options: string[] }[] = []
  const answers = Array.isArray(opts.askAnswer) ? [...opts.askAnswer] : null
  let openaiCalls = 0
  let opened = 0
  let selected: string | null = null
  const openaiBodies: string[] = []
  const options: Record<string, unknown> = {}
  let now = 1000
  const state = { lastTurnId: 't0' as string | null, pending: 0, unread: 0 }
  const messages: SessionMessage[] = [
    { role: 'user', text: 'refactor auth to session cookies', toolUses: [] },
    { role: 'assistant', text: 'Done; token rotation remains.', toolUses: [] },
    // slash-command records are user messages too; they must not count as the main line
    { role: 'user', text: '<local-command-caveat>The command below was run directly…</local-command-caveat>', toolUses: [] },
    { role: 'user', text: '<command-name>/sticky-note</command-name>\n<command-args>doctor</command-args>', toolUses: [] },
  ]
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const fetch = async (url: string, init?: HttpInit): Promise<HttpResponse> => {
    if (url.includes('openai')) {
      openaiCalls++
      openaiBodies.push(String(init?.body ?? ''))
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: '{"title":"OA","summary":"x"}' } }], usage: { total_tokens: 9 } }) }
    }
    const body = JSON.parse(String(init?.body ?? '{}'))
    jevCalls.push(body)
    return { status: 200, ok: true, headers: {}, text: '{}' }
  }
  const ports: Ports = {
    sessionId: async () => session,
    projectRoot: async () => ROOT,
    turns: async () => 7,
    messages: async () => opts.messages ?? messages,
    now: async () => ++now,
    later: fn => void queue.push(fn),
    sleep: () => new Promise<void>(() => {}),
    store: kv,
    fetch,
    fork: async prompt => {
      forkPrompts.push(prompt)
      return { isAnswered: true, text: `answer #${forkPrompts.length}`, usage }
    },
    complete: async () => ({ isAnswered: true, text: '{"title":"標題","summary":"一。二。三。"}', usage }),
    setOption: async (field, value) => ((options[field] = value), { ok: true }),
    place: async () => ({ remote: opts.remote === undefined ? 'git@github.com:me/proj.git' : opts.remote, machine: opts.machine ?? 'HOME' }),
    mcp: {
      tools: async () => (opts.notion ? ['mcp__srv__notion-fetch', 'mcp__srv__notion-create-pages'] : []),
      call: async (server, tool, args) => {
        const db = opts.notion
        if (!db || server !== 'srv') return { isError: true, content: [{ type: 'text', text: 'no server' }] }
        const text = (t: string) => ({ isError: false, content: [{ type: 'text', text: t }] })
        if (tool === 'notion-create-pages') {
          const page = (args.pages as { properties: Record<string, unknown>; content: string }[])[0]!
          const url = `https://app.notion.com/p/${String(db.rows.length + 1).padStart(32, 'a')}`
          db.rows.push({ ...page.properties, url })
          db.bodies.set(url, page.content)
          return text(`Created page ${url}`)
        }
        if (tool === 'notion-query-data-sources') {
          const filters = ((args.data as { filter: { filters: { property: string; value: { value: string } }[] } }).filter.filters)
          const project = filters.find(x => x.property === '專案')!.value.value
          return text(JSON.stringify({ results: db.rows.filter(r => r['專案'] === project), has_more: false }))
        }
        if (tool === 'notion-update-page') {
          const row = db.rows.find(r => String(r.url).replace(/-/g, '').endsWith(String(args.page_id)))
          if (!row) return { isError: true, content: [{ type: 'text', text: 'no page' }] }
          Object.assign(row, (args as { properties: Record<string, unknown> }).properties)
          return text('updated')
        }
        if (tool === 'notion-fetch') return text(JSON.stringify({ text: `<page>\n<content>\n${db.bodies.get(String(args.id)) ?? ''}\n</content>\n</page>` }))
        return { isError: true, content: [] }
      },
    },
    keys: { typesafe: async () => opts.typesafeKey, openai: async () => opts.openaiKey, report: async () => [] },
    ui: {
      log: t => void logs.push(t),
      toast: t => void toasts.push(t),
      ask: async (question, options) => {
        asked++
        lastAsk = { question, options: [...options] }
        asks.push(lastAsk)
        const a = answers ? answers.shift() : (opts.askAnswer as string | undefined)
        if (a === undefined) throw new Error('dismissed')
        return a
      },
      openPane: async () => void opened++,
      closePane: async () => {},
      isPaneOpen: async () => false,
      status: () => {},
    },
    state: {
      publishTree: async () => {},
      lastTurnId: async () => state.lastTurnId,
      addPending: async d => void (state.pending += d),
      addUnread: async d => void (state.unread += d),
      lastPromptUuid: async () => 'msg-uuid-1',
      setSelected: async id => void (selected = id),
      selected: async () => selected,
    },
  }
  return {
    ports,
    kv,
    jevCalls,
    get openaiCalls() {
      return openaiCalls
    },
    openaiBodies,
    selected: () => selected,
    options,
    forkPrompts,
    toasts,
    logs,
    asked: () => asked,
    lastAsk: () => lastAsk,
    asks: () => asks,
    opened: () => opened,
    runLater: async () => {
      while (queue.length) {
        queue.shift()!()
        // answerNote is async; let its awaits settle
        for (let i = 0; i < 200; i++) await Promise.resolve()
      }
    },
    tree: () => loadTree(kv, ROOT),
    setSession: id => void (session = id),
  }
}

const opts = readOptions({})

describe('/sn new (11/05: the way a note is made from the composer)', () => {
  test('makes a root note answered by the fork, toasts which one, and never asks Jev, even with a key', async () => {
    const f = fake({ typesafeKey: 'k' })
    expect(await runCommand(f.ports, opts, 'new 為什麼 TCP 要三次握手？')).toEqual({})
    expect(f.toasts).toContain(dropReason('為什麼 TCP 要三次握手？'))
    await f.runLater()
    const t = await f.tree()
    expect(t.roots).toHaveLength(1)
    expect(t.nodes[t.roots[0]!]).toMatchObject({ question: '為什麼 TCP 要三次握手？', answer: 'answer #1', answeredBy: 'claude-fork', route: { source: 'manual' }, tags: [] })
    expect(f.jevCalls).toHaveLength(0)
    expect(f.asked()).toBe(0)
    expect(await runCommand(f.ports, opts, 'new')).toMatchObject({ text: expect.stringContaining('用法') })
  })

  test('/sn back: the next follow-up starts a new topic', async () => {
    const f = fake()
    const a = await startNote(f.ports, opts, { question: 'q', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    expect((await f.tree()).activeThread).toEqual({ S1: a })
    await runCommand(f.ports, opts, 'back')
    expect((await f.tree()).activeThread).toEqual({ S1: null })
  })
})

describe('notes end to end (stubbed fork and complete)', () => {
  const note = (f: Fake, question: string, attach: 'root' | 'followup') =>
    startNote(f.ports, opts, { question, attach: { kind: attach }, answerer: 'fork', route: { label: 'sidebar_knowledge', confidence: 0.9, source: 'jev' } })

  test('a note is stored at once and answered in the background; the answer is logged (M1)', async () => {
    const f = fake()
    const id = await note(f, 'What is TCP backpressure?', 'root')
    expect((await f.tree()).nodes[id]?.answer).toBe('')
    expect((await f.tree()).nodes[id]?.anchor).toMatchObject({ sessionId: 'S1', turnId: 't0', messageId: 'msg-uuid-1', mainSnippet: 'refactor auth to session cookies' })
    await f.runLater()
    expect((await f.tree()).nodes[id]).toMatchObject({ answer: 'answer #1', answeredBy: 'claude-fork', title: '標題', summary: '一。二。三。' })
    expect(f.toasts).toContain('cc-sticky-note 標題')
    expect(f.opened()).toBe(1) // autoOpenPane is on by default
    expect(f.logs).toContain('cc-sticky-note 標題：一。二。三。　/sn 看完整答案')
    expect([...f.toasts, ...f.logs].join('')).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('three follow-ups hang off the same thread and carry its history to the fork', async () => {
    const f = fake()
    const r = await note(f, 'Q-root', 'root')
    await f.runLater()
    const a = await note(f, 'Q-1', 'followup')
    await f.runLater()
    const b = await note(f, 'Q-2', 'followup')
    await f.runLater()
    const t = await f.tree()
    expect(t.roots).toEqual([r])
    expect(t.nodes[b]?.parentId).toBe(a)
    expect(t.nodes[a]?.parentId).toBe(r)
    expect(f.forkPrompts[2]).toContain('Q1: Q-root\nA1: answer #1\nQ2: Q-1\nA2: answer #2')
  })

  test('two sessions share one tree but keep their own activeThread', async () => {
    const f = fake()
    const a = await note(f, 'from S1', 'root')
    f.setSession('S2')
    const b = await note(f, 'from S2', 'followup')
    const t = await f.tree()
    expect(t.nodes[b]?.parentId).toBeNull()
    expect(t.activeThread).toEqual({ S1: a, S2: b })
  })
})

describe('summary provider', () => {
  test('/sn provider writes the plugin setting and takes effect at once', async () => {
    const f = fake()
    const o = readOptions({})
    await runCommand(f.ports, o, 'provider openai')
    expect(f.options.summaryProvider).toBe('openai')
    expect(o.summaryProvider).toBe('openai')
    expect(await runCommand(f.ports, o, 'provider')).toMatchObject({ text: expect.stringContaining('OpenAI') })
    expect(await runCommand(f.ports, o, 'provider gemini')).toMatchObject({ text: expect.stringContaining('用法') })
  })

  test('OpenAI with openaiContextMode=redacted gets the project content stripped', async () => {
    const f = fake({ openaiKey: 'k' })
    const o = { ...readOptions({ summaryProvider: 'openai' }) }
    await summaryProvider(f.ports, o).summarize('node-title-summary', { system: 's', prompt: '看 src/auth/session.ts\n```ts\nconst SECRET = 1\n```', maxTokens: 10, hasProjectContent: true })
    const body = f.openaiBodies.at(-1)!
    expect(body).not.toContain('src/auth/session.ts')
    expect(body).not.toContain('const SECRET')
    expect(body).toContain('[redacted]')
  })

  test('openai without a key falls back to claude, with one toast', async () => {
    const f = fake()
    const p = summaryProvider(f.ports, readOptions({ summaryProvider: 'openai' }))
    const input = { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false }
    expect(await p.summarize('node-title-summary', input)).toMatchObject({ ok: true, provider: 'claude' })
    await p.summarize('node-title-summary', input)
    expect(f.toasts.filter(t => t.includes('OPENAI_API_KEY'))).toHaveLength(1)
  })

  test('openai with a key sends reasoning_effort from the config', async () => {
    let body: Record<string, unknown> = {}
    const f = fake({ openaiKey: 'k' })
    const fetch = f.ports.fetch
    f.ports.fetch = async (url, init) => {
      if (url.includes('openai')) body = JSON.parse(String(init?.body))
      return fetch(url, init)
    }
    const p = summaryProvider(f.ports, readOptions({ summaryProvider: 'openai', openaiReasoningEffort: 'low' }))
    expect(await p.summarize('tag-name', { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false })).toMatchObject({ ok: true, provider: 'openai' })
    expect(body.reasoning_effort).toBe('low')
    const q = summaryProvider(f.ports, readOptions({ summaryProvider: 'openai', openaiReasoningEffort: 'none' }))
    await q.summarize('tag-name', { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false })
    expect('reasoning_effort' in body).toBe(false)
  })

  test('claudeModel and claudeEffort reach $.model.complete', async () => {
    const f = fake()
    let seen: unknown = null
    f.ports.complete = async req => {
      seen = req
      return { isAnswered: true, text: 'x', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    }
    await summaryProvider(f.ports, readOptions({ claudeModel: 'sonnet', claudeEffort: 'medium' })).summarize('tag-name', { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false })
    expect(seen).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })
})

describe('status line: what the mod spent today (no emoji, no plugin name: Desktop draws it)', () => {
  test('Jev calls and Claude tokens; OpenAI once used; the pending answers', () => {
    const u = { jev: 12, claude: 34567, claudeCacheRead: 900000, openai: 0 }
    expect(usageLine(u, 0)).toBe('今日 Jev 12 次 · Claude 35k')
    expect(usageLine({ ...u, openai: 1234 }, 2)).toBe('今日 Jev 12 次 · Claude 35k · OpenAI 1.2k · 2 則回答中')
    expect(usageLine(u, 1)).not.toMatch(/\p{Extended_Pictographic}|cc-sticky/u)
    expect([shortCount(999), shortCount(1000), shortCount(9949), shortCount(10500)]).toEqual(['999', '1.0k', '9.9k', '11k'])
  })

  test('counted per local day: Jev by URL, OpenAI by total_tokens, Claude without cache reads', async () => {
    const f = fake()
    const day = new Date(2026, 9, 14, 23, 59)
    expect(usageKey(day)).toBe('usage:2026-10-14')
    await addUsage(f.kv, day, fetchDelta('https://api.typesafe.ai/v1/systemone', null))
    await addUsage(f.kv, day, fetchDelta('https://api.openai.com/v1/chat/completions', { status: 200, ok: true, headers: {}, text: '{"usage":{"total_tokens":150}}' }))
    await addUsage(f.kv, day, claudeDelta({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 40000 }))
    expect(await readUsage(f.kv, day)).toEqual({ jev: 1, claude: 35, claudeCacheRead: 40000, openai: 150 })
    expect(await readUsage(f.kv, new Date(2026, 9, 15, 0, 1))).toEqual({ jev: 0, claude: 0, claudeCacheRead: 0, openai: 0 })
    expect(fetchDelta('https://example.com', null)).toEqual({})
  })
})

describe('the /sn new toast and the log preview', () => {
  test('the toast names the note', () => {
    expect(dropReason('CRDT 是什麼？')).toBe('cc-sticky-note：便利貼「CRDT 是什麼？」')
  })

  test('the log preview is one plain line, no Markdown marks', () => {
    const md = [
      '# CRDT（Conflict-free）',
      'CRDT 是一種**無衝突**資料型別。',
      '## 核心特性',
      '- **無衝突**：多個副本',
      '| 型別 | 用途 |',
      '|------|------|',
      '| 計數器 | 遞增 |',
    ].join('\n')
    const p = plainPreview(md, 200)
    expect(p).not.toMatch(/[#*|]/)
    expect(p.startsWith('CRDT（Conflict-free） CRDT 是一種 無衝突 資料型別。')).toBe(true)
    expect([...plainPreview(md, 10)]).toHaveLength(11) // 10 + …
  })

  test('the toast quotes at most 24 characters of the question', () => {
    const long = '為什麼分散式系統裡的 CRDT 可以不靠中央伺服器就讓所有副本最後一致？'
    expect(dropReason(long)).toBe(`cc-sticky-note：便利貼「${[...long].slice(0, 24).join('')}…」`)
  })
})

describe('Notion sync: finding the connector', () => {
  test('the server is the part of a notion-fetch tool name between mcp__ and __', () => {
    expect(notionServer(['mcp__x__other', 'mcp__c20941de-f53b-4587-a934-6b80ec468eea__notion-fetch'])).toBe('c20941de-f53b-4587-a934-6b80ec468eea')
    expect(notionServer(['mcp__x__other'])).toBeNull()
  })

  test('/sn notion takes a collection:// URL into the setting; test needs one first', async () => {
    const f = fake()
    const o = readOptions({})
    expect(await runCommand(f.ports, o, 'notion test')).toMatchObject({ text: expect.stringContaining('還沒設定') })
    expect(await runCommand(f.ports, o, 'notion https://example.com')).toMatchObject({ text: expect.stringContaining('用法') })
    await runCommand(f.ports, o, 'notion collection://8e59b59f-189a-443c-9c5b-083b5766ac70')
    expect(f.options.notionDataSource).toBe('collection://8e59b59f-189a-443c-9c5b-083b5766ac70')
    expect(await runCommand(f.ports, o, 'notion test')).toMatchObject({ text: expect.stringContaining('找不到 Notion connector') })
  })
})

describe('per-machine settings (/sn provider, /sn notion, the settings card)', () => {
  test('the store\'s values go over the plugin settings at session start; the removed ones are left unread', async () => {
    const f = fake()
    await f.kv.set('option:summaryProvider', 'openai')
    await f.kv.set('option:notionDataSource', 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70')
    await f.kv.set('option:autoOpenPane', false)
    await f.kv.set('option:notionSync', false)
    await f.kv.set('option:junk', 'x')
    // kept from before 11/05: still in the store, read by nothing
    await f.kv.set('option:routing', true)
    await f.kv.set('option:digestEvery', 0)
    const o = readOptions({ summaryProvider: 'claude' })
    await applyOptionOverrides(f.kv, o)
    expect(o).toEqual({ ...readOptions({}), summaryProvider: 'openai', notionDataSource: 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70', autoOpenPane: false, notionSync: false })
    expect(await f.kv.get('option:routing')).toBe(true)
  })
})

describe('the old bookmarks (10/14)', () => {
  test('the old 在主線回答 bookmarks go at session start; answered notes stay', async () => {
    const f = fake()
    const keep = await startNote(f.ports, opts, { question: 'q', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await f.runLater()
    const at = 5
    await f.kv.set('node:' + ROOT + ':bm', {
      id: 'bm', parentId: null, outlineId: null, anchor: { sessionId: 'S1', turnId: null, messageId: null, at, mainSnippet: '' },
      question: '我們為什麼用 X？', answer: '', answeredBy: 'claude', title: 'X', summary: null, tags: [],
      route: { label: 'project_question', confidence: 0.9, source: 'jev' }, promotedAt: at, promotedIn: 'S1', children: [],
    })
    expect(Object.keys((await f.tree()).nodes).sort()).toEqual(['bm', keep].sort())
    await prepare(f.ports)
    expect(Object.keys((await f.tree()).nodes)).toEqual([keep])
  })
})

describe('Notion sync between computers', () => {
  test('a project is named by its git remote, the same on every computer', () => {
    expect(projectName('git@github.com:K7term1a/cc-sticky-notes.git', 'c:/x')).toBe('github.com/k7term1a/cc-sticky-notes')
    expect(projectName('https://github.com/k7term1a/cc-sticky-notes.git', '/Users/kaichi/cc-sticky-notes')).toBe('github.com/k7term1a/cc-sticky-notes')
    expect(projectName(null, 'c:/Users/kay13/desktop/proj')).toBe('proj')
  })

  test('home answers and pushes a thread; the laptop pulls it in once, follow-up under its parent', async () => {
    const notion = newNotion()
    const o = { ...readOptions({}), notionDataSource: 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70' }
    const home = fake({ notion, machine: 'HOME' })
    const root = await startNote(home.ports, o, { question: 'CRDT 是什麼？', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await home.runLater()
    const child = await startNote(home.ports, o, { question: '衝突怎麼合併？', attach: { kind: 'under', parentId: root }, answerer: 'fork', route: { label: 'followup', confidence: 1, source: 'manual' } })
    await home.runLater()
    expect(notion.rows.map(r => [r['Note ID'], r['上一層'], r['專案'], r['電腦']])).toEqual([
      [root, '', 'github.com/me/proj', 'HOME'],
      [child, root, 'github.com/me/proj', 'HOME'],
    ])
    // a second push of the same notes writes nothing
    expect(await syncPushAll(home.ports, o)).toEqual({ pushed: 0, failed: 0 })

    const laptop = fake({ notion, machine: 'MAC' })
    expect(await syncPull(laptop.ports, o)).toMatch(/^下載 2 張/)
    const t = await laptop.tree()
    expect(t.nodes[child]?.parentId).toBe(root)
    expect(t.nodes[root]?.answer).toBe('answer #1')
    expect(t.nodes[root]?.title).toBe('標題')
    expect(laptop.toasts.some(x => x.includes('同步了 2 張'))).toBe(true)
    // pulled again: nothing new, and the pulled notes are not pushed back
    expect(await syncPull(laptop.ports, o)).toMatch(/^下載 0 張/)
    expect(await syncPushAll(laptop.ports, o)).toEqual({ pushed: 0, failed: 0 })
    expect(notion.rows).toHaveLength(2)
    // another project's rows stay out
    const other = fake({ notion, machine: 'MAC', remote: 'git@github.com:me/other.git' })
    expect(await syncPull(other.ports, o)).toMatch(/^下載 0 張/)
  })

  test('without a data source nothing is sent', async () => {
    const notion = newNotion()
    const home = fake({ notion })
    await startNote(home.ports, opts, { question: 'q', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await home.runLater()
    expect(notion.rows).toHaveLength(0)
  })
})

describe('deleting a note (this computer only)', () => {
  test('✕ asks first; 刪除 removes the note and its follow-ups; 取消 keeps them', async () => {
    const f = fake({ askAnswer: ['取消', '刪除'] })
    const root = await startNote(f.ports, opts, { question: 'q', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await f.runLater()
    const child = await startNote(f.ports, opts, { question: 'q2', attach: { kind: 'under', parentId: root }, answerer: 'fork', route: { label: 'followup', confidence: 1, source: 'manual' } })
    await f.runLater()
    expect(await confirmDelete(f.ports, opts, root)).toBe(0)
    expect(f.lastAsk()?.question).toContain('和它底下 1 則追問')
    expect(await confirmDelete(f.ports, opts, root)).toBe(2)
    const t = await f.tree()
    expect(t.nodes[root]).toBeUndefined()
    expect(t.nodes[child]).toBeUndefined()
  })

  test('a deleted note\'s Notion row is marked 不同步: other computers stop pulling it, this one never pulls it back', async () => {
    const notion = newNotion()
    const o = { ...readOptions({}), notionDataSource: 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70' }
    const home = fake({ notion, machine: 'HOME' })
    const id = await startNote(home.ports, o, { question: 'q', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await home.runLater()
    expect(await deleteNote(home.ports, o, id)).toBe(1)
    await home.runLater()
    expect(notion.rows[0]!['不同步']).toBe('__YES__')
    expect(await syncPull(home.ports, o)).toMatch(/^下載 0 張/)
    const laptop = fake({ notion, machine: 'MAC' })
    expect(await syncPull(laptop.ports, o)).toMatch(/^下載 0 張/)
  })
})
