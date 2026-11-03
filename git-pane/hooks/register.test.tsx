import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const pane = (bodyRows: number) =>
  ({
    component: 'Pane',
    requestId: 'git-pane',
    props: {
      title: 'Git',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const
const PANE = pane(30)
// what the engine stamps on a command the person typed
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

type Pointer = {
  pointer: (e: { type: 'down' | 'up'; x: number; y: number; button: 'left' | 'right'; in: string }) => Promise<void>
  resize: (size: { columns: number; rows: number; in: string }) => Promise<void>
}
// A click on a branch row in the terminal: its hit Client takes the pointer.
// The row is laid out first, as the terminal measures it: a button let go
// outside the row is no click.
const click = async (ui: Pointer, key: string, upAt = { x: 0, y: 0 }) => {
  await ui.resize({ columns: 40, rows: 1, in: `bhit:${key}` })
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: `bhit:${key}` })
  await ui.pointer({ type: 'up', ...upAt, button: 'left', in: `bhit:${key}` })
}
const rightClick = (ui: Pointer, key: string) => ui.pointer({ type: 'down', x: 0, y: 0, button: 'right', in: `bhit:${key}` })

test('outside a repo the pane shows the git error', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('process.run', async () => ok('', 128, 'fatal: not a git repository'))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
})

test('outside a repo session start opens the pane for the file tree', async ($, on) => {
  on('session.cwd', async () => ({ value: '/home/u/plain' }))
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  on('session.id', async () => ({ value: 'test-session' }))
  const opened: string[] = []
  on('process.run', async () => ok('', 128, 'fatal: not a git repository'))
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.root', async () => ({ value: '/home/u/plain' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/home/u/plain', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['git-pane'])
  await clock.advance(100) // let the tree's start-up work settle before the test ends
})

test('inside a repo session start opens the pane', async ($, on) => {
  on('session.cwd', async () => ({ value: '/home/u/wt-a' }))
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  on('session.id', async () => ({ value: 'test-session' }))
  const opened: string[] = []
  on('process.run', async (_$, e) => (e.argv[1] === 'status' ? ok('## main\n') : ok('x\n')))
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['git-pane'])
  await clock.advance(100) // let the tree's start-up work settle before the test ends
})

test('inside a repo the pane shows the branch, the actions, the tree, changes and graph, each but the branch in a border', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('process.run', async (_$, e) =>
    e.argv[1] === 'rev-parse'
      ? ok('/home/u/wt-a\n')
      : e.argv[1] === 'status'
      ? ok('## main...origin/main [ahead 2]\n M a.py\n?? b.py\n')
      : ok('* abc123 (HEAD -> main) first\n'),
  )
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-pane', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^wt-a$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^\/home\/u\/wt-a$/ })).toBeUndefined() // the path row is gone
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(b => b.props.borderStyle === 'round').length).toBe(4) // actions, tree, Changes, Graph
    expect(boxes.some(b => b.props.paddingLeft === 1 && JSON.stringify(b.children).includes('"branch"'))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s*\[ahead 2\]$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /origin/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Changes \(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeDefined()
    for (const act of ['fetch', 'pull', 'push', 'stash', 'stash-pop']) expect(await ui.find({ type: 'Button', key: `act:${act}` })).toBeDefined()
    await ui.unmount()
  }
})

test('git runs in the session root, not where a shell cd left the session', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const cwds: (string | undefined)[] = []
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  on('session.cwd', async () => ({ value: '/elsewhere' }))
  on('process.run', async (_$, e) => {
    cwds.push(e.init?.cwd)
    return e.argv[1] === 'status' ? ok('## main\n M a.py\n') : ok('x\n')
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'f:a.py' })
  await ui.unmount()
  expect(cwds.length).toBeGreaterThan(3)
  expect(cwds.every(c => c === '/home/u/wt-a')).toBe(true)
})

test('pressing a file swaps the graph panel for its diff, and back', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[1] === 'status') return ok('## main\n M a.py\n?? b.py\n')
    if (e.argv[1] === 'log') return ok('* abc123 (HEAD -> main) first\n')
    return ok(`diff --git x\n@@ -1 +1 @@\n-old\n+new ${e.argv.at(-1)}\n`)
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-pane', surface, ...PANE })
    await ui.press({ key: 'f:a.py' })
    expect(await ui.find({ type: 'Text', text: /Diff: a\.py/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+new a\.py/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeUndefined()

    await ui.press({ key: 'diff-back' })
    expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeDefined()

    await ui.press({ key: 'f:b.py' })
    expect(await ui.find({ type: 'Text', text: /\+new b\.py/ })).toBeDefined()
    await ui.press({ key: 'f:b.py' })
    expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeDefined()
    await ui.unmount()
  }
  expect(calls.some(a => a.includes('--no-index') && a.at(-1) === 'b.py')).toBe(true)
  expect(calls.some(a => a.includes('HEAD') && a.at(-1) === 'a.py')).toBe(true)
})

