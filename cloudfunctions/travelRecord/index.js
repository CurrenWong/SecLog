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

  // 解析 location JSON 字符串为对象
  const entries = (journalRes.data || []).map((j) => {
    if (typeof j.location === 'string') {
      try { j.location = JSON.parse(j.location) } catch (e) { j.location = null }
    }
    return j
  })

  // 计算相邻地点的驾车距离
  await computeDistances(entries)

  return { success: true, trip, entries }
}

// 计算相邻地点驾车距离（在 getTrip 中调用）
// 优先读数据库缓存，没有才调 API，调完后自动存回数据库
async function computeDistances(entries) {
  const key = process.env.TENCENT_MAP_KEY
  if (!key) return entries

  // 先把 location 字符串解析为对象
  for (const e of entries) {
    if (typeof e.location === 'string') {
      try { e.location = JSON.parse(e.location) } catch (e2) { e.location = null }
    }
  }

  // 第 1 步：对没有坐标但有地名的地点进行地理编码（使用 AI 智能地理编码）
  const geocodePromises = entries.map(async (entry) => {
    if (!entry.location || !entry.location.name) return
    if (entry.location.latitude && entry.location.longitude) return
    try {
      const geoResult = await smartGeocode(entry.location.name, key)
      if (geoResult.success) {
        entry.location.latitude = geoResult.latitude
        entry.location.longitude = geoResult.longitude
        // 坐标存回数据库
        await db.collection(JOURNALS).doc(entry._id).update({
          data: { location: JSON.stringify(entry.location) },
        }).catch((e) => console.error('保存坐标失败', entry._id, e))
      }
    } catch (e) {
      console.error('geocode failed for', entry.location.name, e)
    }
  })
  await Promise.all(geocodePromises)

  // 第 2 步：找出需要计算距离的相邻条目
  const needCalc = []
  for (let i = 0; i < entries.length - 1; i++) {
    const from = entries[i].location
    const to = entries[i + 1].location
    if (!from || !to || !from.latitude || !from.longitude || !to.latitude || !to.longitude) continue
    // 已有缓存跳过
    if (entries[i].distanceToNext) continue
    needCalc.push({ index: i, from, to })
  }

  if (needCalc.length > 0) {
    const promises = needCalc.map(async ({ index, from, to }) => {
      const fromStr = `${from.latitude},${from.longitude}`
      const toStr = `${to.latitude},${to.longitude}`
      try {
        const result = await new Promise((resolve, reject) => {
          const url = `https://apis.map.qq.com/ws/direction/v1/driving/?from=${encodeURIComponent(fromStr)}&to=${encodeURIComponent(toStr)}&key=${key}`
          https.get(url, (res) => {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => {
              try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
            })
          }).on('error', reject)
        })

        if (result.status === 0 && result.result?.routes?.length > 0) {
          const route = result.result.routes[0]
          const distanceKm = round2(route.distance / 1000)
          const durationMin = Math.round(route.duration)
          const distanceToNext = {
            distance: distanceKm,
            text: `${distanceKm} 公里 · ${durationMin} 分钟`,
          }
          return { index, distanceToNext }
        }
      } catch (e) {
        console.error('computeDistances failed for index', index, e)
      }
      return null
    })

    const results = await Promise.all(promises)

    // 存回数据库 & 更新内存
    const batch = db.collection(JOURNALS)
    for (const r of results) {
      if (r) {
        entries[r.index].distanceToNext = r.distanceToNext
        try {
          await batch.doc(entries[r.index]._id).update({ distanceToNext: r.distanceToNext })
        } catch (e) {
          console.error('保存 distanceToNext 失败', entries[r.index]._id, e)
        }
      }
    }
  }

  return entries
}

