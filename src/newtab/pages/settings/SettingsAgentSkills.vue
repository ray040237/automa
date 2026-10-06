<template>
  <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
    <div class="mb-2 flex items-center gap-2">
      <p class="flex-1 font-semibold">
        {{ t('settings.agent.skills.title') }}
      </p>
      <ui-button @click="startAdd">
        <v-remixicon name="riAddLine" class="mr-1 -ml-1" size="18" />
        {{ t('settings.agent.skills.add') }}
      </ui-button>
    </div>

    <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
      {{ t('settings.agent.skills.hint') }}
    </p>

    <!-- 导入 / 备份：两个隐藏 file input，按钮触发（同一种文件动作两种包，
         分开两个 input 让 accept 各自精确，也避免共用状态互相踩） -->
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <ui-button @click="fileMd.click()">
        <v-remixicon name="riFileUploadLine" class="mr-1 -ml-1" size="18" />
        {{ t('settings.agent.skills.importMd') }}
      </ui-button>
      <ui-button @click="fileZip.click()">
        <v-remixicon name="riFolderUploadLine" class="mr-1 -ml-1" size="18" />
        {{ t('settings.agent.skills.importZip') }}
      </ui-button>
      <ui-button @click="exportBackup">
        <v-remixicon name="riDownloadLine" class="mr-1 -ml-1" size="18" />
        {{ t('settings.agent.skills.exportBackup') }}
      </ui-button>
      <ui-button @click="fileBackup.click()">
        <v-remixicon name="riHistoryLine" class="mr-1 -ml-1" size="18" />
        {{ t('settings.agent.skills.importBackup') }}
      </ui-button>
      <input
        ref="fileMd"
        type="file"
        class="hidden"
        accept=".md,.markdown,text/markdown"
        @change="onImportMd"
      />
      <input
        ref="fileZip"
        type="file"
        class="hidden"
        accept=".zip,application/zip"
        @change="onImportZip"
      />
      <input
        ref="fileBackup"
        type="file"
        class="hidden"
        accept=".zip,application/zip"
        @change="onImportBackup"
      />
    </div>

    <ul
      v-if="notice"
      class="mb-3 rounded p-2 text-xs"
      :class="
        noticeKind === 'error'
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-green-500/10 text-green-700 dark:text-green-400'
      "
    >
      <li v-for="(line, i) in notice" :key="i">{{ line }}</li>
    </ul>

    <ul v-if="skills.length" class="flex flex-col gap-2">
      <li
        v-for="s in skills"
        :key="s.id"
        class="rounded-lg bg-box-transparent p-2"
      >
        <div v-if="editingId !== s.id" class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm font-semibold">
            {{ s.name }}
          </span>
          <span
            v-if="s.description"
            class="hidden min-w-0 flex-1 truncate text-xs opacity-60 sm:block"
          >
            {{ s.description }}
          </span>
          <span
            v-if="Object.keys(s.files).length"
            class="shrink-0 text-xs opacity-60"
          >
            {{
              t('settings.agent.skills.fileCount', {
                n: Object.keys(s.files).length,
              })
            }}
          </span>
          <ui-switch
            :model-value="s.enabled"
            @update:model-value="toggleEnabled(s, $event)"
          />
          <button
            type="button"
            class="shrink-0 text-xs text-gray-500 underline"
            @click="exportOne(s)"
          >
            {{ t('settings.agent.skills.exportOne') }}
          </button>
          <button
            type="button"
            class="shrink-0 text-xs text-gray-500 underline"
            @click="startEdit(s)"
          >
            {{ t('settings.agent.skills.edit') }}
          </button>
          <v-remixicon
            name="riDeleteBin7Line"
            class="shrink-0 cursor-pointer text-gray-600 hover:text-red-500 dark:text-gray-200"
            @click="removeSkill(s)"
          />
        </div>

        <!-- 编辑表单 -->
        <div v-else class="flex flex-col gap-2">
          <div class="flex flex-wrap gap-2">
            <ui-input
              v-model="form.name"
              class="w-48"
              :label="t('settings.agent.skills.name')"
              autocomplete="off"
            />
            <ui-input
              v-model="form.description"
              class="min-w-64 flex-1"
              :label="t('settings.agent.skills.description')"
              autocomplete="off"
            />
          </div>
          <ui-textarea
            v-model="form.body"
            rows="8"
            :label="t('settings.agent.skills.body')"
          />
          <p
            v-if="formWarnings.length"
            class="rounded bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400"
          >
            {{ formWarnings.join('；') }}
          </p>
          <div class="flex items-center gap-2">
            <p
              v-if="formErrors.length"
              class="min-w-0 flex-1 truncate rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
            >
              {{ formErrors.join('；') }}
            </p>
            <ui-button class="ml-auto" @click="cancelEdit">
              {{ t('common.cancel') }}
            </ui-button>
            <ui-button variant="accent" @click="commitEdit">
              {{ t('common.save') }}
            </ui-button>
          </div>
        </div>
      </li>
    </ul>

    <p
      v-if="!skills.length && !adding"
      class="text-sm text-gray-600 dark:text-gray-200"
    >
      {{ t('settings.agent.skills.empty') }}
    </p>

    <!-- 新增表单在列表外：新记录还没有 id，塞进 v-for 里等于永远渲染不出来
         （T-81a 在 SettingsAgentCommands 里踩过同一个坑） -->
    <div v-if="adding" class="mt-2 rounded-lg bg-box-transparent p-2">
      <div class="flex flex-wrap gap-2">
        <ui-input
          v-model="form.name"
          class="w-48"
          :label="t('settings.agent.skills.name')"
          autocomplete="off"
        />
        <ui-input
          v-model="form.description"
          class="min-w-64 flex-1"
          :label="t('settings.agent.skills.description')"
          autocomplete="off"
        />
      </div>
      <ui-textarea
        v-model="form.body"
        rows="8"
        class="mt-2"
        :label="t('settings.agent.skills.body')"
      />
      <p
        v-if="formWarnings.length"
        class="mt-2 rounded bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400"
      >
        {{ formWarnings.join('；') }}
      </p>
      <div class="mt-2 flex items-center gap-2">
        <p
          v-if="formErrors.length"
          class="min-w-0 flex-1 truncate rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
        >
          {{ formErrors.join('；') }}
        </p>
        <ui-button class="ml-auto" @click="cancelEdit">
          {{ t('common.cancel') }}
        </ui-button>
        <ui-button variant="accent" @click="commitAdd">
          {{ t('common.save') }}
        </ui-button>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 技能管理（T-81b）：两级注入的存储侧 UI。
 *
 * 模板（T-81a）与技能同属用户内容库，交互立场一致：增删改启停**逐动作
 * 立即落盘**；导入永远有名有姓地汇报（几条新增、几条更新、哪些文件被拒收
 * —— 不静默丢）。合并策略：技能按名称覆盖更新；备份里的指令只在当前为空
 * 时套用，绝不悄悄覆盖用户已有的指令。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import { configIO } from '@/agent';
