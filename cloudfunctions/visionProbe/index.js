const tcb = require('@cloudbase/node-sdk')
const app = tcb.init({ env: 'seclog-d1g8no5pc45e643aa' })

exports.main = async (event) => {
  const imageUrl = event.imageUrl
  if (!imageUrl) return { success: false, error: 'missing imageUrl' }
  try {
    const ai = app.ai()
    if (!ai) return { success: false, error: 'app.ai() is undefined' }
    // 直接用 deepseek-v4-pro + cloudbase group + base64 data URL + image 在前 text 在后
    const model = ai.createModel('cloudbase')
    const res = await model.generateText({
      model: 'deepseek-v4-pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: '识别这张支付宝账单详情页，返回 JSON {amount,merchant,category,date}。category从[餐饮,交通,购物,居家,医疗,娱乐,教育,其他]选。' },
        ],
      }],
    })
    const text = res && (res.text || (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content))
    return { success: true, text: String(text || '').slice(0, 800) }
  } catch (e) {
    return { success: false, error: String(e && e.message || e).slice(0, 500), status: e && e.status }
  }
}