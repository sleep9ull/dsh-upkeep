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

type BundleSummary = {
  name?: string
  version?: string | null
  enabled?: boolean
  official?: boolean
  availability?: string | null
  rowCount?: number
  error?: { code?: string; diagnostic?: string | null } | null
}

type StatusSnapshot = {
  checkedAt?: number
  plugin?: { name?: string; version?: string }
  dsh?: { runtimeVersion?: string | null; installAnchor?: string | null }
  profile?: { name?: string | null; dir?: string | null }
  bundles?: BundleSummary[]
  plugins?: { entryCount?: number | null }
  excluded?: { bundles?: number; entries?: number }
  warnings?: string[]
}

type StorePhase = 'idle' | 'loading' | 'ready' | 'error'
type StoreState = { phase: StorePhase; data: StatusSnapshot | null; error: RpcFailure | null }
type Store = {
  subscribe(listener: () => void): () => void
  get(): StoreState
  refresh(): Promise<void>
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

      const en: Record<string, string> = {
        tab: 'Upkeep',
        panel: 'Upkeep',
        openPanel: 'Open panel',
        panelSubtitle: 'What this installation runs, and which plugins it loaded.',
        title: 'Plugin compatibility',
        subtitle: 'What this installation runs, and which plugins it loaded.',
        refresh: 'Refresh',
        loading: 'Reading status…',
        pluginVersion: 'Upkeep',
        dshVersion: 'DSH',
        profile: 'Profile',
        entries: 'Plugin entries',
        bundles: 'Bundles',
        unknown: 'unknown',
        bundle: 'Bundle',
        version: 'Version',
        state: 'State',
        source: 'Source',
        rows: 'Rows',
        enabled: 'enabled',
        disabled: 'disabled',
        failed: 'load error',
        excluded: 'Excluded',
        officialRule: 'Official @deepseek-ai packages ship with DSH and are not monitored.',
        empty: 'No bundles were reported.',
        warnings: 'Warnings',
        notConnected: 'The panel is not connected to the Host yet.',
        retry: 'Retry',
      }

      const zh: Record<string, string> = {
        tab: '兼容性管家',
        panel: '兼容性管家',
        openPanel: '打开面板',
        panelSubtitle: '当前安装运行的版本，以及它加载了哪些插件。',
        title: '插件兼容性',
        subtitle: '当前安装运行的版本，以及它加载了哪些插件。',
        refresh: '刷新',
        loading: '正在读取状态…',
        pluginVersion: 'Upkeep',
        dshVersion: 'DSH',
        profile: 'Profile',
        entries: '插件条目',
        bundles: 'Bundle',
        unknown: '未知',
        bundle: 'Bundle',
        version: '版本',
        state: '状态',
        source: '来源',
        rows: '行数',
        enabled: '已启用',
        disabled: '已禁用',
        failed: '加载失败',
        excluded: '已排除',
        officialRule: '官方 @deepseek-ai 插件随 DSH 发布，不纳入监测。',
        empty: '没有读取到任何 bundle。',
        warnings: '提示',
        notConnected: '面板尚未连接到 Host。',
        retry: '重试',
      }

      const CSS = `
[data-upkeep] { display: flex; flex-direction: column; gap: 10px; }
[data-upkeep] .upkeep-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
[data-upkeep] .upkeep-title { margin: 0; font-size: 14px; line-height: 1.35; }
[data-upkeep] .upkeep-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
[data-upkeep] .upkeep-actions { display: flex; gap: 8px; flex: none; }
[data-upkeep] .upkeep-tab-inner, [data-upkeep] .upkeep-page-inner { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
[data-upkeep] .upkeep-page-inner { gap: 14px; width: 100%; max-width: 1080px; margin: 0 auto; padding: 24px 28px 40px; box-sizing: border-box; }
[data-upkeep].upkeep-page { height: 100%; overflow: auto; }
[data-upkeep].upkeep-page .upkeep-title { font-size: 18px; }
[data-upkeep].upkeep-page .upkeep-subtitle { font-size: 13px; }
[data-upkeep].upkeep-page .upkeep-grid { grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; }
[data-upkeep].upkeep-page .upkeep-table { font-size: 13px; }
[data-upkeep] .upkeep-btn[data-variant="primary"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
[data-upkeep] .upkeep-btn { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; cursor: pointer; }
[data-upkeep] .upkeep-btn:hover:not([disabled]) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
[data-upkeep] .upkeep-btn[disabled] { opacity: 0.55; cursor: default; }
[data-upkeep] .upkeep-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 12px; }
[data-upkeep] .upkeep-grid dt { color: var(--dsw-alias-label-secondary); }
[data-upkeep] .upkeep-grid dd { margin: 0; overflow-wrap: anywhere; }
[data-upkeep] .upkeep-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
[data-upkeep] .upkeep-table { width: 100%; border-collapse: collapse; font-size: 12px; }
[data-upkeep] .upkeep-table th, [data-upkeep] .upkeep-table td { padding: 4px 6px; text-align: left; border-top: 1px solid var(--dsw-alias-border-l1); overflow-wrap: anywhere; }
[data-upkeep] .upkeep-table th { color: var(--dsw-alias-label-secondary); font-weight: 600; border-top: none; }
[data-upkeep] .upkeep-table td.upkeep-num { text-align: right; }
[data-upkeep] .upkeep-chip { display: inline-flex; align-items: center; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 10px; }
[data-upkeep] .upkeep-chip[data-state="ok"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
[data-upkeep] .upkeep-chip[data-state="warn"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
[data-upkeep] .upkeep-chip[data-state="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
[data-upkeep] .upkeep-warn { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: var(--dsw-radius-md, 6px); font-size: 11px; line-height: 1.5; }
[data-upkeep] .upkeep-error { padding: 8px 10px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: var(--dsw-radius-md, 6px); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
[data-upkeep] .upkeep-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; }
[data-upkeep] .upkeep-note { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; }
@media (max-width: 520px) {
  [data-upkeep] .upkeep-head { flex-wrap: wrap; }
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

      function createStore(ctx: ClientContext): Store {
        let state: StoreState = { phase: 'idle', data: null, error: null }
        const listeners = new Set<() => void>()
        let running = false

        const publish = (next: StoreState): void => {
          state = next
          for (const listener of [...listeners]) listener()
        }

        return {
          subscribe(listener: () => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          get() { return state },
          async refresh() {
            if (running) return
            running = true
            publish({ phase: 'loading', data: state.data, error: null })
            try {
              const answer = await callHost(ctx, 'status')
              if (answer.ok) publish({ phase: 'ready', data: answer.value as StatusSnapshot | null, error: null })
              else publish({ phase: 'error', data: state.data, error: answer.error })
            } finally {
              running = false
            }
          },
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

      /* ------------------------------------------------------------------ *
       * Tab body
       * ------------------------------------------------------------------ */

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

        const summary: Array<[string, Child]> = [
          [t('pluginVersion'), h('span', { className: 'upkeep-mono' }, data && data.plugin && data.plugin.version ? data.plugin.version : t('unknown'))],
          [t('dshVersion'), h('span', { className: 'upkeep-mono' }, data && data.dsh && data.dsh.runtimeVersion ? data.dsh.runtimeVersion : t('unknown'))],
          [t('profile'), h('span', { className: 'upkeep-mono' }, data && data.profile && data.profile.name ? data.profile.name : t('unknown'))],
          [t('entries'), h('span', { className: 'upkeep-mono' }, data && data.plugins && typeof data.plugins.entryCount === 'number' ? String(data.plugins.entryCount) : t('unknown'))],
          [t('bundles'), h('span', { className: 'upkeep-mono' }, data && data.bundles ? String(data.bundles.length) : '0')],
        ]

        // Official DSH packages are reported, not hidden: the counts say what the list leaves out.
        const excluded = data && data.excluded ? data.excluded : null
        const excludedBundles = excluded && typeof excluded.bundles === 'number' ? excluded.bundles : 0
        const excludedEntries = excluded && typeof excluded.entries === 'number' ? excluded.entries : 0
        if (excludedBundles > 0 || excludedEntries > 0) {
          summary.push([t('excluded'), h('span', { className: 'upkeep-mono' },
            String(excludedBundles) + ' ' + t('bundles') + ' · ' + String(excludedEntries) + ' ' + t('entries'))])
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

        const bundles = data && Array.isArray(data.bundles) ? data.bundles : []
        const table = bundles.length === 0
          ? h('div', { className: 'upkeep-empty' }, ready ? t('empty') : t('loading'))
          : h('table', { className: 'upkeep-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, t('bundle')),
                  h('th', null, t('version')),
                  h('th', null, t('state')),
                  h('th', null, t('source')),
                  h('th', { className: 'upkeep-num' }, t('rows')))),
              h('tbody', null,
                ...bundles.map((bundle, index) => {
                  const status = bundleState(bundle, t)
                  return h('tr', { key: (bundle.name || 'bundle') + '-' + index },
                    h('td', null, h('span', { className: 'upkeep-mono' }, bundle.name || t('unknown'))),
                    h('td', { className: 'upkeep-mono' }, bundle.version || '—'),
                    h('td', null, h('span', { className: 'upkeep-chip', 'data-state': status.state }, status.label)),
                    h('td', null, (bundle.official ? 'official' : '') + (bundle.official && bundle.availability ? ' · ' : '') + (bundle.availability || '')),
                    h('td', { className: 'upkeep-num upkeep-mono' }, typeof bundle.rowCount === 'number' ? String(bundle.rowCount) : '—'))
                })))

        const actions = h('div', { className: 'upkeep-actions' },
          !page && openPanel
            ? h('button', { className: 'upkeep-btn upkeep-btn-primary', type: 'button', onClick: openPanel }, t('openPanel'))
            : null,
          h('button', {
            className: 'upkeep-btn',
            type: 'button',
            disabled: loading,
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
              h('div', null,
                page ? h('h2', { className: 'upkeep-title' }, t('title')) : h('h3', { className: 'upkeep-title' }, t('title')),
                h('p', { className: 'upkeep-subtitle' }, page ? t('panelSubtitle') : t('subtitle'))),
              actions),
            failure,
            warning,
            h('dl', { className: 'upkeep-grid' }, ...summary.flatMap(([label, value]) => [h('dt', { key: 'dt-' + label }, label), h('dd', { key: 'dd-' + label }, value)])),
            h('div', { className: 'upkeep-mono' }, data && typeof data.checkedAt === 'number' ? relativeTime(data.checkedAt, locale) : ''),
            h('div', { className: 'upkeep-note' }, t('officialRule')),
            table))
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
        const store = createStore(ctx)
        const t = ctx.locale.bind(NS)

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
        inject: ['slots', 'locale', 'connection', 'layout'],
        apply,
      }
    },
  })
})(window.__ModuleLoader__)
