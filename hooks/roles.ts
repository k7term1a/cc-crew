// Session roles (PLAN.md「11/05 改版」): a project's main session, the sub sessions
// forked from it, and 統整 sessions that read only the project's documents.
//
// One $.store key per session, `role:<projectKey>:<sessionId>`, so two sessions tagging
// at once never overwrite each other (PROBE.md P3); a project's roles are listed by
// prefix. The hooks live in register.tsx; everything here goes through Ports.
//
// Where each piece comes from (PROBE.md「〇之九」): a Desktop fork copies the parent's
// records and gets a new id, and holds them already at `session.start`, so a sub is
// recognised by its first user message (mods see message text, not uuids). The working
// rules go with a prompt as `context` (hook_additional_context). Every dialog has at
// least two options (Desktop pads a single one with a stray "Yes").
import type { SessionMessage } from 'claude-code'

import { callJev, type JevRequest } from './jev'
import type { Ports } from './ports'
import { normalizeRoot } from './tree'

export type Role = 'main' | 'sub' | 'synthesis'
/**
 * A main's documents, relative to the project root: the record (main writes it), the progress
 * log and the evidence folder (subs write them), and the external folder (11/11: what the person
 * brings in, e.g. deep research or a changed spec; read once, folded into the record).
 */
export type Docs = { record: string; progress: string; evidence: string; external: string }
export type RoleEntry = {
  role: Role
  /** The main a sub or 統整 belongs to; null for a main. */
  parentId: string | null
  taggedAt: number
  /** A main's name, as the dialogs and the status line show it. */
  name?: string
  /** A main's documents (paths relative to the project root). */
  docs?: Partial<Docs> & Omit<Docs, 'external'>
  /** A main's first prompt, normalized and cut (fingerprintOf): what its forks start with. */
  fingerprint?: string
  /** Whether the working rules went with a prompt since the role was set. */
  briefed?: boolean
  /** A main's external folder entries already announced to it (11/11). */
  externalSeen?: string[]
  /**
   * A main tagged mid-conversation that leaves its documents to the session (11/09): its brief
   * asks it to find the project's records, propose paths and write the first record; the person
   * sets them with `/sn docs`. `docs` holds the defaults until then.
   */
  docsPending?: boolean
}

export const ROLE_LABEL: Record<Role, string> = { main: 'main', sub: 'sub', synthesis: '統整' }
export const DEFAULT_DOCS: Docs = { record: 'docs/RECORD.md', progress: 'docs/progress.jsonl', evidence: 'docs/evidence/', external: 'docs/external/' }
export const DOCS_OPTIONS = ['docs/RECORD.md, docs/progress.jsonl, docs/evidence/, docs/external/', 'RECORD.md, progress.jsonl, evidence/, external/'] as const

/** The four paths, the external folder beside the record when an older entry has none. */
export function fullDocs(d: Partial<Docs> & Omit<Docs, 'external'>): Docs {
  const dir = d.record.includes('/') ? d.record.slice(0, d.record.lastIndexOf('/') + 1) : ''
  return { record: d.record, progress: d.progress, evidence: d.evidence, external: d.external ?? dir + 'external/' }
}

/** A path under the project root (one typed absolute is kept). */
export function underRoot(root: string, rel: string): string {
  if (/^([a-zA-Z]:)?[\\/]/.test(rel)) return rel
  return root.replace(/[\\/]+$/, '') + '/' + rel
}
/** The deck skills only a 統整 session's listing keeps (REQUESTS.md R8 decision 2); the plugin option `deckSkills`. */
export const DEFAULT_DECK_SKILLS = ['research-report-writing', 'anthropic-skills:deckframes', 'anthropic-skills:pptx', 'anthropic-skills:docx', 'anthropic-skills:docs'] as const
/** How long a dialog at a prompt may stay unanswered before the prompt goes on untagged. */
export const ASK_TIMEOUT_MS = 60_000
export const FINGERPRINT_CHARS = 200
/** Jev reads worse past a few thousand characters (PLAN.md「Jev 分類設計」). */
export const CLASSIFY_CHARS = 1500
const NAME_CHARS = 20
const MAX_MAINS = 3
const CANCEL = '取消'
const NONE = '不用'
const YES_MAIN = '要，標成 main'
const HEADER = 'session 角色'

