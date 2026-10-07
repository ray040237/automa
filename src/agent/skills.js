/**
 * 技能（skill）库：T-81b。两级注入的存储侧 —— system prompt 只放索引
 * （名称/描述），正文与附带文件由 read_skill 工具按需取。
 *
 * 与 customizations.js（指令/模板）同一分工：纯校验/归一在本文件，
 * storage IO 从外部注入，node --test 直接可测。JSZip 只服务 zip 往返
 * （导入 pi / Claude Code 生态的 skill 文件夹 + 全量备份），不参与存储形状。
 *
 * **附带文件在本运行时只有「读」没有「执行」**：pi 生态 skill 里的
 * `.sh`/`.py` 靠 CLI shell，本 agent 工具链不具备 —— 附带文件是参考材料，
 * 且只收文本（TEXT_FILE_EXTENSIONS），二进制在导入时拒收并上报，不静默丢。
 *
 * 术语见 CONTEXT.md。技能正文经工具观察值通道返回，走 untrusted 包装 ——
 * 导入的 skill 可能来自第三方（网上下载的 skill 文件夹），按第三方内容对待，
 * 红线不豁免；「按技能内容办事」由 prompt 索引区的说明交代，与安全声明冲突时
 * 以安全声明为准。
 */

import JSZip from 'jszip';

export const SKILLS_KEY = 'automaAgentSkills';

/**
 * 描述的软警告阈值（UI 编辑时提示，**不阻断**）。生态技能的描述本来就长
 * （它是给模型的触发判据），硬闸会挡住导入 —— 索引体积的真正防线是
 * SKILL_INDEX_SOFT_LIMIT 总量软警告。
 */
export const SKILL_DESCRIPTION_MAX = 100;

/**
 * 正文软警告线。read_skill 的观察值预算是 READ_SKILL_MAX_CHARS（见
 * tools/skill.js），超过它的正文会被截断且模型看到截断标记 —— 不是静默，
 * 但读回来的是残缺技能，所以保存时就警告。
 */
export const SKILL_BODY_SOFT_LIMIT = 30000;
export const READ_SKILL_MAX_CHARS = 32768;

/** 单技能总量（正文 + 附带文件）软警告线。落盘与注入照常，由用户权衡。 */
export const SKILL_TOTAL_SOFT_LIMIT = 256 * 1024;

/** 索引区（名称+描述累计）软警告线：超了保存时提示精简，不阻断。 */
export const SKILL_INDEX_SOFT_LIMIT = 4096;

/**
 * 附带文件只收这些扩展名（小写，不含点）。SKILL.md 本体不受此限。
 * `.sh`/`.py` 这类执行脚本收进来也是死重，拒收并告知。
 */
export const TEXT_FILE_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'js',
  'mjs',
  'json',
  'csv',
  'yml',
  'yaml',
  'html',
  'css',
]);

/**
 * 导入包的两道硬上限（T-146）：条目数与解压后累计字符数。刻意**抛错**而不是
 * 静默截断 —— 一个刻意构造的超大 zip 会把全部内容读进内存再写进存储，
 * 用户该看到「包太大」而不是「导入成功但少了东西」。
 */
export const MAX_IMPORT_ENTRIES = 500;
export const MAX_IMPORT_CHARS = 8 * 1024 * 1024;

export function isTextPath(path) {
  const ext = String(path || '')
    .split('.')
    .pop()
    .toLowerCase();

  return TEXT_FILE_EXTENSIONS.has(ext);
}

/** zip 条目数守卫（T-146）。超限直接抛，不静默裁。 */
function assertWithinImportLimits(entries) {
  if (entries.length > MAX_IMPORT_ENTRIES) {
    throw new Error(
      `技能包条目过多（${entries.length} 个，上限 ${MAX_IMPORT_ENTRIES}），已中止导入`
    );
  }
}

