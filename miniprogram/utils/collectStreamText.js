// utils/collectStreamText.js
// 统一收集 streamText 返回的文本（CloudBase AI SDK 不同版本返回结构差异大）。
// 纯函数，无 wx / this 依赖，便于 node 环境单测。
//
// 覆盖的真机/SDK 形态：
//   1) res 本身是字符串
//   2) res.text 是字符串
//   3) res.text 是 Promise（res.text.then）或函数（res.text()）
//   4) res.eventStream 异步迭代器，每条 event.data 是 SSE JSON：{ choices:[{ delta:{ content }, finish_reason }] }
//      （CloudBase AI SDK 真机返回形态，agent-ui 主对话即用此）
//   5) res.textStream 异步迭代器，直接 yield 文本片段 / { text } / { content }
//   6) res 自身是异步迭代器（OpenAI 兼容 / 简单格式）

// 从单条 SSE 事件里取增量文本（eventStream 用）
function _fromSSEEvent(event) {
  if (!event || !event.data) return ''
  let dataJson
  try {
    dataJson = JSON.parse(event.data)
  } catch (e) {
    return ''
  }
  const choices = dataJson.choices || []
  const delta = choices[0] && choices[0].delta
  if (delta && typeof delta.content === 'string') return delta.content
  return ''
}

// 判断是否 SSE 终止信号
function _isSSEStop(event) {
  if (!event || !event.data) return false
  try {
    const dataJson = JSON.parse(event.data)
    const choices = dataJson.choices || []
    return !!(choices[0] && choices[0].finish_reason === 'stop')
  } catch (e) {
    return false
  }
}

async function collectStreamText(res) {
  // 情况1：res 本身就是字符串
  if (typeof res === 'string') return res

  if (res && typeof res === 'object') {
    // 情况2：res.text 是字符串
    if (typeof res.text === 'string') return res.text

    // 情况3：res.text 是 Promise（部分 SDK 版本）或函数（res.text()）
    if (res.text) {
      try {
        if (typeof res.text.then === 'function') return await res.text // Promise
        if (typeof res.text === 'function') {
          const t = res.text() // 可能是同步或返回 Promise
          return (t && typeof t.then === 'function') ? await t : t
        }
      } catch (e) { /* ignore */ }
    }

    // 情况4：eventStream（CloudBase AI SDK 真机返回形态）
    if (res.eventStream && typeof res.eventStream[Symbol.asyncIterator] === 'function') {
      let t = ''
      try {
        for await (const event of res.eventStream) {
          t += _fromSSEEvent(event) // 先收集当前事件内容
          if (_isSSEStop(event)) break // 再判断是否终止（避免漏掉 stop 同条的最后一段内容）
        }
      } catch (e) { /* 迭代异常忽略，返回已收集部分 */ }
      if (t) return t
    }

    // 情况5：textStream（部分 SDK 版本，异步迭代器直接 yield 文本片段）
    if (res.textStream && typeof res.textStream[Symbol.asyncIterator] === 'function') {
      let t = ''
      try {
        for await (const chunk of res.textStream) {
          if (typeof chunk === 'string') t += chunk
          else if (chunk && typeof chunk.text === 'string') t += chunk.text
          else if (chunk && typeof chunk.content === 'string') t += chunk.content
        }
      } catch (e) { /* ignore */ }
      if (t) return t
    }

    // 情况6：res 自身是异步迭代器（OpenAI 兼容 / 简单格式）
    if (typeof res[Symbol.asyncIterator] === 'function') {
      let t = ''
      for await (const chunk of res) {
        if (!chunk) continue
        // OpenAI 兼容：{ choices: [{ delta: { content } }] }
        if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
          t += chunk.choices[0].delta.content || ''
        } else if (typeof chunk.delta === 'string') {
          t += chunk.delta
        } else if (typeof chunk.text === 'string') {
          t += chunk.text
        } else if (typeof chunk.content === 'string') {
          t += chunk.content
        } else if (typeof chunk === 'string') {
          t += chunk
        }
      }
      return t
    }
  }

  return ''
}

module.exports = { collectStreamText }