import {
  loadCommands,
  loadInstructions,
  saveCommands,
  saveInstructions,
} from '@/agent/customizations';
import {
  SKILL_BODY_SOFT_LIMIT,
  SKILL_DESCRIPTION_MAX,
  SKILL_INDEX_SOFT_LIMIT,
  SKILL_TOTAL_SOFT_LIMIT,
  exportBackupZip,
  exportSkillZip,
  importBackupZip,
  importSkillsZip,
  loadSkills,
  mergeSkills,
  saveSkills,
  skillFromMarkdown,
} from '@/agent/skills';

const { t } = useI18n();
const toast = useToast();

const skills = ref([]);
const editingId = ref('');
const adding = ref(false);
const formErrors = ref([]);
const form = reactive({
  id: '',
  name: '',
  description: '',
  body: '',
  files: {},
});
const notice = ref([]);
const noticeKind = ref('info');

const fileMd = ref(null);
const fileZip = ref(null);
const fileBackup = ref(null);

const formWarnings = computed(() => {
  const total =
    form.body.length +
    Object.values(form.files || {}).reduce((n, c) => n + c.length, 0);
  const lines = [];

  if (form.body.length > SKILL_BODY_SOFT_LIMIT) {
    lines.push(
      t('settings.agent.skills.warnBody', { limit: SKILL_BODY_SOFT_LIMIT })
    );
  }
  if (total > SKILL_TOTAL_SOFT_LIMIT) {
    lines.push(
      t('settings.agent.skills.warnTotal', {
        limit: Math.round(SKILL_TOTAL_SOFT_LIMIT / 1024),
      })
    );
  }
  if (form.description.length > SKILL_DESCRIPTION_MAX) {
    lines.push(
      t('settings.agent.skills.warnDescription', {
        limit: SKILL_DESCRIPTION_MAX,
        n: form.description.length,
      })
    );
  }

  return lines;
});

