// Orchestration between the hooks and the pure modules: creating a note, answering
// it in the background, keeping the pane's state in sync, and the Notion sync.
// Everything outside goes through Ports.
//
// 11/05 (PLAN.md「11/05 改版」): per-prompt Jev routing, the R7 rule reminder and the
// R4 background digest are gone; a note is made only by hand (/sn new, the pane).
import type { ModelEffort, PluginOptions } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { answerSide } from './answer'
import { titleAndSummary } from './digest'
import { markUnsynced, pullNotes, pushNote, type SyncPorts } from './notion'
import type { Ports } from './ports'
import { parseDeckSkills } from './roles'
import { asEffort, claudeProvider } from './providers/claude'
import { asContextMode, asReasoningEffort, openaiProvider, type OpenAIReasoningEffort } from './providers/openai'
import { withFallback, type SummaryProvider } from './providers/types'
import { addNode, removeNode, loadTree, migrateLegacy, mutateTree, normalizeRoot, sideHistory, updateNode, type Attach } from './tree'

export type Options = {
  summaryProvider: 'claude' | 'openai'
  claudeModel: string
  claudeEffort: ModelEffort
  openaiModel: string
  openaiReasoningEffort: OpenAIReasoningEffort
  openaiContextMode: 'off' | 'redacted' | 'full'
  autoOpenPane: boolean
  /** Notes sync with Notion when a data source is set; off keeps the data source but sends nothing. */
  notionSync: boolean
  /** The Notion data source the notes sync to (collection://…); '' turns the sync off. */
  notionDataSource: string
  /** The skills only a 統整 session's listing keeps (roles.ts); the plugin option `deckSkills`, comma-separated. */
  deckSkills: string[]
}

export function readOptions(o: PluginOptions): Options {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
  return {
    summaryProvider: o.summaryProvider === 'openai' ? 'openai' : 'claude',
    claudeModel: str(o.claudeModel, 'haiku'),
    claudeEffort: asEffort(o.claudeEffort),
    openaiModel: str(o.openaiModel, 'gpt-5-mini'),
    openaiReasoningEffort: asReasoningEffort(o.openaiReasoningEffort),
    openaiContextMode: asContextMode(o.openaiContextMode),
    autoOpenPane: o.autoOpenPane !== false, // default on (the developer's pick, 10/07)
    notionSync: true,
    notionDataSource: typeof o.notionDataSource === 'string' ? o.notionDataSource.trim() : '',
    deckSkills: parseDeckSkills(o.deckSkills),
  }
}

/** What /sn provider, /sn notion and the settings card set, kept per machine in $.store over the plugin settings. */
export const OVERRIDABLE = ['summaryProvider', 'notionDataSource', 'notionSync', 'autoOpenPane'] as const
export type OverridableField = (typeof OVERRIDABLE)[number]
export const optionKey = (field: OverridableField) => 'option:' + field

/** Puts this machine's own settings (optionKey) over the plugin's, in place. */
export async function applyOptionOverrides(kv: { get(key: string): Promise<unknown> }, opts: Options): Promise<void> {
  const provider = await kv.get(optionKey('summaryProvider'))
  if (provider === 'claude' || provider === 'openai') opts.summaryProvider = provider
  const notion = await kv.get(optionKey('notionDataSource'))
  if (typeof notion === 'string') opts.notionDataSource = notion
  for (const field of ['notionSync', 'autoOpenPane'] as const) {
    const v = await kv.get(optionKey(field))
    if (typeof v === 'boolean') opts[field] = v
  }
}

/** Whether notes go to (and come from) Notion now: a data source, and the switch on. */
export const syncing = (opts: Options) => opts.notionSync && opts.notionDataSource !== ''

/** The configured summary provider; openai without a key falls back to claude with one toast. */
export function summaryProvider(p: Ports, opts: Options): SummaryProvider {
  const log = (text: string) => p.ui.log(text, 'debug')
  const claude = claudeProvider({ complete: p.complete, log }, { model: opts.claudeModel, effort: opts.claudeEffort })
  if (opts.summaryProvider !== 'openai') return claude
  const openai = openaiProvider(
    { key: p.keys.openai, fetch: p.fetch, log },
    { model: opts.openaiModel, contextMode: opts.openaiContextMode, reasoningEffort: opts.openaiReasoningEffort },
  )
  return withFallback(openai, claude, () => p.ui.toast('Sticky Notes：沒有 OPENAI_API_KEY，統整層改用 Claude'))
}

/** PLAN.md: the repo root (shared by every worktree), else the session root. */
export async function projectKey(p: Ports): Promise<string> {
  return normalizeRoot(await p.projectRoot())
}

export async function refresh(p: Ports): Promise<Tree> {
  const tree = await loadTree(p.store, await projectKey(p))
  await p.state.publishTree(tree)
  return tree
}

/**
 * The project_question bookmarks the mod kept until 10/12 (「這題在主線回答」): no answer,
 * promoted at creation. The developer asked them gone (10/14); nothing makes them any more.
 */
