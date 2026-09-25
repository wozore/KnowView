/**
 * delivery/index.js —— news/delivery 统一门面
 */

'use strict';

const {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  validateDataPrFiles,
  findOpenDataPr,
  syncDataPrBaseline,
  assertCandidateRetention,
  verifyHeadNotDrifted,
  deliverNewsDataPr,
} = require('./news-data-pr-delivery');

module.exports = {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  validateDataPrFiles,
  findOpenDataPr,
  syncDataPrBaseline,
  assertCandidateRetention,
  verifyHeadNotDrifted,
  deliverNewsDataPr,
};
