// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { CommandRunResult, EngineInterface, HttpResponse, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, maskNewArgs, runCommand, SHORT_COMMAND, SHORT_COMMAND_SPEC } from './commands'
import { applyOptionOverrides, checkRules, syncing, change, confirmDelete, digestNow, syncPull, optionKey, projectKey, explainDrop, prepare, readOptions, recordFeedback, routePrompt, startNote, type Options } from './notes'
import { PANE_ID, PANE_TITLE, paneView } from './pane'
import { addFacts, compactInstructions, contextKey, MANUAL_CARD, readDigest, readFacts, rulesBlock, type ContextFact } from './context'
import type { Ports } from './ports'
import { describeKey, findKey, keyFiles, resolveKey } from './secrets'
import { setActive } from './tree'
import { addUsage, claudeDelta, fetchDelta, readUsage, usageLine, type Usage } from './usage'

// $.state values (types/index.d.ts). The loader reads atoms only from this file's own consts.
const treeAtom = atom({ plugin: 'cc-sticky-notes', key: 'tree' } as const, null)
const selectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'selectedId' } as const, null)
const editingAtom = atom({ plugin: 'cc-sticky-notes', key: 'editingId' } as const, null)
const contextRevAtom = atom({ plugin: 'cc-sticky-notes', key: 'contextRev' } as const, 0)
const digestStatusAtom = atom({ plugin: 'cc-sticky-notes', key: 'digestStatus' } as const, { running: false, at: null, result: null })
const reminderAtom = atom({ plugin: 'cc-sticky-notes', key: 'reminder' } as const, null)
const compactedInAtom = atom({ plugin: 'cc-sticky-notes', key: 'compactedIn' } as const, null)
const unreadAtom = atom({ plugin: 'cc-sticky-notes', key: 'unread' } as const, 0)
const pendingAtom = atom({ plugin: 'cc-sticky-notes', key: 'pending' } as const, 0)
const lastTurnAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastTurnId' } as const, null)
const turnsAtSidebarAtom = atom({ plugin: 'cc-sticky-notes', key: 'turnsAtLastSidebar' } as const, 0)
const lastPromptAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastPromptUuid' } as const, null)
const lastSampleAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastSampleId' } as const, null)

/** Key files to try after the environment (secrets.ts says which and why). */
async function keyFilesOf($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return keyFiles(home, $.plugin.root)
}

const kvOf = ($: EngineInterface) => ({
  get: (key: string) => $.store.get(key),
  set: (key: string, value: never) => $.store.set(key, value),
  delete: (key: string) => $.store.delete(key),
  keys: () => $.store.keys(),
})

/**
 * The status line under the prompt (PROBE.md「UI 能放在哪裡」 D): what this mod spent
 * today (usage.ts), and the answers still pending. Desktop draws the plugin's name
 * before it. Redrawn when a count, the tree or the pending number changes.
 */
async function refreshStatus($: EngineInterface) {
  $.ui.status(usageLine(await readUsage(kvOf($), new Date()), await read($, pendingAtom), !currentOpts.routing))
}

/** Adds one request's cost to today's count; a failure to count never fails the request. */
function count($: EngineInterface, delta: Partial<Usage>) {
  if (Object.keys(delta).length === 0) return
  void addUsage(kvOf($), new Date(), delta)
    .then(() => refreshStatus($))
    .catch(() => {})
}

