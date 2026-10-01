<template>
  <ui-card
    v-if="modalState.show"
    class="group fixed bottom-8 right-8 w-72 border-2 shadow-2xl"
  >
    <button
      class="absolute -right-2 -top-2 scale-0 rounded-full bg-white shadow-md transition group-hover:scale-100"
      @click="closeModal"
    >
      <v-remixicon class="text-gray-600" name="riCloseLine" />
    </button>
    <h2 class="text-lg font-semibold">
      {{ activeModal.title }}
    </h2>
    <p class="mt-1 text-gray-700 dark:text-gray-100">
      {{ activeModal.body }}
    </p>
    <div class="mt-4 space-y-2">
      <ui-button
        :href="activeModal.url"
        tag="a"
        target="_blank"
        rel="noopener"
        class="block w-full"
        variant="accent"
      >
        {{ activeModal.button }}
      </ui-button>
    </div>
  </ui-card>
</template>
<script setup>
import dayjs from '@/lib/dayjs';
import { computed, onMounted, shallowReactive } from 'vue';
import { useI18n } from 'vue-i18n';
import browser from 'webextension-polyfill';

const { t } = useI18n();

const modalTypes = {
  testimonial: {
    title: t('components.appSurvey.testimonial.title'),
    body: t('components.appSurvey.testimonial.body'),
    button: t('components.appSurvey.testimonial.button'),
    url: 'https://testimonial.to/automa',
  },
  survey: {
    title: t('components.appSurvey.survey.title'),
    body: t('components.appSurvey.survey.body'),
    button: t('components.appSurvey.survey.button'),
    url: 'https://extension.automa.site/survey',
  },
};

const modalState = shallowReactive({
  show: true,
  type: 'survey',
});

function closeModal() {
  let value = true;

  if (modalState.type === 'survey') {
    value = new Date().toString();
  }

  modalState.show = false;
  localStorage.setItem(`has-${modalState.type}`, value);
}
async function checkModal() {
  try {
    const { isFirstTime } = await browser.storage.local.get('isFirstTime');

    if (isFirstTime) {
      modalState.show = false;
      localStorage.setItem('has-testimonial', true);
      localStorage.setItem('has-survey', Date.now());
      return;
    }

    const survey = localStorage.getItem('has-survey');

    if (!survey) return;

    const daysDiff = dayjs().diff(survey, 'day');
    const showTestimonial =
      daysDiff >= 2 && !localStorage.getItem('has-testimonial');

    if (showTestimonial) {
      modalState.show = true;
      modalState.type = 'testimonial';
    } else {
      modalState.show = false;
    }
  } catch (error) {
    console.error(error);
  }
}

const activeModal = computed(() => modalTypes[modalState.type]);

onMounted(checkModal);
</script>
