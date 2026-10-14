import { objectHasKey } from '@/utils/helper';

export async function sliceData({ id, data }) {
  let dataToSort = null;

  if (data.dataSource === 'table') {
    dataToSort = this.engine.referenceData.table;
  } else if (data.dataSource === 'variable') {
    const { variables } = this.engine.referenceData;

    if (!objectHasKey(variables, data.varSourceName)) {
      const error = new Error('variable-not-found');
      error.data = { variableName: data.varSourceName };

      throw error;
    }

    dataToSort = variables[data.varSourceName];
  }

  if (!Array.isArray(dataToSort)) {
    const dataType = dataToSort === null ? 'null' : typeof dataToSort;
    const error = new Error('invalid-sort-data-type');
    error.data = { dataType };

    throw error;
  }

  const getComparisonValue = ({ itemA, itemB, order = 'asc' }) => {
    let comparison = 0;

    if (itemA > itemB) {
      comparison = 1;
    } else if (itemA < itemB) {
      comparison = -1;
    }

    return order === 'desc' ? comparison * -1 : comparison;
  };
  const sortedArray = dataToSort.sort((a, b) => {
    let comparison = 0;

    if (data.sortByProperty) {
      data.itemProperties.forEach(({ name, order }) => {
        comparison = getComparisonValue({
          order,
          itemA: a[name] ?? a,
          itemB: b[name] ?? b,
        });
      });
    } else {
      comparison = getComparisonValue({
        itemA: a,
        itemB: b,
      });
    }

    return comparison;
  });

  if (data.assignVariable) {
    await this.setVariable(data.variableName, sortedArray);
  }
  if (data.saveData) {
    this.addDataToColumn(data.dataColumn, sortedArray);
  }

  return {
    data: sortedArray,
    nextBlockId: this.getBlockConnections(id),
  };
}

export default sliceData;
