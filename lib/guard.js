// @ts-check
/*
 * dsh-plugin-allcrash —— 判定层（纯逻辑，零依赖，可离线测试）
 *
 * 对照原型 https://github.com/mingzi94387355/allcrash （Minecraft Forge 1.20.1）：
 *
 *   原型                                    本插件
 *   ────────────────────────────────────    ────────────────────────────────────────
 *   Config.crash_mod = ["examplemod"]        config.crash_plugin = ["example-plugin"]
 *   ModList.get().isLoaded(name)             ctx.loader.entries() + 预设 composition 行
 *   throw new RuntimeException(一句歌词)      fail-loud 捕获 → exit(1) + 崩溃报告
 *   服务端 ConfigSyncPacket / AckPacket      本机三条检测通道（工具拦截/事件/看门狗）
 *
 * 本文件只做「判定」，不碰任何 I/O、不依赖任何 @deepseek-ai 包。
 * 崩溃（写报告、stderr、抛出、兜底退出）全部在 detonate.js。
 * 接线（ctx.on / ctx.effect）全部在 plugin.js —— 这样判定逻辑可以用
 * `node --test` 在没有 Harness 的情况下跑。
 */

/** 默认配置。首次运行时会在 ${DSH_HOME}/allcrash.json 落盘同样内容。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 禁止出现的插件名列表（照抄原型的 crash_mod）。支持 `*` / `?` 通配。 */
  crash_plugin: Object.freeze(['example-plugin']),
  /** 崩溃信息里那句歌词（原型原文）。 */
  crash_message: 'Never gonna give you up, never gonna let you down, Never gonna run around and desert you.',
  /** 通过 plugin_manager 工具安装被禁插件时，在 pnpm 启动前立刻崩溃。 */
  crash_on_install_attempt: true,
  /** 监听 pnpm 输出发现被禁插件名时崩溃（覆盖市场/CLI 安装通道，见 README 风险说明）。 */
  crash_on_install_log: false,
  /** 禁止通过 plugin_manager 关停/卸载本插件自身（原型的「踢出未回执客户端」对应物）。 */
  guard_self_removal: true,
  /** 本插件自身的 loader 行 id / 包名。 */
  self_entry_ids: Object.freeze(['allcrash']),
  self_package: 'dsh-plugin-allcrash',
  /** 看门狗扫描间隔（毫秒）。每一次扫描都会重新读取配置文件。 */
  watch_interval_ms: 5000,
  /** 行存在但被 `disabled` 的行是否也算命中（原型只看「已加载」，故默认 false）。 */
  include_disabled: false,
  /** 是否写 ${DSH_HOME}/.allcrash/watch.log 审计日志。 */
  audit_log: true,
})

/** 已安装 spec 的前缀，剥掉后保留包名/路径。 */
const SPEC_PREFIXES = ['link:', 'file:', 'workspace:', 'portal:', 'patch:', 'npm:', 'pnpm:', 'yarn:', 'git:', 'github:', 'bitbucket:', 'gitlab:']

/** 路径片段里不作为候选名的噪音（避免 crash_plugin=["lib"] 这类误伤）。 */
const SEGMENT_STOPLIST = new Set(['lib', 'src', 'dist', 'index', 'index.js', 'main.js', 'node_modules', 'file', 'http', 'https'])

/** 任意平台的分隔符：Windows 的 `\` 与 POSIX 的 `/` 都要认。 */
const SEPARATOR_RE = /[\\/]/

