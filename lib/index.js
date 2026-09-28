// dsh-plugin-allcrash —— bundle 入口。
//
// DSH 的 bundle 加载器读取本模块的具名导出（name / inject / apply）。
// 真正的实现放在 lib/plugin.js + lib/guard.js + lib/detonate.js，
// 保持真实模块结构（判定逻辑可被 node --test 直接 import）。
export { inject, name, apply, PLUGIN_VERSION } from './plugin.js'
export { default } from './plugin.js'
