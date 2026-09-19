/**
 * 路由 —— 六个视图
 * =================
 * 生产环境是 file:// 加载 dist/index.html, 所以只能用 hash 模式
 * (history 模式在 file:// 下刷新会 404)。
 *
 * Detail 用 query 传参(/detail?path=xxx)而不是 path 参数:
 * Windows 路径里全是 \ 和 :, 塞进 path 段要反复转义, 用 query 更省事。
 */
import { createRouter, createWebHashHistory } from 'vue-router'

const Home = () => import('@/views/HomeView.vue')
const Series = () => import('@/views/SeriesView.vue')
const Tags = () => import('@/views/TagsView.vue')
const Scan = () => import('@/views/ScanView.vue')
const Cart = () => import('@/views/CartView.vue')
const Detail = () => import('@/views/DetailView.vue')
const Favs = () => import('@/views/FavView.vue')

export const routes = [
  { path: '/', name: 'home', component: Home, meta: { title: '看板' } },
  { path: '/series', name: 'series', component: Series, meta: { title: '系列浏览' } },
  { path: '/tags', name: 'tags', component: Tags, meta: { title: '标签浏览' } },
  { path: '/scan', name: 'scan', component: Scan, meta: { title: '扫描文件夹' } },
  { path: '/cart', name: 'cart', component: Cart, meta: { title: '角色购物车' } },
  { path: '/favs', name: 'favs', component: Favs, meta: { title: '收藏' } },
  { path: '/detail', name: 'detail', component: Detail, meta: { title: '图片详情' } },
  { path: '/:rest(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.afterEach((to) => {
  const t = to.meta?.title
  document.title = t ? `${t} · Tag 看板` : 'Tag 看板'
})