test('each panel scrolls on its own: tree, Changes and Graph', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const files = Array.from({ length: 30 }, (_, i) => ` M f${i}.py`).join('\n')
  const commits = Array.from({ length: 50 }, (_, i) => `* c${i} msg`).join('\n')
  on('process.run', async (_$, e) => (e.argv[1] === 'status' ? ok(`## main\n${files}\n`) : ok(`${commits}\n`)))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  // bodyRows 40: branch 0, actions box 1-3, tree box 4-17, Changes box 18-24 (list 20-23), Graph box 25-39 (list 27-38)
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(40) })
  const wheel = (row: number | undefined, by: number) =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'git-pane',
      offset: 0,
      by,
      bodyRows: 40,
      contentRows: 40,
      origin: { kind: 'person' },
      ...(row === undefined ? {} : { pointer: { column: 5, row } }),
    })

  expect(await ui.find({ type: 'Text', text: /1-4\/30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1-12\/50/ })).toBeDefined()

  await wheel(10, 3) // over the tree: Changes and Graph stay
  expect(await ui.find({ type: 'Text', text: /1-4\/30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1-12\/50/ })).toBeDefined()

  await wheel(21, 3) // over Changes
  expect(await ui.find({ type: 'Text', text: /4-7\/30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ M f3\.py$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ M f0\.py$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1-12\/50/ })).toBeDefined()

  await wheel(28, 5) // over Graph
  expect(await ui.find({ type: 'Text', text: /6-17\/50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4-7\/30/ })).toBeDefined()

  await wheel(undefined, 100) // scroll keys: Graph, clamped to the end
  expect(await ui.find({ type: 'Text', text: /39-50\/50/ })).toBeDefined()

  await wheel(21, -100) // clamped to the top
  expect(await ui.find({ type: 'Text', text: /1-4\/30/ })).toBeDefined()
  await ui.unmount()
})

test('Changes keeps its height whatever it holds: the Graph below shows as many rows', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const commits = Array.from({ length: 50 }, (_, i) => `* c${i} msg`).join('\n')
  let files = ' M a.py'
  on('process.run', async (_$, e) => (e.argv[1] === 'status' ? ok(`## main\n${files}\n`) : ok(`${commits}\n`)))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(40) })
  expect(await ui.find({ type: 'Text', text: /1-12\/50/ })).toBeDefined()
  await ui.unmount()
  files = Array.from({ length: 30 }, (_, i) => ` M f${i}.py`).join('\n')
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui2 = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(40) })
  expect(await ui2.find({ type: 'Text', text: /1-12\/50/ })).toBeDefined()
  await ui2.unmount()
})

test('the file tree sits between the header and Changes, drawn from the session cwd', async ($, on) => {
  mock.env(on, {})
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  on('process.run', repo(calls))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  on('session.cwd', async () => ({ value: '/home/u/wt-a' }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 1_700_000_000_000, isLink: false })
  on('fs.list', async (_$, e) => {
    if (e.path === '/home/u/wt-a') return { value: [entry('README.md', 'file'), entry('src', 'dir')] }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.stat', async (_$, e) => {
    if (e.path === '/home/u/wt-a' || e.path === '/home/u/wt-a/src') return { value: { kind: 'dir', size: 1, mtimeMs: 1, isLink: false } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.read', async () => {
    throw new Error('no file')
  })
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(40) })
  expect(await ui.find({ type: 'Client', key: 'rows' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).toContain('README.md')
  const all = JSON.stringify(await ui.drawn())
  expect(all.indexOf('"rows"')).toBeGreaterThan(all.indexOf('stash pop'))
  expect(all.indexOf('"rows"')).toBeLessThan(all.indexOf('Changes ('))
  await ui.unmount()
})

test('/git-close closes the pane', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const closed: string[] = []
  on('ui.close', async (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  const ran = await $.command.run({ command: 'git-close', args: '', ...TYPED })
  expect(closed).toEqual(['git-pane'])
  expect(ran.text).toBe('Git pane closed.')
})

// A repo on main with dev locally and origin/{main,dev,feat,feature/x}, and an
// untracked new.py always there. `dirty` is the tracked changes; a porcelain
// status that counts untracked files too sees new.py, so a check that forgot
// --untracked-files=no would block every checkout. `fail` makes that git
// subcommand exit 1 with the given stderr. `head` is the status branch line.
const repo =
  (calls: string[][], dirty = '', fail: Record<string, string> = {}, head = '## main...origin/main') =>
  async (_$: unknown, e: { argv: readonly string[] }) => {
    calls.push([...e.argv])
    const a = e.argv
    const sub = a[1] ?? ''
    if (sub in fail) return ok('', 1, fail[sub])
    if (sub === 'rev-parse') return ok('/home/u/wt-a\n')
    if (sub === 'status')
      return a.includes('--porcelain') ? ok(a.includes('--untracked-files=no') ? dirty : `${dirty}?? new.py\n`) : ok(`${head}\n?? new.py\n`)
    if (sub === 'for-each-ref')
      return ok(
        'refs/heads/dev\nrefs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/dev\nrefs/remotes/origin/feat\nrefs/remotes/origin/feature/x\nrefs/remotes/origin/main\n',
      )
    if (sub === 'show-ref') return ['refs/heads/dev', 'refs/heads/main'].includes(a.at(-1) ?? '') ? ok('') : ok('', 1)
    if (['switch', 'merge', 'rebase', 'fetch', 'pull', 'push', 'stash'].includes(sub)) return ok('done\n')
    return ok('* abc123 (HEAD -> main) first\n')
  }
const ran = (calls: string[][], ...subs: string[]) => calls.filter(a => subs.includes(a[1] ?? ''))
const setup = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], handler: ReturnType<typeof repo>) => {
  on('process.run', handler)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
}

