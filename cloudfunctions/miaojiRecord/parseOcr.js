// parseOcr.js
// 纯函数：从 AI 多模态识别返回的文本里提取记账字段。与 wx-server-sdk / tcbApp 解耦，便于单测。
//
// 抽出原因：云函数主入口的 extractFromImage 混了 AI 调用 + JSON 容错解析 + 字段归一化三件事，
// 单元测试难写。把这块纯逻辑抽到这里，云函数 require 它，jest 直接 require 同文件测。

const CATEGORY_ENUM = ['餐饮', '交通', '购物', '居家', '医疗', '娱乐', '教育', '其他']

/**
 * 从模型返回文本里抠出 JSON 对象。
 * 容错：兼容 ```json ... ``` / ``` ... ``` 包裹、纯文本里有杂讯、JSON 内含换行等。
 * @param {string} content
 * @returns {string|null} 抠出的 JSON 字符串（已 trim），解析不出返回 null
 */
function extractJsonString(content) {
  if (!content) return null
  let s = String(content).trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const brace = s.match(/\{[\s\S]*\}/)
  if (brace) s = brace[0]
  return s || null
}

/**
 * 把模型抠出的 JSON 解析并归一化为记账字段。
 * @param {string} content 模型原始返回（含/不含代码块都可）
 * @returns {{ok:true, amount:number|null, merchant:string, category:string, date:string}
 *          |{ok:false, code:'AI_EMPTY'|'AI_PARSE_ERROR', message:string, raw?:string}}
 */
function parseOcrResponse(content) {
  if (!content || !String(content).trim()) {
    return { ok: false, code: 'AI_EMPTY', message: '模型返回为空' }
  }
  const jsonStr = extractJsonString(content)
  if (!jsonStr) {
    return { ok: false, code: 'AI_PARSE_ERROR', message: '未找到 JSON 对象', raw: String(content).slice(0, 200) }
  }
  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch (e) {
    return { ok: false, code: 'AI_PARSE_ERROR', message: '模型返回无法解析为 JSON', raw: String(content).slice(0, 200) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'AI_PARSE_ERROR', message: 'JSON 不是对象' }
  }
  const amount = typeof parsed.amount === 'number' ? parsed.amount : null
  const category = CATEGORY_ENUM.includes(parsed.category) ? parsed.category : '其他'
  return {
    ok: true,
    amount,
    merchant: typeof parsed.merchant === 'string' ? parsed.merchant : '',
    category,
    date: typeof parsed.date === 'string' ? parsed.date : '',
  }
}

module.exports = { parseOcrResponse, extractJsonString, CATEGORY_ENUM }