'use strict';

const policy = require('./catalog-series-policy');
const migration = require('./catalog-series-migration');
const placement = require('./catalog-series-placement-ai');
const audit = require('./series-data-audit');
const bundleContract = require('./series-bundle-contract');
const bundlePlanner = require('./series-bundle-planner');

module.exports = { ...policy, ...migration, ...placement, ...audit, ...bundleContract, ...bundlePlanner };
