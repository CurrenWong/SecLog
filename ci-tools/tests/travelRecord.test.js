// travelRecord NLP 自然语言解析测试
// 测试云函数 travelRecord 的 parseNaturalLanguage 功能
// 通过 mock @cloudbase/node-sdk 控制 AI 返回内容，不依赖真实 AI 调用
const cloud = require('wx-server-sdk')
const tcbStub = require('@cloudbase/node-sdk')

// 云函数源码
const FUNC = require('../../cloudfunctions/travelRecord/index.js')

// 每个用例前重置
beforeEach(() => {
  cloud.__reset([], { OPENID: 'user1' })
  tcbStub.__resetMock()
})

// 默认用户上下文
const DEFAULT_CTX = { OPENID: 'user1' }

// 调用云函数
async function call(action, params, ctx) {
  cloud.__setCtx(ctx || DEFAULT_CTX)
  return FUNC.main({ action, ...params }, {})
}

describe('travelRecord NLP 自然语言解析', () => {
  describe('parseNaturalLanguage', () => {
    test('空文本返回错误', async () => {
      const r = await call('parseNaturalLanguage', { text: '' })
      expect(r.success).toBe(false)
      expect(r.error).toBe('text 必填')
    })

    test('空白文本返回错误', async () => {
      const r = await call('parseNaturalLanguage', { text: '   ' })
      expect(r.success).toBe(false)
      expect(r.error).toBe('text 必填')
    })

    test('未知 action 返回错误', async () => {
      const r = await call('unknownAction', { text: 'test' })
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/未知 action/)
    })
  })

  describe('AI 解析结果验证', () => {
    test('正确解析输入：昨天下午去了故宫', async () => {
      tcbStub.__setMockResponse(JSON.stringify({
        date: '2026-08-03',
        time: '14:00',
        title: '游览故宫',
        location: { name: '故宫' },
        content: '昨天下午去了故宫',
        expense: 0,
        confidence: 0.95,
        unparsed: '',
      }))
      const r = await call('parseNaturalLanguage', { text: '昨天下午去了故宫' })
      expect(r.success).toBe(true)
      expect(r.parsed.date).toBe('2026-08-03')
      expect(r.parsed.time).toBe('14:00')
      expect(r.parsed.title).toBe('游览故宫')
      expect(r.parsed.location.name).toBe('故宫')
      expect(r.parsed.content).toBe('昨天下午去了故宫')
      expect(r.parsed.confidence).toBeGreaterThanOrEqual(0.9)
    })

    test('无地点输入：中午吃烤鸭', async () => {
      tcbStub.__setMockResponse(JSON.stringify({
        date: '2026-08-04',
        time: '12:00',
        title: '午餐吃烤鸭',
        location: null,
        content: '中午吃烤鸭',
        expense: 0,
        confidence: 0.9,
        unparsed: '',
      }))
      const r = await call('parseNaturalLanguage', { text: '中午吃烤鸭' })
      expect(r.success).toBe(true)
      expect(r.parsed.date).toBe('2026-08-04')
      expect(r.parsed.time).toBe('12:00')
      expect(r.parsed.title).toBe('午餐吃烤鸭')
      // location 可为 null 或 { name: '' }
      if (r.parsed.location) {
        expect(r.parsed.location.name).toBeFalsy()
      }
    })

    test('带旅程上下文的解析', async () => {
      tcbStub.__setMockResponse(JSON.stringify({
        date: '2026-08-04',
        time: '07:00',
        title: '天安门看升旗',
        location: { name: '天安门' },
        content: '早上七点在天安门看升旗',
        expense: 0,
        confidence: 0.95,
        unparsed: '',
      }))
      const r = await call('parseNaturalLanguage', {
        text: '早上七点在天安门看升旗',
        tripStartDate: '2026-08-02',
        tripEndDate: '2026-08-10',
      })
      expect(r.success).toBe(true)
      expect(r.parsed.title).toBe('天安门看升旗')
      expect(r.parsed.location.name).toBe('天安门')
      expect(r.parsed.time).toBe('07:00')
    })

    test('AI 返回非 JSON 文本时回退为纯文本', async () => {
      tcbStub.__setMockResponse('抱歉，我无法理解您的输入。请重新描述。')
      const r = await call('parseNaturalLanguage', { text: '随便说点什么' })
      expect(r.success).toBe(true)
      // 回退模式：content 保留原文，其他字段为空
      expect(r.parsed.content).toBe('随便说点什么')
      expect(r.parsed.confidence).toBeLessThanOrEqual(0.5)
      expect(r.parsed.unparsed).toBeTruthy()
    })

    test('AI 调用失败时返回错误', async () => {
      tcbStub.__setMockError(new Error('AI 服务不可用'))
      const r = await call('parseNaturalLanguage', { text: '今天天气不错' })
      expect(r.success).toBe(false)
      expect(r.error).toBe('AI 解析失败')
    })

    test('AI 返回 JSON 在代码块中（```json 包裹）', async () => {
      tcbStub.__setMockResponse([
        '```json',
        JSON.stringify({
          date: '2026-08-04',
          time: '09:00',
          title: '酒店早餐',
          content: '早上在酒店吃早餐',
          expense: 0,
          confidence: 0.9,
          unparsed: '',
        }),
        '```',
      ].join('\n'))
      const r = await call('parseNaturalLanguage', { text: '早上在酒店吃早餐' })
      expect(r.success).toBe(true)
      expect(r.parsed.title).toBe('酒店早餐')
      expect(r.parsed.content).toBe('早上在酒店吃早餐')
    })
  })

  describe('关键字段校验', () => {
    test('date 格式为 YYYY-MM-DD', async () => {
      tcbStub.__setMockResponse(JSON.stringify({
        date: '2026-08-04',
        time: '15:30',
        title: '下午茶',
        content: '下午三点半喝咖啡',
        expense: 0,
        confidence: 0.9,
        unparsed: '',
      }))
      const r = await call('parseNaturalLanguage', { text: '下午三点半喝咖啡' })
      expect(r.parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    test('time 格式为 HH:MM 或空', async () => {
      tcbStub.__setMockResponse(JSON.stringify({
        date: '2026-08-04',
        time: '',
        title: '随便逛逛',
        content: '今天出去随便逛逛',
        expense: 0,
        confidence: 0.85,
        unparsed: '',
      }))
      const r = await call('parseNaturalLanguage', { text: '今天出去随便逛逛' })
      // time 可为空
      expect(r.parsed.time).toBe('')
    })

    test('title 必填且不为空', async () => {
      tcbStub.__setMockResponse(JSON.stringify({
        date: '2026-08-04',
        time: '20:00',
        title: '夜游秦淮河',
        location: { name: '秦淮河' },
        content: '晚上去秦淮河坐船',
        expense: 0,
        confidence: 0.95,
        unparsed: '',
      }))
      const r = await call('parseNaturalLanguage', { text: '晚上去秦淮河坐船' })
      expect(r.parsed.title).toBeTruthy()
      expect(r.parsed.title.length).toBeGreaterThanOrEqual(2)
    })
  })
})

// ========== 日记 CRUD 测试（含地点 location） ==========
describe('travelRecord 日记 CRUD（含地点）', () => {
  // 先创建一条旅程记录供测试使用
  let tripId
  beforeEach(async () => {
    cloud.__reset([], { OPENID: 'user1' })
    tcbStub.__resetMock()
    const r = await call('createTrip', {
      title: '北京之旅',
      startDate: '2026-08-01',
      endDate: '2026-08-05',
      location: '北京',
    })
    tripId = r.tripId
  })

  describe('addJournal', () => {
    test('添加日记含完整地点信息（名称/地址/经纬度）', async () => {
      const location = {
        name: '故宫',
        address: '北京市东城区景山前街4号',
        latitude: 39.9163,
        longitude: 116.3972,
      }
      const r = await call('addJournal', {
        tripId,
        day: 1,
        date: '2026-08-01',
        time: '14:00',
        title: '游览故宫',
        location,
        content: '下午去了故宫，非常壮观',
      })
      expect(r.success).toBe(true)
      expect(r.journalId).toBeTruthy()

      // 验证存储的数据
      const store = cloud.__store()
      const journal = store.find((s) => s._id === r.journalId)
      expect(journal).toBeTruthy()
      expect(journal.location).toEqual(location)
      expect(journal.location.name).toBe('故宫')
      expect(journal.location.latitude).toBe(39.9163)
      expect(journal.location.longitude).toBe(116.3972)
    })

    test('添加日记不含地点（location 为 null）', async () => {
      const r = await call('addJournal', {
        tripId,
        day: 2,
        date: '2026-08-02',
        title: '随便逛逛',
        content: '今天没去什么地方',
      })
      expect(r.success).toBe(true)
      const store = cloud.__store()
      const journal = store.find((s) => s._id === r.journalId)
      expect(journal.location).toBeNull()
    })

    test('添加日记含简略地点（仅名称）', async () => {
      const r = await call('addJournal', {
        tripId,
        day: 3,
        date: '2026-08-03',
        title: '吃烤鸭',
        location: { name: '全聚德' },
        content: '去全聚德吃了烤鸭',
      })
      expect(r.success).toBe(true)
      const store = cloud.__store()
      const journal = store.find((s) => s._id === r.journalId)
      expect(journal.location).toEqual({ name: '全聚德' })
    })
  })

  describe('updateJournal', () => {
    let journalId
    beforeEach(async () => {
      // 先创建一条日记
      const r = await call('addJournal', {
        tripId,
        day: 1,
        date: '2026-08-01',
        time: '14:00',
        title: '游览故宫',
        location: { name: '故宫' },
        content: '下午去了故宫',
      })
      journalId = r.journalId
    })

    test('更新日记地点（从故宫改为天坛）', async () => {
      const newLocation = {
        name: '天坛',
        address: '北京市东城区天坛内东里7号',
        latitude: 39.8822,
        longitude: 116.4066,
      }
      const r = await call('updateJournal', {
        journalId,
        location: newLocation,
      })
      expect(r.success).toBe(true)

      const store = cloud.__store()
      const journal = store.find((s) => s._id === journalId)
      expect(journal.location).toEqual(newLocation)
      expect(journal.location.name).toBe('天坛')
      expect(journal.location.latitude).toBe(39.8822)
    })

    test('更新日记清除地点（设为 null）', async () => {
      const r = await call('updateJournal', {
        journalId,
        location: null,
      })
      expect(r.success).toBe(true)

      const store = cloud.__store()
      const journal = store.find((s) => s._id === journalId)
      expect(journal.location).toBeNull()
    })

    test('更新日记不改变地点（不传 location 字段）', async () => {
      const r = await call('updateJournal', {
        journalId,
        title: '更新后的标题',
        content: '更新后的内容',
      })
      expect(r.success).toBe(true)

      const store = cloud.__store()
      const journal = store.find((s) => s._id === journalId)
      expect(journal.location).toEqual({ name: '故宫' })
      expect(journal.title).toBe('更新后的标题')
    })

    test('更新日记地点为坐标对象（来自 wx.chooseLocation 完整数据）', async () => {
      const fullLocation = {
        name: '颐和园',
        address: '北京市海淀区新建宫门路19号',
        latitude: 39.9999,
        longitude: 116.2755,
      }
      const r = await call('updateJournal', {
        journalId,
        location: fullLocation,
      })
      expect(r.success).toBe(true)

      const store = cloud.__store()
      const journal = store.find((s) => s._id === journalId)
      expect(journal.location).toEqual(fullLocation)
      // 验证所有字段都在
      expect(Object.keys(journal.location)).toEqual(['name', 'address', 'latitude', 'longitude'])
    })
  })

  describe('getTrip 返回日记含地点', () => {
    test('getTrip 返回的日记包含完整地点信息', async () => {
      const location = {
        name: '天安门',
        address: '北京市东城区长安街',
        latitude: 39.9054,
        longitude: 116.3976,
      }
      await call('addJournal', {
        tripId,
        day: 1,
        date: '2026-08-01',
        time: '07:00',
        title: '天安门看升旗',
        location,
        content: '早上七点在天安门看升旗',
      })

      const r = await call('getTrip', { tripId })
      expect(r.success).toBe(true)
      expect(r.entries.length).toBe(1)
      expect(r.entries[0].location).toEqual(location)
      expect(r.entries[0].location.latitude).toBe(39.9054)
    })

    test('getTrip 返回的日记不含地点时为 null', async () => {
      await call('addJournal', {
        tripId,
        day: 1,
        date: '2026-08-01',
        title: '无地点日记',
        content: '今天没出门',
      })

      const r = await call('getTrip', { tripId })
      expect(r.success).toBe(true)
      expect(r.entries[0].location).toBeNull()
    })
  })

  describe('旅程 CRUD 含地点', () => {
    test('创建旅程含地点', async () => {
      const r = await call('createTrip', {
        title: '上海之旅',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        location: '上海',
      })
      expect(r.success).toBe(true)
      const store = cloud.__store()
      const trip = store.find((s) => s._id === r.tripId)
      expect(trip.location).toBe('上海')
    })

    test('更新旅程地点', async () => {
      const r = await call('updateTrip', {
        tripId,
        location: '北京市',
      })
      expect(r.success).toBe(true)
      const store = cloud.__store()
      const trip = store.find((s) => s._id === tripId)
      expect(trip.location).toBe('北京市')
    })
  })
})