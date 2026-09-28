// dsh-plugin-allcrash —— 隔离端到端测试：真实 Cordis Loader + 真实 fail-loud
//
//   node test/isolated-boot.mjs <mode>
//
// 这个脚本**不在你的 DSH 实例里跑**：它用 @deepseek-ai/dsh-app-boot 的 boot()
// 起一棵只含「一个假插件 + allcrash」的进程内插件树，DSH_HOME 指向本目录下的
// 临时目录，所以崩溃报告/配置文件都落在工作区里，不会碰到 ~/.dsh。
//
// 它验证的是真正会崩的那条路：
//   installFailLoud(...)  →  插件抛未捕获异常  →  stderr 诊断  →  process.exit(1)
//
// mode：
//   clean       树里有一个无关假插件，crash_plugin=["example-plugin"] → 必须活着
//   genfile     行与文件都没有列表 → 必须生成默认 allcrash.json 且活着
//   crash-row   行配置 crash_plugin=["dummy-forbidden"] → 必须崩（exit 1，trigger=boot+Nms）
//   crash-file  allcrash.json 里 crash_plugin=["dummy-forbidden"] → 必须崩
//   crash-tool  树干净，但模拟 plugin_manager 安装被禁插件 → 必须崩（L1 工具闸门）
//   gate-after-edit     运行期改配置文件 → 不重启即生效（必须崩，L1）
//   gate-after-delete   运行期删配置文件 → fail-closed 不放手（必须崩，L1）
//   gate-after-watchdog 运行期改配置、不发任何事件也不调工具 → 看门狗自己扫到（必须崩）
//   late-mount  boot 之后才把被禁插件挂进树 + 发 plugin-manager/changed → 必须崩（L2 事件通道）
//   crash-report-unwritable  报告目录被同名文件占位 → 写不出报告也必须崩
//   warn-loaded mode=warn，被禁插件已加载 → 只告警 + 落 dry-run 诊断，必须活着
//   deny-install mode=deny，安装被禁插件 / 拆守卫自身 → waterfall 返回 deny，Host 必须活着
//   version-hit  被禁插件的已装版本满足约束 → 必须崩（报告里带已装版本与约束）
//   version-miss 已装版本不满足约束 → 不该命中，必须活着
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/*
 * 让父级 runner 能断言 stderr 契约：把 process.stderr.write 的内容复制一份到文件。
 * 用文件而不是管道 —— 本仓库的开发环境（DSH 文件沙箱）会拒绝 Node 创建管道，
 * `node --test`/child_process 默认 stdio:'pipe' 都会 EPERM，文件则不触发该限制。
 */
const stderrCapturePath = process.env.ALLCRASH_STDERR_FILE
if (stderrCapturePath) {
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => {
    try {
      appendFileSync(stderrCapturePath, typeof chunk === 'string' ? chunk : String(chunk))
    } catch {
      /* 采集失败不影响被测行为 */
    }
    return originalWrite(chunk, ...rest)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const mode = process.argv[2] ?? 'clean'

/**
 * 临时目录位置。
 * 默认放在包目录下的 .isolated/（方便翻看崩溃报告），可用 $ALLCRASH_TEST_DIR 覆盖 ——
 * 例如插件被装在只读位置（POSIX 上 /usr/lib 之类）时，指向一个可写目录即可。
 */
const scratch = process.env.ALLCRASH_TEST_DIR
  ? resolve(process.env.ALLCRASH_TEST_DIR)
  : join(packageRoot, '.isolated')
const home = join(scratch, 'home')
try {
  for (const dir of [scratch, home]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
} catch (cause) {
  console.error(`[isolated] 无法写入临时目录 ${scratch}：${cause?.message ?? cause}`)
  console.error('[isolated] 换一个可写目录重试，例如：ALLCRASH_TEST_DIR=/tmp/allcrash node test/isolated-boot.mjs crash-row')
  process.exit(2)
}

/**
 * 找到 DSH 安装目录（里面有 node_modules/@deepseek-ai/dsh-app-boot）。
 * 跨平台：显式 $DSH_APP_ROOT 优先，否则按平台给出候选；全都不存在就明确报错退出，
 * 而不是让后面的 import 抛一个看不懂的 ENOENT。
 */
function resolveAppRoot() {
  const candidates = []
  if (process.env.DSH_APP_ROOT) candidates.push(process.env.DSH_APP_ROOT)
  if (process.platform === 'win32') {
    candidates.push('D:/DSH Desktop/resources/app')
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs/DSH Desktop/resources/app'))
    if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'DSH Desktop/resources/app'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app')
    if (process.env.HOME) candidates.push(join(process.env.HOME, 'Applications/DSH Desktop.app/Contents/Resources/app'))
  } else {
    candidates.push('/opt/DSH Desktop/resources/app', '/usr/lib/dsh-desktop/resources/app', '/usr/share/dsh-desktop/resources/app')
  }
  const marker = 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, marker))) return candidate
  }
  console.error(
    `[isolated] 找不到 DSH 安装目录（缺 ${marker}）。\n` +
      `[isolated] 请用 DSH_APP_ROOT 指向包含 node_modules/@deepseek-ai 的那个目录，例如：\n` +
      `[isolated]   Windows : $env:DSH_APP_ROOT='D:/DSH Desktop/resources/app'\n` +
      `[isolated]   macOS   : export DSH_APP_ROOT='/Applications/DSH Desktop.app/Contents/Resources/app'\n` +
      `[isolated]   Linux   : export DSH_APP_ROOT=/opt/'DSH Desktop'/resources/app`,
  )
  process.exit(2)
}

