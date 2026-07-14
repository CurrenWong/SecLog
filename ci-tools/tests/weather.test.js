const simulate = require('miniprogram-simulate')
const path = require('path')

// 组件路径：miniprogram-simulate 内部拼 `${componentPath}.json/.wxml/.wxss/.js`，
// 微信组件文件名为 index.*，所以这里必须带 /index
const COMPONENT_PATH = path.resolve(__dirname, '../../miniprogram/components/toolCard/weather/index')

// 关键：miniprogram-simulate / j-component 的内部 cache 在「多次 load 同一组件」时会冲突，
// 导致后续 render 拿不到 componentManager（返回 undefined）。
// 因此只在 beforeAll 里 load 一次，所有用例复用同一个 componentId。
let componentId
beforeAll(() => {
  componentId = simulate.load(COMPONENT_PATH)
})

// 构造一个合法的 weather toolData（与小程序运行时结构一致）
function buildWeatherToolData() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          result: {
            forecast: [
              {
                city: '上海',
                district: '浦东',
                infos: [
                  {
                    date: '2026-07-14',
                    week: '周二',
                    day: { weather: '晴', temperature: 33 },
                    night: { weather: '多云', temperature: 25 },
                  },
                  {
                    date: '2026-07-15',
                    week: '周三',
                    day: { weather: '雷阵雨', temperature: 30 },
                    night: { weather: '雨', temperature: 24 },
                  },
                ],
              },
            ],
          },
        }),
      },
    ],
  }
}

describe('toolCard/weather 组件', () => {
  test('transformWeather 中文天气 -> 英文图标名', () => {
    const comp = simulate.render(componentId)
    const inst = comp.instance

    expect(inst.transformWeather('晴')).toBe('sunny')
    expect(inst.transformWeather('多云')).toBe('cloudy')
    expect(inst.transformWeather('阴')).toBe('overcast')
    expect(inst.transformWeather('雨')).toBe('rainy')
    expect(inst.transformWeather('雪')).toBe('snowy')
    expect(inst.transformWeather('雷阵雨')).toBe('thunderstorm')
    expect(inst.transformWeather('未知天气')).toBe('sunny') // 默认兜底
  })

  test('initWeather 从 toolData 正确填充 city / forecasts / today', async () => {
    const toolData = buildWeatherToolData()
    const comp = simulate.render(componentId, { name: 'weather', toolData })
    const inst = comp.instance
    // miniprogram-simulate 不自动触发 lifetimes.attached，手动调用等价逻辑
    inst.initWeather()
    await simulate.sleep(10) // 等待 setData 异步生效

    expect(inst.data.city).toBe('上海')
    expect(Array.isArray(inst.data.forecasts)).toBe(true)
    expect(inst.data.forecasts.length).toBe(2)

    const f0 = inst.data.forecasts[0]
    expect(f0.dayweather).toBe('晴')
    expect(f0.daytemp).toBe(33)
    expect(f0.nightweather).toBe('多云')
    expect(f0.nighttemp).toBe(25)
    expect(f0.dayweatherIcon).toBe('sunny')
    expect(f0.nightweatherIcon).toBe('cloudy')
    expect(f0.date).toBe('07/14')

    const f1 = inst.data.forecasts[1]
    expect(f1.dayweatherIcon).toBe('thunderstorm')
    expect(f1.nightweatherIcon).toBe('rainy')

    expect(inst.data.today.dayweather).toBe('晴')
    expect(inst.data.today.daytemp).toBe(33)
    expect(inst.data.today.nightweather).toBe('多云')
    expect(inst.data.today.nighttemp).toBe(25)
  })

  test('name 非 weather 时不填充数据', () => {
    const comp = simulate.render(componentId, { name: 'other', toolData: buildWeatherToolData() })
    const inst = comp.instance
    inst.initWeather()

    expect(inst.data.city).toBe('')
    expect(inst.data.forecasts.length).toBe(0)
  })
})
