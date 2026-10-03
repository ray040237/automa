/**
 * codeEditorAutocomplete 测试桩。
 *
 * 真实模块 import @codemirror/*，只为拿一批补全片段。
 * agent 只用 automaFuncsSnippets 的键名，桩里给几个代表性的就够。
 */
export const automaFuncsSnippets = {
  automaGetTab: () => [],
  automaNextBlock: () => [],
  automaFindTabs: () => [],
  automaOpenTab: () => [],
  automaSendPrompt: () => [],
};
