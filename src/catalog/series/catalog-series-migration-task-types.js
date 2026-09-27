'use strict';

const { taskTypesForMember } = require('./catalog-series-task-types');

function applyMemberTaskTypes(snapshot, memberIds, familyTaskTypes, registry, changes) {
  for (const id of memberIds) {
    const detailIndex = snapshot['tool-level3'].findIndex(item => item.id === id);
    const detail = snapshot['tool-level3'][detailIndex];
    if (!detail || detail.detail_kind !== 'api_model') continue;
    const taskTypes = taskTypesForMember(detail.title, familyTaskTypes, registry);
    if (!taskTypes.length || JSON.stringify(detail.task_types || []) === JSON.stringify(taskTypes)) continue;
    snapshot['tool-level3'][detailIndex] = { ...detail, task_types: taskTypes };
    changes.push({ area: 'tool-level3', id, operation: 'replace', note: '标准化模型任务类型' });
    for (let index = 0; index < snapshot['tool-card'].length; index += 1) {
      const card = snapshot['tool-card'][index];
      if (card.detail_ref?.id !== id || JSON.stringify(card.task_types || []) === JSON.stringify(taskTypes)) continue;
      snapshot['tool-card'][index] = { ...card, task_types: taskTypes };
      changes.push({ area: 'tool-card', id: card.id, operation: 'replace', note: '同步标准模型任务类型' });
    }
  }
}

module.exports = { applyMemberTaskTypes };
