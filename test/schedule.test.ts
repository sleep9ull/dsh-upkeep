import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  LAUNCHER_HEAD,
  TASK_PROMPT_VERSION,
  TASK_TITLE,
  isLauncherPrompt,
  promptVersionOf,
  parseTaskMarker,
  isKnownTimeZone,
  normalizeTimeOfDay,
  parseUpkeepTitle,
  taskTitleFor,
  buildSchedulePrompt,
  clampIntervalSeconds,
  createUpkeepTask,
  listUpkeepTasks,
  scheduleService,
  scheduledTaskViews,
} from '../dist/host/schedule.js'
import type { ScheduleServiceLike } from '../dist/host/schedule.js'

test('the interval is clamped into the schedule service range', () => {
  assert.equal(clampIntervalSeconds(0.1), 360)
  assert.equal(clampIntervalSeconds(24), 86_400)
  assert.equal(clampIntervalSeconds(1000), 30 * 24 * 3_600)
})

test('the scheduled prompt runs a check and never edits files', () => {
  const prompt = buildSchedulePrompt()
  assert.match(prompt, /upkeep_status/)
  assert.match(prompt, /action: "check"/)
  assert.match(prompt, /Do not modify any file/)
})

test('creating the task sends the documented request shape', async () => {
  const requests: unknown[] = []
  const service: ScheduleServiceLike = {
    create: async (request) => { requests.push(request); return { id: 'task-1', title: TASK_TITLE } },
    catalog: async () => [],
    list: async () => ({}),
  }
  const task = await createUpkeepTask(service, { intervalHours: 6, cwd: '/work/plugin' })
  assert.equal(task.id, 'task-1')
  const request = requests[0] as {
    title: string
    prompt: string
    timing: { kind: string; every_seconds: number }
    target: { kind: string; create: { cwd?: string } }
  }
  assert.equal(request.title, TASK_TITLE)
  assert.equal(request.timing.kind, 'every')
  assert.equal(request.timing.every_seconds, 6 * 3_600)
  assert.equal(request.target.kind, 'new_once')
  assert.equal(request.target.create.cwd, '/work/plugin')

  const noCwd = await createUpkeepTask(service, { intervalHours: 24, cwd: '  ' })
  assert.equal(noCwd.title, TASK_TITLE)
  assert.deepEqual((requests[1] as { target: { create: unknown } }).target.create, {})
})

test('listing keeps only this plugin\'s tasks', async () => {
  const service: ScheduleServiceLike = {
    create: async () => ({}),
    catalog: async () => [
      { id: 'a', title: TASK_TITLE, status: 'active', prompt: 'p' },
      { id: 'b', title: 'Someone else task', status: 'active', prompt: 'q' },
      { id: 'c', title: 'Upkeep second', status: 'paused', prompt: 'r' },
    ],
  }
  const tasks = await listUpkeepTasks(service)
  assert.deepEqual(tasks.map(task => task.id), ['a', 'c'])
  assert.equal(tasks[0]?.status, 'active')
})

test('the service is read structurally and absent cleanly', () => {
  assert.equal(scheduleService({ get: () => undefined }), undefined)
  assert.equal(scheduleService({ get: () => ({ list: async () => [] }) }), undefined)
  const minimal = scheduleService({ get: () => ({ create: async () => ({}), list: async () => [] }) })
  assert.equal(typeof minimal?.create, 'function')
})

test('task titles map to and from their scope', () => {
  assert.deepEqual(parseUpkeepTitle(TASK_TITLE), { kind: 'all' })
  assert.deepEqual(parseUpkeepTitle(taskTitleFor({ kind: 'bundle', bundle: '@a/b' })), { kind: 'bundle', bundle: '@a/b' })
  assert.equal(parseUpkeepTitle('Somebody else task'), null)
  assert.equal(parseUpkeepTitle('Upkeep: '), null)
})

test('a bundle-scoped prompt names the plugin', () => {
  const prompt = buildSchedulePrompt('@sleep9ull/plugin')
  assert.match(prompt, /@sleep9ull\/plugin/)
  assert.match(prompt, /Do not modify any file/)
})

