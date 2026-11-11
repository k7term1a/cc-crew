// /sticky-note and its subcommands.
// A command's `{ text }` is a transcript row the model also reads, so anything
// long or private goes to $.ui.log / toast instead and the command returns {}.
import type { CommandRunResult } from 'claude-code'

import { notionProbe } from './notion'
import { change, confirmDelete, dropReason, syncPull, syncPushAll, syncStatus, startNote, type Options } from './notes'
import type { Ports } from './ports'
import { docsCommand, tagCommand } from './roles'
import { setActive } from './tree'

export const COMMAND = 'sticky-note'

export const COMMAND_SPEC = {
  name: COMMAND,
  description: 'Sticky Notes: session roles (tag main / sub / 統整) and sticky notes: open/close the pane, or tag | docs | new | back | rm | provider | notion | doctor',
  argumentHint: '[tag | docs [default | <紀錄>, <進度>, <證據>, <外部>] | new <問題> | back | rm | provider claude|openai | notion … | doctor]',
}

/**
 * /sn: the keyboard way to the pane. The status line cannot be clicked, a plugin
 * button's hotkey works only while its site has the focus, and keybindings.json
 * has no "run a command" action (PROBE.md), so a two-letter command is the shortcut.
 * Takes the same subcommands as /sticky-note.
 */
export const SHORT_COMMAND = 'sn'

export const SHORT_COMMAND_SPEC = {
  name: SHORT_COMMAND,
  description: 'Sticky Notes: open/close the pane, tag this session main / sub / 統整 (short for /sticky-note)',
  argumentHint: '[tag | docs … | new <問題> | back | rm | provider claude|openai | notion …]',
}

const LATER: Record<string, string> = {
  promote: 'M2',
  outline: 'M3',
  refresh: 'M3',
  digest: 'M3',
  export: 'M3',
  mode: 'M4',
  stats: 'M4',
}

export function parseArgs(args: string): { sub: string; rest: string } {
  const m = /^\s*(\S*)\s*([\s\S]*)$/.exec(args)
  return { sub: (m?.[1] ?? '').toLowerCase(), rest: (m?.[2] ?? '').trim() }
}

/** The args a /sticky-note new record keeps in the transcript (PROBE.md P10). */
export const NEW_ARGS_MASK = 'new (sticky note)'

/**
 * Rewrites the transcript record of `/sticky-note new <問題>` so the question
 * does not stay in the main context. Returns null when the text is not that record.
 */
export function maskNewArgs(text: string): string | null {
  if (!text.includes(`<command-name>/${COMMAND}</command-name>`) && !text.includes(`<command-name>/${SHORT_COMMAND}</command-name>`)) return null
  const re = /<command-args>\s*new\b[\s\S]*?<\/command-args>/
  return re.test(text) ? text.replace(re, `<command-args>${NEW_ARGS_MASK}</command-args>`) : null
}

export async function runCommand(p: Ports, opts: Options, args: string): Promise<CommandRunResult> {
  const { sub, rest } = parseArgs(args)
  switch (sub) {
    case '': {
      if (await p.ui.isPaneOpen()) await p.ui.closePane()
      else await p.ui.openPane()
      return {}
    }
    case 'docs':
      return { text: await docsCommand(p, rest) }
    case 'tag':
      // this session's role: every dialog awaited, the outcome as the command's own row
      return { text: await tagCommand(p) }
    case 'new': {
      if (rest === '') return { text: '用法：/sticky-note new <問題>' }
      await startNote(p, opts, {
        question: rest,
        attach: { kind: 'root' },
        answerer: 'fork',
        route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
      })
      p.ui.toast(dropReason(rest))
      return {}
    }
    case 'rm': {
      // the note the pane has open (its thread runs through it), as ✕ does
      const id = await p.state.selected()
      if (id === null || id.startsWith('__')) return { text: '先在 pane 點開要刪的便利貼（或在問題旁按 ✕）' }
      const n = await confirmDelete(p, opts, id)
      return n > 0 ? {} : { text: '沒有刪除' }
    }
    case 'back': {
      const sessionId = await p.sessionId()
      await change(p, t => setActive(t, sessionId, null))
      return {}
    }
    case 'notion': {
      // /sn notion <collection://… or a database URL>: where the notes sync; /sn notion test: can the mod reach it
      const [verb = ''] = rest.split(/\s+/)
      if (verb === 'test') {
        if (opts.notionDataSource === '') return { text: '還沒設定 Notion 資料庫：/sn notion <collection://…>' }
        return { text: ['Notion 測試：', ...(await notionProbe(p, opts.notionDataSource))].join('\n') }
      }
      if (verb === 'pull' || verb === 'push') {
        if (opts.notionDataSource === '') return { text: '還沒設定 Notion 資料庫：/sn notion <collection://…>' }
        if (verb === 'pull') return { text: `Notion：${await syncPull(p, opts)}` }
        const r = await syncPushAll(p, opts)
        return { text: `Notion：上傳 ${r.pushed} 張${r.failed ? `，${r.failed} 張失敗（/sn notion 看原因）` : ''}` }
      }
      if (verb === '') {
        if (opts.notionDataSource === '') return { text: '還沒設定 Notion 資料庫：/sn notion <collection://…>' }
        return { text: `便利貼同步到：${opts.notionDataSource}\n上次：${(await syncStatus(p)) ?? '還沒同步過'}\n指令：/sn notion pull（下載）、/sn notion push（把這個專案還沒上傳的都上傳）、/sn notion test` }
      }
      if (!/^collection:\/\/[0-9a-f-]{32,36}$/.test(verb)) return { text: '用法：/sn notion <collection://…> | test | pull | push' }
      const r = await p.setOption('notionDataSource', verb)
      if (!r.ok) return { text: `沒有改成功：${r.reason}` }
      opts.notionDataSource = verb
      return { text: '已設定 Notion 資料庫。打 /sn notion test 確認 mod 連得到。' }
    }
    case 'doctor': {
      for (const line of await p.keys.report()) p.ui.log(line)
      return {}
    }
    case 'provider': {
      // the summary layer: titles, summaries, knowledge answers (Claude subscription or OpenAI free tier)
      const v = rest.toLowerCase()
      if (v === '') return { text: `統整層目前用 ${opts.summaryProvider === 'openai' ? 'OpenAI' : 'Claude'}。切換：/sn provider claude 或 /sn provider openai` }
      if (v !== 'claude' && v !== 'openai') return { text: '用法：/sn provider claude|openai' }
      const r = await p.setOption('summaryProvider', v)
      if (!r.ok) return { text: `沒有改成功：${r.reason}` }
      opts.summaryProvider = v
      p.ui.toast(`Sticky Notes：統整層改用 ${v === 'claude' ? 'Claude' : 'OpenAI'}`)
      return {}
    }
    default: {
      const when = LATER[sub]
      return { text: when ? `/sticky-note ${sub}：尚未實作（${when}）` : `未知的子指令：${sub}` }
    }
  }
}