/**
 * 保存多日行程后，异步触发相邻地点距离计算
 * 批量解析的日记只有 location.name（地名），没有坐标
 * 需要先地理编码获取坐标，再计算驾车距离
 */
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
    location: location ? (typeof location === 'object' ? JSON.stringify(location) : location) : null,
    content: content || '',
    photos: photos || [],
    createdAt: now,
    updatedAt: now,
  }

  const res = await db.collection(JOURNALS).add({ data })

  // 更新旅程的 entryCount 和 photoCount
  try {
    const photoCount = (photos || []).length
    await db.collection(TRIPS).where({ _id: tripId, _openid: openid }).update({
      data: {
        entryCount: _.inc(1),
        photoCount: _.inc(photoCount),
        updatedAt: now,
      },
    })
  } catch (updateErr) {
    // 如果 TRIPS 更新失败，回滚刚创建的日记
    console.error('addJournal trip update error, rolling back journal:', updateErr)
    await db.collection(JOURNALS).doc(res._id).remove().catch(() => {})
    return { success: false, error: '更新旅程统计失败: ' + updateErr.message }
  }

  // 新增日记后，清除上一条日记的缓存距离（因为上一条→本条目需要重新计算）
  clearPrevJournalDistanceToNext(tripId, res._id, day, time).catch((e) => {
    console.error('addJournal clearPrev failed', e)
  })

  return { success: true, journalId: res._id }
}

/**
 * 清除指定日记的"上一条日记"的 distanceToNext 缓存
 * 当新增/修改日记位置时，前一条的缓存距离已失效
 */
async function clearPrevJournalDistanceToNext(tripId, journalId, day, time) {
  const filter = ownerFilter()
  if (!filter) return

  // 找到上一条日记（同旅程，day小于等于当前，排除自己，按 day/time 降序取第一条）
  const prev = await db.collection(JOURNALS)
    .where({ tripId, ...filter })
    .orderBy('day', 'asc')
    .orderBy('time', 'asc')
    .get()

  // 找到本日记在排序中的位置，取前一条
  let prevId = null
  for (let i = 0; i < prev.data.length - 1; i++) {
    if (prev.data[i + 1]._id === journalId) {
      prevId = prev.data[i]._id
      break
    }
  }

  if (prevId) {
    await db.collection(JOURNALS).where({ _id: prevId, ...filter }).update({ data: { distanceToNext: null } })
  }
}

