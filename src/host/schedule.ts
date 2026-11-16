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
}

/** How this plugin names its profile-wide task. */
export const TASK_TITLE = 'Upkeep compatibility check'

/** Title prefix for a task that watches one bundle. */
export const BUNDLE_TITLE_PREFIX = 'Upkeep: '

/** What one of this plugin's tasks covers. */
export type UpkeepTaskScope = { kind: 'all' } | { kind: 'bundle'; bundle: string }

/** The task title for one scope. */
export function taskTitleFor(scope: UpkeepTaskScope): string {
  return scope.kind === 'all' ? TASK_TITLE : BUNDLE_TITLE_PREFIX + scope.bundle
}

/** Read a task title back into its scope; unknown titles are not ours. */
export function parseUpkeepTitle(title: string): UpkeepTaskScope | null {
  if (title.trim() === TASK_TITLE) return { kind: 'all' }
  if (title.startsWith(BUNDLE_TITLE_PREFIX)) {
    const bundle = title.slice(BUNDLE_TITLE_PREFIX.length).trim()
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
  if (catalog === undefined && list === undefined) return undefined
  return {
    create: async (request) => await (create as (request: unknown) => Promise<unknown>).call(value, request),
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

/** The prompt the scheduled session receives. */
export function buildSchedulePrompt(bundle?: string): string {
  const focus = bundle === undefined
    ? 'which of MY plugins need care and why'
    : `whether \`${bundle}\` needs care and why`
  return [
    'Run a DeepSeek Harness plugin compatibility check with dsh-upkeep.',
    '',
    '1. Call the `upkeep_status` tool with `action: "check"` so the target DSH version and every verdict are fresh.',
    `2. Report, briefly: the running and target DSH versions; ${focus}; the matched migration-guide items, if any.`,
    '3. Do not modify any file or repository in this run. If something needs care, say what to do next: open the Upkeep panel and press Upgrade (optionally in a worktree), then Verify and Create PR.',
  ].join('\n')
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
  options: { intervalHours: number; cwd: string; bundle?: string; timeOfDay?: string; timeZone?: string },
): Promise<{ id: string | null; title: string; timing: Record<string, unknown> }> {
  // A chosen wall-clock time makes a daily task; otherwise the interval decides.
  const daily = options.timeOfDay !== undefined && options.timeOfDay !== ''
    ? normalizeTimeOfDay(options.timeOfDay)
    : null
  const timing: Record<string, unknown> = daily !== null
    ? { kind: 'daily', daily: { time: daily, time_zone: options.timeZone ?? 'UTC' } }
    : { kind: 'every', every_seconds: clampIntervalSeconds(options.intervalHours) }
  const title = taskTitleFor(options.bundle === undefined ? { kind: 'all' } : { kind: 'bundle', bundle: options.bundle })
  const created = await service.create({
    title,
    prompt: buildSchedulePrompt(options.bundle),
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

/** Reduce a live catalog to the tasks this plugin owns and the panel can show. */
export function scheduledTaskViews(entries: unknown[]): ScheduledTaskView[] {
  const views: ScheduledTaskView[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const title = typeof entry.title === 'string' ? entry.title : ''
    const scope = parseUpkeepTitle(title)
    if (scope === null) continue
    const status = typeof entry.status === 'string' ? entry.status : null
    if (status === 'paused' || status === 'ended') continue
    views.push({
      bundle: scope.kind === 'all' ? null : scope.bundle,
      title,
      everySeconds: typeof entry.everySeconds === 'number' ? entry.everySeconds : null,
      nextAt: typeof entry.scheduledAt === 'string' ? entry.scheduledAt : null,
    })
  }
  return views
}

/** List the tasks this plugin created, newest fields preserved as-is. */
export async function listUpkeepTasks(service: ScheduleServiceLike): Promise<Array<{
  id: string | null
  title: string
  status: string | null
  prompt: string | null
}>> {
  const entries = await service.catalog()
  const tasks: Array<{ id: string | null; title: string; status: string | null; prompt: string | null }> = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const title = typeof entry.title === 'string' ? entry.title : ''
    if (!title.startsWith('Upkeep')) continue
    tasks.push({
      id: typeof entry.id === 'string' ? entry.id : null,
      title,
      status: typeof entry.status === 'string' ? entry.status : null,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : null,
    })
  }
  return tasks
}