function portsOf($: EngineInterface): Ports {
  const readText = (path: string) => $.fs.read(path) as Promise<string>
  return {
    sessionId: () => $.session.id(),
    // PLAN.md: one tree per repo, shared by its worktrees; the session root outside a repo.
    projectRoot: async () => (await $.session.repo())?.root ?? (await $.session.root()),
    turns: () => $.session.turns(),
    messages: async () => {
      const list = await $.session.messages()
      return Array.isArray(list) ? list : []
    },
    now: () => $.clock.now(),
    later: fn => void $.clock.after(0, fn),
    sleep: ms => $.clock.sleep(ms),
    store: kvOf($),
    // every request that costs a quota is counted as it leaves (usage.ts)
    fetch: async (url, init) => {
      let r: HttpResponse | null = null
      try {
        r = await $.http.fetch(url, init)
        return r
      } finally {
        count($, fetchDelta(url, r))
      }
    },
    fork: async prompt => {
      const r = await $.model.fork({ prompt })
      if ('usage' in r) count($, claudeDelta(r.usage))
      return r
    },
    complete: async request => {
      const r = await $.model.complete(request)
      count($, claudeDelta(r.usage))
      return r
    },
    keys: {
      typesafe: async () => resolveKey('TYPESAFE_API_KEY', await $.env.get('TYPESAFE_API_KEY'), await keyFilesOf($), readText),
      openai: async () => resolveKey('OPENAI_API_KEY', await $.env.get('OPENAI_API_KEY'), await keyFilesOf($), readText),
      report: async () => {
        const files = await keyFilesOf($)
        return [
          describeKey('TYPESAFE_API_KEY', await findKey('TYPESAFE_API_KEY', await $.env.get('TYPESAFE_API_KEY'), files, readText)),
          describeKey('OPENAI_API_KEY', await findKey('OPENAI_API_KEY', await $.env.get('OPENAI_API_KEY'), files, readText)),
          `key 檔查找順序：${files.join(' → ')}`,
        ]
      },
    },
    place: async () => ({
      remote: (await $.session.repo())?.remote ?? null,
      machine: (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')) ?? (await $.env.get('USER')) ?? 'unknown',
    }),
    mcp: {
      tools: async () => (await $.tool.list()).filter(t => t.mcp).map(t => t.name),
      call: async (server, tool, args) => {
        const r = await $.mcp.call(server, tool, args)
        return { isError: r.isError, content: r.content as { type: string; text?: string }[] }
      },
    },
    setOption: async (field, value) => {
      try {
        // the row of this plugin's own field: `cc-sticky-notes.<field>` (or `cc-sticky-notes@inline.<field>`)
        // kept in this machine's store too, applied at session.start (applyOptionOverrides): a
        // --plugin-dir mod's fields are not rows of /config (seen 10/14), so that is the one that holds
        await $.store.set(optionKey(field), value)
        const row = (await $.config.list()).find(r => /^cc-sticky-notes(@[^.]+)?\./.test(r.key) && r.key.endsWith(`.${field}`))
        if (!row) return { ok: true }
        const r = await $.config.set({ key: row.key, value: value as never })
        if (r.deny !== undefined) $.ui.log(`sticky-notes: /config kept ${field} as it was (${r.deny}); this machine's own setting stands`, { to: 'debug' })
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: String(err).slice(0, 200) }
      }
    },
    ui: {
      log: (text, to) => $.ui.log(text, { to: to ?? 'transcript' }),
      toast: text => $.ui.toast(text),
      ask: (question, options, header) => $.ui.ask(question, { options, header }),
      openPane: async () => {
        await update($, unreadAtom, () => 0)
        await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      },
      closePane: () => $.ui.close({ id: PANE_ID }),
      isPaneOpen: async () => (await $.ui.panes()).some(pane => pane.id === PANE_ID),
      status: text => $.ui.status(text),
    },
    state: {
      publishTree: async tree => {
        await update($, treeAtom, () => tree)
        await refreshStatus($)
      },
      lastTurnId: () => read($, lastTurnAtom),
      turnsAtLastSidebar: () => read($, turnsAtSidebarAtom),
      setTurnsAtLastSidebar: async n => void (await update($, turnsAtSidebarAtom, () => n)),
      addPending: async delta => {
        await update($, pendingAtom, n => Math.max(0, n + delta))
        await refreshStatus($)
      },
      addUnread: async delta => void (await update($, unreadAtom, n => Math.max(0, n + delta))),
      lastPromptUuid: () => read($, lastPromptAtom),
      lastSampleId: () => read($, lastSampleAtom),
      setLastSampleId: async id => void (await update($, lastSampleAtom, () => id)),
      setSelected: async id => void (await update($, selectedAtom, () => id)),
      selected: () => read($, selectedAtom),
      contextChanged: async () => void (await update($, contextRevAtom, n => n + 1)),
      setDigestStatus: async (running, result) =>
        void (await update($, digestStatusAtom, s => (running ? { ...s, running: true } : { running: false, at: Date.now(), result }))),
      setReminder: async reminder => void (await update($, reminderAtom, () => reminder)),
    },
  }
}

