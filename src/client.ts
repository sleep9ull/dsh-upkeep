/* ------------------------------------------------------------------ *
 * Types
 * The Client half is a browser script, not a module: the Harness module
 * loader calls the factory with a `require` table that holds react and
 * nothing else, so there is no import or export anywhere below.
 * ------------------------------------------------------------------ */

type Child = unknown
type PostChildren = Child | Child[]

type ElementProps = {
  [key: string]: unknown
  children?: PostChildren
  className?: string
  key?: string | number
  id?: string
  role?: string
  title?: string
  type?: string
  disabled?: boolean
  onClick?: () => void
}

type VNode = { type: unknown; props: ElementProps }

type Component<P extends object> = (props: P) => Child

interface CreateElement {
  (type: string, props?: ElementProps | null, ...children: PostChildren[]): VNode
  <P extends object>(type: Component<P>, props?: P | null, ...children: PostChildren[]): VNode
}

type SetState<T> = (next: T | ((prev: T) => T)) => void

type ReactModule = {
  createElement: CreateElement
  useState<T>(initial: T | (() => T)): [T, SetState<T>]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useCallback<T>(fn: T, deps?: readonly unknown[]): T
  useSyncExternalStore<T>(subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T
}

type Translate = (key: string, params?: Record<string, unknown>) => string

/* ---- the wire ---------------------------------------------------- */

type JsonData = { [key: string]: unknown }
type WireErrorLike = { code?: unknown; message?: unknown; details?: { text?: unknown } | null }
type WireReply = { ok?: unknown; value?: unknown; error?: WireErrorLike | null } | null | undefined
type RpcFailure = { code: string; message: string }

/* ---- Host payloads ----------------------------------------------- */

type OwnershipVerdict = { status?: 'mine' | 'other' | 'unknown'; evidence?: string[] }
type MaintenanceVerdict = { state?: 'ok' | 'attention' | 'unknown' | 'not-mine'; reasons?: string[] }

type EvaluationView = {
  status?: 'compatible' | 'incompatible' | 'unknown'
  requirements?: Record<string, string>
  exempted?: boolean
  reason?: string
}

type BundleCompat = {
  running?: EvaluationView
  target?: EvaluationView | null
  runtime?: { failed?: number; pending?: number }
  impact?: {
    matched?: number
    versions?: string[]
    top?: Array<{ version?: string; item?: string; description?: string }>
  }
}

type TargetVersion = {
  version?: string | null
  channel?: string | null
  fetchedAt?: number | null
  source?: 'config' | 'network' | 'cache' | 'none'
  stale?: boolean
}

type LastCheckView = {
  at?: number
  runtimeVersion?: string | null
  targetVersion?: string | null
  total?: number
  needsCare?: number
}

type BundleSummary = {
  name?: string
  version?: string | null
  enabled?: boolean
  official?: boolean
  availability?: string | null
  source?: string | null
  rowCount?: number
  error?: { code?: string; diagnostic?: string | null } | null
  owner?: OwnershipVerdict
  maintenance?: MaintenanceVerdict
  compat?: BundleCompat
}

type StatusSnapshot = {
  checkedAt?: number
  plugin?: { name?: string; version?: string }
  dsh?: { runtimeVersion?: string | null; installAnchor?: string | null }
  profile?: { name?: string | null; dir?: string | null }
  target?: TargetVersion
  lastCheck?: LastCheckView
  bundles?: BundleSummary[]
  plugins?: { entryCount?: number | null }
  excluded?: { bundles?: number; entries?: number }
  ownership?: {
    mine?: number
    other?: number
    unknown?: number
    needsMaintenance?: number
    identity?: { handles?: string[]; sources?: string[] }
  }
  warnings?: string[]
}

type StorePhase = 'idle' | 'loading' | 'checking' | 'upgrading' | 'ready' | 'error'
type UpgradeNotice = { kind: 'ok' | 'error'; text: string; runId?: string }
type StoreState = { phase: StorePhase; data: StatusSnapshot | null; error: RpcFailure | null; notice?: UpgradeNotice }
type Store = {
  subscribe(listener: () => void): () => void
  get(): StoreState
  /** Read the Host snapshot without touching the registry. */
  refresh(): Promise<void>
  /** Refresh the target from the registry, evaluate, and store one report. */
  check(): Promise<void>
  /** Prepare a targeted upgrade and open the session with its prompt. */
  upgrade(bundle: string, worktree: boolean): Promise<void>
  /** Run the prepared verification commands for one run. */
  verify(runId: string): Promise<void>
}

/* ---- the Cordis services the plugin is applied to ---------------- */

type LocaleService = {
  bind(namespace: string): Translate
  register(namespace: string, dicts: { en: Record<string, string>; zh: Record<string, string> }): () => void
  getLocale(): unknown
}

type SlotOptions = {
  [key: string]: unknown
  name?: string
  id?: string
  key?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: () => unknown
}

type ClientContext = {
  connection: {
    rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<WireReply> }
  }
  /** Panel navigation; present whenever the shell is mounted. */
  layout: { selectPanel(panelId: string): void }
  /** Start a Session in a prepared workspace with the upgrade prompt prefilled. */
  uiWorkspace: { startSession(workspaceId?: string, options?: { prompt?: string }): void }
  locale: LocaleService
  slots: {
    inject(key: string, callback: () => unknown, label: string): unknown
    register(options: SlotOptions, component: (props: never) => unknown): unknown
  }
  effect(callback: () => unknown, label: string): unknown
}