/** 索引区常驻成本（名称+描述累计）超预算的软警告，列表实时算。 */
const indexOver = computed(
  () =>
    skills.value
      .filter((s) => s.enabled)
      .reduce((n, s) => n + s.name.length + s.description.length, 0) >
    SKILL_INDEX_SOFT_LIMIT
);

function setNotice(lines, kind = 'info') {
  notice.value = lines;
  noticeKind.value = kind;
}

async function refresh() {
  skills.value = await loadSkills(configIO);

  if (indexOver.value) {
    setNotice(
      [t('settings.agent.skills.warnIndex', { limit: SKILL_INDEX_SOFT_LIMIT })],
      'error'
    );
  }
}

onMounted(refresh);

function showResult(lines) {
  setNotice(lines, 'info');
  setTimeout(() => {
    notice.value = [];
  }, 6000);
}

function startAdd() {
  adding.value = true;
  form.id = null;
  form.name = '';
  form.description = '';
  form.body = '';
  form.files = {};
  formErrors.value = [];
}

function startEdit(s) {
  adding.value = false;
  editingId.value = s.id;
  form.id = s.id;
  form.name = s.name;
  form.description = s.description;
  form.body = s.body;
  form.files = { ...s.files };
  formErrors.value = [];
}

function cancelEdit() {
  adding.value = false;
  editingId.value = '';
}

function pickForm() {
  return {
    name: form.name,
    description: form.description,
    body: form.body,
    files: form.files,
  };
}

async function commitAdd() {
  const r = await saveSkills(configIO, [
    ...skills.value,
    { id: null, enabled: true, ...pickForm() },
  ]);

  if (!r.ok) {
    formErrors.value = r.errors;

    return;
  }

  adding.value = false;
  await refresh();
}

async function commitEdit() {
  const r = await saveSkills(
    configIO,
    skills.value.map((s) => (s.id === form.id ? { ...s, ...pickForm() } : s))
  );

  if (!r.ok) {
    formErrors.value = r.errors;

    return;
  }

  editingId.value = '';
  await refresh();
}

async function persist(list) {
  const r = await saveSkills(configIO, list);

  if (!r.ok) {
    toast.error(r.errors.join('；'));

    return false;
  }

  await refresh();

  return true;
}

async function toggleEnabled(s, value) {
  await persist(
    skills.value.map((x) => (x.id === s.id ? { ...x, enabled: value } : x))
  );
}

async function removeSkill(s) {
  await persist(skills.value.filter((x) => x.id !== s.id));

  if (editingId.value === s.id) editingId.value = '';
}

function download(bytes, filename) {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: 'application/zip' })
  );
  const a = document.createElement('a');

  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportOne(s) {
  download(await exportSkillZip(s), `${s.name}.zip`);
}

