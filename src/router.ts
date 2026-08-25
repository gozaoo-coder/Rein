import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 路由表 = 底部导航的四个一级页面 + 二级页。
 * 约定：新增页面必须在 docs/ARCHITECTURE.md 的路由清单中登记。
 */
export const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/pages/HomePage.vue'),
    meta: { tab: '今天' },
  },
  {
    path: '/sports',
    name: 'sports',
    component: () => import('@/pages/SportsPage.vue'),
    meta: { tab: '运动' },
  },
  {
    path: '/ai',
    name: 'ai',
    component: () => import('@/pages/AIPage.vue'),
    meta: { tab: 'AI' },
  },
  {
    path: '/ai/models',
    name: 'ai-models',
    component: () => import('@/pages/ModelsPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '管理模型' },
  },
  {
    path: '/me',
    name: 'me',
    component: () => import('@/pages/ProfilePage.vue'),
    meta: { tab: '我' },
  },
  {
    path: '/focus',
    name: 'focus',
    component: () => import('@/pages/FocusPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '专注' },
  },
  {
    path: '/todos',
    name: 'todos',
    component: () => import('@/pages/TodosPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '全部待办' },
  },
  {
    path: '/nutrition',
    name: 'nutrition',
    component: () => import('@/pages/NutritionPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '营养全览' },
  },
  {
    path: '/nutrition/adjust',
    name: 'nutrition-adjust',
    component: () => import('@/pages/DietAdjustPage.vue'),
    meta: { title: '饮食调整' },
  },
  {
    path: '/nutrition/foods',
    name: 'nutrition-foods',
    component: () => import('@/pages/FoodLibraryPage.vue'),
    meta: { title: '饮食库' },
  },
  {
    path: '/ledger',
    name: 'ledger',
    component: () => import('@/pages/LedgerPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '记账' },
  },
  {
    path: '/sports/plans',
    name: 'sports-plans',
    component: () => import('@/pages/PlansPage.vue'),
    meta: { title: '全部课程' },
  },
  {
    path: '/sports/plans/:id',
    name: 'sports-plan-detail',
    component: () => import('@/pages/PlanDetailPage.vue'),
    meta: { title: '课程详情' },
  },
  {
    path: '/sports/plans/:id/edit',
    name: 'sports-plan-edit',
    component: () => import('@/pages/PlanEditPage.vue'),
    // :id = 'new' 表示新建课程
    meta: { title: '编辑课程' },
  },
  {
    path: '/sports/records',
    name: 'sports-records',
    component: () => import('@/pages/WorkoutRecordsPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '全部运动记录' },
  },
  {
    path: '/session',
    name: 'session',
    component: () => import('@/pages/SessionPage.vue'),
    // 二级沉浸页：覆盖底部导航栏，不在 TabBar 中展示
    meta: { fullscreen: true },
  },
  {
    path: '/session/run',
    name: 'session-run',
    component: () => import('@/pages/RunPage.vue'),
    meta: { fullscreen: true },
  },
] as const

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  const t = (to.meta.tab ?? to.meta.title) as string | undefined
  document.title = t ? `Rein · ${t}` : 'Rein'
})
