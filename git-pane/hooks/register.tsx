import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { GitView } from '../types'
import type { HitProps } from './branch-hit'
import { registerTree, renderTree, scrollTree, treeMessage, treeOpensAtStart, treeSessionStart } from './filetree'

const PANE = 'git-pane'
const view = atom({ plugin: 'git-pane', key: 'view' } as const, { root: '', status: '', graph: '' } as GitView)
const selected = atom({ plugin: 'git-pane', key: 'selected' } as const, null as string | null)
const diff = atom({ plugin: 'git-pane', key: 'diff' } as const, '')
const changesTop = atom({ plugin: 'git-pane', key: 'changesTop' } as const, 0)
const bottomTop = atom({ plugin: 'git-pane', key: 'bottomTop' } as const, 0)
const picker = atom({ plugin: 'git-pane', key: 'picker' } as const, false)
const branches = atom({ plugin: 'git-pane', key: 'branches' } as const, { local: [], remote: [] } as { local: string[]; remote: string[] })
const pick = atom({ plugin: 'git-pane', key: 'pick' } as const, null as string | null)
const menu = atom({ plugin: 'git-pane', key: 'menu' } as const, null as string | null)
const menuOpt = atom({ plugin: 'git-pane', key: 'menuOpt' } as const, 'merge' as 'merge' | 'rebase')
const notice = atom({ plugin: 'git-pane', key: 'notice' } as const, '')
const localTop = atom({ plugin: 'git-pane', key: 'localTop' } as const, 0)
const remoteTop = atom({ plugin: 'git-pane', key: 'remoteTop' } as const, 0)
// the graph's scope: the current branch (default) or every branch (--all)
const graphAll = atom({ plugin: 'git-pane', key: 'graphAll' } as const, false)
// a commit picked in the graph, and what `git show` says of it
const commit = atom({ plugin: 'git-pane', key: 'commit' } as const, null as string | null)
const commitText = atom({ plugin: 'git-pane', key: 'commitText' } as const, '')
// the commit's files (exact paths, in the stat's order), and one picked from its stat
const commitFiles = atom({ plugin: 'git-pane', key: 'commitFiles' } as const, [] as string[])
const commitFile = atom({ plugin: 'git-pane', key: 'commitFile' } as const, null as string | null)
const commitFileText = atom({ plugin: 'git-pane', key: 'commitFileText' } as const, '')
// the Changes panel's tab; `git stash list` as "<hash> stash@{n} <message>"; the
// stash picked there, by its hash: its stash@{n} shifts as stashes come and go
const changesTab = atom({ plugin: 'git-pane', key: 'changesTab' } as const, 'changes' as 'changes' | 'stash')
const stashes = atom({ plugin: 'git-pane', key: 'stashes' } as const, [] as string[])
const stashSel = atom({ plugin: 'git-pane', key: 'stashSel' } as const, null as string | null)
// what the picked stash holds (`git stash show -p`), and whether its apply keeps it
const stashShow = atom({ plugin: 'git-pane', key: 'stashShow' } as const, '')
const stashKeep = atom({ plugin: 'git-pane', key: 'stashKeep' } as const, true)
// a revert or drop waiting for its yes in the band: what it does, and the question
type Confirm = { kind: 'revert' | 'revert-all' | 'drop'; target: string; text: string }
const confirm = atom({ plugin: 'git-pane', key: 'confirm' } as const, null as Confirm | null)
// ponytail: the band draws this many lines of a detail; a longer one says how many more
const DETAIL_MAX = 2000

// Two presses on one branch within this many ms are a double click: a press
// carries no click count.
const DOUBLE_MS = 500
let lastPress = { key: '', at: -Infinity }
// One git job (an action, a checkout, a merge or rebase) at a time. Taken
// before the first await, so two presses in flight cannot both pass.
let busy = false
function exclusive($: EngineInterface, job: () => Promise<unknown>) {
  if (busy) {
    void $.ui.toast('git is busy, try again in a moment')
    return Promise.resolve()
  }
  busy = true
  return job().finally(() => {
    busy = false
  })
}

const ACTIONS = [
  { id: 'fetch', label: 'fetch' },
  { id: 'pull', label: 'pull' },
  { id: 'push', label: 'push' },
  { id: 'stash', label: 'stash' },
  { id: 'stash-pop', label: 'stash pop' },
] as const
type ActionId = (typeof ACTIONS)[number]['id']

// The header: the branch row, then the action buttons in a border (the repo's
// name and path head the tree below).
const HEAD_ROWS = 4
// The picker's footer: checkout / close, notice, two hints; or the menu's two
// choices, run / cancel, notice.
const FOOTER_ROWS = 4

// Rows of the body, top to bottom: header, file tree, Changes panel (border,
// title, list, border), bottom panel (border, title, list, border). Below the
// header the room splits 40/20/40, each part fixed whatever it holds. The tree
// is exactly bodyRows tall so the engine never scrolls the pane; each part
// scrolls itself.
// The tree draws 6 rows of its own (header, search, footer) around a list of at
// least 5, so it gets no fewer than TREE_MIN rows; Graph gives way first.
// The tree's box adds its border's 2 rows.
const TREE_MIN = 11
function layout(bodyRows: number) {
  const avail = Math.max(16 + TREE_MIN - 4, bodyRows) - HEAD_ROWS
  const treeBox = Math.max(TREE_MIN + 2, Math.floor(avail * 0.4))
  const changesBox = Math.max(4, Math.floor(avail * 0.2))
  const changeRows = changesBox - 3
  const bottomRows = Math.max(1, avail - treeBox - changesBox - 3)
  // the tree's rows inside its border; first body rows of the Changes panel and of the bottom panel
  return { treeRows: treeBox - 2, changeRows, bottomRows, changesStart: HEAD_ROWS + treeBox, bottomStart: HEAD_ROWS + treeBox + changesBox }
}

