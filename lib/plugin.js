// @ts-check
/*
 * dsh-plugin-allcrash —— Host 接线层（Cordis 插件）
 *
 * 只做四件事：读配置、订阅事件、开看门狗、在命中时调用引爆器。
 * 判定逻辑在 ./guard.js，引爆副作用在 ./detonate.js。
 *
 * 四条检测通道（对照原型的「客户端本地检查 + 服务端强制校验」）：
 *
 *   L1 tools/pre-execute  —— 有人用 plugin_manager 安装/启用被禁插件，
 *                            或试图关停守卫自身。此刻 pnpm 尚未启动，profile 未被改动。
 *   L2 plugin-manager/changed + install-state + install-log —— 任何来源
 *                            （含 Web 市场 / CLI）的安装完成或输出，立刻重扫。
 *   L3 看门狗 interval      —— 覆盖「HMR 监听器手工改动 patch」这条不发事件的路径
 *                            （plugin-manager/changed 的文档明确说手工改动不广播）。
 *   L4 agentPresets.compositionInventory —— 预设里的行不在 loader 树上，单独扫。
 *
 * 零包依赖：只用 node: 内建模块。以 link: 方式装进 profile 时按真实路径解析，
 * 插件目录下没有 node_modules，任何 `import '@deepseek-ai/...'` 都会让插件加载失败。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  buildReport,
  classifyInstallLog,
  classifyManagerCall,
  inspectLoaderRows,
  inspectPresetCompositions,
  mergeConfig,
  nameMatches,
  parseConfigText,
  policyOf,
  readLoaderRows,
  resolveResponse,
  rickrollMessage,
  shortName,
} from './guard.js'
import { auditLogPathFor, configPathFor, parentDirOf, resolveDshHome, safeHomedir } from './paths.js'
import { createDetonator } from './detonate.js'

export const name = 'allcrash'
export const PLUGIN_VERSION = '1.1.0'
/** 不依赖任何服务：拿不到 loader 也要能跑，全部用 ctx.get 惰性读取。 */
export const inject = []

const REPORT_TAIL_BYTES = 64 * 1024
const REPORT_TAIL_LINES = 200

/**
 * @param {any} ctx Cordis 上下文
 * @param {any} rowConfig cordis.patch.yml 那一行的 config（本插件不导出 Config，
 *   所以 resolver 原样透传，见 @deepseek-ai/cordis 的 resolveConfig）
 */
