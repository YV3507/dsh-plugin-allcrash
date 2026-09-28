// dsh-plugin-allcrash —— 隔离模式 runner（带事后断言）
//
//   node test/run-modes.mjs
//
// 为什么需要它：光看退出码无法区分「守卫崩了」和「进程因为别的原因崩了」，
// 也发现不了「崩溃报告/ stderr 这些事后证据丢了但进程照样 exit 1」这类回归。
// 这里对每个模式断言：退出码 + 崩溃报告（数量、trigger、命中的名字）+ stderr 契约
// + 配置文件副作用。harness 自己被改坏（例如闸门挂住不崩）时以 exit 3 暴露。
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const harness = join(here, 'isolated-boot.mjs')

const RICKROLL = 'Never gonna give you up, never gonna let you down, Never gonna run around and desert you.'

/** 每个模式的期望。`trigger` 是崩溃报告里 trigger= 后面那段。 */
const CASES = [
  { mode: 'clean', exit: 0, alive: true },
  { mode: 'genfile', exit: 0, alive: true, defaultConfig: ['example-plugin'] },
  { mode: 'crash-row', exit: 1, trigger: 'boot+0ms', name: 'dummy-forbidden' },
  { mode: 'crash-file', exit: 1, trigger: 'boot+0ms', name: 'dummy-forbidden' },
  { mode: 'crash-tool', exit: 1, trigger: 'tools/pre-execute:install-attempt', name: 'dshmarket' },
  { mode: 'gate-after-edit', exit: 1, trigger: 'tools/pre-execute:install-attempt', name: 'dshmarket' },
  { mode: 'gate-after-delete', exit: 1, trigger: 'tools/pre-execute:install-attempt', name: 'dshmarket', rewrittenConfig: ['dshmarket'] },
  { mode: 'gate-after-watchdog', exit: 1, trigger: 'watchdog', name: 'dummy-forbidden' },
  { mode: 'late-mount', exit: 1, trigger: 'plugin-manager/changed', name: 'late-plugin' },
  { mode: 'crash-report-unwritable', exit: 1, noReport: true, stderrIncludes: 'crash report write failed / 崩溃报告写入失败' },
]

const root = join(tmpdir(), 'allcrash-run-modes')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0

for (const testCase of CASES) {
  const { mode } = testCase
  const runDir = join(root, mode)
  mkdirSync(runDir, { recursive: true })
  const stderrPath = join(runDir, 'stderr.txt')
  closeSync(openSync(stderrPath, 'w')) // 先建空文件，随后由 harness 追加

  const result = spawnSync(process.execPath, [harness, mode], {
    cwd: packageRoot,
    env: { ...process.env, ALLCRASH_TEST_DIR: runDir, ALLCRASH_STDERR_FILE: stderrPath },
    // 不用管道：本仓库的开发沙箱会拒绝 Node 创建管道（EPERM），文件采集已经覆盖 stderr
    stdio: ['ignore', 'ignore', 'ignore'],
  })

  const problems = []
  const home = join(runDir, 'home')
  const reportDir = join(home, 'crash-reports')
  // crash-report-unwritable 模式下 crash-reports 是一个**文件**（故意占位），
  // 所以这里必须先确认它是目录再列目录
  let reports = []
  try {
    if (existsSync(reportDir) && statSync(reportDir).isDirectory()) {
      reports = readdirSync(reportDir).filter((file) => file.endsWith('.txt'))
    }
  } catch {
    reports = []
  }
  const stderrText = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : ''
  const configPath = join(home, 'allcrash.json')

  if ((result.status ?? -1) !== testCase.exit) {
    problems.push(`退出码 ${result.status} != 期望 ${testCase.exit}`)
  }

  if (testCase.alive === true) {
    if (reports.length > 0) problems.push(`本应存活，却写了 ${reports.length} 份崩溃报告`)
    if (stderrText.includes('fatal uncaught exception')) problems.push('本应存活，stderr 却出现 fail-loud 致命诊断')
  } else {
    if (testCase.noReport === true) {
      if (reports.length > 0) problems.push(`报告本应写不出来，却出现 ${reports.length} 份`)
    } else if (reports.length !== 1) {
      problems.push(`崩溃报告数量 ${reports.length} != 1（事后证据缺失或多写）`)
    }
    // stderr 契约：这几行是「真的走了引爆序列」的证据，而不只是进程退出了
    for (const needle of ['==== allcrash ====', RICKROLL, 'allcrash detected a forbidden plugin:', 'terminating the DSH Host process']) {
      if (!stderrText.includes(needle)) problems.push(`stderr 缺少契约行：${needle}`)
    }
    if (testCase.noReport === true) {
      if (!stderrText.includes(testCase.stderrIncludes)) problems.push(`stderr 缺少：${testCase.stderrIncludes}`)
    } else if (!stderrText.includes('crash report: ')) {
      problems.push('stderr 未写出崩溃报告路径')
    }
  }

  if (reports.length === 1) {
    const text = readFileSync(join(reportDir, reports[0]), 'utf8')
    if (testCase.trigger && !text.includes(`trigger=${testCase.trigger}`)) {
      problems.push(`报告里的 trigger 不是 ${testCase.trigger}`)
    }
    if (testCase.name && !text.includes(testCase.name)) {
      problems.push(`报告里没有出现命中的名字 ${testCase.name}`)
    }
    if (!text.includes('---- DSH Crash Report ----')) problems.push('报告缺少头部')
    if (!text.includes('Recovery')) problems.push('报告缺少 Recovery 段')
  }

  if (testCase.defaultConfig) {
    if (!existsSync(configPath)) {
      problems.push('未生成默认配置文件')
    } else {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (JSON.stringify(parsed.crash_plugin) !== JSON.stringify(testCase.defaultConfig)) {
        problems.push(`默认 crash_plugin 是 ${JSON.stringify(parsed.crash_plugin)}`)
      }
    }
  }

  if (testCase.rewrittenConfig) {
    if (!existsSync(configPath)) {
      problems.push('配置文件删除后没有被回写（fail-closed 失效）')
    } else {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (JSON.stringify(parsed.crash_plugin) !== JSON.stringify(testCase.rewrittenConfig)) {
        problems.push(`回写的 crash_plugin 是 ${JSON.stringify(parsed.crash_plugin)}，期望 ${JSON.stringify(testCase.rewrittenConfig)}`)
      }
    }
  }

  if (problems.length === 0) {
    console.log(`ok   ${mode}`)
  } else {
    failed += 1
    console.log(`FAIL ${mode}`)
    for (const problem of problems) console.log(`       - ${problem}`)
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} 模式通过`)
process.exit(failed === 0 ? 0 : 1)
