// @ts-check
/*
 * dsh-plugin-allcrash —— 引爆层（副作用都在这里）
 *
 * 崩溃链路（与原型对应的「发现即崩溃」）：
 *
 *   1. 写崩溃报告 → ${DSH_HOME}/crash-reports/allcrash-<时间>-<pid>.txt
 *   2. stderr 打出原型那句歌词 + 中文说明
 *   3. process.nextTick(() => { throw error })
 *        DSH Host 在 boot 之前就装了 fail-loud（@deepseek-ai/dsh-app-boot 的
 *        installFailLoud，见 Desktop 的 host-process-entry.js）：
 *        任何未捕获异常/未处理拒绝 → stderr 一行诊断 → release() → exit(1)。
 *        也就是说这一步是真的把 Host 进程打死，不是插件级别的小错误。
 *   4. 兜底：3 秒后无论如何 process.exit(1)
 *        万一运行环境没有装 fail-loud（嵌入式/自建 bin），也必须死。
 *        这个 fallback 定时器故意不注册到 ctx 上：它必须活过插件的 dispose。
 *
 * 时间常量：fail-loud 等待 release 最多 FAIL_LOUD_RELEASE_TIMEOUT_MS(2000)，
 * 所以兜底 3000ms 保证正常情况下 fail-loud 先落地、异常情况下兜底接管。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { auditDirFor, crashReportDirFor, crashReportFileFor } from './paths.js'

/** fail-loud 的 release 上限 2000ms 之后仍然要死。 */
export const EXIT_FALLBACK_MS = 3000

/** 文件名用本地时间，避免时区看不懂；保留毫秒防撞。只含数字/短横/下划线（Windows 安全）。 */
export function stamp(date) {
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  )
}

/** 默认 I/O：真实进程。测试注入假实现。 */
export function defaultIo() {
  return {
    now: () => new Date(),
    env: () => process.env,
    pid: () => process.pid,
    /**
     * 写崩溃报告；失败也不能阻止崩溃。
     * 路径规则全部走 paths.js（DSH_HOME → ~/.dsh，宿主平台 join/resolve）。
     * @param {string} text
     * @returns {string | undefined}
     */
    writeReport(text) {
      const date = this.now()
      const env = this.env()
      const dir = crashReportDirFor({ env })
      const file = crashReportFileFor(stamp(date), this.pid(), { env })
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, text, 'utf8')
      return file
    },
    /** @param {string} line */
    stderr(line) {
      // 首选 stderr 原流；不可用时才退回 console.error（两者同时写会看到重复行）
      try {
        process.stderr.write(line + '\n')
        return
      } catch {
        /* fall through */
      }
      try {
        console.error(line)
      } catch {
        /* ignore */
      }
    },
    /** @param {Error} error */
    throwAsync(error) {
      process.nextTick(() => {
        throw error
      })
    },
    /** @param {number} ms */
    exitFallback(ms) {
      // 故意不 unref：这个定时器要撑住事件循环直到进程真的死掉。
      setTimeout(() => {
        try {
          process.stderr.write(`[allcrash] fail-loud 未接管，兜底 process.exit(1)\n`)
        } catch {
          /* ignore */
        }
        process.exit(1)
      }, ms)
    },
  }
}

/**
 * 造一个「每次 apply 一份」的引爆器。`fired` 状态在闭包里，
 * 因此同一插件实例只可能崩一次（重复的扫描/事件不会写一堆报告）。
 *
 * @param {{now?: () => Date, env?: () => NodeJS.ProcessEnv, pid?: () => number,
 *   writeReport?: (text: string) => string | undefined, stderr?: (line: string) => void,
 *   throwAsync?: (error: Error) => void, exitFallback?: (ms: number) => void}} [io]
 *   可注入的 I/O 面（测试用）；未提供的项使用真实进程实现。
 */