test('a chosen time of day is normalized to the service format', () => {
  assert.equal(normalizeTimeOfDay('8:00'), '08:00:00')
  assert.equal(normalizeTimeOfDay('08:5'), null)
  assert.equal(normalizeTimeOfDay('08:05'), '08:05:00')
  assert.equal(normalizeTimeOfDay('23:59'), '23:59:00')
  assert.equal(normalizeTimeOfDay('23:59:30'), '23:59:30')
  assert.equal(normalizeTimeOfDay('24:00'), null)
  assert.equal(normalizeTimeOfDay('later'), null)
})

test('time zones are checked against the runtime', () => {
  assert.equal(isKnownTimeZone('Asia/Shanghai'), true)
  assert.equal(isKnownTimeZone('UTC'), true)
  assert.equal(isKnownTimeZone('Mars/Olympus'), false)
  assert.equal(isKnownTimeZone('  '), false)
})

test('the stored prompt is a launcher that delegates the policy', () => {
  const prompt = buildSchedulePrompt()
  assert.ok(prompt.startsWith(LAUNCHER_HEAD))
  assert.match(prompt, /follow the `brief` block/)
  assert.match(prompt, new RegExp('<!-- upkeep-task:v' + TASK_PROMPT_VERSION + ' lang=en -->'))
  // Policy lives in the plugin, not in the frozen copy.
  assert.doesNotMatch(prompt, /P0|P1|P2/)
  assert.doesNotMatch(prompt, /migration-guide/)
  assert.equal(promptVersionOf(prompt), TASK_PROMPT_VERSION)
  assert.equal(promptVersionOf('no marker here'), 0)
  assert.equal(isLauncherPrompt(prompt), true)
  assert.equal(isLauncherPrompt('Do my own thing <!-- upkeep-task:v1 -->'), false)
  assert.equal(isLauncherPrompt(LAUNCHER_HEAD + ' but no marker'), false)
})

test('a daily task reports its cadence even without everySeconds', () => {
  const views = scheduledTaskViews([
    { id: 'a', title: 'Upkeep compatibility check', status: 'active', timing: { kind: 'daily', daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' } }, scheduledAt: '2026-01-02T00:00:00.000Z' },
    { id: 'b', title: 'Upkeep: @a/b', status: 'active', everySeconds: 3600, scheduledAt: '2026-01-01T09:00:00.000Z' },
  ])
  const daily = views.find(view => view.title === 'Upkeep compatibility check')
  assert.equal(daily?.everySeconds, 86_400, 'a daily timing is one day')
  const hourly = views.find(view => view.title === 'Upkeep: @a/b')
  assert.equal(hourly?.everySeconds, 3_600)
})

test('a task title distinguishes the global check from a per-plugin one', () => {
  assert.equal(taskTitleFor({ kind: 'all' }), TASK_TITLE)
  assert.equal(taskTitleFor({ kind: 'bundle', bundle: '@a/b' }), 'Upkeep: @a/b')
  assert.deepEqual(parseUpkeepTitle(TASK_TITLE), { kind: 'all' })
  assert.deepEqual(parseUpkeepTitle('Upkeep: @a/b'), { kind: 'bundle', bundle: '@a/b' })
  // Old and new titles both resolve, so an upgrade never orphans a task.
  assert.equal(scheduledTaskViews([{ title: TASK_TITLE, status: 'active', everySeconds: 86_400 }]).length, 1)
})

test('a task is created in the language the panel asked for', () => {
  const zh = buildSchedulePrompt('@a/b', 'zh')
  assert.match(zh, /运行 dsh-upkeep 的兼容性检查/)
  assert.match(zh, /只关注插件 `@a\/b`/)
  assert.match(zh, /<!-- upkeep-task:v2 lang=zh bundle="@a\/b" -->/)
  assert.equal(promptVersionOf(zh), TASK_PROMPT_VERSION, 'the generation is unchanged')
  assert.deepEqual(parseTaskMarker(zh), { version: TASK_PROMPT_VERSION, locale: 'zh', bundle: '@a/b' })

  // Identity survives a language switch: the marker, not the title, carries it.
  assert.equal(taskTitleFor({ kind: 'all' }, 'zh'), 'Upkeep 兼容性检查')
  assert.equal(taskTitleFor({ kind: 'bundle', bundle: '@a/b' }, 'zh'), 'Upkeep 兼容性检查：@a/b')
  assert.deepEqual(parseUpkeepTitle('Upkeep 兼容性检查'), { kind: 'all' })
  assert.deepEqual(parseUpkeepTitle('Upkeep 兼容性检查：@a/b'), { kind: 'bundle', bundle: '@a/b' })
})