test('checkout is blocked while tracked files are changed', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls, ' M a.py\nM  b.py\n'))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev')
  await clock.advance(100)
  await click(ui, 'b:dev')
  expect(ran(calls, 'switch')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Checkout blocked: 2 tracked/ })).toBeDefined()
  await ui.unmount()
})

test('a single click, or two clicks far apart, does not check out', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev')
  await clock.advance(600)
  await click(ui, 'b:dev')
  await clock.advance(100)
  await click(ui, 'r:origin/feat') // a different branch: not a double click
  expect(ran(calls, 'switch')).toEqual([])
  await ui.unmount()
})

test('the branch picker lists local and remote branches apart, without origin/HEAD', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  await setup($, on, repo(calls))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-pane', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Local \(/ })).toBeUndefined()
    await ui.press({ key: 'branch' })
    expect(await ui.find({ type: 'Text', text: /^Local \(2\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Remote \(4\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^dev$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^origin\/feat$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /origin\/HEAD/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeUndefined()
    await ui.press({ key: 'picker-close' })
    expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a double click on a local branch switches to it and closes the picker', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev')
  await clock.advance(200)
  await click(ui, 'b:dev')
  expect(ran(calls, 'switch')).toEqual([['git', 'switch', '--', 'dev']])
  expect(await ui.find({ type: 'Text', text: /^Local \(2\)$/ })).toBeUndefined()
  await ui.unmount()
})

test('a double press on desktop checks out through the Button', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'desktop', ...PANE })
  await ui.press({ key: 'branch' })
  await ui.press({ key: 'b:dev' })
  await clock.advance(200)
  await ui.press({ key: 'b:dev' })
  expect(ran(calls, 'switch')).toEqual([['git', 'switch', '--', 'dev']])
  await ui.unmount()
})

test('a double click on a remote branch tracks it, or switches to the local one of its name', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  const double = async (key: string) => {
    await ui.press({ key: 'branch' })
    await click(ui, key)
    await clock.advance(200)
    await click(ui, key)
    await clock.advance(1000)
  }
  await double('r:origin/feat')
  await double('r:origin/dev')
  await double('r:origin/feature/x')
  expect(ran(calls, 'switch')).toEqual([
    ['git', 'switch', '--track', 'origin/feat'],
    ['git', 'switch', '--', 'dev'],
    ['git', 'switch', '--track', 'origin/feature/x'],
  ])
  await ui.unmount()
})

test('a failed switch shows the first line of the git error and keeps the picker open', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  const err = 'error: The following untracked working tree files would be overwritten by checkout:\n\tnew.py\nAborting\n'
  await setup($, on, repo(calls, '', { switch: err }))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev')
  await clock.advance(200)
  await click(ui, 'b:dev')
  expect(ran(calls, 'switch')).toEqual([['git', 'switch', '--', 'dev']])
  expect(await ui.find({ type: 'Text', text: /^error: The following untracked .*checkout:$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Aborting/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Local \(2\)$/ })).toBeDefined()
  await ui.unmount()
})

test('a click selects a branch and the checkout button switches to it', async ($, on) => {
  const calls: string[][] = []
  mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  expect(await ui.find({ type: 'Button', key: 'checkout' })).toBeUndefined()
  await click(ui, 'r:origin/feat')
  expect(ran(calls, 'switch')).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'checkout' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'picker-close' })).toBeDefined()
  await ui.press({ key: 'checkout' })
  expect(ran(calls, 'switch')).toEqual([['git', 'switch', '--track', 'origin/feat']])
  expect(await ui.find({ type: 'Text', text: /^Local \(2\)/ })).toBeUndefined()
  await ui.unmount()
})

test('the checkout button is blocked by tracked changes too', async ($, on) => {
  const calls: string[][] = []
  mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls, ' M a.py\n'))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev')
  await ui.press({ key: 'checkout' })
  expect(ran(calls, 'switch')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Checkout blocked: 1 tracked/ })).toBeDefined()
  await ui.unmount()
})