export function createDetonator(io) {
  const real = defaultIo()
  const sink = { ...real, ...(io ?? {}) }
  let fired = false
  /** @type {string | undefined} */
  let reportPath
  /** @type {any} */
  let incidentSeen

  return {
    get fired() {
      return fired
    },
    get reportPath() {
      return reportPath
    },
    get incident() {
      return incidentSeen
    },
    /**
     * 非致命诊断（`mode: "warn"` 用）：把同一份报告正文写到
     * `${DSH_HOME}/.allcrash/would-crash-<时间>-<pid>.txt`。
     * 刻意**不写进 crash-reports/** —— 那个目录的语义是"真的崩过"，保持干净。
     * @param {any} incident
     * @param {(incident: any) => string} buildText
     * @returns {string | undefined} 诊断文件路径（写不出来就是 undefined）
     */
    note(incident, buildText) {
      let text
      try {
        text = buildText(incident)
      } catch (buildError) {
        text = `---- DSH Crash Report (dry-run) ----\n// 报告生成失败: ${String(buildError && /** @type {any} */ (buildError).message ? /** @type {any} */ (buildError).message : buildError)}\n`
      }
      try {
        const env = sink.env()
        const file = join(auditDirFor({ env }), `would-crash-${stamp(sink.now())}-${sink.pid()}.txt`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, text, 'utf8')
        return file
      } catch (error) {
        try {
          sink.stderr(`[allcrash] dry-run diagnostic write failed / 诊断写入失败: ${String(error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error)}`)
        } catch {
          /* ignore */
        }
        return undefined
      }
    },
    /**
     * @param {any} incident 已由 guard.js 组装好的事件（含 reportText 之外的字段）
     * @param {(incident: any) => string} buildText 由 plugin.js 注入的报告生成函数
     * @returns {{reportPath?: string, error?: Error, alreadyFired?: boolean}}
     */
    fire(incident, buildText) {
      if (fired) return { alreadyFired: true }
      fired = true
      incidentSeen = incident

      /** stderr 本身也不能把引爆流程带走 */
      const safeStderr = (line) => {
        try {
          sink.stderr(line)
        } catch {
          /* ignore */
        }
      }

      // 报告正文生成失败也要有报告：这是唯一的事后证据
      let text
      try {
        text = buildText(incident)
      } catch (buildError) {
        text =
          '---- DSH Crash Report ----\n' +
          `// 报告生成失败 / report generation failed: ${String(buildError && /** @type {any} */ (buildError).message ? /** @type {any} */ (buildError).message : buildError)}\n` +
          `trigger: ${String(incident?.trigger ?? 'n/a')}\n` +
          `what: ${String(incident?.what ?? 'n/a')}\n`
      }

      // 1) 崩溃报告：先落盘，后面怎么死都留得下证据
      try {
        reportPath = sink.writeReport(text)
      } catch (error) {
        reportPath = undefined
        safeStderr(
          `[allcrash] crash report write failed / 崩溃报告写入失败: ${String(error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error)}`,
        )
      }

      // 2) stderr：**面向机器/日志的行全部用 ASCII**，中文细节放在最后。
      //    理由：Windows 控制台默认代码页（cp936/cp437）会把 UTF-8 中文显示成乱码，
      //    但 ASCII 行在任何代码页、任何平台的日志里都能被 grep 到；
      //    完整中文细节在 UTF-8 的崩溃报告里。
      const error = new Error(incident?.stderrMessage ?? 'allcrash: forbidden plugin detected')
      error.name = 'AllCrashError'
      for (const line of [
        '',
        '==== allcrash ====',
        String(incident?.stderrMessage ?? ''),
        `allcrash detected a forbidden plugin: ${incident?.what ?? '<unknown>'}`,
        `crash report: ${reportPath ?? '<write failed>'}`,
        'terminating the DSH Host process (fail-loud -> exit 1)',
      ]) {
        safeStderr(line)
      }
      if (incident?.description) safeStderr(`说明：${incident.description}`)
      safeStderr('==================')
      safeStderr('')

      // 3) 交由 fail-loud：未捕获异常 → Host exit(1)
      //    注意：上面任何一步都不允许跳过下面两步 —— 它们才是「死」本身。
      let fatalArmed = false
      try {
        sink.throwAsync(error)
        fatalArmed = true
      } catch (throwFailure) {
        safeStderr(`[allcrash] throw scheduling failed / 抛出失败: ${String(throwFailure)}`)
      }

      // 4) 兜底：即使 3) 被吞掉（某些环境会 log-and-continue）、或抛出调度失败，也必须死
      try {
        sink.exitFallback(EXIT_FALLBACK_MS)
        fatalArmed = true
      } catch (exitFailure) {
        safeStderr(`[allcrash] fallback exit scheduling failed: ${String(exitFailure)}`)
      }

      // 两条致命通道都没装上：解除 fired，让下一次扫描重新尝试引爆，
      // 而不是留下一个「已触发但没死、而且不再检测」的假死状态。
      if (!fatalArmed) fired = false

      return { reportPath, error }
    },
  }
}