const DSH_APP = resolveAppRoot()

process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'isolated-test'
process.env.DSH_PROFILE_DIR = home

// 叶子配置：空数组，全部靠 patch 插入（与 profile 的 cordis.yml 同形）
writeFileSync(join(scratch, 'cordis.yml'), '[]\n', 'utf8')

// 假插件：在树里活着，名字就是要被禁的那个
const dummyPath = join(scratch, 'dummy-mod.js')
writeFileSync(
  dummyPath,
  [
    "export const name = 'dummy-forbidden'",
    'export const inject = []',
    'export function apply() { globalThis.__dummyApplied = true }',
    'export default { name, inject, apply }',
    '',
  ].join('\n'),
  'utf8',
)

// late-mount 模式用：boot 之后才挂进树的插件
const latePath = join(scratch, 'late-plugin.js')
writeFileSync(
  latePath,
  ["export const name = 'late-plugin'", 'export const inject = []', 'export function apply() {}', 'export default { name, inject, apply }', ''].join('\n'),
  'utf8',
)

// 版本判定用：带 package.json 的插件目录（版本解析要从模块文件往上找到它）
const fakeDir = join(scratch, 'fake-plugin')
mkdirSync(fakeDir, { recursive: true })
writeFileSync(join(fakeDir, 'package.json'), JSON.stringify({ name: 'fake-plugin', version: '1.0.0', type: 'module' }, null, 2), 'utf8')
const fakeEntryPath = join(fakeDir, 'index.js')
writeFileSync(
  fakeEntryPath,
  ["export const name = 'fake-plugin'", 'export const inject = []', 'export function apply() {}', 'export default { name, inject, apply }', ''].join('\n'),
  'utf8',
)

