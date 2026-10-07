import { postRunAPWorkflow } from '@/utils/getAIPoweredInfo';
import renderString from '../templating/renderString';

async function aiWorkflow(block, { refData }) {
  const {
    flowUuid,
    inputs,
    assignVariable,
    variableName,
    saveData,
    dataColumn,
  } = block.data;

  if (IS_OFFLINE) {
    throw new Error('AI Workflow block is not available in offline mode');
  }

  const replacedValueList = {};
  const aipowerToken = this.engine.workflow.settings?.aipowerToken;

  if (!aipowerToken) {
    throw new Error('AI Power token is not set');
  }

  const inputForAPI = {};
  for (const item of inputs) {
    if (typeof item.value === 'object' && item.value !== null) {
      // For file objects, we don't render them as strings.
      // We assume they contain the necessary structure like { filename, url }.
      inputForAPI[item.name] = item.value;
    } else {
      // For strings, we render them using the templating engine.
      const renderedValue = await renderString(
        item.value,
        refData,
        this.engine.isPopup
      );
      inputForAPI[item.name] = renderedValue.value;
      Object.assign(replacedValueList, renderedValue.list);
    }
  }

  try {
    const runResponse = await postRunAPWorkflow(
      { flowUuid, input: inputForAPI },
      aipowerToken
    );
    const { success, msg } = runResponse;

    if (!success) {
      throw new Error(msg || 'AI workflow execution failed');
    }

    if (assignVariable) {
      // T-03：必须 await。setVariable 是 async（$$ 全局变量还要落 IndexedDB），
      // 不等它就返回，后面的块会读到旧值；它自己 reject 时更糟 —— 那是一条
      // unhandled rejection，本块照样报成功。
      await this.setVariable(variableName, runResponse.data.result);
    }

    if (saveData) {
      this.addDataToColumn(dataColumn, runResponse.data.result);
    }

    const nextBlockId = this.getBlockConnections(block.id);

    return {
      data: runResponse.data.result,
      nextBlockId,
      replacedValue: replacedValueList,
    };
  } catch (error) {
    console.error('AI workflow execution failed:', error);
    // T-03：原字段必须留着。WorkflowWorker 的错误日志
    // （`...(error.data || {})`、`...(error.ctxData || {})`）正是靠它们拼上下文，
    // `new Error(error.message)` 只搬了 message，日志里就只剩一句干巴巴的话。
    // 全仓确实有人在 error 上挂 ctxData（handlerWebhook.js:51）。
    // 非 Error 的抛出物（字符串、对象）仍然包一层，message 才读得出来。
    if (error instanceof Error) throw error;

    throw Object.assign(new Error(String(error)), error);
  }
}

export default aiWorkflow;