export const roleKey = (root: string, sessionId: string) => `role:${root}:${sessionId}`
/**
 * A session that must not be taken for a fork: cleared with /sn tag, or one whose own
 * first prompt matched a main's and stayed untagged (a resume would read it as a fork).
 */
export const notForkKey = (root: string, sessionId: string) => `role-none:${root}:${sessionId}`

/** `a, b ,c` → ['a', 'b', 'c']; empty or not a string → the default list. */
export function parseDeckSkills(v: unknown): string[] {
  const list = typeof v === 'string' ? v.split(/[,，]/).map(s => s.trim()).filter(s => s !== '') : []
  return list.length > 0 ? list : [...DEFAULT_DECK_SKILLS]
}

export const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => [...s].slice(0, n).join('')
export const fingerprintOf = (s: string) => cut(normalizeText(s), FINGERPRINT_CHARS)

/** The records slash commands leave as user messages; never a first prompt. */
const COMMAND_RECORD = /^<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/

/** The first message the person wrote: not a tool result, not a command's record. */
export function firstUserText(messages: readonly SessionMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user' || (m.toolResults?.length ?? 0) > 0) continue
    const t = m.text.trim()
    if (t === '' || COMMAND_RECORD.test(t)) continue
    return m.text
  }
  return null
}

/** Whether a request has been answered (then the listing and the first context were sent). */
export const hasReply = (messages: readonly SessionMessage[]) => messages.some(m => m.role === 'assistant')

const ROLES: readonly Role[] = ['main', 'sub', 'synthesis']

function asEntry(v: unknown): RoleEntry | null {
  const e = v as RoleEntry | null | undefined
  if (!e || typeof e !== 'object' || !ROLES.includes(e.role) || typeof e.taggedAt !== 'number') return null
  return e
}

type Me = { root: string; id: string; entry: RoleEntry | null }

export async function myRole(p: Ports): Promise<Me> {
  // notes.ts projectKey, spelled here so notes.ts can read this module's option parser
  const root = normalizeRoot(await p.projectRoot())
  const id = await p.sessionId()
  return { root, id, entry: asEntry(await p.store.get(roleKey(root, id))) }
}

/** Every tagged session of the project, by its key prefix. */
export async function projectRoles(p: Ports, root: string): Promise<{ id: string; entry: RoleEntry }[]> {
  const prefix = `role:${root}:`
  const out: { id: string; entry: RoleEntry }[] = []
  for (const key of await p.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const id = key.slice(prefix.length)
    if (id === '' || id.includes(':')) continue // another project whose key starts with this one's
    const entry = asEntry(await p.store.get(key))
    if (entry) out.push({ id, entry })
  }
  return out
}

/** The project's mains, newest first, without the given session. */
export async function mainsOf(p: Ports, root: string, exceptId: string): Promise<{ id: string; entry: RoleEntry }[]> {
  return (await projectRoles(p, root)).filter(r => r.entry.role === 'main' && r.id !== exceptId).sort((a, b) => b.entry.taggedAt - a.entry.taggedAt)
}

const mainName = (id: string, e: RoleEntry | null | undefined) => (e?.name !== undefined && e.name !== '' ? e.name : id.slice(0, 8))

async function entryOf(p: Ports, root: string, id: string | null): Promise<RoleEntry | null> {
  return id === null ? null : asEntry(await p.store.get(roleKey(root, id)))
}

/** Three or four comma-separated paths (紀錄, 進度, 證據[, 外部]); null when it is not that. */
export function docsFrom(text: string): Docs | null {
  const parts = text.split(/[,，]/).map(s => s.trim()).filter(s => s !== '')
  if (parts.length !== 3 && parts.length !== 4) return null
  const [record, progress, evidence, external] = parts as [string, string, string, string | undefined]
  return fullDocs({ record, progress, evidence, ...(external !== undefined ? { external } : {}) })
}