/** 解压后累计字符预算（T-146）。每读一段调用一次，超限抛错。 */
function createCharBudget() {
  let used = 0;

  return (n) => {
    used += n;

    if (used > MAX_IMPORT_CHARS) {
      throw new Error(
        `技能包解压后内容过大（超过 ${MAX_IMPORT_CHARS} 字符），已中止导入`
      );
    }
  };
}

/**
 * 生成技能 id。与 newCommandId / newProviderId 同一习语：本地生成、
 * 不承担安全职责、直接用全局 crypto（eslint env 只声明 browser）。
 */
export function newSkillId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return 's_' + crypto.randomUUID();
  }

  return (
    's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

/**
 * 存储里的原始值 → 规范的技能记录。**纯函数**，坏字段归一而不是抛 ——
 * 手改存储不该让整份列表加载不出来；「填没填对」由 validateSkills 按条报错。
 *
 * files 是 {相对路径: 文本内容}；非字符串值直接丢弃（不是归一能救的形状）。
 *
 * @param {Object} raw
 * @returns {Object} {id, name, description, body, files, enabled}
 */
export function normalizeSkill(raw) {
  const src = raw || {};
  const files = {};

  if (src.files && typeof src.files === 'object') {
    Object.entries(src.files).forEach(([path, content]) => {
      const p = String(path || '')
        .trim()
        .replace(/^\/+/, '');

      if (p && typeof content === 'string') files[p] = content;
    });
  }

  return {
    id: String(src.id || '') || newSkillId(),
    name: String(src.name || '').trim(),
    description: String(src.description || '').trim(),
    body: String(src.body || ''),
    files,
    enabled: src.enabled === undefined ? true : Boolean(src.enabled),
  };
}

/**
 * 校验并归一整份技能列表。**纯函数**。
 *
 * 名称是 read_skill 的查找键、索引区的显示键，重名直接报错（与 config /
 * validateCommands 同一立场）。描述**不做上限硬校验**（T-81b 实测修正）：
 * pi / Claude Code 生态的 skill 描述本来就长（描述是给模型的触发判据，
 * 数百字符是常态），硬闸会把「导入生态技能」这个主场景挡在门外 —— 索引
 * 体积的防线是 SKILL_INDEX_SOFT_LIMIT 总量软警告（不阻断），单技能的
 * SKILL_DESCRIPTION_MAX 只作 UI 编辑时的软警告阈值。
 *
 * @param {Object[]} input
 * @returns {{ok: boolean, errors: string[], skills: Object[]}}
 */
export function validateSkills(input) {
  const errors = [];
  const skills = [];
  const seenNames = new Map();

  (Array.isArray(input) ? input : []).forEach((raw, i) => {
    const s = normalizeSkill(raw);
    const tag = s.name || `第 ${i + 1} 条`;

    if (!s.name) errors.push(`第 ${i + 1} 条技能：缺少名称`);
    if (!s.body.trim()) errors.push(`技能「${tag}」：正文（SKILL.md）不能为空`);

    if (s.name) {
      const key = s.name.toLowerCase();
      if (seenNames.has(key)) {
        errors.push(
          `技能名「${s.name}」重复了（另一条在第 ${seenNames.get(key) + 1} 位）`
        );
      } else {
        seenNames.set(key, i);
      }
    }

    skills.push(s);
  });

  return { ok: errors.length === 0, errors, skills };
}

/** 读技能列表（归一，不校验；展示用。保存走 saveSkills）。 */
export async function loadSkills(io) {
  const raw = await io.get(SKILLS_KEY);

  return (Array.isArray(raw) ? raw : []).map(normalizeSkill);
}

/** 校验并保存技能列表。校验不过不写盘。 */
export async function saveSkills(io, input) {
  const { ok, errors, skills } = validateSkills(input);
  if (!ok) return { ok: false, errors };

  await io.set(SKILLS_KEY, skills);

  return { ok: true, errors: [] };
}

/**
 * 按名称查技能。**纯函数**。刻意不做模糊匹配：模型猜错技能名时，
 * 调用方回「可用技能名列表」让它自纠，不拿最像的那个糊弄。
 *
 * @param {Object[]} skills 已归一的技能列表
 * @param {string} name
 * @returns {Object|null}
 */
export function findSkill(skills, name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();

  return (
    (skills || []).find((s) => s.enabled && s.name.toLowerCase() === key) ||
    null
  );
}

/**
 * 给 read_skill 工具用的查找实现工厂。
 *
 * @param {{get: Function}} io
 * @returns {(name: string) => Promise<{skill: Object|null, available: string[]}>}
 *   available 只列启用的技能名 —— 模型拿它自纠，停用项不该被点到名。
 */
export function readSkillFrom(io) {
  return async (name) => {
    const skills = await loadSkills(io);

    return {
      skill: findSkill(skills, name),
      available: skills.filter((s) => s.enabled).map((s) => s.name),
    };
  };
}

/**
 * 索引区要用的技能清单（promptFacts.skills）。**只含启用的** ——
 * 停用的技能不该再占 prompt 的常驻预算。
 *
 * @param {{get: Function}} io
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function getSkillIndexFrom(io) {
  const skills = await loadSkills(io);

  return skills
    .filter((s) => s.enabled && s.body.trim())
    .map((s) => ({ name: s.name, description: s.description }));
}

// —— markdown / zip 往返 ——

/**
 * 解析 SKILL.md 头部的 frontmatter（`---` 围栏的 key: value 行）。
 * **纯函数**。只认 name / description，其余键忽略 —— 我们不需要 pi 生态
 * 全部的 frontmatter 字段，贪婪解析只会带来「存了但没人读」的暗数据。
 *
 * @param {string} md
 * @returns {{attrs: Object, body: string}} body 是去掉 frontmatter 围栏后的正文
 */
export function parseFrontmatter(md) {
  const src = String(md || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);

  if (!m) return { attrs: {}, body: src };

  const attrs = {};

  m[1].split(/\r?\n/).forEach((line) => {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());

    if (kv && ['name', 'description'].includes(kv[1].toLowerCase())) {
      attrs[kv[1].toLowerCase()] = parseFrontmatterValue(kv[2]);
    }
  });

  return { attrs, body: src.slice(m[0].length) };
}

