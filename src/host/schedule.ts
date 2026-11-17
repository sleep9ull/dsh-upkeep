/**
 * Scheduled upkeep: create the recurring compatibility check through DSH's
 * shared schedule service (`ctx.schedule`), and list the tasks this plugin owns.
 *
 * Delivery is a prompt handed to a fresh Session, so the task does what the
 * user sees in the panel: run a check and report. It never edits repositories —
 * the upgrade flow stays behind the human-confirmed buttons.
 */

import { isRecord } from './types.js'

/** The structural slice of `ctx.schedule` this plugin calls. */
export interface ScheduleServiceLike {
  create(request: Record<string, unknown>): Promise<unknown>
  catalog(): Promise<unknown[]>
  list?(request?: Record<string, unknown>): Promise<unknown>
  edit?(request: Record<string, unknown>): Promise<unknown>
}

/** The canonical (English) name of the profile-wide task. */
export const TASK_TITLE = 'Upkeep compatibility check'

/** Canonical (English) prefix for a task that watches one bundle. */
export const BUNDLE_TITLE_PREFIX = 'Upkeep: '

/**
 * Titles per language.
 *
 * The title is the author's to read in the Automation tasks list, so it follows
 * their language. Identity never comes from it: the stored prompt carries the
 * scope in a marker, which is why switching language cannot orphan a task.
 */
const TITLES = {
  en: { all: TASK_TITLE, bundlePrefix: BUNDLE_TITLE_PREFIX },
  zh: { all: 'Upkeep 兼容性检查', bundlePrefix: 'Upkeep 兼容性检查：' },
} as const

/** What one of this plugin's tasks covers. */
export type UpkeepTaskScope = { kind: 'all' } | { kind: 'bundle'; bundle: string }

/** The task title for one scope, in the author's language. */
export function taskTitleFor(scope: UpkeepTaskScope, locale: 'en' | 'zh' = 'en'): string {
  const titles = TITLES[locale] ?? TITLES.en
  return scope.kind === 'all' ? titles.all : titles.bundlePrefix + scope.bundle
}

/**
 * Read a task title back into its scope.
 *
 * Only a fallback now: titles are localized, so the prompt marker is the identity.
 * A task written by an older build has no marker scope, and this still recognizes
 * the English titles it used.
 */
export function parseUpkeepTitle(title: string): UpkeepTaskScope | null {
  if (title.trim() === TASK_TITLE) return { kind: 'all' }
  if (title.startsWith(BUNDLE_TITLE_PREFIX)) {
    const bundle = title.slice(BUNDLE_TITLE_PREFIX.length).trim()
    if (bundle !== '') return { kind: 'bundle', bundle }
  }
  const chinese = TITLES.zh
  if (title.trim() === chinese.all) return { kind: 'all' }
  if (title.startsWith(chinese.bundlePrefix)) {
    const bundle = title.slice(chinese.bundlePrefix.length).trim()
    if (bundle !== '') return { kind: 'bundle', bundle }
  }
  return null
}

/** Read `ctx.schedule` structurally; `undefined` when the schedule service is not mounted. */
export function scheduleService(ctx: { get(name: string): unknown }): ScheduleServiceLike | undefined {
  const value = ctx.get('schedule')
  if (!isRecord(value) || typeof value.create !== 'function') return undefined
  const create = value.create
  const catalog = typeof value.catalog === 'function' ? value.catalog : undefined
  const list = typeof value.list === 'function' ? value.list : undefined
  const edit = typeof value.edit === 'function' ? value.edit : undefined
  if (catalog === undefined && list === undefined) return undefined
  return {
    create: async (request) => await (create as (request: unknown) => Promise<unknown>).call(value, request),
    ...(edit === undefined ? {} : {
      edit: async (request: Record<string, unknown>) => await (edit as (request: unknown) => Promise<unknown>).call(value, request),
    }),
    catalog: async () => {
      if (catalog !== undefined) {
        const entries: unknown = await (catalog as () => Promise<unknown>).call(value)
        return Array.isArray(entries) ? entries : []
      }
      const listed: unknown = await (list as (request?: unknown) => Promise<unknown>).call(value, {})
      if (Array.isArray(listed)) return listed
      return isRecord(listed) && Array.isArray(listed.items) ? listed.items : []
    },
  }
}