test('a right click opens merge and rebase for that branch, onto the current one', async ($, on) => {
  const calls: string[][] = []
  mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  expect(await ui.find({ type: 'Button', key: 'menu-run' })).toBeUndefined()
  await rightClick(ui, 'b:dev')
  // merge is chosen first, said in full on a row of its own; a choice alone runs nothing
  expect(await ui.find({ type: 'Text', text: /^merge dev into main$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◉ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^○ $/ })).toBeDefined()
  await ui.press({ key: 'opt-rebase' })
  expect(await ui.find({ type: 'Text', text: /^rebase main onto dev$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^merge dev into main$/ })).toBeUndefined()
  await ui.press({ key: 'opt-merge' })
  expect(ran(calls, 'merge', 'rebase')).toEqual([])
  await ui.press({ key: 'menu-run' })
  expect(ran(calls, 'merge', 'rebase')).toEqual([['git', 'merge', '--no-edit', 'refs/heads/dev']])

  await ui.press({ key: 'branch' })
  await rightClick(ui, 'r:origin/feat')
  await ui.press({ key: 'opt-rebase' })
  await ui.press({ key: 'menu-run' })
  expect(ran(calls, 'merge', 'rebase').at(-1)).toEqual(['git', 'rebase', 'refs/remotes/origin/feat'])

  await ui.press({ key: 'branch' })
  await rightClick(ui, 'b:main') // the current branch: nothing to merge
  expect(await ui.find({ type: 'Button', key: 'menu-run' })).toBeUndefined()
  await ui.unmount()
})

test('merge and rebase are blocked by tracked changes', async ($, on) => {
  const calls: string[][] = []
  mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls, ' M a.py\n'))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await rightClick(ui, 'b:dev')
  await ui.press({ key: 'menu-run' })
  expect(await ui.find({ type: 'Text', text: /Merge blocked: 1 tracked/ })).toBeDefined()
  await rightClick(ui, 'b:dev')
  await ui.press({ key: 'opt-rebase' })
  await ui.press({ key: 'menu-run' })
  expect(await ui.find({ type: 'Text', text: /Rebase blocked: 1 tracked/ })).toBeDefined()
  expect(ran(calls, 'merge', 'rebase')).toEqual([])
  await ui.unmount()
})

test('a merge conflict shows the last line git wrote', async ($, on) => {
  const calls: string[][] = []
  const base = repo(calls)
  mock.clock(on, { now: 1000 })
  on('process.run', async (_$, e) =>
    e.argv[1] === 'merge' ? ok('Auto-merging a.py\nCONFLICT (content): Merge conflict in a.py\nAutomatic merge failed; fix conflicts and then commit the result.\n', 1) : base(_$, e),
  )
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await rightClick(ui, 'b:dev')
  await ui.press({ key: 'menu-run' })
  expect(await ui.find({ type: 'Text', text: /^Automatic merge failed; fix conflicts/ })).toBeDefined()
  await ui.unmount()
})

test('the action buttons run fetch, pull --ff-only, push, stash and stash pop', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  for (const act of ['fetch', 'pull', 'push', 'stash', 'stash-pop']) await ui.press({ key: `act:${act}` })
  expect(ran(calls, 'fetch', 'pull', 'push', 'stash')).toEqual([
    ['git', 'fetch'],
    ['git', 'pull', '--ff-only'],
    ['git', 'push'],
    ['git', 'stash', 'push'],
    ['git', 'stash', 'pop'],
  ])
  expect(toasts.some(t => /^pull: /.test(t))).toBe(true)
  await ui.unmount()
})

test('push without an upstream sets one on origin; a failed action toasts the git error', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await setup($, on, repo(calls, '', { pull: 'fatal: Not possible to fast-forward, aborting.\n' }, '## feat'))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'act:push' })
  await ui.press({ key: 'act:pull' })
  expect(ran(calls, 'push')).toEqual([['git', 'push', '-u', 'origin', 'HEAD']])
  expect(toasts).toContain('pull failed: fatal: Not possible to fast-forward, aborting.')
  await ui.unmount()
})

test('the picker orders main, develop, release, then the current branch, then the rest by date', async ($, on) => {
  mock.clock(on, { now: 1000 })
  // for-each-ref --sort=committerdate hands them oldest first
  const refs = ['zeta', 'feat-old', 'release/1.0', 'cur', 'develop', 'main']
  on('process.run', async (_$, e) =>
    e.argv[1] === 'for-each-ref'
      ? ok(`${[...refs.map(r => `refs/heads/${r}`), ...['feat-old', 'cur', 'main', 'release/1.0'].map(r => `refs/remotes/origin/${r}`)].join('\n')}\n`)
      : e.argv[1] === 'status'
      ? ok('## cur\n')
      : ok('* abc first\n'),
  )
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(50) })
  await ui.press({ key: 'branch' })
  const names = (await ui.findAll({ type: 'Text', text: /^(origin\/)?(zeta|feat-old|release\/1\.0|cur|develop|main)$/ })).map(t => t.text)
  expect(names).toEqual(['cur', 'main', 'develop', 'release/1.0', 'cur', 'zeta', 'feat-old', 'origin/main', 'origin/release/1.0', 'origin/cur', 'origin/feat-old'])
  await ui.unmount()
})

