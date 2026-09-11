/**
 * budget.js —— 四桶独立预算账本与预占/结算控制（T2 纯领域模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §7 与 §13.2 契约：
 * 1. 四桶结构：account, discovery, article_retry, tail_recheck
 * 2. hot 总额 7500 = account 5500 + discovery 800 + article_retry 750 + tail_recheck 450
 * 3. cold 总额 2500 = account 1300 + discovery 300 + article_retry 300 + tail_recheck 600
 * 4. 严禁桶间越权借用
 * 5. 请求前预占（Tweet 默认 300，Article 100），成功按返回量结算（最低 15），超 20 记 overage
 * 6. 网络异常/超时进入 unknown_reserved，不释放
 */

'use strict';

const DEFAULT_BUDGET_CAPS = Object.freeze({
  hot: Object.freeze({
    account: 5500,
    discovery: 800,
    article_retry: 750,
    tail_recheck: 450,
  }),
  cold: Object.freeze({
    account: 1300,
    discovery: 300,
    article_retry: 300,
    tail_recheck: 600,
  }),
});

const VALID_BUCKETS = new Set(['account', 'discovery', 'article_retry', 'tail_recheck']);

class BudgetLedger {
  /**
   * @param {'hot'|'cold'} slot
   * @param {object} [capsOverride]
   */
  constructor(slot = 'hot', capsOverride = {}) {
    const baseCaps = DEFAULT_BUDGET_CAPS[slot] || DEFAULT_BUDGET_CAPS.hot;
    this.slot = slot;
    this.buckets = {};
    this._seq = 0;
    this.totalTweets = 0;
    this.totalArticles = 0;
    this.totalRetries = 0;
    this.tweetRequests = 0;
    this.articleRequests = 0;

    for (const key of VALID_BUCKETS) {
      const cap = Number.isFinite(Number(capsOverride[key]))
        ? Math.max(0, Math.trunc(Number(capsOverride[key])))
        : (baseCaps[key] ?? 0);

      this.buckets[key] = {
        cap,
        reserved: 0,
        settled: 0,
        unknown_reserved: 0,
        requests: 0,
        pages: 0,
        retries: 0,
        articles: 0,
        overage: 0,
      };
    }
  }

  /**
   * 检查指定桶当前可用余额是否满足预占要求。
   * @param {'account'|'discovery'|'article_retry'|'tail_recheck'} bucketKey
   * @param {number} [amount=300]
   * @returns {boolean}
   */
  canReserve(bucketKey, amount = 300) {
    const bucket = this.buckets[bucketKey];
    if (!bucket) return false;
    const used = bucket.settled + bucket.reserved + bucket.unknown_reserved;
    const remaining = bucket.cap - used;
    return remaining >= amount;
  }

  /**
   * 预占指定桶额度。额度不足时抛错。
   * @param {'account'|'discovery'|'article_retry'|'tail_recheck'} bucketKey
   * @param {number} [amount=300]
   * @param {object} [options]
   * @param {boolean} [options.isRetry=false]
   * @param {boolean} [options.isArticle=false]
   * @returns {object} reservation
   */
  reserve(bucketKey, amount = 300, { isRetry = false, isArticle = false } = {}) {
    if (!VALID_BUCKETS.has(bucketKey)) {
      throw new Error(`Invalid bucket key: "${bucketKey}"`);
    }
    if (!this.canReserve(bucketKey, amount)) {
      const b = this.buckets[bucketKey];
      const used = b.settled + b.reserved + b.unknown_reserved;
      throw new Error(`BUDGET_EXHAUSTED: bucket "${bucketKey}" cap=${b.cap}, used=${used}, requested=${amount}`);
    }

    const bucket = this.buckets[bucketKey];
    bucket.reserved += amount;
    bucket.requests += 1;
    if (isRetry) {
      bucket.retries += 1;
      this.totalRetries += 1;
    }
    if (isArticle) {
      bucket.articles += 1;
      this.articleRequests += 1;
    } else {
      bucket.pages += 1;
      this.tweetRequests += 1;
    }

    this._seq += 1;
    return {
      id: `res_${bucketKey}_${this._seq}`,
      bucketKey,
      amount,
      isRetry,
      isArticle,
      settled: false,
      unknown: false,
    };
  }

