// From filetree 0.6.0 (MIT, Kurt Buhler): the file tree's types.
export type FileNode = {
  id: string
  parent: string
  name: string
  kind: 'dir' | 'file' | 'link'
  hidden: boolean
  mtime: number
  size: number
  loaded: boolean
}

export type Branch = {
  head: string
  upstream: string
  ahead: number
  behind: number
}

export type Activity = {
  id: number
  kind: string
  label: string
  state: 'running' | 'done' | 'failed'
  detail: string
  at: number
  tone: string
  nerd: string
  plain: string
}

export type FileTree = {
  root: string
  nodes: FileNode[]
  expanded: string[]
  cursor: string
  selected: string
  query: string
  searchCase: boolean
  searchRegex: boolean
  searchScope: string
  autoCollapse?: boolean
  sortCol: '' | 'name' | 'git' | 'metric'
  sortDir: 'desc' | 'asc'
  showHidden: boolean
  column: 'date' | 'size' | 'loc'
  dirSizes: Record<string, number>
  git: Record<string, string>
  diff: Record<string, [number, number]>
  ignored: string[]
  untrackedDirs: string[]
  top: string
  prefix: string
  branch: Branch | null
  counts: Record<string, [number, number, number]>
  flash: string[]
  flashDim: string[]
  flashOn: boolean
  flashTones: Record<string, string>
  scroll: number | null
  preview: string
  previewTop: number
  split: boolean
}

export type Theme = {
  fg: string
  accent: string
  muted: string
  urgent: string
  selection: string
  bg: string
}

export type GitView = { root: string; status: string; graph: string; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'git-pane': {
      view: GitView
      selected: string | null
      diff: string
      changesTop: number
      bottomTop: number
      picker: boolean
      branches: { local: string[]; remote: string[] }
      pick: string | null
      menu: string | null
      menuOpt: 'merge' | 'rebase'
      notice: string
      localTop: number
      remoteTop: number
      graphAll: boolean
      commit: string | null
      commitText: string
      commitFiles: string[]
      commitFile: string | null
      commitFileText: string
      // the file tree (from filetree 0.6.0, MIT)
      tree: FileTree
      theme: Theme
      activity: Activity[]
      visits: Record<string, { n: number; at: number }>
    }
  }
}
