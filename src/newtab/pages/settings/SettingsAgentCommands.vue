<template>
  <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
    <div class="mb-2 flex items-center gap-2">
      <p class="flex-1 font-semibold">
        {{ t('settings.agent.commands.title') }}
      </p>
      <ui-button @click="startAdd">
        <v-remixicon name="riAddLine" class="mr-1 -ml-1" size="18" />
        {{ t('settings.agent.commands.add') }}
      </ui-button>
    </div>

    <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
      {{ t('settings.agent.commands.hint') }}
    </p>

    <ul v-if="commands.length" class="flex flex-col gap-2">
      <li
        v-for="c in commands"
        :key="c.id"
        class="rounded-lg bg-box-transparent p-2"
      >
        <!-- 摘要行；编辑时换成表单 -->
        <div v-if="editingId !== c.id" class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-mono text-sm">
            /{{ c.name }}
          </span>
          <span
            v-if="c.description"
            class="hidden min-w-0 flex-1 truncate text-xs opacity-60 sm:block"
          >
            {{ c.description }}
          </span>
          <ui-switch
            :model-value="c.enabled"
            @update:model-value="toggleEnabled(c, $event)"
          />
          <button
            type="button"
            class="shrink-0 text-xs text-gray-500 underline"
            @click="startEdit(c)"
          >
            {{ t('settings.agent.commands.edit') }}
          </button>
          <v-remixicon
            name="riDeleteBin7Line"
            class="shrink-0 cursor-pointer text-gray-600 hover:text-red-500 dark:text-gray-200"
            @click="removeCommand(c)"
          />
        </div>

        <!-- 编辑表单 -->
        <div v-else class="flex flex-col gap-2">
          <div class="flex flex-wrap gap-2">
            <ui-input
              v-model="form.name"
              class="w-48"
              :label="t('settings.agent.commands.name')"
              placeholder="review"
              autocomplete="off"
            />
            <ui-input
              v-model="form.description"
              class="min-w-64 flex-1"
              :label="t('settings.agent.commands.description')"
              autocomplete="off"
            />
          </div>
          <ui-textarea
            v-model="form.body"
            rows="5"
            :label="t('settings.agent.commands.body')"
          />
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
      v-if="!commands.length && !adding"
      class="text-sm text-gray-600 dark:text-gray-200"
    >
      {{ t('settings.agent.commands.empty') }}
    </p>

    <!-- 新增表单在列表外：新记录还没有 id，塞进 v-for 里等于永远渲染不出来 -->
    <div v-if="adding" class="mt-2 rounded-lg bg-box-transparent p-2">
      <div class="flex flex-wrap gap-2">
        <ui-input
          v-model="form.name"
          class="w-48"
          :label="t('settings.agent.commands.name')"
          placeholder="review"
          autocomplete="off"
        />
        <ui-input
          v-model="form.description"
          class="min-w-64 flex-1"
          :label="t('settings.agent.commands.description')"
          autocomplete="off"
        />
      </div>
      <ui-textarea
        v-model="form.body"
        rows="5"
        class="mt-2"
        :label="t('settings.agent.commands.body')"
      />
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
 * `/` 模板管理（T-81a）：用户在面板输入框以 `/` 触发的消息片段。
 *
 * 每个动作（增/改/删/启停）**立即落盘**，没有整页的保存按钮 —— 模板是
 * 一组小记录，攒一批再存只会让「编辑到一半关掉页面」变成丢数据。
 * 校验失败（重名、缺正文）显示在表单行内，存储不会被写入。
 */
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import { configIO } from '@/agent';
import {
  loadCommands,
  newCommandId,
  saveCommands,
} from '@/agent/customizations';

const { t } = useI18n();
const toast = useToast();

const commands = ref([]);
const editingId = ref('');
const adding = ref(false);
const formErrors = ref([]);
const form = reactive({ id: '', name: '', description: '', body: '' });

async function refresh() {
  commands.value = await loadCommands(configIO);
}

onMounted(refresh);

function pickForm() {
  return {
    name: form.name,
    description: form.description,
    body: form.body,
  };
}

function startAdd() {
  adding.value = true;
  form.id = newCommandId();
  form.name = '';
  form.description = '';
  form.body = '';
  formErrors.value = [];
}

function startEdit(c) {
  adding.value = false;
  editingId.value = c.id;
  form.id = c.id;
  form.name = c.name;
  form.description = c.description;
  form.body = c.body;
  formErrors.value = [];
}

function cancelEdit() {
  adding.value = false;
  editingId.value = '';
}

/**
 * 把表单内容并进列表并落盘。校验失败时 saveCommands 不写盘并带回错误，
 * 这里展示后停住 —— 用户改完再点保存，中间不会出现「存了一半」的状态。
 */
async function commitAdd() {
  const r = await saveCommands(configIO, [
    ...commands.value,
    { id: form.id, enabled: true, ...pickForm() },
  ]);

  if (!r.ok) {
    formErrors.value = r.errors;

    return;
  }

  adding.value = false;
  await refresh();
}

async function commitEdit() {
  const r = await saveCommands(
    configIO,
    commands.value.map((c) => (c.id === form.id ? { ...c, ...pickForm() } : c))
  );

  if (!r.ok) {
    formErrors.value = r.errors;

    return;
  }

  editingId.value = '';
  await refresh();
}

async function toggleEnabled(c, value) {
  const r = await saveCommands(
    configIO,
    commands.value.map((x) => (x.id === c.id ? { ...x, enabled: value } : x))
  );

  if (!r.ok) {
    toast.error(r.errors.join('；'));

    return;
  }

  await refresh();
}

async function removeCommand(c) {
  const r = await saveCommands(
    configIO,
    commands.value.filter((x) => x.id !== c.id)
  );

  if (!r.ok) {
    toast.error(r.errors.join('；'));

    return;
  }

  if (editingId.value === c.id) editingId.value = '';
  await refresh();
}
</script>
