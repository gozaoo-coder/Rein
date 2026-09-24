import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'
import { initRubberScroll } from './system/rubberScroll'
import { shareInbox } from './system/shareInbox'
import { workoutRuntime } from './system/workoutRuntime'

import './styles/tokens.css'
import './styles/base.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 运动系统运行时：启动即接管未完成的运动（计时/GPS/落盘独立于组件，
// 悬浮运动条与沉浸页共用这一份数据源）
workoutRuntime.init()
// 分享收件箱运行时：接收系统分享/打开的文件，路由到 AI 页预填
shareInbox.init()
// 超范围回弹：到边拖动改为自绘平移（Android 原生 stretch 已在 MainActivity 关闭）
initRubberScroll()
app.mount('#app')
