import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  LAUNCHER_HEAD,
  TASK_PROMPT_VERSION,
  TASK_TITLE,
  isLauncherPrompt,
  promptVersionOf,
  isKnownTimeZone,
  normalizeTimeOfDay,
  parseUpkeepTitle,
  taskTitleFor,
  buildSchedulePrompt,
  clampIntervalSeconds,
  createUpkeepTask,
  listUpkeepTasks,
  scheduleService,
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
  assert.match(prompt, new RegExp('<!-- upkeep-task:v' + TASK_PROMPT_VERSION + ' -->'))
  // Policy lives in the plugin, not in the frozen copy.
  assert.doesNotMatch(prompt, /P0|P1|P2/)
  assert.doesNotMatch(prompt, /migration-guide/)
  assert.equal(promptVersionOf(prompt), TASK_PROMPT_VERSION)
  assert.equal(promptVersionOf('no marker here'), 0)
  assert.equal(isLauncherPrompt(prompt), true)
  assert.equal(isLauncherPrompt('Do my own thing <!-- upkeep-task:v1 -->'), false)
  assert.equal(isLauncherPrompt(LAUNCHER_HEAD + ' but no marker'), false)
})
