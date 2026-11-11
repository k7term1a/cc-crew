// Session roles (PLAN.md「11/05 改版」): the first prompt's classification and its dialogs,
// a fork tagged sub, the brief once per role, the skill listing, the status line, /sn tag.
// Through the register harness: the store, the session and the dialogs are this file's.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { DOCS_OPTIONS, dropSkills, fingerprintOf, ORGANIZE_DOCS, parseDeckSkills, parseDocs, roleKey, type RoleEntry } from '../hooks/roles'

const ROOT = '/proj'
const KEY = (id: string) => roleKey(ROOT, id)

/** An answer the dialog gets: a label (or text typed under "Other"), dismissed, or one that comes late. */
type Answer = string | { dismiss: true } | { lateMs: number; answer: string }

type World = {
  mem: Map<string, unknown>
  get(key: string): RoleEntry | undefined
  asks: { question: string; header: string; options: string[] }[]
  answers: Answer[]
  /** Jev's answer: a kind, or an HTTP status for a failure. */
  jev: { kind: string } | { status: number }
  jevBodies: { state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> }[]
  invalidated: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  sent: { text: string; context?: readonly string[] }[]
  session: { id: string; messages: SessionMessage[] }
  clock: ReturnType<typeof mock.clock>
  /** The project's files, by absolute path. */
  files: Map<string, string>
}

type AskCall = { questions: { question: string; header: string; options: { label: string }[] }[] }

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })

function world(on: On, seed: Record<string, unknown> = {}, cfg: { key?: boolean } = {}): World {
  const mem = new Map<string, unknown>(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  const w: World = {
    mem,
    get: key => mem.get(KEY(key)) as RoleEntry | undefined,
    asks: [],
    answers: [],
    jev: { kind: 'other' },
    jevBodies: [],
    invalidated: [],
    statuses: [],
    toasts: [],
    sent: [],
    session: { id: 'S1', messages: [] },
    clock: mock.clock(on, { now: Date.UTC(2026, 10, 5, 6, 30) }),
    files: new Map(),
  }
  // the engine hands paths resolved (C:\proj\…); the fake keeps them as /proj/…
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
  const under = (path: string) => norm(path).replace(/\/+$/, '') + '/'
  on('fs.exists', ($, e) => ({ value: [...w.files.keys()].some(k => k === norm(e.path) || k.startsWith(under(e.path))) }) as never)
  on('fs.list', ($, e) => ({ value: [...new Set([...w.files.keys()].filter(k => k.startsWith(under(e.path))).map(k => k.slice(under(e.path).length).split('/')[0]!))].map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }) as never)
  on('fs.write', ($, e) => (w.files.set(norm(e.path), e.text), { value: undefined }) as never)
  on('store.get', ($, e) => ({ value: mem.has(e.key) ? JSON.parse(JSON.stringify(mem.get(e.key))) : undefined }) as never)
  on('store.set', ($, e) => (mem.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }) as never)
  on('store.delete', ($, e) => (mem.delete(e.key), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...mem.keys()] }) as never)
  on('session.id', () => ({ value: w.session.id }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({ value: w.session.messages }) as never)
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('env.get', ($, e) => ({ value: cfg.key !== false && e.name === 'TYPESAFE_API_KEY' ? 'test-key' : undefined }) as never)
  on('fs.read', () => {
    throw new Error('no file')
  })
  on('http.fetch', ($, e) => {
    w.jevBodies.push(JSON.parse(String(e.init?.body ?? '{}')))
    const j = w.jev
    if ('status' in j) return { value: { status: j.status, ok: false, headers: {}, text: '{}' } } as never
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { session_kind: { type: 'choice', choice: j.kind, confidence: 0.9 } } }) } } as never
  })
  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }) as never)
  on('ui.invalidate', ($, e) => (w.invalidated.push(e.event), { value: undefined }) as never)
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('prompt.attachment', ($, e) => ({ text: e.text }) as never)
  on('prompt.submit', ($, e) => (w.sent.push({ text: e.text, context: e.context }), { text: e.text, context: e.context }) as never)
  // $.ui.ask is a tool.call of AskUserQuestion: every dialog must offer two options at least
  // (the hook's own type for one built-in tool is deeper than tsc follows here)
  const onAsk = on as unknown as (event: 'tool.call', matcher: { tool: 'AskUserQuestion' }, fn: ($: unknown, e: AskCall) => Promise<unknown>) => void
  onAsk('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const q = e.questions[0]!
    const options = q.options.map(o => o.label)
    w.asks.push({ question: q.question, header: q.header, options })
    if (options.length < 2) throw new Error(`a dialog with ${options.length} option(s): ${q.question}`)
    const a = w.answers.shift()
    if (a === undefined) throw new Error(`no answer planned for: ${q.question}`)
    if (typeof a === 'object' && 'dismiss' in a) return { deny: 'dismissed' }
    if (typeof a === 'object') await w.clock.sleep(a.lateMs)
    const answer = typeof a === 'string' ? a : a.answer
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  return w
}

