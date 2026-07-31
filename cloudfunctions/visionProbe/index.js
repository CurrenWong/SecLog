const tcb = require('@cloudbase/node-sdk')
const app = tcb.init({ env: 'seclog-d1g8no5pc45e643aa' })

const TEST_IMG = 'data:image/png;base64,iVBORwKGgoAAAANSUhEUgAAAMgAAAEECAIAAADiZ+yyAAATaUlEQVR4nO3de1BUZR8H8GfFGVxQQQWVSmuggkRYLhqXvQFyU+PiTCGlCaXMOGZo4oVJnP5wHkJN0sloUNdyrGFoE00hLmrpQIBm4RVFUBN1hQYFBeW2PO/kmfcMw1lY8PWnHv5/HX2t8959qzvd55z2N7OzLOOQN40oY98RkBECygghULSCBYQALBAhIIFpBAsIAEggUkECwggWABCQQLnlGw/vzzz9DQ0NDAwJCQkNra2saYra2tK9bWFsW7dO//KBQKFpbW2tHASJZ/j/vQAG/vAMJBAtIIFhAAsECEggWkECwgASCBSQQLCCBYAEJBAtIIFhAAsECEggWkECwgASCBSQQLCCBYAEJBAtIIFhAAsECEggWkECwgASCBSQQLCCBYMGzCFZOTk7AI8OHDxc29Hr97t27vb29/fz8vuu96GMcZ27txpaWlZ1cnzGZra2v2gPLy8uRyOWOsqCgIM752rVrtVrtvn37ettdo9JNkqQoGxc29Hr97t27vb29/fz8vuu96GMcZ27txpaWlZ1cnzGZra2tK9bWFsW7dO//fabTqdjjMXExCQnJ0sHFBQUVFdXC9stLS1Go1FasbCwEMfX1NRs2rTp119/ZYzJZDKFQpGZmblv376EhISr4/+b6d6eEb6zp1goxFWGqGN0YIFCzjnDg4OwjLW2tr6wgsvSFcsaU8HaUV0//59b29v8VOuXr3a2dkptHKwsOMMZycnL+TbEpzs7OJSUljLHS0tJXXnlF9N0g7dSA3g1DST9PhYGPCFfZ4op1/fr18PBwjUYTFBRUU1PDOV+3bt2UKVPeffddYa26cuWK+p1a6b0dvFeUVGheUSr1d71119i7wZppwb0hhC0LsBSOCXdyCBYAEJBAtIIFhAAsECEggWkECwgASCBSQQLCCBYAEJBAtIIFhAAsECEggWkECwgASCBSQQLCCBYAEJBAtIIFhAAsECEggWkECwgASCBSQQLGAU/gNzl3Wnd52XlQAAAABJRU5ErkJggg=='

exports.main = async (event) => {
  const imageUrl = event.imageUrl || TEST_IMG
  const prompt = event.prompt || '识别这张小票，返回JSON {amount,merchant,category,date}。category从[餐饮,交通,购物,居家,医疗,娱乐,教育,其他]选。'
  try {
    // 服务端 AI 走 @cloudbase/node-sdk app.ai()（wx-server-sdk 无 cloud.ai()）
    const ai = app.ai()
    if (!ai) return { success: false, error: 'app.ai() is undefined' }
    const model = ai.createModel('hunyuan-exp')
    const res = await model.generateText({
      model: 'hunyuan-2.0-instruct-20251111',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    })
    const text = res && (res.text || (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content))
    return { success: true, text: String(text).slice(0, 800) }
  } catch (e) {
    return { success: false, error: String(e && e.message || e), stack: (e && e.stack || '').slice(0, 400) }
  }
}
