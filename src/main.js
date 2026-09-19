/**
 * 渲染进程入口
 * ============
 * 依赖顺序: pinia -> router -> App。
 * tokens.css 必须最先引入 —— 所有组件的 scoped 样式都依赖那批 CSS 变量,
 * 顺序反了会在首帧闪一下无样式的布局。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router/index.js'
import './styles/tokens.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// 组件里出现的异常不要静默: 打到控制台, 免得"某个交互没反应"却查不出原因
app.config.errorHandler = (err, instance, info) => {
  console.error('[vue error]', info, err, instance)
}

app.mount('#app')
