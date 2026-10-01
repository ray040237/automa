<template>
  <p>{{ t('log.hello') }}</p>
</template>
<script setup>
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import emitter from '@/lib/mitt';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

onMounted(() => {
  emitter.emit('ui:logs', {
    show: true,
    logId: route.params.id,
  });

  router.replace('/');
});
</script>
