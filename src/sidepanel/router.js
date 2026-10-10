/**
 * 浏览器侧边栏的最小路由（T-199）。
 *
 * 为什么侧栏明明只有一页还要 router：面板宿主委托 `useAgentHost` 接线，而
 * `agentHost.js:99` 在 setup 期调了 `useRouter()`。Vue 的组合式 API 不允许条件
 * 调用，所以要么装 router、要么改 agentHost —— 装了更稳（agentHost 将来若新增
 * router 用法，侧栏不会再突然炸），且消除 `inject() can only be used inside
 * setup` 的告警噪音。
 *
 * 这里只有一个通配路由：侧栏自己不做页面切换（它的设置页在 newtab 里，由宿主
 * 通过 `onOpenSettings` 开标签页过去，见 sidepanel/App.vue）。留一条通配是为了
 * 任何意外的 `router.push` 不至于静默失败。
 */
import { createRouter, createWebHashHistory } from 'vue-router';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 侧栏自身没有页面可切；兜底渲染同一个 App（由 App.vue 内的面板承担）。
    { path: '/:pathMatch(.*)*', component: { template: '<div></div>' } },
  ],
});

export default router;