/**
 * frontmatter 值 → 原值。**只剥成对的引号**（T-145）：值内或单侧的引号是
 * 正文的一部分（旧实现的无条件 `^["']|["']$` 会把它们吃掉）。双引号内
 * 的 `\"` 由生成侧转义，这里还原。
 */
function parseFrontmatterValue(raw) {
  const v = String(raw || '').trim();

  if (/^"[\s\S]*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
  if (/^'[\s\S]*'$/.test(v)) return v.slice(1, -1);

  return v;
}

/**
 * frontmatter 反向生成（导出 SKILL.md 时用）。**值必须单行**（T-145）：
 * frontmatter 是逐行 key: value，值里的换行会把后面的内容挤成新的一行，
 * 再解析时只取到首行。值以引号起止时加一层双引号，避免解析侧把它当引号剥掉。
 */
function frontmatterTo(name, description) {
  const lines = ['---', frontmatterLine('name', name)];

  if (description) lines.push(frontmatterLine('description', description));
  lines.push('---', '');

  return lines.join('\n');
}

function frontmatterLine(key, value) {
  const v = String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim();

  if (/^["']/.test(v) || /["']$/.test(v)) {
    return `${key}: "${v.replace(/"/g, '\\"')}"`;
  }

  return `${key}: ${v}`;
}

/**
 * 从 markdown 文本建技能记录（导入 .md 用）。
 * 名称缺省回落 fallbackName（一般是文件名去扩展）。
 *
 * @param {string} md
 * @param {string=} fallbackName
 * @returns {Object} 已归一的技能记录
 */
export function skillFromMarkdown(md, fallbackName = '') {
  const { attrs, body } = parseFrontmatter(md);

  return normalizeSkill({
    name: attrs.name || fallbackName,
    description: attrs.description || '',
    body,
  });
}

/** zip 里的路径安全化（备份导出的技能文件夹名）。 */
function sanitizeFolder(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_') || 'skill';
}

/**
 * 单技能导出 zip 的字节流。SKILL.md 在根目录（带 frontmatter），
 * 附带文件按相对路径展开 —— 与 pi / Claude Code 的 skill 文件夹形状互通。
 *
 * @param {Object} skill 已归一的技能记录
 * @returns {Promise<Uint8Array>} 调用方（UI）自己包 Blob 下载
 */
export async function exportSkillZip(skill) {
  const s = normalizeSkill(skill);
  const zip = new JSZip();

  zip.file('SKILL.md', frontmatterTo(s.name, s.description) + s.body);
  Object.entries(s.files).forEach(([path, content]) => {
    // 附带文件里若有 SKILL.md，会覆盖上面的技能入口（T-147a）
    if (path.split('/').pop() === 'SKILL.md') return;

    zip.file(path, content);
  });

  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * 从 zip 导入技能。zip 里**每个 SKILL.md 视为一条技能**（根目录一个 =
 * 单技能包；多个子文件夹各一个 = 一把多技能，生态里的合集包直接吃）。
 *
 * 附带文件取该 SKILL.md 同目录下的其余文本文件；二进制/不支持的扩展名
 * 进 rejected 上报 —— **不静默丢**是硬要求。
 *
 * @param {File|Blob|Uint8Array} file
 * @returns {Promise<{skills: Object[], rejected: Array<{path: string, reason: string}>}>}
 */
export async function importSkillsZip(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((e) => !e.dir);

  assertWithinImportLimits(entries);

  const skillEntries = entries.filter((e) => {
    const parts = e.name.split('/');

    return parts[parts.length - 1] === 'SKILL.md';
  });

  if (skillEntries.length === 0) {
    throw new Error('zip 里没有找到 SKILL.md —— 请确认这是技能包');
  }

  // 每个技能入口的所在目录（根技能为 ''）：用来把**别的技能的整棵子树**
  // 从本条技能的附带文件里排除（T-144）。只比 '=== SKILL.md' 挡不住
  // 「根技能吞掉子目录技能」——根技能的 dir 是空串，前缀过滤不生效。
  const skillDirs = skillEntries.map((e) => {
    const at = e.name.lastIndexOf('/');

    return at === -1 ? '' : e.name.slice(0, at);
  });

  const skills = [];
  const rejected = [];
  const budget = createCharBudget();

  for (const entry of skillEntries) {
    // 根目录的 SKILL.md 没有 '/' —— lastIndexOf 返回 -1 时目录必须取空串，
    // 否则 slice(0, -1) 会把它切成 'SKILL.m'，附带文件全部对不上
    const slashAt = entry.name.lastIndexOf('/');
    const dir = slashAt === -1 ? '' : entry.name.slice(0, slashAt);
    const folderName = dir ? dir.split('/').pop() : '';
    const md = await entry.async('string');

    budget(md.length);
    const skill = skillFromMarkdown(
      md,
      folderName.replace(/\.md$/i, '') || 'skill'
    );

    if (!skill.name) {
      rejected.push({
        path: entry.name,
        reason: 'SKILL.md 缺少名称（frontmatter 与文件名都没有）',
      });
      continue;
    }

    // 同名文件按路径去重（zip 内本就不会重复，防御手改包）
    const files = {};

    for (const other of entries) {
      if (other === entry) continue;
      // 落在别的技能目录里的条目属于那条技能，不是本条的附带文件（T-144）
      if (
        skillDirs.some((d) => d && d !== dir && other.name.startsWith(d + '/'))
      ) {
        continue;
      }

      if (dir && !other.name.startsWith(dir + '/')) continue;
      // 根目录 SKILL.md 的技能吃下 zip 里全部其余文件（含子目录）——
      // 不要按「有没有 /」排除，那会把 reference/api.md 这类参考文档拒掉。

      const rel = dir ? other.name.slice(dir.length + 1) : other.name;

      if (!rel || rel === 'SKILL.md') continue;

      if (!isTextPath(rel)) {
        rejected.push({
          path: other.name,
          reason: '二进制/不支持的文件类型，未导入',
        });
        continue;
      }

      const content = await other.async('string');

      budget(content.length);
      files[rel] = content;
    }

    skill.files = files;
    skills.push(skill);
  }

  return { skills, rejected };
}

/**
 * 全量备份（技能 + 模板 + 指令）导出。
 *
 * 结构：`automa-agent-backup.json`（模板与指令 —— 它们没有文件语义，
 * 直接 JSON）+ `skills/<名称>/SKILL.md` 与附带文件（技能走文件形状，
 * 与生态互通）。
 *
 * @param {{skills: Object[], commands: Object[], instructions: {text: string, enabled: boolean}}}
 * @returns {Promise<Uint8Array>}
 */
export async function exportBackupZip({ skills, commands, instructions }) {
  const zip = new JSZip();
  const normalized = (skills || []).map(normalizeSkill);

  zip.file(
    'automa-agent-backup.json',
    JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        commands,
        instructions,
        // 技能的正文与 files 走文件形状（与生态互通），但 enabled/id 是
        // 记录级状态，文件形态带不了 —— 单独记在 JSON 里，否则恢复后
        // 停用技能全部复活、id 全部重生（T-141）
        skills: normalized.map((s) => ({
          name: s.name,
          description: s.description,
          enabled: s.enabled,
          id: s.id,
        })),
      },
      null,
      2
    )
  );

  // 目录名去重：两个技能名清洗后同名（A/B 与 A\B、大小写差异）会互相覆盖
  // 而丢技能（T-147b）
  const usedFolders = new Set();

  for (const s of normalized) {
    const stem = sanitizeFolder(s.name);
    let folder = stem;
    let n = 2;

    while (usedFolders.has(folder.toLowerCase())) {
      folder = `${stem}-${n}`;
      n += 1;
    }
    usedFolders.add(folder.toLowerCase());

    const base = 'skills/' + folder;

    zip.file(`${base}/SKILL.md`, frontmatterTo(s.name, s.description) + s.body);
    Object.entries(s.files).forEach(([path, content]) => {
      if (path.split('/').pop() === 'SKILL.md') return;

      zip.file(`${base}/${path}`, content);
    });
  }

  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * 全量备份导入。skills 走 importSkillsZip 的同一解析；commands / instructions
 * 从备份 JSON 原样带出（**合并策略由调用方定**：本函数只解包，不写盘）。
 *
 * @param {File|Blob|Uint8Array} file
 * @returns {Promise<{skills: Object[], commands: Object[], instructions: Object|null, rejected: Array}>}
 */
export async function importBackupZip(file) {
  const zip = await JSZip.loadAsync(file);
  const jsonEntry = zip.file('automa-agent-backup.json');

  if (!jsonEntry) {
    throw new Error(
      '不是备份包（缺少 automa-agent-backup.json）——请用「导入技能包」'
    );
  }

  const meta = JSON.parse(await jsonEntry.async('string'));

  // 备份 JSON 里记的技能元数据（含 enabled/id —— 文件形态带不了的记录级状态，T-141）
  const metaByName = new Map(
    (Array.isArray(meta.skills) ? meta.skills : []).map((s) => [
      String((s && s.name) || '').toLowerCase(),
      s,
    ])
  );

  // 直接在备份包上扫描 skills/ 目录 —— 与 importSkillsZip 共用
  // 「SKILL.md 定位 + 文本过滤 + 拒收上报」的判定，不另写一份扫描逻辑。
  const entries = Object.values(zip.files).filter((e) => !e.dir);

  assertWithinImportLimits(entries);

  const mdEntries = entries.filter((e) => e.name.endsWith('/SKILL.md'));
  const skills = [];
  const rejected = [];
  const budget = createCharBudget();

  for (const entry of mdEntries) {
    const slashAt = entry.name.lastIndexOf('/');
    const dir = slashAt === -1 ? '' : entry.name.slice(0, slashAt);
    const md = await entry.async('string');

    budget(md.length);
    const folderName = dir.split('/').pop() || '';
    const skill = skillFromMarkdown(md, folderName);

    if (!skill.name) {
      rejected.push({ path: entry.name, reason: 'SKILL.md 缺少名称' });
      continue;
    }

    // 以备份 JSON 里的记录级状态回盖（T-141）：恢复后停用技能仍是停用、
    // id 保持稳定。JSON 缺这条（旧备份包）时保持 normalize 的默认。
    const metaSkill = metaByName.get(skill.name.toLowerCase());

    if (metaSkill) {
      if (metaSkill.enabled !== undefined) {
        skill.enabled = Boolean(metaSkill.enabled);
      }
      if (metaSkill.id) skill.id = String(metaSkill.id);
    }

    const files = {};

    for (const other of entries) {
      if (other === entry || !other.name.startsWith(dir + '/')) continue;

      const rel = other.name.slice(dir.length + 1);

      if (!rel || rel === 'SKILL.md') continue;

      if (!isTextPath(rel)) {
        rejected.push({
          path: other.name,
          reason: '二进制/不支持的文件类型，未导入',
        });
        continue;
      }

      const content = await other.async('string');

      budget(content.length);
      files[rel] = content;
    }

    skill.files = files;
    skills.push(skill);
  }

  return {
    skills,
    commands: Array.isArray(meta.commands) ? meta.commands : [],
    instructions:
      meta.instructions && typeof meta.instructions === 'object'
        ? meta.instructions
        : null,
    rejected,
  };
}

/**
 * 按名称合并技能（备份导入用）：已存在的更新、新的追加。
 *
 * **纯函数** —— 写盘由调用方决定；合并永远有名有姓（added/updated 计数），
 * UI 如实上报，不静默。
 *
 * @param {Object[]} existing
 * @param {Object[]} incoming
 * @returns {{merged: Object[], added: number, updated: number}}
 */
export function mergeSkills(existing, incoming) {
  const byName = new Map(
    (existing || []).map((s) => [s.name.toLowerCase(), s])
  );
  let added = 0;
  let updated = 0;

  for (const raw of incoming || []) {
    const src = raw || {};
    const s = normalizeSkill(src);
    const key = s.name.toLowerCase();
    const prev = byName.get(key);

    if (prev) {
      // incoming 缺 enabled/id 时保留原有值（T-142）：normalizeSkill 会补
      // enabled:true 与新 id，直接 {...prev, ...s} 会把用户停用的技能重新
      // 启用、把稳定 id 换掉。zip/.md 导入的记录本就不带这两个字段。
      const next = { ...prev, ...s };

      if (src.enabled === undefined) next.enabled = prev.enabled;
      if (!src.id) next.id = prev.id;

      byName.set(key, next);
      updated += 1;
    } else {
      byName.set(key, s);
      added += 1;
    }
  }

  return { merged: [...byName.values()], added, updated };
}

/**
 * 单技能总量（正文 + 附带文件）的字符数。保存时 UI 拿它对比
 * SKILL_TOTAL_SOFT_LIMIT 做软警告。
 */
export function skillTotalChars(skill) {
  const s = normalizeSkill(skill);
  const files = Object.values(s.files).reduce((n, c) => n + c.length, 0);

  return s.body.length + files;
}
