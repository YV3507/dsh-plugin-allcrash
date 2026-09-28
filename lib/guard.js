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
  /**
   * 禁止出现的插件。数组元素可以是：
   *   - `"evil-plugin"`                    整个插件（支持 `*` / `?` 通配）
   *   - `"dshmarket@1.66.0"`               精确版本
   *   - `"bad-plugin@<2.0.0"`              版本约束（`= > >= < <= ^ ~`，空格分隔可组合）
   *   - `{ name, version?, mode?, reason? }` 对象形式，可按条目覆盖响应模式
   */
  crash_plugin: Object.freeze(['example-plugin']),
  /**
   * 命中后的响应：
   *   - `crash`（默认）崩溃 Host（原型的语义，发行态用）
   *   - `warn`        只告警 + 审计 + 落一份诊断，不崩（编写/试名单时用）
   *   - `deny`        安装/启用/拆守卫这类**可拦截的动作**直接拒绝（Host 存活）；已加载的插件无法拦，退化为 warn
   */
  mode: 'crash',
  /** 崩溃信息里那句歌词（原型原文）。 */
  crash_message: 'Never gonna give you up, never gonna let you down, Never gonna run around and desert you.',
  /** 通过 plugin_manager 工具安装被禁插件时，在 pnpm 启动前就拦下（按 mode 决定拒绝还是崩溃）。 */
  crash_on_install_attempt: true,
  /** 监听 pnpm 输出发现被禁插件名时命中（覆盖市场/CLI 安装通道，见 README 风险说明）。 */
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

/** 响应模式，从弱到强。 */
export const RESPONSE_MODES = Object.freeze(['warn', 'deny', 'crash'])

/** 取更严格的那个响应模式（越靠后越严格）。 */
export function strictestMode(a, b) {
  const ia = RESPONSE_MODES.indexOf(a)
  const ib = RESPONSE_MODES.indexOf(b)
  if (ia < 0) return ib < 0 ? 'crash' : b
  if (ib < 0) return a
  return ia >= ib ? a : b
}

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

/* ------------------------------------------------------------------ 版本约束
 *
 * 零依赖的 semver **近似**实现：够用来写「禁止某个版本 / 某个区间」，不追求
 * 与 node-semver 逐字一致。明确的近似点（都写在这里，避免以后误以为是完整实现）：
 *   - `^1.2.3` → `>=1.2.3 <2.0.0`；`^0.2.3` → `>=0.2.3 <0.3.0`；`^0.0.3` → `>=0.0.3 <0.0.4`
 *   - `~1.2.3` → `>=1.2.3 <1.3.0`；`~1.2` → `>=1.2.0 <1.3.0`；`~1` → `>=1.0.0 <2.0.0`
 *   - 裸部分版本按 npm 的 x-range：`1.2` → `>=1.2.0 <1.3.0`，`1` → `>=1.0.0 <2.0.0`
 *   - **比较符 + 部分版本按补零处理**：`>1.2` 等价 `>1.2.0`（npm 会当 `>=1.3.0`，这里不跟）
 *   - 预发布段按 semver 排序（`1.0.0-rc.1 < 1.0.0`），但不支持 `||` 或 `-` 区间
 *   - 无法解析的约束**不会**被当成通配：返回 ok:false，由调用方按「版本无法判定」处理
 */

/** @returns {{numbers: number[], prerelease: string | null} | null} */
function parseVersionParts(text) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim())
  if (match === null) return null
  return {
    numbers: [Number(match[1]), match[2] === undefined ? 0 : Number(match[2]), match[3] === undefined ? 0 : Number(match[3])],
    prerelease: match[4] ?? null,
  }
}

/** 部分版本是否只给到第几段（1 → 0，1.2 → 1，1.2.3 → 2）。 */
function versionDepth(text) {
  const core = String(text ?? '').trim().replace(/^v/, '').split('-')[0]
  return core.split('.').length - 1
}

/**
 * 比较两个版本。无法解析时返回 null（调用方必须按「不可判定」处理，不能当成相等）。
 * @returns {-1 | 0 | 1 | null}
 */