test('local and remote lists keep one fixed height each and scroll on their own', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const local = Array.from({ length: 20 }, (_, i) => `refs/heads/l${String(i).padStart(2, '0')}`)
  const remote = Array.from({ length: 30 }, (_, i) => `refs/remotes/origin/r${String(i).padStart(2, '0')}`)
  on('process.run', async (_$, e) =>
    e.argv[1] === 'for-each-ref' ? ok(`${[...local, ...remote].join('\n')}\n`) : e.argv[1] === 'status' ? ok('## l00\n') : ok('* abc first\n'),
  )
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  const wheel = (row: number | undefined, by: number) =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'git-pane',
      offset: 0,
      by,
      bodyRows: 30,
      contentRows: 30,
      origin: { kind: 'person' },
      ...(row === undefined ? {} : { pointer: { column: 5, row } }),
    })
  // bodyRows 30: 4 header rows, Local 5 rows (body rows 6-10), Remote box from body row 12, 5 rows, 4 footer rows
  expect(await ui.find({ type: 'Text', text: /1-5\/20/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1-5\/30/ })).toBeDefined()

  await wheel(8, 3) // over Local
  expect(await ui.find({ type: 'Text', text: /4-8\/20/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1-5\/30/ })).toBeDefined()

  await wheel(14, 5) // over Remote
  expect(await ui.find({ type: 'Text', text: /6-10\/30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4-8\/20/ })).toBeDefined()

  await wheel(undefined, 100) // scroll keys: Remote, clamped to the end
  expect(await ui.find({ type: 'Text', text: /26-30\/30/ })).toBeDefined()
  await ui.unmount()
})

test('a short list keeps its half of the room, padded', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  // Local holds 2 branches in 5 rows, Remote 4 in 5: 4 padding rows, and the footer's empty notice row
  expect((await ui.findAll({ type: 'Text', text: /^ $/ })).length).toBe(5)
  await ui.unmount()
})

test('the picker colors only the Local and Remote titles and borders; branch names stay plain', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  expect((await ui.find({ type: 'Text', text: /^Local \(2\)$/ }))?.props.color).toBe('cyan')
  expect((await ui.find({ type: 'Text', text: /^Remote \(4\)$/ }))?.props.color).toBe('magenta')
  expect((await ui.find({ type: 'Text', text: /^dev$/ }))?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^origin\/feat$/ }))?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^main$/ }))?.props.color).toBe('green') // the current branch
  await ui.unmount()
})

test('one git job at a time: a second press while one runs does nothing', async ($, on) => {
  const calls: string[][] = []
  const base = repo(calls)
  // while `gate` is set, stash pop and rebase wait on it
  let gate: Promise<void> | null = null
  let open = () => {}
  const hold = () => {
    gate = new Promise<void>(r => (open = r))
  }
  mock.clock(on, { now: 1000 })
  on('process.run', async (_$, e) => {
    if (gate && (e.argv[1] === 'stash' || e.argv[1] === 'rebase')) {
      calls.push([...e.argv])
      await gate
      return ok('done\n')
    }
    return base(_$, e)
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })

  hold()
  const first = ui.press({ key: 'act:stash-pop' })
  await ui.press({ key: 'act:stash-pop' })
  open()
  await first
  expect(ran(calls, 'stash')).toEqual([['git', 'stash', 'pop']])

  await ui.press({ key: 'branch' })
  await rightClick(ui, 'b:dev')
  await ui.press({ key: 'opt-rebase' })
  hold()
  const rebasing = ui.press({ key: 'menu-run' })
  await ui.press({ key: 'act:push' })
  open()
  await rebasing
  expect(ran(calls, 'rebase', 'push')).toEqual([['git', 'rebase', 'refs/heads/dev']])
  await ui.unmount()
})

test('a git call that times out is reported, not dropped', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  const base = repo(calls)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[1] === 'push') throw new Error('timed out after 60000ms')
    return base(_$, e)
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'act:push' })
  // the harness rejects a throwing process.run hook in words of its own
  expect(toasts.some(t => /^push failed: git push: /.test(t))).toBe(true)
  await ui.press({ key: 'act:fetch' }) // the lock was let go
  expect(ran(calls, 'fetch')).toEqual([['git', 'fetch']])
  await ui.unmount()
})

