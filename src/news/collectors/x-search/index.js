/**
 * index.js —— X Advanced Search 纯逻辑子域统一门面（Facade）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §2.1 与 §13.2 契约：
 * 门面汇聚导出纯领域时间窗、查询契约、分页状态机、预算账本、Transport 与执行器。
 */

'use strict';

const {
  resolveXCollectionWindow,
  inWindow,
  resolveTailRecheckWindow,
  checkDelayed,
} = require('./window');

const {
  buildAccountGroupQuery,
  buildDiscoveryQuery,
  generateQueryHash,
} = require('./query-contract');

const {
  createPaginationState,
  advancePagination,
} = require('./pagination');

const {
  createBudgetLedger,
} = require('./budget');

const {
  createAdvancedSearchClient,
} = require('./advanced-search-client');

const {
  executeAccountGroups,
  executeTailRecheck,
} = require('./account-executor');

const {
  executeDiscoveryQueries,
} = require('./discovery-executor');

const {
  checkpointKeyOf,
  buildCheckpointRecord,
  pruneTailRecheckObservations,
  computeTailRecheckMetrics,
} = require('./checkpoint-contract');

const {
  readXCheckpointStore,
  writeXCheckpointStore,
  applyCheckpointPatches,
  createDefaultCheckpointStore,
} = require('./x-checkpoint-store');

module.exports = {
  resolveXCollectionWindow,
  inWindow,
  resolveTailRecheckWindow,
  checkDelayed,
  queryContract: {
    buildAccountGroupQuery,
    buildDiscoveryQuery,
    generateQueryHash,
  },
  createPaginationState,
  advancePagination,
  createBudgetLedger,
  createAdvancedSearchClient,
  executeAccountGroups,
  executeTailRecheck,
  executeDiscoveryQueries,
  checkpointStore: {
    readXCheckpointStore,
    writeXCheckpointStore,
    applyCheckpointPatches,
    createDefaultCheckpointStore,
  },
  checkpointContract: {
    checkpointKeyOf,
    buildCheckpointRecord,
    pruneTailRecheckObservations,
    computeTailRecheckMetrics,
  },
};
