'use strict';

const batch = require('./catalog-batch');
const resolution = require('./resolution');
const adapters = require('./catalog-adapters');
const identityVerification = require('./model-identity-verification');
const catalogModelCompletion = require('./catalog-model-completion');
const officialSourceFetch = require('./official-source-fetch');
const identityReceipts = require('./identity-receipts');

module.exports = { ...batch, ...resolution, ...adapters, ...identityVerification, ...catalogModelCompletion, ...officialSourceFetch, ...identityReceipts };
