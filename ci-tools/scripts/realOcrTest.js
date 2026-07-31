#!/usr/bin/env node
/**
 * realOcrTest.js — 真 OCR 集成测试（端到端，不依赖 mock）
 *
 * 流程：
 *   1. 读 fixtures/alipay_bill_detail.jpg → base64 data URI
 *   2. 调 CloudBase visionProbe 云函数（传新 prompt），喂真图 + 真模型
 *   3. 解析返回 + 断言：amount≈76.80、category∈{娱乐,其他}、date 含 '2026-07-31'
 *
 * 运行：
 *   node ci-tools/scripts/realOcrTest.js
 *   node ci-tools/scripts/realOcrTest.js --prompt old   # 用旧 prompt 对比
 *
 * 前置：
 *   - 装 tcb CLI：npm i -g @cloudbase/cli
 *   - tcb CLI 已登录（cloudbase login 或 env 有 TENCENTCLOUD_SECRETID/KEY）
 *   - visionProbe 已部署到 env=seclog-d1g8no5pc45e643aa
 *
 * 注意：
 *   - 调一次约 4-15s + 模型 token 费用（生产 CloudBase 资源包已购）
 *   - 失败不抛 exit code 非零，仅打印诊断（CI 不阻塞；想 strict 加 --strict）
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// ====== 配置 ======
const ENV_ID = 'seclog-d1g8no5pc45e643aa'
const FN_NAME = 'visionProbe'
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'alipay_bill_detail.jpg')
const STRICT = process.argv.includes('--strict')
const USE_OLD_PROMPT = process.argv.includes('--prompt=old') || process.argv.includes('--prompt') && process.argv[process.argv.indexOf('--prompt') + 1] === 'old'

// ====== 1. 读 fixture + 编码 ======
function loadFixture() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`❌ Fixture 不存在：${FIXTURE}`)
    console.error('   应在 ci-tools/fixtures/alipay_bill_detail.jpg（git 已跟踪）')
    return null
  }
  const buf = fs.readFileSync(FIXTURE)
  const b64 = buf.toString('base64')
  return `data:image/jpeg;base64,${b64}`
}

// ====== 2. 构造 prompt ======
const NEW_PROMPT = [
  '你是一个消费凭证识别助手。识别用户上传的消费图片（小票/发票/支付宝/微信账单详情页/银行 APP 交易截图等），提取记账需要的字段。',
  '',
  '⚠️ 关键识别规则（按重要性排序）：',
  '1. 金额（amount）：页面里【最大、最显眼、居中显示的数字】，通常带 ¥ 符号或负号（-）。',
  '   - 忽略：时间里的数字（如 20:01:23）、订单号/交易号、积分（5积分）、抵扣券金额（0.5元话费券）、状态文字（交易成功）。',
  '   - 若是支付宝/微信 APP 的「账单详情」界面，金额就是顶部大字号、带「-」号的数字（如 -76.80 → 76.80）。',
  '   - 若是小票/发票，找「合计/应付/总计/实付/金额」旁边的数字，不要拿「单价/数量」。',
  '2. 商家（merchant）：从「商品说明」「收款方」「商户名称」「商家」等标签旁的字段提取，',
  '   - 不要拿界面顶部的页面标题（如「账单详情」「交易记录」）。',
  '   - 若是小票，取抬头店名。',
  '   - 若是支付宝详情，取「商品说明」字段。',
  '3. 类别（category）：从以下枚举选最接近的一个：餐饮、交通、购物、居家、医疗、娱乐、教育、其他。',
  '   - 电影院/演唱会/景点/游戏 → 娱乐',
  '   - 餐饮店/外卖/咖啡 → 餐饮',
  '   - 加油站/打车/公交 → 交通',
  '4. 日期（date）：优先用「支付时间/交易时间/消费时间」字段（YYYY-MM-DD）。',
  '   - 不要用界面顶部的手机状态栏时间（20:10）。',
  '   - 无法识别时返回 ""。',
  '',
  '以 JSON 返回（不要任何额外解释、不要代码块包裹）：',
  '1. amount: 总金额（数字，如 45.5）。若无法确认金额返回 null。',
  '2. merchant: 商家/收款方名称（字符串）。无法识别返回 ""。',
  '3. category: 消费类别，从枚举选一个。',
  '4. date: 消费日期（YYYY-MM-DD），无法识别返回 ""。',
  '只输出一个 JSON 对象。',
].join('\n')

const OLD_PROMPT = '识别这张小票，返回JSON {amount,merchant,category,date}。category从[餐饮,交通,购物,居家,医疗,娱乐,教育,其他]选。'

// ====== 3. 调 visionProbe（tcb CLI） ======
function invokeVisionProbe(imageUrl, prompt) {
  // tcb cli 路径探测
  const candidates = [
    'cloudbase',                          // 全局 PATH
    'npx cloudbase',                      // npx fallback（首次会下载）
    'cloudbase.cmd',                      // Windows
    path.join(process.env.APPDATA || '', 'npm', 'cloudbase.cmd'),
  ]
  for (const cmd of candidates) {
    const trySpawn = cmd.startsWith('npx ')
      ? spawnSync(cmd.split(' ')[0], [...cmd.split(' ').slice(1), '--version'], { encoding: 'utf8', shell: true })
      : spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: true })
    if (trySpawn.status === 0) {
      const bin = cmd.startsWith('npx ') ? 'npx cloudbase' : cmd
      console.log(`📦 用 tcb CLI：${bin}`)
      const params = JSON.stringify({ imageUrl, prompt })
      const res = spawnSync(bin, [
        'functions:invoke', FN_NAME,
        '--e', ENV_ID,
        '--params', params,
      ], { encoding: 'utf8', shell: true, maxBuffer: 50 * 1024 * 1024 })
      return { stdout: res.stdout, stderr: res.stderr, status: res.status }
    }
  }
  return null
}

// ====== 4. 解析 + 断言 ======
function extractJsonFromOutput(text) {
  if (!text) return null
  // tcb CLI 输出格式：{ "Result": "...", "Data": "..." } 或纯 JSON
  // 我们找最外层 {amount,merchant,category,date} 块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1]
  const brace = text.match(/\{[\s\S]*?"amount"[\s\S]*?\}/)
  if (brace) {
    try { return JSON.parse(brace[0]) } catch (e) { /* fallthrough */ }
  }
  return null
}

