<template>
  <div class="input-ui inline-block w-full">
    <label
      v-if="label"
      class="ml-1 inline-flex items-center text-sm leading-none text-gray-600 dark:text-gray-200"
    >
      <span>{{ label }}</span>
      <v-remixicon
        v-tooltip="tooltipContent"
        name="riInformationLine"
        class="ml-1"
        size="16"
      />
    </label>
    <div class="mt-1 w-full">
      <input
        ref="fileInput"
        type="file"
        class="hidden"
        :accept="accept"
        @change="handleFileChange"
      />
      <ui-button
        :loading="uploading"
        :disabled="uploading"
        variant="default"
        class="w-full"
        @click="fileInput.click()"
      >
        <v-remixicon name="riUploadLine" class="mr-2 -ml-1" />
        {{ t('components.ui.fileInput.chooseFile') }}
      </ui-button>
      <p
        class="mt-1 text-sm text-center text-gray-500 dark:text-gray-400"
        :class="{ 'text-red-500': hasError }"
      >
        {{ statusText }}
      </p>
    </div>
  </div>
</template>
<script setup>
import {
  computed,
  defineEmits,
  defineProps,
  onMounted,
  ref,
  shallowRef,
} from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import UiButton from './UiButton.vue';

const props = defineProps({
  modelValue: {
    type: [String, Object],
    default: '',
  },
  label: {
    type: String,
    default: '',
  },
  accept: {
    type: String,
    default: '*',
  },
  maxSize: {
    type: Number,
    default: 30, // in MB
  },
  onUpload: {
    type: Function,
    default: null,
  },
});

const emit = defineEmits(['update:modelValue', 'change']);
const toast = useToast();
const { t } = useI18n();

const uploading = ref(false);
const fileInput = ref(null);
const fileName = shallowRef('');
const hasError = ref(false);

const tooltipContent = computed(() => ({
  allowHTML: true,
  content: t('components.ui.fileInput.maxSizeTooltip', {
    size: props.maxSize,
    types: props.accept.replace(/,/g, ', '),
  }),
  maxWidth: 250,
}));

const statusText = computed(() => {
  if (uploading.value) return t('components.ui.fileInput.uploading');
  if (hasError.value) return t('components.ui.fileInput.uploadFailed');
  return fileName.value || t('components.ui.fileInput.noFileSelected');
});

const isFileTypeValid = (file) => {
  if (props.accept === '*') return true;

  const acceptedTypes = props.accept.split(',').map((type) => type.trim());
  const { name: fName, type: fileType } = file;

  return acceptedTypes.some((acceptedType) => {
    if (acceptedType.startsWith('.')) {
      return fName.endsWith(acceptedType);
    }
    if (acceptedType.endsWith('/*')) {
      return fileType.startsWith(acceptedType.slice(0, -1));
    }
    return fileType === acceptedType;
  });
};

const resetState = () => {
  fileInput.value.value = '';
  fileName.value = '';
};

const handleError = (message) => {
  toast.error(message);
  hasError.value = true;
  resetState();
};

const handleFileChange = async (event) => {
  hasError.value = false;
  const file = event.target.files[0];

  if (!file) {
    resetState();
    return;
  }

  fileName.value = file.name;

  if (!isFileTypeValid(file)) {
    handleError(t('components.ui.fileInput.invalidFileType'));
    return;
  }

  if (file.size > props.maxSize * 1024 * 1024) {
    handleError(
      t('components.ui.fileInput.maxSizeExceeded', { size: props.maxSize })
    );
    return;
  }

  if (!props.onUpload) {
    handleError(t('components.ui.fileInput.onUploadNotProvided'));
    return;
  }

  uploading.value = true;

  try {
    const value = await props.onUpload(file);

    emit('update:modelValue', value);
    emit('change', value);
    fileName.value = file.name; // Keep filename on success
  } catch (error) {
    console.error('Upload error:', error);
    toast.error(error.message || t('components.ui.fileInput.uploadError'));
    handleError(error.message || t('components.ui.fileInput.uploadError'));
  } finally {
    uploading.value = false;
  }
};

onMounted(() => {
  if (typeof props.modelValue === 'object' && props.modelValue?.filename) {
    fileName.value = props.modelValue.filename;
  }
});
</script>
