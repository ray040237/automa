import { createApp } from 'vue';
import { appendToDocument } from '@/utils/domMount';
import vRemixicon from 'v-remixicon';
import App from './App.vue';
import icons from './icons';
import injectAppStyles from '../../injectAppStyles';
import { createContentI18n } from '../../contentI18n';

const customCSS = `
  #app {
    font-family: 'Inter var';
    line-height: 1.5;
  }
  .content {
    width: 250px;
  }
`;

export default async function () {
  const rootElement = document.createElement('div');
  rootElement.attachShadow({ mode: 'open' });
  rootElement.setAttribute('id', 'automa-recording');
  rootElement.classList.add('automa-element-selector');
  appendToDocument(rootElement);

  await injectAppStyles(rootElement.shadowRoot, customCSS);

  // locale 就绪后再挂载，同 elementSelector。见 contentI18n.js 注释。
  const i18n = await createContentI18n();

  const appRoot = document.createElement('div');
  appRoot.setAttribute('id', 'app');
  rootElement.shadowRoot.appendChild(appRoot);

  const app = createApp(App).use(i18n).use(vRemixicon, icons);
  app.mount(appRoot);

  return app;
}
