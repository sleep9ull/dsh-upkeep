/**
 * Host-side copy in the reader's language.
 *
 * Warnings are produced deep inside the Host, where the reader's language is not
 * known. Those warnings are collected as KEYS plus optional detail, and translated
 * once, at the boundary, using the locale the client sent with the request.
 *
 * Anything that is not a known key is passed through unchanged: a warning with
 * machine detail (a git error, a path) stays verbatim rather than becoming empty.
 */

/** Languages the Host can speak; DSH itself ships more, which fall back to English. */
export type HostLocale = 'en' | 'zh'

/** Stable warning identities. Never reuse a key for different copy. */
export type MessageKey =
  | 'runtimeUnreadable'
  | 'noOwnerIdentity'
  | 'bundlesUnlistable'
  | 'pluginManagerMissing'
  | 'targetStale'
  | 'feedUnavailable'
  | 'tasksUnreadable'
  | 'launcherRefreshed'
  | 'worktreePruned'
  | 'autoStartFailed'
  | 'scheduleMissing'
  | 'repoDirty'
  | 'guidesFallback'
  | 'surfaceScanLimited'
  | 'bundlePatchUnreadable'
  | 'bundleSourceUnreadable'
  | 'surfaceScanEmpty'

type Entry = { en: string; zh: string }

const MESSAGES: Record<MessageKey, Entry> = {
  runtimeUnreadable: {
    en: 'The running DSH version could not be read from the profile installation anchor.',
    zh: '无法从 profile 的安装锚点读到当前运行的 DSH 版本。',
  },
  noOwnerIdentity: {
    en: 'No owner identity was detected; ownership is reported as unknown. Set ownerHandles in the plugin configuration.',
    zh: '没有检测到你的身份，归属一律显示为未知。可在插件配置里设置 ownerHandles。',
  },
  bundlesUnlistable: {
    en: 'Installed bundles could not be listed: {detail}',
    zh: '无法列出已安装的 bundle：{detail}',
  },
  pluginManagerMissing: {
    en: 'The plugin manager service is not mounted; installed bundles are unknown.',
    zh: '插件管理服务未挂载，已安装的 bundle 未知。',
  },
  targetStale: {
    en: 'The target DSH version comes from a stale cached answer; run a check to refresh it.',
    zh: '目标 DSH 版本来自过期的缓存结果；执行一次检查即可刷新。',
  },
  feedUnavailable: {
    en: 'The DSH version feed is unavailable ({detail}); using the cached target.',
    zh: 'DSH 版本源不可用（{detail}），改用缓存的目标版本。',
  },
  tasksUnreadable: {
    en: 'The stored scheduled tasks could not be inspected; they keep their current launcher.',
    zh: '无法读取已保存的定时任务，它们保留当前的启动器。',
  },
  launcherRefreshed: {
    en: 'Refreshed the launcher of {detail} to this version.',
    zh: '已把 {detail} 的启动器刷新到当前版本。',
  },
  worktreePruned: {
    en: 'Removed an older worktree to stay within worktreesToKeep: {detail}',
    zh: '为保持在 worktreesToKeep 之内，删除了较旧的 worktree：{detail}',
  },
  autoStartFailed: {
    en: 'The upgrade session could not be started automatically ({detail}); open the workspace and send the prompt yourself.',
    zh: '未能自动启动升级会话（{detail}）；请打开工作区自行发送提示词。',
  },
  scheduleMissing: {
    en: 'The schedule service is not mounted, so the upgrade session was not started automatically; open the workspace and send the prompt yourself.',
    zh: '定时任务服务未挂载，无法自动启动升级会话；请打开工作区自行发送提示词。',
  },
  repoDirty: {
    en: 'The repository has {detail} uncommitted change(s); the worktree starts from HEAD.',
    zh: '仓库有 {detail} 处未提交改动；worktree 从 HEAD 开始。',
  },
  guidesFallback: {
    en: 'Some upgrade guides could not be fetched ({detail}); the report uses the installed guides only.',
    zh: '部分升级指南无法获取（{detail}），报告只使用安装版指南。',
  },
  surfaceScanLimited: {
    en: 'The surface scan stopped at its limit ({detail}); the report may miss a usage.',
    zh: '表面扫描在限额处停止（{detail}），报告可能漏掉某处用法。',
  },
  bundlePatchUnreadable: {
    en: 'The bundle patch of {detail} could not be read; the rows and config it declares are unknown to this scan.',
    zh: '读不到 {detail} 声明的 bundle patch，本次扫描无法得知它声明的 row 与配置。',
  },
  bundleSourceUnreadable: {
    en: 'The source directory of {detail} could not be resolved; its surface scan is unknown, not clean.',
    zh: '无法解析 {detail} 的源码目录；表面扫描是未知，不代表没有兼容问题。',
  },
  surfaceScanEmpty: {
    en: 'No readable source file was found for {detail}; its surface scan is unknown, not clean.',
    zh: '没有读到 {detail} 的任何源码文件；表面扫描是未知，不代表没有兼容问题。',
  },
}

/** Normalize anything a request may carry into one of our two languages. */
export function hostLocale(value: unknown): HostLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Render one message.
 * @param key - the stable identity.
 * @param locale - who is reading.
 * @param detail - substituted for `{detail}` when the copy has a placeholder.
 */
export function hostMessage(key: MessageKey, locale: HostLocale, detail?: string): string {
  const entry = MESSAGES[key]
  const text = entry === undefined ? key : entry[locale]
  return detail === undefined ? text : text.replace('{detail}', detail)
}

/**
 * Translate every warning a Host call collected.
 *
 * Entries arrive either as a bare key or as `key\u0000detail`; anything else is
 * already human copy (or machine detail) and is returned untouched.
 */
export function localizeWarnings(warnings: string[], locale: HostLocale): string[] {
  return warnings.map(warning => {
    const separator = warning.indexOf('\u0000')
    const key = (separator === -1 ? warning : warning.slice(0, separator)) as MessageKey
    if (!(key in MESSAGES)) return warning
    return hostMessage(key, locale, separator === -1 ? undefined : warning.slice(separator + 1))
  })
}

/** Build a warning that {@link localizeWarnings} can translate later. */
export function warning(key: MessageKey, detail?: string): string {
  return detail === undefined ? key : `${key}\u0000${detail}`
}

/**
 * Localize every `warnings` array inside a result, leaving all other fields alone.
 *
 * Doing this once at the adapter boundary keeps the deep code free of locale
 * plumbing: the Host builds keys, the response speaks the caller's language.
 */
export function localizeResult<T>(value: T, locale: HostLocale, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(entry => localizeResult(entry, locale, depth + 1)) as unknown as T
  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (key === 'warnings' && Array.isArray(entry)) {
      output[key] = localizeWarnings(entry.filter((item): item is string => typeof item === 'string'), locale)
      continue
    }
    output[key] = localizeResult(entry, locale, depth + 1)
  }
  return output as unknown as T
}
