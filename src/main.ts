import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'
import { workoutRuntime } from './system/workoutRuntime'

import './styles/tokens.css'
import './styles/base.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 运动系统运行时：启动即接管未完成的运动（计时/GPS/落盘独立于组件，
// 悬浮运动条与沉浸页共用这一份数据源）
workoutRuntime.init()
app.mount('#app')