test('long changed paths and branch names are cut, not wrapped', async ($, on) => {
  const long = 'x'.repeat(200)
  const calls: string[][] = []
  mock.clock(on, { now: 1000 })
  on('process.run', async (_$, e) => (e.argv[1] === 'status' && !e.argv.includes('--porcelain') ? ok(`## main\n M ${long}.py\n`) : repo(calls)(_$, e)))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  expect((await ui.find({ type: 'Text', text: new RegExp(`^ M ${long}`) }))?.props.wrap).toBe('truncate')
  await ui.press({ key: `f:${long}.py` })
  expect((await ui.find({ type: 'Text', text: /^Diff: x+/ }))?.props.wrap).toBe('truncate')
  await ui.unmount()
})

test('a drag that lets go off the row is no click', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev', { x: 0, y: 3 })
  await clock.advance(100)
  await click(ui, 'b:dev', { x: 50, y: 0 })
  expect(ran(calls, 'switch')).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'checkout' })).toBeUndefined()
  await ui.unmount()
})

test('a click on the current branch clears the selection: no checkout button, no name below', async ($, on) => {
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch' })
  await click(ui, 'b:dev')
  expect(await ui.find({ type: 'Button', key: 'checkout' })).toBeDefined()
  await clock.advance(1000)
  await click(ui, 'b:main') // the current branch
  expect(await ui.find({ type: 'Button', key: 'checkout' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /^main$/ })).length).toBe(2) // the header and its row, not the footer
  await clock.advance(100)
  await click(ui, 'b:main') // a double click on it switches nothing
  expect(ran(calls, 'switch')).toEqual([])
  await ui.unmount()
})

test('the graph shows the current branch by default; all and current switch it, and the poll keeps it', async ($, on) => {
  on('session.cwd', async () => ({ value: '/home/u/wt-a' }))
  mock.env(on, {})
  on('session.id', async () => ({ value: 'test-session' }))
  const calls: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  on('process.run', repo(calls))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  const logs = () => ran(calls, 'log')
  const last = () => logs().at(-1) ?? []
  expect(logs().length).toBeGreaterThan(0)
  expect(logs().every(a => !a.includes('--all'))).toBe(true)

  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...PANE })
  expect((await ui.find({ type: 'Text', text: /^current$/ }))?.props.bold).toBe(true)
  await ui.press({ key: 'graph-all' })
  expect(last()).toContain('--all')
  expect((await ui.find({ type: 'Text', text: /^all$/ }))?.props.bold).toBe(true)
  await clock.advance(3000) // the poll
  expect(last()).toContain('--all')

  await ui.press({ key: 'graph-current' })
  expect(last()).not.toContain('--all')
  await clock.advance(3000)
  expect(last()).not.toContain('--all')

  // a diff in the lower panel: no scope buttons beside its title
  await ui.press({ key: 'graph-all' })
  await setupDiff(ui)
  expect(await ui.find({ type: 'Button', key: 'graph-all' })).toBeUndefined()
  await ui.unmount()
})
const setupDiff = (ui: { press: (t: { key: string }) => Promise<unknown> }) => ui.press({ key: 'f:new.py' })

// The file tree's settings live in git-pane's userConfig now: glyphs 'text'
// draws the tree's header buttons as words.
for (const glyphs of ['text', 'plain'] as const)
  test(`the tree's settings reach it from git-pane's own config (glyphs ${glyphs})`, { options: { glyphs } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    mock.env(on, {})
    const calls: string[][] = []
    on('process.run', repo(calls))
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('session.root', async () => ({ value: '/home/u/wt-a' }))
    on('session.cwd', async () => ({ value: '/home/u/wt-a' }))
    on('session.id', async () => ({ value: 'test-session' }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('fs.list', async () => ({ value: [{ name: 'README.md', kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }] }))
    on('fs.stat', async () => ({ value: { kind: 'dir' as const, size: 1, mtimeMs: 1, isLink: false } }))
    on('fs.read', async () => {
      throw new Error('no file')
    })
    await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
    await clock.advance(100)
    const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(60) })
    const drawn = JSON.stringify(await ui.drawn())
    expect(/"label":"sync"/.test(drawn)).toBe(glyphs === 'text')
    await ui.unmount()
    await clock.advance(100)
  })

