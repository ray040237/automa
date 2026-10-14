import browser from 'webextension-polyfill';
import i18n from '@/lib/vueI18n';

const checkPermissions = (permissions) =>
  browser.permissions.contains({ permissions });
const isEmptyStr = (str) => !str.trim();
const isFirefox = BROWSER_TYPE === 'firefox';
const defaultOptions = {
  once: false,
};

const P = 'workflow.blockValidation';
const t = (key, params) => i18n.global.t(key, params);
const field = (name) => t(`${P}.fields.${name}`);
const emptyField = (name) => t(`${P}.emptyField`, { field: field(name) });
const permission = (name) => t(`${P}.permission.${name}`);

export async function validateTrigger(data) {
  const errors = [];
  const checkValue = (value, { name, location }) => {
    if (value && value.trim()) return;

    errors.push(
      t(`${P}.emptyIn`, {
        name: t(`${P}.fields.${name}`),
        location: t(`${P}.locations.${location}`),
      })
    );
  };
  const triggersValidation = {
    'cron-job': (triggerData) => {
      checkValue(triggerData.expression, {
        name: 'expression',
        location: 'cronJob',
      });
    },
    'context-menu': async (triggerData) => {
      const permission_ = isFirefox ? 'menus' : 'contextMenus';
      const hasPermission = await checkPermissions([permission_]);

      if (!hasPermission) {
        errors.push(permission('contextMenu'));
      } else {
        checkValue(triggerData.contextMenuName, {
          name: 'contextMenuName',
          location: 'contextMenu',
        });
      }
    },
    date: (triggerData) => {
      checkValue(triggerData.date, {
        name: 'date',
        location: 'date',
      });
    },
    'visit-web': (triggerData) => {
      checkValue(triggerData.url, {
        name: 'url',
        location: 'visitWeb',
      });
    },
    'keyboard-shortcut': (triggerData) => {
      checkValue(triggerData.shortcut, {
        name: 'shortcut',
        location: 'shortcut',
      });
    },
  };

  if (data.triggers) {
    for (const trigger of data.triggers) {
      const validate = triggersValidation[trigger.type];
      if (validate) await validate(trigger.data);
    }
  } else {
    const validate = triggersValidation[data.type];
    if (validate) await validate(data);
  }

  return errors;
}

export async function validateExecuteWorkflow(data) {
  if (isEmptyStr(data.workflowId)) return [t(`${P}.noWorkflow`)];

  return [];
}

export async function validateNewTab(data) {
  if (isEmptyStr(data.url)) return [emptyField('url')];

  return [];
}

export async function validateSwitchTab(data) {
  const errors = [];
  const validateItems = {
    'match-patterns': () => {
      if (isEmptyStr(data.matchPattern))
        errors.push(emptyField('matchPatterns'));
    },
    'tab-title': () => {
      if (isEmptyStr(data.tabTitle)) errors.push(emptyField('tabTitle'));
    },
  };

  if (validateItems[data.findTabBy]) validateItems[data.findTabBy]();

  return errors;
}

export async function validateProxy(data) {
  if (isEmptyStr(data.host)) return [emptyField('host')];

  return [];
}

export async function validateCloseTab(data) {
  if (data.closeType === 'tab' && !data.activeTab && isEmptyStr(data.url)) {
    return [emptyField('matchPatterns')];
  }

  return [];
}

export async function validateTakeScreenshot(data) {
  if (data.type === 'element' && isEmptyStr(data.selector)) {
    return [emptyField('cssSelector')];
  }

  return [];
}

export async function validateInteractionBasic(data) {
  if (isEmptyStr(data.selector)) return [emptyField('selector')];

  return [];
}

export async function validateExportData(data) {
  const errors = [];

  const hasPermission = await checkPermissions(['downloads']);
  if (!hasPermission) errors.push(permission('download'));

  if (data.dataToExport === 'variable' && isEmptyStr(data.variableName)) {
    errors.push(emptyField('variableName'));
  } else if (data.dataToExport === 'google-sheets' && isEmptyStr(data.refKey)) {
    errors.push(emptyField('referenceKey'));
  }

  return errors;
}

export async function validateAttributeValue(data) {
  const errors = [];

  if (isEmptyStr(data.selector)) errors.push(emptyField('selector'));
  if (isEmptyStr(data.attributeName)) errors.push(emptyField('attributeName'));

  return errors;
}

export async function validateGoogleSheets(data) {
  const errors = [];

  if (isEmptyStr(data.spreadsheetId)) errors.push(emptyField('spreadsheetId'));
  if (isEmptyStr(data.range)) errors.push(emptyField('range'));

  return errors;
}

export async function validateWebhook(data) {
  if (isEmptyStr(data.url)) return [emptyField('url')];

  return [];
}

