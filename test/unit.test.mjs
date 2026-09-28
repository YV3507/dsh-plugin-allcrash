// dsh-plugin-allcrash —— 离线单元测试（零依赖，node --test）
//
//   node --test test/unit.test.mjs
//
// 覆盖：名字归一化 / 通配匹配 / loader 行判定 / 预设行判定 /
//       plugin_manager 工具闸门 / 安装日志判定 / 崩溃报告 / 引爆器幂等。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  buildReport,
  candidatesOf,
  classifyInstallLog,
  classifyManagerCall,
  formatLocalTime,
  globMatches,
  inspectLoaderRows,
  inspectPresetCompositions,
  mergeConfig,
  nameMatches,
  parseConfigText,
  readLoaderRows,
  rickrollMessage,
  shortName,
} from '../lib/guard.js'
import { createDetonator, EXIT_FALLBACK_MS, stamp } from '../lib/detonate.js'
import {
  CONFIG_FILE_NAME,
  CRASH_REPORT_DIR_NAME,
  configPathFor,
  crashReportDirFor,
  crashReportFileFor,
  expandHomePath,
  resolveDshHome,
  safeHomedir,
} from '../lib/paths.js'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/* ------------------------------------------------------------ 名字归一化 */

test('candidatesOf 剥离版本号、link:/file:/github: 前缀与路径噪声', () => {
  assert.ok(candidatesOf('@Scope/Pkg@1.2.3').includes('@scope/pkg'))
  assert.ok(candidatesOf('dshmarket@1.66.0').includes('dshmarket'))
  assert.ok(candidatesOf('link:E:/dsh-love_for_llm').includes('dsh-love_for_llm'))
  assert.ok(candidatesOf('github:user/repo#v1.2.3').includes('user/repo'))
  assert.ok(candidatesOf('github:user/repo#v1.2.3').includes('repo'))
  assert.ok(candidatesOf('https://github.com/user/repo.git').includes('repo'))
  assert.ok(candidatesOf('../dsh-plugin-allcrash/lib/index.js').includes('dsh-plugin-allcrash'))
  assert.deepEqual(candidatesOf(undefined), [])
  assert.deepEqual(candidatesOf(''), [])
})

test('路径片段不会把 lib/src/index 当成候选名（防误伤）', () => {
  const list = candidatesOf('C:/x/lib/src/dist/index.js')
  assert.ok(!list.includes('lib'))
  assert.ok(!list.includes('src'))
  assert.ok(!list.includes('dist'))
  assert.ok(!list.includes('index'))
})

/* ------------------------------------------------------ 跨平台路径形态 */

test('candidatesOf 认三种平台的路径写法（Windows 反斜杠 / POSIX / UNC / 百分号编码）', () => {
  // 纯反斜杠路径也必须能拆出片段：只按 '/' 拆就会漏掉 `E:\vendor\evil-plugin`
  assert.ok(candidatesOf('E:\\dsh-crash\\evil-plugin').includes('evil-plugin'), 'Windows 盘符路径')
  assert.ok(candidatesOf('link:D:\\vendor\\evil-plugin').includes('evil-plugin'), 'link: + 反斜杠')
  assert.ok(candidatesOf('C:\\Users\\me\\My Plugins\\evil-plugin').includes('evil-plugin'), '带空格的 Windows 路径')
  assert.ok(candidatesOf('\\\\server\\share\\evil-plugin').includes('evil-plugin'), 'UNC 路径')
  assert.ok(candidatesOf('/Users/me/My Plugins/evil-plugin').includes('evil-plugin'), 'macOS/Linux 路径')
  assert.ok(candidatesOf('file:///Users/me/My%20Plugins/evil-plugin').includes('evil-plugin'), 'file URL')
  assert.ok(candidatesOf('file:///Users/me/My%20Plugins/evil-plugin').includes('my plugins'), 'file URL 百分号解码')
  assert.ok(candidatesOf('link:/home/me/My Projects/evil-plugin').includes('evil-plugin'), 'POSIX link:')
  assert.ok(candidatesOf('E:\\X\\Evil-Plugin').includes('evil-plugin'), '大小写不敏感')
  // 反斜杠路径同样不能把 lib/src/index 当候选
  const noisy = candidatesOf('E:\\pkg\\lib\\index.js')
  assert.ok(!noisy.includes('lib') && !noisy.includes('index'))
  assert.ok(noisy.includes('pkg'))
})