// The tree's preview has a `back` Button of its own: with the tree's preview and
// git-pane's Diff both open, each back closes its own.
test('the Diff back button and the tree preview back button are told apart', { options: { open: 'preview' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  const calls: string[][] = []
  on('process.run', repo(calls))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  on('session.cwd', async () => ({ value: '/home/u/wt-a' }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.list', async (_$, e) => {
    if (e.path === '/home/u/wt-a') return { value: [{ name: 'README.md', kind: 'file' as const, size: 6, mtimeMs: 1, isLink: false }] }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.stat', async (_$, e) =>
    e.path === '/home/u/wt-a' ? { value: { kind: 'dir' as const, size: 1, mtimeMs: 1, isLink: false } } : { value: { kind: 'file' as const, size: 6, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', async (_$, e) => {
    if (e.path === '/home/u/wt-a/README.md') return { value: '# hello\n' }
    throw new Error('no file')
  })
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(60) })
  await ui.post({ press: '/home/u/wt-a/README.md' }, { in: 'rows' })
  await ui.post({ press: '/home/u/wt-a/README.md' }, { in: 'rows' })
  await clock.advance(100)
  await ui.press({ key: 'f:new.py' }) // git-pane's Diff
  expect(await ui.find({ type: 'Text', text: /^Diff: new\.py/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button', key: 'back' })).length).toBe(1) // the tree preview's own
  await ui.press({ key: 'diff-back' })
  expect(await ui.find({ type: 'Text', text: /^Diff: / })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined() // the preview stays open
  await ui.unmount()
  await clock.advance(100)
})

// A world: a folder with 40 files, outside a repo unless `repoRoot` is given.
const treeWorld = (on: Parameters<TestBody>[1], calls: string[][], repoRoot = '', opened: string[] = []) => {
  const root = '/home/u/wt-a'
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }))
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[1] === 'status' || e.argv[1] === 'rev-parse')
      return repoRoot ? ok(e.argv[1] === 'status' ? '## main\n' : `${repoRoot}\n`) : ok('', 128, 'fatal: not a git repository (or any of the parent directories): .git')
    return ok('')
  })
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.root', async () => ({ value: root }))
  on('session.cwd', async () => ({ value: root }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.list', async (_$, e) => {
    if (e.path === root) return { value: files }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.stat', async (_$, e) => (e.path === root ? { value: { kind: 'dir' as const, size: 1, mtimeMs: 1, isLink: false } } : { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => {
    throw new Error('no file')
  })
  return root
}
const rowsOfTree = async (ui: { drawn: (scope?: { in?: string }) => Promise<unknown> }) => {
  const drawn = JSON.stringify(await ui.drawn({ in: 'rows' }))
  return [...drawn.matchAll(/f\d\d\.txt/g)].map(m => m[0])
}

test('outside a repo the pane shows the tree under one line saying why there is no git', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  const calls: string[][] = []
  const opened: string[] = []
  treeWorld(on, calls, '', opened)
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  expect(opened).toEqual(['git-pane'])
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(40) })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
  // a plain line saying it is the git pane, not git's own error
  expect(await ui.find({ type: 'Text', text: /^Git · not a git repository/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fatal:/ })).toBeUndefined()
  expect((await rowsOfTree(ui)).length).toBeGreaterThan(20) // the tree has the room Changes and Graph would take
  expect(await ui.find({ type: 'Text', text: /^Changes/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'branch' })).toBeUndefined()
  await ui.unmount()
  await clock.advance(100)
})

test('open at start off: outside a repo the pane waits for /git', { options: { start: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  const calls: string[][] = []
  const opened: string[] = []
  treeWorld(on, calls, '', opened)
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  expect(opened).toEqual([])
  await clock.advance(100)
})

test('on a surface the tree does not draw for, the pane still draws its git parts', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  await setup($, on, repo(calls))
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Changes \(/ })).toBeDefined()
  await ui.unmount()
})

test('a short pane still gives the tree the rows it draws', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  const calls: string[][] = []
  treeWorld(on, calls, '/home/u/wt-a')
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(24) })
  // the tree's region holds its 6 rows of chrome and its list: no file row is drawn past it
  const region = (await ui.findAll({ type: 'Box' })).find(b => b.props.overflow === 'hidden' && typeof b.props.height === 'number')
  const height = Number(region?.props.height)
  const listRows = ((await ui.find({ type: 'Client', key: 'rows' }))?.props.props as { rows?: unknown[] } | undefined)?.rows?.length ?? 0
  expect(listRows).toBeGreaterThan(0)
  expect(listRows + 6).toBeLessThanOrEqual(height)
  await ui.unmount()
  await clock.advance(100)
})

test('the wheel over the tree scrolls the tree', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, {})
  const calls: string[][] = []
  treeWorld(on, calls, '/home/u/wt-a')
  await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(40) })
  const before = await rowsOfTree(ui)
  expect(before[0]).toBe('f00.txt')
  await $.ui.scroll({ component: 'Pane', requestId: 'git-pane', offset: 0, by: 5, bodyRows: 40, contentRows: 40, origin: { kind: 'person' }, pointer: { column: 5, row: 8 } })
  await clock.advance(100)
  expect((await rowsOfTree(ui))[0]).not.toBe('f00.txt')
  await ui.unmount()
  await clock.advance(100)
})

