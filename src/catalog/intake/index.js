'use strict';

const batch = require('./catalog-batch');
const resolution = require('./resolution');
const adapters = require('./catalog-adapters');
const identityVerification = require('./model-identity-verification');

module.exports = { ...batch, ...resolution, ...adapters, ...identityVerification };