async function updateJournal({ journalId, day, date, time, title, location, content, photos }) {
  const filter = ownerFilter()
  if (!filter) return { success: false, error: '未登录' }
  if (!journalId) return { success: false, error: 'journalId 必填' }

  // 如果 location 变更，清除受影响的缓存距离
  if (location !== undefined) {
    // 先查当前日记，获取 tripId 和排序信息
    const cur = await db.collection(JOURNALS).where({ _id: journalId, ...filter }).get()
    if (cur.data.length > 0) {
      const curJournal = cur.data[0]
      // 1. 清除本日记的 distanceToNext（影响本条目→下一条）
      await db.collection(JOURNALS).where({ _id: journalId, ...filter }).update({ data: { distanceToNext: null } })

      // 2. 清除上一条日记的 distanceToNext（影响上一条→本条目）
      await clearPrevJournalDistanceToNext(curJournal.tripId, journalId, curJournal.day, curJournal.time)
    }
  }

  const updateData = { updatedAt: new Date().toISOString() }
  if (day !== undefined) updateData.day = day
  if (date !== undefined) updateData.date = date
  if (time !== undefined) updateData.time = time
  if (title !== undefined) updateData.title = title
  if (location !== undefined) {
    updateData.location = location === null
      ? null
      : (typeof location === 'object' ? JSON.stringify(location) : location)
  }
  if (content !== undefined) updateData.content = content
  if (photos !== undefined) updateData.photos = photos

  try {
    await db.collection(JOURNALS).where({ _id: journalId, ...filter }).update({ data: updateData })
  } catch (err) {
    console.error('updateJournal db error:', err, 'updateData keys:', Object.keys(updateData))
    return { success: false, error: '更新日记失败: ' + err.message }
  }
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
  await db.collection(TRIPS).where({ _id: journal.tripId, _openid: getOpenid() }).update({
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

  // 旅程上下文（如果有）
  let tripContext = ''
  if (tripStartDate) {
    tripContext = `\n旅程范围：${tripStartDate} ~ ${tripEndDate || '至今'}`
  }

  const prompt = `你是一个旅游日记的 NLP 解析助手。请将用户输入的日常语言解析为结构化数据。

输入示例：
- "今天八点去了故宫" → {"date":"2026-08-04","time":"08:00","title":"游览故宫","location":{"name":"故宫"},"content":"今天八点去了故宫"}
- "昨天晚上去了夫子庙" → {"date":"2026-08-03","time":"20:00","title":"夜游夫子庙","location":{"name":"夫子庙"},"content":"昨天晚上去了夫子庙"}
- "下午三点在颐和园散步" → {"date":"2026-08-04","time":"15:00","title":"颐和园散步","location":{"name":"颐和园"},"content":"下午三点在颐和园散步"}
- "中午吃烤鸭" → {"date":"2026-08-04","time":"12:00","title":"午餐吃烤鸭","content":"中午吃烤鸭"}
- "早上七点在天安门看升旗" → {"date":"2026-08-04","time":"07:00","title":"天安门看升旗","location":{"name":"天安门"},"content":"早上七点在天安门看升旗"}

输出 JSON 格式（只输出 JSON，不要额外文字）：
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "title": "简短标题（4-12字，从输入内容提取，必填）",
  "location": { "name": "地点名" },
  "content": "完整描述（保留原文语气）",
  "expense": 0,
  "confidence": 0.95,
  "unparsed": ""
}

注意：
- title 必填！从输入内容提取关键词生成，例如"游览故宫"、"夜游夫子庙"
- 如果用户没说地点，location.name 可以为空
- 如果用户没说时间，time 可以为空
- date 必须基于当前参考日期推算
- content 保留用户原文，不要自己编造${tripContext}

当前参考日期：${todayStr}
用户输入：${text}`

  try {
    const ai = tcbApp.ai()
    const model = ai.createModel('cloudbase')
    const result = await model.generateText({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
    })

    const aiRes = result.text

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

// ========== 地理编码（地名 → 坐标） ==========
// 将地点名称通过腾讯地图 WebService API 转为经纬度坐标
// 使用时需在云函数环境变量中配置 TENCENT_MAP_KEY（腾讯位置服务密钥）
// 如果未配置密钥，会尝试用 AI 模型估算坐标（适用于知名地点）

const https = require('https')

// 通过腾讯地图 API 地理编码（带完整地址字符串）
async function geocodeByTencent(addrStr, key) {
  const result = await new Promise((resolve, reject) => {
    const url = `https://apis.map.qq.com/ws/geocoder/v1/?address=${encodeURIComponent(addrStr)}&key=${key}`
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })

  if (result.status === 0) {
    return {
      success: true,
      latitude: result.result.location.lat,
      longitude: result.result.location.lng,
      title: result.result.title || addrStr,
      address: result.result.address || '',
    }
  }
  return { success: false, error: `地理编码失败: ${result.message}`, status: result.status }
}

/**
 * AI 智能地理编码：先让 AI 判断城市 → 拼城市名调腾讯地图 → 失败再调 AI 估算坐标
 */
async function smartGeocode(addrStr, key) {
  // 方案一：AI 判断城市 + 腾讯地图 API
  if (key) {
    try {
      const ai = tcbApp.ai()
      const model = ai.createModel('cloudbase')
      const cityResult = await model.generateText({
        model: 'deepseek-v4-flash',
        messages: [{
          role: 'user',
          content: `你是一个地理助手。请判断以下地点所在的城市名称。
只返回 JSON，不要多余文字。
如果知道所在城市，返回: {"city": "城市名", "address": "${addrStr}"}
如果不确定，返回: {"city": "", "address": "${addrStr}"}

地点名称：${addrStr}`,
        }],
      })

      let city = ''
      try {
        const parsed = JSON.parse(cityResult.text.trim().match(/\{[\s\S]*\}/)[0])
        city = (parsed.city || '').trim()
      } catch (e) { /* AI 返回格式异常，忽略城市前缀 */ }

      // 优先尝试带城市前缀的地址
      const fullAddr = city ? `${city}${addrStr}` : addrStr
      const mapResult = await geocodeByTencent(fullAddr, key)
      if (mapResult.success) return mapResult

      // 带城市前缀失败，再试一次不带城市前缀的
      if (city) {
        const fallbackResult = await geocodeByTencent(addrStr, key)
        if (fallbackResult.success) return fallbackResult
      }
    } catch (err) {
      // API 异常，继续尝试方案二
    }
  }

  // 方案二：AI 模型直接估算坐标（兜底）
  try {
    const ai = tcbApp.ai()
    const model = ai.createModel('cloudbase')
    const result = await model.generateText({
      model: 'deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: `你是一个地理编码助手。请判断以下地点名称的经纬度坐标，只返回坐标，不要多余文字。
如果知道该地点的坐标，返回 JSON: {"latitude": 纬度, "longitude": 经度}
如果不知道或不确定，返回: {"error": "unknown"}

地点名称：${addrStr}`,
      }],
    })

    const aiRes = result.text.trim()
    const jsonMatch = aiRes.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.latitude && parsed.longitude) {
        return {
          success: true,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          title: addrStr,
          address: '',
        }
      }
    }
    return { success: false, error: '无法确定该地点坐标（AI 估算失败）' }
  } catch (err) {
    return { success: false, error: 'AI 坐标估算失败: ' + err.message }
  }
}

async function geocode({ address }) {
  if (!address) return { success: false, error: 'address 必填' }
  const key = process.env.TENCENT_MAP_KEY
  return await smartGeocode(address, key)
}

// ========== 驾车距离计算 ==========

async function calcDistance({ from, to }) {
  if (!from || !to) return { success: false, error: 'from 和 to 必填' }

  const key = process.env.TENCENT_MAP_KEY
  if (!key) return { success: false, error: '未配置腾讯地图密钥' }

  // 构造坐标/地址字符串：优先用坐标，降级用地名
  const fmt = (loc) => {
    if (loc.latitude && loc.longitude) return `${loc.latitude},${loc.longitude}`
    if (loc.name) return loc.name
    return ''
  }

  const fromStr = fmt(from)
  const toStr = fmt(to)
  if (!fromStr || !toStr) return { success: false, error: '地点信息不完整' }

  const result = await new Promise((resolve, reject) => {
    const url = `https://apis.map.qq.com/ws/direction/v1/driving/?from=${encodeURIComponent(fromStr)}&to=${encodeURIComponent(toStr)}&key=${key}`
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })

  if (result.status === 0 && result.result?.routes?.length > 0) {
    const route = result.result.routes[0]
    const distanceKm = round2(route.distance / 1000)
    const durationMin = Math.round(route.duration)
    return {
      success: true,
      distance: distanceKm,
      distanceText: `${distanceKm} 公里`,
      duration: durationMin,
      durationText: `约 ${durationMin} 分钟`,
      polyline: route.polyline || null,
    }
  }

  return { success: false, error: `路线规划失败: ${result.message || '未知错误'}` }
}

// ========== 多日行程 NLP 批量解析 ==========

async function parseMultiDay({ text, today }) {
  if (!text || !text.trim()) return { success: false, error: 'text 必填' }

  const todayDate = today ? new Date(today) : new Date()
  const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`

  const prompt = `你是一个多日行程解析助手。请将用户输入的多日行程文案解析为按天分组的结构化数据。

**参考日期（今天）：${todayStr}**

**规则：**
1. 识别文案中所有相对日期并转换为绝对日期：
   - 前天 = 今天 - 2天，昨天 = 今天 - 1天，今天 = 今天
   - 明天 = 今天 + 1天，后天 = 今天 + 2天
   - 大前天 = 今天 - 3天，大后天 = 今天 + 3天
   - 如果文案直接说"8月3日"或"8月3号" → 推断最近的该日期
2. 按日期分组，每天可能有多条活动
3. 每条活动推断时间：凌晨→05:00, 早上→07:00, 上午→09:00, 中午→12:00, 下午→14:00, 傍晚→17:00, 晚上→19:00, 深夜→22:00
4. 如果没说具体时间，用默认时间：上午→09:00, 下午→14:00, 晚上→19:00
5. 每条提取精简标题（4-12字）和简短内容描述
6. 识别地点和交通方式（飞/高铁/开车/地铁等）
7. 推断整体旅程名称（3-8字，如"北京之旅"、"上海出差"）

**输出 JSON 格式（只输出 JSON，不要多余文字）：**
{
  "tripTitle": "旅程名称",
  "tripStartDate": "YYYY-MM-DD",
  "tripEndDate": "YYYY-MM-DD",
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "entries": [
        {
          "time": "HH:MM",
          "title": "简短标题",
          "content": "一句话描述",
          "location": { "name": "地点名" },
          "transport": "交通方式或空字符串"
        }
      ]
    }
  ]
}

**注意事项：**
- day 从 1 开始计数（最早的那天是 day 1）
- 如果用户没说地点，location.name 可以为空
- 如果用户没说时间，time 可以为空
- 如果用户没说详细内容，content 用文案原文
- location 只放 name 字段，不需要坐标
- 对连续的行程，如果没有明确的时间分隔，相邻活动推断合理间隔（通常1-3小时）
- transport 表示交通方式：如"飞机"、"高铁"、"开车"等，没有则传空字符串

**用户输入：**${text}`

  try {
    const ai = tcbApp.ai()
    const model = ai.createModel('cloudbase')
    const result = await model.generateText({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
    })

    const aiRes = result.text.trim()
    const jsonMatch = aiRes.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { success: false, error: 'AI 返回格式异常，无法解析', raw: aiRes }
    }

    const parsed = JSON.parse(jsonMatch[0])

    // 校验基本结构
    if (!parsed.days || !Array.isArray(parsed.days) || parsed.days.length === 0) {
      return { success: false, error: 'AI 未能解析出任何行程', raw: aiRes }
    }

    // 补充默认值
    let totalEntries = 0
    for (const day of parsed.days) {
      day.dateLabel = day.date ? day.date.slice(5) : ''
      // 计算相对标签
      if (day.date === todayStr) {
        day.relativeLabel = '今天'
      } else {
        const d = new Date(day.date + 'T00:00:00')
        const diff = Math.round((d - todayDate) / (1000 * 60 * 60 * 24))
        const labels = { '-3': '大前天', '-2': '前天', '-1': '昨天', '1': '明天', '2': '后天', '3': '大后天' }
        day.relativeLabel = labels[diff] || ''
      }
      day.entries = (day.entries || []).map((e) => ({
        ...e,
        location: e.location && e.location.name ? { name: e.location.name } : null,
        transport: e.transport || '',
      }))
      totalEntries += day.entries.length
    }

    return {
      success: true,
      days: parsed.days,
      tripTitle: parsed.tripTitle || '',
      tripStartDate: parsed.tripStartDate || parsed.days[0].date,
      tripEndDate: parsed.tripEndDate || parsed.days[parsed.days.length - 1].date,
      totalEntries,
    }
  } catch (err) {
    console.error('parseMultiDay error:', err)
    return { success: false, error: 'AI 解析失败: ' + err.message }
  }
}

// ========== 批量保存多日行程 ==========

async function saveMultiDay({ tripTitle, tripStartDate, tripEndDate, tripLocation, days, targetTripId }) {
  const openid = getOpenid()
  if (!openid) return { success: false, error: '未登录' }
  if (!days || !Array.isArray(days) || days.length === 0) {
    return { success: false, error: 'days 必填且不能为空' }
  }

  const now = new Date().toISOString()

  // 1. 创建或获取旅程
  let tripId = targetTripId
  if (!tripId) {
    const title = tripTitle || `${tripStartDate} 的旅程`
    const tripRes = await db.collection(TRIPS).add({
      data: {
        _openid: openid,
        title,
        startDate: tripStartDate,
        endDate: tripEndDate,
        location: tripLocation || '',
        cover: '',
        summary: '',
        entryCount: 0,
        photoCount: 0,
        route: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    tripId = tripRes._id
  }

  // 2. 批量创建日记
  const journals = []
  for (const day of days) {
    for (const entry of day.entries) {
      const journalData = {
        _openid: openid,
        tripId,
        day: day.day,
        date: day.date,
        time: entry.time || '',
        title: entry.title || '',
        location: entry.location ? (typeof entry.location === 'object' ? JSON.stringify(entry.location) : entry.location) : null,
        content: entry.content || '',
        photos: [],
        createdAt: now,
        updatedAt: now,
      }
      const res = await db.collection(JOURNALS).add({ data: journalData })
      journals.push(res._id)
    }
  }

  // 3. 更新旅程统计
  const entryCount = days.reduce((sum, d) => sum + (d.entries || []).length, 0)
  await db.collection(TRIPS).where({ _id: tripId, _openid: openid }).update({
    data: {
      entryCount: _.inc(entryCount),
      endDate: tripEndDate,
      updatedAt: now,
    },
  })

  return {
    success: true,
    tripId,
    journalCount: entryCount,
    journalIds: journals,
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

      // 地理编码
      case 'geocode': return await geocode(params)
      // 驾车距离
      case 'calcDistance': return await calcDistance(params)

      // NLP
      case 'parseNaturalLanguage': return await parseNaturalLanguage(params)
      case 'parseMultiDay': return await parseMultiDay(params)
      case 'saveMultiDay': return await saveMultiDay(params)
      case 'voiceToText': return await voiceToText(params)

      default:
        return { success: false, error: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error(`travelRecord.${action} error:`, err)
    return { success: false, error: err.message }
  }
}