/**
 * A card press: opens the card holding this note (null closes). Reading a card does not
 * make it the one this session follows up (10/14): a reply does, or the dialog's pick.
 */
async function selectNode($: EngineInterface, id: string | null) {
  await update($, editingAtom, () => null)
  await update($, selectedAtom, () => id)
}

/** R4: what the project context card shows; read on each draw (contextRev makes it draw again). */
async function contextData($: EngineInterface, opts: Options) {
  await read($, contextRevAtom)
  const how = {
    digestEvery: opts.digestEvery,
    provider: opts.summaryProvider,
    digestStatus: await read($, digestStatusAtom),
    settings: {
      routing: opts.routing,
      autoOpenPane: opts.autoOpenPane,
      notionSync: opts.notionSync,
      notionSet: opts.notionDataSource !== '',
      digestEvery: opts.digestEvery,
      askTimeout: opts.askTimeout,
      provider: opts.summaryProvider,
      ruleReminder: opts.ruleReminder,
    },
    reminder: await read($, reminderAtom),
  }
  try {
    const p = portsOf($)
    const root = await projectKey(p)
    const facts = await readFacts(p.store, root)
    const digest = (await readDigest(p.store, root, await p.sessionId()))?.text ?? null
    return { ...how, digest, facts: facts.map(({ sessionId: _, ...f }) => f) }
  } catch {
    // never let the context card refuse the whole pane
    return { ...how, digest: null, facts: [] }
  }
}

/** R4: the pane's edits to the project context. */
async function editFacts($: EngineInterface, edit: (facts: ContextFact[]) => ContextFact[]) {
  const p = portsOf($)
  const root = await projectKey(p)
  await p.store.set(contextKey(root), edit(await readFacts(p.store, root)))
  await p.state.contextChanged()
}


/**
 * ✎: a rewritten question is asked again beside the old one — a new follow-up of the
 * same parent, so the parent's answer offers both; a first question starts a new topic.
 */
async function rewrite($: EngineInterface, opts: Options, nodeId: string, question: string) {
  const tree = await read($, treeAtom)
  const parentId = tree?.nodes[nodeId]?.parentId ?? null
  if (parentId !== null) return followUp($, opts, parentId, question)
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'root' },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

/** The pane's reply box: straight to a note under that node, no Jev (PLAN.md). */
async function followUp($: EngineInterface, opts: Options, parentId: string, question: string) {
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'under', parentId },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

// ---- TEMP probe, /sn tag and /sn r8 … (REQUESTS.md R8, probes 1, 2 and the fallback of 2):
// session roles in `roles:<root>`, the skill listing each request carries (deck skills taken out
// for main and task-only), the 統整 opening block. Logged to $.store `r8probe:log` while
// `r8probe:on`; read back from the store file. Untagged sessions are left as they are, and with the
// probe off nothing changes at all. Remove after the probe. ----
const R8_ON = 'r8probe:on'
const R8_LOG = 'r8probe:log'
/** The latest skill_listing text each session saw (before any filtering), by short session id. */
const R8_LISTING = 'r8probe:listing'
/** Session ids whose next typed prompt carries the deck skills' text (`/sn r8 offer`). */
const R8_OFFER = 'r8probe:offer'
const R8_DECK = ['research-report-writing', 'anthropic-skills:deckframes', 'anthropic-skills:pptx', 'anthropic-skills:docx', 'anthropic-skills:docs']
const R8_DOCS_DEFAULT = 'RECORD.md, progress.jsonl, evidence/'
type R8Role = 'main' | 'task-only' | 'synthesis'
type R8Docs = { record: string; progress: string; evidence: string }
type R8Entry = { role: R8Role; parentId: string | null; taggedAt: string; docs?: R8Docs }
const R8_PICK: Record<string, R8Role> = { main: 'main', 'task-only': 'task-only', 統整: 'synthesis' }
const R8_NAME: Record<R8Role, string> = { main: 'main', 'task-only': 'task-only', synthesis: '統整' }

async function r8On($: EngineInterface): Promise<boolean> {
  return (await $.store.get(R8_ON)) === true
}

