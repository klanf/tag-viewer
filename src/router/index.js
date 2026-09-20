/**
 * 路由 —— 八个视图
 * =================
 * 生产环境是 file:// 加载 dist/index.html, 所以只能用 hash 模式
 * (history 模式在 file:// 下刷新会 404)。
 *
 * Detail 用 query 传参(/detail?path=xxx)而不是 path 参数:
 * Windows 路径里全是 \ 和 :, 塞进 path 段要反复转义, 用 query 更省事。
 *
 * `/tags/:tag`(某个标签的图片列表)反过来**必须**用 path 参数 —— 它是标签列表的
 * 下一级页面, 层级要写进地址栏(能后退一步回列表、能当深链分享)。
 * 标签名里的 `/`(如 `bb_(fate/extra)`)由 vue-router 编码成 %2F 再解回来, 实测无碍。
 */
import { createRouter, createWebHashHistory } from 'vue-router'

const Home = () => import('@/views/HomeView.vue')
const Series = () => import('@/views/SeriesView.vue')
const Tags = () => import('@/views/TagsView.vue')
const TagImages = () => import('@/views/TagImagesView.vue')
const Scan = () => import('@/views/ScanView.vue')
const Sources = () => import('@/views/SourceView.vue')
const Cart = () => import('@/views/CartView.vue')
const Detail = () => import('@/views/DetailView.vue')
const Favs = () => import('@/views/FavView.vue')

export const routes = [
  { path: '/', name: 'home', component: Home, meta: { title: '看板' } },
  { path: '/series', name: 'series', component: Series, meta: { title: '系列浏览' } },
  {
    path: '/tags',
    name: 'tags',
    component: Tags,
    meta: { title: '标签浏览' },
    /* 旧地址兼容: 2026-09-20 之前"点标签"的落点是 /tags?tag=xxx, 现在子页面
       有了自己的路径。老书签/老深链进来直接转过去, 不要在标签列表上停一下。 */
    beforeEnter: (to) => (to.query.tag
      ? { name: 'tag-images', params: { tag: String(to.query.tag) } }
      : true),
  },
  { path: '/tags/:tag', name: 'tag-images', component: TagImages, meta: { title: '标签图片' } },
  { path: '/scan', name: 'scan', component: Scan, meta: { title: '扫描文件夹' } },
  { path: '/sources', name: 'sources', component: Sources, meta: { title: '来源管理' } },
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
