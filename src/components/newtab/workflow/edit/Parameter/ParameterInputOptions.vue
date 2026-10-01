<template>
  <div class="flex items-center">
    <label class="flex items-center">
      <ui-switch v-model="options.useMask" />
      <span class="ml-2">
        {{ t('workflow.blocks.workflow-parameters.mask.useInputMasking') }}
      </span>
    </label>
    <v-remixicon
      v-tooltip="{ content: maskInfo, allowHTML: true }"
      name="riInformationLine"
      class="ml-1 text-gray-600 dark:text-gray-200"
      size="20"
    />
    <label v-if="false" class="ml-4 flex items-center">
      <ui-switch v-model="options.unmaskValue" />
      <span class="ml-2">
        {{ t('workflow.blocks.workflow-parameters.mask.returnUnmaskValue') }}
      </span>
    </label>
  </div>
  <div v-if="options.useMask" class="mt-2">
    <p>{{ t('workflow.blocks.workflow-parameters.mask.masks') }}</p>
    <div class="space-y-2">
      <div
        v-for="(mask, index) in options.masks"
        :key="index"
        class="flex items-center"
      >
        <ui-input
          v-model="options.masks[index].mask"
          placeholder="aaa-aaa-aaa"
        />
        <ui-checkbox v-model="mask.isRegex" class="ml-4">
          {{ t('workflow.blocks.workflow-parameters.mask.isRegex') }}
        </ui-checkbox>
        <div class="grow" />
        <v-remixicon
          name="riDeleteBin7Line"
          class="ml-1 shrink-0 cursor-pointer"
          @click="options.masks.splice(index, 1)"
        />
      </div>
    </div>
    <template v-if="false">
      <p>
        {{ t('workflow.blocks.workflow-parameters.mask.customTokens') }}
      </p>
      <div class="grid grid-cols-2 gap-4">
        <div
          v-for="(token, index) in options.customTokens"
          :key="index"
          class="flex items-center"
        >
          <ui-input
            v-model="token.symbol"
            :placeholder="
              t('workflow.blocks.workflow-parameters.mask.symbolPlaceholder')
            "
            style="width: 120px"
          />
          <ui-input
            v-model="token.regex"
            :placeholder="
              t('workflow.blocks.workflow-parameters.mask.regexPlaceholder')
            "
            class="ml-2 flex-1"
          />
          <v-remixicon
            name="riDeleteBin7Line"
            class="ml-1 shrink-0 cursor-pointer"
            @click="options.customTokens.splice(index, 1)"
          />
        </div>
      </div>
      <ui-button class="mt-4" @click="addToken">
        {{ t('workflow.blocks.workflow-parameters.mask.addToken') }}
      </ui-button>
    </template>
  </div>
</template>
<script setup>
import { reactive, watch, onMounted } from 'vue';
import cloneDeep from 'lodash.clonedeep';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  modelValue: {
    type: [Object, String],
    default: () => ({}),
  },
  defaultValue: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();

const maskInfo = `
${t('workflow.blocks.workflow-parameters.mask.maskInfo.addMask')}
<p class="mt-2">${t(
  'workflow.blocks.workflow-parameters.mask.maskInfo.supportedPatterns'
)}</p>
<table class="tokens">
	<tbody>
		<tr>
			<td>0</td>
			<td>${t('workflow.blocks.workflow-parameters.mask.maskInfo.anyDigit')}</td>
		</tr>
		<tr>
			<td>a</td>
			<td>${t('workflow.blocks.workflow-parameters.mask.maskInfo.anyLetter')}</td>
		</tr>
		<tr>
			<td>*</td>
			<td>${t('workflow.blocks.workflow-parameters.mask.maskInfo.anyChar')}</td>
		</tr>
		<tr>
			<td>[]</td>
			<td>${t('workflow.blocks.workflow-parameters.mask.maskInfo.optionalInput')}</td>
		</tr>
		<tr>
			<td>{}</td>
			<td>${t('workflow.blocks.workflow-parameters.mask.maskInfo.fixedPart')}</td>
		</tr>
		<tr>
			<td>\`</td>
			<td>${t('workflow.blocks.workflow-parameters.mask.maskInfo.preventShift')}</td>
		</tr>
    <tr>
      <td>!</td>
      <td>${t(
        'workflow.blocks.workflow-parameters.mask.maskInfo.escapeChar'
      )}</td>
    </tr>
	<tbody>
</table>
`;

const cloneData = cloneDeep(props.modelValue || {});
const options = reactive({
  ...(props.defaultValue || {}),
  ...cloneData,
});

function addMask() {
  options.masks.push({
    isRegex: false,
    mask: '',
    lazy: false,
  });
}
function addToken() {
  options.customTokens.push({
    symbol: '',
    regex: '',
  });
}

watch(
  options,
  () => {
    emit('update:modelValue', options);
  },
  { deep: true }
);

onMounted(() => {
  if (options.masks.length === 0) {
    addMask();
  }
});
</script>
