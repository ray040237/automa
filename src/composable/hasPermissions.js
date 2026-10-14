import { onMounted, shallowReactive } from 'vue';
import browser from 'webextension-polyfill';
import i18n from '@/lib/vueI18n';

const isMV2 = browser.runtime.getManifest().manifest_version === 2;

export function useHasPermissions(permissions) {
  const hasPermissions = shallowReactive({});

  function handlePermission(name, status) {
    hasPermissions[name] = status;
  }
  function request(needReload = false) {
    const reqPermissions = permissions.filter(
      (permission) => !hasPermissions[permission]
    );

    browser.permissions
      .request({ permissions: reqPermissions })
      .then((status) => {
        if (!status) return;

        reqPermissions.forEach((permission) => {
          handlePermission(permission, true);
        });

        if (typeof needReload === 'boolean' && needReload) {
          alert(i18n.global.t('common.reloadRequired'));

          if (isMV2) {
            browser.runtime.getBackgroundPage().then((background) => {
              background.location.reload();
            });
          } else {
            browser.runtime.reload();
          }
        }
      })
      .catch((error) => {
        console.error(error);
      });
  }

  onMounted(() => {
    permissions.forEach((permission) => {
      browser.permissions
        .contains({ permissions: [permission] })
        .then((status) => {
          handlePermission(permission, status);
        });
    });
  });

  return {
    request,
    has: hasPermissions,
  };
}
