import { request, unwrap, revisionFrom, ApiError } from '../api.js';
import {
  state,
  $,
  addText,
  clearChildren,
  setLoadState,
  showNotice,
  updateRevisionNote,
} from '../state.js';

const CONFIG_LABELS = Object.freeze({
  groups: Object.freeze({
    news: '新闻采集',
    comparison: '模型对比',
    catalog_ai: '目录 AI 配置',
    environment: '运行环境',
  }),
  sections: Object.freeze({
    schema: '结构版本',
    schedule: '调度',
    collection: '采集',
    long_term_quality: '长期质量',
    review: '审核',
    keywords: '关键词',
    x_sources: 'X 来源',
    feedback: '反馈',
    transcripts: '字幕',
    scoring: '评分',
    view: '视图',
    refresh_policy: '刷新策略',
    refresh_state: '刷新状态',
    aliases: '别名',
    exclusions: '排除规则',
    series: '系列',
    effective: '生效配置',
    limits: '限制',
    providers: '提供方注册表',
    credentials: '凭据状态',
    network: '网络状态',
  }),
  collections: Object.freeze({
    platforms_supported: '支持的平台',
    observation_score_range: '观察分数范围',
    content_keywords: '内容关键词',
    youtube_queries: 'YouTube 查询',
    x_discovery_queries: 'X 发现查询',
    excluded_content_keywords: '排除的内容关键词',
    excluded_youtube_queries: '排除的 YouTube 查询',
    excluded_x_discovery_queries: '排除的 X 发现查询',
    accounts: '账号',
    account_groups: '账号组',
    weights: '评分权重',
    type_preference_score: '类型偏好分数',
    default_dimensions: '默认维度',
    sources: '来源',
    vendor_aliases: '厂商别名',
    entries: '条目',
    never_merge: '禁止合并',
    rules: '规则',
    series: '系列条目',
    providers: '提供方',
    credentials: '凭据',
  }),
  fields: Object.freeze({
    schema_version: '结构版本',
    youtube_cron: 'YouTube 调度表达式',
    youtube_tz: 'YouTube 时区',
    youtube_interval_hours: 'YouTube 采集间隔（小时）',
    youtube_window_days: 'YouTube 时间窗口（天）',
    x_cron_hot: 'X 热点调度表达式',
    x_cron_cold: 'X 冷门调度表达式',
    x_tz: 'X 时区',
    tool_update_review_hour_utc: '工具更新审核时（UTC）',
    tool_update_review_minute_utc: '工具更新审核分（UTC）',
    enabled: '采集总开关',
    youtube_search_max_per_run: 'YouTube 每次搜索上限',
    youtube_search_cost_units: 'YouTube 搜索成本单位',
    youtube_daily_quota_units: 'YouTube 每日配额单位',
    youtube_videos_batch_size: 'YouTube 视频批量大小',
    youtube_comments_top_n: 'YouTube 评论前 N 条',
    x_credits_per_hot_run: 'X 热点单次 credits',
    x_credits_per_cold_run: 'X 冷门单次 credits',
    x_credits_per_tweet: 'X 单条推文 credits',
    x_credits_per_article: 'X 单篇文章 credits',
    x_tweets_per_request_max: '单次请求最大推文数',
    max_output_items_daily: '每日最大输出条数',
    min_output_items_daily: '每日最小输出条数',
    max_output_with_youtube: '含 YouTube 时最大输出条数',
    review_top_pure_x: '纯 X 审核 Top 数',
    review_top_with_youtube: '含 YouTube 审核 Top 数',
    ai_top_input_max: 'AI Top 输入上限',
    concurrency: '并发数',
    request_timeout_ms: '请求超时（毫秒）',
    max_retries: '最大重试次数',
    retry_base_ms: '重试基础间隔（毫秒）',
    l1_input_include_comments: 'L1 输入包含评论',
    l1_comments_top_n: 'L1 评论前 N 条',
    l1_confidence_auto_approve: 'L1 自动通过置信度',
    l1_confidence_auto_discard: 'L1 自动丢弃置信度',
    l2_enabled: 'L2 审核开关',
    tool_feedback: '工具反馈',
    concept_feedback: '概念反馈',
    llm_extract: 'LLM 实体提取',
    llm_model: 'LLM 模型',
    refine_rule_top_n: '提纯规则 Top 数',
    refine_batch_size: '提纯批量大小',
    refine_max_output: '提纯最大输出数',
    refine_timeout_ms: '提纯超时（毫秒）',
    notify_count: '字幕通知数量',
    observation_period_count: '观察期数量',
    window_n: '窗口 N',
    window_months_youtube: 'YouTube 窗口月数',
    window_months_x: 'X 窗口月数',
    min_samples: '最小样本数',
    neutral_score: '中性分',
    long_term_quality: '长期质量',
    recent_timeliness: '近期时效性',
    light_user_experience: '轻量用户体验',
    source_reliability: '来源可靠性',
    interaction_quality: '互动质量',
    type_preference: '类型偏好',
    ai_tool: 'AI 工具',
    ai_product: 'AI 产品',
    ai_concept: 'AI 概念',
    ai_industry: 'AI 行业',
    ai_technology: 'AI 技术',
    other: '其他',
    unclassified: '未分类',
    radar_dimension_cap: '雷达维度上限',
    model_cap: '模型数量上限',
    provider: '提供方',
    model: '模型',
    protocol: '协议',
    retrieval_provider: '检索提供方',
    timeout_ms: '请求超时（毫秒）',
    max_search_queries: '最大搜索查询数',
    max_pages: '最大页数',
    max_responses_calls: '最大 Responses 调用数',
    max_synthesis_calls: '最大合成调用数',
    max_repair_calls: '最大修复调用数',
    network_probe_performed: '已执行网络探测',
  }),
});