export function isMainLineBookmark(n: TreeNode): boolean {
  return n.promotedAt !== null && n.answer === '' && n.route.label === 'project_question' && n.children.length === 0
}

/** session.start: move a tree saved in the old one-key layout, drop the old bookmarks, then load. */
export async function prepare(p: Ports): Promise<Tree> {
  const root = await projectKey(p)
  const moved = await migrateLegacy(p.store, root)
  if (moved > 0) p.ui.log(`sticky-notes: moved ${moved} notes to the per-node store layout`, 'debug')
  const tree = await loadTree(p.store, root)
  const bookmarks = Object.values(tree.nodes).filter(isMainLineBookmark)
  if (bookmarks.length > 0) {
    await mutateTree(p.store, root, t => bookmarks.reduce((acc, n) => removeNode(acc, n.id), t))
    p.ui.log(`sticky-notes: removed ${bookmarks.length} old 在主線回答 bookmarks`, 'debug')
  }
  return refresh(p)
}

export async function change(p: Ports, fn: (t: Tree) => Tree): Promise<Tree> {
  const tree = await mutateTree(p.store, await projectKey(p), fn)
  await p.state.publishTree(tree)
  return tree
}

export function snippet(s: string, n: number): string {
  const cps = [...s.replace(/\s+/g, ' ').trim()]
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('')
}

/** How much of the question the /sn new toast quotes, and of the answer the log line previews (the developer: keep them short). */
export const QUESTION_CHARS = 24
export const PREVIEW_CHARS = 40