// 相对 cordis.yml 所在目录解析还是绝对 file:// URL：两个入口都用 file:// URL，
// 这样临时目录可以在包外（$ALLCRASH_TEST_DIR），插件装在只读位置时也能跑。
// 注意：入口不能写成 Windows 绝对路径 —— 用裸 Include 时 loader 会把 `E:\x` 当作
// 模块标识符交给内部的 ModuleLoader，加载会失败；`file://` URL 三种平台都认。
const guardName = pathToFileURL(join(packageRoot, 'lib', 'index.js')).href
const configFile = join(home, 'allcrash.json')
const rowConfig =
  mode === 'crash-row' || mode === 'crash-report-unwritable'
    ? { crash_plugin: ['dummy-forbidden'], watch_interval_ms: 1000 }
    : mode === 'clean'
      ? { crash_plugin: ['example-plugin'], watch_interval_ms: 1000 }
      : mode === 'crash-tool'
        ? { crash_plugin: ['dshmarket'], watch_interval_ms: 1000 }
        : mode === 'late-mount'
          ? // 名单里先放 late-plugin（boot 时树里还没有它），再看事件驱动的重扫能不能抓到
            { crash_plugin: ['late-plugin'], watch_interval_ms: 60000 }
          : mode === 'warn-loaded'
            ? // dry-run：命中也不崩，只告警 + 落诊断
              { mode: 'warn', crash_plugin: ['dummy-forbidden'], watch_interval_ms: 1000, audit_log: true }
            : mode === 'deny-install'
              ? // 可拦动作走 deny：拒绝安装 / 拆守卫，Host 保持存活
                { mode: 'deny', crash_plugin: ['dshmarket'], watch_interval_ms: 60000 }
              : mode === 'version-hit'
                ? { crash_plugin: ['fake-plugin@<2.0.0'], watch_interval_ms: 1000 }
                : mode === 'version-miss'
                  ? { crash_plugin: ['fake-plugin@>=2.0.0'], watch_interval_ms: 1000 }
                  : mode === 'gate-after-edit'
                    ? // 行配置里**不能**带 crash_plugin，否则行配置会盖住配置文件，改文件就测不出来了
                      { watch_interval_ms: 60000 }
                    : undefined // crash-file / genfile / gate-after-delete / gate-after-watchdog：走配置文件

if (mode === 'crash-file') {
  writeFileSync(configFile, JSON.stringify({ crash_plugin: ['dummy-forbidden'], watch_interval_ms: 1000 }, null, 2), 'utf8')
}
if (mode === 'gate-after-edit' || mode === 'gate-after-delete' || mode === 'gate-after-watchdog') {
  // 名单来自配置文件。edit 模式运行期把被禁插件写进去；delete 模式运行期把文件删掉；
  // watchdog 模式同样在运行期改文件，但不发事件、不调工具。
  const initial = mode === 'gate-after-delete' ? ['dshmarket'] : ['example-plugin']
  writeFileSync(configFile, JSON.stringify({ crash_plugin: initial, watch_interval_ms: mode === 'gate-after-watchdog' ? 2000 : 1000 }, null, 2), 'utf8')
}
if (mode === 'crash-report-unwritable') {
  // 在报告目录的位置放一个同名文件，让 mkdir/write 必然失败 —— 报告写不出来也必须崩
  writeFileSync(join(home, 'crash-reports'), 'not a directory\n', 'utf8')
}

const patches = [
  {
    insert: [
      { id: 'dummy-forbidden', name: pathToFileURL(dummyPath).href },
      ...(mode === 'version-hit' || mode === 'version-miss' ? [{ id: 'fake-plugin', name: pathToFileURL(fakeEntryPath).href }] : []),
      { id: 'allcrash', name: guardName, ...(rowConfig === undefined ? {} : { config: rowConfig }) },
    ],
  },
]

