<img src="src/assets/images/icon-128.png" width="64"/>

# 流翼 FlowWing

<p>
  <img alt="Latest version" src="https://img.shields.io/github/package-json/v/ray040237/automa" />
  <img alt="Tagline" src="https://img.shields.io/badge/tagline-Pilot%20your%20browser%2C%20automate%20the%20flow.-0B0B0A" />
</p>

> 商店标题：**流翼 FlowWing — 浏览器自动化**<br />
> 标语：*Pilot your browser, automate the flow.*

An extension for automating your browser by connecting blocks. <br />
Auto-fill forms, do a repetitive task, take a screenshot, or scrape website data — the choice is yours. You can even schedule when the automation will execute!

## 安装

尚未上架 Chrome / Firefox 商店，当前请以开发模式本地加载，见下方 [Install Locally](#install-locally)。

## 关于本仓库（Fork 声明）

本仓库 fork 自 [AutomaApp/automa](https://github.com/AutomaApp/automa)。上游已停止维护，
此分支由本人接手继续维护：修 bug、补功能（内置 AI 助手、离线构建等）。

- **许可**：顶层 `business/` 目录之外的源码遵循 AGPL，见 [LICENSE.txt](./LICENSE.txt)。
- **商业代码已剥离**：上游 `business/` 目录内的源码属 Automa Commercial License（本仓库
  只含闭源包的空壳占位）。本 fork 不携带任何商业许可文件——占位已替换为
  `src/businessStubs/` 下的等价空实现，位于 AGPL 区。
- **归属**：上游的版权与许可声明全部保留。"Automa" 名称与图标的商标权归上游作者所有，
  本仓库不主张。

## Chrome Extension Builder
上游的 Extension Builder 依赖 `extension.automa.site` 云服务，该服务已随上游停更而下线，
本 fork 未内置此功能（Cloud 相关块在 offline 构建中不可用）。


## Project setup
Before running the `yarn dev` or `yarn build` script, you need to create the `getPassKey.js` file in the `src/utils` directory.  Inside the file write

```js
export default function() {
  return 'anything-you-want';
}
```

```bash
# Install dependencies
pnpm install

# Compiles and hot-reloads for development for the chrome browser
pnpm dev

# Compiles and minifies for production for the chrome browser
pnpm build

# Create a zip file from the build folder
pnpm build:zip

# Compiles and hot-reloads for development for the firefox browser
pnpm dev:firefox

# Compiles and minifies for production for the firefox browser
pnpm build:firefox

# Lints and fixes files
pnpm lint
```

### Icon Preview
v-remixicon/icons: https://preview-v-remixicon.vercel.app/

### Install Locally
#### Chrome
1. Open chrome and navigate to extensions page using this URL: chrome://extensions.
2. Enable the "Developer mode".
3. Click "Load unpacked extension" button, browse the `automa/build` directory and select it.

![Install in chrome](https://user-images.githubusercontent.com/22908993/166417152-f870bfbd-1770-4c28-b69d-a7303aebc9a6.png)

### Firefox
1. Open firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click the "Load Temporary Add-on" button.
3. Browse the `automa/build` directory and select the `manifest.json` file.

![Install in firefox](https://user-images.githubusercontent.com/22908993/166417727-3481fef4-00e5-4cf0-bb03-27fb880d993c.png)

## Contributors
Thanks to everyone who has submitted issues, made suggestions, and generally helped make this a better project.

<a href="https://github.com/AutomaApp/automa/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ray040237/automa" />
</a>

## License
Source code in this repository is variously licensed under the GNU Affero General Public License (AGPL), or the [Automa Commercial License](https://extension.automa.site/license/commercial/).

See [LICENSE.txt](./LICENSE.txt) for details.
