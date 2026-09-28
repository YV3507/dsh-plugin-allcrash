// @ts-check
/*
 * dsh-plugin-allcrash —— 平台路径策略（全插件唯一一处）
 *
 * 与 @deepseek-ai/dsh-home-paths 的 resolveDshHome 走同一套规则，避免
 * 「插件以为的家目录」和「DSH 以为的家目录」在某个平台上不一致：
 *
 *   1) 显式 configured 参数优先；
 *   2) 其次 $DSH_HOME —— 空串 / 纯空白视为未设置（不得退化成 cwd）；
 *   3) 最后 ~/.dsh —— homedir()，Node 在 Windows 取 USERPROFILE、POSIX 取 $HOME；
 *   4) 支持 `~`、`~/`、`~\` 前缀展开（`~\` 在 Windows 上是合法写法，POSIX 上也接受）；
 *   5) 最后 resolve() 成绝对路径（相对路径按 cwd 解析，与 DSH 一致）。
 *
 * 注意一个 DSH 自身的语义细节（这里刻意照抄，不做"改进"）：
 * `$DSH_HOME` 只用 **trim 后的结果判断是否已设置**，值本身**原样**交给 resolve()。
 * 所以 `DSH_HOME=" /tmp/x "` 在 DSH 眼里是一个带空白的相对路径。插件若擅自 trim，
 * 就会和宿主对「家目录在哪」产生分歧 —— 那比"看起来不对"危险得多：
 * 守卫会把配置写到 DSH 不认的地方，然后静默按默认值跑。
 * 遇到这种可疑写法，plugin.js 会在启动日志里明确告警。
 *
 * 所有 join/resolve 都用 node:path 的**宿主平台**实现，不手写分隔符：
 * Windows 上 `link:E:/x` 与 `E:\x` 都能用，macOS/Linux 上 `/Users/a/b` 也照旧。
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 崩溃报告目录名（对应原型 Minecraft 的 crash-reports/）。 */
export const CRASH_REPORT_DIR_NAME = 'crash-reports'
/** 配置文件文件名（对应原型 config/allcrash-common.toml）。 */
export const CONFIG_FILE_NAME = 'allcrash.json'
/** 审计日志目录名 / 文件名。 */
export const AUDIT_DIR_NAME = '.allcrash'
export const AUDIT_FILE_NAME = 'watch.log'
export const DSH_HOME_ENV = 'DSH_HOME'
export const DSH_HOME_DIR_NAME = '.dsh'

/** homedir() 在极端环境（无 HOME/USERPROFILE）会抛，退到 cwd 而不是崩。 */
export function safeHomedir() {
  try {
    return homedir()
  } catch {
    return process.cwd()
  }
}

/**
 * 展开 `~` / `~/` / `~\`。与 DSH 的实现一致：不支持的写法原样返回。
 * @param {string} value
 * @param {string} home
 * @returns {string}
 */
export function expandHomePath(value, home) {
  if (typeof value !== 'string') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

/**
 * 解析 DSH 家目录。
 * @param {{env?: Record<string, string | undefined>, home?: string, configured?: string}} [options]
 * @returns {string} 绝对的宿主原生路径
 */
export function resolveDshHome(options = {}) {
  const env = options.env ?? process.env
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : safeHomedir()
  const fromEnv = env?.[DSH_HOME_ENV]
  const usableEnv = typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : undefined
  // 显式参数与 $DSH_HOME 同样对待：空串 / 纯空白视为未设置，否则 resolve('') 会落到 cwd。
  // 注意这是**刻意的偏离**：@deepseek-ai/dsh-home-paths 用的是 `configured ?? …`，
  // 所以它会把空串 resolve 成 cwd；本插件不这么做 —— 一个空的 home 配置绝不该
  // 把「守卫读哪份名单 / 写哪份报告」变成当前工作目录。今天没有调用方传 configured。
  const configured = typeof options.configured === 'string' && options.configured.trim().length > 0 ? options.configured : undefined
  const chosen = configured ?? usableEnv ?? join(home, DSH_HOME_DIR_NAME)
  return resolve(expandHomePath(chosen, home))
}

/** `${DSH_HOME}/allcrash.json` */
export function configPathFor(options) {
  return join(resolveDshHome(options), CONFIG_FILE_NAME)
}

/** `${DSH_HOME}/crash-reports` */
export function crashReportDirFor(options) {
  return join(resolveDshHome(options), CRASH_REPORT_DIR_NAME)
}

/** `${DSH_HOME}/.allcrash`（审计日志与 dry-run 诊断所在的目录） */
export function auditDirFor(options) {
  return join(resolveDshHome(options), AUDIT_DIR_NAME)
}

/** `${DSH_HOME}/.allcrash/watch.log` */
export function auditLogPathFor(options) {
  return join(resolveDshHome(options), AUDIT_DIR_NAME, AUDIT_FILE_NAME)
}

/** 崩溃报告文件的完整路径：`<crash-reports>/allcrash-<本地时间>-<pid>.txt` */
export function crashReportFileFor(stamp, pid, options) {
  return join(crashReportDirFor(options), `allcrash-${stamp}-${pid}.txt`)
}

/** 某个路径所在目录（`mkdirSync(..., {recursive:true})` 用）。 */
export function parentDirOf(path) {
  return dirname(path)
}
