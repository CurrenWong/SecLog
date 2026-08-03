// 旅游记录 travelRecord 云函数
// 独立于 miaojiRecord，不互相依赖
// 负责旅程 Trip / 日记 Journal 的增删查改 + NLP 自然语言解析
const cloud = require('wx-server-sdk')
const tcb = require('@cloudbase/node-sdk')

cloud.init({
  env: 'seclog-d1g8no5pc45e643aa',
})

const tcbApp = tcb.init({ env: 'seclog-d1g8no5pc45e643aa' })

const db = cloud.database()
const _ = db.command

const TRIPS = 'trips'
const JOURNALS = 'trip_journals'

// 获取当前用户 openid
function getOpenid() {
  return cloud.getWXContext().OPENID
}

// 用户数据隔离查询条件
function ownerFilter() {
  const openid = getOpenid()
  return openid ? { _openid: openid } : null
}

// 金额四舍五入
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// ========== 旅程 CRUD ==========

async function createTrip({ title, startDate, endDate, cover, location, summary }) {
  const openid = getOpenid()
  if (!openid) return { success: false, error: '未登录' }
  if (!title || !startDate || !endDate) return { success: false, error: '标题、开始日期、结束日期为必填' }

  const now = new Date().toISOString()
  const data = {
    _openid: openid,
    title,
    startDate,
    endDate,
    cover: cover || '',
    location: location || '',
    summary: summary || '',
    entryCount: 0,
    photoCount: 0,
    route: [],
    createdAt: now,
    updatedAt: now,
  }

  const res = await db.collection(TRIPS).add({ data })
  return { success: true, tripId: res._id }
}

async function updateTrip({ tripId, title, cover, startDate, endDate, location, summary }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!tripId) return { success: false, error: 'tripId 必填' }

  const updateData = { updatedAt: new Date().toISOString() }
  if (title !== undefined) updateData.title = title
  if (cover !== undefined) updateData.cover = cover
  if (startDate !== undefined) updateData.startDate = startDate
  if (endDate !== undefined) updateData.endDate = endDate
  if (location !== undefined) updateData.location = location
  if (summary !== undefined) updateData.summary = summary

  await db.collection(TRIPS).where({ _id: tripId, ...filter }).update({ data: updateData })
  return { success: true }
}

async function deleteTrip({ tripId }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!tripId) return { success: false, error: 'tripId 必填' }

  // 删除旅程下的所有日记
  const delJournals = await db.collection(JOURNALS).where({ tripId, ...filter }).remove()

  // 删除旅程
  await db.collection(TRIPS).where({ _id: tripId, ...filter }).remove()

  return { success: true, deletedJournals: delJournals.removed || 0 }
}

async function listTrips({ page, limit }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }

  const p = page || 1
  const l = limit || 20
  const skip = (p - 1) * l

  const [tripRes, countRes] = await Promise.all([
    db.collection(TRIPS).where(filter).orderBy('createdAt', 'desc').skip(skip).limit(l).get(),
    db.collection(TRIPS).where(filter).count(),
  ])

  return { success: true, trips: tripRes.data, total: countRes.total }
}

async function getTrip({ tripId }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!tripId) return { success: false, error: 'tripId 必填' }

  const tripRes = await db.collection(TRIPS).where({ _id: tripId, ...filter }).get()
  if (tripRes.data.length === 0) return { success: false, error: '旅程不存在' }

  const trip = tripRes.data[0]

  // 获取所有日记
  const journalRes = await db.collection(JOURNALS)
    .where({ tripId, ...filter })
    .orderBy('day', 'asc')
    .orderBy('time', 'asc')
    .get()

  return { success: true, trip, entries: journalRes.data }
}

// ========== 日记 CRUD ==========

async function addJournal({ tripId, day, date, time, title, location, content, photos }) {
  const openid = getOpenid()
  if (!openid) return { success: false, error: '未登录' }
  if (!tripId || day === undefined || !date) return { success: false, error: 'tripId、day、date 必填' }

  const now = new Date().toISOString()
  const data = {
    _openid: openid,
    tripId,
    day,
    date,
    time: time || '',
    title: title || '',
    location: location || null,
    content: content || '',
    photos: photos || [],
    createdAt: now,
    updatedAt: now,
  }

  const res = await db.collection(JOURNALS).add({ data })

  // 更新旅程的 entryCount 和 photoCount
  const photoCount = (photos || []).length
  await db.collection(TRIPS).where({ _id: tripId }).update({
    data: {
      entryCount: _.inc(1),
      photoCount: _.inc(photoCount),
      updatedAt: now,
    },
  })

  return { success: true, journalId: res._id }
}

