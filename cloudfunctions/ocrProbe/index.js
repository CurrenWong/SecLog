const cloudbase = require('@cloudbase/node-sdk')
const app = cloudbase.init({ env: 'seclog-d1g8no5pc45e643aa' })

exports.main = async (event) => {
  const { imageUrl, prompt } = event
  if (!imageUrl) {
    return { success: false, error: 'missing imageUrl' }
  }
  try {
    // 服务端 AI 走 @cloudbase/node-sdk app.ai()（内网鉴权，无需手动 fetch + token）
    const ai = app.ai()
    if (!ai) return { success: false, stage: 'ai', error: 'app.ai() undefined' }
    const model = ai.createModel('hunyuan-exp')
    const res = await model.generateText({
      model: 'hunyuan-2.0-instruct-20251111',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt || 'This is a shopping receipt. Recognize total amount, merchant, and category (food/transport/shopping/other). Return JSON {amount, merchant, category}.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    })
    const text = res && (res.text || (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content))
    return { success: true, text: String(text).slice(0, 800) }
  } catch (e) {
    return { success: false, error: String(e && e.message || e), stack: e && e.stack }
  }
}