test('nameMatches 认同一条路径的两种分隔符写法（跨平台漏检修复）', () => {
  const bs = String.fromCharCode(92)
  // profile YAML 里常见正斜杠，而 Node 的 path.join 在 Windows 上给反斜杠 ——
  // 两边任一种写法都必须能对上，否则「路径形状的模式」会漏检
  assert.equal(nameMatches(`link:E:${bs}vendor${bs}evil`, 'link:E:/vendor/evil'), true)
  assert.equal(nameMatches('E:/vendor/evil', `E:${bs}vendor${bs}evil`), true)
  assert.equal(nameMatches(`${bs}${bs}server${bs}share${bs}evil`, '//server/share/evil'), true)
  assert.equal(nameMatches('/Users/me/pkg', `${bs}Users${bs}me${bs}pkg`), true)
  // 名字片段照旧
  assert.equal(nameMatches(`E:${bs}vendor${bs}evil`, 'evil'), true)
  assert.equal(nameMatches('E:/vendor/evil', 'vendor'), true)
})

test('globMatches 与「正则展开」参考实现在穷举输入上完全一致', () => {
  // 参考实现只用于良性模式（无嵌套量词），不会回溯爆炸；两指针版必须给出同样结果
  const reference = (text, pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(text)
  const texts = ['']
  for (let length = 1; length <= 4; length += 1) {
    const build = (prefix) => {
      if (prefix.length === length) {
        texts.push(prefix)
        return
      }
      for (const ch of ['a', 'b']) build(prefix + ch)
    }
    build('')
  }
  const patterns = ['']
  for (let length = 1; length <= 3; length += 1) {
    const build = (prefix) => {
      if (prefix.length === length) {
        patterns.push(prefix)
        return
      }
      for (const ch of ['a', 'b', '*', '?']) build(prefix + ch)
    }
    build('')
  }
  let checked = 0
  for (const text of texts) {
    for (const pattern of patterns) {
      checked += 1
      assert.equal(globMatches(text, pattern), reference(text, pattern), `文本 ${JSON.stringify(text)} 模式 ${JSON.stringify(pattern)}`)
    }
  }
  assert.ok(checked > 2000, `穷举用例太少：${checked}`)
})

/* ------------------------------------------------------------ 配置解析 */

test('parseConfigText 容忍 UTF-8 BOM（Windows PowerShell 5.1 / 部分编辑器的默认行为）', () => {
  // 不剥 BOM 的话 JSON.parse 会抛错，表现成「用户改了配置却不生效」
  assert.deepEqual(parseConfigText('\uFEFF{"crash_plugin":["x"]}'), { crash_plugin: ['x'] })
  assert.deepEqual(parseConfigText('\uFEFF\r\n{\r\n  "a": 1\r\n}\r\n'), { a: 1 })
  assert.deepEqual(parseConfigText('{"crash_plugin":["x"]}'), { crash_plugin: ['x'] })
  assert.throws(() => parseConfigText('{'), SyntaxError)
  assert.throws(() => parseConfigText(null), TypeError)
})

test('shortName 压路径/URL 但不破坏包名（跨平台可读性）', () => {
  // 包名（含 scope）必须原样保留 —— 不能被当成路径切掉 scope
  assert.equal(shortName('dshmarket'), 'dshmarket')
  assert.equal(shortName('@deepseek-ai/dsh-client-ui-chat'), '@deepseek-ai/dsh-client-ui-chat')
  // 路径与 URL 压成最后一段
  assert.equal(shortName('./dummy-mod.js'), 'dummy-mod.js')
  assert.equal(shortName('../lib/index.js'), 'index.js')
  assert.equal(shortName('E:\\vendor\\evil-plugin'), 'evil-plugin')
  assert.equal(shortName('/Users/me/My Plugins/evil-plugin'), 'evil-plugin')
  assert.equal(shortName('file:///C:/Users/me/evil-plugin/index.js'), 'index.js')
  assert.equal(shortName('file:///Users/me/My%20Plugins/evil-plugin'), 'evil-plugin')
  assert.equal(shortName('\\\\server\\share\\evil-plugin'), 'evil-plugin')
  assert.equal(shortName(''), '')
  assert.equal(shortName(undefined), '')
})

/* ------------------------------------------------------- 跨平台家目录 */

const fakeHome = join(tmpdir(), 'allcrash-fake-home')

test('resolveDshHome 与 DSH 同一套规则：$DSH_HOME → ~/.dsh，空白视为未设置', () => {
  // 显式参数优先级最高
  assert.equal(
    resolveDshHome({ env: { DSH_HOME: '/ignored' }, home: fakeHome, configured: join(fakeHome, 'cfg') }),
    resolve(join(fakeHome, 'cfg')),
  )
  // 其次 $DSH_HOME
  const envHome = join(fakeHome, 'dsh-home')
  assert.equal(resolveDshHome({ env: { DSH_HOME: envHome }, home: fakeHome }), resolve(envHome))
  // 空串 / 纯空白 / 未设置 → ~/.dsh；不得退化成 cwd
  for (const value of [undefined, '', '   ', '\t']) {
    assert.equal(resolveDshHome({ env: { DSH_HOME: value }, home: fakeHome }), resolve(join(fakeHome, '.dsh')), JSON.stringify(value))
  }
  // 与 DSH 完全一致：只拿 trim 判断「是否设置」，值本身原样 resolve。
  // 插件不能自作聪明地 trim —— 否则插件与宿主会对「家目录在哪」产生分歧。
  assert.equal(resolveDshHome({ env: { DSH_HOME: `  ${envHome}  ` }, home: fakeHome }), resolve(`  ${envHome}  `))
})

test('resolveDshHome 支持 ~ / ~\\ 展开，结果总是绝对路径', () => {
  assert.equal(expandHomePath('~', fakeHome), fakeHome)
  assert.equal(expandHomePath('~/x', fakeHome), join(fakeHome, 'x'))
  assert.equal(expandHomePath('~\\x', fakeHome), join(fakeHome, 'x'))
  assert.equal(expandHomePath('/abs/x', fakeHome), '/abs/x')
  assert.equal(expandHomePath('relative/x', fakeHome), 'relative/x')
  const relative = resolveDshHome({ env: { DSH_HOME: 'relative-home' }, home: fakeHome })
  assert.ok(isAbsolute(relative))
  assert.equal(relative, resolve('relative-home'))
  assert.ok(safeHomedir().length > 0)
})

test('配置/报告/审计路径由 paths.js 统一拼装（宿主分隔符 + 平台安全文件名）', () => {
  const env = { DSH_HOME: join(tmpdir(), 'allcrash-home') }
  assert.equal(configPathFor({ env }), join(env.DSH_HOME, CONFIG_FILE_NAME))
  assert.equal(crashReportDirFor({ env }), join(env.DSH_HOME, CRASH_REPORT_DIR_NAME))
  const file = crashReportFileFor('2026-08-28_11-07-12-139', 4242, { env })
  assert.equal(file, join(env.DSH_HOME, CRASH_REPORT_DIR_NAME, 'allcrash-2026-08-28_11-07-12-139-4242.txt'))
  assert.equal(dirname(file), crashReportDirFor({ env }))
  // 文件名不能出现 Windows 非法字符 : * ? " < > | （时间戳用 - 而不是 :）
  assert.ok(!/[:*?"<>|]/.test(basename(file)))
})

/* --------------------------------------------------------------- 模式匹配 */

test('nameMatches：精确、大小写不敏感、通配、以及不误伤', () => {
  assert.equal(nameMatches('dshmarket', 'dshmarket'), true)
  assert.equal(nameMatches('DshMarket', 'dshmarket'), true)
  assert.equal(nameMatches('dsh-plugin-wallpaper-engine', 'dsh-plugin-*'), true)
  assert.equal(nameMatches('dsh-plugin-wallpaper-engine', 'dsh-plugin-?????-*'), false)
  assert.equal(nameMatches('dshmarketpro', 'dshmarket'), false)
  assert.equal(nameMatches('@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-*'), true)
  assert.equal(nameMatches('anything', ''), false)
})

test('globMatches：通配语义正确，且恶意模式不会灾难性回溯', () => {
  assert.equal(globMatches('abc', 'abc'), true)
  assert.equal(globMatches('abc', 'a*c'), true)
  assert.equal(globMatches('abc', 'a?c'), true)
  assert.equal(globMatches('abc', 'a?'), false)
  assert.equal(globMatches('abc', '*'), true)
  assert.equal(globMatches('', '*'), true)
  assert.equal(globMatches('', '?'), false)
  assert.equal(globMatches('aaa', 'a*a'), true)
  assert.equal(globMatches('abc', '*b*'), true)
  assert.equal(globMatches('abc', '*d*'), false)
  assert.equal(globMatches('abcdef', 'a*d*f'), true)
  assert.equal(globMatches('abcdef', 'a*d*g'), false)

  // 正则版（.* 展开）在这种模式 + 这种输入上会指数级回溯；两指针版必须瞬间返回。
  const pattern = '*a*a*a*a*a*a*a*a*a*a*a*a*b'
  const text = 'a'.repeat(120)
  const started = Date.now()
  assert.equal(globMatches(text, pattern), false)
  assert.ok(Date.now() - started < 200, '匹配耗时应远小于 200ms，说明没有回溯爆炸')
})

/* ------------------------------------------------------------- loader 行 */

const fakeLoader = (rows) => ({ entries: () => rows[Symbol.iterator]() })
const row = (options, extra = {}) => ({
  id: options.id,
  options,
  disabled: Boolean(extra.disabled),
  fiber: { state: extra.state ?? 2, ...(extra.pluginName ? { runtime: { name: extra.pluginName } } : {}) },
  parent: { tree: { ctx: { baseUrl: 'file:///profile/' } } },
})

test('readLoaderRows 读取 id/name/pluginName/enabled/phase，并跳过坏行', () => {
  const rows = readLoaderRows(
    fakeLoader([
      row({ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }, { pluginName: 'ui-chat' }),
      row({ id: 'off', name: 'disabled-plugin' }, { disabled: true }),
      row({ id: 'group-x', group: true }),
    ]),
  )
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    entryId: 'ui-chat',
    moduleName: '@deepseek-ai/dsh-client-ui-chat',
    pluginName: 'ui-chat',
    enabled: true,
    phase: 'active',
    group: false,
    baseUrl: 'file:///profile/',
  })
  assert.equal(rows[1].enabled, false)
  assert.equal(rows[2].group, true)
  assert.deepEqual(readLoaderRows(undefined), [])
  assert.deepEqual(readLoaderRows({}), [])
})

test('readLoaderRows 逐行容错：单行取值抛错、迭代中途抛错都不影响已读到的行', () => {
  const badRow = {
    id: 'bad',
    options: { id: 'bad', name: 'bad-plugin' },
    get disabled() {
      throw new Error('disabled 取值炸了')
    },
    fiber: { state: 2 },
    parent: { tree: { ctx: {} } },
  }
  const withBad = readLoaderRows(fakeLoader([row({ id: 'ok', name: 'ok-plugin' }), badRow]))
  assert.equal(withBad.length, 2)
  assert.equal(withBad[1].moduleName, 'bad-plugin')
  // 取值失败时按「未禁用」处理：宁可多查一次，不可漏检
  assert.equal(withBad[1].enabled, true)

  function* throwingIteration() {
    yield row({ id: 'first', name: 'first-plugin' })
    throw new Error('迭代炸了')
  }
  const partial = readLoaderRows({ entries: () => throwingIteration() })
  assert.equal(partial.length, 1)
  assert.equal(partial[0].entryId, 'first')

  // entries 不是函数
  assert.deepEqual(readLoaderRows({ entries: 42 }), [])
})

test('inspectLoaderRows：按包名或行 id 命中，默认忽略 disabled 行', () => {
  const rows = readLoaderRows(
    fakeLoader([
      row({ id: 'bundle-dshmarket', name: 'dshmarket' }),
      row({ id: 'wallpaper', name: 'dsh-plugin-wallpaper-engine' }),
      row({ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }),
      row({ id: 'ghost', name: 'ghost-plugin' }, { disabled: true }),
      row({ id: 'g', group: true }),
    ]),
  )
  const hit = inspectLoaderRows(rows, { crash_plugin: ['dshmarket', 'dsh-plugin-wallpaper-*'] })
  assert.deepEqual(
    hit.map((v) => v.moduleName).sort(),
    ['dsh-plugin-wallpaper-engine', 'dshmarket'],
  )

  // 按行 id 命中
  assert.equal(inspectLoaderRows(rows, { crash_plugin: ['ui-chat'] }).length, 1)

  // disabled 行默认不算「已加载」；打开开关才算
  assert.equal(inspectLoaderRows(rows, { crash_plugin: ['ghost-plugin'] }).length, 0)
  assert.equal(inspectLoaderRows(rows, { crash_plugin: ['ghost-plugin'], include_disabled: true }).length, 1)

  // 组节点永不命中
  assert.equal(inspectLoaderRows(rows, { crash_plugin: ['g'] }).length, 0)
})

test('inspectLoaderRows：行 name 是模块 spec，插件声明名同样能命中', () => {
  // 行 name 是模块 spec（'./dummy-mod.js'），插件自己声明的名字才叫 dummy-forbidden；
  // 两个都要能命中，否则只比对行 name 就会漏检
  const rows = readLoaderRows(fakeLoader([row({ id: 'dummy', name: './dummy-mod.js' }, { pluginName: 'dummy-forbidden' })]))
  const byDeclared = inspectLoaderRows(rows, { crash_plugin: ['dummy-forbidden'] })
  assert.equal(byDeclared.length, 1)
  assert.equal(byDeclared[0].pluginName, 'dummy-forbidden')
  // spec 里的路径片段也照样能命中
  assert.equal(inspectLoaderRows(rows, { crash_plugin: ['dummy-mod'] }).length, 1)
  // 报告里两个名字都要能看见
  const text = buildReport({ violations: byDeclared, rows, config: { crash_plugin: ['dummy-forbidden'] } })
  assert.match(text, /\[plugin name: dummy-forbidden\]/)
  assert.match(text, /dummy = \.\/dummy-mod\.js \[dummy-forbidden\] \(active\)/)
})

/* --------------------------------------------------------- 预设 composition */

test('inspectPresetCompositions 按真实行形状判定：enabled / fiberState / condition 都要用对', () => {
  // 形状来自 AgentPresetCompositionRow 类型声明：
  // { entryId: string | null, moduleName, enabled: boolean | 'conditional', condition?, fiberState? }
  const compositions = [
    {
      id: 'standard',
      isDefault: true,
      rows: [
        { entryId: 'ui-chat', moduleName: '@deepseek-ai/dsh-client-ui-chat', enabled: true, fiberState: 2 /* ACTIVE */ },
        { entryId: null, moduleName: 'dsh-whale-widget', enabled: 'conditional', condition: 'ctx.get("flag")', fiberState: 2 },
      ],
    },
    {
      id: 'custom',
      rows: [
        { entryId: null, moduleName: 'dshmarket', enabled: false, fiberState: 0 /* PENDING */ },
        { entryId: 'evil-tool', moduleName: 'evil-tool', enabled: true, fiberState: 2 },
      ],
    },
  ]

  const hit = inspectPresetCompositions(compositions, { crash_plugin: ['dshmarket'] })
  // enabled:false 的 preset 行不算「已加载」，与 loader 通道同一语义
  assert.equal(hit.length, 0)

  const withDisabled = inspectPresetCompositions(compositions, { crash_plugin: ['dshmarket'], include_disabled: true })
  assert.equal(withDisabled.length, 1)
  assert.equal(withDisabled[0].preset, 'custom')
  assert.equal(withDisabled[0].phase, 'pending')
  assert.equal(withDisabled[0].enabled, false)
  assert.equal(withDisabled[0].entryId, '') // entryId 为 null 时不能写出字符串 'null'

  // 行 id 与声明名都要能命中
  assert.equal(inspectPresetCompositions(compositions, { crash_plugin: ['evil-tool'] })[0].phase, 'active')

  // conditional 行按「可能被加载」处理，并把 condition 带进判定结果
  const conditional = inspectPresetCompositions(compositions, { crash_plugin: ['dsh-whale-widget'] })
  assert.equal(conditional.length, 1)
  assert.equal(conditional[0].enabled, true)
  assert.equal(conditional[0].condition, 'ctx.get("flag")')
  assert.equal(conditional[0].preset, 'standard')

  assert.equal(inspectPresetCompositions(compositions, { crash_plugin: ['nope'] }).length, 0)
})

/* ------------------------------------------------------- plugin_manager 闸门 */

test('classifyManagerCall：安装尝试在 pnpm 启动前就被判死', () => {
  const config = { crash_plugin: ['dshmarket', 'evil-*'], self_entry_ids: ['allcrash'], self_package: 'dsh-plugin-allcrash' }
  const hit = classifyManagerCall('plugin_manager', { action: 'install_bundle', target: 'dshmarket@1.66.0' }, config)
  assert.equal(hit?.kind, 'install-attempt')
  assert.equal(hit?.pattern, 'dshmarket')

  const wild = classifyManagerCall('plugin_manager', { action: 'install_bundle', target: 'evil-tool' }, config)
  assert.equal(wild?.kind, 'install-attempt')

  // 本地路径安装：目录名命中即可
  const local = classifyManagerCall('plugin_manager', { action: 'install_bundle', target: 'E:/vendor/dshmarket' }, config)
  assert.equal(local?.kind, 'install-attempt')
})

test('classifyManagerCall：启用尝试、无关操作与非本工具都不触发', () => {
  const config = { crash_plugin: ['dshmarket'], self_entry_ids: ['allcrash'], self_package: 'dsh-plugin-allcrash' }
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_bundle', target: 'dshmarket', enabled: true }, config)?.kind, 'enable-attempt')
  // 行 id 与包名不同：给 resolver 就能解析回来
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_plugin', target: 'bundle-dshmarket', enabled: true }, config), undefined)
  const resolved = classifyManagerCall(
    'plugin_manager',
    { action: 'set_plugin', target: 'bundle-dshmarket', enabled: true },
    config,
    { moduleNameOf: (entryId) => (entryId === 'bundle-dshmarket' ? 'dshmarket' : undefined) },
  )
  assert.equal(resolved?.kind, 'enable-attempt')
  // 通配也能直接命中行 id
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_plugin', target: 'bundle-dshmarket', enabled: true }, { ...config, crash_plugin: ['*dshmarket*'] })?.kind, 'enable-attempt')
  // 关掉被禁插件是允许的（那是恢复动作）
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_bundle', target: 'dshmarket', enabled: false }, config), undefined)
  // 列表/无关目标
  assert.equal(classifyManagerCall('plugin_manager', { action: 'list_plugins' }, config), undefined)
  assert.equal(classifyManagerCall('plugin_manager', { action: 'install_bundle', target: 'harmless-plugin' }, config), undefined)
  assert.equal(classifyManagerCall('plugin_manager', { action: 'install_bundle' }, config), undefined)
  assert.equal(classifyManagerCall('read', { action: 'install_bundle', target: 'dshmarket' }, config), undefined)
  assert.equal(classifyManagerCall('plugin_manager', null, config), undefined)
  // 关掉安装拦截
  assert.equal(classifyManagerCall('plugin_manager', { action: 'install_bundle', target: 'dshmarket' }, { ...config, crash_on_install_attempt: false }), undefined)
})

test('classifyManagerCall：拆除守卫自身触发 self-removal', () => {
  const config = { crash_plugin: [], self_entry_ids: ['allcrash'], self_package: 'dsh-plugin-allcrash' }
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_plugin', target: 'allcrash', enabled: false }, config)?.kind, 'self-removal')
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_bundle', target: 'dsh-plugin-allcrash', enabled: false }, config)?.kind, 'self-removal')
  assert.equal(classifyManagerCall('plugin_manager', { action: 'remove_bundle', target: 'dsh-plugin-allcrash' }, config)?.kind, 'self-removal')
  // 启用自己不算
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_plugin', target: 'allcrash', enabled: true }, config), undefined)
  // 可关闭
  assert.equal(classifyManagerCall('plugin_manager', { action: 'remove_bundle', target: 'dsh-plugin-allcrash' }, { ...config, guard_self_removal: false }), undefined)
})

test('classifyManagerCall：给被禁插件开版本豁免也算「放行安装」', () => {
  const config = { crash_plugin: ['dshmarket'], self_entry_ids: ['allcrash'], self_package: 'dsh-plugin-allcrash' }
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_version_exemption', target: 'dshmarket@1.66.0', runtimeVersion: '0.1.7', enabled: true }, config)?.kind, 'enable-attempt')
  // 撤销豁免是恢复动作，放行
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_version_exemption', target: 'dshmarket@1.66.0', runtimeVersion: '0.1.7', enabled: false }, config), undefined)
  assert.equal(classifyManagerCall('plugin_manager', { action: 'set_version_exemption', target: 'harmless@1.0.0', enabled: true }, config), undefined)
})

/* ------------------------------------------------------------ 安装日志通道 */

test('classifyInstallLog 只在显式开启时工作，并按整词匹配', () => {
  const chunk = { requestId: 'r1', stream: 'stdout', text: 'Progress: resolved 1, fetched 1\n+ dshmarket 1.66.0' }
  assert.equal(classifyInstallLog(chunk, { crash_plugin: ['dshmarket'] }), undefined)
  const hit = classifyInstallLog(chunk, { crash_plugin: ['dshmarket'], crash_on_install_log: true })
  assert.equal(hit?.kind, 'install-log')
  assert.equal(hit?.pattern, 'dshmarket')
  // 不得误伤更长的名字
  assert.equal(classifyInstallLog({ text: 'dshmarketplace' }, { crash_plugin: ['dshmarket'], crash_on_install_log: true }), undefined)
  // 任意嵌套结构里的字符串都能被抓到
  assert.equal(classifyInstallLog({ a: { b: ['x', 'evil-tool installed'] } }, { crash_plugin: ['evil-tool'], crash_on_install_log: true })?.pattern, 'evil-tool')
})

test('classifyInstallLog 支持通配模式（名字被截断一半也能命中）', () => {
  const on = (crash_plugin) => ({ crash_plugin, crash_on_install_log: true })
  const line = { text: '+ dsh-plugin-wallpaper-engine 1.0.0' }
  assert.equal(classifyInstallLog(line, on(['dsh-plugin-wallpaper-*']))?.pattern, 'dsh-plugin-wallpaper-*')
  assert.equal(classifyInstallLog({ text: 'dsh-plugin-wallpaper-engine' }, on(['*wallpaper*']))?.pattern, '*wallpaper*')
  assert.equal(classifyInstallLog(line, on(['dsh-plugin-*-engine']))?.pattern, 'dsh-plugin-*-engine')
  // 纯通配定位不到具体包 → 跳过（否则任何一行 pnpm 输出都会崩）
  assert.equal(classifyInstallLog(line, on(['*'])), undefined)
  assert.equal(classifyInstallLog(line, on(['?'])), undefined)
  // 通配也不能跨出名字边界乱吃
  assert.equal(classifyInstallLog({ text: 'nothing-here' }, on(['wallpaper*'])), undefined)
})

/* ------------------------------------------------------------------ 配置合并 */

test('mergeConfig：默认 ← 文件 ← 行配置，逐键覆盖且做类型过滤', () => {
  const cfg = mergeConfig(
    { crash_plugin: ['from-row'], watch_interval_ms: 100 },
    { crash_plugin: ['from-file'], include_disabled: true, crash_message: 'file-msg' },
  )
  assert.deepEqual(cfg.crash_plugin, ['from-row'])
  assert.equal(cfg.include_disabled, true)
  assert.equal(cfg.crash_message, 'file-msg')
  assert.equal(cfg.watch_interval_ms, DEFAULT_CONFIG.watch_interval_ms) // 100 < 250 被拒
  const onlyFile = mergeConfig(undefined, { crash_plugin: ['from-file'] })
  assert.deepEqual(onlyFile.crash_plugin, ['from-file'])
  const empty = mergeConfig(undefined, undefined)
  assert.deepEqual(empty.crash_plugin, [...DEFAULT_CONFIG.crash_plugin])
  const junk = mergeConfig({ crash_plugin: [1, null, 'ok', '  '], watch_interval_ms: 'x' }, undefined)
  assert.deepEqual(junk.crash_plugin, ['ok'])
})

test('mergeConfig：类型错误不得把守卫悄悄关掉', () => {
  // crash_plugin 写成字符串（少写方括号）是最容易手滑的写法：
  // 必须保持上一层名单 + 告警，而不是当成空数组把守卫关掉
  const typo = mergeConfig(undefined, { crash_plugin: 'dshmarket' })
  assert.deepEqual(typo.crash_plugin, [...DEFAULT_CONFIG.crash_plugin])
  assert.equal(typo.problems.length, 1)
  assert.match(typo.problems[0], /crash_plugin 不是数组/)

  // 显式空数组是合法输入：确实不禁止任何插件
  const empty = mergeConfig(undefined, { crash_plugin: [] })
  assert.deepEqual(empty.crash_plugin, [])
  assert.deepEqual(empty.problems, [])

  // 顶层不是对象
  const arrayTop = mergeConfig(undefined, ['dshmarket'])
  assert.deepEqual(arrayTop.crash_plugin, [...DEFAULT_CONFIG.crash_plugin])
  assert.match(arrayTop.problems[0], /顶层不是 JSON 对象/)

  // 布尔/数字类型错误：忽略并告警，仍取默认值（默认值本身是严格的一侧）
  const badTypes = mergeConfig({ include_disabled: 'yes', guard_self_removal: 0, watch_interval_ms: 'soon' }, undefined)
  assert.equal(badTypes.include_disabled, false)
  assert.equal(badTypes.guard_self_removal, true)
  assert.equal(badTypes.watch_interval_ms, DEFAULT_CONFIG.watch_interval_ms)
  assert.equal(badTypes.problems.length, 3)

  // 行配置同样被检查
  const rowTypo = mergeConfig({ crash_plugin: 42 }, { crash_plugin: ['from-file'] })
  assert.deepEqual(rowTypo.crash_plugin, ['from-file'])
  assert.match(rowTypo.problems[0], /行配置/)
})

/* -------------------------------------------------------------- 崩溃报告 */

test('buildReport 含检测项、插件树、环境与恢复步骤', () => {
  const violations = [{ entryId: 'bundle-dshmarket', moduleName: 'dshmarket', phase: 'active', enabled: true, pattern: 'dshmarket' }]
  const text = buildReport({
    time: new Date('2026-08-28T00:00:00.000Z'),
    trigger: 'watchdog',
    violations,
    rows: [{ entryId: 'allcrash', moduleName: 'dsh-plugin-allcrash', enabled: true, phase: 'active', group: false }],
    config: { crash_plugin: ['dshmarket'] },
    configPath: 'C:/Users/x/.dsh/allcrash.json',
    pluginVersion: '1.0.0',
    env: { DSH_HOME: 'C:/Users/x/.dsh', DSH_PROFILE: 'web', node: 'v22.0.0', platform: 'win32', arch: 'x64', pid: 42 },
    description: 'allcrash 在 watchdog 时检测到被禁插件：dshmarket',
    stack: 'AllCrashError: boom',
  })
  assert.match(text, /---- DSH Crash Report ----/)
  assert.match(text, /Time: 2026-08-28T00:00:00\.000Z/)
  assert.match(text, /Local time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/)
  assert.match(text, /dshmarket \(entry id: bundle-dshmarket, phase: active/)
  assert.match(text, /allcrash = dsh-plugin-allcrash \(active\)/)
  assert.match(text, /DSH_PROFILE=web/)
  assert.match(text, /crash_plugin=\["dshmarket"\]/)
  assert.match(text, /Recovery/)
  assert.match(text, /AllCrashError: boom/)
})

test('buildReport 会把配置类型问题写进报告（诊断用）', () => {
  const text = buildReport({
    violations: [],
    rows: [],
    config: { crash_plugin: ['example-plugin'], problems: ['配置文件.crash_plugin 不是数组，已忽略（保持上一层名单，守卫不会因此被关掉）'] },
    configPath: 'x',
  })
  assert.match(text, /config_problems=\["配置文件\.crash_plugin 不是数组/)
})

test('rickrollMessage 保留原型原文并在括号里带命中的插件名', () => {
  const msg = rickrollMessage(DEFAULT_CONFIG, 'dshmarket')
  assert.equal(msg, 'Never gonna give you up, never gonna let you down, Never gonna run around and desert you.(dshmarket is loaded)')
})

test('formatLocalTime 给出带 UTC 偏移的本地时间（跨时区排查用）', () => {
  const text = formatLocalTime(new Date('2026-08-28T03:07:12Z'))
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/)
  // 与 UTC 的偏移必须和宿主时区一致（不能写死 +08:00）
  const offsetMinutes = -new Date('2026-08-28T03:07:12Z').getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const expected = `(UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')})`
  assert.ok(text.endsWith(expected), `${text} 应以 ${expected} 结尾`)
})

test('stamp() 产出的崩溃报告文件名在 Windows 上也合法', () => {
  const text = stamp(new Date(2026, 7, 28, 11, 7, 12, 139))
  assert.equal(text, '2026-08-28_11-07-12-139')
  // Windows 非法字符一个都不能有（早期断言用的是字面量，测不到 stamp 自身）
  assert.ok(!/[:*?"<>|\\/]/.test(text))
  assert.match(text, /^[0-9_-]+$/)
})

/* ---------------------------------------------------------------- 引爆器 */

function fakeIo(overrides = {}) {
  const calls = { reports: [], lines: [], thrown: [], fallback: [] }
  return {
    calls,
    io: {
      now: () => new Date('2026-08-28T00:00:00.000Z'),
      writeReport(text) {
        calls.reports.push(text)
        return 'C:/tmp/crash-reports/allcrash.txt'
      },
      stderr(line) {
        calls.lines.push(line)
      },
      throwAsync(error) {
        calls.thrown.push(error)
      },
      exitFallback(ms) {
        calls.fallback.push(ms)
      },
      ...overrides,
    },
  }
}

const incident = {
  trigger: 'tools/pre-execute:install-attempt',
  violations: [],
  rows: [],
  config: { crash_plugin: ['dshmarket'] },
  configPath: 'C:/tmp/allcrash.json',
  stderrMessage: rickrollMessage(DEFAULT_CONFIG, 'dshmarket'),
  description: '试图安装 dshmarket',
}

test('detonate：写报告 + stderr + 异步抛出 + 兜底退出，且只崩一次', () => {
  const { calls, io } = fakeIo()
  const detonator = createDetonator(io)
  const result = detonator.fire(incident, buildReport)

  assert.equal(result.reportPath, 'C:/tmp/crash-reports/allcrash.txt')
  assert.equal(calls.reports.length, 1)
  assert.match(calls.reports[0], /DSH Crash Report/)
  assert.ok(calls.lines.some((line) => line.includes('Never gonna give you up')))
  assert.ok(calls.lines.some((line) => line.includes('C:/tmp/crash-reports/allcrash.txt')))
  assert.equal(calls.thrown.length, 1)
  assert.equal(calls.thrown[0].name, 'AllCrashError')
  assert.match(calls.thrown[0].message, /dshmarket is loaded/)
  assert.deepEqual(calls.fallback, [EXIT_FALLBACK_MS])

  // 幂等：第二次不再写报告、不再抛
  const second = detonator.fire(incident, buildReport)
  assert.equal(second.alreadyFired, true)
  assert.equal(calls.reports.length, 1)
  assert.equal(calls.thrown.length, 1)
  assert.equal(detonator.fired, true)
})

test('detonate：报告写不进去也必须崩', () => {
  const { calls, io } = fakeIo({
    writeReport() {
      throw new Error('磁盘满了')
    },
  })
  const detonator = createDetonator(io)
  const result = detonator.fire(incident, buildReport)
  assert.equal(result.reportPath, undefined)
  assert.equal(calls.thrown.length, 1)
  assert.deepEqual(calls.fallback, [EXIT_FALLBACK_MS])
  assert.ok(calls.lines.some((line) => line.includes('崩溃报告写入失败')))
})

test('detonate：报告正文生成失败也必须崩，并写出一份兜底报告', () => {
  const { calls, io } = fakeIo()
  const detonator = createDetonator(io)
  detonator.fire(incident, () => {
    throw new Error('build 崩了')
  })
  assert.equal(calls.reports.length, 1)
  assert.match(calls.reports[0], /报告生成失败/)
  assert.match(calls.reports[0], /trigger: tools\/pre-execute:install-attempt/)
  assert.equal(calls.thrown.length, 1)
  assert.deepEqual(calls.fallback, [EXIT_FALLBACK_MS])
  assert.ok(calls.lines.some((line) => line.includes('allcrash detected a forbidden plugin')))
})

test('detonate：stderr 抛错也不能挡住抛出与兜底退出', () => {
  const { calls, io } = fakeIo({
    stderr() {
      throw new Error('stderr 坏了')
    },
  })
  const detonator = createDetonator(io)
  detonator.fire(incident, buildReport)
  assert.equal(calls.thrown.length, 1)
  assert.deepEqual(calls.fallback, [EXIT_FALLBACK_MS])
})

test('detonate：两条致命通道都调度失败时解除 fired，让下一次扫描重试', () => {
  const { io } = fakeIo({
    throwAsync() {
      throw new Error('调度失败')
    },
    exitFallback() {
      throw new Error('调度失败')
    },
  })
  const detonator = createDetonator(io)
  const first = detonator.fire(incident, buildReport)
  assert.equal(first.alreadyFired, undefined)
  // 没死成、也没装上致命通道 → 不能留下「已触发但不再检测」的假死状态
  assert.equal(detonator.fired, false)
  const second = detonator.fire(incident, buildReport)
  assert.equal(second.alreadyFired, undefined)
})
