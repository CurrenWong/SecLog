// agent-ui 极简 stub：仅用于 chatBot 页面级集成测试，避免加载真实 agent-ui
// 及其子组件树（markdown/collapse/chatFile/...）带来的复杂依赖。
// 测试通过 instance.selectComponent('#agentui') 注入带 appendAssistantMessage 的假对象，
// 所以这个 stub 本身不需要真实实现。
Component({
  data: {},
  methods: {},
})