const KICKOFF = `專案：把 auth 改成 session cookie
目標：
  - 移除 JWT
  - 加上 CSRF 防護
背景：${'這是一段很長的專案背景說明。'.repeat(20)}`
const FIRST20 = [...KICKOFF.replace(/\s+/g, ' ').trim()].slice(0, 20).join('')
const typed = (text: string) => ({ text, origin: { kind: 'composer' } }) as never
/** A main as the parent dialog offers it: `<name>（MM-DD HH:mm 標記）`, local time. */
function label(name: string, ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${name}（${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 標記）`
}
const mainEntry = (over: Partial<RoleEntry> = {}): RoleEntry => ({
  role: 'main',
  parentId: null,
  taggedAt: Date.UTC(2026, 10, 4, 1, 2),
  name: 'auth 改版',
  docs: { record: 'RECORD.md', progress: 'progress.jsonl', evidence: 'evidence/' },
  fingerprint: fingerprintOf(KICKOFF),
  briefed: true,
  ...over,
})

describe('first prompt', () => {
  test('kickoff: one Jev call, three dialogs, a main with name, docs and fingerprint; the brief rides that prompt', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    w.jev = { kind: 'kickoff' }
    w.answers = ['要，標成 main', FIRST20, DOCS_OPTIONS[1]]
    const r = await $.prompt.submit(typed(KICKOFF))
    expect(r).toMatchObject({ text: KICKOFF })
    expect(w.jevBodies).toHaveLength(1)
    const q = w.jevBodies[0]!.questions.session_kind!
    expect(q.type).toBe('choice')
    expect(Object.keys(q.criteria)).toEqual(['kickoff', 'synthesis', 'other'])
    expect(w.jevBodies[0]!.state).toContain('移除 JWT')
    expect(w.asks.map(a => a.options)).toEqual([['要，標成 main', '不用'], [FIRST20, 'proj'], [...DOCS_OPTIONS]])
    expect(w.asks[0]!.question).toContain('fork 出來的會自動標成 sub')
    expect(w.get('S1')).toMatchObject({ role: 'main', parentId: null, name: FIRST20, docs: { record: 'RECORD.md', progress: 'progress.jsonl', evidence: 'evidence/', external: 'external/' }, fingerprint: fingerprintOf(KICKOFF), briefed: true })
    expect(fingerprintOf(KICKOFF)).toHaveLength(200)
    expect(fingerprintOf(KICKOFF)).not.toContain('\n')
    // the brief went with this same prompt
    const ctx = w.sent[0]!.context ?? []
    expect(ctx).toHaveLength(1)
    expect(ctx[0]).toContain(`main session「${FIRST20}」`)
    expect(ctx[0]).toContain('RECORD.md 只由 main 寫')
    expect(ctx[0]).toContain('SendMessage')
    // nothing was sent yet: the listing is asked again; the status line shows the role
    expect(w.invalidated).toEqual(['prompt.attachment'])
    expect(w.statuses.at(-1)).toBe(`main「${FIRST20}」`)
    // the next prompt: no Jev, no dialog, no brief
    w.session.messages = [user(KICKOFF), reply('好')]
    await $.prompt.submit(typed('開始吧'))
    expect(w.jevBodies).toHaveLength(1)
    expect(w.asks).toHaveLength(3)
    expect(w.sent[1]!.context ?? []).toEqual([])
  })

  test('kickoff: a name and paths typed under "Other"; anything that is not three paths falls back to the first', async ($, on) => {
    const w = world(on)
    w.jev = { kind: 'kickoff' }
    w.answers = ['要，標成 main', '  我的專案  ', 'notes/R.md, notes/p.jsonl , notes/ev/']
    await $.prompt.submit(typed(KICKOFF))
    expect(w.get('S1')).toMatchObject({ name: '我的專案', docs: { record: 'notes/R.md', progress: 'notes/p.jsonl', evidence: 'notes/ev/' } })
    expect(parseDocs('就放根目錄')).toEqual({ record: 'docs/RECORD.md', progress: 'docs/progress.jsonl', evidence: 'docs/evidence/', external: 'docs/external/' })
    // three paths typed: the external folder beside the record
    expect(w.get('S1')?.docs).toMatchObject({ external: 'notes/external/' })
  })

  test('kickoff declined, or a dialog closed on the way: no role, the prompt goes on unchanged', async ($, on) => {
    const w = world(on)
    w.jev = { kind: 'kickoff' }
    w.answers = ['不用']
    await $.prompt.submit(typed(KICKOFF))
    expect(w.get('S1')).toBeUndefined()
    expect(w.sent[0]).toMatchObject({ text: KICKOFF })
    expect(w.sent[0]!.context ?? []).toEqual([])
    w.session.id = 'S2'
    w.answers = ['要，標成 main', { dismiss: true }]
    await $.prompt.submit(typed(KICKOFF))
    expect(w.get('S2')).toBeUndefined()
    expect(w.sent[1]).toMatchObject({ text: KICKOFF })
    expect(w.invalidated).toEqual([])
  })

  test('synthesis: pick one of the newest three mains (name and when tagged), or 不用', async ($, on) => {
    const w = world(on, {
      [KEY('M1')]: mainEntry({ name: '最舊', taggedAt: Date.UTC(2026, 10, 1) }),
      [KEY('M2')]: mainEntry({ name: '第二', taggedAt: Date.UTC(2026, 10, 2) }),
      [KEY('M3')]: mainEntry({ name: '第三', taggedAt: Date.UTC(2026, 10, 3) }),
      [KEY('M4')]: mainEntry({ name: '最新', taggedAt: Date.UTC(2026, 10, 4, 1, 2) }),
      // another project's main is not offered
      [roleKey('/other', 'X1')]: mainEntry({ name: '別的專案' }),
    })
    w.jev = { kind: 'synthesis' }
    w.answers = ['不用']
    await $.prompt.submit(typed('幫我把目前的進度整理成簡報'))
    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]!.question).toBe('這看起來是統整需求。要標成統整 session 嗎？選它屬於哪一個 main：')
    expect(w.asks[0]!.options).toEqual([label('最新', Date.UTC(2026, 10, 4, 1, 2)), label('第三', Date.UTC(2026, 10, 3)), label('第二', Date.UTC(2026, 10, 2)), '不用'])
    expect(w.get('S1')).toBeUndefined()
    expect(w.sent[0]!.context ?? []).toEqual([])
  })

  test('synthesis picked: a 統整 session of that main; its brief names the main and the files', async ($, on) => {
    const w = world(on, { [KEY('M1')]: mainEntry({ docs: { record: 'R.md', progress: 'p.jsonl', evidence: 'ev/' } }) })
    w.jev = { kind: 'synthesis' }
    const m1 = label('auth 改版', Date.UTC(2026, 10, 4, 1, 2))
    w.answers = [m1]
    await $.prompt.submit(typed('幫我把目前的進度整理成簡報'))
    expect(w.asks[0]!.options).toEqual([m1, '不用'])
    expect(w.get('S1')).toMatchObject({ role: 'synthesis', parentId: 'M1', briefed: true })
    const brief = w.sent[0]!.context?.[0] ?? ''
    expect(brief).toContain('統整 session，屬於 main「auth 改版」（id M1）')
    expect(brief).toContain('只讀 R.md、p.jsonl、ev/')
    expect(brief).toContain('文件裡沒有')
    expect(brief).toContain('GAPS.md')
    expect(w.statuses.at(-1)).toBe('統整 ← auth 改版')
  })

  test('synthesis with no main in the project: no dialog', async ($, on) => {
    const w = world(on)
    w.jev = { kind: 'synthesis' }
    await $.prompt.submit(typed('幫我把目前的進度整理成簡報'))
    expect(w.jevBodies).toHaveLength(1)
    expect(w.asks).toHaveLength(0)
    expect(w.get('S1')).toBeUndefined()
  })

  test('other, no Jev key, a Jev failure: no dialog, the prompt unchanged', async ($, on) => {
    const w = world(on)
    w.jev = { kind: 'other' }
    await $.prompt.submit(typed(KICKOFF))
    w.jev = { status: 500 }
    w.session.id = 'S2'
    await $.prompt.submit(typed(KICKOFF))
    expect(w.jevBodies).toHaveLength(2)
    expect(w.asks).toHaveLength(0)
    expect(w.sent.map(s => [s.text, s.context ?? []])).toEqual([
      [KICKOFF, []],
      [KICKOFF, []],
    ])
    expect(w.mem.size).toBe(1) // only the day's usage count
  })

  test('no Jev key: Jev is never called', async ($, on) => {
    const w = world(on, {}, { key: false })
    w.jev = { kind: 'kickoff' }
    await $.prompt.submit(typed(KICKOFF))
    expect(w.jevBodies).toHaveLength(0)
    expect(w.asks).toHaveLength(0)
    expect(w.sent[0]).toMatchObject({ text: KICKOFF })
  })

  test('only a new session, a typed prompt, not a slash command', async ($, on) => {
    const w = world(on)
    w.jev = { kind: 'kickoff' }
    await $.prompt.submit({ text: '/sn tag', origin: { kind: 'composer' } } as never)
    await $.prompt.submit({ text: KICKOFF, origin: { kind: 'peer' } } as never)
    w.session.messages = [user('hi'), reply('hello')]
    await $.prompt.submit(typed(KICKOFF))
    expect(w.jevBodies).toHaveLength(0)
    expect(w.asks).toHaveLength(0)
  })

  test('a dialog left unanswered for 60 s: the prompt goes on untagged', async ($, on) => {
    const w = world(on)
    w.jev = { kind: 'kickoff' }
    w.answers = [{ lateMs: 120_000, answer: '要，標成 main' }]
    const pending = $.prompt.submit(typed(KICKOFF))
    await w.clock.advance(59_000)
    expect(w.sent).toHaveLength(0)
    await w.clock.advance(1_000)
    expect(await pending).toMatchObject({ text: KICKOFF })
    expect(w.sent[0]!.context ?? []).toEqual([])
    expect(w.get('S1')).toBeUndefined()
    expect(w.toasts.some(t => t.includes('60 秒沒有回應'))).toBe(true)
    // the late answer changes nothing
    await w.clock.advance(60_000)
    expect(w.get('S1')).toBeUndefined()
  })
})

describe('fork → sub, and the brief', () => {
  test('a session that starts holding a main\'s first prompt under another id is its sub; the brief goes once, with a peer\'s message', async ($, on) => {
    const w = world(on, { [KEY('M1')]: mainEntry() })
    w.session = { id: 'F1', messages: [user('<local-command-caveat>x</local-command-caveat>'), user(KICKOFF), reply('收到'), user('再來')] }
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    expect(w.get('F1')).toMatchObject({ role: 'sub', parentId: 'M1', briefed: false })
    expect(w.invalidated).toEqual([]) // it holds replies: the listing is never asked again
    expect(w.statuses.at(-1)).toBe('sub ← auth 改版')
    // main's message arrives: it carries the sub's rules, once
    await $.prompt.submit({ text: '請實作 CSRF', origin: { kind: 'peer' } } as never)
    const brief = w.sent[0]!.context?.[0] ?? ''
    expect(brief).toContain('main「auth 改版」（id M1）的 sub session')
    expect(brief).toContain('progress.jsonl（一行一個 JSON 物件）')
    expect(brief).toContain('不要改 RECORD.md')
    expect(w.get('F1')).toMatchObject({ briefed: true })
    await $.prompt.submit({ text: '下一步', origin: { kind: 'peer' } } as never)
    expect(w.sent[1]!.context ?? []).toEqual([])
    expect(w.jevBodies).toHaveLength(0)
  })

  test('not tagged: the main itself, a text that does not match, a session cleared before', async ($, on) => {
    const w = world(on, { [KEY('M1')]: mainEntry({ briefed: true }), 'role-none:/proj:C1': { at: 1 } })
    w.session = { id: 'M1', messages: [user(KICKOFF), reply('收到')] }
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    expect(w.get('M1')).toMatchObject({ role: 'main' })
    w.session = { id: 'O1', messages: [user('別的開頭'), reply('好')] }
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    expect(w.get('O1')).toBeUndefined()
    w.session = { id: 'C1', messages: [user(KICKOFF), reply('收到')] }
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    expect(w.get('C1')).toBeUndefined()
    // a new session: no messages, nothing to compare
    w.session = { id: 'N1', messages: [] }
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    expect(w.get('N1')).toBeUndefined()
  })

  test('a new session whose own first prompt reads like a main\'s and stays untagged is not taken for a fork later', async ($, on) => {
    const w = world(on, { [KEY('M1')]: mainEntry() })
    w.session = { id: 'S2', messages: [] }
    w.jev = { kind: 'kickoff' }
    w.answers = ['不用']
    await $.prompt.submit(typed(KICKOFF))
    w.session.messages = [user(KICKOFF), reply('好')]
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    expect(w.get('S2')).toBeUndefined()
  })
})

describe('the skill listing', () => {
  const LISTING = [
    'The following skills are available:',
    '- pdf: Use this skill for PDFs.',
    '- research-report-writing: 撰寫研究報告。',
    '  第二行說明。',
    '- anthropic-skills:pptx: Use this skill any time a .pptx file is involved: decks.',
    '- anthropic-skills:xlsx: spreadsheets.',
    '- anthropic-skills:docs: docs.',
  ].join('\n')
  const KEPT = ['The following skills are available:', '- pdf: Use this skill for PDFs.', '- anthropic-skills:xlsx: spreadsheets.'].join('\n')

  test('entries run to the next `- name:` line; names may hold a colon', () => {
    const r = dropSkills(LISTING, parseDeckSkills(undefined))
    expect(r.text).toBe(KEPT)
    expect(r.removed).toEqual(['research-report-writing', 'anthropic-skills:pptx', 'anthropic-skills:docs'])
    expect(parseDeckSkills(' a, b ，c ,')).toEqual(['a', 'b', 'c'])
    expect(parseDeckSkills('')).toHaveLength(5)
  })

  for (const [who, entry, kept] of [
    ['untagged', undefined, false],
    ['main', mainEntry(), false],
    ['sub', { role: 'sub', parentId: 'M1', taggedAt: 1, briefed: true }, false],
    ['統整', { role: 'synthesis', parentId: 'M1', taggedAt: 1, briefed: true }, true],
  ] as const) {
    test(`${who}: the deck skills are ${kept ? 'kept' : 'dropped'}`, async ($, on) => {
      world(on, entry === undefined ? { [KEY('M1')]: mainEntry() } : { [KEY('M1')]: mainEntry(), [KEY('S1')]: entry })
      const r = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
      expect(r.text).toBe(kept ? LISTING : KEPT)
    })
  }

  test('the plugin option deckSkills names the list', { options: { deckSkills: 'pdf' } }, async ($, on) => {
    world(on)
    const r = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    expect(r.text).not.toContain('- pdf:')
    expect(r.text).toContain('research-report-writing')
  })
})

describe('/sn tag', () => {
  test('main before the first prompt: name and docs; the first prompt then gives the fingerprint and carries the brief', async ($, on) => {
    const w = world(on)
    w.answers = ['main', 'proj', DOCS_OPTIONS[0]]
    const r = await $.command.run({ command: 'sn', args: 'tag' } as never)
    expect(r).toMatchObject({ text: expect.stringContaining('這個 session 標成 main「proj」') })
    expect(w.asks.map(a => a.options)).toEqual([['main', 'sub', '統整', '清除'], ['proj', '取消'], [...DOCS_OPTIONS]])
    expect(w.get('S1')).toMatchObject({ role: 'main', name: 'proj', docs: { record: 'docs/RECORD.md', external: 'docs/external/' }, briefed: false })
    expect(w.get('S1')?.fingerprint).toBeUndefined()
    expect(w.invalidated).toEqual(['prompt.attachment'])
    expect(w.statuses.at(-1)).toBe('main「proj」')
    w.jev = { kind: 'kickoff' }
    await $.prompt.submit(typed(KICKOFF))
    expect(w.jevBodies).toHaveLength(0) // it has a role: no classification
    expect(w.sent[0]!.context?.[0]).toContain('main session「proj」')
    expect(w.get('S1')).toMatchObject({ fingerprint: fingerprintOf(KICKOFF), briefed: true })
  })

  test('main later in a conversation: the fingerprint is its first user message; the listing is not asked again', async ($, on) => {
    const w = world(on)
    w.session.messages = [user(KICKOFF), reply('好'), user('<command-name>/sn</command-name>')]
    w.answers = ['main', FIRST20, DOCS_OPTIONS[0]]
    await $.command.run({ command: 'sn', args: 'tag' } as never)
    expect(w.asks[1]!.options).toEqual([FIRST20, 'proj'])
    expect(w.get('S1')).toMatchObject({ role: 'main', fingerprint: fingerprintOf(KICKOFF) })
    expect(w.invalidated).toEqual([])
  })

  test('sub / 統整: pick the main, or 取消; with no main, say to tag one first', async ($, on) => {
    const w = world(on)
    w.answers = ['sub']
    expect(await $.command.run({ command: 'sn', args: 'tag' } as never)).toMatchObject({ text: expect.stringContaining('這個專案還沒有 main') })
    expect(w.get('S1')).toBeUndefined()
    w.mem.set(KEY('M1'), mainEntry())
    w.answers = ['統整', '取消']
    expect(await $.command.run({ command: 'sn', args: 'tag' } as never)).toMatchObject({ text: '沒有改變這個 session 的角色' })
    const m1 = label('auth 改版', Date.UTC(2026, 10, 4, 1, 2))
    expect(w.asks.at(-1)!.options).toEqual([m1, '取消'])
    w.answers = ['統整', m1]
    expect(await $.command.run({ command: 'sn', args: 'tag' } as never)).toMatchObject({ text: expect.stringContaining('統整，屬於 main「auth 改版」') })
    expect(w.get('S1')).toMatchObject({ role: 'synthesis', parentId: 'M1', briefed: false })
    expect(w.statuses.at(-1)).toBe('統整 ← auth 改版')
  })

  test('清除, and a closed dialog', async ($, on) => {
    const w = world(on, { [KEY('S1')]: { role: 'sub', parentId: 'M1', taggedAt: 1, briefed: true } })
    w.answers = [{ dismiss: true }]
    expect(await $.command.run({ command: 'sn', args: 'tag' } as never)).toMatchObject({ text: '沒有改變這個 session 的角色' })
    w.answers = ['清除']
    expect(await $.command.run({ command: 'sn', args: 'tag' } as never)).toMatchObject({ text: '已清除這個 session 的角色' })
    expect(w.get('S1')).toBeUndefined()
    expect(w.mem.has('role-none:/proj:S1')).toBe(true)
  })
})

describe('documents of a main tagged mid-conversation (11/09)', () => {
  test('a session that has talked is offered to organize first; the brief asks it to, until /sn docs', async ($, on) => {
    const w = world(on)
    w.session.messages = [user(KICKOFF), reply('好')]
    w.answers = ['main', FIRST20, ORGANIZE_DOCS]
    const r = await $.command.run({ command: 'sn', args: 'tag' } as never)
    expect(w.asks[2]!.options).toEqual([...DOCS_OPTIONS, ORGANIZE_DOCS])
    expect(r).toMatchObject({ text: expect.stringContaining('/sn docs') })
    expect(w.get('S1')).toMatchObject({ role: 'main', docsPending: true, docs: { record: 'docs/RECORD.md' } })
    // the paths are not decided: no folder made yet
    expect(w.files.size).toBe(0)
    await $.prompt.submit(typed('繼續'))
    const brief = w.sent[0]!.context?.[0] ?? ''
    expect(brief).toContain('聊到一半才標成 main')
    expect(brief).toContain('找專案裡現有的紀錄類檔案')
    expect(brief).toContain('/sn docs')
  })

  test('a new session (nothing said yet) gets the two choices only', async ($, on) => {
    const w = world(on)
    w.answers = ['main', 'proj', DOCS_OPTIONS[0]]
    await $.command.run({ command: 'sn', args: 'tag' } as never)
    expect(w.asks[2]!.options).toEqual([...DOCS_OPTIONS])
    expect(w.get('S1')?.docsPending).toBeUndefined()
  })

  test('/sn docs sets the paths; the subs and 統整 already briefed get their rules again with them', async ($, on) => {
    const w = world(on, {
      [KEY('M1')]: mainEntry({ docsPending: true }),
      [KEY('B1')]: { role: 'sub', parentId: 'M1', taggedAt: 2, briefed: true },
      [KEY('T1')]: { role: 'synthesis', parentId: 'M1', taggedAt: 3, briefed: false },
    })
    w.session.id = 'M1'
    expect(await $.command.run({ command: 'sn', args: 'docs a, b' } as never)).toMatchObject({ text: expect.stringContaining('用法') })
    const r = await $.command.run({ command: 'sn', args: 'docs notes/HANDOFF.md, notes/runs.jsonl, notes/evidence/' } as never)
    expect(r).toMatchObject({ text: expect.stringContaining('1 個 session（sub）') })
    expect(w.get('M1')).toMatchObject({ docs: { record: 'notes/HANDOFF.md', progress: 'notes/runs.jsonl', evidence: 'notes/evidence/' } })
    expect(w.get('M1')?.docsPending).toBeUndefined()
    expect(w.get('B1')).toMatchObject({ briefed: false })
    w.session.id = 'B1'
    w.session.messages = [user(KICKOFF), reply('好')]
    await $.prompt.submit({ text: '請做第一步', origin: { kind: 'peer' } } as never)
    expect(w.sent.at(-1)!.context?.[0]).toContain('notes/runs.jsonl')
    // in a sub: the paths are main's, shown not changed
    expect(await $.command.run({ command: 'sn', args: 'docs x, y, z' } as never)).toMatchObject({ text: expect.stringContaining('文件路徑由 main 決定') })
  })
})

describe('the external folder (11/11)', () => {
  test('a main gets the folder with a README; what the person adds is told to main once, README aside', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    w.jev = { kind: 'kickoff' }
    w.answers = ['要，標成 main', FIRST20, DOCS_OPTIONS[0]]
    await $.prompt.submit(typed(KICKOFF))
    expect([...w.files.keys()]).toEqual(['/proj/docs/external/README.md'])
    expect(w.files.get('/proj/docs/external/README.md')).toContain('docs/RECORD.md')
    const brief = w.sent[0]!.context?.[0] ?? ''
    expect(brief).toContain('docs/external/ 放使用者帶進來的外部資料')
    expect(w.sent[0]!.context).toHaveLength(1) // the README is not news
    w.session.messages = [user(KICKOFF), reply('好')]
    w.files.set('/proj/docs/external/2026-11-11-deep-research.md', '...')
    await $.prompt.submit(typed('接著做'))
    const notice = w.sent[1]!.context?.[0] ?? ''
    expect(notice).toContain('有新的外部資料：docs/external/2026-11-11-deep-research.md')
    expect(notice).toContain('更新進 docs/RECORD.md')
    await $.prompt.submit(typed('再來'))
    expect(w.sent[2]!.context ?? []).toEqual([])
    expect(w.get('S1')?.externalSeen).toEqual(['2026-11-11-deep-research.md'])
  })

  test('only main hears of it; a sub is told not to touch it; an older main without the fourth path gets it beside the record', async ($, on) => {
    const w = world(on, {
      [KEY('M1')]: mainEntry({ docs: { record: 'notes/R.md', progress: 'notes/p.jsonl', evidence: 'notes/ev/' } }),
      [KEY('B1')]: { role: 'sub', parentId: 'M1', taggedAt: 2, briefed: false },
    })
    w.files.set('/proj/notes/external/spec-v2.md', '...')
    w.session.id = 'B1'
    w.session.messages = [user(KICKOFF), reply('好')]
    await $.prompt.submit({ text: '請做第一步', origin: { kind: 'peer' } } as never)
    expect(w.sent[0]!.context).toHaveLength(1)
    expect(w.sent[0]!.context?.[0]).toContain('不要改 notes/R.md（只由 main 寫）和 notes/external/')
    w.session.id = 'M1'
    await $.prompt.submit(typed('sub 回報了'))
    expect(w.sent[1]!.context?.[0]).toContain('notes/external/spec-v2.md')
  })

  test('/sn docs takes four paths and makes the folder', async ($, on) => {
    const w = world(on, { [KEY('M1')]: mainEntry() })
    w.session.id = 'M1'
    const r = await $.command.run({ command: 'sn', args: 'docs d/R.md, d/p.jsonl, d/ev/, d/in/' } as never)
    expect(r).toMatchObject({ text: expect.stringContaining('外部 d/in/') })
    expect(w.get('M1')?.docs).toEqual({ record: 'd/R.md', progress: 'd/p.jsonl', evidence: 'd/ev/', external: 'd/in/' })
    expect(w.files.has('/proj/d/in/README.md')).toBe(true)
  })
})