async function exportBackup() {
  const [currentSkills, commands, instructions] = await Promise.all([
    loadSkills(configIO),
    loadCommands(configIO),
    loadInstructions(configIO),
  ]);

  download(
    await exportBackupZip({ skills: currentSkills, commands, instructions }),
    'automa-agent-backup.zip'
  );
  showResult([t('settings.agent.skills.backupExported')]);
}

/** 通用：把一批新技能按名称合并进存储。返回计数，通知由调用方统一组装
 *  （导入结果要和拒收清单拼在同一条汇报里，这里抢着 setNotice 会被覆盖）。 */
async function mergeAndSave(incoming) {
  // mergeSkills 按名称合并：已存在的更新、新的追加
  const { merged, added, updated } = mergeSkills(skills.value, incoming);
  const r = await saveSkills(configIO, merged);

  if (!r.ok) {
    setNotice(r.errors, 'error');

    return null;
  }

  await refresh();

  return { added, updated };
}

async function onImportMd(e) {
  const file = e.target.files[0];
  e.target.value = '';

  if (!file) return;

  const text = await file.text();
  const skill = skillFromMarkdown(
    text,
    file.name.replace(/\.(md|markdown)$/i, '')
  );
  const counts = await mergeAndSave([skill]);

  if (counts) {
    showResult([
      t('settings.agent.skills.importMdDone', { name: file.name }),
      t('settings.agent.skills.importMerged', counts),
    ]);
  }
}

async function onImportZip(e) {
  const file = e.target.files[0];
  e.target.value = '';

  if (!file) return;

  try {
    const { skills: incoming, rejected } = await importSkillsZip(file);
    const counts = await mergeAndSave(incoming);

    if (counts) {
      const lines = [
        t('settings.agent.skills.importZipDone', { name: file.name }),
        t('settings.agent.skills.importMerged', counts),
        ...rejected.map((x) => `${x.path}: ${x.reason}`),
      ];

      setNotice(lines, rejected.length ? 'error' : 'info');
    }
  } catch (err) {
    setNotice([err && err.message ? err.message : String(err)], 'error');
  }
}

async function onImportBackup(e) {
  const file = e.target.files[0];
  e.target.value = '';

  if (!file) return;

  try {
    const {
      skills: incoming,
      commands,
      instructions,
      rejected,
    } = await importBackupZip(file);

    // 技能与模板同语义：按名称覆盖合并。mergeSkills 是形状无关的
    // 「按 name 合并记录」（模板字段是它的子集），复用不另写一份。
    const {
      merged: mergedSkills,
      added,
      updated,
    } = mergeSkills(skills.value, incoming);
    const { merged: mergedCommands } = mergeSkills(
      await loadCommands(configIO),
      commands
    );
    const lines = [t('settings.agent.skills.backupImported')];

    const r = await saveSkills(configIO, mergedSkills);
    if (!r.ok) {
      setNotice(r.errors, 'error');

      return;
    }

    const rc = await saveCommands(configIO, mergedCommands);
    if (!rc.ok) {
      setNotice(rc.errors, 'error');

      return;
    }

    // 指令只在当前为空时套用：备份恢复不该悄悄覆盖用户手写的一段话
    let instructionNote = null;
    const current = await loadInstructions(configIO);

    if (instructions && !current.text.trim()) {
      await saveInstructions(configIO, instructions);
      instructionNote = t('settings.agent.skills.instructionsImported');
    } else if (instructions) {
      instructionNote = t('settings.agent.skills.instructionsKept');
    }

    await refresh();

    lines.push(
      t('settings.agent.skills.importMerged', { added, updated }),
      t('settings.agent.skills.commandsMerged', { n: commands.length })
    );
    if (instructionNote) lines.push(instructionNote);
    if (rejected.length) {
      lines.push(...rejected.map((x) => `${x.path}: ${x.reason}`));
    }

    setNotice(lines, rejected.length ? 'error' : 'info');
  } catch (err) {
    setNotice([err && err.message ? err.message : String(err)], 'error');
  }
}
</script>