export async function validateLoopData(data) {
  const errors = [];
  if (isEmptyStr(data.loopId)) errors.push(emptyField('loopId'));

  const loopThroughItems = {
    'google-sheets': () => {
      if (isEmptyStr(data.referenceKey))
        errors.push(emptyField('referenceKey'));
    },
    variable: () => {
      if (isEmptyStr(data.variableName))
        errors.push(emptyField('variableName'));
    },
  };
  const validateItem = loopThroughItems[data.loopThrough];
  if (validateItem) validateItem();

  return errors;
}

export async function validateLoopElements(data) {
  const errors = [];
  if (isEmptyStr(data.loopId)) errors.push(emptyField('loopId'));
  if (isEmptyStr(data.selector)) errors.push(emptyField('selector'));

  if (
    ['click-element', 'click-link'].includes(data.loadMoreAction) &&
    isEmptyStr(data.actionElSelector)
  ) {
    errors.push(emptyField('loadMoreSelector'));
  }

  return errors;
}

export async function validateClipboard() {
  const permissions = isFirefox
    ? ['clipboardRead', 'clipboardWrite']
    : ['clipboardRead'];
  const hasPermission = await checkPermissions(permissions);

  if (!hasPermission) return [permission('clipboard')];

  return [];
}

export async function validateSwitchTo(data) {
  if (data.windowType === 'iframe' && isEmptyStr(data.selector)) {
    return [emptyField('iframeSelector')];
  }

  return [];
}

export async function validateUploadFile(data) {
  const errors = [];

  if (isEmptyStr(data.selector)) errors.push(emptyField('selector'));

  const someInputsEmpty = data.filePaths.some((path) => isEmptyStr(path));
  if (someInputsEmpty) errors.push(t(`${P}.someFilePathsEmpty`));

  return errors;
}

export async function validateSaveAssets(data) {
  const errors = [];

  const hasPermission = await checkPermissions(['downloads']);
  if (!hasPermission) errors.push(permission('download'));
  else if (isEmptyStr(data.selector) && data.type === 'element')
    errors.push(emptyField('selector'));

  return errors;
}

export async function validatePressKey(data) {
  const errors = [];

  const isKeyEmpty =
    !data.action || (data.action === 'press-key' && isEmptyStr(data.keys));
  const isMultipleKeysEmpty =
    data.action === 'multiple-keys' && isEmptyStr(data.keysToPress);
  if (isKeyEmpty || isMultipleKeysEmpty) errors.push(emptyField('keysToPress'));

  return errors;
}

export async function validateNotification() {
  const hasPermission = await checkPermissions(['notifications']);
  if (!hasPermission) return [permission('notifications')];

  return [];
}

export async function validateCookie() {
  const hasPermission = await checkPermissions(['cookies']);
  if (!hasPermission) return [permission('cookies')];

  return [];
}

export default {
  trigger: {
    ...defaultOptions,
    func: validateTrigger,
  },
  'execute-workflow': {
    ...defaultOptions,
    func: validateExecuteWorkflow,
  },
  'new-tab': {
    ...defaultOptions,
    func: validateNewTab,
  },
  'switch-tab': {
    ...defaultOptions,
    func: validateSwitchTab,
  },
  proxy: {
    ...defaultOptions,
    func: validateProxy,
  },
  'close-tab': {
    ...defaultOptions,
    func: validateCloseTab,
  },
  'take-screenshot': {
    ...defaultOptions,
    func: validateTakeScreenshot,
  },
  'event-click': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'get-text': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'export-data': {
    ...defaultOptions,
    func: validateExportData,
  },
  'element-scroll': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  link: {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'attribute-value': {
    ...defaultOptions,
    func: validateAttributeValue,
  },
  forms: {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'trigger-event': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'google-sheets': {
    ...defaultOptions,
    func: validateGoogleSheets,
  },
  'element-exists': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  webhook: {
    ...defaultOptions,
    func: validateWebhook,
  },
  'loop-data': {
    ...defaultOptions,
    func: validateLoopData,
  },
  'loop-elements': {
    ...defaultOptions,
    func: validateLoopElements,
  },
  clipboard: {
    ...defaultOptions,
    once: true,
    func: validateClipboard,
  },
  'switch-to': {
    ...defaultOptions,
    func: validateSwitchTo,
  },
  'upload-file': {
    ...defaultOptions,
    func: validateUploadFile,
  },
  'hover-element': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'save-assets': {
    ...defaultOptions,
    func: validateSaveAssets,
  },
  'press-key': {
    ...defaultOptions,
    func: validatePressKey,
  },
  notification: {
    ...defaultOptions,
    func: validateNotification,
  },
  'create-element': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  cookie: {
    ...defaultOptions,
    func: validateCookie,
  },
};
