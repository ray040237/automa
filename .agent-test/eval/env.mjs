/**
 * eval 集合共用的 .env 读取与配置构造。
 *
 * 原来 5 个 live 脚本各自抄了一份「读 .env → 拼 CONFIG」，模型名散在 5 处，
 * 「换模型对比」要先改 5 个文件。这里收成一份：本文件是唯一读 `.env` 的地方。
 *
 * 只有**一套运行时配置**（`agentConfig`）—— pi 迁移（ADR 0004）后 provider 接线
 * 与 `resolveActiveConfig` 的产物是同一份扁平结构：`createPiProvider` 要
 * `provider/baseUrl/apiKey/model/temperature/contextWindow`，正是扁平配置的形状。
 *
 * 但**落盘配置**（`saveConfig` / `loadConfig`）自 T-97 起是 v2 多连接文档
 * `{version, providers[], activeProviderId, activeModelId, temperature}` ——
 * 扁平形状喂给 `saveConfig` 会被校验成「零连接」（空 providers 合法），
 * 读回就只剩默认值。故另有 `configDoc()` 造 v2 文档，供装配层写盘用。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 仓库根（`.agent-test/eval/` 往上两级）。 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 把 `.env` 文本切成键值对；空行与 `#` 注释行忽略。 */
export function parseEnv(text) {
  return Object.fromEntries(
    String(text)
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');

        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

/** 读仓库根的 `.env`；缺文件时抛带 `code` 的错误，让 runner 能给出人话提示。 */
export function loadEnv(root = ROOT) {
  try {
    return parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  } catch (err) {
    const e = new Error(`读不到 ${join(root, '.env')}：${err.message}`);

    e.code = 'ENV_MISSING';
    throw e;
  }
}

/**
 * 唯一一套配置：`createPiProvider` 与 `saveConfig` 都吃它。
 *
 * `provider` 固定 `custom`（BYOK，见 config.js 的 PROVIDERS 口径）；
 * `contextWindow` 是给 pi 的模型元数据、也是压缩预算来源（provider.js head 第 2 条）。
 */
export function agentConfig(env, over = {}) {
  return {
    provider: 'custom',
    baseUrl: env.modelscope_url,
    apiKey: env.modelscope_api_key,
    model: env.modelscope_model,
    temperature: 0.2,
    contextWindow: 32000,
    ...over,
  };
}

/**
 * 落盘用的 v2 文档 —— `saveConfig(index.configIO, doc)` 吃这个形状。
 *
 * 单连接：一条 provider（id `eval-conn`），一个模型，active 指向它。
 * `loadConfig` 会把它 resolve 回与 `agentConfig` 等价的扁平配置。
 */
export function configDoc(env, over = {}) {
  const cfg = agentConfig(env, over);
  const providerId = 'eval-conn';

  return {
    version: 2,
    providers: [
      {
        id: providerId,
        name: 'eval',
        templateId: 'custom',
        baseUrl: cfg.baseUrl,
        // v2 文档里这里放**明文**：saveConfig 负责加密。缺模板字段时校验会报
        // 「缺少 API Key」或「至少添加一个模型」。
        apiKey: cfg.apiKey,
        models: [
          {
            id: cfg.model,
            contextWindow: cfg.contextWindow,
            maxTokens: cfg.maxTokens || 0,
          },
        ],
      },
    ],
    activeProviderId: providerId,
    activeModelId: cfg.model,
    temperature: cfg.temperature,
  };
}

/**
 * 极简参数解析：`--only=agent/chat` / `--model=xxx` / `--base-url=xxx`。
 * `--flag`（不带值）解析为 `true`。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {};

  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);

    if (!m) continue;

    // --base-url -> baseUrl
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    opts[key] = m[2] === undefined ? true : m[2];
  }

  return opts;
}