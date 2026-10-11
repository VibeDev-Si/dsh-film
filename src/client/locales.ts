/** The two languages the Host can ask for; anything else falls back to English. */
export const zh: Record<string, string> = {
  'tab.title': '影视工作台',
  'tab.guide.description': '小说拆解、剧本、画布、导演台与剪辑，模型使用已登录的 VibeDev 账号',
  'app.loading': '影视工作台加载中',
  'app.failed': '影视工作台没有启动成功。',
  'app.retry': '重试',
  'app.hint': '若一直失败，请在插件设置里确认已启用 VibeDev 账号插件。',
  'app.lost': '工作台服务在两分钟内多次断开，已停止自动重连。点"重试"再开一次；若仍断开，请把数据目录 logs 里最新的日志发给我们。',
}

export const en: Record<string, string> = {
  'tab.title': 'Film Studio',
  'tab.guide.description': 'Novel breakdown, screenplay, storyboard, director desk and editing, on the signed-in VibeDev account',
  'app.loading': 'Loading Film Studio',
  'app.failed': 'Film Studio did not start.',
  'app.retry': 'Retry',
  'app.hint': 'If it keeps failing, check that the VibeDev account plugin is enabled.',
  'app.lost': 'The workbench service dropped several times in two minutes, so automatic reconnection stopped. Press Retry to open it again; if it keeps dropping, send us the newest log from the data directory.',
}
