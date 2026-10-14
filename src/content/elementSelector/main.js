import { createApp } from 'vue';
import vRemixicon from 'v-remixicon';
import App from './App.vue';
import compsUi from './compsUi';
import icons from './icons';
import { createContentI18n } from '../contentI18n';
import '@/assets/css/tailwind.css';

export default async function (rootElement) {
  // locale 就绪后再挂载（读 storage + 动态 import 词条，几十毫秒），
  // 避免面板先闪英文再切换。见 contentI18n.js 注释。
  const i18n = await createContentI18n();

  const appRoot = document.createElement('div');
  appRoot.setAttribute('id', 'app');

  rootElement.shadowRoot.appendChild(appRoot);

  createApp(App)
    .provide('rootElement', rootElement)
    .use(i18n)
    .use(vRemixicon, icons)
    .use(compsUi)
    .mount(appRoot);
}
