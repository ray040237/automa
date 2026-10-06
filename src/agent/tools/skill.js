/**
 * read_skill 工具（T-81b）：两级注入的「按需读全文」侧。
 *
 * system prompt 只带技能索引（名称/描述），任务匹配时模型用本工具取回
 * SKILL.md 正文或某个附带文件。class: read（免确认门，ADR 0002），
 * group: context（与 get_variables / get_block_schema 同类，宿主
 * enabledGroups 零改动 —— T-81b 拍板）。
 *
 * 技能名**不做模糊匹配**：猜错名字时回「可用技能名列表」让模型自纠，
 * 不拿最像的那个糊弄（get_block_schema 同款立场）。
 *
 * 观察值预算：技能正文是用户主动导入、点名要读的内容，8K 的全局默认会把
 * 大技能砍残 —— 本工具把观察值上限放宽到 READ_SKILL_MAX_CHARS（32K），
 * 经 envelope 的 maxChars 字段传给 wrapObservation；超限依然截断且模型
 * 看得到截断标记，不是静默。
 *
 * 正文经 untrusted_tool_result 包装 —— 导入的技能可能是第三方产物，
 * 红线不豁免（见 skills.js 头注）。
 */

import { READ_SKILL_MAX_CHARS } from '../skills';

export const readSkillTool = {
  name: 'read_skill',
  class: 'read',
  group: 'context',
  ctx: ['readSkill'],
  description:
    '读取某个技能的全文（SKILL.md 正文，或 path 指定的附带文件）。' +
    '系统提示的技能索引里标明何时用哪个技能；当前任务与某个技能匹配时，' +
    '先读全文再动手，不要只凭索引里的描述猜技能内容。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（见系统提示的技能索引）。' },
      path: {
        type: 'string',
        description:
          '可选。要读的附带文件相对路径（如 reference/api.md）。' +
          '省略时返回 SKILL.md 正文。',
      },
    },
    required: ['name'],
  },
  async execute(args, ctx) {
    const name = String((args && args.name) || '').trim();
    const path = String((args && args.path) || '').trim();
    const { skill, available } = await ctx.readSkill(name);

    if (!skill) {
      return {
        status: 'error',
        payload: available.length
          ? `没有叫「${name}」的技能。可用技能：${available.join('、')}。`
          : '当前没有任何可用技能。',
      };
    }

    if (path) {
      const content = skill.files[path];

      if (content === undefined) {
        const paths = Object.keys(skill.files);

        return {
          status: 'error',
          payload: paths.length
            ? `技能「${
                skill.name
              }」没有附带文件「${path}」。可用文件：${paths.join('、')}。`
            : `技能「${skill.name}」没有任何附带文件，只有 SKILL.md 正文。`,
        };
      }

      return {
        payload: `【技能附带文件 ${path}】\n${content}`,
        maxChars: READ_SKILL_MAX_CHARS,
      };
    }

    return {
      payload: `【技能「${skill.name}」全文】\n${skill.body}`,
      maxChars: READ_SKILL_MAX_CHARS,
    };
  },
};