test('a click on a commit in the graph shows that commit: message, files and changes; back returns to the graph', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: string[][] = []
  const base = repo(calls)
  on('process.run', async (_$, e) => {
    if (e.argv[1] === 'log') return ok('* abc1234 (HEAD -> main) first\n|\\\n| * def5678 other\n|/\n')
    if (e.argv[1] === 'show' && e.argv.includes('--name-only')) return ok('a.py\0b.py\0')
    if (e.argv[1] === 'show' && e.argv.includes('--')) {
      calls.push([...e.argv])
      return ok(`diff --git a/${e.argv.at(-1)} b/${e.argv.at(-1)}\n@@ -1 +1 @@\n-was ${e.argv.at(-1)}\n+now ${e.argv.at(-1)}\n`)
    }
    if (e.argv[1] === 'show') {
      calls.push([...e.argv])
      return ok(`commit ${e.argv.at(-1)}\nAuthor: u\n\n    the message\n\n a.py | 2 +-\n b.py | 3 ---\n 2 files changed, 1 insertion(+), 4 deletions(-)\n\ndiff --git a/a.py b/a.py\n@@ -1 +1 @@\n-old\n+new\n`)
    }
    return base(_$, e)
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/home/u/wt-a' }))
  await $.command.run({ command: 'git', args: '', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'git-pane', surface: 'terminal', ...pane(50) }) // 16 rows for the commit
  // only lines with a commit take a click
  expect(await ui.find({ type: 'Client', key: 'chit:abc1234' })).toBeDefined()
  expect(await ui.find({ type: 'Client', key: 'chit:def5678' })).toBeDefined()
  expect((await ui.findAll({ type: 'Client' })).filter(c => String(c.key).startsWith('chit:')).length).toBe(2)
  await ui.resize({ columns: 40, rows: 1, in: 'chit:def5678' })
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'chit:def5678' })
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'chit:def5678' })
  expect(ran(calls, 'show')).toEqual([['git', 'show', '--no-color', '--stat', '--patch', '--diff-merges=first-parent', 'def5678']])
  expect(await ui.find({ type: 'Text', text: /^Commit def5678/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /the message/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\+new$/ }))?.props.color).toBe('green')
  // a rule between the message and the files, and between the files and the patch
  const rules = await ui.findAll({ type: 'Text', text: /^─+$/ })
  expect(rules.length).toBe(2)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = (re: RegExp) => texts.findIndex(t => re.test(t))
  expect(at(/the message/)).toBeLessThan(at(/^─+$/))
  expect(at(/^─+$/)).toBeLessThan(at(/^ a\.py \| 2 /))
  // the stat's bars in color: + green, - red
  const bars = await ui.findAll({ type: 'Text', text: /^(\+|-|\+-|---)$/ })
  expect(bars.some(t => t.text === '+' && t.props.color === 'green')).toBe(true)
  expect(bars.some(t => t.text === '---' && t.props.color === 'red')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /abc1234/ })).toBeUndefined()

  // a file in the stat takes a click: that file's change in this commit; back goes to the commit
  expect(await ui.find({ type: 'Client', key: 'fhit:1' })).toBeDefined()
  expect((await ui.findAll({ type: 'Client' })).filter(c => String(c.key).startsWith('fhit:')).length).toBe(2) // not the summary line
  await ui.resize({ columns: 40, rows: 1, in: 'fhit:1' })
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'fhit:1' })
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'fhit:1' })
  expect(ran(calls, 'show').at(-1)).toEqual(['git', 'show', '--no-color', '--format=', '--patch', '--diff-merges=first-parent', 'def5678', '--', 'b.py'])
  expect(await ui.find({ type: 'Text', text: /^def5678 · b\.py/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\+now b\.py$/ }))?.props.color).toBe('green')
  expect(await ui.find({ type: 'Text', text: /the message/ })).toBeUndefined()
  await ui.press({ key: 'diff-back' })
  expect(await ui.find({ type: 'Text', text: /the message/ })).toBeDefined()
  await ui.press({ key: 'diff-back' })
  expect(await ui.find({ type: 'Text', text: /abc1234/ })).toBeDefined()
  await ui.unmount()
})

// Opened unasked at start, a pane waits undrawn on a terminal narrower than the
// engine's floor: say so once, and how to open it.
for (const placed of [false, true])
  test(`at start a pane left waiting on a narrow terminal says how to open it (placed ${placed})`, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    mock.env(on, {})
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('process.run', async (_$, e) => (e.argv[1] === 'status' ? ok('## main\n') : ok('x\n')))
    on('ui.open', async () => ({ value: placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'below 144 columns (100 now)' } }))
    on('session.root', async () => ({ value: '/home/u/wt-a' }))
    on('session.cwd', async () => ({ value: '/home/u/wt-a' }))
    on('session.id', async () => ({ value: 'test-session' }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: '/home/u/wt-a', surface: 'terminal', isInteractive: true })
    await clock.advance(100)
    expect(toasts.filter(t => /\/git/.test(t) && /narrow|wait/i.test(t)).length).toBe(placed ? 0 : 1)
    await clock.advance(100)
  })