/** The paths as picked or typed, else the defaults. */
export function parseDocs(answer: string): Docs {
  return docsFrom(answer) ?? { ...DEFAULT_DOCS }
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** `11-05 14:03`, local time. */
export function shortTime(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** The last path segment of the project root: a main's second name to offer. */
function folderName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(s => s !== '')
  return parts[parts.length - 1] ?? root
}

// ---- dialogs ----

/** null: dismissed, timed out, or (with a timeout) answered too late. */
type Ask = (question: string, options: readonly string[], header: string) => Promise<string | null>

/**
 * $.ui.ask that never throws; with a timeout (at a prompt), unanswered by then is null and
 * the dialog stays where it is (a mod cannot take one down). /sn tag waits: a dialog left
 * open after its command returned keeps Desktop spinning (PROBE.md「〇之九」).
 */
function dialogs(p: Ports, timeoutMs: number | null): Ask {
  return async (question, options, header) => {
    if (options.length < 2) throw new Error('a dialog needs two options at least')
    const asked = p.ui.ask(question, options, header).then(
      a => a,
      () => null,
    )
    if (timeoutMs === null) return asked
    const timer = p.timer(timeoutMs)
    const first = await Promise.race([asked.then(answer => ({ answer })), timer.done.then(() => null)])
    if (first === null) {
      p.ui.toast(`Sticky Notes：${Math.round(timeoutMs / 1000)} 秒沒有回應，這個 session 先不標角色（之後可以打 /sn tag）`)
      return null
    }
    timer.cancel()
    return first.answer
  }
}

/**
 * The parent pick: the newest mains as `<name>（<MM-DD HH:mm> 標記）` and a way out.
 * Two mains of one name and minute get their ids to tell them apart.
 */
async function askParent(ask: Ask, mains: { id: string; entry: RoleEntry }[], question: string, out: string): Promise<string | null> {
  const shown = mains.slice(0, MAX_MAINS)
  const labels = shown.map(m => `${mainName(m.id, m.entry)}（${shortTime(m.entry.taggedAt)} 標記）`)
  const labelled = labels.map((l, i) => (labels.indexOf(l) !== i || labels.lastIndexOf(l) !== i ? `${l} ${shown[i]!.id.slice(0, 8)}` : l))
  const answer = await ask(question, [...labelled, out], HEADER)
  const i = answer === null ? -1 : labelled.indexOf(answer)
  return i < 0 ? null : shown[i]!.id
}

/** The docs dialog's third option, for a session tagged main mid-conversation. */
export const ORGANIZE_DOCS = '讓這個 session 先整理再決定'

/** A main's name, then its documents; null when either dialog was left. */
async function askMain(p: Ports, ask: Ask, firstPrompt: string | null, talked = false): Promise<{ name: string; docs: Docs; docsPending: boolean } | null> {
  const candidates = [...new Set([firstPrompt === null ? '' : cut(normalizeText(firstPrompt), NAME_CHARS), folderName(await p.projectRoot())].filter(s => s !== ''))]
  const options = candidates.length >= 2 ? candidates : [...candidates, CANCEL]
  const named = await ask('這個 main 要叫什麼名字？要用別的名字就選「其他」自己打。', options, 'main 名稱')
  if (named === null || (named === CANCEL && !candidates.includes(CANCEL))) return null
  const name = cut(normalizeText(named), 40) || candidates[0] || 'main'
  const docsAnswer = await ask(
    talked
      ? '專案文件放在哪裡？要改就選「其他」，依序打紀錄檔、進度檔、證據資料夾、外部資料夾，用逗號分開。不確定的話，選最後一項：這個 session 會先找專案裡現有的紀錄、提議路徑、把到目前為止的對話整理成第一份紀錄。'
      : '專案文件放在哪裡？要改就選「其他」，依序打紀錄檔、進度檔、證據資料夾、外部資料夾，用逗號分開。外部資料夾放你帶進來的東西（深入研究、規範更新），main 讀一次後整理進紀錄檔。',
    talked ? [...DOCS_OPTIONS, ORGANIZE_DOCS] : [...DOCS_OPTIONS],
    '文件路徑',
  )
  if (docsAnswer === null) return null
  if (talked && docsAnswer === ORGANIZE_DOCS) return { name, docs: { ...DEFAULT_DOCS }, docsPending: true }
  return { name, docs: parseDocs(docsAnswer), docsPending: false }
}

// ---- first-prompt classification (Jev) ----

export type SessionKind = 'kickoff' | 'synthesis' | 'other'

export function kindRequest(prompt: string): JevRequest {
  const text = [...prompt].length > CLASSIFY_CHARS ? cut(prompt, CLASSIFY_CHARS) + '…' : prompt
  return {
    state: ['[first prompt of a new Claude Code session]', text].join('\n'),
    questions: {
      session_kind: {
        type: 'choice',
        instructions: 'What does this first prompt of a new coding session do?',
        criteria: {
          kickoff:
            "The person pastes a project's starting context (goals, background, plan, constraints) to align on before work starts",
          synthesis:
            "Asks to summarize, consolidate or report on the project's progress, results or records so far, e.g. for slides or a report",
          other: 'Anything else: a task, a question, a fix, small talk',
        },
      },
    },
  }
}

export function parseKind(body: unknown): SessionKind | null {
  const choice = (body as { answers?: { session_kind?: { choice?: unknown } } } | null)?.answers?.session_kind?.choice
  return choice === 'kickoff' || choice === 'synthesis' || choice === 'other' ? choice : null
}

/** One Jev call; null without a key or when Jev could not say (the prompt goes on either way). */
export async function classifyFirst(p: Ports, prompt: string): Promise<SessionKind | null> {
  const r = await callJev({ key: await p.keys.typesafe(), fetch: p.fetch, now: p.now }, kindRequest(prompt))
  if (!r.ok) {
    if (r.reason !== 'no-key') p.ui.log(`sticky-notes: Jev unavailable for the first prompt (${r.reason}${r.status ? ` ${r.status}` : ''})`, 'debug')
    return null
  }
  const kind = parseKind(r.body)
  if (kind === null) p.ui.log('sticky-notes: Jev answered the first prompt in a shape the mod does not know', 'debug')
  return kind
}

/** What Jev's kind leads to: the dialogs at a first prompt, and the role they gave (null: none). */
async function offerRole(p: Ports, root: string, id: string, prompt: string): Promise<RoleEntry | null> {
  const kind = await classifyFirst(p, prompt)
  if (kind === null || kind === 'other') return null
  const ask = dialogs(p, ASK_TIMEOUT_MS)
  if (kind === 'kickoff') {
    const yes = await ask('這看起來是專案啟動的上下文。要讓 mod 共同管理嗎？（之後從這個 session fork 出來的會自動標成 sub）', [YES_MAIN, NONE], HEADER)
    if (yes !== YES_MAIN) return null
    const main = await askMain(p, ask, prompt)
    if (main === null) return null
    return { role: 'main', parentId: null, taggedAt: await p.now(), name: main.name, docs: main.docs, fingerprint: fingerprintOf(prompt), briefed: false }
  }
  const mains = await mainsOf(p, root, id)
  if (mains.length === 0) return null
  const parentId = await askParent(ask, mains, '這看起來是統整需求。要標成統整 session 嗎？選它屬於哪一個 main：', NONE)
  if (parentId === null) return null
  return { role: 'synthesis', parentId, taggedAt: await p.now(), briefed: false }
}

/** Whether this text starts like the first prompt of one of the project's mains. */
async function forkParent(p: Ports, root: string, id: string, first: string): Promise<string | null> {
  const text = normalizeText(first)
  const hit = (await mainsOf(p, root, id)).find(m => m.entry.fingerprint !== undefined && m.entry.fingerprint !== '' && text.includes(m.entry.fingerprint))
  return hit?.id ?? null
}

export type SubmitInput = { text: string; origin: string; isCommand: boolean }

/**
 * prompt.submit: a new session's first typed prompt is classified (one Jev call, then the
 * dialogs); a session with a role and no brief yet gets its working rules with this
 * prompt, of any origin. Returns the context to attach (null: none). Never throws for
 * the prompt's sake: the caller sends it on whatever this says.
 */
export async function atPrompt(p: Ports, e: SubmitInput): Promise<string | null> {
  const { root, id, entry } = await myRole(p)
  let me = entry
  let messages: readonly SessionMessage[] | null = null
  const read = async () => (messages ??= await p.messages())
  if (me === null) {
    const typed = e.origin === 'composer' || e.origin === 'bridge'
    if (!typed || e.isCommand || e.text.trim() === '' || e.text.trimStart().startsWith('/')) return null
    if (hasReply(await read())) return null
    me = await offerRole(p, root, id, e.text)
    if (me === null) {
      // its own first prompt, so not a fork, even when it reads like a main's
      if ((await forkParent(p, root, id, e.text)) !== null) await p.store.set(notForkKey(root, id), { at: await p.now() })
      return null
    }
    await p.store.set(roleKey(root, id), me)
    await ensureExternal(p, me)
    // nothing was sent yet: the first request's listing can still follow the role
    p.ui.invalidateSkillListing()
    await p.state.refreshStatus()
  }
  if (e.isCommand || e.text.trim() === '') return null
  // a main tagged before its first prompt: that prompt is what its forks will start with
  const fingerprint = me.role === 'main' && (me.fingerprint ?? '') === '' ? fingerprintOf(firstUserText(await read()) ?? e.text) : me.fingerprint
  let brief: string | null = null
  if (me.briefed !== true || fingerprint !== me.fingerprint) {
    brief = me.briefed === true ? null : await briefOf(p, root, id, me)
    me = { ...me, ...(fingerprint !== undefined ? { fingerprint } : {}), briefed: true }
    await p.store.set(roleKey(root, id), me)
  }
  // 11/11: the external folder (made for a main tagged before it existed), and what the person
  // put in it since, told once
  await ensureExternal(p, me)
  const notice = await externalNotice(p, root, id, me).catch(() => null)
  const parts = [brief, notice].filter((x): x is string => x !== null)
  return parts.length === 0 ? null : parts.join('\n\n')
}

/**
 * session.start: an untagged session that already holds messages, whose first user message
 * carries a main's fingerprint and whose id is not that main's, is a Desktop fork of it: sub.
 */
export async function tagFork(p: Ports): Promise<RoleEntry | null> {
  const { root, id, entry } = await myRole(p)
  if (entry !== null) return null
  const messages = await p.messages()
  if (messages.length === 0) return null
  const first = firstUserText(messages)
  if (first === null) return null
  if ((await p.store.get(notForkKey(root, id))) !== undefined) return null
  const parentId = await forkParent(p, root, id, first)
  if (parentId === null) return null
  const sub: RoleEntry = { role: 'sub', parentId, taggedAt: await p.now(), briefed: false }
  await p.store.set(roleKey(root, id), sub)
  if (!hasReply(messages)) p.ui.invalidateSkillListing()
  return sub
}

// ---- the brief ----

/** What a main tagged mid-conversation does first, when the person left the documents to it. */
const ORGANIZE_STEPS = [
  '',
  '這個 session 是聊到一半才標成 main 的，文件路徑還沒定。上面的路徑是預設值，先不要照著寫。先做這幾件事，再回到原本的工作：',
  '1. 找專案裡現有的紀錄類檔案（交接、筆記、進度、決策、實驗紀錄之類），列出路徑和各自的內容大概是什麼。',
  '2. 提議哪個當紀錄檔（決定與現況，只有 main 寫）、哪個當進度檔（sub 一行一個 JSON 的執行紀錄）、證據放哪個資料夾、使用者帶進來的外部資料（深入研究、規範更新）放哪個資料夾。沒有合適的就用上面的預設值。問使用者同不同意。',
  '3. 使用者同意後，把到目前為止的對話整理進紀錄檔：做過的決定、目前狀態、還沒做完的事、要使用者決定的事，每一條附上日期。已經有的內容不要刪，用補的。',
  '4. 請使用者打「/sn docs <紀錄>, <進度>, <證據>, <外部>」，把路徑告訴 mod；之後 fork 出來的 sub 和統整 session 才會拿到這組路徑。',
]

/** What the external folder's README says (written once, when the folder does not exist). */
export function externalReadme(d: Docs): string {
  return [
    '# 外部資料',
    '',
    '這個資料夾放你從外面帶進來的東西：深入研究的結果、規範或需求的更新、別人給的文件。',
    '',
    '- 檔名開頭放日期，例如 2026-11-11-主題.md。原始內容照原樣放，不要改。',
    `- main session 會在下一句收到「有新檔」的通知，讀一次，把需要的內容更新進 ${d.record}，並記一條：日期、檔名、採用哪些、不採用哪些與原因。之後不再讀它。`,
    '- 這個 README 由 cc-sticky-notes 建立，可以刪。',
    '',
  ].join('\n')
}

/** Makes a main's external folder (with its README) when it is missing; never throws. */
export async function ensureExternal(p: Ports, me: RoleEntry): Promise<void> {
  if (me.role !== 'main' || me.docsPending === true) return
  try {
    const d = fullDocs(me.docs ?? DEFAULT_DOCS)
    const dir = underRoot(await p.projectRoot(), d.external)
    if (await p.files.exists(dir)) return
    await p.files.write(dir.replace(/[\\/]+$/, '') + '/README.md', externalReadme(d))
  } catch {
    // a folder the mod could not make: the brief still names it
  }
}

/** Entries of the external folder a main has not been told of: README and dot-files aside. */
export async function externalNotice(p: Ports, root: string, id: string, me: RoleEntry): Promise<string | null> {
  if (me.role !== 'main' || me.docsPending === true) return null
  const d = fullDocs(me.docs ?? DEFAULT_DOCS)
  const names = (await p.files.list(underRoot(await p.projectRoot(), d.external))) ?? []
  const shown = names.filter(n => n !== 'README.md' && !n.startsWith('.')).sort()
  const seen = new Set(me.externalSeen ?? [])
  const fresh = shown.filter(n => !seen.has(n))
  if (fresh.length === 0) return null
  await p.store.set(roleKey(root, id), { ...me, externalSeen: shown })
  const list = fresh.slice(0, 10).map(n => d.external.replace(/[\\/]*$/, '/') + n).join('、') + (fresh.length > 10 ? ` 等 ${fresh.length} 個` : '')
  return `[sticky-notes] ${d.external} 有新的外部資料：${list}。每個檔讀一次，把需要的內容（決定、規範、要做的事）更新進 ${d.record}，並在 ${d.record} 記一條：日期、檔名、採用哪些、不採用哪些與原因。`
}

/** The working rules a role's session gets with its next prompt (Traditional Chinese, short). */
export async function briefOf(p: Ports, root: string, id: string, me: RoleEntry): Promise<string> {
  const where = await p.projectRoot()
  const parent = me.role === 'main' ? me : await entryOf(p, root, me.parentId)
  const d = fullDocs((me.role === 'main' ? me.docs : parent?.docs) ?? DEFAULT_DOCS)
  const paths = `（路徑都相對於專案根目錄 ${where}）`
  if (me.role === 'main') {
    return [
      `[sticky-notes] 這個 session 是這個專案的 main session「${mainName(id, me)}」（id ${id}）。`,
      '- 和使用者的討論在這裡進行。',
      '- 需要實作時，用 SendMessage 交給從這個 session fork 出來的 sub session（Desktop 會把 fork 列成連結的 session）；大段的實作不要自己做。',
      `- sub 回報後，把結果整理進 ${d.record}。${d.record} 只由 main 寫。`,
      `- ${d.progress} 和 ${d.evidence} 是 sub 寫的地方。`,
      `- ${d.external} 放使用者帶進來的外部資料（深入研究、規範更新等）。有新檔時 mod 會在那一句告訴你；每個檔讀一次，把需要的內容更新進 ${d.record}，並記一條：日期、檔名、採用哪些、不採用哪些與原因。之後不用再讀它。${paths}`,
      ...(me.docsPending === true ? ORGANIZE_STEPS : []),
    ].join('\n')
  }
  const pid = me.parentId ?? '（未指定）'
  const pname = me.parentId === null ? '（未指定）' : mainName(me.parentId, parent)
  if (me.role === 'sub') {
    return [
      `[sticky-notes] 這個 session 是 main「${pname}」（id ${pid}）的 sub session。`,
      '- 做 main 用 SendMessage 交給你的實作。',
      `- 執行結果和要記錄的東西寫進 ${d.progress}（一行一個 JSON 物件）和 ${d.evidence}。`,
      `- 不要改 ${d.record}（只由 main 寫）和 ${d.external}（使用者放的外部資料）。`,
      `- 做完用 SendMessage 回報給 main（${pid}）。${paths}`,
    ].join('\n')
  }
  return [
    `[sticky-notes] 這個 session 是統整 session，屬於 main「${pname}」（id ${pid}）。`,
    `- 只讀 ${d.record}、${d.progress}、${d.evidence}，不讀 main 的對話。${d.external} 是使用者帶進來的外部原始資料（深入研究、規範更新），main 已經整理進 ${d.record}；只有紀錄檔引用到、需要查原文時才讀。`,
    '- 只根據這些文件回答，每個說法都附上出自哪個檔。文件沒寫的，回答「文件裡沒有」，不要猜，並把缺的項目寫進專案根目錄的 GAPS.md。',
    `- 討論出結果時，寫進對應的文件，再用 SendMessage 回報給 main（${pid}）。${paths}`,
  ].join('\n')
}

// ---- /sn tag ----

const PICKS: Record<string, Role> = { main: 'main', sub: 'sub', 統整: 'synthesis' }

/**
 * /sn tag: every dialog awaited here, the outcome as the command's text (a dialog left
 * open after the command returned keeps Desktop spinning, PROBE.md「〇之九」).
 */
export async function tagCommand(p: Ports): Promise<string> {
  const { root, id, entry } = await myRole(p)
  const ask = dialogs(p, null)
  const pick = await ask('這個 session 要標成哪個角色？', ['main', 'sub', '統整', '清除'], HEADER)
  if (pick === null) return '沒有改變這個 session 的角色'
  const messages = await p.messages()
  const sent = hasReply(messages)
  const changed = async () => {
    if (!sent) p.ui.invalidateSkillListing()
    await p.state.refreshStatus()
  }
  if (pick === '清除') {
    await p.store.delete(roleKey(root, id))
    await p.store.set(notForkKey(root, id), { at: await p.now() })
    await changed()
    return entry === null ? '這個 session 本來就沒有角色' : '已清除這個 session 的角色'
  }
  const role = PICKS[pick]
  if (role === undefined) return `沒有改變這個 session 的角色（回答是「${cut(pick, 20)}」）`
  let next: RoleEntry
  if (role === 'main') {
    const first = firstUserText(messages)
    const main = await askMain(p, ask, first, sent)
    if (main === null) return '沒有改變這個 session 的角色'
    next = { role, parentId: null, taggedAt: await p.now(), name: main.name, docs: main.docs, briefed: false }
    if (main.docsPending) next.docsPending = true
    // none yet (tagged before the first prompt): that prompt gives it (atPrompt)
    if (first !== null) next.fingerprint = fingerprintOf(first)
  } else {
    const mains = await mainsOf(p, root, id)
    if (mains.length === 0) return `這個專案還沒有 main。先在 main session 打 /sn tag 標成 main，再回來標${ROLE_LABEL[role]}。`
    const parentId = await askParent(ask, mains, `這個${ROLE_LABEL[role]} session 屬於哪一個 main？`, CANCEL)
    if (parentId === null) return '沒有改變這個 session 的角色'
    next = { role, parentId, taggedAt: await p.now(), briefed: false }
  }
  await p.store.set(roleKey(root, id), next)
  await ensureExternal(p, next)
  await changed()
  const shown = role === 'main' ? `main「${next.name}」` : `${ROLE_LABEL[role]}，屬於 main「${mainName(next.parentId!, await entryOf(p, root, next.parentId))}」`
  const keepsListing = sent && (role === 'synthesis') !== (entry?.role === 'synthesis')
  return [
    `這個 session 標成 ${shown}。下一句會帶上這個角色的工作規則。`,
    ...(next.docsPending === true ? ['文件路徑還沒定：下一句起，這個 session 會先找專案裡現有的紀錄、提議路徑，你同意後它整理出第一份紀錄。定好後打 /sn docs <紀錄>, <進度>, <證據>, <外部>。'] : []),
    ...(keepsListing ? ['這個 session 已經送出過請求，skill 清單不回頭改（改了會讓快取失效）；簡報類 skill 要用就手打 /名字，或開一個新的統整 session。'] : []),
  ].join('\n')
}

// ---- the skill listing and the status line ----

/** A listing line `- <name>: …` (names may hold a colon, `plugin:skill`). */
const ENTRY = /^\s*-\s+(\S+?):\s/

/** The listing without the named skills' entries; an entry runs to the next `- name:` line. */
export function dropSkills(text: string, names: readonly string[]): { text: string; removed: string[] } {
  const kept: string[] = []
  const removed: string[] = []
  let dropping = false
  for (const line of text.split('\n')) {
    const m = ENTRY.exec(line)
    if (m) {
      const name = m[1] ?? ''
      dropping = names.includes(name)
      if (dropping) removed.push(name)
    }
    if (!dropping) kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

/** The listing this session's requests carry: the deck skills only for 統整 (untagged too go without, R8 decision 3). */
export async function listingFor(p: Ports, text: string, deck: readonly string[]): Promise<string> {
  const { entry } = await myRole(p)
  if (entry?.role === 'synthesis') return text
  const r = dropSkills(text, deck)
  return r.removed.length > 0 ? r.text : text
}

/** `main「名稱」`, `sub ← 名稱`, `統整 ← 名稱`; null untagged. */
export async function roleLine(p: Ports): Promise<string | null> {
  const { root, id, entry } = await myRole(p)
  if (entry === null) return null
  if (entry.role === 'main') return `main「${mainName(id, entry)}」`
  const parent = await entryOf(p, root, entry.parentId)
  return `${ROLE_LABEL[entry.role]} ← ${entry.parentId === null ? '?' : mainName(entry.parentId, parent)}`
}

// ---- /sn docs ----

/**
 * `/sn docs <紀錄>, <進度>, <證據>[, <外部>]` in a main: its documents. Its subs and 統整 sessions that had
 * their rules already get them again, with the new paths, on their next prompt. No args: the paths.
 */
export async function docsCommand(p: Ports, args: string): Promise<string> {
  const { root, id, entry } = await myRole(p)
  if (entry === null || entry.role !== 'main') {
    const parent = entry === null ? null : await entryOf(p, root, entry.parentId)
    return parent === null
      ? '/sn docs 要在 main session 裡打（這個 session 不是 main）。'
      : `文件路徑由 main 決定。這個 session 屬於 main「${mainName(entry!.parentId!, parent)}」，目前是：${showDocs(fullDocs(parent.docs ?? DEFAULT_DOCS))}`
  }
  const cur = fullDocs(entry.docs ?? DEFAULT_DOCS)
  if (args.trim() === '') return `main「${mainName(id, entry)}」的文件：${showDocs(cur)}${entry.docsPending === true ? '（還沒定，這是預設值）' : ''}\n改：/sn docs default（docs/ 底下的預設），或 /sn docs <紀錄>, <進度>, <證據>, <外部>`
  const docs = args.trim().toLowerCase() === 'default' ? { ...DEFAULT_DOCS } : docsFrom(args)
  if (docs === null) return '用法：/sn docs default（docs/ 底下的預設），或 /sn docs <紀錄>, <進度>, <證據>, <外部>（用逗號分開，相對於專案根目錄；只給三個時，外部資料夾放在紀錄檔旁邊的 external/）'
  const next: RoleEntry = { ...entry, docs }
  delete next.docsPending
  await p.store.set(roleKey(root, id), next)
  await ensureExternal(p, next)
  // the ones that already have the old paths get their rules again
  const told: string[] = []
  for (const r of await projectRoles(p, root)) {
    if (r.entry.parentId !== id || r.entry.briefed !== true) continue
    await p.store.set(roleKey(root, r.id), { ...r.entry, briefed: false })
    told.push(ROLE_LABEL[r.entry.role])
  }
  return [
    `main「${mainName(id, entry)}」的文件改成：${showDocs(docs)}`,
    ...(told.length > 0 ? [`已經拿到舊路徑的 ${told.length} 個 session（${told.join('、')}）會在它們的下一句收到新路徑。`] : []),
  ].join('\n')
}

const showDocs = (d: Docs) => `紀錄 ${d.record}、進度 ${d.progress}、證據 ${d.evidence}、外部 ${d.external}`