function configLabel(kind, key, fallback) {
  return CONFIG_LABELS[kind]?.[key] ?? fallback ?? key;
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function namedEntries(value) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const key = entry.key ?? entry.name ?? entry.id ?? String(index + 1);
        const label = entry.label ?? entry.title ?? key;
        const content = Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value : entry;
        return { key, label, value: content };
      }
      return { key: String(index + 1), label: String(index + 1), value: entry };
    });
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, entry]) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)
      && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      return { key, label: entry.label ?? entry.title ?? key, value: entry.value };
    }
    return { key, label: key, value: entry };
  });
}

function groupEntries(groups) {
  return namedEntries(groups).map((entry) => ({
    ...entry,
    sections: entry.value && typeof entry.value === 'object' ? entry.value.sections : [],
  }));
}

function collectionEntries(collections) {
  return namedEntries(collections).map((entry) => {
    const source = entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)
      ? entry.value
      : {};
    const items = Array.isArray(source.items) ? source.items : (Array.isArray(entry.value) ? entry.value : []);
    const count = source.count ?? entry.value?.count ?? items.length;
    return { key: entry.key, label: source.label ?? source.title ?? entry.label, count, items };
  });
}

function renderCollection(parent, collection) {
  const details = document.createElement('details');
  details.className = 'config-collection';
  const summary = document.createElement('summary');
  summary.textContent = `${configLabel('collections', collection.key, displayValue(collection.label))}（${displayValue(collection.count)}）`;
  details.appendChild(summary);
  const items = document.createElement('ul');
  items.className = 'config-items';
  if (!collection.items.length) {
    addText(items, 'li', '暂无返回项。', 'muted');
  } else {
    for (const item of collection.items) addText(items, 'li', displayValue(item));
  }
  details.appendChild(items);
  parent.appendChild(details);
}

function renderSection(parent, section) {
  const sectionNode = document.createElement('section');
  sectionNode.className = 'config-section';
  addText(sectionNode, 'h4', configLabel('sections', section.key, section.label), 'config-section-title');

  const values = namedEntries(section.value?.values);
  if (values.length) {
    const valueList = document.createElement('dl');
    valueList.className = 'config-values';
    for (const value of values) {
      addText(valueList, 'dt', configLabel('fields', value.key, value.label), 'config-key');
      addText(valueList, 'dd', displayValue(value.value), 'config-value');
    }
    sectionNode.appendChild(valueList);
  }

  const collections = collectionEntries(section.value?.collections);
  if (collections.length) {
    const collectionList = document.createElement('div');
    collectionList.className = 'config-collections';
    for (const collection of collections) renderCollection(collectionList, collection);
    sectionNode.appendChild(collectionList);
  }
  if (!values.length && !collections.length) addText(sectionNode, 'p', '当前分段没有可展示参数。', 'muted');
  parent.appendChild(sectionNode);
}

function renderGroup(parent, group) {
  const groupNode = document.createElement('section');
  groupNode.className = 'config-group';
  addText(groupNode, 'h3', configLabel('groups', group.key, group.label), 'config-group-title');
  const sections = namedEntries(group.sections).map(entry => ({
    key: entry.key,
    label: entry.label,
    value: entry.value,
  }));
  if (!sections.length) {
    addText(groupNode, 'p', '当前配置组没有可展示分段。', 'muted');
  } else {
    for (const section of sections) renderSection(groupNode, section);
  }
  parent.appendChild(groupNode);
}

export function renderConfig(payload) {
  const root = $('#configList');
  if (!root) return;
  clearChildren(root);
  const data = unwrap(payload);
  const groups = groupEntries(data?.groups);
  if (data?.mode) addText(root, 'p', `展示模式：${data.mode === 'read_only' ? '只读' : displayValue(data.mode)}`, 'config-mode');
  if (!groups.length) {
    addText(root, 'p', '当前没有可展示的配置参数。', 'empty-state');
    setLoadState('configState', '空数据', 'success');
    return;
  }
  const groupList = document.createElement('div');
  groupList.className = 'config-groups';
  for (const group of groups) renderGroup(groupList, group);
  root.appendChild(groupList);
  setLoadState('configState', `${groups.length} 组`, 'success');
}

export async function loadConfig() {
  const root = $('#configList');
  state.loading.add('config');
  setLoadState('configState', '加载中…', 'loading');
  try {
    const payload = await request('config');
    const revision = revisionFrom(payload);
    if (revision) state.revisions.config = revision;
    renderConfig(payload);
    updateRevisionNote();
  } catch (error) {
    clearChildren(root);
    const message = error instanceof ApiError && error.status === 409
      ? '配置数据已变化，请刷新后重试。'
      : '配置参数加载失败，请检查 token 与工作台 API。';
    addText(root, 'p', message, 'error-state');
    setLoadState('configState', error instanceof ApiError && error.status === 409 ? '数据冲突' : '加载失败', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    showNotice(message, error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  } finally {
    state.loading.delete('config');
  }
}

export function setupConfigPanel() {
  const root = $('#configList');
  if (root) root.setAttribute('aria-readonly', 'true');
}
