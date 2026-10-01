<template>
  <div v-if="!store.integrations.googleDrive">
    <p>
      {{ t('workflow.blocks.google-sheets-drive.notConnectedPrefix') }}
      <a
        href="https://docs.automa.site/integrations/google-drive.html"
        target="_blank"
        class="underline"
        >{{ t('workflow.blocks.google-sheets-drive.notConnectedLink') }}</a
      >{{ t('workflow.blocks.google-sheets-drive.notConnectedSuffix') }}
    </p>
  </div>
  <edit-google-sheets
    v-else
    google-drive
    :data="data"
    :additional-actions="['create', 'add-sheet']"
    @update:data="updateData"
  >
    <ui-tabs
      v-if="data.type !== 'create'"
      small
      :model-value="data.inputSpreadsheetId"
      fill
      class="w-full my-2"
      type="fill"
      @change="updateData({ inputSpreadsheetId: $event })"
    >
      <ui-tab value="connected">
        {{ t('workflow.blocks.google-sheets-drive.tabs.connected') }}
      </ui-tab>
      <ui-tab value="manually">
        {{ t('workflow.blocks.google-sheets-drive.tabs.manually') }}
      </ui-tab>
    </ui-tabs>
    <div
      v-if="data.type !== 'create' && data.inputSpreadsheetId === 'connected'"
      class="flex items-end"
    >
      <ui-select
        :model-value="data.spreadsheetId"
        :label="t('workflow.blocks.google-sheets-drive.connected')"
        :placeholder="t('workflow.blocks.google-sheets-drive.select')"
        class="w-full"
        @change="updateData({ spreadsheetId: $event })"
      >
        <option
          v-for="sheet in store.connectedSheets"
          :key="sheet.id"
          :value="sheet.id"
        >
          {{ sheet.name }}
        </option>
      </ui-select>
      <ui-button
        v-tooltip="t('workflow.blocks.google-sheets-drive.connect')"
        icon
        class="ml-2"
        @click="connectSheet"
      >
        <v-remixicon name="riLink" />
      </ui-button>
    </div>
    <ui-input
      v-if="['create', 'add-sheet'].includes(data.type)"
      :model-value="data.sheetName"
      :label="t('workflow.blocks.google-sheets-drive.sheetName')"
      :placeholder="
        t('workflow.blocks.google-sheets-drive.sheetNamePlaceholder')
      "
      class="w-full"
      @change="updateData({ sheetName: $event })"
    />
  </edit-google-sheets>
</template>
<script setup>
import { useStore } from '@/stores/main';
import { openGDrivePickerPopup } from '@/utils/openGDriveFilePicker';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import browser from 'webextension-polyfill';
import EditGoogleSheets from './EditGoogleSheets.vue';

const props = defineProps({
  data: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update:data']);

const { t } = useI18n();
const toast = useToast();
const store = useStore();
store.getConnectedSheets();

function updateData(value) {
  emit('update:data', { ...props.data, ...value });
}

async function connectSheet() {
  // 1. 获取当前 access_token
  const { sessionToken } = await browser.storage.local.get('sessionToken');
  if (!sessionToken?.access) {
    toast.error(t('workflow.blocks.google-sheets-drive.errors.noGoogleAuth'));
    return;
  }
  try {
    // 2. 弹出 Picker 让用户选择文件
    const file = await openGDrivePickerPopup(sessionToken.access);
    if (!file) return;
    if (file.mimeType !== 'application/vnd.google-apps.spreadsheet') {
      toast.error(
        t('workflow.blocks.google-sheets-drive.errors.notSpreadsheet')
      );
      return;
    }
    const sheetExists = store.connectedSheets.some(
      (sheet) => sheet.id === file.id
    );
    if (sheetExists) return;
    // 3. 加入已连接列表
    store.connectedSheets.push({ name: file.name, id: file.id });
  } catch (e) {
    toast.error(t('workflow.blocks.google-sheets-drive.errors.selectFailed'));
  }
}

// function connectSheet() {
//   openGDriveFilePicker().then((sheets) => {
//     if (!Array.isArray(sheets) || sheets.length === 0) {
//       toast.error('未获取到 Google Sheets 文件');
//       return;
//     }
//     // 弹窗/下拉选择，用户选择后加入 store.connectedSheets
//     // 这里用 window.prompt 简化，实际可用自定义弹窗组件
//     const options = sheets.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
//     const idx = window.prompt(`请选择要连接的 Google Sheet:\n${options}`);
//     const index = Number(idx) - 1;
//     if (Number.isNaN(index) || !sheets[index]) return;
//     const { name, id, mimeType } = sheets[index];
//     if (mimeType !== 'application/vnd.google-apps.spreadsheet') {
//       toast.error('File is not a google spreadsheet');
//       return;
//     }
//     const sheetExists = store.connectedSheets.some((sheet) => sheet.id === id);
//     if (sheetExists) return;
//     store.connectedSheets.push({ name, id });
//   });
// }
</script>