/** Markdown flattened to one plain line (headings, emphasis, code, tables, list marks dropped), first n characters. */
export function plainPreview(md: string, n: number): string {
  const text = md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ') // table rules
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`|>#]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  return snippet(text, n)
}

/** What /sn new shows as its toast: which note was made (PLAN.md / PROBE.md P2). */
export function dropReason(question: string): string {
  return `cc-sticky-note：便利貼「${snippet(question, QUESTION_CHARS)}」`
}

/**
 * A user message the person typed: not a slash-command record or caveat
 * (`<command-name>…`, `<local-command-…>`), which $.session.messages() also lists.
 */
export function isTypedPrompt(m: { role: string; text: string }): boolean {
  if (m.role !== 'user') return false
  const t = m.text.trimStart()
  return t !== '' && !/^<(command-|local-command-|system-reminder)/.test(t)
}

export type NoteRequest = {
  question: string
  attach: Attach
  answerer: 'fork' | 'summary-provider'
  route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual'; jev?: string }
}

async function anchorFor(p: Ports) {
  const sessionId = await p.sessionId()
  const lastUser = (await p.messages()).filter(isTypedPrompt).at(-1)?.text ?? ''
  return {
    sessionId,
    turnId: await p.state.lastTurnId(),
    messageId: await p.state.lastPromptUuid(),
    at: await p.now(),
    mainSnippet: [...lastUser].slice(0, 120).join(''),
  }
}

/**
 * Writes the node now (answer pending) and answers it in the background.
 * /sn new shows dropReason() as its toast; the pane's boxes show the question at once.
 */
export async function startNote(p: Ports, opts: Options, req: NoteRequest): Promise<string> {
  const anchor = await anchorFor(p)
  const id = crypto.randomUUID()
  await change(p, t =>
    addNode(
      t,
      anchor.sessionId,
      {
        id,
        question: req.question,
        anchor,
        route: req.route,
        answeredBy: req.answerer === 'fork' ? 'claude-fork' : opts.summaryProvider,
      },
      req.attach,
    ).tree,
  )
  await p.state.addPending(1)
  // the pane follows the newest note of this session (its answer shows as it arrives)
  await p.state.setSelected(id)

  // Answered outside the dispatch that asked (PROBE.md: works, and the
  // command returns at once instead of after the 1–3 s fork). Nothing may
  // escape a background job: a failure marks the note and says so.
  p.later(() => {
    answerNote(p, opts, id, req).catch(async (err: unknown) => {
      p.ui.log(`sticky-notes: answering failed: ${String(err).slice(0, 200)}`, 'debug')
      p.ui.toast('Sticky Notes：回答失敗')
      await change(p, t => updateNode(t, id, { answer: '_(回答失敗)_' })).catch(() => {})
    })
  })
  return id
}

export async function answerNote(p: Ports, opts: Options, id: string, req: NoteRequest): Promise<void> {
  const provider = summaryProvider(p, opts)
  try {
    const tree = await refresh(p)
    const history = sideHistory(tree, tree.nodes[id]?.parentId ?? null)
    const a = await answerSide(p.fork, { question: req.question, history, answerer: req.answerer }, provider)
    if (!a.ok) {
      await change(p, t => updateNode(t, id, { answer: `_(沒有答案：${a.reason})_` }))
      p.ui.toast(`Sticky Notes：回答失敗（${a.reason}）`)
      return
    }
    await change(p, t => updateNode(t, id, { answer: a.text, answeredBy: a.answeredBy }))
    const ts = await titleAndSummary(provider, req.question, a.text)
    await change(p, t => updateNode(t, id, { title: ts.title, summary: ts.summary }))
    await p.state.addUnread(1)
    // M1 (PLAN.md): the answer is shown with $.ui.log — a dim transcript line the model never reads.
    // $.ui.log is plain text (no Markdown): one clean line here, the rendered answer in the pane.
    p.ui.log(`cc-sticky-note ${ts.title}：${plainPreview(ts.summary ?? a.text, PREVIEW_CHARS)}　/sn 看完整答案`)
    p.ui.toast(`cc-sticky-note ${ts.title}`)
    if (opts.autoOpenPane) await p.ui.openPane()
    // the answered note goes to Notion for the other computers, in the background
    if (syncing(opts)) p.later(() => void syncPush(p, opts, id))
  } finally {
    await p.state.addPending(-1)
  }
}

const syncPorts = (p: Ports): SyncPorts => ({ ...p, projectKey: () => projectKey(p) })
const syncStatusKey = async (p: Ports) => `notion-status:${await projectKey(p)}`

/**
 * Deletes a note and the follow-ups under it, here only (the developer, 10/14). Their
 * Notion rows, if any, are marked 不同步 so no other computer pulls them from now on;
 * the notion:<root>:<id> keys stay, so this computer never pulls them back either.
 */
export async function deleteNote(p: Ports, opts: Options, id: string): Promise<number> {
  const before = await refresh(p)
  if (!before.nodes[id]) return 0
  const gone: string[] = []
  const walk = (nid: string) => {
    gone.push(nid)
    for (const c of before.nodes[nid]?.children ?? []) walk(c)
  }
  walk(id)
  const parent = before.nodes[id]!.parentId
  await change(p, t => removeNode(t, id))
  const selected = await p.state.selected()
  if (selected !== null && gone.includes(selected)) await p.state.setSelected(parent)
  if (syncing(opts)) p.later(() => void markUnsynced(syncPorts(p), opts.notionDataSource, gone))
  return gone.length
}

/** ✕ and /sn rm: the dialog first (how much goes), then deleteNote. Dismissed, nothing goes. */
export async function confirmDelete(p: Ports, opts: Options, id: string): Promise<number> {
  const tree = await refresh(p)
  const node = tree.nodes[id]
  if (!node) return 0
  let below = 0
  const count = (nid: string) => (tree.nodes[nid]?.children ?? []).forEach(c => (below++, count(c)))
  count(id)
  const what = `「${node.title}」${below > 0 ? `和它底下 ${below} 則追問` : ''}`
  try {
    const a = await p.ui.ask(`刪除${what}？只刪這台電腦的，Notion 上會標成不同步。`, ['刪除', '取消'], 'Sticky Notes')
    if (a !== '刪除') return 0
  } catch {
    return 0
  }
  const n = await deleteNote(p, opts, id)
  p.ui.toast(`Sticky Notes：已刪除${what}`)
  return n
}

/** One note to Notion; how it went is kept for /sn notion. */
export async function syncPush(p: Ports, opts: Options, id: string): Promise<string> {
  const node = (await refresh(p)).nodes[id]
  if (!node) return 'gone'
  const r = await pushNote(syncPorts(p), opts.notionDataSource, node)
  if (r !== 'pushed' && r !== 'skipped') {
    p.ui.log(`sticky-notes: Notion push failed (${r})`, 'debug')
    await p.store.set(await syncStatusKey(p), `上傳失敗：${r}`)
  }
  return r
}

/** /sn notion push: every answered note of this project not yet in Notion. */
export async function syncPushAll(p: Ports, opts: Options): Promise<{ pushed: number; failed: number }> {
  const tree = await refresh(p)
  let pushed = 0
  let failed = 0
  for (const node of Object.values(tree.nodes).sort((a, b) => a.anchor.at - b.anchor.at)) {
    const r = await pushNote(syncPorts(p), opts.notionDataSource, node)
    if (r === 'pushed') pushed++
    else if (r !== 'skipped') failed++
  }
  await p.store.set(await syncStatusKey(p), `上傳 ${pushed} 張${failed ? `，${failed} 張失敗` : ''}（${new Date(await p.now()).toLocaleString()}）`)
  return { pushed, failed }
}

/** The other computers' notes of this project into the tree; a toast when any came. */
export async function syncPull(p: Ports, opts: Options): Promise<string> {
  const r = await pullNotes(syncPorts(p), opts.notionDataSource, fn => change(p, fn), await refresh(p))
  const text = 'error' in r ? `下載失敗：${r.error}` : `下載 ${r.added} 張`
  await p.store.set(await syncStatusKey(p), `${text}（${new Date(await p.now()).toLocaleString()}）`)
  if ('error' in r) p.ui.log(`sticky-notes: Notion pull failed (${r.error})`, 'debug')
  else if (r.added > 0) p.ui.toast(`Sticky Notes：從其他電腦同步了 ${r.added} 張便利貼`)
  return text
}

/** The last sync's outcome, for /sn notion. */
export async function syncStatus(p: Ports): Promise<string | null> {
  const s = await p.store.get(await syncStatusKey(p))
  return typeof s === 'string' ? s : null
}