async function r8Log($: EngineInterface, kind: string, data: Record<string, unknown> = {}) {
  if (!(await r8On($))) return
  const list = ((await $.store.get(R8_LOG)) as unknown[] | undefined) ?? []
  list.push({ at: new Date().toISOString(), session: (await $.session.id()).slice(0, 8), kind, ...data })
  await $.store.set(R8_LOG, list.slice(-400) as never)
}

async function r8RolesKey($: EngineInterface): Promise<string> {
  return `roles:${await projectKey(portsOf($))}`
}

async function r8Roles($: EngineInterface): Promise<Record<string, R8Entry>> {
  return ((await $.store.get(await r8RolesKey($))) as Record<string, R8Entry> | undefined) ?? {}
}

async function r8Me($: EngineInterface): Promise<R8Entry | null> {
  return (await r8Roles($))[await $.session.id()] ?? null
}

/** Whether this conversation has had a request answered (then the listing and context were sent). */
async function r8Sent($: EngineInterface): Promise<boolean> {
  const list = await $.session.messages()
  return Array.isArray(list) && list.some(m => m.role === 'assistant')
}

/** A listing line `- <name>: …` (names may hold a colon, `plugin:skill`). */
const R8_ENTRY = /^\s*-\s+(\S+?):\s/

/** The listing without the deck skills' entries; an entry runs to the next `- name:` line. */
function r8Split(text: string): { kept: string; removed: string[]; removedText: string } {
  const kept: string[] = []
  const out: string[] = []
  const removed: string[] = []
  let dropping = false
  for (const line of text.split('\n')) {
    const m = R8_ENTRY.exec(line)
    if (m) {
      const name = m[1] ?? ''
      dropping = R8_DECK.includes(name)
      if (dropping) removed.push(name)
    }
    ;(dropping ? out : kept).push(line)
  }
  return { kept: kept.join('\n'), removed, removedText: out.join('\n') }
}

/** `紀錄, 進度, 證據` as typed (three parts), else the defaults. */
function r8Docs(typed: string): R8Docs {
  const parts = typed.split(/[,，]/).map(s => s.trim()).filter(s => s !== '')
  const [record = 'RECORD.md', progress = 'progress.jsonl', evidence = 'evidence/'] = parts.length === 3 ? parts : []
  return { record, progress, evidence }
}

function r8Opening(parentId: string | null, docs: R8Docs): string {
  return [
    `這個 session 是「統整」session（R8 探針），屬於 main session ${parentId ?? '（未指定）'}。`,
    `- 要讀的文件：紀錄 ${docs.record}、進度 ${docs.progress}、證據資料夾 ${docs.evidence}。不讀 main 的對話。`,
    '- 只根據這些文件回答，每個說法附上出自哪個檔；文件裡沒有就說「文件裡沒有」，不要猜，並把缺的項目寫進專案根目錄的 GAPS.md。',
    `- 有討論出結果時，寫進文件，再用 SendMessage 回報給 main（${parentId ?? '未指定'}）。`,
  ].join('\n')
}

