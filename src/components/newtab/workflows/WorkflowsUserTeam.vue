<template>
  <p v-if="!userStore.user" class="my-4 text-center">
    <ui-spinner v-if="!userStore.retrieved" color="text-accent" />
    <template v-else>
      {{ t('workflows.loginRequired') }}
      <a
        href="https://extension.automa.site/auth"
        class="underline"
        target="_blank"
        >{{ t('workflows.login') }}</a
      >
      {{ t('workflows.loginRequiredSuffix') }}
    </template>
  </p>
  <div
    v-else-if="!isUnknownTeam && teamWorkflows.length === 0"
    class="text-center"
  >
    <img src="@/assets/svg/files-and-folder.svg" class="mx-auto w-96" />
    <p class="text-lg font-semibold">{{ t('workflows.emptyTitle') }}</p>
    <p class="text-gray-600 dark:text-gray-200">
      {{ t('workflows.emptyDescription') }}
    </p>
    <ui-button
      :href="`http://extension.automa.site/workflows?teamId=${teamId}&workflowsBy=team`"
      tag="a"
      target="_blank"
      variant="accent"
      class="mt-8 inline-block"
    >
      {{ t('workflow.browse') }}
    </ui-button>
  </div>
  <div v-else class="workflows-container">
    <shared-card
      v-for="workflow in workflows"
      :key="workflow.id"
      :data="workflow"
      :menu="workflowMenus"
      :disabled="isUnknownTeam"
      @click="openWorkflowPage"
      @menuSelected="onMenuSelected"
      @execute="RendererWorkflowService.executeWorkflow(workflow)"
    >
      <template #footer-content>
        <span
          :class="tagColors[workflow.tag]"
          class="rounded-md p-1 text-sm capitalize text-black"
        >
          {{ workflow.tag }}
        </span>
      </template>
    </shared-card>
  </div>
</template>
<script setup>
import SharedCard from '@/components/newtab/shared/SharedCard.vue';
import { useDialog } from '@/composable/dialog';
import RendererWorkflowService from '@/service/renderer/RendererWorkflowService';
import { useTeamWorkflowStore } from '@/stores/teamWorkflow';
import { useUserStore } from '@/stores/user';
import { fetchApi } from '@/utils/api';
import { arraySorter } from '@/utils/helper';
import { tagColors } from '@/utils/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';

const props = defineProps({
  active: Boolean,
  search: {
    type: String,
    default: '',
  },
  teamId: {
    type: [String, Number],
    default: '',
  },
  sort: {
    type: Object,
    default: () => ({
      by: '',
      order: '',
    }),
  },
});

const { t } = useI18n();

const menu = [
  {
    id: 'delete',
    name: t('common.delete'),
    hasAccess: true,
    icon: 'riDeleteBin7Line',
    attrs: {
      class: 'text-red-400 dark:text-red-500',
    },
  },
  {
    id: 'delete-team',
    name: t('workflows.deleteFromTeam'),
    icon: 'riDeleteBin7Line',
    permissions: ['owner', 'create'],
    attrs: {
      class: 'text-red-400 dark:text-red-500',
    },
  },
];

const toast = useToast();
const dialog = useDialog();
const router = useRouter();
const userStore = useUserStore();
const teamWorkflowStore = useTeamWorkflowStore();

const isUnknownTeam = computed(() => props.teamId === '(unknown)');
const workflowMenus = computed(() =>
  menu.filter((item) => {
    if (!item.permissions) return true;

    return userStore.validateTeamAccess(props.teamId, item.permissions);
  })
);
const teamWorkflows = computed(() => {
  if (isUnknownTeam.value) {
    return Object.keys(teamWorkflowStore.workflows).reduce((acc, teamId) => {
      const teamExist = userStore.user?.teams?.some(
        (team) => team.id === teamId || team.id === +teamId
      );
      if (!teamExist) {
        acc.push(...Object.values(teamWorkflowStore.workflows[teamId]));
      }

      return acc;
    }, []);
  }

  return teamWorkflowStore.getByTeam(props.teamId);
});
const workflows = computed(() => {
  if (!props.active) return [];

  const filtered = teamWorkflows.value.filter(({ name }) =>
    name.toLocaleLowerCase().includes(props.search.toLocaleLowerCase())
  );

  return arraySorter({
    data: filtered,
    key: props.sort.by,
    order: props.sort.order,
  });
});

function onMenuSelected({ id, data }) {
  if (id === 'delete') {
    dialog.confirm({
      title: t('workflow.delete'),
      okVariant: 'danger',
      body: t('message.delete', { name: data.name }),
      onConfirm: () => {
        teamWorkflowStore.delete(data.teamId, data.id);
      },
    });
  } else if (id === 'delete-team') {
    dialog.confirm({
      async: true,
      title: t('workflows.deleteFromTeamTitle'),
      okVariant: 'danger',
      body: t('workflows.deleteFromTeamConfirm', { name: data.name }),
      onConfirm: async () => {
        try {
          const response = await fetchApi(
            `/teams/${props.teamId}/workflows/${data.id}`,
            { method: 'DELETE', auth: true }
          );
          const result = await response.json();

          if (!response.ok && response.status !== 404)
            throw new Error(result.message);

          await teamWorkflowStore.delete(props.teamId, data.id);

          return true;
        } catch (error) {
          toast.error(t('message.somethingWrong'));
          console.error(error);
          return false;
        }
      },
    });
  }
}
function openWorkflowPage({ id }) {
  if (isUnknownTeam.value) return;

  router.push(`/teams/${props.teamId}/workflows/${id}`);
}
</script>
