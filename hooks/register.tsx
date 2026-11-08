// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { EngineInterface, HttpResponse, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, maskNewArgs, runCommand, SHORT_COMMAND, SHORT_COMMAND_SPEC } from './commands'
import { applyOptionOverrides, syncing, confirmDelete, syncPull, optionKey, prepare, readOptions, startNote, type Options } from './notes'
import { PANE_ID, PANE_TITLE, paneView } from './pane'
import type { Ports } from './ports'
import { atPrompt, listingFor, roleLine, tagFork } from './roles'
import { describeKey, findKey, keyFiles, resolveKey } from './secrets'
import { addUsage, claudeDelta, fetchDelta, readUsage, usageLine, type Usage } from './usage'

// $.state values (types/index.d.ts). The loader reads atoms only from this file's own consts.
const treeAtom = atom({ plugin: 'cc-sticky-notes', key: 'tree' } as const, null)
const selectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'selectedId' } as const, null)
const editingAtom = atom({ plugin: 'cc-sticky-notes', key: 'editingId' } as const, null)
const settingsRevAtom = atom({ plugin: 'cc-sticky-notes', key: 'settingsRev' } as const, 0)
const unreadAtom = atom({ plugin: 'cc-sticky-notes', key: 'unread' } as const, 0)
const pendingAtom = atom({ plugin: 'cc-sticky-notes', key: 'pending' } as const, 0)
const lastTurnAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastTurnId' } as const, null)
const lastPromptAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastPromptUuid' } as const, null)

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
 * The status line under the prompt (PROBE.md「UI 能放在哪裡」 D): this session's role
 * (roles.ts), what this mod spent today (usage.ts), and the answers still pending.
 * Desktop draws the plugin's name before it. Redrawn when a count, the tree, the
 * pending number or the role changes, and at session start.
 */
async function refreshStatus($: EngineInterface) {
  // the role only (11/08); the mod's own usage is in /sn doctor. Untagged: no status line
  const role = await roleLine(portsOf($)).catch(() => null)
  $.ui.status(role ?? undefined)
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
    timer: ms => {
      let cancel = () => {}
      const done = new Promise<void>(resolve => {
        const t = $.clock.after(ms, resolve)
        cancel = () => t.cancel()
      })
      return { done, cancel }
    },
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
          `這個 mod 今天用掉的（所有專案、所有 session 合計）：${usageLine(await readUsage(kvOf($), new Date()), await read($, pendingAtom))}`,
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
      invalidateSkillListing: () => $.ui.invalidate('prompt.attachment'),
    },
    state: {
      publishTree: async tree => {
        await update($, treeAtom, () => tree)
        await refreshStatus($)
      },
      lastTurnId: () => read($, lastTurnAtom),
      addPending: async delta => {
        await update($, pendingAtom, n => Math.max(0, n + delta))
        await refreshStatus($)
      },
      addUnread: async delta => void (await update($, unreadAtom, n => Math.max(0, n + delta))),
      lastPromptUuid: () => read($, lastPromptAtom),
      setSelected: async id => void (await update($, selectedAtom, () => id)),
      selected: () => read($, selectedAtom),
      refreshStatus: () => refreshStatus($),
    },
  }
}

/**
 * A card press: opens the card holding this note (null closes). Reading a card does not
 * make it the one this session follows up (10/14): a reply does.
 */
async function selectNode($: EngineInterface, id: string | null) {
  await update($, editingAtom, () => null)
  await update($, selectedAtom, () => id)
}

/** What the settings card shows; read on each draw (settingsRev makes it draw again). */
async function settingsData($: EngineInterface, opts: Options) {
  await read($, settingsRevAtom)
  return {
    autoOpenPane: opts.autoOpenPane,
    notionSync: opts.notionSync,
    notionSet: opts.notionDataSource !== '',
    provider: opts.summaryProvider,
    deckSkills: opts.deckSkills,
  }
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

/** The pane's reply box: straight to a note under that node (PLAN.md). */
async function followUp($: EngineInterface, opts: Options, parentId: string, question: string) {
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'under', parentId },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  on('session.start', async ($, e, next) => {
    await applyOptionOverrides(kvOf($), opts)
    await $.command.register(COMMAND_SPEC)
    await $.command.register(SHORT_COMMAND_SPEC)
    const p = portsOf($)
    await prepare(p)
    // the notes other computers made in this project (Notion), in the background
    if (syncing(opts)) p.later(() => void syncPull(p, opts))
    // a Desktop fork of a main holds the main's first prompt already: it is that main's sub
    await tagFork(p).catch(err => p.ui.log(`sticky-notes: fork check failed (${String(err).slice(0, 200)})`, 'debug'))
    await refreshStatus($)
    return next(e)
  })

  // The status line is set again when a screen attaches and after each main turn: a Desktop
  // fork starts with no screen attached, and per-prompt counting no longer redraws it (11/08)
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await refreshStatus($).catch(() => {})
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await refreshStatus($).catch(() => {})
    return r
  })

  on('turn.start', async ($, e, next) => {
    await update($, lastTurnAtom, () => e.turnId)
    return next(e)
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
    // every prompt goes to the main line (11/05: no per-prompt routing); a new session's
    // first one may get a role first, and a role's first prompt carries its working rules
    const p = portsOf($)
    let brief: string | null = null
    try {
      brief = await atPrompt(p, { text: e.text, origin: e.origin.kind, isCommand: e.command !== undefined })
    } catch (err) {
      p.ui.log(`sticky-notes: session role check failed (${String(err).slice(0, 200)})`, 'debug')
    }
    return next(brief === null ? e : { ...e, context: [...(e.context ?? []), brief] })
  })

  // the deck skills only in a 統整 session's listing (R8 decision 3: untagged go without);
  // the listing itself is never logged
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const r = await next(e)
    if (typeof r.text !== 'string') return r
    try {
      const text = await listingFor(portsOf($), r.text, opts.deckSkills)
      return text === r.text ? r : { ...r, text }
    } catch {
      return r
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(portsOf($), opts, e.args))
  // /sn: the keyboard shortcut for the pane (the status line cannot be clicked; PROBE.md)
  on('command.run', { command: SHORT_COMMAND }, async ($, e) => runCommand(portsOf($), opts, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const data = {
      tree: await read($, treeAtom),
      selectedId: await read($, selectedAtom),
      editingId: await read($, editingAtom),
      sessionId: await $.session.id(),
      pending: await read($, pendingAtom),
      surface: e.surface,
      settings: await settingsData($, opts),
    }
    return paneView($.ui.resolve(e), data, {
      select: id => void selectNode($, id),
      edit: id => void update($, editingAtom, () => id),
      followUp: (parentId, question) => void followUp($, opts, parentId, question),
      rewrite: (nodeId, question) => void rewrite($, opts, nodeId, question),
      remove: nodeId => void confirmDelete(portsOf($), opts, nodeId),
      // the settings card: this machine's own setting, at once
      setSetting: (field, value) => {
        const p = portsOf($)
        void (async () => {
          const r = await p.setOption(field, value)
          if (!r.ok) return p.ui.toast(`Sticky Notes：沒有改成功（${r.reason}）`)
          ;(opts as Record<string, unknown>)[field] = value
          await update($, settingsRevAtom, n => n + 1)
        })()
      },
    })
  })
}