type ModuleDefinition = {
  id: string
  factory(require: (id: 'react') => ReactModule): { inject: readonly string[]; apply(ctx: ClientContext): void }
}

interface Window {
  __ModuleLoader__: { load(definition: ModuleDefinition): void; __dshUpkeepRegistered?: boolean }
}

;(function registerUpkeep(loader: Window['__ModuleLoader__']): void {
  if (loader.__dshUpkeepRegistered === true) return
  loader.__dshUpkeepRegistered = true
  loader.load({
    // The module id is the package name: the boot manifest keys plugins by
    // package and the loader imports that id.
    id: '@sleep9ull/dsh-upkeep',
    factory(require) {
      const React = require('react')
      const h: CreateElement = React.createElement

      const NS = 'upkeep'
      /** Settings-tab cell id; the main panel reuses it so both entries address one thing. */
      const TAB_ID = 'dsh-upkeep'
      /** First-level sidebar panel id: the `main` key and the `sidebar.panellist` icon id agree. */
      const PANEL_ID = TAB_ID
      /** Remembered choice for the "other plugins" group; hidden until the reader opens it. */
      const OTHERS_OPEN_KEY = 'dsh.upkeep.othersExpanded'

      /** The group starts collapsed: other authors' plugins are noise until asked for. */
      function readOthersOpen(): boolean {
        try {
          return window.localStorage.getItem(OTHERS_OPEN_KEY) === 'true'
        } catch {
          return false
        }
      }

      /** Persist the choice so a refresh keeps the reader's preference. */
      function writeOthersOpen(open: boolean): void {
        try {
          window.localStorage.setItem(OTHERS_OPEN_KEY, open ? 'true' : 'false')
        } catch {
          // Private mode or a blocked storage partition: keep the in-memory state.
        }
      }

      const en: Record<string, string> = {
        tab: 'Upkeep',
        panel: 'Upkeep',
        openPanel: 'Open panel',
        title: 'Plugin compatibility',
        subtitle: 'What this installation runs, and which plugins it loaded.',
        refresh: 'Refresh',
        loading: 'Reading status…',
        statusHealthyOne: 'Your plugin is healthy.',
        statusHealthy: 'All {mine} of your plugins are healthy.',
        statusCareOne: 'Your plugin needs care.',
        statusCareSingle: 'One of your {mine} plugins needs care.',
        statusCareMany: '{care} of your {mine} plugins need care.',
        statusNoMine: 'No plugin here is recognized as yours yet.',
        pluginVersion: 'Upkeep',
        dshVersion: 'DSH',
        profile: 'Profile',
        entries: 'Plugin entries',
        bundles: 'Bundles',
        unknown: 'unknown',
        bundle: 'Bundle',
        version: 'Version',
        state: 'State',
        enabled: 'enabled',
        disabled: 'disabled',
        failed: 'load error',
        excluded: 'Excluded',
        officialRule: 'Official @deepseek-ai packages ship with DSH and are not monitored.',
        care: 'Care',
        needsCare: 'Needs care',
        healthy: 'Healthy',
        unknownCare: 'Unknown',
        notMine: 'Not mine',
        groupMine: 'Your plugins',
        groupMineHint: 'Matched against this machine identity',
        groupOthers: 'Other plugins',
        groupOthersHint: 'Other authors or unknown ownership',
        groupOthersOther: 'Other authors',
        groupOthersUnknown: 'Unknown ownership',
        noMine: 'No plugin here is recognized as yours yet. Set ownerHandles if that is wrong.',
        noOthers: 'No other plugins.',
        collapseOthers: 'Collapse other plugins',
        expandOthers: 'Expand other plugins',
        warnings: 'Warnings',
        notConnected: 'The panel is not connected to the Host yet.',
        retry: 'Retry',
        checkNow: 'Check now',
        checking: 'Checking…',
        targetVersion: 'Target',
        lastCheck: 'Last check',
        notChecked: 'not checked yet',
        cached: 'cached',
        incompatible: 'incompatible',
        breaksOn: 'breaks on',
        breakingChanges: 'breaking changes',
        upgrade: 'Upgrade',
        upgradeConfirm: 'Prepare a targeted upgrade for {bundle}?',
        worktreeConfirm: 'Edit in a separate git worktree instead of the checkout?',
        upgrading: 'Preparing…',
        upgradeFailed: 'The upgrade could not be prepared.',
        preparedNotice: 'Upgrade task prepared for {bundle}; the session is open with the prompt.',
        verifyNow: 'Verify',
        verifyResult: 'Verification: {ok}/{total} commands passed.',
        verifyNone: 'No verification commands ran.',
      }

      const zh: Record<string, string> = {
        tab: '兼容性管家',
        panel: '兼容性管家',
        openPanel: '打开面板',
        title: '插件兼容性',
        subtitle: '当前安装运行的版本，以及它加载了哪些插件。',
        refresh: '刷新',
        loading: '正在读取状态…',
        statusHealthyOne: '你的插件正常。',
        statusHealthy: '你的 {mine} 个插件全部正常。',
        statusCareOne: '你的插件需要维护。',
        statusCareSingle: '你的 {mine} 个插件中有 1 个需要维护。',
        statusCareMany: '你的 {mine} 个插件中有 {care} 个需要维护。',
        statusNoMine: '还没有识别到属于你的插件。',
        pluginVersion: 'Upkeep',
        dshVersion: 'DSH',
        profile: 'Profile',
        entries: '插件条目',
        bundles: 'Bundle',
        unknown: '未知',
        bundle: 'Bundle',
        version: '版本',
        state: '状态',
        enabled: '已启用',
        disabled: '已禁用',
        failed: '加载失败',
        excluded: '已排除',
        officialRule: '官方 @deepseek-ai 插件随 DSH 发布，不纳入监测。',
        care: '维护',
        needsCare: '需维护',
        healthy: '正常',
        unknownCare: '未知',
        notMine: '—',
        groupMine: '我的插件',
        groupMineHint: '按本机身份识别',
        groupOthers: '其他插件',
        groupOthersHint: '他人或归属未知',
        groupOthersOther: '他人',
        groupOthersUnknown: '归属未知',
        noMine: '还没有识别到属于你的插件。若判断有误，请设置 ownerHandles。',
        noOthers: '没有其他插件。',
        collapseOthers: '收起其他插件',
        expandOthers: '展开其他插件',
        warnings: '提示',
        notConnected: '面板尚未连接到 Host。',
        retry: '重试',
        checkNow: '立即检查',
        checking: '检查中…',
        targetVersion: '目标版本',
        lastCheck: '上次检查',
        notChecked: '尚未检查',
        cached: '缓存',
        incompatible: '不兼容',
        breaksOn: '将在',
        breakingChanges: '破坏性变更',
        upgrade: '升级',
        upgradeConfirm: '为 {bundle} 准备一次定向升级？',
        worktreeConfirm: '在独立的 git worktree 中修改（而不是当前 checkout）？',
        upgrading: '准备中…',
        upgradeFailed: '无法准备升级。',
        preparedNotice: '已为 {bundle} 准备升级任务，会话已带着提示词打开。',
        verifyNow: '验证',
        verifyResult: '验证结果：{ok}/{total} 个命令通过。',
        verifyNone: '没有可运行的验证命令。',
      }

      const CSS = `
[data-upkeep] { display: flex; flex-direction: column; min-width: 0; color: var(--dsw-alias-label-primary); font-size: 12px; }
[data-upkeep].upkeep-page { height: 100%; overflow: auto; box-sizing: border-box; }
[data-upkeep] .upkeep-page-inner { display: flex; flex-direction: column; gap: 20px; width: 100%; max-width: 1080px; margin: 0 auto; padding: 28px 28px 44px; box-sizing: border-box; }
[data-upkeep] .upkeep-tab-inner { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

[data-upkeep] .upkeep-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
[data-upkeep] .upkeep-heading { min-width: 0; }
[data-upkeep] .upkeep-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.35; letter-spacing: -0.01em; }
[data-upkeep].upkeep-page .upkeep-title { font-size: 20px; }
[data-upkeep] .upkeep-subtitle { margin: 3px 0 0; max-width: 64ch; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; }
[data-upkeep] .upkeep-actions { display: flex; flex: none; gap: 8px; }

[data-upkeep] .upkeep-status { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.45; letter-spacing: -0.01em; }
[data-upkeep].upkeep-page .upkeep-status { font-size: 19px; }
[data-upkeep] .upkeep-status[data-care="true"] { color: var(--dsw-alias-state-error-primary); }

[data-upkeep] .upkeep-meta { display: flex; flex-wrap: wrap; align-items: baseline; font-size: 11px; color: var(--dsw-alias-label-secondary); }
[data-upkeep] .upkeep-meta > span { padding: 0 10px; border-left: 1px solid var(--dsw-alias-border-l1); line-height: 1.6; }
[data-upkeep] .upkeep-meta > span:first-child { padding-left: 0; border-left: none; }
[data-upkeep] .upkeep-meta b { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }

[data-upkeep] .upkeep-btn { padding: 4px 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; cursor: pointer; }
[data-upkeep] .upkeep-btn:hover:not([disabled]) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
[data-upkeep] .upkeep-btn[disabled] { opacity: 0.55; cursor: default; }
[data-upkeep] .upkeep-btn[data-variant="primary"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
[data-upkeep] :is(button):focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }

[data-upkeep] .upkeep-groups { display: flex; flex-direction: column; gap: 22px; }
[data-upkeep] .upkeep-group { display: flex; flex-direction: column; }
[data-upkeep] .upkeep-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 0 0 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
[data-upkeep] .upkeep-group-toggle { width: 100%; margin: 0; background: transparent; border: none; border-bottom: 1px solid var(--dsw-alias-border-l2); color: inherit; font: inherit; text-align: left; cursor: pointer; }
[data-upkeep] .upkeep-group-toggle:hover .upkeep-group-title { color: var(--dsw-alias-brand-primary); }
[data-upkeep] .upkeep-group-left { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
[data-upkeep] .upkeep-group-chevron { flex: none; width: 11px; color: var(--dsw-alias-label-secondary); font-size: 10px; }
[data-upkeep] .upkeep-group-title { margin: 0; font-size: 12px; font-weight: 600; }
[data-upkeep] .upkeep-group-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; text-align: right; }

[data-upkeep] .upkeep-table-scroll { overflow-x: auto; }
[data-upkeep] .upkeep-table { width: 100%; border-collapse: collapse; font-size: 12px; }
[data-upkeep] .upkeep-table th { padding: 5px 10px; text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
[data-upkeep] .upkeep-table td { padding: 7px 10px; border-top: 1px solid var(--dsw-alias-border-l1); overflow-wrap: anywhere; }
[data-upkeep] .upkeep-table td.upkeep-name { width: 60%; }
[data-upkeep] .upkeep-table tr[data-care="attention"] td:first-child { box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary); }
[data-upkeep] .upkeep-version { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }

[data-upkeep] .upkeep-chip { display: inline-flex; align-items: center; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1.5; white-space: nowrap; }
[data-upkeep] .upkeep-chip[data-state="ok"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
[data-upkeep] .upkeep-chip[data-state="warn"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
[data-upkeep] .upkeep-chip[data-state="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }

[data-upkeep] .upkeep-warn { display: flex; flex-direction: column; gap: 3px; padding: 6px 0 6px 12px; border-left: 2px solid var(--dsw-alias-state-warn-primary); font-size: 11px; line-height: 1.55; }
[data-upkeep] .upkeep-error { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 6px 12px; border-left: 2px solid var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }

[data-upkeep] .upkeep-empty { padding: 14px 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
[data-upkeep] .upkeep-muted { color: var(--dsw-alias-label-secondary); font-size: 11px; }
[data-upkeep] .upkeep-care { display: flex; align-items: center; gap: 8px; }
[data-upkeep] .upkeep-btn-xs { padding: 1px 8px; font-size: 10px; line-height: 1.5; }
[data-upkeep] .upkeep-notice { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0 6px 12px; border-left: 2px solid var(--dsw-alias-brand-primary); font-size: 11px; line-height: 1.55; }
[data-upkeep] .upkeep-notice[data-kind="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
[data-upkeep] .upkeep-footer { display: flex; flex-direction: column; gap: 3px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.55; }

@media (max-width: 640px) {
  [data-upkeep] .upkeep-head { flex-wrap: wrap; }
  [data-upkeep] .upkeep-page-inner { padding: 18px 16px 32px; }
  [data-upkeep] .upkeep-group-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-upkeep] * { transition: none !important; animation: none !important; }
}
`

      /* ------------------------------------------------------------------ *
       * Transport: exact-Fetch RPC over the shared /api channel.
       * ------------------------------------------------------------------ */

      async function callHost(ctx: ClientContext, action: string, input?: unknown, signal?: AbortSignal): Promise<{ ok: true; value: JsonData | null } | { ok: false; error: RpcFailure }> {
        const payload = input === undefined ? { action } : { action, input }
        try {
          const result = await ctx.connection.rpc.call('/api', 'upkeep/' + action, payload, signal)
          if (!result || result.ok !== true) {
            const error: WireErrorLike = result && result.error && typeof result.error === 'object' ? result.error : {}
            return {
              ok: false,
              error: {
                code: typeof error.code === 'string' && error.code ? error.code : 'RPC_FAILED',
                message: typeof error.message === 'string' ? error.message : '',
              },
            }
          }
          const value = result.value
          return { ok: true, value: value && typeof value === 'object' ? (value as JsonData) : null }
        } catch (error) {
          const failure = error as { message?: unknown } | null
          return { ok: false, error: { code: 'RPC_FAILED', message: failure && failure.message ? String(failure.message) : '' } }
        }
      }

      /* ------------------------------------------------------------------ *
       * Store: one status snapshot, one in-flight read at a time.
       * ------------------------------------------------------------------ */

      function createStore(ctx: ClientContext, t: Translate): Store {
        let state: StoreState = { phase: 'idle', data: null, error: null }
        const listeners = new Set<() => void>()
        let running = false

        const publish = (next: StoreState): void => {
          state = next
          for (const listener of [...listeners]) listener()
        }

        const read = async (action: 'status' | 'check', phase: 'loading' | 'checking'): Promise<void> => {
          if (running) return
          running = true
          publish({ phase, data: state.data, error: null })
          try {
            const answer = await callHost(ctx, action)
            if (answer.ok) publish({ phase: 'ready', data: answer.value as StatusSnapshot | null, error: null })
            else publish({ phase: 'error', data: state.data, error: answer.error })
          } finally {
            running = false
          }
        }

        const upgrade = async (bundle: string, worktree: boolean): Promise<void> => {
          publish({ phase: 'upgrading', data: state.data, error: null })
          try {
            const answer = await callHost(ctx, 'upgrade.prepare', { bundle, worktree, confirm: true })
            if (!answer.ok) {
              publish({ phase: 'ready', data: state.data, error: null, notice: { kind: 'error', text: answer.error.code + ': ' + answer.error.message } })
              return
            }
            const value = answer.value as {
              run?: { id?: string; workspaceId?: string; prompt?: string }
            } | null
            const run = value && value.run ? value.run : null
            if (!run || typeof run.workspaceId !== 'string' || typeof run.prompt !== 'string') {
              publish({ phase: 'ready', data: state.data, error: null, notice: { kind: 'error', text: t('upgradeFailed') } })
              return
            }
            try {
              ctx.uiWorkspace.startSession(run.workspaceId, { prompt: run.prompt })
            } catch {
              // The shell may be mid-reload; the run is stored either way.
            }
            publish({ phase: 'ready', data: state.data, error: null, notice: { kind: 'ok', text: t('preparedNotice', { bundle }), runId: run.id } })
          } finally {
            running = false
          }
        }

        const verify = async (runId: string): Promise<void> => {
          publish({ phase: 'checking', data: state.data, error: null, notice: state.notice })
          try {
            const answer = await callHost(ctx, 'upgrade.verify', { runId, confirm: true })
            if (!answer.ok) {
              publish({ phase: 'ready', data: state.data, error: null, notice: { kind: 'error', text: answer.error.code + ': ' + answer.error.message, runId } })
              return
            }
            const value = answer.value as { results?: Array<{ ok?: boolean }> } | null
            const results = value && Array.isArray(value.results) ? value.results : []
            const passed = results.filter(result => result.ok === true).length
            publish({
              phase: 'ready',
              data: state.data,
              error: null,
              notice: {
                kind: passed === results.length && results.length > 0 ? 'ok' : 'error',
                text: results.length === 0 ? t('verifyNone') : t('verifyResult', { ok: passed, total: results.length }),
                runId,
              },
            })
          } finally {
            running = false
          }
        }

        return {
          subscribe(listener: () => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          get() { return state },
          async refresh() { await read('status', 'loading') },
          async check() { await read('check', 'checking') },
          upgrade,
          verify,
        }
      }

      /* ------------------------------------------------------------------ *
       * View helpers
       * ------------------------------------------------------------------ */

      function relativeTime(timestamp: number | undefined, locale: string): string {
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
        const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
        const steps: Array<[number, string, string]> = [
          [60, 'second', '秒'],
          [60, 'minute', '分钟'],
          [24, 'hour', '小时'],
          [30, 'day', '天'],
        ]
        let value = seconds
        let unit = 'second'
        let unitZh = '秒'
        for (const [size, name, nameZh] of steps) {
          if (value < size) break
          value = Math.floor(value / size)
          unit = name
          unitZh = nameZh
        }
        return locale === 'zh' ? `${value} ${unitZh}前` : `${value} ${unit}${value === 1 ? '' : 's'} ago`
      }

      function bundleState(bundle: BundleSummary, t: Translate): { label: string; state: 'ok' | 'warn' | 'error' } {
        if (bundle.error) return { label: t('failed'), state: 'error' }
        if (bundle.enabled === false) return { label: t('disabled'), state: 'warn' }
        return { label: t('enabled'), state: 'ok' }
      }

      /** One state chip; `title` carries the evidence or reasons behind it. */
      function chip(label: string, state: 'ok' | 'warn' | 'error', title?: string): Child {
        return h('span', { className: 'upkeep-chip', 'data-state': state, title }, label)
      }


      /** Maintenance chip for the author's own plugins; other authors get a dash. */
      function careChip(bundle: BundleSummary, t: Translate): Child {
        const state = bundle.maintenance && bundle.maintenance.state ? bundle.maintenance.state : 'unknown'
        const reasons = bundle.maintenance && Array.isArray(bundle.maintenance.reasons) ? bundle.maintenance.reasons.join('; ') : ''
        if (state === 'attention') return chip(t('needsCare'), 'error', reasons)
        if (state === 'ok') return chip(t('healthy'), 'ok')
        if (state === 'not-mine') return h('span', { className: 'upkeep-muted' }, '—')
        return chip(t('unknownCare'), 'warn', reasons)
      }

      /** One bundle table; both groups reuse it so the columns stay identical. */
      /** One ledger table; both groups share it so columns cannot drift apart. */
      /** One ledger table; both groups share it so columns cannot drift apart. */
      function renderBundleTable(
        bundles: BundleSummary[],
        t: Translate,
        emptyText: string,
        options: { showCare: boolean; targetVersion: string | null; onUpgrade?: ((bundle: BundleSummary) => void) | null },
      ): Child {
        if (bundles.length === 0) return h('div', { className: 'upkeep-empty' }, emptyText)
        const headers: Child[] = [
          h('th', { key: 'bundle' }, t('bundle')),
          h('th', { key: 'version' }, t('version')),
          h('th', { key: 'state' }, t('state')),
        ]
        if (options.showCare) headers.push(h('th', { key: 'care' }, t('care')))

        return h('div', { className: 'upkeep-table-scroll' },
          h('table', { className: 'upkeep-table' },
            h('thead', null, h('tr', null, ...headers)),
            h('tbody', null,
              ...bundles.map((bundle, index) => {
                const status = bundleState(bundle, t)
                const care = bundle.maintenance && bundle.maintenance.state ? bundle.maintenance.state : 'unknown'
                // The row count and install spec stay available on hover instead of taking a column:
                // for a single-plugin bundle they say little, and the group already names the owner.
                const ownership = bundle.owner
                const ownershipEvidence = ownership && ownership.status !== 'mine' && Array.isArray(ownership.evidence)
                  ? ownership.evidence.join(' · ')
                  : ''
                const compat = bundle.compat
                const requirementText = (view: EvaluationView | null | undefined): string =>
                  view && view.status === 'incompatible' && view.requirements
                    ? Object.entries(view.requirements).map(([name, range]) => name + ' ' + range).join(', ')
                    : ''
                const runningText = requirementText(compat && compat.running)
                const targetText = requirementText(compat && compat.target)
                const impact = compat && compat.impact
                const impactText = impact && typeof impact.matched === 'number' && impact.matched > 0
                  ? String(impact.matched) + ' ' + t('breakingChanges') + (impact.versions && impact.versions.length > 0 ? ' (' + impact.versions.join(', ') + ')' : '')
                  : ''
                const detail = [
                  typeof bundle.rowCount === 'number' ? String(bundle.rowCount) + ' ' + t('entries') : '',
                  bundle.source || '',
                  ownershipEvidence,
                  runningText === '' ? '' : t('incompatible') + ': ' + runningText,
                  targetText === '' ? '' : t('breaksOn') + ' ' + (options.targetVersion ?? '') + ': ' + targetText,
                  impactText,
                ].filter(part => part !== '').join(' · ')
                const cells: Child[] = [
                  h('td', { key: 'name', className: 'upkeep-name' },
                    h('span', { title: detail }, bundle.name || t('unknown'))),
                  h('td', { key: 'version' }, h('span', { className: 'upkeep-version' }, bundle.version || '—')),
                  h('td', { key: 'state' }, chip(status.label, status.state)),
                ]
                if (options.showCare) {
                  const eligible = options.onUpgrade && (care === 'attention' || (bundle.compat && bundle.compat.impact !== undefined && typeof bundle.compat.impact.matched === 'number' && bundle.compat.impact.matched > 0))
                  cells.push(h('td', { key: 'care', className: 'upkeep-care' },
                    careChip(bundle, t),
                    eligible && options.onUpgrade
                      ? h('button', {
                          className: 'upkeep-btn upkeep-btn-xs',
                          type: 'button',
                          onClick: () => options.onUpgrade?.(bundle),
                        }, t('upgrade'))
                      : null))
                }
                return h('tr', { key: (bundle.name || 'bundle') + '-' + index, 'data-care': care }, ...cells)
              }))))
      }

      /** The props every upkeep view receives through its slot injection. */
      type TabProps = { store: Store; t: Translate; locale: string; openPanel?: () => void }

      function StatusView(props: TabProps & { variant: 'tab' | 'panel' }): Child {
        const { store, t, locale, openPanel } = props
        const page = props.variant === 'panel'
        const state = React.useSyncExternalStore(store.subscribe, store.get)
        const ready = state.phase === 'ready'
        const loading = state.phase === 'loading'
        const data = state.data

        React.useEffect(() => {
          if (state.phase === 'idle') void store.refresh()
        }, [state.phase])

        // The other-authors group is collapsed by default and remembers being opened.
        const [othersOpen, setOthersOpen] = React.useState<boolean>(readOthersOpen)
        React.useEffect(() => { writeOthersOpen(othersOpen) }, [othersOpen])

        const rollup = data && data.ownership ? data.ownership : null
        const bundles = data && Array.isArray(data.bundles) ? data.bundles : []
        const ownerOf = (bundle: BundleSummary): string =>
          bundle.owner && bundle.owner.status ? bundle.owner.status : 'unknown'
        const mineBundles = bundles.filter(bundle => ownerOf(bundle) === 'mine')
        const otherBundles = bundles.filter(bundle => ownerOf(bundle) !== 'mine')
        const mineCount = rollup && typeof rollup.mine === 'number' ? rollup.mine : mineBundles.length
        const careCount = mineBundles.filter(bundle => bundle.maintenance && bundle.maintenance.state === 'attention').length

        // The sentence is the product: it answers "do my plugins need care" before any table.
        const statusText = !ready && !data
          ? t('loading')
          : mineCount === 0
            ? t('statusNoMine')
            : careCount === 0
              ? (mineCount === 1 ? t('statusHealthyOne') : t('statusHealthy', { mine: mineCount }))
              : mineCount === 1
                ? t('statusCareOne')
                : careCount === 1
                  ? t('statusCareSingle', { mine: mineCount })
                  : t('statusCareMany', { care: careCount, mine: mineCount })

        const facts: Child[] = []
        const runtimeVersion = data && data.dsh && data.dsh.runtimeVersion ? data.dsh.runtimeVersion : t('unknown')
        facts.push(h('span', { key: 'dsh' }, t('dshVersion') + ' ', h('b', null, runtimeVersion)))
        const target = data && data.target ? data.target : null
        const targetText = target && target.version
          ? target.version + (target.channel ? ' (' + target.channel + ')' : '') + (target.stale ? ' · ' + t('cached') : '')
          : t('notChecked')
        facts.push(h('span', { key: 'target' }, t('targetVersion') + ' ', h('b', null, targetText)))
        if (data && data.lastCheck && typeof data.lastCheck.at === 'number') {
          facts.push(h('span', { key: 'last-check' }, t('lastCheck') + ' ', h('b', null, relativeTime(data.lastCheck.at, locale))))
        }
        const profileName = data && data.profile && data.profile.name ? data.profile.name : t('unknown')
        facts.push(h('span', { key: 'profile' }, t('profile') + ' ', h('b', null, profileName)))
        facts.push(h('span', { key: 'bundles' }, t('bundles') + ' ', h('b', null, String(bundles.length))))
        if (data && data.plugins && typeof data.plugins.entryCount === 'number') {
          facts.push(h('span', { key: 'entries' }, t('entries') + ' ', h('b', null, String(data.plugins.entryCount))))
        }
        if (data && data.plugin && data.plugin.version) {
          facts.push(h('span', { key: 'upkeep' }, t('pluginVersion') + ' ', h('b', null, data.plugin.version)))
        }
        if (data && typeof data.checkedAt === 'number') {
          facts.push(h('span', { key: 'checked' }, relativeTime(data.checkedAt, locale)))
        }

        const warning = data && Array.isArray(data.warnings) && data.warnings.length > 0
          ? h('div', { className: 'upkeep-warn', role: 'status' },
              h('strong', null, t('warnings')),
              ...data.warnings.map((item, index) => h('div', { key: 'warn-' + index }, item)))
          : null

        const failure = state.error
          ? h('div', { className: 'upkeep-error', role: 'alert' },
              h('div', null, (state.error.code || 'RPC_FAILED') + ': ' + (state.error.message || t('notConnected'))),
              h('div', null, h('button', { className: 'upkeep-btn', type: 'button', onClick: () => { void store.refresh() } }, t('retry'))))
          : null

        // Official DSH packages are reported, not hidden: the footer says what the list leaves out.
        const excluded = data && data.excluded ? data.excluded : null
        const excludedBundles = excluded && typeof excluded.bundles === 'number' ? excluded.bundles : 0
        const excludedEntries = excluded && typeof excluded.entries === 'number' ? excluded.entries : 0
        const footer = h('div', { className: 'upkeep-footer' },
          h('span', null, t('officialRule')),
          excludedBundles > 0 || excludedEntries > 0
            ? h('span', null, t('excluded') + ' ' + String(excludedBundles) + ' ' + t('bundles') + ' · ' + String(excludedEntries) + ' ' + t('entries'))
            : null)

        /** One visually separated group: a heading line plus its own ledger table. */
        const group = (
          key: 'mine' | 'others',
          title: string,
          hint: string,
          rows: BundleSummary[],
          emptyText: string,
          options: { collapsible?: boolean; open?: boolean; onToggle?: () => void },
        ): Child => {
          const collapsible = options.collapsible === true
          const open = options.open === true
          const label = title + ' · ' + String(rows.length)
          const header = collapsible
            ? h('button', {
                className: 'upkeep-group-head upkeep-group-toggle',
                type: 'button',
                'aria-expanded': open ? 'true' : 'false',
                title: open ? t('collapseOthers') : t('expandOthers'),
                onClick: options.onToggle,
              },
              h('span', { className: 'upkeep-group-left' },
                h('span', { className: 'upkeep-group-chevron' }, open ? '▾' : '▸'),
                h('span', { className: 'upkeep-group-title' }, label)),
              h('span', { className: 'upkeep-group-hint' }, hint))
            : h('div', { className: 'upkeep-group-head' },
                h('h4', { className: 'upkeep-group-title' }, label),
                h('span', { className: 'upkeep-group-hint' }, hint))
          return h('section', {
            className: 'upkeep-group',
            'data-group': key,
            'data-collapsed': collapsible && !open ? 'true' : 'false',
          },
            header,
            collapsible && !open
              ? null
              : renderBundleTable(rows, t, emptyText, {
                  showCare: key === 'mine',
                  targetVersion,
                  onUpgrade: key === 'mine' ? requestUpgrade : null,
                }))
        }

        const requestUpgrade = (bundle: BundleSummary): void => {
          const name = bundle.name || ''
          if (name === '') return
          if (typeof window.confirm === 'function' && !window.confirm(t('upgradeConfirm', { bundle: name }))) return
          const worktree = typeof window.confirm === 'function' ? window.confirm(t('worktreeConfirm')) : false
          void store.upgrade(name, worktree)
        }

        const targetVersion = data && data.target && data.target.version ? data.target.version : null
        const mineHint = careCount > 0 ? String(careCount) + ' ' + t('needsCare') : t('groupMineHint')
        const otherAuthorCount = otherBundles.filter(bundle => ownerOf(bundle) === 'other').length
        const unknownAuthorCount = otherBundles.filter(bundle => ownerOf(bundle) === 'unknown').length
        const otherHintParts: string[] = []
        if (otherAuthorCount > 0) otherHintParts.push(t('groupOthersOther') + ' ' + String(otherAuthorCount))
        if (unknownAuthorCount > 0) otherHintParts.push(t('groupOthersUnknown') + ' ' + String(unknownAuthorCount))
        const otherHint = otherHintParts.length > 0 ? otherHintParts.join(' · ') : t('groupOthersHint')
        const groups = !ready && bundles.length === 0
          ? h('div', { className: 'upkeep-empty' }, t('loading'))
          : h('div', { className: 'upkeep-groups' },
              group('mine', t('groupMine'), mineHint, mineBundles, t('noMine'), {}),
              group('others', t('groupOthers'), otherHint, otherBundles, t('noOthers'), {
                collapsible: true,
                open: othersOpen,
                onToggle: () => setOthersOpen((open: boolean) => !open),
              }))

        const busy = loading || state.phase === 'checking' || state.phase === 'upgrading'
        const actions = h('div', { className: 'upkeep-actions' },
          !page && openPanel
            ? h('button', { className: 'upkeep-btn', type: 'button', onClick: openPanel }, t('openPanel'))
            : null,
          h('button', {
            className: 'upkeep-btn',
            type: 'button',
            'data-variant': 'primary',
            disabled: busy,
            'aria-busy': state.phase === 'checking' ? 'true' : 'false',
            onClick: () => { void store.check() },
          }, state.phase === 'checking' ? t('checking') : state.phase === 'upgrading' ? t('upgrading') : t('checkNow')),
          h('button', {
            className: 'upkeep-btn',
            type: 'button',
            disabled: busy,
            'aria-busy': loading ? 'true' : 'false',
            onClick: () => { void store.refresh() },
          }, loading ? t('loading') : t('refresh')))

        return h('div', {
          'data-upkeep': '',
          'data-upkeep-ready': ready ? 'true' : 'false',
          className: page ? 'upkeep-page' : '',
        },
          h('style', null, CSS),
          h('div', { className: page ? 'upkeep-page-inner' : 'upkeep-tab-inner' },
            h('div', { className: 'upkeep-head' },
              h('div', { className: 'upkeep-heading' },
                page ? h('h2', { className: 'upkeep-title' }, t('title')) : h('h3', { className: 'upkeep-title' }, t('title')),
                h('p', { className: 'upkeep-subtitle' }, t('subtitle'))),
              actions),
            h('p', {
              className: 'upkeep-status',
              'data-care': careCount > 0 ? 'true' : 'false',
              role: 'status',
            }, statusText),
            h('div', { className: 'upkeep-meta' }, ...facts),
            failure,
            warning,
            state.notice
              ? h('div', { className: 'upkeep-notice', 'data-kind': state.notice.kind, role: 'status' },
                  h('span', null, state.notice.text),
                  state.notice.runId
                    ? h('button', { className: 'upkeep-btn', type: 'button', onClick: () => { if (state.notice?.runId) void store.verify(state.notice.runId) } }, t('verifyNow'))
                    : null)
              : null,
            groups,
            footer))
      }

      function TabBody(props: TabProps): Child {
        return StatusView({ ...props, variant: 'tab' })
      }

      function PanelPage(props: TabProps): Child {
        return StatusView({ ...props, variant: 'panel' })
      }

      /** The sidebar panel glyph: a shield with two cycle arrows, drawn in the host's text color. */
      function PanelIcon(props: { size?: number; active?: boolean }): Child {
        const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
        const opacity = props.active === true ? '1' : '0.88'
        return h('svg', {
          width: String(size),
          height: String(size),
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', opacity },
        },
          h('path', {
            d: 'M12 2.9 19.3 5.7v5.7c0 4.3-2.9 7.6-7.3 9-4.4-1.4-7.3-4.7-7.3-9V5.7L12 2.9Z',
            stroke: 'currentColor',
            'stroke-width': '1.6',
            'stroke-linejoin': 'round',
          }),
          h('path', {
            d: 'M15.5 9.2a3.9 3.9 0 0 0-6.5.5',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
          }),
          h('path', {
            d: 'M8.7 7.7v2.4h2.4',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
          h('path', {
            d: 'M8.5 14.8a3.9 3.9 0 0 0 6.5-.5',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            opacity: '0.65',
          }),
          h('path', {
            d: 'M15.3 16.3v-2.4h-2.4',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            opacity: '0.65',
          }))
      }

      /* ------------------------------------------------------------------ *
       * Plugin body
       * ------------------------------------------------------------------ */

      function apply(ctx: ClientContext): void {
        const t = ctx.locale.bind(NS)
        const store = createStore(ctx, t)

        const openPanel = (): void => {
          try {
            ctx.layout.selectPanel(PANEL_ID)
          } catch {
            // The panel may not be mounted yet; the sidebar entry remains.
          }
        }

        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'upkeep: locale')

        // The first-level panel is the primary entry: an icon in the sidebar panel
        // list and a page in the center column, keyed by the same id.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon), 'upkeep: sidebar panel icon')

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ store, t, locale: localeOf(ctx) }),
        }, PanelPage), 'upkeep: main panel')

        // The Plugins settings tab stays as the secondary entry, reachable from the
        // plugin manager page where plugin authors already are.
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: TAB_ID,
          order: 40,
          label: () => t('tab'),
          locale: NS,
          inject: () => ({ store, t, locale: localeOf(ctx), openPanel }),
        }, TabBody), 'upkeep: settings tab')
      }

      function localeOf(ctx: ClientContext): string {
        try {
          const snapshot = ctx.locale.getLocale() as { id?: unknown } | null
          const id = snapshot && typeof snapshot.id === 'string' ? snapshot.id : ''
          return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
        } catch {
          return 'en'
        }
      }

      return {
        inject: ['slots', 'locale', 'connection', 'layout', 'uiWorkspace'],
        apply,
      }
    },
  })
})(window.__ModuleLoader__)
