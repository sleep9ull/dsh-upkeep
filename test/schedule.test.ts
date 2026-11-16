import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  TASK_TITLE,
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