async function updateJournal({ journalId, day, date, time, title, location, content, photos }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!journalId) return { success: false, error: 'journalId 必填' }

  const updateData = { updatedAt: new Date().toISOString() }
  if (day !== undefined) updateData.day = day
  if (date !== undefined) updateData.date = date
  if (time !== undefined) updateData.time = time
  if (title !== undefined) updateData.title = title
  if (location !== undefined) updateData.location = location
  if (content !== undefined) updateData.content = content
  if (photos !== undefined) updateData.photos = photos

  await db.collection(JOURNALS).where({ _id: journalId, ...filter }).update({ data: updateData })
  return { success: true }
}

async function deleteJournal({ journalId }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!journalId) return { success: false, error: 'journalId 必填' }

  // 先查原日记获取照片数
  const old = await db.collection(JOURNALS).where({ _id: journalId, ...filter }).get()
  if (old.data.length === 0) return { success: false, error: '日记不存在' }

  const journal = old.data[0]

  await db.collection(JOURNALS).where({ _id: journalId, ...filter }).remove()

  // 更新旅程统计
  await db.collection(TRIPS).where({ _id: journal.tripId }).update({
    data: {
      entryCount: _.inc(-1),
      photoCount: _.inc(-(journal.photos || []).length),
      updatedAt: new Date().toISOString(),
    },
  })

  return { success: true }
}

async function listJournals({ tripId, sort }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!tripId) return { success: false, error: 'tripId 必填' }

  const order = sort === 'desc' ? 'desc' : 'asc'
  const res = await db.collection(JOURNALS)
    .where({ tripId, ...filter })
    .orderBy('day', order)
    .orderBy('time', 'asc')
    .get()

  return { success: true, journals: res.data }
}

// ========== NLP 自然语言解析（调用 AI 模型） ==========

async function parseNaturalLanguage({ text, tripStartDate, tripEndDate }) {
  if (!text || !text.trim()) return { success: false, error: 'text 必填' }

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const prompt = `你是一个旅游日记的 NLP 解析助手。请将用户输入的日常语言解析为结构化数据。

输入示例：
- "今天八点去了故宫"
- "昨天晚上去了夫子庙"
- "下午三点在颐和园散步"
- "中午吃烤鸭，180块"
- "早上七点在天安门看升旗"

输出 JSON 格式（只输出 JSON，不要额外文字）：
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "title": "简短标题",
  "location": { "name": "地点名" },
  "content": "完整描述",
  "expense": 0,
  "confidence": 0.95,
  "unparsed": ""
}

当前参考日期：${todayStr}
用户输入：${text}`

  try {
    const aiRes = await tcbApp.ai().generateText({
      model: 'deepseek-v4-flash',
      prompt,
    })

    let parsed
    try {
      // 尝试从 AI 回复中提取 JSON
      const raw = aiRes.trim()
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        parsed = JSON.parse(raw)
      }
    } catch (e) {
      // AI 返回非 JSON，回退为纯文本
      return { success: true, parsed: {
        date: todayStr,
        time: '',
        title: '',
        location: null,
        content: text,
        expense: 0,
        confidence: 0.3,
        unparsed: aiRes,
      }}
    }

    return { success: true, parsed }
  } catch (err) {
    console.error('NLP parse error:', err)
    return { success: false, error: 'AI 解析失败', detail: err.message }
  }
}

// ========== 语音转文字（占位，实际由前端 WechatSI 插件完成） ==========

async function voiceToText({ voiceFileId }) {
  // 语音转文字由前端微信同声传译插件 WechatSI 完成
  // 此接口仅作转发/记录，实际 STT 在前端
  return { success: false, error: '语音转文字请使用前端 WechatSI 插件，此接口暂未实现' }
}

// ========== 路由分发 ==========

exports.main = async (event, context) => {
  const { action, ...params } = event

  try {
    switch (action) {
      // 旅程
      case 'createTrip': return await createTrip(params)
      case 'updateTrip': return await updateTrip(params)
      case 'deleteTrip': return await deleteTrip(params)
      case 'listTrips': return await listTrips(params)
      case 'getTrip': return await getTrip(params)

      // 日记
      case 'addJournal': return await addJournal(params)
      case 'updateJournal': return await updateJournal(params)
      case 'deleteJournal': return await deleteJournal(params)
      case 'listJournals': return await listJournals(params)

      // NLP
      case 'parseNaturalLanguage': return await parseNaturalLanguage(params)
      case 'voiceToText': return await voiceToText(params)

      default:
        return { success: false, error: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error(`travelRecord.${action} error:`, err)
    return { success: false, error: err.message }
  }
}