<template>
  <div class="max-w-lg">
    <div class="bg-box-transparent mb-2 inline-block rounded-full p-3">
      <img src="@/assets/svg/logo.svg" class="w-14" />
    </div>
    <p class="text-2xl font-semibold">Automa</p>
    <p class="mb-2 mt-1">
      {{ t('settings.about.version', { version: extensionVersion }) }}
      <span
        v-if="isOffline"
        class="ml-1 rounded-md bg-teal-200 px-2 py-0.5 text-sm font-medium text-teal-800 dark:bg-teal-700 dark:text-teal-100"
      >
        {{ t('settings.about.offlineBuild') }}
      </span>
    </p>
    <p class="text-gray-600 dark:text-gray-200">
      {{ t('settings.about.description') }}
    </p>
    <div class="mt-4 space-x-2">
      <a
        v-for="link in links"
        :key="link.name"
        v-tooltip.group="t(`settings.about.links.${link.name.toLowerCase()}`)"
        :href="link.url"
        target="_blank"
        class="hoverable inline-block rounded-lg p-2 transition"
      >
        <v-remixicon :name="link.icon" />
      </a>
    </div>
    <div class="my-8 border-b dark:border-gray-700"></div>
    <template v-if="!isOffline">
      <h2 class="text-xl font-semibold">
        {{ t('settings.about.contributors') }}
      </h2>
      <p class="mt-1 text-gray-600 dark:text-gray-200">
        {{ t('settings.about.contributorsDescription') }}
      </p>
      <div class="mt-4 mb-12 grid grid-cols-7 gap-2">
        <a
          v-for="contributor in store.contributors"
          :key="contributor.username"
          v-tooltip.group="contributor.username"
          :href="contributor.url"
          target="_blank"
          rel="noopener"
        >
          <img
            :src="contributor.avatar"
            :alt="
              t('settings.about.contributorAvatar', {
                name: contributor.username,
              })
            "
            class="w-16 rounded-lg"
          />
        </a>
      </div>
    </template>
  </div>
</template>
<script setup>
/* eslint-disable camelcase */
import { useGroupTooltip } from '@/composable/groupTooltip';
import { useStore } from '@/stores/main';
import { communities } from '@/utils/shared';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import browser from 'webextension-polyfill';

useGroupTooltip();
const { t } = useI18n();
const store = useStore();
const isOffline = IS_OFFLINE;

const extensionVersion = browser.runtime.getManifest().version;
const links = [
  ...communities,
  {
    name: 'Website',
    icon: 'riGlobalLine',
    url: 'https://extension.automa.site',
  },
  {
    name: 'Documentation',
    icon: 'riBook3Line',
    url: 'https://docs.extension.automa.site',
  },
  {
    name: 'Blog',
    icon: 'riArticleLine',
    url: 'https://blog.automa.site',
  },
];

onMounted(async () => {
  if (IS_OFFLINE || store.contributors) return;

  try {
    const response = await fetch(
      'https://api.github.com/repositories/412741449/contributors'
    );
    const contributors = (await response.json()).reduce(
      (acc, { type, avatar_url, login, html_url }) => {
        if (type !== 'Bot') {
          acc.push({
            username: login,
            url: html_url,
            avatar: avatar_url,
          });
        }

        return acc;
      },
      []
    );

    store.contributors = contributors;
  } catch (error) {
    console.error(error);
  }
});
</script>