// "* abc1234 (HEAD -> main) msg", "| * def5678 msg": the commit a graph line draws, if any
function commitOf(line: string) {
  return /^[^0-9A-Za-z]*\*[^0-9A-Za-z]*([0-9a-f]{7,40})\b/.exec(line)?.[1] ?? null
}

// The branch picker: header, Local box (border, title, list, border), Remote box
// (the same), footer. The two lists take the same height, 35% of the room each,
// padded to it and scrolling themselves; the rest stays empty below the footer.
function pickerLayout(bodyRows: number) {
  const avail = Math.max(2, Math.max(12, bodyRows) - HEAD_ROWS - 6 - FOOTER_ROWS)
  const localRows = Math.max(1, Math.floor(avail * 0.35))
  const remoteRows = localRows
  // first body row past the Local box's bottom border
  return { localRows, remoteRows, remoteStart: HEAD_ROWS + 3 + localRows }
}

function clamp(top: number, total: number, rows: number) {
  return Math.max(0, Math.min(top, total - rows))
}

function range(top: number, rows: number, total: number) {
  return total > rows ? `  ${top + 1}-${Math.min(total, top + rows)}/${total}` : ''
}

// The session root, not its cwd: the cwd follows a shell `cd` in a Bash call, so
// a long command run in another repo would swap the pane to that repo meanwhile.
// GIT_OPTIONAL_LOCKS=0: the 3s poll's `git status` takes no index.lock, so it
// never makes a checkout fail with "index.lock: File exists".
// GIT_TERMINAL_PROMPT=0: the pane has no terminal to type a password in, so a
// fetch, pull or push that needs one fails at once instead of hanging.
// core.quotePath=false: status prints a non-ASCII path as itself, not as octal
// escapes that name no file.
// A call that rejects (its timeout) comes back as a failed result, so every
// caller reports it the way it reports git's own errors.
async function git($: EngineInterface, args: string[], timeoutMs = 5000): Promise<ProcessRunResult> {
  try {
    return await $.process.run(['git', ...args], {
      cwd: await $.session.root(),
      timeoutMs,
      env: {
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.quotePath',
        GIT_CONFIG_VALUE_0: 'false',
      },
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { exitCode: -1, stdout: '', stderr: `git ${args[0]}: ${why}`, isStdoutTruncated: false, isStderrTruncated: false }
  }
}

// What went wrong, in one row: git's first error line, or for a merge conflict
// (said on stdout alone) its last line.
function gitError(ran: ProcessRunResult) {
  const err = ran.stderr.trim()
  if (err) return err.split('\n')[0] ?? err
  return ran.stdout.trim().split('\n').pop() || `git exited ${ran.exitCode}`
}

const unquote = (p: string) => (p.startsWith('"') ? p.slice(1, -1) : p)
// `git status --short` line -> path ("R  old -> new" takes new, quoted paths unquoted)
function pathOf(line: string) {
  return unquote(line.slice(3).split(' -> ').pop() ?? '')
}
// every path the line names: a rename's old one too
function pathsOf(line: string) {
  return line.slice(3).split(' -> ').map(unquote)
}

// ponytail: an untracked folder shows its first DIR_MAX files, one git call each; the rest are counted
const DIR_MAX = 50

async function diffOf($: EngineInterface, line: string) {
  const path = pathOf(line)
  const out = (ran: ProcessRunResult) => (ran.stdout || ran.stderr).trimEnd()
  if (!line.startsWith('??')) return out(await git($, ['diff', '--no-color', 'HEAD', '--', path])) || '(no diff)'
  // a folder ("dir/"): git diff --no-index would look in it for a file named null, so diff its files
  const files = path.endsWith('/')
    ? (await git($, ['ls-files', '--others', '--exclude-standard', '-z', '--', path])).stdout.split('\0').filter(Boolean)
    : [path]
  const parts: string[] = []
  for (const f of files.slice(0, DIR_MAX)) parts.push(out(await git($, ['diff', '--no-color', '--no-index', '--', '/dev/null', f])))
  if (files.length > DIR_MAX) parts.push(`… ${files.length - DIR_MAX} more files`)
  return parts.filter(Boolean).join('\n') || '(no diff)'
}

async function setTab($: EngineInterface, tab: 'changes' | 'stash') {
  await update($, changesTab, () => tab)
  await update($, changesTop, () => 0)
}

// One detail shows in the band at a time: a file's diff, a commit (or a file of
// it) or a stash. Picking one drops the others and any question waiting.
async function closeDetail($: EngineInterface) {
  await update($, selected, () => null)
  await update($, commit, () => null)
  await update($, commitFile, () => null)
  await update($, stashSel, () => null)
  await update($, confirm, () => null)
}

async function refresh($: EngineInterface) {
  // read here, by the poll too, so the scope chosen stays chosen
  const all = await read($, graphAll)
  const [root, status, graph, stash] = await Promise.all([
    git($, ['rev-parse', '--show-toplevel']),
    git($, ['status', '--short', '--branch', '--untracked-files=all']),
    // ponytail: --graph walks the whole history (topo order); 15s, cache it if a huge repo needs more
    git($, ['log', '--graph', '--oneline', '--decorate', ...(all ? ['--all'] : []), '-n', '200'], 15_000),
    git($, ['stash', 'list', '--format=%H %gd %s']),
  ])
  const next: GitView =
    status.exitCode !== 0
      ? { root: '', status: '', graph: '', error: status.stderr.trim() || 'not a git repository' }
      : { root: root.stdout.trim(), status: status.stdout.trimEnd(), graph: graph.stdout.trimEnd() }
  await update($, view, prev =>
    prev.root === next.root && prev.status === next.status && prev.graph === next.graph && prev.error === next.error ? prev : next,
  )
  const list = next.error || stash.exitCode !== 0 ? [] : stash.stdout.split('\n').filter(l => l.includes(' '))
  await update($, stashes, prev => (prev.join('\n') === list.join('\n') ? prev : list))
  // a picked stash that is gone (popped, dropped) is picked no more
  await update($, stashSel, s => (s !== null && !list.some(l => l.startsWith(`${s} `)) ? null : s))

  const sel = await read($, selected)
  if (sel === null) return
  const line = next.status.split('\n').slice(1).find(l => l === sel || pathOf(l) === pathOf(sel))
  if (!line) {
    await update($, selected, () => null)
    return
  }
  const text = await diffOf($, line)
  await update($, selected, () => line)
  await update($, diff, prev => (prev === text ? prev : text))
}

async function toggle($: EngineInterface, line: string) {
  const sel = await read($, selected)
  await closeDetail($)
  if (sel !== null && pathOf(sel) === pathOf(line)) return
  await update($, diff, () => '…')
  await update($, selected, () => line)
  const text = await diffOf($, line)
  await update($, diff, () => text)
}

async function setGraphAll($: EngineInterface, all: boolean) {
  await update($, graphAll, () => all)
  await update($, bottomTop, () => 0)
  await refresh($)
}

// Marks in a commit's text: a rule line, and a line of the files' stat (told by
// where it stands, before the patch, not by its look: a patch line can look alike).
// A stat line is STAT, its file's number (none on the summary line), FILE_END, the line.
const RULE = '\u0000rule'
const STAT = '\u0001'
const FILE_END = '\u0002'
const STAT_LINE = /^ \S.*\|\s+(\d+|Bin)/

// `git show --stat --patch`: a rule above the stat and above the patch, the stat's lines marked
function withRules(text: string) {
  const lines = text.split('\n')
  const patch = lines.findIndex(l => l.startsWith('diff --git '))
  const end = patch < 0 ? lines.length : patch
  const stat = lines.findIndex((l, i) => i < end && (STAT_LINE.test(l) || /^ \d+ files? changed/.test(l)))
  let file = 0
  return lines.flatMap((l, i) => [
    ...(i === stat || (i === patch && patch > 0) ? [RULE] : []),
    stat >= 0 && i >= stat && i < end && l.startsWith(' ') ? STAT + (STAT_LINE.test(l) ? String(file++) : '') + FILE_END + l : l,
  ]).join('\n')
}

// A commit picked in the graph: its message, the files it touched and its changes.
// The hash is hex from the graph line, never an option.
async function showCommit($: EngineInterface, hash: string) {
  await closeDetail($)
  await update($, commitText, () => '…')
  await update($, commit, () => hash)
  // a merge shows its changes against its first parent, stat and patch alike
  const [ran, names] = await Promise.all([
    git($, ['show', '--no-color', '--stat', '--patch', '--diff-merges=first-parent', hash], 15_000),
    git($, ['show', '--no-color', '--format=', '--name-only', '-z', '--diff-merges=first-parent', hash], 15_000),
  ])
  await update($, commitFiles, () => names.stdout.split('\0').filter(Boolean))
  await update($, commitText, () => (ran.exitCode === 0 ? withRules(ran.stdout.trimEnd()) : ran.stderr.trimEnd()) || '(empty)')
}

// A file picked from the commit's stat: its change in that commit alone.
async function showCommitFile($: EngineInterface, index: number) {
  const hash = await read($, commit)
  const path = (await read($, commitFiles))[index]
  if (hash === null || path === undefined) return
  await update($, commitFileText, () => '…')
  await update($, commitFile, () => path)
  const ran = await git($, ['show', '--no-color', '--format=', '--patch', '--diff-merges=first-parent', hash, '--', path], 15_000)
  await update($, commitFileText, () => (ran.stdout || ran.stderr).trimEnd() || '(no change)')
}

// main, master, develop, release*, then the current branch, then the rest in the
// order given (oldest tip commit first). A remote branch ranks by its name past the remote.
function rank(name: string, current: string) {
  if (name === 'main') return 0
  if (name === 'master') return 1
  if (name === 'develop') return 2
  if (/^release([/-]|$)/.test(name)) return 3
  return name === current ? 4 : 5
}

function ordered(refs: string[], current: string, remote: boolean) {
  const nameOf = (r: string) => (remote ? r.slice(r.indexOf('/') + 1) : r)
  return [...refs].sort((a, b) => rank(nameOf(a), current) - rank(nameOf(b), current))
}

function currentBranch(v: GitView) {
  return branchOf(v.status.split('\n')[0] ?? '').branch
}

async function closePicker($: EngineInterface) {
  await update($, picker, () => false)
  await update($, menu, () => null)
  await update($, pick, () => null)
}

async function togglePicker($: EngineInterface) {
  await update($, bottomTop, () => 0)
  await update($, notice, () => '')
  await update($, localTop, () => 0)
  await update($, remoteTop, () => 0)
  lastPress = { key: '', at: -Infinity }
  if (await read($, picker)) return closePicker($)
  await update($, pick, () => null)
  await update($, menu, () => null)
  const ran = await git($, ['for-each-ref', '--sort=committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  const refs = ran.stdout.split('\n').filter(Boolean)
  const under = (prefix: string) => refs.filter(r => r.startsWith(prefix)).map(r => r.slice(prefix.length))
  const current = currentBranch(await read($, view))
  await update($, branches, () => ({
    local: ordered(under('refs/heads/'), current, false),
    remote: ordered(
      under('refs/remotes/').filter(r => !r.endsWith('/HEAD')),
      current,
      true,
    ),
  }))
  await update($, picker, () => true)
}

// `b:<branch>` / `r:<remote>/<branch>`, the key of a picker row
async function pressBranch($: EngineInterface, key: string) {
  // the current branch: nothing to check out, so the selection clears
  if (key === `b:${currentBranch(await read($, view))}`) {
    lastPress = { key: '', at: -Infinity }
    await update($, menu, () => null)
    return update($, pick, () => null)
  }
  const now = await $.clock.now()
  const isDouble = lastPress.key === key && now - lastPress.at < DOUBLE_MS
  lastPress = isDouble ? { key: '', at: -Infinity } : { key, at: now }
  await update($, menu, () => null)
  await update($, pick, () => key)
  if (isDouble) await exclusive($, () => checkout($, key))
}

// A right click: merge or rebase that branch with the current one; none for
// the current branch itself.
async function openMenu($: EngineInterface, key: string) {
  const isCurrent = key === `b:${currentBranch(await read($, view))}`
  await update($, pick, () => key)
  await update($, notice, () => '')
  await update($, menuOpt, () => 'merge')
  await update($, menu, () => (isCurrent ? null : key))
}

async function trackedChanges($: EngineInterface) {
  const dirty = (await git($, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
  return dirty ? dirty.split('\n').length : 0
}

// Tracked changes block the switch (untracked files ride along, as git allows).
// A remote branch switches to the local branch of its name, or creates one tracking it.
async function checkout($: EngineInterface, key: string) {
  const remote = key.startsWith('r:')
  const ref = key.slice(2)
  const n = await trackedChanges($)
  if (n) return update($, notice, () => `Checkout blocked: ${n} tracked change(s). Commit or stash first.`)
  const local = remote ? ref.slice(ref.indexOf('/') + 1) : ref
  // asked now, not from the list: a branch made since the picker opened counts
  const hasLocal = !remote || (await git($, ['show-ref', '--verify', '--quiet', `refs/heads/${local}`])).exitCode === 0
  // `--`: a branch named like an option (`--detach`) stays a branch name
  const ran = await git($, hasLocal ? ['switch', '--', local] : ['switch', '--track', ref], 30_000)
  if (ran.exitCode !== 0) return update($, notice, () => gitError(ran))
  await closePicker($)
  await update($, selected, () => null)
  await update($, bottomTop, () => 0)
  await refresh($)
  void $.ui.toast(`Switched to ${local}`)
}

// The checkout button, for a surface that does not hand over both presses of a
// double click. Runs under exclusive, as checkout does from a double click.
async function checkoutPicked($: EngineInterface) {
  const key = await read($, pick)
  if (key !== null) await checkout($, key)
}

// The menu's merge / rebase. The full ref name keeps a branch named like an
// option an argument, and tells a local branch from a remote one.
async function integrate($: EngineInterface) {
  const key = await read($, menu)
  if (key === null) return
  const kind = await read($, menuOpt)
  await update($, menu, () => null)
  const n = await trackedChanges($)
  const Kind = kind === 'merge' ? 'Merge' : 'Rebase'
  if (n) return update($, notice, () => `${Kind} blocked: ${n} tracked change(s). Commit or stash first.`)
  const ref = `${key.startsWith('r:') ? 'refs/remotes/' : 'refs/heads/'}${key.slice(2)}`
  const ran = await git($, kind === 'merge' ? ['merge', '--no-edit', ref] : ['rebase', ref], 60_000)
  if (ran.exitCode !== 0) {
    await update($, notice, () => gitError(ran))
    return refresh($)
  }
  await closePicker($)
  await refresh($)
  void $.ui.toast(`${Kind}d ${key.slice(2)}`)
}

// The picked stash's stash@{n}, found by its hash now: stashes made since shift
// it. Gone (popped or dropped elsewhere): unpicked, said, and none.
async function pickedStash($: EngineInterface, what: string) {
  const hash = await read($, stashSel)
  if (hash === null) return null
  const listed = (await git($, ['stash', 'list', '--format=%H %gd'])).stdout.split('\n')
  const ref = listed.find(l => l.startsWith(`${hash} `))?.split(' ')[1]
  if (ref) return ref
  await update($, stashSel, () => null)
  void $.ui.toast(`${what}: the picked stash is gone`)
  await refresh($)
  return null
}

// A stash row: picks it and shows what it holds in the band; again, unpicks it.
async function pickStash($: EngineInterface, hash: string) {
  const was = await read($, stashSel)
  await closeDetail($)
  if (was === hash) return
  await update($, stashShow, () => '…')
  await update($, stashSel, () => hash)
  const ref = await pickedStash($, 'stash show')
  if (!ref) return
  const ran = await git($, ['stash', 'show', '-p', '--include-untracked', '--no-color', ref], 15_000)
  await update($, stashShow, () => (ran.stdout || ran.stderr).trimEnd() || '(empty)')
}

// What a git job that changes the worktree says, then the pane catches up.
async function report($: EngineInterface, name: string, ran: ProcessRunResult) {
  void $.ui.toast(ran.exitCode === 0 ? `${name}: done` : `${name} failed: ${gitError(ran)}`)
  await refresh($)
  return ran.exitCode === 0
}

// apply: keep the stash or, as chosen, drop it once applied (pop keeps it on a conflict)
async function applyStash($: EngineInterface) {
  const keep = await read($, stashKeep)
  const ref = await pickedStash($, 'stash apply')
  if (!ref) return
  await report($, `stash ${keep ? 'apply' : 'pop'} ${ref}`, await git($, ['stash', keep ? 'apply' : 'pop', ref], 60_000))
}

// The band's revert, revert all and drop ask first; this is the yes.
async function askRevert($: EngineInterface, line: string) {
  const path = pathOf(line)
  const text = line.startsWith('??')
    ? `delete the untracked file ${path}?`
    : line[0] === 'A'
      ? `revert ${path}? It is new, so the file is deleted.`
      : `revert ${path} to HEAD?`
  await update($, confirm, () => ({ kind: 'revert', target: line, text }))
}

async function askRevertAll($: EngineInterface) {
  const changes = (await read($, view)).status.split('\n').slice(1)
  const untracked = changes.filter(l => l.startsWith('??')).length
  const text = `revert all ${changes.length} changes to HEAD?${untracked ? ` ${untracked} untracked file(s) are deleted.` : ''}`
  await update($, confirm, () => ({ kind: 'revert-all', target: '', text }))
}

async function askDrop($: EngineInterface) {
  const ref = await pickedStash($, 'stash drop')
  if (ref) await update($, confirm, () => ({ kind: 'drop', target: ref, text: `drop ${ref}? Its changes are gone.` }))
}

async function confirmed($: EngineInterface) {
  const c = await read($, confirm)
  await update($, confirm, () => null)
  if (c === null) return
  if (c.kind === 'revert') {
    const ok = await report(
      $,
      `revert ${pathOf(c.target)}`,
      c.target.startsWith('??')
        ? await git($, ['clean', '-f', '--', pathOf(c.target)])
        : await git($, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...pathsOf(c.target)]),
    )
    if (ok) await update($, selected, () => null)
    return
  }
  if (c.kind === 'revert-all') {
    // `:/`: the whole worktree, wherever in it the session root is; ignored files stay
    const restored = await git($, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ':/'], 30_000)
    if (restored.exitCode !== 0) return report($, 'revert all', restored)
    if (await report($, 'revert all', await git($, ['clean', '-fd', '--', ':/'], 30_000))) await update($, selected, () => null)
    return
  }
  // drop: asked by its stash@{n}; picked by hash, so check it still is that one
  const ref = await pickedStash($, 'stash drop')
  if (ref !== c.target) return void $.ui.toast('stash drop: the stashes moved, pick it again')
  await report($, `stash drop ${ref}`, await git($, ['stash', 'drop', ref]))
}

async function act($: EngineInterface, id: ActionId) {
  let name = id.replace('-', ' ')
  const head = (await read($, view)).status.split('\n')[0] ?? ''
  const args: Record<ActionId, string[]> = {
    fetch: ['fetch'],
    pull: ['pull', '--ff-only'],
    // no upstream yet: set one on origin, the branch of the same name
    push: head.includes('...') ? ['push'] : ['push', '-u', 'origin', 'HEAD'],
    stash: ['stash', 'push'],
    'stash-pop': ['stash', 'pop'],
  }
  // stash pop: the picked stash
  if (id === 'stash-pop' && (await read($, stashSel)) !== null) {
    const ref = await pickedStash($, 'stash pop')
    if (!ref) return
    args['stash-pop'] = ['stash', 'pop', ref]
    name = `stash pop ${ref}`
  }
  void $.ui.toast(`${name}…`)
  const ran = await git($, args[id], 60_000)
  void $.ui.toast(
    ran.exitCode === 0 ? `${name}: ${(ran.stdout || ran.stderr).trim().split('\n').pop() || 'done'}` : `${name} failed: ${gitError(ran)}`,
  )
  await refresh($)
}

// "## main...origin/main [ahead 1]" -> { branch: "main", track: " [ahead 1]" }
function branchOf(head: string) {
  const m = /^## (.+?)(?:\.\.\.\S+)?( \[.+\])?$/.exec(head)
  return { branch: m?.[1] ?? head.replace(/^## /, ''), track: m?.[2] ?? '' }
}

function lineColor(line: string) {
  if (line.startsWith('@@')) return 'cyan'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'green'
  if (line.startsWith('-') && !line.startsWith('---')) return 'red'
  return undefined
}

export const register: Register = (on, options) => {
  // the file tree's hooks (filetree 0.6.0): its activity shimmer, its watchers;
  // its render and scroll are called below for its region
  registerTree(on, options)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'git', description: 'Open the git changes / graph / diff pane' })
    await $.command.register({ name: 'git-close', description: 'Close the git pane' })
    await refresh($)
    // Not a repo: no git polling; the pane opens for the file tree alone.
    // "Open at start" off: the pane waits for /git either way.
    if (!(await read($, view)).error) {
      // ponytail: 3s polling, switch to fs watch on .git if it ever matters
      $.clock.every(3000, () => refresh($))
    }
    // Opened unasked, the pane waits undrawn on a terminal narrower than the
    // engine's floor (144 columns, 110 once the person has opened it): say how to open it.
    if (treeOpensAtStart())
      void $.ui
        .open({ id: PANE, title: 'Git' })
        .then(r => (r.isPlaced ? undefined : $.ui.toast('Git pane is waiting: the terminal is narrow. Run /git to open it.')))
        .catch(() => undefined)

    return treeSessionStart($, e, next)
  })

  on('command.run', { command: 'git' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Git' })

    return { text: 'Git pane opened.' }
  })

  on('command.run', { command: 'git-close' }, async $ => {
    await $.ui.close({ id: PANE })

    return { text: 'Git pane closed.' }
  })

  // The branch rows' hit Clients (terminal): a left click presses, a right click opens the menu.
  on('ui.message', async ($, e, next) => {
    // a graph line's hit Client: a click shows that commit
    if (e.requestId === PANE && e.element.startsWith('chit:') && typeof e.data === 'object' && e.data !== null) {
      if (typeof (e.data as Record<string, unknown>).press === 'string') await showCommit($, e.element.slice('chit:'.length))
      return {}
    }
    if (e.requestId !== PANE || !e.element.startsWith('bhit:') || typeof e.data !== 'object' || e.data === null) return treeMessage($, e, next)
    const data = e.data as Record<string, unknown>
    if (typeof data.press === 'string') await pressBranch($, data.press)
    else if (typeof data.menu === 'string') await openMenu($, data.menu)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Client = 'Client' in elements ? elements.Client : undefined
    const v = await read($, view)
    // the tree draws on the terminal and the desktop; elsewhere its room stays empty
    const drawTree = (rows: number) =>
      e.surface === 'terminal' || e.surface === 'desktop'
        ? renderTree($, { ...e, props: { ...e.props, bodyColumns: Math.max(1, e.props.bodyColumns - 2), scroll: { ...e.props.scroll, bodyRows: rows } } }, next)
        : null
    // Not a repo: one row saying so, the file tree in all the rest
    if (v.error) {
      const rows = Math.max(TREE_MIN, e.props.scroll.bodyRows - 3)
      const tree = await drawTree(rows)
      return (
        <Box flexDirection="column" gap={0}>
          <Box paddingLeft={1}>
            {/not a git repository/i.test(v.error) ? (
              // the usual case outside a repo: say what the pane is, not git's words
              <Text dimColor wrap="truncate">
                Git · not a git repository — file tree only
              </Text>
            ) : (
              <Text color="red" wrap="truncate">
                Git · {v.error.split('\n')[0]}
              </Text>
            )}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderDimColor>
            <Box flexDirection="column" height={rows} overflow="hidden">
              {tree}
            </Box>
          </Box>
        </Box>
      )
    }
    const sel = await read($, selected)

    const [head = '', ...changes] = v.status.split('\n')
    const picked = await read($, commit)
    // the lower panel is the graph; a picked file, commit or stash shows in the band
    const bottom = v.graph.split('\n')
    const { treeRows, changeRows, bottomRows } = layout(e.props.scroll.bodyRows)
    const tab = await read($, changesTab)
    const stashList = await read($, stashes)
    const listed = tab === 'stash' ? stashList : changes
    const cTop = clamp(await read($, changesTop), listed.length, changeRows)
    const { branch, track } = branchOf(head)

    const header = (
      <Box flexDirection="column" gap={0}>
        <Box flexDirection="row" paddingLeft={1}>
          <Button key="branch" plain onPress={() => togglePicker($)}>
            <Text bold color="green" wrap="truncate">{branch}</Text>
            <Text dimColor> ▾</Text>
          </Button>
          <Text dimColor wrap="truncate">{track}</Text>
        </Box>
        <Box flexDirection="row" borderStyle="round" borderDimColor paddingX={1}>
          {ACTIONS.flatMap((a, i) => [
            ...(i ? [<Text dimColor>{' · '}</Text>] : []),
            <Button key={`act:${a.id}`} plain onPress={() => exclusive($, () => act($, a.id))}>
              <Text color="cyan">{a.label}</Text>
            </Button>,
          ])}
        </Box>
      </Box>
    )

    if (await read($, picker)) {
      const b = await read($, branches)
      const { localRows, remoteRows } = pickerLayout(e.props.scroll.bodyRows)
      const lTop = clamp(await read($, localTop), b.local.length, localRows)
      const rTop = clamp(await read($, remoteTop), b.remote.length, remoteRows)
      const p = await read($, pick)
      const m = await read($, menu)
      const opt = await read($, menuOpt)
      const msg = await read($, notice)
      // branch names stay plain; only the current one is green
      const row = (ref: string, remote: boolean) => {
        const key = `${remote ? 'r' : 'b'}:${ref}`
        const isCurrent = !remote && ref === branch
        const label = (
          <Text inverse={p === key} bold={isCurrent} color={isCurrent ? 'green' : undefined} wrap="truncate">
            {ref}
          </Text>
        )
        // terminal: a hit Client over the row, so a double click is not taken for selecting a word
        return e.surface === 'terminal' && Client ? (
          <Box key={`brow:${key}`} position="relative" flexDirection="row">
            {label}
            <Box position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client key={`bhit:${key}`} module="./branch-hit.tsx" props={{ id: key } satisfies HitProps} width="100%" height="100%" />
            </Box>
          </Box>
        ) : (
          <Button key={key} plain onPress={() => pressBranch($, key)}>
            {label}
          </Button>
        )
      }
      const list = (title: string, refs: string[], top: number, rows: number, remote: boolean, tone: string) => {
        const shown = refs.slice(top, top + rows)
        const pad = rows - Math.max(1, shown.length)
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
            <Text bold color={tone} wrap="truncate">
              {title} ({refs.length})<Text dimColor>{range(top, rows, refs.length)}</Text>
            </Text>
            {refs.length === 0 && <Text dimColor>none</Text>}
            {shown.map(ref => row(ref, remote))}
            {Array.from({ length: Math.max(0, pad) }, () => (
              <Text> </Text>
            ))}
          </Box>
        )
      }
      // one row, a blank (' ') where there is nothing to say, so the footer keeps its height
      const noticeRow = (
        <Text color={/^(\w+ blocked|fatal|error)/.test(msg) ? 'red' : 'yellow'} wrap="truncate">
          {msg || ' '}
        </Text>
      )
      // Buttons hold short words only: a long label wraps inside its Button
      // whatever its Text says. Branch names go on rows of their own, cut.
      const choice = (id: 'merge' | 'rebase') => (
        <Button key={`opt-${id}`} plain onPress={() => update($, menuOpt, () => id)}>
          <Text bold={opt === id}>{opt === id ? '◉ ' : '○ '}</Text>
          <Text bold={opt === id}>{id}</Text>
        </Button>
      )
      const target = m === null ? '' : m.slice(2)
      const footer =
        m !== null ? (
          <Box flexDirection="column">
            <Box flexDirection="row">
              {choice('merge')}
              <Text>{'   '}</Text>
              {choice('rebase')}
            </Box>
            <Text wrap="truncate">{opt === 'merge' ? `merge ${target} into ${branch}` : `rebase ${branch} onto ${target}`}</Text>
            <Box flexDirection="row">
              <Button key="menu-run" plain onPress={() => exclusive($, () => integrate($))}>
                <Text bold color="green">▶ run</Text>
              </Button>
              <Text dimColor>{' · '}</Text>
              <Button key="menu-cancel" plain dimColor onPress={() => update($, menu, () => null)}>
                cancel
              </Button>
            </Box>
            {noticeRow}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Button key="picker-close" plain dimColor onPress={() => togglePicker($)}>
                ← close
              </Button>
              {p !== null && <Text dimColor>{' · '}</Text>}
              {p !== null && (
                <Button key="checkout" plain onPress={() => exclusive($, () => checkoutPicked($))}>
                  <Text bold color="green">▶ checkout</Text>
                </Button>
              )}
            </Box>
            {msg ? noticeRow : <Text wrap="truncate">{p === null ? ' ' : p.slice(2)}</Text>}
            <Text dimColor wrap="truncate">{e.surface === 'terminal' ? 'double-click: checkout' : 'double-press: checkout'}</Text>
            <Text dimColor wrap="truncate">{e.surface === 'terminal' ? 'right-click: merge / rebase' : ' '}</Text>
          </Box>
        )
      return (
        <Box flexDirection="column">
          {header}
          {list('Local', b.local, lTop, localRows, false, 'cyan')}
          {list('Remote', b.remote, rTop, remoteRows, true, 'magenta')}
          {footer}
        </Box>
      )
    }

    const bTop = clamp(await read($, bottomTop), bottom.length, bottomRows)
    const all = await read($, graphAll)
    const scope = (id: 'current' | 'all', active: boolean) => (
      <Button key={`graph-${id}`} plain onPress={() => setGraphAll($, id === 'all')}>
        <Text bold={active} color={active ? 'green' : undefined} dimColor={!active}>
          {id}
        </Text>
      </Button>
    )

    // the tree draws to the room it is told, cut at it should it ask for more
    const tree = await drawTree(treeRows)
    const sSel = await read($, stashSel)
    // the question and a picked stash's actions sit in the pane, which never folds
    // (the band can, and stays folded); the Graph gives up their rows
    const ask = await read($, confirm)
    const keep = await read($, stashKeep)
    const stashActs = tab === 'stash' && sSel !== null
    const inner = Math.max(1, e.props.bodyColumns - 4)
    const extra = (ask ? Math.ceil(ask.text.length / inner) + 1 : 0) + (stashActs ? 2 : 0)
    const graphRows = Math.max(1, bottomRows - extra)
    const shownChanges = listed.slice(cTop, cTop + changeRows)
    const pact = (key: string, label: string, onPress: () => unknown, color?: string) => (
      <Button key={key} plain onPress={onPress}>
        <Text color={color}>{label}</Text>
      </Button>
    )
    const choice = (key: string, isOn: boolean, label: string) => (
      <Button key={key} plain onPress={() => update($, stashKeep, () => key === 'stash-keep')}>
        <Text bold={isOn}>
          {isOn ? '◉ ' : '○ '}
          {label}
        </Text>
      </Button>
    )
    // a stash row shows "stash@{n} <message>", its hash kept for the key
    const hashOf = (line: string) => line.slice(0, line.indexOf(' '))
    const stashLabel = (line: string) => line.slice(line.indexOf(' ') + 1)
    const tabButton = (id: 'changes' | 'stash', label: string) => (
      <Button key={`tab-${id}`} plain onPress={() => setTab($, id)}>
        <Text bold={tab === id} dimColor={tab !== id} wrap="truncate">
          {label}
        </Text>
      </Button>
    )

    return (
      <Box flexDirection="column" gap={0}>
        {header}
        <Box flexDirection="column" borderStyle="round" borderDimColor>
          <Box flexDirection="column" height={treeRows} overflow="hidden">
            {tree}
          </Box>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row">
            {tabButton('changes', `Changes (${changes.length})`)}
            <Text dimColor>{' · '}</Text>
            {tabButton('stash', `Stash (${stashList.length})`)}
            <Text dimColor wrap="truncate">{range(cTop, changeRows, listed.length)}</Text>
            {tab === 'changes' && changes.length > 0 && <Text>{'  '}</Text>}
            {tab === 'changes' && changes.length > 0 && (
              <Button key="revert-all" plain onPress={() => askRevertAll($)}>
                <Text color="red">[revert all]</Text>
              </Button>
            )}
          </Box>
          {ask !== null && <Text color="yellow" wrap="wrap">{ask.text}</Text>}
          {ask !== null && (
            <Box flexDirection="row">
              {pact('confirm-yes', '[▶ yes]', () => exclusive($, () => confirmed($)), 'red')}
              <Text>{'  '}</Text>
              {pact('confirm-cancel', '[cancel]', () => update($, confirm, () => null))}
            </Box>
          )}
          {stashActs && (
            <Box flexDirection="row">
              <Text dimColor>after apply: </Text>
              {choice('stash-keep', keep, 'keep')}
              <Text>{' '}</Text>
              {choice('stash-delete', !keep, 'delete')}
            </Box>
          )}
          {stashActs && (
            <Box flexDirection="row">
              {pact('stash-apply', '[▶ apply]', () => exclusive($, () => applyStash($)), 'green')}
              <Text>{'  '}</Text>
              {pact('stash-drop', '[drop]', () => askDrop($), 'red')}
            </Box>
          )}
          {listed.length === 0 && <Text dimColor>{tab === 'stash' ? 'no stash' : 'clean'}</Text>}
          {tab === 'stash'
            ? shownChanges.map(line => {
                const hash = hashOf(line)
                // a press shows it in the band, for apply, drop or the header's stash pop
                return (
                  <Button key={`s:${hash}`} plain onPress={() => pickStash($, hash)}>
                    <Text inverse={sSel === hash} wrap="truncate">
                      {stashLabel(line)}
                    </Text>
                  </Button>
                )
              })
            : shownChanges.map(line => (
                <Button key={`f:${pathOf(line)}`} plain onPress={() => toggle($, line)}>
                  <Text
                    inverse={sel !== null && pathOf(sel) === pathOf(line)}
                    color={line.startsWith('??') ? 'gray' : line[0] !== ' ' ? 'green' : 'yellow'}
                    wrap="truncate"
                  >
                    {line}
                  </Text>
                </Button>
              ))}
          {Array.from({ length: Math.max(0, changeRows - Math.max(1, shownChanges.length)) }, () => (
            <Text> </Text>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row">
            <Text bold wrap="truncate">
              Graph
              <Text dimColor>{range(bTop, graphRows, bottom.length)}  </Text>
            </Text>
            {scope('current', !all)}
            <Text dimColor>{' · '}</Text>
            {scope('all', all)}
          </Box>
          {bottom.slice(bTop, bTop + graphRows).map(line => {
            const hash = commitOf(line)
            // the picked commit stays marked while the band shows it
            const text = (
              <Text inverse={hash !== null && hash === picked} wrap="truncate">
                {line}
              </Text>
            )
            if (hash === null) return text
            // a commit line takes a click: a hit Client on the terminal (a long
            // Button label would wrap), a Button elsewhere
            return e.surface === 'terminal' && Client ? (
              <Box key={`crow:${hash}`} position="relative" flexDirection="row">
                {text}
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client key={`chit:${hash}`} module="./branch-hit.tsx" props={{ id: hash } satisfies HitProps} width="100%" height="100%" />
                </Box>
              </Box>
            ) : (
              <Button key={`c:${hash}`} plain onPress={() => showCommit($, hash)}>
                {text}
              </Button>
            )
          })}
        </Box>
      </Box>
    )
  })

  // The band above the prompt: the picked file's diff, commit (or a file of it)
  // or stash, as wide as the transcript, long lines wrapped; the engine scrolls
  // it when taller than its room. A question waiting for its yes shows on top.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const sel = await read($, selected)
    const hash = await read($, commit)
    const file = await read($, commitFile)
    const stash = await read($, stashSel)
    const stashLine = stash === null ? undefined : (await read($, stashes)).find(l => l.startsWith(`${stash} `))
    const kind = stash !== null ? 'stash' : sel !== null ? 'diff' : hash !== null ? (file !== null ? 'file' : 'commit') : null
    if (kind === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const title =
      kind === 'stash'
        ? `Stash ${stashLine?.slice(stashLine.indexOf(' ') + 1) ?? ''}`
        : kind === 'diff' && sel !== null
          ? `Diff: ${pathOf(sel)}`
          : kind === 'file'
            ? `${hash} · ${file}`
            : `Commit ${hash}`
    const text =
      kind === 'stash'
        ? await read($, stashShow)
        : kind === 'diff'
          ? await read($, diff)
          : kind === 'file'
            ? await read($, commitFileText)
            : await read($, commitText)
    const all = text === '' ? [] : text.split('\n')
    const lines = all.slice(0, DETAIL_MAX)
    // Words in brackets: a wider mark to hit than a glyph
    const act = (key: string, label: string, onPress: () => unknown, color?: string) => [
      <Text>{'  '}</Text>,
      <Button key={key} plain onPress={onPress}>
        <Text color={color}>{label}</Text>
      </Button>,
    ]
    return (
      <Box flexDirection="column">
        {/* the title row sits above the frame, on the band's first row: the engine draws its [-] right of it */}
        <Box flexDirection="row" paddingLeft={1}>
          <Box flexDirection="row" flexGrow={1}>
            <Text bold wrap="truncate">
              {title}
            </Text>
            {kind === 'file' && act('detail-back', '[← commit]', () => update($, commitFile, () => null))}
            {kind === 'diff' && sel !== null && act('detail-revert', '[revert]', () => askRevert($, sel), 'red')}
          </Box>
          {/* at the far right, beside the engine's own [-] (which only folds the band, and it stays folded) */}
          <Button key="detail-close" plain onPress={() => closeDetail($)}>
            <Text color="cyan">[✕]</Text>
          </Button>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        {lines.map(line => {
          if (line === RULE) return <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns - 4))}</Text>
          if (line.startsWith(STAT)) {
            const cut = line.indexOf(FILE_END)
            const at = line.slice(STAT.length, cut)
            const body = line.slice(cut + FILE_END.length)
            // " path | 12 ++++---": the bars in color, the rest plain
            const m = /^(.*\|\s*\S+ ?)(\+*)(-*)$/.exec(body)
            const stat = m ? (
              <Text wrap="wrap">
                {m[1]}
                <Text color="green">{m[2]}</Text>
                <Text color="red">{m[3]}</Text>
              </Text>
            ) : (
              <Text wrap="wrap">{body}</Text>
            )
            // a file's line takes a press: its change in this commit
            return at === '' ? (
              stat
            ) : (
              <Button key={`file:${at}`} plain onPress={() => showCommitFile($, Number(at))}>
                {stat}
              </Button>
            )
          }
          return (
            <Text color={lineColor(line)} wrap="wrap">
              {line}
            </Text>
          )
        })}
        {all.length > lines.length && <Text dimColor>… {all.length - lines.length} more lines</Text>}
        </Box>
      </Box>
    )
  })

  // Each panel scrolls on its own: the wheel scrolls the panel under the pointer,
  // the scroll keys (no pointer) the lower one. No next(e): the pane's own window
  // stays put.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const v = await read($, view)
    // not a repo: the pane is all tree
    if (v.error) return scrollTree($, e, next)
    if (await read($, picker)) {
      const b = await read($, branches)
      const { localRows, remoteRows, remoteStart } = pickerLayout(e.bodyRows)
      if (e.pointer !== undefined && e.pointer.row < remoteStart) {
        await update($, localTop, top => clamp(top + e.by, b.local.length, localRows))
      } else {
        await update($, remoteTop, top => clamp(top + e.by, b.remote.length, remoteRows))
      }
      return {}
    }
    const changes = (await read($, changesTab)) === 'stash' ? (await read($, stashes)).length : v.status.split('\n').length - 1
    const { changeRows, bottomRows, changesStart, bottomStart } = layout(e.bodyRows)
    // over the tree: the tree's own scrolling (its rows, its preview, its split)
    if (e.pointer !== undefined && e.pointer.row >= HEAD_ROWS && e.pointer.row < changesStart) return scrollTree($, e, next)
    if (e.pointer !== undefined && e.pointer.row < bottomStart) {
      await update($, changesTop, top => clamp(top + e.by, changes, changeRows))
    } else {
      const total = v.graph.split('\n').length
      await update($, bottomTop, top => clamp(top + e.by, total, bottomRows))
    }

    return {}
  })
}