  /**
   * 成功响应结算：释放预占，按实际返回条数结算（最低 15 credits）。
   * 若实际返回条数 > 20，累加 overage。
   * @param {object} reservation
   * @param {number} actualReturnedCount
   * @param {number} [unitCost=15]
   * @returns {{actualCost: number, overage: number}}
   */
  settle(reservation, actualReturnedCount, unitCost = 15, countAsArticle = true) {
    if (!reservation || typeof reservation !== 'object') {
      throw new Error('Invalid reservation for settlement');
    }
    if (reservation.settled) {
      throw new Error(`Reservation "${reservation.id}" already settled`);
    }
    if (reservation.unknown) {
      throw new Error(`Reservation "${reservation.id}" already retained as unknown`);
    }

    const bucket = this.buckets[reservation.bucketKey];
    if (!bucket) {
      throw new Error(`Bucket "${reservation.bucketKey}" not found`);
    }

    bucket.reserved -= reservation.amount;

    const count = Math.max(0, Number(actualReturnedCount) || 0);
    const billableCount = Math.max(1, count);
    const actualCost = billableCount * unitCost;

    bucket.settled += actualCost;
    if (reservation.isArticle && countAsArticle) this.totalArticles += 1;
    else if (!reservation.isArticle) this.totalTweets += count;

    let overage = 0;
    if (count > 20) {
      overage = count - 20;
      bucket.overage += overage;
    }

    reservation.settled = true;
    return { actualCost, overage };
  }

  /**
   * 网络失败/超时/未知状态：保留预占，划入 unknown_reserved，不释放。
   * @param {object} reservation
   */
  retainAsUnknown(reservation) {
    if (!reservation || typeof reservation !== 'object') return;
    if (reservation.settled || reservation.unknown) return;

    const bucket = this.buckets[reservation.bucketKey];
    if (!bucket) return;

    bucket.reserved -= reservation.amount;
    bucket.unknown_reserved += reservation.amount;
    reservation.unknown = true;
  }

  /**
   * 输出自洽的 credits 统计 DTO。
   */
  toCreditsDto() {
    let totalCap = 0;
    let totalSettled = 0;
    let totalReserved = 0;
    let totalUnknownReserved = 0;
    let totalRequests = 0;
    let totalPages = 0;
    let totalRetries = 0;
    let totalArticles = 0;
    let totalOverage = 0;

    const bucketsCopy = {};
    for (const [key, b] of Object.entries(this.buckets)) {
      totalCap += b.cap;
      totalSettled += b.settled;
      totalReserved += b.reserved;
      totalUnknownReserved += b.unknown_reserved;
      totalRequests += b.requests;
      totalPages += b.pages;
      totalRetries += b.retries;
      totalArticles += b.articles;
      totalOverage += b.overage;
      bucketsCopy[key] = { ...b };
    }

    const used = totalSettled + totalReserved + totalUnknownReserved;

    return {
      total_budget: totalCap,
      budget: totalCap,
      used,
      tweets: this.totalTweets,
      articles: this.totalArticles,
      settled: totalSettled,
      reserved: totalReserved,
      unknown_reserved: totalUnknownReserved,
      overage: totalOverage,
      requests: {
        total: this.tweetRequests + this.articleRequests,
        tweet: this.tweetRequests,
        article: this.articleRequests,
        retries: totalRetries,
        pages: totalPages,
      },
      buckets: bucketsCopy,
    };
  }
}

/**
 * 工厂函数：创建 BudgetLedger 实例。
 */
function createBudgetLedger(slot = 'hot', capsOverride = {}) {
  return new BudgetLedger(slot, capsOverride);
}

module.exports = {
  DEFAULT_BUDGET_CAPS,
  BudgetLedger,
  createBudgetLedger,
};
