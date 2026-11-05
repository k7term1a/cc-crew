// cc-sticky-notes type contract.
// Data model (PLAN.md「資料模型」) plus the $.state values the pane draws from.
// Self-contained: no imports. Hooks modules import these from '../types'.

/** How a note was made. `manual` since 11/05; `jev` and `ask` (the old routing dialog) stay on older notes. */
export type RouteSource = 'jev' | 'ask' | 'manual'

/** Who wrote a node's answer. */
export type AnsweredBy = 'claude-fork' | 'claude' | 'openai' | 'manual'

/** Bookmark: where in the main line the curiosity happened. */
export type Anchor = {
  sessionId: string
  /** Last main-line turn before the question (turn.start); idle prompts carry none. */
  turnId: string | null
  /** uuid of the main-line user message before the question (session.append door='prompt'). UserMessage badge / $.ui.scroll (M2). */
  messageId: string | null
  at: number
  /** Last main-line user prompt, first 120 chars. Debug only. */
  mainSnippet: string
}

/** One Q/A in the tree. Root when parentId is null. */
export type TreeNode = {
  id: string
  parentId: string | null
  /** Only roots carry it; at most one outline per root. */
  outlineId: string | null
  anchor: Anchor
  question: string
  answer: string
  answeredBy: AnsweredBy
  /** ≤ 12 chars; falls back to the first 12 chars of the question. */
  title: string
  /** Three sentences; null until the summary layer fills it. */
  summary: string | null
  tags: string[]
  /** `jev`: Jev's route (main_task | sidebar_knowledge | project_question), the card's category; only on notes from before 11/05 that Jev saw. */
  route: { label: string; confidence: number; source: RouteSource; jev?: string }
  promotedAt: number | null
  /** The session it was promoted in (promotion only goes into the current session). */
  promotedIn: string | null
  /** Derived on load from the children's parentId (never trusted from the store), ordered by anchor.at. */
  children: string[]
}

/** A grouping over roots. Not part of the tree; cannot be nested. */
export type Outline = {
  id: string
  title: string
  outline: string
  /** Root ids only. */
  memberIds: string[]
  createdAt: number
  staleSince: number | null
}

export type MainDigest = {
  text: string
  updatedAtTurn: string
  updatedAt: number
  sessionId: string
}

/** $.store `meta:<root>`. */
export type TreeMeta = {
  version: 2
  tags: string[]
  mainDigest: MainDigest | null
}

/**
 * The whole tree of one project, as assembled in memory from its keys:
 * node:<root>:<id>, outline:<root>:<id>, active:<root>:<sessionId>, meta:<root>.
 * Every session of the project (forks, restarts, other worktrees) shares it.
 */
export type Tree = {
  nodes: Record<string, TreeNode>
  /** Derived: parentId === null, ordered by anchor.at. */
  roots: string[]
  outlines: Record<string, Outline>
  /** key = sessionId; each session keeps its own "currently following up". */
  activeThread: Record<string, string | null>
  tags: string[]
  mainDigest: MainDigest | null
}

declare module 'claude-code' {
  interface PluginState {
    'cc-sticky-notes': {
      /** Mirror of the stored tree for drawing; null before session.start loads it. */
      tree: Tree | null
      /** Node shown in the pane's answer area. */
      selectedId: string | null
      /** The question the pane is rewriting in place (✎), if any. */
      editingId: string | null
      /** Bumped when a setting changes, so the pane's settings card draws again. */
      settingsRev: number
      /** Unread sidebar answers since the pane was last opened (badge count). */
      unread: number
      /** "只看本 session" filter. */
      onlyThisSession: boolean
      /** Outline selection mode and the roots picked in it. */
      selectMode: boolean
      selection: string[]
      /** Sidebar answers in flight, for a "thinking…" row. */
      pending: number
      /** Last main-line turnId seen at turn.start (prompt.submit has none while idle). */
      lastTurnId: string | null
      /** uuid of the last main-line user message (session.append door='prompt'). */
      lastPromptUuid: string | null
    }
  }
}
