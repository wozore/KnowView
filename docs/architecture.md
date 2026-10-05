# 知览（KnowView）架构

> 当前实现事实、模块边界和数据流。设计理由见 [架构决策](decisions.md)，运维命令见 [运维操作](operations.md)，未来长期演进见本地维护者工作稿开发计划。

> **当前运行状态：** 项目已转为静态归档。共享策略关闭所有外网请求与 GitHub 仓库操作；GitHub Actions 工作流已从仓库配置中移除。浏览器保留本地快照浏览、筛选、比较和搜索。

## 定位与技术栈

知览（KnowView）是以静态归档方式保留的 AI 信息聚合与编辑部项目。浏览器使用原生 HTML/CSS/JS，构建脚本使用 Node.js 20；项目无 npm 依赖，以静态 JSON 展示资料，构建产物为 `dist/`。

当前为环 B（MVP 交付），提供 AI 搜索、工具库、场景、对比、AI 热点、编辑精选、AI 概念和关于八个视图。

## 系统拓扑

```text
本地 JSON 快照 → 浏览器静态站 → 本机静态服务器
```

代码保留原有的采集和构建模块以供项目阅读；共享运行策略会在任何外网请求前拒绝请求。仓库不再配置 GitHub Actions 工作流。

## 目录与模块边界

| 目录 | 契约 |
|---|---|
| `src/web/` | 页面、样式、数据加载、筛选、比较和八视图渲染 |
| `src/news/` | 热点管线 v2（采集、去重、分类、审核、评分、候选与投影）和 CLI 实现 |
| `src/catalog/` | 目录生成与研究域：厂商/工具/概念卡合成、URL 登记与工具更新审核 |
| `src/comparison/` | 对比数据抓取、模型身份对齐与系列归一 |
| `src/content/` | RSS 和 OG 生成 |
| `src/maintenance/` | 数据校验 |
| `src/maintainer-web/` | 维护者工作台前端页面与面板 |
| `src/pending/` | 目录待补卡（工具/概念）存储与采纳规则 |
| `src/shared/paths.js` | Node 数据路径的唯一登记点 |
| `scripts/` | CI 使用的稳定薄入口，不放业务逻辑 |
| `tests/` | 自动化测试和 fixtures |
| `data/catalog/` | 工具、术语、场景和编辑精选主数据 |
| `data/news/` | 热点配置（configV2）、运行时状态和公开投影 |
| `data/comparison/` | 模型对比数据层：raw 原样快照、integrated 前端索引与人工对齐登记表 |
| `data/manual/` | 人工工作目录：官方登记表（registries）、工具/概念链路与待审清单 |
| `data/shared/` | comparison 与 catalog 间唯一跨层共享数据（发布日期、身份桥与保留策略） |
| `public/` | RSS、sitemap、robots、OG 等部署根资源 |
| `docs/` | 系统级设计与工程手册，不放运行时数据或代码 |
| `resources/` | 人工参考材料，不直接发布 |

数据结构变化时须同步 `src/maintenance/validate.js` 和相关测试。每份数据只保留一个权威路径，不在 `data/` 根目录新增 JSON，也不在代码中绕过 `src/shared/paths.js` 硬编码路径。

## 浏览器运行时

浏览器读取 `data/catalog/` 主数据、`data/comparison/` 集成索引（`view-config.json`、`models-alias.json` 与 `integrated/`）和 `data/news/output/hotspots.json`，不读取 `data/news/runtime/` 与 `data/comparison/raw/` 内部状态。`catalog(request)` 是五模块目录的唯一 Interface，`loadData()` 加载其他独立数据，`switchView()` 切换视图，各渲染函数生成页面；单份数据加载失败时保留其他视图并显示降级说明。

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
本地热点快照 → 浏览器展示
```

外部采集、AI 分类与审核、候选交付和自动发布均不再运行。浏览器只读取项目中已有的热点快照。

核心模块：

- `collector-youtube-v2.js`：YouTube search.list 关键词发现，配额耗尽降级 mostPopular；
- `collector-x-v2.js`：X（TwitterAPI.io）博主时间窗 + 关键词搜索，独立计 credits；
- `collectors/x-search/`：X Advanced Search 纯逻辑子域（时间窗、查询构造、分页、预算账本、账号/发现执行器与断点存储），由 `index.js` 门面统一导出；
- `review-v2.js`：L0 规则硬审 → L1 AI 审 → L2 AI 建议 + 人工；
- `history-store.js`：来源长期质量历史库（三率加权）；
- `scoring-v2.js`：6 权重加权评分（长期质量来自历史库，互动用真实三率）；
- `min-store.js`：候选层读写（min-candidates.json，人工结论不因重采而重置）；
- `daily-projection.js`：approved 按天分组取前 N 的公开投影；
- `pipeline-min.js`：v2 总指挥（`runMin` 编排）；
- `news-cli.js`：min-review 审核命令组。

平台来源、时间窗口和降级边界以 [质量标准](content-quality.md) 为准。

### 对比数据与概念缓存

```text
data/comparison/integrated/ 与 data/catalog/glossary.json → 浏览器读取
```

### RSS / SEO

```text
hotspots.json → generate-rss.js → public/feed.xml
src/web/ → generate-og-image.js → OG 图
```

## 当前边界

当前保留静态八视图、热点快照、模型对比快照、规则与证据处理源代码，以及离线项目校验工具。外网信息获取和 GitHub 仓库操作处于关闭状态。

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