/** The dialogs, awaited by the command: a dialog left running after it keeps Desktop spinning (probe, 11/05). */
async function r8Tag($: EngineInterface): Promise<string> {
  try {
    const id = await $.session.id()
    const roles = await r8Roles($)
    const pick = await $.ui.ask('這個 session 要標哪個角色？', { options: ['main', 'task-only', '統整', '清除'], header: 'R8 標籤' })
    if (pick === '清除') {
      delete roles[id]
      await $.store.set(await r8RolesKey($), roles as never)
      await r8Log($, 'tag', { role: null })
      return 'R8：已清除這個 session 的標籤'
    }
    const role = R8_PICK[pick]
    if (role === undefined) {
      return `R8：沒有標籤（回答是「${pick.slice(0, 20)}」）`
    }
    const entry: R8Entry = { role, parentId: null, taggedAt: new Date().toISOString() }
    if (role === 'main') {
      const d = await $.ui.ask('文件放在哪裡？要改就選「其他」，依序打紀錄檔、進度檔、證據資料夾，用逗號分開。', { options: [R8_DOCS_DEFAULT, '取消'], header: 'R8 文件' })
      if (d === '取消') {
        return 'R8：沒有標籤'
      }
      entry.docs = r8Docs(d)
    } else {
      const mains = Object.entries(roles)
        .filter(([k, v]) => v.role === 'main' && k !== id)
        .sort((a, b) => b[1].taggedAt.localeCompare(a[1].taggedAt))
        .slice(0, 4)
      if (mains.length === 0) {
        return 'R8：這個專案還沒有標成 main 的 session。先在 main 打 /sn tag'
      }
      const labels = mains.map(([k, v]) => `${k.slice(0, 8)}（${v.taggedAt.slice(5, 16).replace('T', ' ')} UTC 標的）`)
      const which = await $.ui.ask(`這個 ${R8_NAME[role]} session 屬於哪一個 main？`, { options: [...labels, '取消'], header: 'R8 main' })
      const hit = mains.find(([k]) => which.startsWith(k.slice(0, 8)))
      if (hit === undefined) {
        return 'R8：沒有選到 main，沒有標籤'
      }
      entry.parentId = hit[0]
    }
    roles[id] = entry
    await $.store.set(await r8RolesKey($), roles as never)
    const sent = await r8Sent($)
    // before the first request nothing has been sent: the listing and the context can still change
    if (!sent) {
      $.ui.invalidate('prompt.context')
      $.ui.invalidate('prompt.attachment')
    }
    await r8Log($, 'tag', { role, parentId: entry.parentId?.slice(0, 8) ?? null, docs: entry.docs ?? null, sent, invalidated: !sent })
    return `R8：這個 session 標成 ${R8_NAME[role]}${sent ? '（已經聊過，清單不回頭改）' : ''}`
  } catch (err) {
    return `R8：標籤失敗（${String(err).slice(0, 200)}）`
  }
}

/** What a session started with: a Desktop fork may or may not get its own id (probe 1). */
async function r8SessionStart($: EngineInterface, e: { surface: unknown; isInteractive: boolean }) {
  try {
    if (!(await r8On($))) return
    const me = await r8Me($)
    const list = await $.session.messages()
    await r8Log($, 'session.start', { id: await $.session.id(), surface: e.surface, isInteractive: e.isInteractive, messages: Array.isArray(list) ? list.length : null, role: me?.role ?? null })
  } catch (err) {
    $.ui.log(`sticky-notes: R8 probe (${String(err).slice(0, 200)})`, { to: 'debug' })
  }
}

async function r8TurnStart($: EngineInterface, turnId: string) {
  try {
    if (!(await r8On($))) return
    await r8Log($, 'turn.start', { turnId, role: (await r8Me($))?.role ?? null })
  } catch {}
}

/** The context blocks the first request carries, plus the 統整 opening for a 統整 session (D). */
async function r8Context<R extends { blocks: readonly { name: string; text: string }[] }>($: EngineInterface, r: R): Promise<R> {
  try {
    if (!(await r8On($))) return r
    const me = await r8Me($)
    await r8Log($, 'prompt.context', { role: me?.role ?? null, blocks: r.blocks.map(b => b.name), sent: await r8Sent($) })
    if (me?.role !== 'synthesis') return r
    const parent = me.parentId !== null ? (await r8Roles($))[me.parentId] : undefined
    const docs = parent?.docs ?? r8Docs(R8_DOCS_DEFAULT)
    return { ...r, blocks: [...r.blocks, { name: 'sessionRole', text: r8Opening(me.parentId, docs) }] }
  } catch (err) {
    $.ui.log(`sticky-notes: R8 probe context (${String(err).slice(0, 200)})`, { to: 'debug' })
    return r
  }
}

/** After `/sn r8 offer`: the deck skills' listing text, for the next typed prompt's context. */
async function r8OfferBlock($: EngineInterface, origin: string): Promise<string | null> {
  try {
    if ((origin !== 'composer' && origin !== 'bridge') || !(await r8On($))) return null
    const id = await $.session.id()
    const offer = ((await $.store.get(R8_OFFER)) as string[] | undefined) ?? []
    if (!offer.includes(id)) return null
    await $.store.set(R8_OFFER, offer.filter(x => x !== id) as never)
    // a new session's first prompt comes before its listing: then any session's (same machine, same skills)
    const all = ((await $.store.get(R8_LISTING)) as Record<string, { at: string; text: string }> | undefined) ?? {}
    const latest = Object.values(all).sort((a, b) => b.at.localeCompare(a.at))[0]
    const listing = (all[id.slice(0, 8)] ?? latest)?.text
    const text = listing !== undefined ? r8Split(listing).removedText : ''
    await r8Log($, 'offer.sent', { chars: text.length })
    return text === '' ? null : `[sticky-notes R8 探針] 下面這幾個 skill 不在這個 session 的清單裡，需要時一樣可以用 Skill tool 叫：
${text}`
  } catch (err) {
    $.ui.log(`sticky-notes: R8 probe offer (${String(err).slice(0, 200)})`, { to: 'debug' })
    return null
  }
}

