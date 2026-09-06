# 知览（KnowView）架构

> 当前实现事实、模块边界和数据流。设计理由见 [架构决策](decisions.md)，运维命令见 [运维操作](operations.md)，未来长期演进见本地维护者工作稿开发计划。

## 定位与技术栈

知览（KnowView）是部署在 GitHub Pages 的开源 AI 信息聚合与编辑部平台。浏览器使用原生 HTML/CSS/JS，构建脚本使用 Node.js 20；项目无 npm 依赖，以 Git 管理静态 JSON，构建产物为 `dist/`。

当前为环 B（MVP 交付），提供工具库、场景导航、对比模式、AI 热点、编辑精选、AI 概念和关于七个视图。

## 系统拓扑

```text
工具/对比/场景/概念 JSON ───────────────┐
YouTube、X → 热点构建 ─────────────────┤→ 浏览器静态站 → GitHub Pages
多源上游数据 → 对比/概念刷新 ───────────┘
```

六个 GitHub Actions 工作流分别负责热点采集、热点发布、对比数据刷新、工具更新周审、Vibe Hub 概念缓存刷新以及构建部署；触发时间与写入范围见 [运维操作](operations.md)。

## 目录与模块边界

| 目录 | 契约 |
|---|---|
| `src/web/` | 页面、样式、数据加载、筛选、比较和七视图渲染 |
| `src/news/` | 热点管线 v2（采集、去重、分类、审核、评分、候选与投影）和 CLI 实现 |
| `src/content/` | RSS 和 OG 生成 |
| `src/maintenance/` | 数据校验 |
| `src/shared/paths.js` | Node 数据路径的唯一登记点 |
| `scripts/` | CI 使用的稳定薄入口，不放业务逻辑 |
| `tests/` | 自动化测试和 fixtures |
| `data/catalog/` | 工具、术语、场景和编辑精选主数据 |
| `data/news/` | 热点配置（configV2）、运行时状态和公开投影 |
| `public/` | RSS、sitemap、robots、OG 等部署根资源 |
| `docs/` | 系统级设计与工程手册，不放运行时数据或代码 |
| `resources/` | 人工参考材料，不直接发布 |

数据结构变化时须同步 `src/maintenance/validate.js` 和相关测试。每份数据只保留一个权威路径，不在 `data/` 根目录新增 JSON，也不在代码中绕过 `src/shared/paths.js` 硬编码路径。

## 浏览器运行时

浏览器只读取 `data/catalog/` 主数据和 `data/news/output/hotspots.json`，不读取 `data/news/runtime/` 内部状态。`catalog(request)` 是五模块目录的唯一 Interface，`loadData()` 加载其他独立数据，`switchView()` 切换视图，各渲染函数生成页面；单份数据加载失败时保留其他视图并显示降级说明。

五模块目录层级：

- **厂商卡**：厂商总览入口，通过 `level1_ref` 打开一级预览，不作为场景推荐对象；
- **厂商一级/二级预览**：通过稳定 `level2_refs` / `detail_refs` 组织模型、套餐和工具详情；
- **工具卡**：只包含 `tool`、`api_model` 和未来 `product_variant`，通过 `detail_ref` 打开三级详情；
- **三级详情**：模型、工具、产品变体和订阅套餐的唯一详情来源，价格、场景、官方日期与来源由这里拥有；订阅套餐不生成工具卡。

## 数据所有权

| 类别 | 主要文件 | 读写方 |
|---|---|---|
| 五模块工具目录 | `vendor-cards.json`、`tool-cards.json`、`vendor-preview-level1.json`、`vendor-preview-level2.json`、`tool-preview-level3.json` | 人工维护；三级 API 价格可由采集器更新；浏览器通过 catalog Interface 读取 |
| 其他目录数据 | `glossary.json`、`scenes.json`、`featured.json` | 人工维护；浏览器读取 |
| 热点配置 | `news-config-v2.json` | 人工维护；构建/CLI 读取 |
| 热点投影 | `hotspots.json` | 发布脚本原子写入；浏览器读取 |
| 内部状态 | `runtime/min-candidates.json`、`runtime/source-history.json` | 构建/CLI 读写 |