export function apply(ctx, rowConfig) {
  const pluginVersion = PLUGIN_VERSION
  const message = (error) => String(error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error)

  /*
   * 诊断走宿主 logger，不用 console.log：
   *   - ACP 模式下 stdout 就是 JSON-RPC 的 ND-JSON 线（dsh-acp 的
   *     `ndJsonStream(Writable.toWeb(process.stdout), …)`），往 stdout 写日志会污染协议；
   *   - Desktop 的日志文件只收 ctx.logger 的记录，宿主子进程的 stdout 只是被转发，
   *     所以 console.log 出去的降级告警用户看不到 —— 「守卫悄悄不干活了」会看起来一切正常。
   * 只有拿不到 logger 的环境（裸 Node 里直接 apply）才退回 console。
   */
  const stringifyParts = (parts) =>
    parts
      .map((part) => {
        if (typeof part === 'string') return part
        if (part instanceof Error) return part.stack ?? part.message
        try {
          return JSON.stringify(part)
        } catch {
          return String(part)
        }
      })
      .join(' ')
  const logger = ctx.logger
  const emit = (level, parts) => {
    const text = stringifyParts(parts)
    try {
      if (logger !== undefined && typeof logger[level] === 'function') {
        // 用 '%s' + 参数的形式：消息里出现的 % 不会被当成格式占位符
        logger[level]('%s', text)
        return
      }
    } catch {
      /* fall through to console */
    }
    try {
      if (level === 'info') console.log('[allcrash]', text)
      else console.error('[allcrash]', text)
    } catch {
      /* ignore */
    }
  }
  const log = (...parts) => emit('info', parts)
  const warn = (...parts) => emit('warn', parts)

  // 路径规则全部交给 paths.js：$DSH_HOME（空白视为未设置）→ ~/.dsh，宿主平台 join/resolve
  const configPath = () => configPathFor()
  const auditPath = () => auditLogPathFor()

  /* ------------------------------------------------------------------ 配置 */

  /** 最后一次成功解析的配置文件内容（不含 composition 行配置）。 */
  let lastGoodFileConfig
  /** 是否成功读到过配置文件。 */
  let sawFile = false
  /** 本次「文件消失」是否已经告警并回写过，避免每 5 秒刷一次日志。 */
  let missingHandled = false
  let wroteDefaultFile = false
  const rowHasCrashList = rowConfig !== null && typeof rowConfig === 'object' && 'crash_plugin' in rowConfig
  /** 配置读取过程中发生的降级事件，等 config() 拿到生效配置后写进审计日志。 */
  const pendingNotices = new Set()
  /** 已经告警/审计过的降级事件（每实例只吵一次）。 */
  const reportedNotices = new Set()
  const note = (text) => pendingNotices.add(text)

  function defaultFileContent() {
    return {
      _readme:
        '把 example-plugin 改成你要禁止的插件名（包名或 loader 行 id 都行，支持 * 通配）。' +
        '检测到即崩溃：这份文件相当于 allcrash 的 config/allcrash-common.toml。改动会被下一次扫描读到，无需重启。',
      _encoding: 'UTF-8（无 BOM 也能读；写入时用 \\n 换行，Windows 记事本/VS Code/编辑器均可读）',
      _keys: Object.keys(DEFAULT_CONFIG),
      ...DEFAULT_CONFIG,
    }
  }

  function writeConfigFile(path, value, reason) {
    try {
      mkdirSync(parentDirOf(path), { recursive: true })
      writeFileSync(path, JSON.stringify(value ?? defaultFileContent(), null, 2) + '\n', 'utf8')
      log(`${reason}：`, path)
      return true
    } catch (error) {
      const detail = message(error)
      warn('配置文件写入失败：', detail)
      note(`config-write-failed path=${path} error=${detail}`)
      return false
    }
  }

  /**
   * 读取配置文件。
   *
   * 三个刻意的行为，都是为了「删掉配置就等于关掉守卫」这类绕过不成立：
   *   - 不缓存：每次扫描都重新读。mtime/size 之类的缓存会在时间戳精度低、
   *     或时间戳更新滞后的文件系统（HFS+、网络盘、同步盘）上漏掉用户的修改，
   *     表现为「改了配置不生效」。文件很小，读取代价可以忽略。
   *   - 删文件 = fail-closed：曾经读到过文件、之后文件消失时，**沿用上一次的有效名单**
   *     并把它写回去，而不是退回默认的占位符名单。要停用守卫请显式写 `"crash_plugin": []`。
   *   - 解析失败同样沿用上一次的有效配置（不改写用户正在编辑的文件）。
   */
  function readConfigFile() {
    const path = configPath()
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        if (!sawFile && !wroteDefaultFile && !rowHasCrashList) {
          // 首次运行：像原型一样生成默认配置文件；行内已给出名单时不生成，避免两份真源打架
          wroteDefaultFile = writeConfigFile(path, defaultFileContent(), '已生成默认配置')
        } else if ((sawFile || wroteDefaultFile) && !missingHandled) {
          // 曾经读到过/生成过名单、现在文件没了：fail-closed ——
          // 沿用上一次的有效配置并回写，否则「删掉配置文件」就等于关掉守卫
          missingHandled = true
          warn('配置文件已不存在：按上一次的有效配置继续执行并回写该文件；要停用守卫请把 crash_plugin 设为 []')
          note(`config-missing-rewritten path=${path}`)
          writeConfigFile(path, lastGoodFileConfig, '已回写配置')
        }
        return lastGoodFileConfig
      }
      const detail = message(error)
      warn('配置读取失败，沿用上一次的有效配置：', detail)
      note(`config-unreadable path=${path} error=${detail}`)
      return lastGoodFileConfig
    }
    try {
      const parsed = parseConfigText(text)
      lastGoodFileConfig = parsed
      sawFile = true
      missingHandled = false
      return parsed
    } catch (error) {
      const detail = message(error)
      warn('配置解析失败，沿用上一次的有效配置：', detail)
      note(`config-invalid path=${path} error=${detail}`)
      return lastGoodFileConfig
    }
  }

  /** @type {Set<string>} 运行时学到的自身行 id（行 id 不一定等于 patch 里写的） */
  const learnedSelfEntryIds = new Set()
  /** 上一次已经告警过的配置问题，避免重复刷屏 */
  let lastProblems = ''

  function config() {
    const merged = mergeConfig(rowConfig, readConfigFile())
    // 配置类型错误：同一组问题只吵一次
    const problems = merged.problems ?? []
    const key = problems.join('|')
    if (key !== lastProblems) {
      lastProblems = key
      for (const problem of problems) {
        warn('配置告警：', problem)
        if (!reportedNotices.has(problem)) {
          reportedNotices.add(problem)
          audit(`config-problem ${problem}`, merged)
        }
      }
    }
    // 读取/回写过程中的降级事件（解析失败、文件消失、写入失败…）：每实例只记一次。
    // 这些必须同时进 logger 与审计日志 —— 否则「改了配置却没生效」会完全无迹可查。
    if (pendingNotices.size > 0) {
      for (const notice of pendingNotices) {
        if (reportedNotices.has(notice)) continue
        reportedNotices.add(notice)
        warn('配置降级：', notice)
        audit(`config-notice ${notice}`, merged)
      }
      pendingNotices.clear()
    }
    return merged
  }

  /** 交给 classifyManagerCall 的配置：补上运行时学到的自身行 id。 */
  function configForToolGuard() {
    const base = config()
    if (learnedSelfEntryIds.size === 0) return base
    return { ...base, self_entry_ids: [...base.self_entry_ids, ...learnedSelfEntryIds] }
  }

  /* --------------------------------------------------------------- 审计日志 */

  /**
   * 审计日志。`cfg` 必须由调用方传入（本函数绝不自己读配置，否则 config() 与
   * audit() 会互相递归）。传入已读到的配置也顺带避免同一次扫描里重复读文件。
   * @param {string} line
   * @param {any} cfg
   */
  function audit(line, cfg) {
    try {
      if (cfg === undefined || cfg.audit_log !== true) return
      const file = auditPath()
      mkdirSync(parentDirOf(file), { recursive: true })
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
      const stat = statSync(file)
      if (stat.size > REPORT_TAIL_BYTES) {
        const tail = readFileSync(file, 'utf8').split('\n').slice(-REPORT_TAIL_LINES).join('\n')
        writeFileSync(file, tail, 'utf8')
      }
    } catch {
      /* 审计日志永远不能影响判定 */
    }
  }

  /* --------------------------------------------------------- 已装版本解析
   *
   * 只在策略里真的出现了版本约束时才去读盘（见 policyNeedsVersions）。
   * 解析路径（零依赖、尽力而为）：
   *   1) 裸包名 → `<行所在目录>/node_modules/<包名>/package.json` 的 version
   *      （profile 的 node_modules 里，`link:` 依赖是指向真实目录的软链，读到的就是真版本）
   *   2) 路径 / file:// URL → 从模块文件往上找最近的 package.json
   * 读不到就返回 null：调用方按「版本不可判定」处理（fail-open + 审计），
   * 绝不猜一个版本来判定 —— 猜错的代价是 Host 启动循环。
   */

  /** @type {Map<string, string | null>} */
  const versionCache = new Map()

  function readManifestVersion(manifestPath) {
    try {
      const parsed = parseConfigText(readFileSync(manifestPath, 'utf8'))
      return typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : null
    } catch {
      return null
    }
  }

  function baseDirOf(baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl === '') return null
    try {
      const url = baseUrl.startsWith('file:') ? baseUrl : null
      const path = url === null ? baseUrl : fileURLToPath(url)
      return dirname(path)
    } catch {
      return null
    }
  }

  /** 从某个文件/目录往上找最近的 package.json（最多 4 层）。 */
  function findManifestNear(name, baseUrl) {
    let start = null
    if (/^file:/i.test(name)) {
      try {
        start = dirname(fileURLToPath(name))
      } catch {
        start = null
      }
    } else if (/^[a-z]:[\\/]/i.test(name) || name.startsWith('/') || name.startsWith('.')) {
      const base = baseDirOf(baseUrl)
      start = base === null ? null : join(base, name)
      if (start !== null && /\.(m?js|cjs|ts|json)$/i.test(start)) start = dirname(start)
    }
    if (start === null) return null
    let current = start
    for (let depth = 0; depth < 4; depth += 1) {
      const version = readManifestVersion(join(current, 'package.json'))
      if (version !== null) return version
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  }

  /**
   * 解析一行插件的已装版本。
   * @param {{moduleName?: string, baseUrl?: string}} row
   * @returns {string | null}
   */
  function resolveRowVersion(row) {
    const name = typeof row?.moduleName === 'string' ? row.moduleName : ''
    if (name === '') return null
    const key = `${name}\u0000${row?.baseUrl ?? ''}`
    if (versionCache.has(key)) return versionCache.get(key)

    let version = null
    const looksLikePath = /^file:/i.test(name) || /^[a-z]:[\\/]/i.test(name) || name.startsWith('/') || name.startsWith('.')
    if (looksLikePath) {
      version = findManifestNear(name, row?.baseUrl)
    } else {
      const base = baseDirOf(row?.baseUrl)
      if (base !== null) version = readManifestVersion(join(base, 'node_modules', name, 'package.json'))
      if (version === null) version = findManifestNear(name, row?.baseUrl)
    }
    versionCache.set(key, version)
    return version
  }

  /** 策略里有没有版本约束（没有就完全不做读盘）。 */
  function policyNeedsVersions(cfg) {
    return policyOf(cfg).some((entry) => entry.version !== null)
  }

  /** 把版本解析结果附到行上（仅在需要时）。 */
  function enrichRowsWithVersions(rows, cfg) {
    if (!policyNeedsVersions(cfg)) return rows
    return rows.map((row) => ({ ...row, version: resolveRowVersion(row) }))
  }

  /** 版本约束相关的 note（无法判定 / 不满足）→ 日志 + 审计，去重后只报一次。 */
  function reportNotes(notes, cfg) {
    for (const note of notes ?? []) {
      if (reportedNotices.has(note)) continue
      reportedNotices.add(note)
      warn('策略提示：', note)
      audit(`policy-note ${note}`, cfg)
    }
  }

  /* --------------------------------------------------- 命中后的响应（crash / warn / deny） */

  const detonator = createDetonator()

  function envFacts() {
    return {
      DSH_HOME: process.env.DSH_HOME,
      dshHomeResolved: resolveDshHome(),
      DSH_PROFILE: process.env.DSH_PROFILE,
      DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
      DSH_WEB_URL: process.env.DSH_WEB_URL,
      DSH_SESSION_ID: process.env.DSH_SESSION_ID,
      node: process.version,
      platform: process.platform,
      osRelease: osRelease(),
      arch: process.arch,
      pathSeparator: sep,
      home: safeHomedir(),
      cwd: process.cwd(),
      pid: process.pid,
    }
  }

  /**
   * 命中的统一入口：按响应模式决定「崩 / 只告警 / 交给调用方拒绝」。
   *
   * @param {{trigger: string, violations?: any[], rows?: any[], toolCall?: any, detail?: string,
   *   selfRemoval?: boolean, what?: string, pattern?: string, mode?: string}} input
   * @returns {'crash' | 'warn'} 实际采取的非拦截型响应（`deny` 由调用方在动作路径上处理）
   */
  function handleIncident(input) {
    const cfgNow = config()
    const violations = Array.isArray(input.violations) ? input.violations : []
    const response = input.mode ?? resolveResponse(violations, cfgNow, { actionable: false })
    if (response === 'crash') {
      detonateIncident(input)
      return 'crash'
    }
    // warn（以及"没有可拦动作"的 deny）：只告警 + 审计 + 落一份诊断，Host 继续跑
    let incident
    try {
      incident = buildIncident(input, 'warn')
    } catch (error) {
      incident = minimalIncident(input, error)
    }
    // 去重键**不能带 trigger**：同一个违规会被 boot+0ms / boot+250ms / watchdog… 反复扫到，
    // 带上 trigger 就等于每 5 秒落一份诊断（无界增长）。按「违规身份」去重，
    // 每个不同命中只告警一次；trigger 仍然记在审计行里，能看到是什么时候发现的。
    const key = [
      incident.what,
      incident.violations
        .map((violation) => `${violation.entryId ?? ''}@${violation.version ?? ''}:${violation.pattern ?? ''}`)
        .sort()
        .join(','),
      incident.pattern ?? '',
      incident.detail ? 'detail' : '',
    ].join('|')
    if (!warnedIncidents.has(key)) {
      warnedIncidents.add(key)
      warn(`命中被禁插件（mode=${response}，未拦截 / 未崩溃）：`, incident.description)
      const path = detonator.note(incident, buildReport)
      audit(`would-crash trigger=${incident.trigger} what=${incident.what} mode=${response} matched=${incident.violations.map((v) => v.pattern).join(',') || incident.pattern || ''} diagnostic=${path ?? '<failed>'}`, cfgNow)
    }
    return response === 'deny' ? 'warn' : response
  }

  /** @type {Set<string>} 已经告警过的命中（warn 模式去重，避免每 5 秒刷一份诊断） */
  const warnedIncidents = new Set()

  /**
   * @param {{trigger: string, violations?: any[], rows?: any[], toolCall?: any, detail?: string, selfRemoval?: boolean, what?: string, pattern?: string}} input
   */
  function detonateIncident(input) {
    if (detonator.fired) return
    let incident
    try {
      incident = buildIncident(input, 'crash')
    } catch (error) {
      // 组装（读配置/取 env/写审计）本身出错也必须留下报告、也必须死：
      // 退化成只依赖 process 事实的最小 incident。
      incident = minimalIncident(input, error)
    }
    detonator.fire(incident, buildReport)
  }

  /**
   * 组装 incident。任何一步抛错都由 detonateIncident/handleIncident 兜底成 minimalIncident。
   * @param {any} input
   * @param {'crash' | 'warn'} response
   */
  function buildIncident(input, response = 'crash') {
    const cfgNow = config()
    const violations = Array.isArray(input.violations) ? input.violations : []
    // 人看的名字优先用显式给出的 what（install-log 通道），其次插件声明名
    // （spec 可能是一条 './xxx.js' 之类的路径），再其次模块名、工具调用的 target
    const toolTarget = input.toolCall?.arguments?.target
    const what =
      input.what ||
      violations[0]?.pluginName ||
      violations[0]?.moduleName ||
      (typeof toolTarget === 'string' && toolTarget) ||
      input.pattern ||
      violations[0]?.pattern ||
      'plugin'
    const stderrMessage = rickrollMessage(cfgNow, what)
    const description =
      input.detail ??
      `allcrash 在 ${input.trigger} 时检测到被禁插件：` +
        (violations.map((v) => shortName(v.pluginName || v.moduleName || v.entryId)).join(', ') || '<unknown>')
    // 工具闸门/安装日志这些通道没有 violations，命中的规则由 input.pattern 带进来
    const matched =
      violations
        .map((v) => v.pattern)
        .filter(Boolean)
        .join(',') || String(input.pattern ?? '')

    // crash 路径在这里记账；warn 路径由 handleIncident 记 `would-crash`（避免一次命中写两条）
    if (response === 'crash') audit(`CRASH trigger=${input.trigger} what=${what} matched=${matched}`, cfgNow)
    return {
      // 组装时就有 `time`，warn 模式下诊断文件里的时间才是命中时刻
      response,
      time: new Date(),
      trigger: input.trigger,
      violations,
      rows: Array.isArray(input.rows) ? input.rows : [],
      toolCall: input.toolCall,
      detail: input.detail,
      selfRemoval: input.selfRemoval === true,
      pattern: input.pattern,
      config: cfgNow,
      configPath: configPath(),
      pluginVersion,
      env: envFacts(),
      headline: 'allcrash 检测到被禁止的插件 / forbidden plugin detected',
      description,
      what,
      stderrMessage,
      stack: new Error(stderrMessage).stack,
    }
  }

  /** 组装失败时的兜底 incident：只依赖 process 事实，不再碰配置/服务。 */
  function minimalIncident(input, error) {
    const detail = `allcrash incident assembly failed: ${message(error)}`
    return {
      time: new Date(),
      trigger: String(input?.trigger ?? 'unknown'),
      violations: Array.isArray(input?.violations) ? input.violations : [],
      rows: [],
      config: { crash_plugin: [] },
      pluginVersion,
      env: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
      headline: 'allcrash 报告组装失败 / incident assembly failed',
      description: detail,
      what: String(input?.what ?? input?.pattern ?? 'plugin'),
      stderrMessage: detail,
      stack: error instanceof Error ? error.stack ?? error.message : String(error),
    }
  }

  /* ------------------------------------------------------------- 检测：L3 */

  let lastSignature = ''

  function scanLoader(trigger) {
    if (detonator.fired) return
    const cfgNow = config()
    const rows = enrichRowsWithVersions(readLoaderRows(ctx.get('loader')), cfgNow)
    learnSelf(rows, cfgNow)

    const signature = rows.map((row) => `${row.entryId}:${row.moduleName}:${row.enabled === false ? 0 : 1}`).join('|')
    const nonGroup = rows.filter((row) => !row.group).length
    const changed = signature !== lastSignature
    // 每次扫描都记一行：既是审计轨迹，也让「看门狗还活着」可以直接观察到
    audit(`scan trigger=${trigger} entries=${nonGroup}`, cfgNow)
    if (changed) {
      lastSignature = signature
      audit(`tree-changed trigger=${trigger} entries=${nonGroup}`, cfgNow)
      log(`插件树 ${nonGroup} 行（trigger=${trigger}）`)
    }

    const { violations, notes } = inspectLoaderRows(rows, cfgNow)
    reportNotes(notes, cfgNow)
    if (violations.length > 0) {
      // 已加载的插件没有"可拦的动作"，deny 在这里会退化为 warn（见 resolveResponse）
      handleIncident({ trigger, violations, rows })
      return
    }
    // stdout 只在启动扫描和树变化时说话，避免每 5 秒刷屏；逐次扫描的轨迹在 watch.log
    if (changed || trigger.startsWith('boot+')) {
      log(`未发现被禁插件（trigger=${trigger}，crash_plugin=${JSON.stringify(cfgNow.crash_plugin)}）`)
    }
  }

  function learnSelf(rows, cfgNow) {
    for (const row of rows) {
      if (row.group) continue
      const isSelf =
        nameMatches(row.moduleName, cfgNow.self_package) ||
        nameMatches(row.pluginName, cfgNow.self_package) ||
        cfgNow.self_entry_ids.some((pattern) => nameMatches(row.entryId, pattern) || nameMatches(row.pluginName, pattern))
      if (isSelf && row.entryId) learnedSelfEntryIds.add(row.entryId)
    }
  }

  /* ------------------------------------------------------------- 检测：L4 */

  // compositionInventory() 要读一遍活跃 preset，比扫 loader 树贵得多，
  // 所以看门狗这条路上给它加节流；事件与启动扫描是强制的。
  const PRESET_SCAN_MIN_INTERVAL_MS = 30_000
  let lastPresetScanAt = 0
  /** 同一条 preset 扫描不允许并发：install-state 会按阶段连发多次事件 */
  let presetScanInFlight = false

  function scanPresets(trigger, force = false) {
    if (detonator.fired || presetScanInFlight) return
    const presets = ctx.get('agentPresets')
    if (presets === undefined || typeof presets.compositionInventory !== 'function') return
    const now = Date.now()
    if (!force && now - lastPresetScanAt < PRESET_SCAN_MIN_INTERVAL_MS) return
    lastPresetScanAt = now
    presetScanInFlight = true
    let crashPath = false
    Promise.resolve()
      .then(() => presets.compositionInventory())
      .then(
        (compositions) => {
          if (detonator.fired) return
          const cfgNow = config()
          const rows = enrichRowsWithVersions(readLoaderRows(ctx.get('loader')), cfgNow)
          const { violations, notes } = inspectPresetCompositions(compositions, cfgNow)
          reportNotes(notes, cfgNow)
          if (violations.length > 0) {
            // 预设行同样没有"可拦的动作"：deny 退化为 warn
            crashPath = handleIncident({ trigger: `${trigger}:agent-preset`, violations, rows }) === 'crash'
          }
        },
        (error) => warn('预设扫描失败：', message(error)),
      )
      .catch((error) => {
        // 组装/引爆过程抛错也不能变成「无报告的假崩溃」：命中过就抛到下一个 tick 交给 fail-loud
        warn('预设扫描异常：', message(error))
        if (crashPath) {
          process.nextTick(() => {
            throw error
          })
        }
      })
      .then(
        () => {
          presetScanInFlight = false
        },
        () => {
          presetScanInFlight = false
        },
      )
  }

  /* ------------------------------------------------------- 检测：L1 工具闸门 */

  try {
    ctx.on('tools/pre-execute', (exec, next) => {
      // 这次命中是否会造成崩溃（决定出错时是"异步重抛"还是"拒绝")
      let crashPath = false
      let denied = false
      try {
        if (!detonator.fired && exec !== null && typeof exec === 'object') {
          // ToolExecutionInput 的字段名是 `arguments`（不是 args），两个都兼容
          const args = /** @type {any} */ (exec).arguments ?? /** @type {any} */ (exec).args
          const cfgNow = configForToolGuard()
          const rows = enrichRowsWithVersions(readLoaderRows(ctx.get('loader')), cfgNow)
          // set_plugin 的 target 是行 id；把它解析回真实模块名与已装版本，行 id 与包名不一致也能命中
          const resolver = {
            moduleNameOf: (entryId) => {
              const found = rows.find((row) => row.entryId === entryId)
              if (found === undefined) return undefined
              return found.moduleName || found.pluginName || undefined
            },
            versionOf: (key) => {
              const found = rows.find((row) => row.entryId === key || row.moduleName === key)
              if (found !== undefined) return found.version ?? null
              return resolveRowVersion({ moduleName: key, baseUrl: ctx.baseUrl })
            },
          }
          const classification = classifyManagerCall(/** @type {any} */ (exec).name, args, cfgNow, resolver)
          reportNotes(classification.notes, cfgNow)
          const hit = classification.hit
          if (hit !== undefined) {
            // 安装/启用/拆守卫都是**可拦截的动作**：deny 在这里是严格优于崩溃的选择
            const response = resolveResponse([{ mode: hit.mode }], cfgNow, { actionable: true })
            const incidentInput = {
              trigger: `tools/pre-execute:${hit.kind}`,
              violations: [],
              rows,
              toolCall: { tool: /** @type {any} */ (exec).name, arguments: args },
              detail: hit.detail,
              pattern: hit.pattern,
              selfRemoval: hit.kind === 'self-removal',
            }
            if (response === 'deny') {
              denied = true
              const reason =
                `allcrash 拒绝该操作：${hit.detail}。` +
                `规则来自 ${configPath()}（mode=${response}）。` +
                `${hit.entry?.reason ? `原因：${hit.entry.reason}。` : ''}` +
                '请改用未被禁止的方案；要放行请让操作者修改那份配置。'
              warn('工具闸门已拒绝该操作（Host 保持存活）：', hit.detail)
              audit(`DENY trigger=${incidentInput.trigger} what=${hit.target} matched=${hit.pattern ?? ''} action=${hit.action ?? ''}`, cfgNow)
              return { kind: 'deny', reason }
            }
            if (response === 'warn') {
              // dry-run：只记录，真的放行 —— 这正是"先试名单再上膛"的用法
              handleIncident({ ...incidentInput, mode: 'warn' })
              return next()
            }
            crashPath = true
            handleIncident({ ...incidentInput, mode: 'crash' })
            // 关键：命中且走崩溃路径时**不**把 next() 交回去。进程马上会被 fail-loud 打死；
            // 万一没打死，这里也宁可让这次调用永久挂住（3 秒后兜底 exit(1)），
            // 绝不给被禁的安装/启用/拆除任何继续执行的机会。
            warn('工具闸门已触发，不再交回 next()：被禁操作不得继续')
            return new Promise(() => {})
          }
        }
      } catch (error) {
        warn('pre-execute 判定失败：', message(error))
        if (crashPath) {
          // 引爆流程本身出错，同样绝不放行：抛到下一个 tick 交给 fail-loud
          // （未装 fail-loud 时，Node 对未捕获异常也会以非 0 退出码终止进程）
          process.nextTick(() => {
            throw error
          })
          return new Promise(() => {})
        }
        if (denied) {
          // 拒绝路径出错也不能变成放行：给一个保守的拒绝理由（仍然不崩 Host）
          return { kind: 'deny', reason: `allcrash: 判定过程出错，拒绝该操作以免放行被禁插件（${message(error)}）` }
        }
      }
      // waterfall：非命中路径必须把 next() 交回去，否则整条工具链停摆
      return next()
    })
    log('已挂载 L1 工具闸门：tools/pre-execute')
  } catch (error) {
    warn('无法监听 tools/pre-execute：', message(error))
  }

  /* ------------------------------------------------------- 检测：L2 管理器事件 */

  for (const event of ['plugin-manager/changed', 'app-boot/config-reload', 'hmr/reload', 'plugin-manager/install-state']) {
    try {
      ctx.on(event, () => {
        scanLoader(event)
        scanPresets(event, true)
      })
    } catch (error) {
      warn(`无法监听 ${event}：`, message(error))
    }
  }

  try {
    ctx.on('plugin-manager/install-log', (chunk) => {
      try {
        if (detonator.fired) return
        const cfgNow = config()
        const classification = classifyInstallLog(chunk, cfgNow)
        reportNotes(classification.notes, cfgNow)
        const hit = classification.hit
        if (hit !== undefined) {
          // 安装日志出手时 pnpm 已经跑起来了：这里**没有**可拦的动作（deny 无意义），
          // 所以按 resolveResponse 的规则，deny 会退化为 warn。
          handleIncident({
            trigger: 'plugin-manager/install-log',
            violations: [],
            rows: enrichRowsWithVersions(readLoaderRows(ctx.get('loader')), cfgNow),
            detail: hit.detail,
            what: hit.pattern,
            pattern: hit.pattern,
            mode: hit.mode,
          })
        }
      } catch (error) {
        warn('install-log 判定失败：', message(error))
      }
    })
  } catch (error) {
    warn('无法监听 plugin-manager/install-log：', message(error))
  }

  /* ----------------------------------------------------------- 看门狗启动 */

  try {
    ctx.effect(() => {
      // 自排程的 timeout 链，而不是 setInterval：这样每一次 tick 都重新读取配置，
      // `watch_interval_ms` 的改动同样「下一次扫描生效」，与文档承诺一致。
      let stopped = false
      /** @type {any} */
      let watchdog
      const schedule = (delay) => {
        if (stopped) return
        watchdog = setTimeout(tick, delay)
      }
      const tick = () => {
        if (stopped) return
        scanLoader('watchdog')
        scanPresets('watchdog')
        schedule(Math.max(250, config().watch_interval_ms))
      }
      const bootTimers = [0, 250, 1000].map((delay) =>
        setTimeout(() => {
          scanLoader(`boot+${delay}ms`)
          scanPresets(`boot+${delay}ms`, true)
        }, delay),
      )
      schedule(Math.max(250, config().watch_interval_ms))
      return () => {
        stopped = true
        clearTimeout(watchdog)
        for (const timer of bootTimers) clearTimeout(timer)
      }
    }, 'allcrash watchdog')
    log(`看门狗已启动：boot 后 0/250/1000ms 各扫一次，之后每 ${Math.max(250, config().watch_interval_ms)}ms 一次`)
  } catch (error) {
    warn('看门狗启动失败：', message(error))
  }

  log(`allcrash ${pluginVersion} 就绪；配置文件 ${configPath()}；crash_plugin=${JSON.stringify(config().crash_plugin)}`)
  // 跨平台告警：DSH 只用 trim 判断 $DSH_HOME 是否设置、值本身原样 resolve，
  // 所以带首尾空白的写法（从 shell/剪贴板粘来的常见笔误）会变成一个奇怪的小径。
  // 两者必须一致，这里只提醒，不擅自纠正。
  const rawHome = process.env.DSH_HOME
  if (typeof rawHome === 'string' && rawHome.trim() !== rawHome) {
    warn('$DSH_HOME 首尾含空白，DSH 会原样当路径解析 —— 请检查环境变量：', JSON.stringify(rawHome))
  }
  log(wroteDefaultFile ? '本轮已生成默认配置文件（占位名单，不会触发崩溃）' : '配置文件已存在，沿用其中的名单')
}

export default { name, inject, apply }