function assert(actual, expected, label, failures) {
  const ok = actual === expected || (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 0.01)
  console.log(`  ${ok ? '✓' : '✗'} ${label}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
  if (!ok) failures.push({ label, expected, actual })
}

function assertIn(actual, allowed, label, failures) {
  const ok = allowed.includes(actual)
  console.log(`  ${ok ? '✓' : '✗'} ${label}: 期望 ∈ ${JSON.stringify(allowed)}, 实际 ${JSON.stringify(actual)}`)
  if (!ok) failures.push({ label, expected: `∈ ${JSON.stringify(allowed)}`, actual })
}

function assertContains(haystack, needle, label, failures) {
  const ok = typeof haystack === 'string' && haystack.includes(needle)
  console.log(`  ${ok ? '✓' : '✗'} ${label}: 期望包含 "${needle}", 实际 "${String(haystack).slice(0, 40)}"`)
  if (!ok) failures.push({ label, expected: `包含 "${needle}"`, actual: haystack })
}

// ====== main ======
async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  真 OCR 集成测试 — 支付宝账单详情页')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  fixture: ${FIXTURE}`)
  console.log(`  prompt: ${USE_OLD_PROMPT ? 'OLD' : 'NEW (e8f01ed 修复版)'}`)
  console.log(`  env: ${ENV_ID}`)
  console.log(`  fn: ${FN_NAME}`)
  console.log('')

  // 1. 读 fixture
  const dataUri = loadFixture()
  if (!dataUri) return printHelpAndExit(1)
  console.log(`📷 fixture 加载：${(dataUri.length / 1024).toFixed(0)} KB (base64)`)
  console.log('')

  // 2. 调云函数
  const prompt = USE_OLD_PROMPT ? OLD_PROMPT : NEW_PROMPT
  console.log(`🚀 调 ${FN_NAME}...`)
  const start = Date.now()
  const res = invokeVisionProbe(dataUri, prompt)
  const cost = ((Date.now() - start) / 1000).toFixed(1)

  if (!res) {
    console.error('❌ 找不到 tcb CLI。')
    console.error('   安装：npm i -g @cloudbase/cli')
    console.error('   登录：cloudbase login（扫码）')
    return printHelpAndExit(STRICT ? 1 : 0)
  }
  if (res.status !== 0) {
    console.error(`❌ ${FN_NAME} 调用失败（exit=${res.status}, ${cost}s）`)
    console.error('--- stdout ---\n' + res.stdout.slice(0, 1000))
    console.error('--- stderr ---\n' + res.stderr.slice(0, 500))
    return printHelpAndExit(STRICT ? 1 : 0)
  }
  console.log(`⏱  ${cost}s`)
  console.log('--- raw stdout (前 1500 字) ---')
  console.log(res.stdout.slice(0, 1500))
  console.log('--- end ---')
  console.log('')

  // 3. 抽 JSON
  const parsed = extractJsonFromOutput(res.stdout)
  if (!parsed) {
    console.error('❌ 模型返回里找不到合法 JSON')
    return printHelpAndExit(STRICT ? 1 : 0)
  }
  console.log(`📋 模型识别结果：`)
  console.log(JSON.stringify(parsed, null, 2))
  console.log('')

  // 4. 断言
  console.log(`🧪 断言：`)
  const failures = []
  // 核心字段（NEW prompt 应该全过；OLD prompt 可能漏）
  assertIn(parsed.category, ['娱乐', '其他'], 'category（电影类应为娱乐，最差兜底其他）', failures)
  // amount：取绝对值对比（模型可能返回 76.8 或 76.80；OLD prompt 可能误识别为 0.5 等）
  const amt = typeof parsed.amount === 'number' ? Math.abs(parsed.amount) : null
  // 宽容：76-77 都算对（小数误差/四舍五入）
  if (amt !== null && Math.abs(amt - 76.80) < 1.5) {
    console.log(`  ✓ amount: ${amt}（与期望 76.80 偏差 < 1.5，可接受）`)
  } else {
    failures.push({ label: 'amount', expected: '~76.80', actual: amt })
    console.log(`  ✗ amount: ${amt}（与期望 76.80 偏差过大，可能被 0.5 元话费券或时间数字干扰）`)
  }
  assertContains(parsed.date || '', '2026-07-31', 'date（含支付时间 YYYY-MM-DD）', failures)
  assertContains(parsed.merchant || '', '影城', 'merchant（含"影城"，确认从"商品说明"取，非界面标题）', failures)

  console.log('')
  if (failures.length === 0) {
    console.log(`✅ 全部断言通过（${USE_OLD_PROMPT ? 'OLD' : 'NEW'} prompt）`)
    return printHelpAndExit(0)
  } else {
    console.log(`❌ ${failures.length} 项断言失败（${USE_OLD_PROMPT ? 'OLD' : 'NEW'} prompt）`)
    return printHelpAndExit(STRICT ? 1 : 0)
  }
}

function printHelpAndExit(code) {
  console.log('')
  console.log('───────────────────────────────────────────────────────')
  console.log('用法：node ci-tools/scripts/realOcrTest.js [--strict] [--prompt old]')
  console.log('  --strict    失败时 exit code = 1（CI 集成用；默认仅打印不阻塞）')
  console.log('  --prompt old  用 OLD prompt（"识别这张小票..."），与 NEW 对比回归效果')
  console.log('───────────────────────────────────────────────────────')
  process.exit(code)
}

main().catch((e) => {
  console.error('💥 脚本异常：', e)
  process.exit(STRICT ? 1 : 0)
})