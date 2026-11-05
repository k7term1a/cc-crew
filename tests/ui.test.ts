// UI: the band and the pane draw valid trees on terminal and desktop, follow-ups
// are listed under their parent, and a click shows the whole thread.
import { expect, mock, test } from 'claude-code/testing'

import type { TreeNode } from '../types'

const PLUGIN = 'cc-sticky-notes'
const ROOT = '/proj'

const node = (id: string, parentId: string | null, at: number, title: string, answer: string, summary: string | null = null): TreeNode => ({
  id,
  parentId,
  outlineId: null,
  anchor: { sessionId: 'S1', turnId: null, messageId: null, at, mainSnippet: '' },
  question: `${title}?`,
  answer,
  answeredBy: 'claude-fork',
  title,
  summary,
  tags: [],
  route: { label: 'sidebar_knowledge', confidence: 1, source: 'jev' },
  promotedAt: null,
  promotedIn: null,
  children: [],
})

const PANE = {
  component: 'Pane',
  requestId: 'sticky',
  props: { title: 'Sticky Notes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 40, contentRows: 1 }, view: {} } as never,
} as const

test('empty: the pane validates on terminal and desktop', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /還沒有/ })).toBeDefined()
    await pane.unmount()
  }
})

test('cards: one per topic; a press opens the thread; picks, reply and rewrite; the tag as a chip', async ($, on) => {
  mock.store(on, {
    [`node:${ROOT}:r1`]: (() => { const n = node('r1', null, 1, '樹載入原因', '因為 $.store 一次只讀一個 key。', '一次只能讀一個 key。'); return { ...n, route: { ...n.route, jev: 'sidebar_knowledge' } } })(),
    [`node:${ROOT}:c1`]: node('c1', 'r1', 2, '為何全讀', '因為 roots 與 children 是推出來的。'),
    [`node:${ROOT}:c3`]: node('c3', 'r1', 4, '一個 JSON', '同時寫會互相蓋掉。'),
    [`node:${ROOT}:r2`]: node('r2', null, 3, 'TCP 背壓', '接收窗口。'),
  })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let forked = ''
  const forks: string[] = []
  on('model.fork', ($, e) => {
    forked = e.prompt
    forks.push(e.prompt.slice(-30))
    return { value: { isAnswered: true, text: 'fork answer', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"title":"新追問","summary":"s"}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    // closed cards, one per topic; no question drawn yet
    expect(await pane.find({ key: 'open:r1' })).toBeDefined()
    expect(await pane.find({ key: 'open:r2' })).toBeDefined()
    expect(await pane.find({ key: 'q:r1' })).toBeUndefined()
    // the tag before the time; the time opens the card too
    expect(await pane.find({ type: 'Text', text: surface === 'terminal' ? /^\[知識旁問\]$/ : /^ 知識旁問 $/ })).toBeDefined()
    expect(await pane.find({ key: 'open-meta:r1' })).toBeDefined()
    // open: the thread runs on down by the newest follow-up (c3), with both offered as picks
    await pane.press({ key: 'open:r1' })
    expect(await pane.find({ key: 'q:r1' })).toBeDefined()
    expect(await pane.find({ key: 'q:c3' })).toBeDefined()
    expect(await pane.find({ key: 'pick:c1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Q / })).toBeUndefined() // no Q/A words
    await pane.press({ key: 'pick:c1' })
    expect(await pane.find({ key: 'q:c1' })).toBeDefined()
    expect(await pane.find({ key: 'q:c3' })).toBeUndefined()
    expect(await pane.find({ key: 'reply:c1' })).toBeDefined()
    await pane.press({ key: 'close:r1' })
    expect(await pane.find({ key: 'q:r1' })).toBeUndefined()
    await pane.unmount()
  }

  // the reply box: a follow-up of the last note shown, which then is the one followed up
  let pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await pane.press({ key: 'open:r1' })
  await pane.press({ key: 'pick:c1' })
  await pane.input({ key: 'reply:c1', text: '那 children 什麼時候算？' })
  await clock.advance(10) // the answer runs in $.clock.after(0)
  expect(await pane.find({ type: 'Text', text: /^那 children 什麼時候算？$/ })).toBeDefined()
  expect(await pane.find({ key: 'reply:c1' })).toBeUndefined() // a fresh, empty box under the new note
  await pane.unmount()
  await clock.advance(1000)
  expect(forks).toHaveLength(1)
  expect(forked).toContain('[side thread so far]')
  expect(forked).toContain('Q2: 為何全讀?')
  expect(forked).toContain('[question]\n那 children 什麼時候算？')

  // ✎ (always drawn on the terminal): asked again beside the old question, under the same parent
  // (the card is still open on the reply's thread, which runs through c1)
  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await term.press({ key: 'edit:c1' })
  await term.input({ key: 'edit-box:c1', text: '換個問法：為什麼要全讀？' })
  await clock.advance(10)
  expect(await term.find({ key: 'edit-box:c1' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /^換個問法：為什麼要全讀？$/ })).toBeDefined()
  await term.unmount()
  await clock.advance(1000)
  expect(forks).toHaveLength(2)
  expect(forked).not.toContain('Q2: 為何全讀?') // a sibling of c1: c1 is not in its history
})

test('/sn opens and closes the pane like /sticky-note', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  const open: string[] = []
  let isOpen = false
  on('ui.open', ($, e) => {
    open.push(e.id)
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'sticky', title: 'Sticky Notes', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  await $.command.run({ command: 'sn', args: '' } as never)
  expect(open).toEqual(['sticky'])
  expect(isOpen).toBe(true)
  await $.command.run({ command: 'sn', args: '' } as never)
  expect(isOpen).toBe(false)
})

test('a pasted 12,000-character question and a 15,000-character answer still draw (Text / Markdown hold 10,000)', async ($, on) => {
  const longQ = '貼上的內容'.repeat(2400) // 12,000 characters
  const longA = '很長的答案。'.repeat(2500) // 15,000 characters
  mock.store(on, { [`node:${ROOT}:big`]: { ...node('big', null, 1, '長問題', longA), question: longQ } })
  mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    await pane.press({ key: 'open:big' })
    expect(await pane.find({ type: 'Text', text: /（共 12000 字）/ })).toBeDefined()
    expect(await pane.find({ key: 'close:big' })).toBeDefined() // the engine did not draw its own instead
    await pane.press({ key: 'close:big' }) // the selection outlives the mount
    await pane.unmount()
  }
})

test('the settings card flips the switches that are left (11/05: no routing, timeout, digest or rule reminder)', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({ value: [] }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  expect(await pane.find({ key: 'open:settings' } as never)).toMatchObject({ props: { label: '設定' } })
  await pane.press({ key: 'open:settings' })
  for (const gone of ['routing', 'timeout', 'digest', 'ruleReminder']) expect(await pane.find({ key: `set-btn:${gone}` } as never)).toBeUndefined()
  expect(await pane.find({ key: 'set-btn:autoOpen' } as never)).toMatchObject({ props: { label: '● 開' } })
  await pane.press({ key: 'set-btn:autoOpen' })
  await pane.press({ key: 'set-btn:provider' })
  expect(await pane.find({ key: 'set-btn:autoOpen' } as never)).toMatchObject({ props: { label: '○ 關' } })
  expect(await pane.find({ key: 'set-btn:provider' } as never)).toMatchObject({ props: { label: 'OpenAI' } })
  expect(await pane.find({ key: 'set-btn:notion' } as never)).toMatchObject({ props: { label: '未設定' } })
  // the deck skills only 統整 sessions list: shown, changed in the plugin's options
  expect(await pane.find({ type: 'Text', text: /^research-report-writing、anthropic-skills:deckframes、/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /deckSkills/ })).toBeDefined()
  // no project-context card, no rule cards
  expect(await pane.find({ key: 'open:context' } as never)).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^專案規範$/ })).toBeUndefined()
  await pane.unmount()
  // the removed subcommands are unknown now
  for (const sub of ['on', 'off', 'timeout 10', 'every 3', 'ctx', 'feedback good', 'calibrate']) {
    expect(await $.command.run({ command: 'sn', args: sub } as never)).toMatchObject({ text: expect.stringContaining('未知的子指令') })
  }
})

test('11/05: a typed prompt goes to the main line as it is (no Jev call, no drop, no rules); a new session gets no rules block', async ($, on) => {
  // what R4 / R7 left in the store is not read any more
  mock.store(on, {
    [`context:${ROOT}`]: [{ id: 'f1', text: '一律用繁體中文', at: 1, sessionId: 'S1', source: 'auto', card: '語言', kind: 'habit', keep: true }],
    [`digest:${ROOT}:S1`]: { text: '主線在把 auth 改成 session cookie。', turns: 3, at: 1 },
    'option:routing': true,
  })
  mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('session.turns', () => ({ value: 9 }))
  on('session.messages', () => ({ value: [{ role: 'user', text: '改一下', toolUses: [] }, { role: 'assistant', text: '好了', toolUses: [] }] }) as never)
  on('env.get', ($, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? 'test-key' : undefined }) as never)
  on('fs.read', () => {
    throw new Error('no file')
  })
  let fetched = 0
  on('http.fetch', () => {
    fetched++
    return { value: { status: 200, ok: true, headers: {}, text: '{"answers":{"broke_rule":{"type":"noul","noul":0.95},"route":{"type":"choice","choice":"sidebar_knowledge","confidence":0.99}}}' } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let sent: { text: string; context?: readonly string[] } | undefined
  on('prompt.submit', ($, e) => {
    sent = e as never
    return { text: e.text } as never
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const r = await $.prompt.submit({ text: '怎麼又用簡體了，TCP 背壓是什麼？', origin: { kind: 'composer' } } as never)
  expect(r).toMatchObject({ text: '怎麼又用簡體了，TCP 背壓是什麼？' })
  expect('drop' in (r as object)).toBe(false)
  expect(sent?.text).toBe('怎麼又用簡體了，TCP 背壓是什麼？')
  expect(sent?.context ?? []).toEqual([])
  expect(fetched).toBe(0)
  expect((await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })).blocks.map(b => b.name)).toEqual(['currentDate'])
  // the pane draws no reminder card
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: /^哪些規範要在壓縮時保留？$/ })).toBeUndefined()
  await pane.unmount()
})
