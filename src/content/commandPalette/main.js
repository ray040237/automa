import { createApp } from 'vue';
import vRemixicon from 'v-remixicon';
import App from './App.vue';
import compsUi from './compsUi';
import icons from './icons';
import { createContentI18n } from '../contentI18n';

const additionalStyle = `.list-item-active svg { visibility: visible }`;

export default async function (rootElement) {
  // 同 elementSelector：locale 就绪后再挂载，见 contentI18n.js 注释。
  const i18n = await createContentI18n();

  const appRoot = document.createElement('div');
  appRoot.setAttribute('id', 'app');

  const style = document.createElement('style');
  style.textContent = additionalStyle;

  rootElement.shadowRoot.appendChild(style);
  rootElement.shadowRoot.appendChild(appRoot);

  createApp(App)
    .use(compsUi)
    .use(i18n)
    .use(vRemixicon, icons)
    .provide('rootElement', rootElement)
    .mount(appRoot);
}
