const cloudbase = require('@cloudbase/node-sdk')
const app = cloudbase.init({})

exports.main = async (event, context) => {
  const { imageUrl, prompt } = event
  try {
    // 拿访问令牌（云函数内网可用）
    const auth = app.auth()
    const tokenRes = await auth.getAccessToken()
    const accessToken = tokenRes.accessToken || (tokenRes.credentials && tokenRes.credentials.accessToken)
    if (!accessToken) {
      return { success: false, stage: 'token', tokenRes }
    }

    // 用 OpenAPI（OpenAI 兼容）直调 qwen3.5-flash，带多模态 content
    const envId = process.env.TCB_ENV || 'sec-log-6gbtzcmb32a3fa30'
    const url = `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions`
    const body = {
      model: 'qwen3.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt || 'This is a shopping receipt. Recognize total amount, merchant, and category (food/transport/shopping/other). Return JSON {amount, merchant, category}.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    return { success: resp.ok, status: resp.status, data }
  } catch (e) {
    return { success: false, error: String(e && e.message || e), stack: e && e.stack }
  }
}
