/**
 * The only child-process seam of the Host half.
 *
 * Upgrade worktrees and verification commands run through this injected runner,
 * so tests never touch the machine and every call is bounded: argv arrays (no
 * shell), a deadline, a captured-output cap and no interactive terminal.
 */

import { execFile } from 'node:child_process'

/** One finished command. */
export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** The injectable command runner. */
export interface ExecRunner {
  run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<CommandResult>
}

/** Keep the tail of a captured stream; agents only need the failure end. */
function tail(text: string, limit = 16_384): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/**
 * Build the default runner over `node:child_process.execFile`.
 * @param limits - maximum captured bytes per stream (default 1 MiB).
 */
export function createExecRunner(limits: { maxBuffer?: number } = {}): ExecRunner {
  const maxBuffer = limits.maxBuffer ?? 1_048_576
  return {
    run(command, args, options) {
      return new Promise<CommandResult>((resolve) => {
        execFile(
          command,
          args,
          {
            cwd: options.cwd,
            timeout: options.timeoutMs ?? 300_000,
            maxBuffer,
            encoding: 'utf8',
            env: { ...process.env, ...options.env },
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const failure = error as { code?: unknown; killed?: boolean } | null
            resolve({
              exitCode: failure !== null && typeof failure.code === 'number' ? failure.code : failure === null ? 0 : null,
              stdout: tail(stdout ?? ''),
              stderr: tail(stderr ?? ''),
              timedOut: failure?.killed === true,
            })
          },
        )
      })
    },
  }
}