export function compareVersions(a, b) {
  const left = parseVersionParts(a)
  const right = parseVersionParts(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  const leftParts = left.prerelease.split('.')
  const rightParts = right.prerelease.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index]
    const y = rightParts[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 解析版本约束文本，展开成若干「比较子句」（全部成立才算满足）。
 * @param {unknown} text
 * @returns {{ok: true, clauses: {op: '=' | '>' | '>=' | '<' | '<=', version: string}[]} | {ok: false, reason: string}}
 */
export function parseVersionConstraint(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: 'empty' }
  if (raw === '*' || raw.toLowerCase() === 'x' || raw.toLowerCase() === 'latest') return { ok: true, clauses: [] }
  const clauses = []
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(part)
    if (match === null) return { ok: false, reason: `无法解析 ${JSON.stringify(part)}` }
    const op = match[1] ?? '='
    const versionText = match[2].trim()
    const parts = parseVersionParts(versionText)
    if (parts === null) return { ok: false, reason: `无法解析版本 ${JSON.stringify(versionText)}` }
    const depth = versionDepth(versionText)
    const floor = `${parts.numbers[0]}.${parts.numbers[1]}.${parts.numbers[2]}${parts.prerelease === null ? '' : `-${parts.prerelease}`}`

    if (op === '^' || op === '~') {
      // 上界：`~` 只允许最小段进位，`^` 允许到下一个不兼容版本
      let upper
      if (op === '~') {
        upper = depth <= 0 ? `${parts.numbers[0] + 1}.0.0` : `${parts.numbers[0]}.${parts.numbers[1] + 1}.0`
      } else if (parts.numbers[0] !== 0) upper = `${parts.numbers[0] + 1}.0.0`
      else if (parts.numbers[1] !== 0) upper = `0.${parts.numbers[1] + 1}.0`
      else upper = `0.0.${parts.numbers[2] + 1}`
      clauses.push({ op: '>=', version: floor }, { op: '<', version: upper })
      continue
    }
    if (op === '=' && depth < 2) {
      // 裸 `1` / `1.2` 按 x-range 展开
      const upper = depth <= 0 ? `${parts.numbers[0] + 1}.0.0` : `${parts.numbers[0]}.${parts.numbers[1] + 1}.0`
      clauses.push({ op: '>=', version: floor }, { op: '<', version: upper })
      continue
    }
    clauses.push({ op, version: floor })
  }
  if (clauses.length === 0) return { ok: false, reason: '空约束' }
  return { ok: true, clauses }
}

/**
 * 判定一个**已知版本**是否满足约束。
 * @param {unknown} version
 * @param {unknown} constraint
 * @returns {{determined: true, satisfied: boolean} | {determined: false, reason: string}}
 */
export function satisfiesVersion(version, constraint) {
  const parsed = parseVersionConstraint(constraint)
  if (!parsed.ok) return { determined: false, reason: parsed.reason }
  if (parseVersionParts(version) === null) return { determined: false, reason: `无法解析已安装版本 ${JSON.stringify(version)}` }
  for (const clause of parsed.clauses) {
    const order = compareVersions(version, clause.version)
    if (order === null) return { determined: false, reason: `无法比较 ${version} 与 ${clause.version}` }
    const ok =
      clause.op === '=' ? order === 0 : clause.op === '>' ? order > 0 : clause.op === '>=' ? order >= 0 : clause.op === '<' ? order < 0 : order <= 0
    if (!ok) return { determined: true, satisfied: false }
  }
  return { determined: true, satisfied: true }
}

/**
 * 把 `@scope/pkg@1.2.3` / `pkg@<2.0.0` 拆成名字与版本约束。
 *
 * 必须**只看最后一个 `@`**：`@deepseek-ai/dsh-client-ui-chat` 里的前导 `@` 是 scope，
 * 不是版本分隔符。尾段解析不出约束时整串当名字处理（保持旧行为）并回报问题。
 * @param {unknown} raw
 */
