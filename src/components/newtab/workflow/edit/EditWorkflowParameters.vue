<template>
  <div
    class="scroll overflow-auto"
    style="max-height: calc(100vh - 15rem); min-height: 200px"
  >
    <p
      v-if="state.parameters.length === 0"
      class="my-4 text-center text-gray-600 dark:text-gray-200"
    >
      {{ t('workflow.blocks.workflow-parameters.noParameters') }}
    </p>
    <section v-else class="w-full">
      <div class="grid grid-cols-12 space-x-2 text-sm">
        <div class="col-span-3" style="padding-left: 28px">
          {{ t('workflow.blocks.workflow-parameters.headers.name') }}
        </div>
        <div class="col-span-2">
          {{ t('workflow.blocks.workflow-parameters.headers.type') }}
        </div>
        <div class="col-span-3">
          {{ t('workflow.blocks.workflow-parameters.headers.placeholder') }}
        </div>
        <div class="col-span-4">
          {{ t('workflow.blocks.workflow-parameters.headers.defaultValue') }}
        </div>
      </div>
      <draggable
        v-model="state.parameters"
        tag="div"
        item-key="id"
        handle=".handle"
      >
        <template #item="{ element: param, index }">
          <div class="mb-4">
            <div class="grid grid-cols-12 space-x-2">
              <div class="col-span-3 flex">
                <v-remixicon name="mdiDrag" class="handle mr-2 cursor-move" />
                <ui-input
                  :model-value="param.name"
                  :placeholder="
                    t('workflow.blocks.workflow-parameters.namePlaceholder')
                  "
                  @change="updateParam(index, $event)"
                />
              </div>
              <div class="col-span-2">
                <ui-select
                  :model-value="param.type"
                  @change="updateParamType(index, $event)"
                >
                  <option
                    v-for="type in paramTypesArr"
                    :key="type.id"
                    :value="type.id"
                  >
                    {{ type.name }}
                  </option>
                </ui-select>
              </div>
              <div class="col-span-3">
                <ui-input
                  v-model="param.placeholder"
                  :placeholder="
                    t('workflow.blocks.workflow-parameters.paramPlaceholder')
                  "
                />
              </div>
              <div class="col-span-4 flex items-center">
                <component
                  :is="paramTypes[param.type]?.valueComp"
                  v-if="paramTypes[param.type]?.valueComp"
                  v-model="param.defaultValue"
                  :param-data="param"
                  :editor="true"
                  class="flex-1"
                  style="max-width: 232px"
                />
                <ui-input
                  v-else
                  v-model="param.defaultValue"
                  :type="param.type === 'number' ? 'number' : 'text'"
                  :placeholder="
                    t(
                      'workflow.blocks.workflow-parameters.defaultValuePlaceholder'
                    )
                  "
                />
                <ui-button
                  icon
                  class="ml-2"
                  @click="state.parameters.splice(index, 1)"
                >
                  <v-remixicon name="riDeleteBin7Line" />
                </ui-button>
              </div>
            </div>
            <div class="w-full">
              <ui-expand
                hide-header-icon
                header-class="flex items-center focus:ring-0 w-full"
              >
                <template #header="{ show }">
                  <v-remixicon
                    :rotate="show ? 270 : 180"
                    name="riArrowLeftSLine"
                    class="mr-2 -ml-1 transition-transform"
                  />
                  <span>{{ t('common.options') }}</span>
                </template>
                <div class="mt-2 mb-4 pl-[28px]">
                  <div class="mb-2 flex items-start">
                    <ui-textarea
                      v-model="param.description"
                      :placeholder="t('common.description')"
                      :title="t('common.description')"
                      style="max-width: 400px"
                    />
                    <ui-checkbox
                      v-if="['string', 'number'].includes(param.type)"
                      :model-value="param.data?.required"
                      class="ml-6"
                      @change="param.data.required = $event"
                    >
                      {{ t('workflow.blocks.workflow-parameters.required') }}
                    </ui-checkbox>
                  </div>
                  <component
                    :is="paramTypes[param.type].options"
                    v-if="paramTypes[param.type].options"
                    v-model="param.data"
                    :default-value="paramTypes[param.type].data"
                  />
                </div>
              </ui-expand>
            </div>
          </div>
        </template>
      </draggable>
    </section>
  </div>
  <div class="mt-4 flex items-center">
    <ui-button variant="accent" @click="addParameter">
      {{ $t('workflow.parameters.add') }}
    </ui-button>
    <div class="grow" />
    <ui-checkbox
      v-if="!hidePreferTab"
      :model-value="preferTab"
      @change="$emit('update:preferTab', $event)"
    >
      {{ $t('workflow.parameters.preferInTab') }}
    </ui-checkbox>
  </div>
</template>
<script setup>
import workflowParameters from '@business/parameters';
import cloneDeep from 'lodash.clonedeep';
import { nanoid } from 'nanoid/non-secure';
import { reactive, watch } from 'vue';
import Draggable from 'vuedraggable';
import ParameterCheckboxValue from './Parameter/ParameterCheckboxValue.vue';
import ParameterInputOptions from './Parameter/ParameterInputOptions.vue';
import ParameterInputValue from './Parameter/ParameterInputValue.vue';
import ParameterJsonValue from './Parameter/ParameterJsonValue.vue';

const props = defineProps({
  data: {
    type: Array,
    default: () => [],
  },
  preferTab: Boolean,
  hidePreferTab: Boolean,
});
const emit = defineEmits(['update', 'update:preferTab']);

const customParameters = workflowParameters();

const paramTypes = {
  string: {
    id: 'string',
    name: 'Input (string)',
    options: ParameterInputOptions,
    valueComp: ParameterInputValue,
    data: {
      masks: [],
      required: false,
      useMask: false,
      unmaskValue: false,
    },
  },
  number: {
    id: 'number',
    name: 'Input (number)',
    data: {
      required: false,
    },
  },
  json: {
    id: 'json',
    name: 'Input (JSON)',
    valueComp: ParameterJsonValue,
    data: {
      required: false,
    },
  },
  checkbox: {
    id: 'checkbox',
    name: 'Checkbox',
    valueComp: ParameterCheckboxValue,
    data: {
      required: false,
    },
  },
  ...customParameters,
};
const paramTypesArr = Object.values(paramTypes)
  .filter((item) => item.id)
  .sort((a, b) => (a.name > b.name ? 1 : -1));

const state = reactive({
  parameters: cloneDeep(props.data || []).map((item) => {
    item.id = nanoid(4);

    return item;
  }),
});

function addParameter() {
  state.parameters.push({
    name: 'param',
    type: 'string',
    description: '',
    defaultValue: '',
    placeholder: 'Text',
    data: paramTypes.string.data,
  });
}
function updateParam(index, value) {
  state.parameters[index].name = value.replace(/\s/g, '_');
}
function updateParamType(index, type) {
  const param = state.parameters[index];

  param.type = type;
  param.data = paramTypes[type].data || {};
}

watch(
  () => state.parameters,
  (parameters) => {
    emit('update', parameters);
  },
  { deep: true }
);
</script>
<style scoped>
table th,
table td {
  @apply p-1 font-normal;
}
</style>
