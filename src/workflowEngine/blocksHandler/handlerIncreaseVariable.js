import objectPath from 'object-path';

export async function increaseVariable({ id, data }) {
  const refVariables = this.engine.referenceData.variables;
  const variableExist = objectPath.has(refVariables, data.variableName);

  if (!variableExist) {
    const error = new Error('variable-not-found');
    error.data = { variableName: data.variableName };

    throw error;
  }

  const currentVar = +objectPath.get(refVariables, data.variableName);
  if (Number.isNaN(currentVar)) {
    const error = new Error('invalid-variable-number');
    error.data = { variableName: data.variableName };

    throw error;
  }

  objectPath.set(
    this.engine.referenceData.variables,
    data.variableName,
    currentVar + data.increaseBy
  );

  return {
    data: refVariables[data.variableName],
    nextBlockId: this.getBlockConnections(id),
  };
}

export default increaseVariable;