/** `/sn tag`, `/sn r8 on|off|offer|log`; null when the args are neither. */
async function r8Command($: EngineInterface, args: string): Promise<CommandRunResult | null> {
  const m = /^\s*(tag|r8)\b\s*([\s\S]*)$/i.exec(args)
  if (!m) return null
  if ((m[1] ?? '').toLowerCase() === 'tag') {
    return { text: `[R8 探針] ${await r8Tag($)}` }
  }
  const sub = (m[2] ?? '').trim().toLowerCase()
  switch (sub) {
    case 'on':
      await $.store.set(R8_ON, true)
      await $.store.set(R8_LOG, [] as never)
      await r8Log($, 'r8.on')
      return { text: '[R8 探針] 開始記錄。沒有標籤的 session 不受影響。' }
    case 'off':
      await r8Log($, 'r8.off')
      await $.store.set(R8_ON, false)
      return { text: '[R8 探針] 停止記錄，標籤留著但不再有作用。' }
    case 'offer': {
      const id = await $.session.id()
      const list = ((await $.store.get(R8_OFFER)) as string[] | undefined) ?? []
      await $.store.set(R8_OFFER, [...list.filter(x => x !== id), id] as never)
      await r8Log($, 'offer')
      return { text: '[R8 探針] 下一句會附上簡報類 skill 的說明。' }
    }
    // which part of /sn tag leaves Desktop spinning: a detached dialog, a dialog awaited in the command, or the invalidates
    case 'ask': {
      void $.clock.after(0, async () => {
        const a = await $.ui.ask('[R8 探針] 只有對話框，背景跑', { options: ['好', '取消'], header: 'R8 ask' })
        await r8Log($, 'spin.ask', { answer: a })
      })
      return { text: '[R8 探針] ask：背景跳對話框' }
    }
    case 'ask2': {
      const a = await $.ui.ask('[R8 探針] 只有對話框，指令等它答完', { options: ['好', '取消'], header: 'R8 ask2' })
      await r8Log($, 'spin.ask2', { answer: a })
      return { text: `[R8 探針] ask2：答了「${a}」` }
    }
    case 'inv':
      $.ui.invalidate('prompt.context')
      $.ui.invalidate('prompt.attachment')
      await r8Log($, 'spin.inv', { sent: await r8Sent($) })
      return { text: '[R8 探針] inv：只有 invalidate，沒有對話框' }
    case 'log': {
      const list = ((await $.store.get(R8_LOG)) as Record<string, unknown>[] | undefined) ?? []
      for (const x of list.slice(-30)) $.ui.log(JSON.stringify(x))
      return {}
    }
    default:
      return { text: '用法：/sn tag，或 /sn r8 on|off|offer|log|ask|ask2|inv' }
  }
}
// ---- end TEMP probe ----

/** R7: how long a compaction waits for the rules to be gathered from what it is about to drop. */
const COMPACT_DIGEST_WAIT_MS = 30000

/** The session's options, for refreshStatus (outside register's closure). */
let currentOpts: Options = readOptions({})