/** `file://` URL 里的 `%20`（macOS/Linux 路径常带空格）要能还原成真实路径。 */
function decodeUriSafely(value) {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 把一个名字（包名 / 安装 spec / 文件 URL / 相对路径 / loader 行 id）展开成
 * 一组小写候选名。判定用「任一候选命中任一模式」。
 *
 * 跨平台：`C:\x\pkg`、`/Users/me/pkg`、`\\server\share\pkg`、`link:D:\x\pkg`、
 * `file:///Users/me/My%20Plugins/pkg` 都要能还原出 `pkg`。
 *
 * 例：
 *   `@Scope/Pkg@1.2.3`            → @scope/pkg
 *   `link:E:/dsh-love_for_llm`    → link:e:/dsh-love_for_llm, e:/dsh-love_for_llm, dsh-love_for_llm
 *   `link:D:\dsh-crash\evil`      → …\evil, evil
 *   `github:user/repo#v1`         → github:user/repo#v1, user/repo#v1, repo#v1, repo
 *   `../dsh-plugin-allcrash/lib/index.js` → 该路径 + dsh-plugin-allcrash
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function candidatesOf(raw) {
  const out = new Set()
  if (typeof raw !== 'string') return []

  const push = (value) => {
    if (typeof value !== 'string') return
    let text = value.trim().replace(/^['"]+|['"]+$/g, '').replace(/[\\/]+$/, '')
    if (!text) return
    text = text.toLowerCase()
    const decoded = decodeUriSafely(text)
    for (const form of decoded === text ? [text] : [text, decoded]) {
      if (!form) continue
      out.add(form)
      // git 地址 / 目录名的 `.git` 后缀要能还原
      if (form.endsWith('.git') && form.length > 4) out.add(form.slice(0, -4))
      // 同一条路径的两种分隔符写法都进候选：配置里手写/粘贴的路径风格未必与 loader 里的一致
      // （profile YAML 里常见 `E:/x/y`，而 Node 的 path.join 在 Windows 上给出 `E:\x\y`）
      if (SEPARATOR_RE.test(form)) {
        const forward = form.replace(/\\/g, '/')
        const backward = form.replace(/\//g, '\\')
        if (forward !== form) out.add(forward)
        if (backward !== form) out.add(backward)
      }
    }
  }

  const stripVersion = (value) => {
    // @scope/pkg@1.2.3 → @scope/pkg ; pkg@1.2.3 → pkg ; 无 @ 版本段则原样返回
    const match = /^(@[^/@]+\/[^@]+|[^@/][^@]*)@[^@]+$/.exec(value)
    return match ? match[1] : value
  }

  push(raw)
  push(stripVersion(String(raw).trim().replace(/^['"]+|['"]+$/g, '')))

  // 剥掉显式前缀
  let rest = String(raw).trim().replace(/^['"]+|['"]+$/g, '')
  const lower = rest.toLowerCase()
  for (const prefix of SPEC_PREFIXES) {
    if (lower.startsWith(prefix)) {
      rest = rest.slice(prefix.length)
      push(rest)
      push(stripVersion(rest))
      break
    }
  }

  // URL / SCP 形式
  const urlLike = rest.replace(/^(git\+)?(https?|ssh|git|ftp):\/\//i, '').replace(/^git@/i, '')
  if (urlLike !== rest) {
    push(urlLike)
    const hostless = urlLike.replace(/^[^/]+\//, '') // 去掉主机名
    push(hostless)
    push(stripVersion(hostless))
  }

  // 片段/查询串（github:user/repo#v1）
  for (const value of [...out]) {
    const hashless = value.split('#')[0].split('?')[0]
    if (hashless && hashless !== value) {
      push(hashless)
      push(stripVersion(hashless))
    }
  }

  // 路径片段：Windows 的反斜杠路径（`E:\a\b`）同样要拆，不能只认 `/`
  for (const value of [...out]) {
    if (!SEPARATOR_RE.test(value)) continue
    const parts = value.split(/[\\/]+/).filter(Boolean)
    for (const part of parts) {
      if (/^[a-z]:$/.test(part)) continue // 盘符 C: / E:
      if (SEGMENT_STOPLIST.has(part)) continue
      if (part.length < 2) continue
      push(part)
    }
    const last = parts[parts.length - 1]
    if (last) {
      const withoutExtension = last.replace(/\.(js|mjs|cjs|ts|json|ya?ml)$/, '')
      // 同一份停用词表：`index.js` 去掉扩展名后是 `index`，同样是噪音
      if (!SEGMENT_STOPLIST.has(withoutExtension) && withoutExtension.length >= 3) push(withoutExtension)
    }
  }

  return [...out]
}

/**
 * glob（`*` 匹配任意长度、`?` 匹配单字符）匹配，大小写由调用方先统一。
 *
 * 这里刻意**不用正则**：把 `*` 翻成 `.*` 之后，`*a*a*a*a*a*a*b` 这类
 * 用户自己写出来的模式在某些输入上会发生灾难性回溯，表现是 Host 事件循环被卡死 ——
 * 对守卫来说「卡死」比「崩溃」糟得多（既不崩也不报警）。两指针算法最坏 O(n·m)，无回溯。
 *
 * @param {string} text 已小写
 * @param {string} pattern 已小写
 * @returns {boolean}
 */
export function globMatches(text, pattern) {
  let t = 0
  let p = 0
  let starPattern = -1
  let starText = -1
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      t += 1
      p += 1
      continue
    }
    if (p < pattern.length && pattern[p] === '*') {
      starPattern = p
      starText = t
      p += 1
      continue
    }
    if (starPattern >= 0) {
      p = starPattern + 1
      starText += 1
      t = starText
      continue
    }
    return false
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

/**
 * 一个名字（或行 id）是否命中某个模式。
 * @param {unknown} raw 被检查的名字
 * @param {string} pattern 配置里的模式
 * @returns {boolean}
 */
export function nameMatches(raw, pattern) {
  const needle = String(pattern ?? '').trim().replace(/^['"]+|['"]+$/g, '').toLowerCase()
  if (!needle) return false
  for (const candidate of candidatesOf(raw)) {
    if (candidate === needle || globMatches(candidate, needle)) return true
  }
  return false
}

/**
 * 一组名字里第一个命中的模式。
 * @param {unknown[]} raws
 * @param {string[]} patterns
 * @returns {string | undefined}
 */
export function firstMatch(raws, patterns) {
  for (const pattern of patterns ?? []) {
    for (const raw of raws ?? []) {
      if (nameMatches(raw, pattern)) return String(pattern)
    }
  }
  return undefined
}

/** FiberState → phase（与 @deepseek-ai/dsh-host-plugin-inventory 的投影一致）。 */
const FIBER_PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' }

/**
 * 把 loader 实例摊平成可判定的行数组。任何一步失败都只影响那一行。
 *
 * 注意：`options.name` 是**模块标识符**（包名，或 profile 里写的那条路径/spec），
 * 不等于插件自己声明的名字。所以这里额外读 `fiber.runtime.name`（插件声明名），
 * 两者都作为候选 —— 用户在 crash_plugin 里写哪一个都应当能命中。
 * @param {any} loader
 * @returns {{entryId: string, moduleName: string, pluginName: string, enabled: boolean, phase: string | null, group: boolean, baseUrl?: string}[]}
 */
export function readLoaderRows(loader) {
  const rows = []
  if (loader === undefined || loader === null || typeof loader.entries !== 'function') return rows
  let iterator
  try {
    iterator = loader.entries()
  } catch {
    return rows
  }
  try {
    for (const entry of iterator) {
      try {
        const options = entry?.options ?? {}
        const group = Boolean(options.group)
        let enabled = true
        try {
          enabled = !entry.disabled
        } catch {
          enabled = true
        }
        const state = entry?.fiber?.state
        rows.push({
          entryId: String(entry?.id ?? options.id ?? ''),
          moduleName: String(options.name ?? ''),
          pluginName: String(entry?.fiber?.runtime?.name ?? ''),
          enabled,
          phase: typeof state === 'number' ? (FIBER_PHASE[state] ?? null) : null,
          group,
          baseUrl: entry?.parent?.tree?.ctx?.baseUrl,
        })
      } catch {
        /* 单行读取失败不影响其它行 */
      }
    }
  } catch {
    /* 迭代中断：返回已读到的部分 */
  }
  return rows
}

/**
 * 判定 loader 行里的违规项。
 * @param {ReturnType<typeof readLoaderRows>} rows
 * @param {{crash_plugin?: string[], include_disabled?: boolean}} config
 * @returns {{entryId: string, moduleName: string, pluginName?: string, phase: string | null, enabled: boolean, pattern: string}[]}
 */
export function inspectLoaderRows(rows, config = {}) {
  const patterns = arrayOfStrings(config.crash_plugin)
  const includeDisabled = Boolean(config.include_disabled)
  const violations = []
  for (const row of rows ?? []) {
    if (row?.group) continue
    if (!includeDisabled && row?.enabled === false) continue
    const pattern = firstMatch([row?.moduleName, row?.entryId, row?.pluginName], patterns)
    if (pattern === undefined) continue
    violations.push({
      entryId: String(row.entryId ?? ''),
      moduleName: String(row.moduleName ?? ''),
      pluginName: row.pluginName ? String(row.pluginName) : undefined,
      phase: row.phase ?? null,
      enabled: row.enabled !== false,
      pattern,
    })
  }
  return violations
}

/**
 * 判定 agent-preset composition 里的行（这些行不在 loader 树上）。
 *
 * 行的真实形状见 `AgentPresetCompositionRow`（@deepseek-ai/dsh-agent-preset-registry）：
 * `{ entryId: string | null, moduleName, enabled: boolean | 'conditional', condition?, fiberState? }`。
 * 注意 `enabled` 可能是 `'conditional'`（该行由 `!!js` 表达式决定），此时按「可能被加载」处理 ——
 * 对守卫而言条件启用同样是风险面，但要把 condition 写进报告，让用户知道为什么崩。
 *
 * @param {any[]} compositions agentPresets.compositionInventory() 的结果
 * @param {{crash_plugin?: string[], include_disabled?: boolean}} config
 */
export function inspectPresetCompositions(compositions, config = {}) {
  const patterns = arrayOfStrings(config.crash_plugin)
  const includeDisabled = Boolean(config.include_disabled)
  const violations = []
  for (const composition of compositions ?? []) {
    for (const row of composition?.rows ?? []) {
      // 与 loader 通道同一条语义：被关掉的行不算「已加载」
      if (row?.enabled === false && !includeDisabled) continue
      const pattern = firstMatch([row?.moduleName, row?.entryId], patterns)
      if (pattern === undefined) continue
      violations.push({
        entryId: row?.entryId === null || row?.entryId === undefined ? '' : String(row.entryId),
        moduleName: String(row?.moduleName ?? ''),
        phase: typeof row?.fiberState === 'number' ? (FIBER_PHASE[row.fiberState] ?? null) : null,
        enabled: row?.enabled !== false,
        pattern,
        preset: composition?.id ?? composition?.name,
        condition: typeof row?.condition === 'string' ? row.condition : undefined,
      })
    }
  }
  return violations
}

/**
 * 判定一次 plugin_manager 工具调用 —— 「不允许被安装」的最前置闸门。
 * 该判定发生在工具真正执行之前（tools/pre-execute），因此 pnpm 尚未启动，
 * profile 尚未被改动，崩溃是干净的。
 *
 * @param {unknown} toolName
 * @param {unknown} args
 * @param {any} config
 * @param {{moduleNameOf?: (entryId: string) => string | undefined}} [resolver]
 *   `set_plugin` 的 target 是 loader 行 id，未必等于包名（例如行 id 叫 `bundle-dshmarket`、
 *   包名才叫 `dshmarket`）。给出 resolver 时，行 id 会先解析成真实模块名再一起比对。
 * @returns {{kind: 'install-attempt' | 'enable-attempt' | 'self-removal', target: string, pattern?: string, action?: string, detail: string} | undefined}
 */
export function classifyManagerCall(toolName, args, config = {}, resolver = {}) {
  if (toolName !== 'plugin_manager') return undefined
  if (args === null || typeof args !== 'object') return undefined

  const action = typeof (/** @type {any} */ (args).action) === 'string' ? /** @type {any} */ (args).action : ''
  const target = typeof (/** @type {any} */ (args).target) === 'string' ? /** @type {any} */ (args).target : ''
  const enabled = /** @type {any} */ (args).enabled
  const patterns = arrayOfStrings(config.crash_plugin)
  const selfPatterns = [...arrayOfStrings(config.self_entry_ids), String(config.self_package ?? '')].filter(Boolean)

  if (!target) return undefined

  // 1) 安装尝试：target 是包 spec
  if (action === 'install_bundle' && config.crash_on_install_attempt !== false) {
    const pattern = firstMatch([target], patterns)
    if (pattern !== undefined) {
      return {
        kind: 'install-attempt',
        target,
        pattern,
        action,
        detail: `plugin_manager install_bundle 试图安装被禁插件 ${JSON.stringify(target)}（命中模式 ${JSON.stringify(pattern)}）`,
      }
    }
    return undefined
  }

  // 2) 启用尝试：set_bundle / set_plugin / set_version_exemption 且 enabled=true
  //    （set_version_exemption 本身不安装任何东西，但它是「放行一个本来装不上的包」的前置动作，
  //      与安装闸门同属一类，一起拦掉）
  if ((action === 'set_bundle' || action === 'set_plugin' || action === 'set_version_exemption') && enabled === true) {
    const raws = [target]
    if (action === 'set_plugin' && typeof resolver.moduleNameOf === 'function') {
      try {
        const moduleName = resolver.moduleNameOf(target)
        if (typeof moduleName === 'string' && moduleName) raws.push(moduleName)
      } catch {
        /* resolver 失败只影响这一条候选 */
      }
    }
    const pattern = firstMatch(raws, patterns)
    if (pattern !== undefined) {
      return {
        kind: 'enable-attempt',
        target,
        pattern,
        action,
        detail: `plugin_manager ${action} 试图启用被禁插件 ${JSON.stringify(target)}（命中模式 ${JSON.stringify(pattern)}）`,
      }
    }
    return undefined
  }

  // 3) 拆除守卫自身：关停/卸载本插件 —— 原型里「不回执就踢出」的对应物
  if (config.guard_self_removal !== false) {
    const selfHit = firstMatch([target], selfPatterns)
    if (selfHit !== undefined) {
      const disabling = (action === 'set_plugin' || action === 'set_bundle') && enabled === false
      const removing = action === 'remove_bundle'
      if (disabling || removing) {
        return {
          kind: 'self-removal',
          target,
          pattern: selfHit,
          action,
          detail: `plugin_manager ${action} 试图关停/卸载 allcrash 守卫自身（${JSON.stringify(target)}）`,
        }
      }
    }
  }

  return undefined
}

/**
 * 从一行 pnpm 输出里找被禁插件名（仅当 crash_on_install_log 打开时使用）。
 *
 * 匹配规则是「名字边界 + 通配」：`*` / `?` 只吃名字字符（`[\w@/.-]`），
 * 因此 `dsh-plugin-wallpaper-*` 能命中 `+ dsh-plugin-wallpaper-engine 1.0.0`，
 * 而 `dshmarket` 不会误命中 `dshmarketplace`。
 * @param {unknown} chunk
 * @param {any} config
 */
export function classifyInstallLog(chunk, config = {}) {
  if (config.crash_on_install_log !== true) return undefined
  const patterns = arrayOfStrings(config.crash_plugin)
  if (patterns.length === 0) return undefined
  const text = collectStrings(chunk).join('\n')
  if (!text) return undefined
  for (const pattern of patterns) {
    // 纯通配（`*`、`?`）定位不到具体包，跳过
    if (String(pattern).replace(/[*?]/g, '').trim() === '') continue
    if (installLogPatternToRegExp(pattern).test(text)) {
      return { kind: 'install-log', pattern: String(pattern), detail: `pnpm 输出中出现被禁插件名 ${JSON.stringify(pattern)}` }
    }
  }
  return undefined
}

/** @param {unknown} pattern */
function installLogPatternToRegExp(pattern) {
  const escaped = escapeRegExp(String(pattern))
  const body = escaped.replace(/\\\*/g, '[\\w@/.-]*').replace(/\\\?/g, '[\\w@/.-]')
  return new RegExp(`(^|[^\\w@/.-])${body}([^\\w@/.-]|$)`, 'i')
}

/** 收集任意结构里的字符串（用于 install-log chunk 的形状不确定）。 */
function collectStrings(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1))
  if (typeof value === 'object') {
    const out = []
    for (const item of Object.values(value)) out.push(...collectStrings(item, depth + 1))
    return out
  }
  return []
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 只保留字符串数组；其它类型忽略（配置容错）。 */
export function arrayOfStrings(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/**
 * 把模块标识符压成适合人读的短名。
 *
 * 跨平台背景：profile 里手工挂的行、以及本插件自己的行，`options.name` 可能是
 * 一条长路径或 `file://` URL（Windows 上还带盘符、POSIX 上可能带 %20），
 * 直接写进崩溃信息看不清楚。包名（含 `@scope/name`）原样返回，不动。
 * @param {unknown} value
 * @returns {string}
 */
export function shortName(value) {
  if (typeof value !== 'string' || value === '') return ''
  const text = value
  const pathLike =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    text.startsWith('.') ||
    text.startsWith('/') ||
    text.includes('\\') ||
    /^[a-z]:[\\/]/i.test(text)
  if (!pathLike) return text
  const withoutScheme = decodeUriSafely(text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))
  const parts = withoutScheme.split(/[\\/]+/).filter(Boolean)
  // UNC 的主机名也不是我们想展示的
  const last = parts[parts.length - 1]
  return last && last.length > 0 ? last : text
}

/**
 * 解析配置文件文本。
 *
 * 跨平台要点：Windows 上 PowerShell 5.1 的 `Set-Content -Encoding utf8`、以及一部分
 * 编辑器会写出 **UTF-8 BOM**；`JSON.parse` 遇到 BOM 会抛 "Unexpected token \uFEFF"，
 * 结果就是「用户明明改了配置，插件却按旧值继续跑」。这里先剥 BOM 再解析。
 * @param {string} text
 * @param {any} [reviver]
 * @returns {any}
 */
export function parseConfigText(text, reviver) {
  if (typeof text !== 'string') throw new TypeError('config text must be a string')
  return JSON.parse(text.replace(/^\uFEFF/, '').trim(), reviver)
}

/**
 * 本地时间（带 UTC 偏移）。崩溃报告的 `Time:` 用 UTC，跨时区排查还需要知道
 * 用户所在时区，否则「什么时候崩的」会对不上。
 * @param {Date} date
 * @returns {string} 例：`2026-08-28 11:07:12 (UTC+08:00)`
 */
export function formatLocalTime(date) {
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    ` (UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)})`
  )
}

/**
 * 归一化配置：默认值 ← 文件 ← 行配置（后者覆盖前者）。
 *
 * 类型错误一律**保守处理**，并在返回值上附带 `problems` 供调用方告警：
 *   - `crash_plugin` 不是数组时**忽略**它（保持上一层名单），而不是当成空数组 ——
 *     后者会让一个手滑的引号把守卫悄悄关掉，对守卫来说是最糟的失败方式。
 *   - 显式的 `[]` 是合法输入，表示「确实不禁止任何插件」。
 *   - 顶层不是对象（数组/字符串等）同样忽略。
 *
 * @param {any} rowConfig
 * @param {any} fileConfig
 * @returns {any} 生效配置，附 `problems: string[]`
 */
export function mergeConfig(rowConfig, fileConfig) {
  const merged = { ...DEFAULT_CONFIG }
  /** @type {string[]} */
  const problems = []

  const apply = (source, label) => {
    if (source === undefined) return
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      problems.push(`${label} 顶层不是 JSON 对象，已忽略`)
      return
    }
    if ('crash_plugin' in source) {
      if (Array.isArray(source.crash_plugin)) merged.crash_plugin = arrayOfStrings(source.crash_plugin)
      else problems.push(`${label}.crash_plugin 不是数组，已忽略（保持上一层名单，守卫不会因此被关掉）`)
    }
    for (const key of ['crash_message', 'self_package']) {
      if (typeof source[key] === 'string' && source[key] !== '') merged[key] = source[key]
    }
    if ('self_entry_ids' in source) {
      if (Array.isArray(source.self_entry_ids)) merged.self_entry_ids = arrayOfStrings(source.self_entry_ids)
      else problems.push(`${label}.self_entry_ids 不是数组，已忽略`)
    }
    for (const key of ['crash_on_install_attempt', 'crash_on_install_log', 'guard_self_removal', 'include_disabled', 'audit_log']) {
      if (typeof source[key] === 'boolean') merged[key] = source[key]
      else if (key in source) problems.push(`${label}.${key} 不是布尔值，已忽略`)
    }
    if (source.watch_interval_ms !== undefined) {
      if (Number.isFinite(source.watch_interval_ms) && source.watch_interval_ms >= 250) {
        merged.watch_interval_ms = Math.floor(source.watch_interval_ms)
      } else {
        problems.push(`${label}.watch_interval_ms 不是 >= 250 的数字，已忽略`)
      }
    }
  }

  apply(fileConfig, '配置文件')
  apply(rowConfig, 'composition 行配置')
  merged.crash_plugin = [...merged.crash_plugin]
  merged.self_entry_ids = [...merged.self_entry_ids]
  merged.problems = problems
  return merged
}

/**
 * 生成崩溃报告正文（格式模仿 Minecraft 的 crash-reports/*.txt）。
 * @param {any} incident
 * @returns {string}
 */
export function buildReport(incident) {
  const lines = []
  const when = incident?.time instanceof Date ? incident.time : new Date()
  lines.push('---- DSH Crash Report ----')
  lines.push(`// ${incident?.headline ?? 'allcrash tripped'}`)
  lines.push('')
  lines.push(`Time: ${when.toISOString()}`)
  lines.push(`Local time: ${formatLocalTime(when)}`)
  lines.push(`Description: ${incident?.description ?? 'allcrash detected a forbidden plugin'}`)
  lines.push('')
  lines.push('Detected')
  lines.push('========')
  for (const violation of incident?.violations ?? []) {
    lines.push(
      `  - ${violation.moduleName || '<unnamed>'}${violation.pluginName ? ` [plugin name: ${violation.pluginName}]` : ''}` +
        ` (entry id: ${violation.entryId || '<none>'}, phase: ${violation.phase ?? 'n/a'}` +
        `, enabled: ${violation.enabled !== false}${violation.preset ? `, preset: ${violation.preset}` : ''}` +
        `${violation.condition ? `, condition: ${violation.condition}` : ''}, matched: ${JSON.stringify(violation.pattern)})`,
    )
  }
  if (incident?.selfRemoval === true) lines.push('  - allcrash 守卫自身被请求关停/卸载')
  if (incident?.toolCall) lines.push(`  - tool: ${incident.toolCall.tool} ${JSON.stringify(incident.toolCall.arguments ?? {})}`)
  if (incident?.detail) lines.push(`  - ${incident.detail}`)
  lines.push('')
  lines.push('Plugin tree')
  lines.push('===========')
  for (const row of incident?.rows ?? []) {
    if (row?.group) continue
    lines.push(
      `  ${row.enabled === false ? '[disabled] ' : ''}${row.entryId || '<no id>'} = ${row.moduleName || '<unnamed>'}` +
        `${row.pluginName ? ` [${row.pluginName}]` : ''} (${row.phase ?? 'n/a'})`,
    )
  }
  const omitted = (incident?.rows ?? []).filter((row) => row?.group).length
  if (omitted > 0) lines.push(`  ... ${omitted} group entr${omitted === 1 ? 'y' : 'ies'} omitted`)
  lines.push('')
  lines.push('Environment')
  lines.push('===========')
  const env = incident?.env ?? {}
  for (const key of ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_SESSION_ID']) {
    if (env[key] !== undefined) lines.push(`  ${key}=${env[key]}`)
  }
  if (env.dshHomeResolved !== undefined) lines.push(`  DSH_HOME(resolved)=${env.dshHomeResolved}`)
  // 跨平台排查需要的信息：宿主平台/版本/架构、真实家目录、cwd（相对 DSH_HOME 的解析基准）
  lines.push(`  node=${env.node ?? 'n/a'} ${env.platform ?? ''} ${env.arch ?? ''} pid=${env.pid ?? 'n/a'}`)
  if (env.osRelease !== undefined) lines.push(`  os=${env.platform ?? ''} ${env.osRelease}`)
  if (env.home !== undefined) lines.push(`  homedir=${env.home}`)
  if (env.cwd !== undefined) lines.push(`  cwd=${env.cwd}`)
  if (env.pathSeparator !== undefined) lines.push(`  path.sep=${env.pathSeparator}`)
  lines.push('')
  lines.push('allcrash')
  lines.push('=========')
  lines.push(`  version=${incident?.pluginVersion ?? 'n/a'}`)
  lines.push(`  config_file=${incident?.configPath ?? 'n/a'}`)
  lines.push(`  crash_plugin=${JSON.stringify(incident?.config?.crash_plugin ?? [])}`)
  const problems = incident?.config?.problems
  if (Array.isArray(problems) && problems.length > 0) lines.push(`  config_problems=${JSON.stringify(problems)}`)
  lines.push(`  trigger=${incident?.trigger ?? 'n/a'}`)
  lines.push('')
  lines.push('Recovery')
  lines.push('========')
  lines.push(`  1) 打开 ${incident?.configPath ?? '${DSH_HOME}/allcrash.json'}，把命中的插件名从 crash_plugin 里删掉；`)
  lines.push('  2) 或从 profile 里移除该插件（其所依赖的 bundle、cordis.patch.yml 里的行，或 agent preset 里的声明）；')
  lines.push('  3) 重启 DSH。')
  lines.push('  要整体拆除守卫：手工编辑 cordis.patch.yml 删掉 allcrash 行，并从 profile package.json 的')
  lines.push('  dsh.profile.bundles / dependencies 里删掉 dsh-plugin-allcrash —— 经 plugin_manager 操作会被再次崩掉。')
  lines.push('')
  lines.push('Stacktrace')
  lines.push('==========')
  lines.push(String(incident?.stack ?? new Error('allcrash').stack ?? 'n/a'))
  lines.push('')
  return lines.join('\n')
}

/**
 * 取 stderr 上那句「原型原文」的崩溃信息。
 * @param {any} config
 * @param {string} what
 */
export function rickrollMessage(config, what) {
  const base = String(config?.crash_message ?? DEFAULT_CONFIG.crash_message)
  return `${base}(${what} is loaded)`
}