const appBoot = await import(pathToFileURL(join(DSH_APP, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)
const { boot, installFailLoud } = appBoot

// Desktop Host 进程在 boot 之前就是这样装的（host-process-entry.js 内同一句）
installFailLoud('allcrash-isolated-test', process)

const ctx = await boot('allcrash-isolated-test', join(scratch, 'cordis.yml'), patches)
console.log(`[isolated] mode=${mode} boot 完成，进程仍然活着`)

// 兜底计时器**必须在任何 await 之前**注册：命中路径返回的是永不 settle 的 promise，
// 一旦出现「闸门挂住但进程没死」的回归，后面的 await 会永远不返回 ——
// 那时也必须以 exit 3 报告失败，而不是让测试进程静默挂着。
const EXPECT_ALIVE = mode === 'clean' || mode === 'genfile' || mode === 'warn-loaded' || mode === 'deny-install' || mode === 'version-miss'
// gate-after-watchdog 必须等过完所有启动扫描（0/250/1000ms）再改配置，
// 否则会被 boot+Nms 那次扫描抓到，就证明不了看门狗
const backstopMs = mode === 'gate-after-watchdog' ? 6000 : 3000
setTimeout(() => {
  console.log(`[isolated] mode=${mode} 存活 ${backstopMs / 1000} 秒：没有触发崩溃`)
  process.exit(EXPECT_ALIVE ? 0 : 3)
}, backstopMs)

if (mode === 'genfile' && !existsSync(configFile)) {
  console.error('[isolated] genfile 模式应当生成默认配置文件，但它不存在')
  process.exit(5)
}

/** 模拟 agent 调用 plugin_manager：走真实的 tools/pre-execute waterfall */
async function pluginManagerGate(target, args) {
  const exec = {
    name: 'plugin_manager',
    callId: 'test',
    arguments: args ?? { action: 'install_bundle', target },
    signal: new AbortController().signal,
  }
  return ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
}

if (mode === 'crash-tool') {
  const decision = await pluginManagerGate('dshmarket@1.66.0')
  console.log('[isolated] waterfall 返回：', JSON.stringify(decision), '（若守卫生效，进程此时已经死了）')
}

if (mode === 'gate-after-edit') {
  // 运行期把被禁插件写进配置文件：不需要重启，下一次判定就该命中
  writeFileSync(configFile, JSON.stringify({ crash_plugin: ['dshmarket'], watch_interval_ms: 1000 }, null, 2), 'utf8')
  console.log('[isolated] 已把 dshmarket 写进配置文件，接着触发工具闸门')
  const decision = await pluginManagerGate('dshmarket')
  console.log('[isolated] waterfall 返回：', JSON.stringify(decision), '（改配置应立刻生效）')
}

if (mode === 'gate-after-delete') {
  // 运行期删掉配置文件：守卫必须 fail-closed（沿用上一次的有效名单），而不是退回默认占位符
  rmSync(configFile, { force: true })
  console.log('[isolated] 已删除配置文件，接着触发工具闸门')
  const decision = await pluginManagerGate('dshmarket')
  console.log('[isolated] waterfall 返回：', JSON.stringify(decision), '（删配置不应关掉守卫）')
}

if (mode === 'gate-after-watchdog') {
  // 不发任何事件、不调任何工具：等启动扫描全部过去之后再改配置，只能靠看门狗自己重扫发现
  await new Promise((resolve) => setTimeout(resolve, 1400))
  writeFileSync(configFile, JSON.stringify({ crash_plugin: ['dummy-forbidden'], watch_interval_ms: 2000 }, null, 2), 'utf8')
  console.log('[isolated] 启动扫描已过，已把 dummy-forbidden 写进配置文件，等看门狗自己扫到')
}

if (mode === 'late-mount') {
  // boot 之后才出现的插件：靠 plugin-manager/changed 事件驱动的重扫抓到（L2）
  await ctx.loader.create({ id: 'late-plugin', name: pathToFileURL(latePath).href })
  console.log('[isolated] 已把 late-plugin 挂进插件树，接着发 plugin-manager/changed')
  ctx.emit('plugin-manager/changed', { reason: 'install' })
}

if (mode === 'clean') {
  // 反向验证：无关的 plugin_manager 调用必须原样放行（waterfall 不能被守卫挂死）
  const decision = await pluginManagerGate('harmless-plugin')
  console.log('[isolated] 无关调用放行：', JSON.stringify(decision))
  if (decision?.kind !== 'allow') {
    console.log('[isolated] 放行失败，判定失败')
    process.exit(4)
  }
}

if (mode === 'deny-install') {
  // mode=deny：可拦动作直接拒绝，Host 必须活着
  const install = await pluginManagerGate('dshmarket@1.66.0')
  console.log('[isolated] 安装被禁插件 →', JSON.stringify(install))
  if (install?.kind !== 'deny') {
    console.error('[isolated] mode=deny 时安装被禁插件应当被 deny，实际：', JSON.stringify(install))
    process.exit(6)
  }
  const selfRemoval = await pluginManagerGate(undefined, { action: 'set_plugin', target: 'allcrash', enabled: false })
  console.log('[isolated] 关停守卫自身 →', JSON.stringify(selfRemoval))
  if (selfRemoval?.kind !== 'deny') {
    console.error('[isolated] mode=deny 时拆守卫自身应当被 deny，实际：', JSON.stringify(selfRemoval))
    process.exit(6)
  }
  // 无关调用仍要放行
  const allowed = await pluginManagerGate('harmless-plugin')
  if (allowed?.kind !== 'allow') {
    console.error('[isolated] deny 模式下无关调用被误拦：', JSON.stringify(allowed))
    process.exit(4)
  }
  console.log('[isolated] deny 模式：拒绝生效且 Host 存活')
}