API Key 仅通过 GitHub Repository Secrets 注入，不进入代码、JSON 或浏览器。

## 四条数据流

### 工具目录

```text
data/catalog/{vendor-cards,tool-cards,vendor-preview-level1,vendor-preview-level2,tool-preview-level3}.json
  → catalog(request) → data.js 领域查询 → 工具库/场景/精选/搜索/对比/热点相关资源

data/catalog/{glossary,scenes,featured}.json
  → fetch() → 对应浏览器视图
```

人工维护主数据；`scripts/validate.js` 负责静态校验。

### AI 热点

```text
YouTube search.list ─────────────┐
X（TwitterAPI.io）──────────────┤→ pipeline-min.js（runMin）
                                 ├→ 去重 → L0 硬过滤 → 分类 → 评分 → L1/L2 审核
                                 ├→ min-candidates.json（候选落地）
                                 └→ publish-news.js → hotspots.json
```

`pipeline-min.js`（`runMin`）编排采集、去重、L0 规则硬过滤、分类、基于历史库的评分、L1/L2 审核和每日公开投影；候选落地到 `min-candidates.json`，长期质量写入 `source-history.json`。发布阶段 `publish-news.js` 从 approved 且被选中的候选重建 `hotspots.json` 并生成 RSS。失败不得以空结果覆盖上一版有效 `hotspots.json`。

核心模块：

- `collector-youtube-v2.js`：YouTube search.list 关键词发现，配额耗尽降级 mostPopular；
- `collector-x-v2.js`：X（TwitterAPI.io）博主时间窗 + 关键词搜索，独立计 credits；
- `review-v2.js`：L0 规则硬审 → L1 AI 审 → L2 AI 建议 + 人工；
- `history-store.js`：来源长期质量历史库（三率加权）；
- `scoring-v2.js`：6 权重加权评分（长期质量来自历史库，互动用真实三率）；
- `min-store.js`：候选层读写（min-candidates.json，人工结论不因重采而重置）；
- `daily-projection.js`：approved 按天分组取前 N 的公开投影；
- `pipeline-min.js`：v2 总指挥（`runMin` 编排）；
- `news-cli.js`：min-review 审核命令组。

平台来源、时间窗口和降级边界以 [质量标准](content-quality.md) 为准。

### 对比数据与概念缓存刷新

```text
多源上游（OpenRouter / LMArena / LiveBench / llm-stats）→ fetch-comparison.js → rebuild-comparison.js
  → 维度归一化与模型对齐 → data/comparison/integrated/

Vibe Hub 概念术语 → refresh-vibe-hub-cache.js → data/catalog/vibe-hub-cache.json
```

### RSS / SEO

```text
hotspots.json → generate-rss.js → public/feed.xml
src/web/ → generate-og-image.js → OG 图
```

## 当前边界

已实现静态七视图、热点管线 v2（采集、去重、分类、审核、评分、候选与公开投影）、模型对比数据管理、规则评分、证据与溯源、管理 CLI、单元测试和部署前校验。

当前 MVP 不包含：

- 浏览器运行时直接调用平台 API；
- 数据库、Serverless API、用户账户或实时推送；
- AI 自动事实裁决、商单定性或作者动机判断；
- 无限历史回溯或无人审核的数据直接入库。

## 扩展不变量

1. 新浏览器数据源在 `loadData()` 中加载并提供失败空状态；新增视图须完整接入切换、渲染、事件和样式。
2. 新采集平台使用独立适配器；所有检测内容先进入 v2 候选层。
3. 新网络操作先定义成本、重试计费和暂停恢复方式。
4. 推广、异常和来源关系必须保留证据与置信度；未知值不得填零。
5. 采集失败保留旧投影，不得以空结果覆盖上一版有效 `hotspots.json`。
