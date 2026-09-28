# dsh-plugin-allcrash

[![test](https://github.com/YV3507/dsh-plugin-allcrash/actions/workflows/test.yml/badge.svg)](https://github.com/YV3507/dsh-plugin-allcrash/actions/workflows/test.yml)

DSH 的「禁止插件」守卫：名单里的插件一旦**被加载、被启用，或被尝试安装**，
DSH Host 进程立刻崩溃，并留下崩溃报告。

- **零依赖**：只用 Node 内建模块，不需要构建步骤、不需要安装任何包
- **Host 插件**（Cordis bundle）：Windows / macOS / Linux 同一份代码
- **判定与副作用分离**：判定逻辑可离线单测，崩溃链路可在隔离子进程里端到端复现
- 设计参考 Minecraft Forge 模组 [allcrash](https://github.com/mingzi94387355/allcrash)

**运行要求**：适用于以 `@deepseek-ai/dsh-app-boot` 的 `boot()` 启动 Host 的环境
（DSH Desktop 与 `dsh` CLI 都是）。崩溃优先走 boot 时安装的 fail-loud；
若环境未安装它，由插件内置的 3 秒兜底 `process.exit(1)` 接管。

---

## 它解决什么

「这个插件不许出现在我的 profile 里」通常是口头约定或人工检查，容易漏。
本插件把这条约定变成机器执行的硬约束：命中即崩，且不给被禁操作留执行窗口。

## 与原型 allcrash 的对应关系

原型是 Forge 模组：`crash_mod = ["examplemod"]` 里的模组被加载时抛异常，游戏崩在启动阶段
并写出 `crash-reports/`；服务端还会把同一份名单下发给连进来的客户端并要求回执，
使「删掉检查器」失去意义。本插件把同一套语义搬到 DSH：

| 原型（Forge） | 本插件（DSH） |
| --- | --- |
| `config/allcrash-common.toml` 的 `crash_mod` | `${DSH_HOME}/allcrash.json` 的 `crash_plugin`（首次运行生成默认值） |
| `ModList.get().isLoaded(name)` | `ctx.loader.entries()`、插件声明名、agent-preset composition 行 |
| 客户端加载完成时检查 | 启动扫描（boot 后 0/250/1000ms）+ 周期性看门狗 |
| 服务端下发名单、不回执则踢出 | `tools/pre-execute` 拦截 `plugin_manager`：安装/启用被禁插件，或关停守卫自身 → 立即崩 |
| `throw new RuntimeException(...)` 导致游戏崩溃 | 未捕获异常 → DSH 的 fail-loud → `process.exit(1)` |
| `crash-reports/crash-*.txt` | `${DSH_HOME}/crash-reports/allcrash-<本地时间>-<pid>.txt` |

## 安装

```
# 从 GitHub 安装（pnpm 的 github: spec；live profile 安装后立即生效，startup profile 需重启）
plugin_manager  action=install_bundle  target=github:YV3507/dsh-plugin-allcrash
dsh plugin --profile <profile> add github:YV3507/dsh-plugin-allcrash

# 从本地目录安装（开发/自用；本文档的测试矩阵就是按这个形态跑的）
plugin_manager  action=install_bundle  target=<本目录绝对路径>
dsh plugin --profile <profile> add <本目录绝对路径>
```

安装后：插件清单中出现 `dsh-plugin-allcrash`（enabled），并在首次运行时生成默认配置
`${DSH_HOME}/allcrash.json`。默认名单是占位符 `["example-plugin"]`，**此时不会有任何崩溃**。

## 配置

`${DSH_HOME}/allcrash.json`（默认即 `~/.dsh/allcrash.json`）：

> 生效范围是 **DSH_HOME**（同一台机器上的所有 profile 共用这一份名单与审计日志）。
> 需要某个 profile 用不同的名单时，在那个 profile 的 composition 行里写 `config`（行配置优先级更高），
> 见下。

```json
{
  "crash_plugin": [
    "example-plugin",
    "dshmarket@1.66.0",
    "bad-plugin@<2.0.0",
    { "name": "risky-plugin", "version": ">=2.0.0", "mode": "deny", "reason": "2.x 会改数据格式" }
  ],
  "mode": "crash",
  "crash_message": "Never gonna give you up, never gonna let you down, Never gonna run around and desert you.",
  "crash_on_install_attempt": true,
  "crash_on_install_log": false,
  "guard_self_removal": true,
  "self_entry_ids": ["allcrash"],
  "self_package": "dsh-plugin-allcrash",
  "watch_interval_ms": 5000,
  "include_disabled": false,
  "audit_log": true
}
```

改动会在下一次扫描（默认 ≤ 5 秒）被读到，**无需重启**。
生成的默认文件里还有三个下划线开头的说明字段（`_readme` / `_encoding` / `_keys`），仅作文档用途，不影响解析。

### 名字与版本

`crash_plugin` 的每个元素可以是字符串或对象：

| 写法 | 语义 |
| --- | --- |
| `"evil-plugin"` | 整个插件（支持 `*` / `?` 通配，大小写不敏感） |
| `"dshmarket@1.66.0"` | **精确版本** |
| `"bad-plugin@<2.0.0"` | 版本约束：`= > >= < <= ^ ~`，空格/逗号分隔可组合（`">=1.0.0 <2.0.0"`） |
| `{ name, version?, mode?, reason? }` | 对象形式：可按条目覆盖响应模式，`reason` 会写进崩溃报告与 deny 原因 |

名字可以写**包名**（`dshmarket`、`@scope/pkg`）、**loader 行 id**（`ui-chat`）、或**插件声明名**；
带版本时只看**最后一个 `@`**，所以 `@scope/pkg@^1.2.0` 能正确拆成 `@scope/pkg` + `^1.2.0`。
版本比较是零依赖的 semver 近似（`^1.2.3` → `>=1.2.3 <2.0.0`；`^0.2.3` → `>=0.2.3 <0.3.0`；裸 `1.2` → `>=1.2.0 <1.3.0`；
不支持 `||` 与 `-` 区间）。

**版本拿不到时不算命中**（fail-open），并在日志与审计里留下 `policy-note`：版本判错的代价是 Host 启动循环，
漏检一次的代价小得多 —— 而插件真装上来之后，下一次扫描会拿到确切版本再判。各通道能拿到的版本信息：

| 通道 | 版本来源 |
| --- | --- |
| 安装尝试（L1） | 请求 spec 里的版本（`pkg@1.66.0`）。请求不带版本时无法判定 → note，装完后由扫描兜住 |
| bundle / 已装插件 | `<profile>/node_modules/<包名>/package.json` 的 `version`（`link:` 依赖读到的就是真实目录的版本） |
| 路径 / `file://` 行 | 从模块文件往上找最近的 `package.json` |
| agent preset 行 / 安装日志 | 拿不到版本 → 带版本约束的条目在这里只回报 note |

### 响应分层（`mode`）

命中之后做什么，由全局 `mode` 或条目上的 `mode` 决定（取更严格者）：

| 值 | 安装 / 启用 / 拆守卫（可拦动作） | 已加载的插件 |
| --- | --- | --- |
| `crash`（默认） | 崩 Host | 崩 Host |
| `deny` | **拒绝该工具调用**（返回 `deny` + 原因），Host 存活 | 无法"拦"，退化为 `warn` |
| `warn` | 只告警，放行（dry-run） | 只告警 + 审计 |

- `warn` 用于**编写阶段**：先把名单当 dry-run 跑起来，看"如果上膛会崩在谁身上"。命中会写一份完整诊断到
  `${DSH_HOME}/.allcrash/would-crash-<时间>-<pid>.txt`（刻意不写进 `crash-reports/`，那个目录的语义是"真的崩过"），
  并在审计里记 `would-crash`。同一个违规只记一次，不会每 5 秒刷一份。
- `deny` 用于**发行/日常**：拦得住的动作就不用崩 —— 安装、启用、拆守卫都被拒绝且会话不丢；
  插件已经加载时没有"可拦的动作"，此时 `deny` 退化为 `warn`（要么显式改成 `crash`，要么把它卸掉）。
- 审计日志里有三种可 grep 的动词：`CRASH`（崩了）、`would-crash`（dry-run 命中）、`DENY`（拒绝了动作）。

对这份文件的两个刻意行为（都是为了「把配置文件删掉就等于关掉守卫」这类绕过不成立）：

- **删文件 ≠ 关守卫**：曾经读到过名单、之后文件消失时，插件会沿用上一次的有效名单、把它写回去并在日志里告警。
  要停用守卫请显式写 `"crash_plugin": []`。
- **改坏不生效也不静默**：解析失败或类型写错时沿用上一次的有效配置并告警（不会退回默认的占位符名单）。

也可以写在 composition 行里 —— 优先级高于配置文件，但带 `config` 的行只在启动时合成，需要重启：

```yaml
- insert:
    - id: allcrash
      name: 'dsh-plugin-allcrash'
      config:
        crash_plugin: ['dshmarket']
```

### 配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `crash_plugin` | `["example-plugin"]` | 禁止名单（名字 / 名字@版本 / 对象条目，见上）。`[]` 表示确实不禁止任何插件；写成非数组时该项被忽略并告警（不会因此把守卫关掉） |
| `mode` | `crash` | 命中后的响应：`crash` / `deny` / `warn`，见「响应分层」 |
| `crash_message` | 原型那句歌词 | 崩溃信息开头的一句 |
| `crash_on_install_attempt` | `true` | `plugin_manager install_bundle` 目标命中时，**在 pnpm 启动之前**就处理（按 `mode` 决定拒绝还是崩溃，profile 不会被动过）。同理拦截 `set_bundle` / `set_plugin` / `set_version_exemption` 里 `enabled: true` 的被禁目标 |
| `crash_on_install_log` | `false` | 额外监听 pnpm 输出，覆盖不经工具的安装通道（Web 市场 / CLI）；见「已知行为」第 5 条 |
| `guard_self_removal` | `true` | 禁止通过 `plugin_manager` 关停或卸载守卫自身 |
| `self_entry_ids` | `["allcrash"]` | 守卫自身的 loader 行 id，用于识别「有人要拆我」 |
| `self_package` | `dsh-plugin-allcrash` | 守卫自身的包名 |
| `watch_interval_ms` | `5000` | 看门狗扫描间隔（最小 250ms） |
| `include_disabled` | `false` | 行存在但被 `disabled` 是否也算命中（原型只看「已加载」）。loader 行与 agent preset 行同一语义 |
| `audit_log` | `true` | 写 `${DSH_HOME}/.allcrash/watch.log` |

配置写错类型时，出错的项会被忽略并打印告警，**守约会保持上一层（更严格）的取值**；
告警过的同一组问题不会重复刷屏，最终也会随崩溃报告一起写出（`config_problems`）。

## 检测通道

| | 触发点 | 覆盖场景 |
| --- | --- | --- |
| **L1** | `tools/pre-execute`（工具执行**之前**） | `plugin_manager` 安装 / 启用被禁插件，或关停、卸载守卫自身。命中时**不把控制权交回工具链**，被禁操作没有任何继续执行的机会 |
| **L2** | `plugin-manager/changed`、`plugin-manager/install-state`、`app-boot/config-reload`、`hmr/reload` | 任何来源（Web 界面、CLI、市场）改动 profile 后立刻重扫 |
| **L3** | 看门狗（默认 5s）+ 启动扫描 | 手工编辑 patch 而不触发事件的路径 |
| **L4** | `agentPresets.compositionInventory()` | 挂在 agent preset 里的行（它们不在 loader 树上）。`enabled: false` 的行同样跳过，`'conditional'` 行按「可能被加载」计并把 condition 写进报告 |
| **L5** | `plugin-manager/install-log` | 可选：pnpm 输出里出现被禁名字即崩 |

判定同时比对三个名字：**模块标识符**（包名，或 profile 里写的路径 / URL）、**loader 行 id**、
**插件声明名**（`fiber.runtime.name`）。三者任一命中即算。

## 崩溃是怎么发生的

```
命中
 ├─ 写崩溃报告    ${DSH_HOME}/crash-reports/allcrash-<本地时间>-<pid>.txt
 ├─ stderr 输出   原型那句歌词 + 英文摘要 + 报告路径
 ├─ process.nextTick(() => { throw AllCrashError })
 │      DSH Host 在 boot 之前就装了 fail-loud（@deepseek-ai/dsh-app-boot 的 installFailLoud）：
 │      任何未捕获异常 / 未处理拒绝 → stderr 一行诊断 → release() → process.exit(1)
 └─ 兜底          3 秒后无论如何 process.exit(1)（该定时器不属于插件上下文，不会被 disposer 清掉）
```

Host 是 Electron 的 utility process，退出后 Desktop 会显示
`DSH Host exited (1); restart the application to reconnect`。

> 以上是 `mode: crash`（默认）的路径。`mode: warn` 只写诊断与审计、`mode: deny` 直接拒绝可拦的动作，
> 两者都不会杀进程 —— 见上面的「响应分层」。

崩溃报告节选（格式参照 Minecraft 的 `crash-reports/`）：

```
---- DSH Crash Report ----
// allcrash 检测到被禁止的插件 / forbidden plugin detected

Time: 2026-01-02T03:04:05.678Z
Local time: 2026-01-02 11:04:05 (UTC+08:00)
Description: allcrash 在 boot+0ms 时检测到被禁插件：dshmarket

Detected
========
  - dshmarket [dshmarket] (entry id: bundle-dshmarket, phase: active, enabled: true, matched: "dshmarket")

Plugin tree
===========
  ...
Environment
===========
  ...
allcrash
=========
  ...
Recovery
========
  ...
Stacktrace
==========
  ...
```

各段内容：`Detected` 命中的行与命中的模式；`Plugin tree` 崩溃时刻的完整插件树
（行 id / 模块 / 声明名 / 阶段 / 是否 disabled）；`Environment` DSH_HOME、profile、node、os、
homedir、cwd、`path.sep`；`allcrash` 版本、配置文件路径、生效名单、触发通道；
`Recovery` 恢复步骤；`Stacktrace` 抛出点。

## 跨平台

**路径**

- 两种分隔符（`/` 与 `\`）、盘符、UNC（`\\server\share\...`）、`file://` URL（含 `%20` 百分号编码）
  都能正确归一化后再比对，不会因为写法的平台差异漏检
- 家目录解析与 `@deepseek-ai/dsh-home-paths` 同一套规则：`$DSH_HOME`（空或纯空白视为未设置）→ `~/.dsh`，
  支持 `~`、`~/`、`~\` 展开，结果统一为宿主平台的绝对路径（不手写分隔符）
- 崩溃报告文件名只含数字、短横、下划线，规避 Windows 非法字符（`: * ? " < > |`）

**编码**

- 配置文件按 UTF-8 读取，**容忍 BOM 与 CRLF**（Windows 上 PowerShell 5.1 的
  `Set-Content -Encoding utf8`、部分编辑器会写入 BOM）
- stderr 上供机器解析的行全部是 ASCII（`allcrash detected a forbidden plugin: …`、
  `crash report: …`、`terminating the DSH Host process`），因此 Windows 控制台代码页
  （cp936 / cp437）不会影响日志检索；完整中文细节留在 UTF-8 的崩溃报告里

**匹配语义**

- 大小写不敏感：npm 包名本就只允许小写，包名维度没有损失；路径维度在大小写敏感的文件系统上
  会把 `Foo` 与 `foo` 视为同一个名字 —— 需要精确时用 `*` / `?` 自行收窄

## 恢复与卸载

**从崩溃中恢复**（最快）：编辑 `${DSH_HOME}/allcrash.json`，把命中的插件名（或版本约束）改掉，重启 DSH。
不确定会崩在谁身上时，先把 `mode` 改成 `warn`：命中只告警 + 落诊断，Host 照常可用。

**彻底卸载守卫**：需手工改文件 —— 守卫会拦住经 `plugin_manager` 对自身的关停与卸载（设计如此）：

1. 编辑 `profiles/<profile>/package.json`，从 `dsh.profile.bundles` 与 `dependencies` 里删掉 `dsh-plugin-allcrash`
2. 若你曾手工在 `profiles/<profile>/cordis.patch.yml` 里写过 `allcrash` 行，一并删掉
3. 重启 DSH

## 测试

```bash
npm test                        # 离线单测 + 全部隔离模式（推荐）
node test/unit.test.mjs         # 只跑离线单测：判定、匹配、路径、配置、报告、引爆器
node test/run-modes.mjs         # 只跑隔离模式：断言退出码 + 崩溃报告 + stderr 契约 + 配置副作用
```

隔离模式（`node test/isolated-boot.mjs <mode>`，调试单个场景时用）：

| 模式 | 覆盖 | 期望 |
| --- | --- | --- |
| `clean` | 树里有无关插件 + 无关 `plugin_manager` 调用 | exit 0，且不产生报告 |
| `genfile` | 首次运行应生成默认配置 | exit 0 + 生成 `allcrash.json` |
| `crash-row` / `crash-file` | 启动扫描（行配置 / 配置文件两种来源） | exit 1，报告 `trigger=boot+0ms` |
| `crash-tool` | L1 工具闸门：模拟安装被禁插件 | exit 1，报告 `trigger=tools/pre-execute:install-attempt` |
| `gate-after-edit` | 运行期改配置文件 | exit 1（无需重启即生效） |
| `gate-after-delete` | 运行期删配置文件 | exit 1 + 配置文件被回写（fail-closed） |
| `gate-after-watchdog` | 运行期改配置、不发事件不调工具 | exit 1，报告 `trigger=watchdog` |
| `late-mount` | boot 之后才挂进树的插件（L2 事件通道） | exit 1，报告 `trigger=plugin-manager/changed` |
| `crash-report-unwritable` | 报告目录不可写 | exit 1 + stderr 出现 `crash report write failed` |
| `warn-loaded` | `mode: warn` + 被禁插件已加载 | exit 0 + 落一份 `would-crash` 诊断 + 审计 |
| `deny-install` | `mode: deny`：安装被禁插件 / 拆守卫自身 | exit 0，waterfall 返回 `deny`，Host 存活 |
| `version-hit` | 已装版本满足 `fake-plugin@<2.0.0` | exit 1，报告含已装版本与约束 |
| `version-miss` | 已装版本不满足 `fake-plugin@>=2.0.0` | exit 0（不该命中） |

退出码约定：`0` 存活（符合预期）、`1` 崩溃（符合预期）、`2` 环境/路径问题、`3` **该崩却活下来了**、
`4` 无关调用没有被放行、`5` 该生成的默认配置没生成。

隔离测试用真实 Cordis Loader 与真实 fail-loud，在**子进程**里起一棵只含
「一个假插件 + allcrash」的树，`DSH_HOME` 指向临时目录，不会影响正在运行的 DSH 实例。
`test/run-modes.mjs` 会为每个模式单独准备临时目录，并断言崩溃报告的数量、`trigger`、命中的名字、
stderr 契约行与配置文件副作用 —— 只断言退出码是不够的：报告或 stderr 丢了、或者进程因为别的原因
退出，都会得到同样的 `exit 1`。

环境变量（非默认安装位置或需要换临时目录时）：

| 变量 | 用途 |
| --- | --- |
| `DSH_APP_ROOT` | DSH 安装目录（含 `node_modules/@deepseek-ai/dsh-app-boot`）；隔离测试用它定位 `boot()` |
| `ALLCRASH_TEST_DIR` | 隔离测试的临时目录；默认在包目录下的 `.isolated/`，包目录只读时指向可写位置 |
| `ALLCRASH_STDERR_FILE` | 由 runner 设置：把子进程 stderr 复制一份到该文件，供断言（用文件而非管道，避免沙箱拒绝管道） |

## 源码结构

```
dsh-plugin-allcrash/
├─ package.json            bundle 清单（dsh.bundle.patch + 显示元数据）
├─ cordis.patch.yml        纯 insert 行（可热挂载；被禁名单放配置文件）
├─ icon.svg / locale/      插件管理页的图标与标题
├─ lib/
│  ├─ index.js             入口：只转出 name / inject / apply
│  ├─ paths.js             跨平台路径策略（$DSH_HOME → ~/.dsh，宿主平台 join/resolve）
│  ├─ guard.js             纯判定：策略条目（名字/版本/模式）、版本约束、通配匹配、五个通道、报告文本
│  ├─ detonate.js          引爆（写报告 → stderr → 抛出 → 兜底 exit(1)）与 dry-run 诊断
│  └─ plugin.js            接线：配置读写、版本解析、响应分层、五条通道、看门狗、审计日志
└─ test/
   ├─ unit.test.mjs        离线单测（零依赖，node 直接跑；含跨平台与穷举差分用例）
   ├─ isolated-boot.mjs    隔离端到端（真 Loader + 真 fail-loud，14 个模式）
   └─ run-modes.mjs        模式 runner：断言退出码 + 崩溃报告 + dry-run 诊断 + 审计 + 配置副作用
```

## 实现说明（给维护者）

- **零包依赖**是硬约束：插件以 `link:` 方式装进 profile 时按真实路径解析，
  插件目录下没有 `node_modules`，任何 `import '@deepseek-ai/...'` 都会让插件加载失败。
  因此只用 `node:` 内建模块。
- **不导出 schemastery `Config`**：配置用「原样透传的普通对象」+ 一个 JSON 配置文件。
  `@deepseek-ai/cordis` 的 `resolveConfig` 在插件没有 `Config` 时把原始 config 直接交给 `apply`，
  这样既零依赖，又让「改配置即时生效、不必重启」成为可能。
- **诊断走宿主 `ctx.logger`，不走 `console.log`**：Desktop 的日志文件只收 logger 的记录
  （宿主子进程的 stdout 只是被转发，不进日志文件），而 ACP 模式下 stdout 就是 JSON-RPC 的
  ND-JSON 线，往它写日志会污染协议。配置降级事件（解析失败、文件消失被回写、类型写错…）
  同时写入 `${DSH_HOME}/.allcrash/watch.log`，这样「改了配置却没生效」有迹可查。
- **引爆链路每一步都做了兜底**：报告正文生成、每一行 stderr、以及两条致命通道
  （异步抛出 / 超时 `exit(1)`）都不会因为前一步出错而被跳过；组装 incident 失败时退化成
  只依赖 `process` 事实的最小报告。守卫可以「死得难看」，但不能「不死」。
- 判定逻辑（`guard.js`）与副作用（`detonate.js`、`plugin.js`）分离，所以匹配/版本/配置/报告
  可以用 `node test/unit.test.mjs` 在没有 Harness 的情况下完整测。

## 已知行为与边界

1. **默认（`mode: crash`）一配即崩，且重启后仍会崩**：名单里若有当前已加载的插件，最多一个扫描周期内
   Host 退出；由于该插件仍在 profile 里，重启后会再次崩。这是本插件的语义（同原型）——
   不想被它锁住就先 `mode: "warn"` 试名单，或用 `mode: "deny"` 只拦动作。处理办法见「恢复与卸载」。
2. **Host 侧代码改动需要重启才生效**（`lib/*.js` 不在 HMR 范围）；配置文件改动不需要重启。
3. 守卫会拦住经 `plugin_manager` 对自身的关停与卸载（`guard_self_removal`）——`mode: deny` 下是拒绝，
   其它模式下是崩溃。
4. 检查的是**被加载的行**，不是「node_modules 里存在」：装了但未被选中、或已 `disabled` 的插件
   不算命中（可用 `include_disabled` 改变）。
5. `crash_on_install_log` 默认关闭：它可能在 pnpm 运行中途触发，代价是 profile 的
   `package.json` / `pnpm-lock.yaml` 可能停在中间状态。工具安装路径（L1）没有这个问题 ——
   它在 pnpm 启动之前就拦下了。
6. L1 命中且走 `crash` 时不把控制权交回工具链：被禁的安装 / 启用 / 拆除不会被继续执行。
7. 审计日志每次扫描写一行，自动截断到最近 200 行 / 64KiB。
8. 崩溃报告写不出来（目录不可写/被同名文件占位）时仍然会崩 —— 只是少一份事后证据，
   stderr 上会明确写出 `crash report write failed`。
9. **版本约束在拿不到版本时不生效**（fail-open，会在日志/审计里留 `policy-note`）：
   覆盖不到的是「`link:` 装的插件被就地改版本」「agent preset 行」「pnpm 安装日志」这几种情况；
   插件真装上来后，下一次扫描会拿到确切版本再判。
10. 版本比较是**近似 semver**（见「名字与版本」），不支持 `||` 与 `-` 区间；比较符配部分版本按补零处理
    （`>1.2` 等价 `>1.2.0`，与 npm 的 `>=1.3.0` 不同）。

## 致谢与许可

- 设计参考：[mingzi94387355/allcrash](https://github.com/mingzi94387355/allcrash)（MIT）—— 本插件是独立实现，与原型作者无隶属关系
- 许可：[MIT](LICENSE) © 2026 YV3507