/**
 * The launcher a scheduled task stores.
 *
 * This text is FROZEN into the user's task at creation, so it must stay small and
 * stable: it only points at the tool. Everything about how to run the check and
 * how to report it lives in the plugin's `brief`, so upgrading dsh-upkeep changes
 * what an existing task does without touching the task.
 */
export const TASK_PROMPT_VERSION = 2

/**
 * The marker this plugin writes on the last line of every launcher.
 *
 * It is the task's machine-readable identity: generation, language, and the bundle
 * it watches. The title above it is display text and may change language freely.
 */
export function promptMarker(version: number, locale: 'en' | 'zh' = 'en', bundle?: string): string {
  const scope = bundle === undefined ? '' : ` bundle="${bundle}"`
  return `<!-- upkeep-task:v${version} lang=${locale}${scope} -->`
}

/** The generation a stored prompt was written at, or 0 when unmarked. */
export function promptVersionOf(prompt: string): number {
  const match = /<!-- upkeep-task:v(\d+)\b/.exec(prompt)
  return match === null ? 0 : Number(match[1])
}

/** What a stored marker says, or null when the prompt is not one of ours. */
export function parseTaskMarker(prompt: string): { version: number; locale: 'en' | 'zh'; bundle: string | null } | null {
  const match = /<!-- upkeep-task:v(\d+)\s+lang=(en|zh)(?:\s+bundle="([^"]*)")?\s*-->/.exec(prompt)
  if (match === null) {
    const legacy = promptVersionOf(prompt)
    return legacy === 0 ? null : { version: legacy, locale: 'en', bundle: null }
  }
  return { version: Number(match[1]), locale: match[2] === 'zh' ? 'zh' : 'en', bundle: match[3] === undefined ? null : match[3] }
}

/** The prompt the scheduled session receives: a launcher, not a policy. */
export function buildSchedulePrompt(bundle?: string, locale: 'en' | 'zh' = 'en'): string {
  const focusEn = bundle === undefined ? '' : 'Focus on the plugin `' + bundle + '`.'
  const focusZh = bundle === undefined ? '' : '只关注插件 `' + bundle + '`。'
  const body = locale === 'zh'
    ? [
        '运行 dsh-upkeep 的兼容性检查。',
        '',
        '1. 调用 `upkeep_status` 工具，参数为 `action: "check"`。',
        '2. 然后严格按返回结果里的 `brief` 执行：它定义了要汇报什么、怎么给发现的问题分级、',
        '   以及哪些事情不允许做。把该段当作当前安装版本的指令，而不是建议。',
        '3. 本次运行不要修改任何文件或仓库。',
        focusZh,
      ]
    : [
        'Run the dsh-upkeep compatibility check.',
        '',
        '1. Call the `upkeep_status` tool with `action: "check"`.',
        '2. Then follow the `brief` block of its result exactly: it defines what to report, how to',
        '   grade anything you notice, and what is out of scope. Treat that block as the instructions',
        '   of the installed dsh-upkeep version, not as a suggestion.',
        '3. Do not modify any file or repository in this run.',
        focusEn,
      ]
  return [...body, '', promptMarker(TASK_PROMPT_VERSION, locale, bundle)].filter(line => line !== '').join('\n')
}

/** A wall-clock time of day, normalized to the service's `HH:mm:ss`. */
export function normalizeTimeOfDay(value: string): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim())
  if (match === null) return null
  const hour = String(Number(match[1])).padStart(2, '0')
  const minute = match[2]
  const second = match[3] ?? '00'
  return hour + ':' + minute + ':' + second
}