export function splitNameVersion(raw) {
  const text = String(raw ?? '').trim()
  const at = text.lastIndexOf('@')
  if (at <= 0) return { name: text, version: null }
  const versionText = text.slice(at + 1)
  if (versionText === '') return { name: text, version: null }
  const parsed = parseVersionConstraint(versionText)
  if (!parsed.ok) {
    return { name: text, version: null, invalidVersion: versionText, invalidReason: parsed.reason }
  }
  return { name: text.slice(0, at), version: versionText }
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
 * 一组名字里第一个命中的模式（不做版本判断；用于 self 模式这类纯名字场景）。
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

/* ------------------------------------------------------------- 策略条目
 *
 * `crash_plugin` 的元素归一化成「策略条目」，判定与响应都基于它：
 *   { raw, name, version, mode, reason }
 * - `name`    名字或 glob（对模块标识符 / 行 id / 插件声明名比对）
 * - `version` 版本约束文本；null = 不看版本
 * - `mode`    该条目命中后的响应（覆盖全局 mode）
 * - `reason`  可选，写进崩溃报告与 deny 原因，便于说明"为什么要禁它"
 */

/** 校验并兜底一个响应模式。 */
export function modeOfConfig(config = {}) {
  const mode = config?.mode
  return RESPONSE_MODES.includes(mode) ? mode : 'crash'
}

/**
 * 归一化 `crash_plugin` 数组。
 * @param {unknown} value
 * @param {string} globalMode
 * @returns {{entries: any[], problems: string[]}}
 */
export function normalizePolicy(value, globalMode = 'crash') {
  const entries = []
  const problems = []
  if (value === undefined) return { entries, problems }
  if (!Array.isArray(value)) {
    problems.push('crash_plugin 不是数组，已忽略（保持上一层名单，守卫不会因此被关掉）')
    return { entries, problems }
  }
  value.forEach((raw, index) => {
    const label = `crash_plugin[${index}]`
    if (typeof raw === 'string') {
      const split = splitNameVersion(raw)
      if (split.name.trim() === '') {
        problems.push(`${label} 是空字符串，已忽略`)
        return
      }
      if (split.invalidVersion !== undefined) {
        problems.push(`${label} ${JSON.stringify(raw)} 尾部的 @${split.invalidVersion} 不是可解析的版本约束（${split.invalidReason}），已按整串名字处理`)
      }
      entries.push({ raw, name: split.name, version: split.version, mode: globalMode, reason: null })
      return
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${label} 既不是字符串也不是对象，已忽略`)
      return
    }
    const nameSource = typeof raw.name === 'string' ? raw.name : typeof raw.pattern === 'string' ? raw.pattern : ''
    if (nameSource.trim() === '') {
      problems.push(`${label} 缺少 name，已忽略`)
      return
    }
    const split = splitNameVersion(nameSource)
    const version = typeof raw.version === 'string' && raw.version.trim() !== '' ? raw.version.trim() : split.version
    if (version !== null && !parseVersionConstraint(version).ok) {
      problems.push(`${label}.version ${JSON.stringify(version)} 无法解析，该条目退化为只看名字`)
    }
    const usableVersion = version !== null && parseVersionConstraint(version).ok ? version : null
    let mode = globalMode
    if (raw.mode !== undefined) {
      if (RESPONSE_MODES.includes(raw.mode)) mode = raw.mode
      else problems.push(`${label}.mode ${JSON.stringify(raw.mode)} 不是 ${RESPONSE_MODES.join('/')} 之一，已回落到 ${globalMode}`)
    }
    entries.push({
      raw,
      name: split.name,
      version: usableVersion,
      mode,
      reason: typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason.trim() : null,
    })
  })
  return { entries, problems }
}

/** 取生效策略条目：优先用 mergeConfig 归一化好的 `config.policy`，否则现场归一化。 */
export function policyOf(config = {}) {
  if (Array.isArray(config?.policy)) return config.policy
  return normalizePolicy(config?.crash_plugin, modeOfConfig(config)).entries
}

/** 目标的名字是否命中某个条目（只看名字，不看版本）。 */
function nameHitsEntry(names, entry) {
  for (const name of names ?? []) {
    if (typeof name !== 'string' || name === '') continue
    for (const candidate of candidatesOf(name)) {
      if (candidate === entry.name || globMatches(candidate, entry.name)) return true
    }
  }
  return false
}

/**
 * 用一个策略条目判定一个目标。
 * @param {{names: unknown[], version?: string | null}} target
 * @param {any} entry
 * @returns {{outcome: 'hit' | 'no-name' | 'version-unknown' | 'version-mismatch', reason?: string}}
 */
export function testPolicyEntry(target, entry) {
  if (!nameHitsEntry(target.names, entry)) return { outcome: 'no-name' }
  if (entry.version === null) return { outcome: 'hit' }
  const installed = target.version
  if (typeof installed !== 'string' || installed.trim() === '') {
    return { outcome: 'version-unknown', reason: '未解析到已安装版本' }
  }
  const verdict = satisfiesVersion(installed, entry.version)
  if (verdict.determined !== true) return { outcome: 'version-unknown', reason: verdict.reason }
  if (verdict.satisfied === true) return { outcome: 'hit' }
  return { outcome: 'version-mismatch', reason: `已装版本 ${installed} 不满足 ${entry.version}` }
}

/**
 * 在策略里找第一个命中的条目。
 *
 * 版本约束**无法判定时不算命中**（fail-open）：版本读不到的代价是漏检一次，
 * 而误判的代价是 Host 启动循环 —— 后者严重得多。这类情况会作为 note 回报，
 * 由调用方写进日志与审计，让作者看得见"这条约束没生效"。
 *
 * @param {{names: unknown[], version?: string | null}} target
 * @param {any[]} entries
 * @returns {{hit?: any, notes: string[]}}
 */
export function matchPolicy(target, entries) {
  const notes = []
  for (const entry of entries ?? []) {
    const result = testPolicyEntry(target, entry)
    if (result.outcome === 'hit') return { hit: entry, notes }
    if (result.outcome === 'version-unknown') notes.push(`${entry.raw} —— ${result.reason}（版本约束未生效）`)
    else if (result.outcome === 'version-mismatch') notes.push(`${entry.raw} —— ${result.reason}（未命中，符合预期）`)
  }
  return { hit: undefined, notes }
}

/** 命中条目的可写进报告/审计的摘要。 */
export function describeEntry(entry) {
  return {
    raw: entry?.raw,
    name: entry?.name,
    version: entry?.version ?? null,
    mode: entry?.mode,
    reason: entry?.reason ?? null,
  }
}

/**
 * 决定一个命中该走哪种响应。
 * @param {any[]} violations
 * @param {any} config
 * @param {{actionable?: boolean}} [options] actionable=false 表示这次没有可拦截的动作
 *   （例如插件已经加载了），此时 `deny` 无处可施，退化为 `warn`。
 */
export function resolveResponse(violations, config = {}, options = {}) {
  let mode = modeOfConfig(config)
  for (const violation of violations ?? []) {
    if (typeof violation?.mode === 'string') mode = strictestMode(mode, violation.mode)
  }
  if (mode === 'deny' && options.actionable !== true) mode = 'warn'
  return mode
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
 *
 * 返回值形状是 `{ violations, notes }`：
 *   - `violations` 命中项（带 `entry`/`mode`/`version`，供响应分层与报告使用）
 *   - `notes`      名字对上了但**版本约束没能生效**（未解析到版本 / 版本不满足）的说明，
 *                 由调用方写进日志与审计，避免"我写了版本约束但它静默失效"
 *
 * 行的 `version` 由调用方（plugin.js）解析后填在 row 上；填不到就是 null。
 * @param {(ReturnType<typeof readLoaderRows>[number] & {version?: string | null})[]} rows
 * @param {any} config
 * @returns {{violations: any[], notes: string[]}}
 */
export function inspectLoaderRows(rows, config = {}) {
  const entries = policyOf(config)
  const includeDisabled = Boolean(config.include_disabled)
  const violations = []
  const notes = []
  for (const row of rows ?? []) {
    if (row?.group) continue
    if (!includeDisabled && row?.enabled === false) continue
    const target = { names: [row?.moduleName, row?.entryId, row?.pluginName], version: row?.version ?? null }
    const matched = matchPolicy(target, entries)
    for (const note of matched.notes) notes.push(`行 ${row?.entryId ?? '?'}: ${note}`)
    if (matched.hit === undefined) continue
    violations.push({
      entryId: String(row.entryId ?? ''),
      moduleName: String(row.moduleName ?? ''),
      pluginName: row.pluginName ? String(row.pluginName) : undefined,
      phase: row.phase ?? null,
      enabled: row.enabled !== false,
      pattern: matched.hit.name,
      entry: describeEntry(matched.hit),
      mode: matched.hit.mode,
      version: typeof row.version === 'string' ? row.version : null,
    })
  }
  return { violations, notes }
}

/**
 * 判定 agent-preset composition 里的行（这些行不在 loader 树上）。
 *
 * 行的真实形状见 `AgentPresetCompositionRow`（@deepseek-ai/dsh-agent-preset-registry）：
 * `{ entryId: string | null, moduleName, enabled: boolean | 'conditional', condition?, fiberState? }`。
 * 注意 `enabled` 可能是 `'conditional'`（该行由 `!!js` 表达式决定），此时按「可能被加载」处理 ——
 * 对守卫而言条件启用同样是风险面，但要把 condition 写进报告，让用户知道为什么崩。
 *
 * 预设行拿不到版本（compositionInventory 不提供），所以带版本约束的条目在这里会作为
 * `version-unknown` 回报而不是命中 —— 名字型条目不受影响。
 *
 * @param {any[]} compositions agentPresets.compositionInventory() 的结果
 * @param {any} config
 * @returns {{violations: any[], notes: string[]}}
 */
export function inspectPresetCompositions(compositions, config = {}) {
  const entries = policyOf(config)
  const includeDisabled = Boolean(config.include_disabled)
  const violations = []
  const notes = []
  for (const composition of compositions ?? []) {
    for (const row of composition?.rows ?? []) {
      // 与 loader 通道同一条语义：被关掉的行不算「已加载」
      if (row?.enabled === false && !includeDisabled) continue
      const matched = matchPolicy({ names: [row?.moduleName, row?.entryId], version: null }, entries)
      for (const note of matched.notes) notes.push(`预设 ${composition?.id ?? '?'} 行 ${row?.entryId ?? '?'}: ${note}`)
      if (matched.hit === undefined) continue
      violations.push({
        entryId: row?.entryId === null || row?.entryId === undefined ? '' : String(row.entryId),
        moduleName: String(row?.moduleName ?? ''),
        phase: typeof row?.fiberState === 'number' ? (FIBER_PHASE[row.fiberState] ?? null) : null,
        enabled: row?.enabled !== false,
        pattern: matched.hit.name,
        entry: describeEntry(matched.hit),
        mode: matched.hit.mode,
        version: null,
        preset: composition?.id ?? composition?.name,
        condition: typeof row?.condition === 'string' ? row.condition : undefined,
      })
    }
  }
  return { violations, notes }
}

/**
 * 判定一次 plugin_manager 工具调用 —— 「不允许被安装」的最前置闸门。
 * 该判定发生在工具真正执行之前（tools/pre-execute），因此 pnpm 尚未启动，
 * profile 尚未被改动，崩溃是干净的。
 *
 * @param {unknown} toolName
 * @param {unknown} args
 * @param {any} config
 * @param {any} config
 * @param {{moduleNameOf?: (entryId: string) => string | undefined, versionOf?: (key: string) => string | null | undefined}} [resolver]
 *   `set_plugin` 的 target 是 loader 行 id，未必等于包名（例如行 id 叫 `bundle-dshmarket`、
 *   包名才叫 `dshmarket`）。给出 resolver 时，行 id 会先解析成真实模块名与已装版本再一起比对。
 * @returns {{hit?: any, notes: string[]}}
 *   `hit.kind` 为 `'install-attempt' | 'enable-attempt' | 'self-removal'`。
 *   注意 `self-removal` 是**内置规则**（不是 crash_plugin 里的条目），因此它没有 entry/mode，
 *   由 `resolveResponse` 回落到全局 mode。
 */
export function classifyManagerCall(toolName, args, config = {}, resolver = {}) {
  const entries = policyOf(config)
  const notes = []
  if (toolName !== 'plugin_manager') return { hit: undefined, notes }
  if (args === null || typeof args !== 'object') return { hit: undefined, notes }

  const action = typeof (/** @type {any} */ (args).action) === 'string' ? /** @type {any} */ (args).action : ''
  const target = typeof (/** @type {any} */ (args).target) === 'string' ? /** @type {any} */ (args).target : ''
  const enabled = /** @type {any} */ (args).enabled
  const selfPatterns = [...arrayOfStrings(config.self_entry_ids), String(config.self_package ?? '')].filter(Boolean)

  if (!target) return { hit: undefined, notes }

  const versionOfKey = (key) => {
    if (typeof resolver.versionOf !== 'function') return null
    try {
      const value = resolver.versionOf(key)
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      return null
    }
  }

  // 1) 安装尝试：target 是包 spec（可能自带版本，如 `dshmarket@1.66.0`）
  if (action === 'install_bundle' && config.crash_on_install_attempt !== false) {
    const split = splitNameVersion(target)
    const matched = matchPolicy({ names: [target], version: split.version }, entries)
    for (const note of matched.notes) notes.push(`安装目标 ${target}: ${note}`)
    if (matched.hit !== undefined) {
      const versionNote = split.version === null ? '' : `，请求版本 ${split.version}`
      return {
        hit: {
          kind: 'install-attempt',
          target,
          pattern: matched.hit.name,
          entry: describeEntry(matched.hit),
          mode: matched.hit.mode,
          requestedVersion: split.version,
          action,
          detail: `plugin_manager install_bundle 试图安装被禁插件 ${JSON.stringify(target)}（命中规则 ${JSON.stringify(matched.hit.raw)}${matched.hit.version === null ? '' : `，版本约束 ${matched.hit.version}`}${versionNote}）`,
        },
        notes,
      }
    }
    return { hit: undefined, notes }
  }

  // 2) 启用尝试：set_bundle / set_plugin / set_version_exemption 且 enabled=true
  //    （set_version_exemption 本身不安装任何东西，但它是「放行一个本来装不上的包」的前置动作，
  //      与安装闸门同属一类，一起拦掉）
  if ((action === 'set_bundle' || action === 'set_plugin' || action === 'set_version_exemption') && enabled === true) {
    const names = [target]
    if (action === 'set_plugin' && typeof resolver.moduleNameOf === 'function') {
      try {
        const moduleName = resolver.moduleNameOf(target)
        if (typeof moduleName === 'string' && moduleName) names.push(moduleName)
      } catch {
        /* resolver 失败只影响这一条候选 */
      }
    }
    const matched = matchPolicy({ names, version: versionOfKey(target) }, entries)
    for (const note of matched.notes) notes.push(`启用目标 ${target}: ${note}`)
    if (matched.hit !== undefined) {
      return {
        hit: {
          kind: 'enable-attempt',
          target,
          pattern: matched.hit.name,
          entry: describeEntry(matched.hit),
          mode: matched.hit.mode,
          action,
          detail: `plugin_manager ${action} 试图启用被禁插件 ${JSON.stringify(target)}（命中规则 ${JSON.stringify(matched.hit.raw)}）`,
        },
        notes,
      }
    }
    return { hit: undefined, notes }
  }

  // 3) 拆除守卫自身：关停/卸载本插件 —— 原型里「不回执就踢出」的对应物（内置规则，非 crash_plugin 条目）
  if (config.guard_self_removal !== false) {
    const selfHit = firstMatch([target], selfPatterns)
    if (selfHit !== undefined) {
      const disabling = (action === 'set_plugin' || action === 'set_bundle') && enabled === false
      const removing = action === 'remove_bundle'
      if (disabling || removing) {
        return {
          hit: {
            kind: 'self-removal',
            target,
            pattern: selfHit,
            entry: null,
            mode: modeOfConfig(config),
            action,
            detail: `plugin_manager ${action} 试图关停/卸载 allcrash 守卫自身（${JSON.stringify(target)}）`,
          },
          notes,
        }
      }
    }
  }

  return { hit: undefined, notes }
}

/**
 * 从一行 pnpm 输出里找被禁插件名（仅当 crash_on_install_log 打开时使用）。
 *
 * 匹配规则是「名字边界 + 通配」：`*` / `?` 只吃名字字符（`[\w@/.-]`），
 * 因此 `dsh-plugin-wallpaper-*` 能命中 `+ dsh-plugin-wallpaper-engine 1.0.0`，
 * 而 `dshmarket` 不会误命中 `dshmarketplace`。
 * 日志行里拿不到已装版本，所以带版本约束的条目在这里只作为 note 回报（不命中）。
 * @param {unknown} chunk
 * @param {any} config
 * @returns {{hit?: any, notes: string[]}}
 */
export function classifyInstallLog(chunk, config = {}) {
  const notes = []
  if (config.crash_on_install_log !== true) return { hit: undefined, notes }
  const entries = policyOf(config)
  if (entries.length === 0) return { hit: undefined, notes }
  const text = collectStrings(chunk).join('\n')
  if (!text) return { hit: undefined, notes }
  for (const entry of entries) {
    if (entry.version !== null) {
      notes.push(`安装日志 ${entry.raw}: pnpm 输出里看不到已装版本，版本约束未生效`)
      continue
    }
    // 纯通配（`*`、`?`）定位不到具体包，跳过
    if (String(entry.name).replace(/[*?]/g, '').trim() === '') continue
    if (installLogPatternToRegExp(entry.name).test(text)) {
      return {
        hit: {
          kind: 'install-log',
          pattern: entry.name,
          entry: describeEntry(entry),
          mode: entry.mode,
          detail: `pnpm 输出中出现被禁插件名 ${JSON.stringify(entry.raw)}`,
        },
        notes,
      }
    }
  }
  return { hit: undefined, notes }
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
      if (Array.isArray(source.crash_plugin)) merged.crash_plugin = [...source.crash_plugin]
      else problems.push(`${label}.crash_plugin 不是数组，已忽略（保持上一层名单，守卫不会因此被关掉）`)
    }
    if ('mode' in source) {
      if (RESPONSE_MODES.includes(source.mode)) merged.mode = source.mode
      else problems.push(`${label}.mode ${JSON.stringify(source.mode)} 不是 ${RESPONSE_MODES.join('/')} 之一，已忽略（保持 ${merged.mode}）`)
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
  // 策略条目在合并完成后再归一化：这样条目里的 mode 回落用的是已经定下来的全局 mode
  const policy = normalizePolicy(merged.crash_plugin, merged.mode)
  merged.policy = policy.entries
  problems.push(...policy.problems)
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
    const entry = violation.entry ?? null
    lines.push(
      `  - ${violation.moduleName || '<unnamed>'}${violation.pluginName ? ` [plugin name: ${violation.pluginName}]` : ''}` +
        ` (entry id: ${violation.entryId || '<none>'}, phase: ${violation.phase ?? 'n/a'}` +
        `, enabled: ${violation.enabled !== false}${violation.preset ? `, preset: ${violation.preset}` : ''}` +
        `${violation.condition ? `, condition: ${violation.condition}` : ''}, matched: ${JSON.stringify(violation.pattern)}` +
        `${violation.version ? `, installed version: ${violation.version}` : ''}` +
        `${entry && entry.version ? `, version constraint: ${entry.version}` : ''}` +
        `${entry ? `, mode: ${entry.mode}` : ''}${entry && entry.reason ? `, reason: ${entry.reason}` : ''})`,
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
  lines.push(`  mode=${incident?.response ?? modeOfConfig(incident?.config ?? {})}`)
  lines.push(`  crash_plugin=${JSON.stringify(incident?.config?.crash_plugin ?? [])}`)
  const problems = incident?.config?.problems
  if (Array.isArray(problems) && problems.length > 0) lines.push(`  config_problems=${JSON.stringify(problems)}`)
  lines.push(`  trigger=${incident?.trigger ?? 'n/a'}`)
  lines.push('')
  lines.push('Recovery')
  lines.push('========')
  lines.push(`  1) 打开 ${incident?.configPath ?? '${DSH_HOME}/allcrash.json'}，把命中的插件名（或版本约束）从 crash_plugin 里改掉；`)
  lines.push('  2) 或从 profile 里移除该插件（其所依赖的 bundle、cordis.patch.yml 里的行，或 agent preset 里的声明）；')
  lines.push('  3) 重启 DSH。')
  lines.push('  要先看"会崩在谁身上"而不真的崩：把配置里的 mode 改成 "warn"（只告警 + 落诊断）。')
  lines.push('  要整体拆除守卫：手工编辑 cordis.patch.yml 删掉 allcrash 行，并从 profile package.json 的')
  lines.push('  dsh.profile.bundles / dependencies 里删掉 dsh-plugin-allcrash —— 经 plugin_manager 操作会被再次拦下。')
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