export const register: Register = (on, options) => {
  const opts = readOptions(options)
  currentOpts = opts

  on('session.start', async ($, e, next) => {
    await applyOptionOverrides(kvOf($), opts)
    await $.command.register(COMMAND_SPEC)
    await $.command.register(SHORT_COMMAND_SPEC)
    const p = portsOf($)
    await prepare(p)
    // the notes other computers made in this project (Notion), in the background
    if (syncing(opts)) p.later(() => void syncPull(p, opts))
    const r = await next(e)
    await r8SessionStart($, e) // TEMP probe (R8)
    return r
  })

  on('turn.start', async ($, e, next) => {
    await update($, lastTurnAtom, () => e.turnId)
    await r8TurnStart($, e.turnId) // TEMP probe (R8)
    return next(e)
  })

  // R4: every digestEvery main turns, the main-line digest and the project context, in the background
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && opts.digestEvery > 0) {
      const p = portsOf($)
      p.later(() => void digestNow(p, opts).catch(err => p.ui.log(`sticky-notes: main digest failed: ${String(err).slice(0, 200)}`, 'debug')))
    }
    return r
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // anchor.messageId: the main-line user message a later sidebar question sits after (M2 badge).
    if (e.door === 'prompt' && e.message.type === 'user' && !e.message.isMeta) {
      await update($, lastPromptAtom, () => e.uuid)
      return next(e)
    }
    // PROBE.md P10: `/sticky-note new <問題>` would leave the question in the main context.
    if (e.door === 'command') {
      let masked = false
      const content = e.message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block
        const text = maskNewArgs(block.text)
        if (text === null) return block
        masked = true
        return { ...block, text }
      })
      if (masked) return next({ ...e, message: { ...e.message, content } })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const offered = await r8OfferBlock($, e.origin.kind) // TEMP probe (R8)
    if (offered !== null) e = { ...e, context: [...(e.context ?? []), offered] }
    // Only the person's own typed prompts are routed; notifications, peers and plugins pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim() === '' || e.text.trimStart().startsWith('/')) return next(e)
    const p = portsOf($)

    // R7: "you broke a rule" (Jev): the pane asks which rules compaction keeps; the kept ones go
    // with this prompt, which stays on the main line whatever the routing says
    const rules = await checkRules(p, opts, e.text)
    if (rules.context !== null) e = { ...e, context: [...(e.context ?? []), rules.context] }
    if (rules.broke) return next(e)

    // the mod's main switch (/sn off, the settings card): everything to the main line, no Jev
    if (!opts.routing) return next(e)

    const routed = await routePrompt(p, opts, e.text, { remote: e.origin.kind === 'bridge' })
    const keep = (nodeId: string | null) => p.later(() => void recordFeedback(p, opts, e.text, routed, nodeId))
    const d = routed.decision
    switch (d.kind) {
      case 'main':
      case 'ask':
        keep(null)
        return next(e)
      case 'project_question':
        // the main line answers it; no note (going to the main line means no note)
        keep(null)
        return next({ ...e, context: [...(e.context ?? []), d.context] })
      case 'sidebar':
        keep(
          await startNote(p, opts, {
            question: e.text,
            attach: d.parentId !== undefined ? { kind: 'under', parentId: d.parentId } : { kind: d.attach },
            answerer: d.answerer,
            route: d.route,
            tag: d.tag.kind === 'existing' ? d.tag.tag : undefined,
          }),
        )
        // The drop reason is the transparency line (PROBE.md P2): who decided, how sure, where it went.
        return { drop: explainDrop(e.text, routed) }
    }
  })

  // R7: before the main line is compacted, the rules in what is about to go are gathered (a digest
  // run, if anything is new since the last), and the summarizer is handed them all to keep the
  // ones the work in progress needs, the kept ones word for word: the summary carries them on
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const p = portsOf($)
    let given = e
    try {
      const root = await projectKey(p)
      const last = await readDigest(p.store, root, await p.sessionId())
      if (opts.digestEvery > 0 && (last === null || last.turns < (await p.turns()))) {
        await Promise.race([digestNow(p, opts, true), p.sleep(COMPACT_DIGEST_WAIT_MS)])
      }
      const instructions = compactInstructions(await readFacts(p.store, root), e.instructions)
      if (instructions !== undefined) given = { ...e, instructions }
    } catch (err) {
      p.ui.log(`sticky-notes: compaction left as it was given (${String(err).slice(0, 200)})`, 'debug')
    }
    const r = await next(given)
    if (r.skip === undefined && e.trigger !== 'precompute') {
      const sessionId = await p.sessionId()
      await update($, compactedInAtom, () => sessionId)
    }
    return r
  })

  // R7: the rules reach a new session's first request only (the developer, 10/21): a resumed
  // conversation still holds what they came from, and a compacted one has them in its summary
  on('prompt.context', async ($, e, next) => {
    let given = e
    try {
      const compacted = (await read($, compactedInAtom)) === (await $.session.id())
      const list = await $.session.messages()
      const answered = Array.isArray(list) && list.some(m => m.role === 'assistant')
      if (!compacted && !answered) {
        const block = rulesBlock(await readFacts(kvOf($), await projectKey(portsOf($))))
        if (block !== null) given = { ...e, blocks: [...e.blocks, { name: 'projectRules', text: block }] }
      }
    } catch (err) {
      $.ui.log(`sticky-notes: no rules block (${String(err).slice(0, 200)})`, { to: 'debug' })
    }
    return r8Context($, await next(given)) // TEMP probe (R8): the 統整 opening
  })

  // ---- TEMP probe (R8): the skill listing each request carries ----
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(await r8On($)) || typeof r.text !== 'string') return r
      const me = await r8Me($)
      const id = await $.session.id()
      const listings = ((await $.store.get(R8_LISTING)) as Record<string, { at: string; text: string }> | undefined) ?? {}
      listings[id.slice(0, 8)] = { at: new Date().toISOString(), text: r.text.slice(0, 30000) }
      const recent = Object.entries(listings).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 8)
      await $.store.set(R8_LISTING, Object.fromEntries(recent) as never)
      const filter = me !== null && me.role !== 'synthesis'
      const split = r8Split(r.text)
      await r8Log($, 'skill_listing', {
        role: me?.role ?? null,
        keys: Object.keys(e),
        chars: r.text.length,
        entries: [...r.text.matchAll(new RegExp(R8_ENTRY.source, 'gm'))].map(x => x[1]),
        deckInText: R8_DECK.filter(n => r.text!.includes(n)),
        sent: await r8Sent($),
        removed: filter ? split.removed : null,
      })
      return filter ? { ...r, text: split.kept } : r
    } catch (err) {
      $.ui.log(`sticky-notes: R8 probe listing (${String(err).slice(0, 200)})`, { to: 'debug' })
      return r
    }
  })

  // ---- end TEMP probe ----

  on('command.run', { command: COMMAND }, async ($, e) => (await r8Command($, e.args)) ?? runCommand(portsOf($), opts, e.args))
  // /sn: the keyboard shortcut for the pane (the status line cannot be clicked; PROBE.md)
  on('command.run', { command: SHORT_COMMAND }, async ($, e) => (await r8Command($, e.args)) ?? runCommand(portsOf($), opts, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const data = {
      tree: await read($, treeAtom),
      selectedId: await read($, selectedAtom),
      editingId: await read($, editingAtom),
      sessionId: await $.session.id(),
      pending: await read($, pendingAtom),
      surface: e.surface,
      ...(await contextData($, opts)),
    }
    return paneView($.ui.resolve(e), data, {
      select: id => void selectNode($, id),
      edit: id => void update($, editingAtom, () => id),
      followUp: (parentId, question) => void followUp($, opts, parentId, question),
      rewrite: (nodeId, question) => void rewrite($, opts, nodeId, question),
      remove: nodeId => void confirmDelete(portsOf($), opts, nodeId),
      addFact: (text, card) =>
        void $.session
          .id()
          .then(sessionId => editFacts($, facts => addFacts(facts, [{ id: crypto.randomUUID(), text, at: Date.now(), sessionId, source: 'manual', card: card ?? MANUAL_CARD }]))),
      removeFact: id => void editFacts($, facts => facts.filter(f => f.id !== id)),
      // R7: kept word for word through compaction, or not
      toggleKeep: id => void editFacts($, facts => facts.map(f => (f.id === id ? { ...f, keep: !f.keep } : f))),
      doneReminder: () =>
        void (async () => {
          await update($, reminderAtom, () => null)
          await selectNode($, null)
        })(),
      // the card itself shows 統整中… and then the outcome (digestStatus)
      refreshDigest: () => {
        const p = portsOf($)
        p.later(() => void digestNow(p, opts, true))
      },
      // the settings card: this machine's own setting, at once
      setSetting: (field, value) => {
        const p = portsOf($)
        void (async () => {
          const r = await p.setOption(field, value)
          if (!r.ok) return p.ui.toast(`Sticky Notes：沒有改成功（${r.reason}）`)
          ;(opts as Record<string, unknown>)[field] = value
          await p.state.contextChanged()
          await refreshStatus($)
        })()
      },
    })
  })
}