/** Whether the runtime knows this time zone. */
export function isKnownTimeZone(value: string): boolean {
  if (value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Clamp the interval to the schedule service's supported range. */
export function clampIntervalSeconds(hours: number): number {
  const seconds = Math.round(hours * 3_600)
  return Math.min(Math.max(seconds, 60), 30 * 24 * 3_600)
}

/**
 * Create the recurring check.
 * @param service - the structural schedule service.
 * @param options.intervalHours - how often to deliver; clamped.
 * @param options.cwd - the created Session's project directory.
 * @returns the created catalog entry, with its id and title when present.
 */
export async function createUpkeepTask(
  service: ScheduleServiceLike,
  options: {
    intervalHours: number
    cwd: string
    bundle?: string
    timeOfDay?: string
    timeZone?: string
    locale?: 'en' | 'zh'
  },
): Promise<{ id: string | null; title: string; timing: Record<string, unknown> }> {
  // A chosen wall-clock time makes a daily task; otherwise the interval decides.
  const daily = options.timeOfDay !== undefined && options.timeOfDay !== ''
    ? normalizeTimeOfDay(options.timeOfDay)
    : null
  const timing: Record<string, unknown> = daily !== null
    ? { kind: 'daily', daily: { time: daily, time_zone: options.timeZone ?? 'UTC' } }
    : { kind: 'every', every_seconds: clampIntervalSeconds(options.intervalHours) }
  const locale = options.locale ?? 'en'
  const title = taskTitleFor(
    options.bundle === undefined ? { kind: 'all' } : { kind: 'bundle', bundle: options.bundle },
    locale,
  )
  const created = await service.create({
    title,
    prompt: buildSchedulePrompt(options.bundle, locale),
    timing,
    target: { kind: 'new_once', create: options.cwd.trim() === '' ? {} : { cwd: options.cwd } },
  })
  const id = isRecord(created) && typeof created.id === 'string' ? created.id : null
  const createdTitle = isRecord(created) && typeof created.title === 'string' ? created.title : title
  return { id, title: createdTitle, timing }
}

/** One scheduled check, reduced to what the panel shows. */
export interface ScheduledTaskView {
  /** The package this task watches, or `null` when it watches every plugin. */
  bundle: string | null
  title: string
  /** Fixed interval in seconds; absent for a calendar-shaped task. */
  everySeconds: number | null
  /** The next occurrence, ISO-8601, when the service reported one. */
  nextAt: string | null
}

/** The first line of every launcher this plugin writes. */
export const LAUNCHER_HEAD = 'Run the dsh-upkeep compatibility check.'

/** Whether a stored prompt is still our own launcher (and therefore safe to refresh). */
export function isLauncherPrompt(prompt: string): boolean {
  return prompt.startsWith(LAUNCHER_HEAD) && prompt.includes('<!-- upkeep-task:v')
}

/**
 * Refresh the stored launcher of one of our tasks when the installed version is
 * newer, leaving anything the user rewrote untouched.
 * @returns whether the task was updated.
 */
export async function reconcileTaskPrompt(
  service: ScheduleServiceLike,
  task: { id: string | null; bundle: string | null; prompt: string | null; updatedAt: string | null },
  options: { locale?: 'en' | 'zh' } = {},
): Promise<boolean> {
  if (service.edit === undefined || task.id === null || task.prompt === null) return false
  if (!isLauncherPrompt(task.prompt)) return false
  const marker = parseTaskMarker(task.prompt)
  const versionStale = promptVersionOf(task.prompt) < TASK_PROMPT_VERSION
  const languageStale = options.locale !== undefined && marker !== null && marker.locale !== options.locale
  if (!versionStale && !languageStale) return false
  // A language switch rewrites display text only; the stored scope comes from the marker.
  const locale = options.locale ?? marker?.locale ?? 'en'
  const bundle = task.bundle ?? marker?.bundle ?? undefined
  const scope = bundle === undefined ? { kind: 'all' as const } : { kind: 'bundle' as const, bundle }
  const answer: unknown = await service.edit({
    id: task.id,
    action: 'update',
    patch: { prompt: buildSchedulePrompt(bundle, locale), title: taskTitleFor(scope, locale) },
    expectedUpdatedAt: task.updatedAt,
  })
  return isRecord(answer) && answer.code !== 'schedule_conflict'
}

/**
 * How often a task repeats, in seconds.
 *
 * A catalog record carries `everySeconds` for interval tasks only; a daily task
 * expresses its cadence through its timing, so it is derived here to keep the
 * panel from showing a bare time with no cadence.
 */
function everySecondsOf(entry: Record<string, unknown>): number | null {
  if (typeof entry.everySeconds === 'number') return entry.everySeconds
  const timing = entry.timing
  if (!isRecord(timing)) return null
  if (timing.kind === 'daily') return 86_400
  if (timing.kind === 'weekly') return 7 * 86_400
  return null
}

/** Reduce a live catalog to the tasks this plugin owns and the panel can show. */
export function scheduledTaskViews(entries: unknown[]): ScheduledTaskView[] {
  const views: ScheduledTaskView[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const title = typeof entry.title === 'string' ? entry.title : ''
    const marker = parseTaskMarker(typeof entry.prompt === 'string' ? entry.prompt : '')
    const scope = marker?.bundle === null || marker?.bundle === undefined
      ? parseUpkeepTitle(title)
      : { kind: 'bundle' as const, bundle: marker.bundle }
    if (scope === null) continue
    const status = typeof entry.status === 'string' ? entry.status : null
    if (status === 'paused' || status === 'ended') continue
    views.push({
      bundle: scope.kind === 'all' ? null : scope.bundle,
      title,
      everySeconds: everySecondsOf(entry),
      nextAt: typeof entry.scheduledAt === 'string' ? entry.scheduledAt : null,
    })
  }
  return views
}

/**
 * Deliver one prompt to a fresh Session shortly from now.
 *
 * The workspace API only seeds an unsent draft, so this is how an upgrade task
 * actually starts running: the schedule service creates the Session in the
 * prepared directory and hands the prompt to its agent as user input.
 */
export async function createOneShotTask(
  service: ScheduleServiceLike,
  options: { title: string; prompt: string; cwd: string; delaySeconds?: number },
): Promise<{ id: string | null; title: string }> {
  const created = await service.create({
    title: options.title,
    prompt: options.prompt,
    timing: { kind: 'after', after_seconds: Math.max(1, Math.round(options.delaySeconds ?? 1)) },
    target: { kind: 'new_once', create: options.cwd.trim() === '' ? {} : { cwd: options.cwd } },
  })
  const id = isRecord(created) && typeof created.id === 'string' ? created.id : null
  const title = isRecord(created) && typeof created.title === 'string' ? created.title : options.title
  return { id, title }
}

/**
 * Delete one of this plugin's tasks.
 *
 * The service deletes through an edit with `action: 'delete'` and the entry's
 * current `updatedAt` as its concurrency token, so the catalog is read first.
 * @returns whether a task was deleted.
 */
export async function removeOneShotTask(service: ScheduleServiceLike, id: string): Promise<boolean> {
  if (service.edit === undefined) return false
  const entries = await service.catalog()
  const entry = entries.find(candidate => isRecord(candidate) && candidate.id === id)
  if (entry === undefined) return false
  const updatedAt = isRecord(entry) && typeof entry.updatedAt === 'string' ? entry.updatedAt : null
  const answer: unknown = await service.edit({ id, action: 'delete', expectedUpdatedAt: updatedAt })
  return isRecord(answer) && answer.deleted === true
}

/** List the tasks this plugin created, newest fields preserved as-is. */
export async function listUpkeepTasks(service: ScheduleServiceLike): Promise<Array<{
  id: string | null
  title: string
  status: string | null
  prompt: string | null
  bundle: string | null
  updatedAt: string | null
}>> {
  const entries = await service.catalog()
  const tasks: Array<{
    id: string | null
    title: string
    status: string | null
    prompt: string | null
    bundle: string | null
    updatedAt: string | null
  }> = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const title = typeof entry.title === 'string' ? entry.title : ''
    if (!title.startsWith('Upkeep')) continue
    const marker = parseTaskMarker(typeof entry.prompt === 'string' ? entry.prompt : '')
    const scope = marker?.bundle === null || marker?.bundle === undefined
      ? parseUpkeepTitle(title)
      : { kind: 'bundle' as const, bundle: marker.bundle }
    tasks.push({
      id: typeof entry.id === 'string' ? entry.id : null,
      title,
      status: typeof entry.status === 'string' ? entry.status : null,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : null,
      bundle: scope !== null && scope.kind === 'bundle' ? scope.bundle : null,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    })
  }
  return tasks
}
