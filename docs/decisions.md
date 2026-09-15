# 架构决策记录

> 当前实现见 [架构文档](architecture.md)。每项决策均已采纳。

## 索引

| 编号 | 决策 |
|---|---|
| ADR-001 | 单仓库分层组织 |
| ADR-002 | 纯静态站点 + GitHub Pages |
| ADR-003 | Node.js 零 npm 依赖 |
| ADR-004 | JSON 文件存储 |
| ADR-005 | 源码、数据与部署资源分离 |
| ADR-006 | 构建时采集 |
| ADR-007 | 概念索引通过前端适配层生成稳定概念 ID，不改写数据契约 |
| ADR-008 | B16 热点浏览与详情体验（P1-B 阻塞级）实现与数据依赖 |
| ADR-009 | B16 高优先级差异修复 |
| ADR-010 | 热点 `content_type` 与 `source_type` 字段拆分（路径 B） |

## ADR-001：单仓库分层组织

**决策**：源码、数据、文档、开发过程和 AI 入口位于同一 Git 仓库，并按职责分层。

**理由**：固定阅读顺序和职责边界，使每个事实有唯一权威位置，降低同步和跨仓库理解成本。

**替代方案**：工程仓库与部署仓库分离；因同步负担和上下文割裂未采用。

## ADR-002：纯静态站点 + GitHub Pages

**决策**：MVP 使用纯静态 HTML/CSS/JS 并部署到 GitHub Pages，不引入运行时后端。

**理由**：无服务器成本，匹配现有技能，并可通过 GitHub Actions 在构建时更新内容。

## ADR-003：零 npm 依赖

**决策**：Node.js 脚本只使用内置模块，不引入 npm 依赖。

**理由**：减少供应链攻击面和依赖漂移，降低部署及理解成本。

## ADR-004：JSON 文件存储

**决策**：数据使用静态 JSON 并纳入 Git 版本控制。

**理由**：直接可读、易校验、无需数据库运维且历史可审计。

## ADR-005：源码、数据与部署资源分离

**决策**：`src/` 放实现，`data/` 放运行数据，`public/` 放部署根资源。

**理由**：避免代码检索混入数据文件，构建发布时可直接组装所需资源。

## ADR-006：构建时采集

**决策**：热点和工具情报由 GitHub Actions 采集并输出静态 JSON，浏览器不直接调用平台 API。

**理由**：保护密钥、控制频率和成本、保留离线可用性，并维持纯静态前端。

## ADR-007：概念索引通过前端适配层生成稳定概念 ID，不改写数据契约

**决策**：全站概念索引联动（B16 决策 9.8 / 9.8.2）所需的稳定概念 ID 与匹配字段均由前端适配层生成和维护，不改写 `glossary.json` 数据契约；`aliases` 作为适配层扩展缝保留，不在首期写入数据。

**现状**：`data/catalog/glossary.json`（45 条）顶层字段为 `term`、`full_name`、`category`、`summary`、`related_terms`、`source`、`relevance`，没有 `aliases`，也没有显式概念 ID。

**适配层实现（`src/web/js/`，只读引用）**：

- 稳定 ID：`searchConceptKey(term)` 对 `term` 做 NFKC 归一化、中文小写、非字母数字段替换为连字符并去首尾，确定性生成 `concept-<slug>`（`src/web/js/views/trending.js`）。同一词条在任何页面得到同一 ID。
- 选中/跳转主键：概念视图以 `term` 为主键（`activeGlossaryId`、`data-glossary-pick`、`data-search-concept`），同时 `src/web/js/views/trending.js` 在解析概念引用时同时接受 `term` 与 `concept-<slug>` 两种写法。
- 匹配字段：`getSearchConceptPatterns()` 从 `term` 与 `full_name` 构建匹配模式，长词优先；配合排除词表（`CONCEPT_EXCLUSION`）与拉丁/数字缩写词边界控制误匹配（`src/web/js/views/search-index.js`）。
- 别名扩展缝：若需补充别名（如 "RAG" → "检索增强生成"），在适配层以本地别名映射或读取可选 `aliases` 字段的方式加入，不修改既有词条数据。

**理由**：B16 P1-A 依赖说明明确“必要时使用原型适配层，不直接改写既有数据契约”；决策时 43 条词条多数没有现成别名，直接写入会引入未经核验内容并扩大校验范围；适配层方案无数据迁移成本，且 `term` 与派生 ID 均随词条名稳定。

**后续（v1.0 再评估）**：如需权威别名与显式 ID，在 `glossary.json` 增加 `concept_id` 与 `aliases[]` 字段，并在校验脚本中复核唯一性后，再让适配层读取新字段。

**状态（2026-08-03）**：正式确认作为 B16 决策 9.8.2 概念联动的落地方式（开发计划 B16-R1 解决）：不改写 `glossary.json` 数据契约，稳定概念 ID 与匹配字段由前端适配层生成与维护；如需权威别名与显式 ID 仍按上方「后续」评估。

## ADR-008：B16 热点浏览与详情体验（P1-B 阻塞级）实现与数据依赖

**状态**：现行有效。内容类型作为列表级一级筛选已实际生效（公开数据 `content_type` 为真实分类值）；`related_resources` 已由公开投影管线自动补充（B16-R7 方案 A），不再是「数据待补充」状态。

**决策**：B16 阻塞级项按「编辑部式内容流 + 详情对话框 + 来源内联展开 + 热度排序 + 稳定 ID 关联资料」落地（决策 74/75/76/77/78/79/80/85/87/88/89）。平台只作为来源核验信息、不作为列表级筛选；热点详情不新增独立路由，关闭后回到原列表位置。

**实现（`src/web/js/views/trending.js` / `src/web/js/data/data-filters.js`）**：

- 热点详情三段式：摘要—来源核验—关联资料，来源默认收起，对话框内联展开来源（`openHotspotDetail()` / `data-hotspot-source-toggle`）。
- 卡片来源入口：默认卡片只显示内容类型、标题、短摘要、时间线索与低权重「查看来源 / 打开详情」入口；「查看来源」在当前卡片内联展开平台、来源名、内容时间、数据更新时间与原始来源链接，同一时刻只展开一个（`renderTrendingCard()` / `data-hotspot-card-source-toggle`）。
- 模糊预览：卡片悬停/键盘聚焦显示保持模糊的次级摘要（`.trending-secondary-preview`，`filter: blur(6px)`），移动端隐藏。
- 平台筛选移除：内容类型作为唯一列表级一级筛选（`getFilteredTrending()`），`activeTrendingPlatform` 已删除。
- 热度排序：默认最近、可切热度，热度缺失值排末尾、不伪装为 0，热度说明经低权重提示查看（`getHotspotHeat()` / `renderTrendingSortHelp()`）。
- 关联资料：按稳定 ID 分组为工具/概念/场景入口并进入现有视图，对象失效显示「资料暂不可用」（`getHotspotRelatedResources()` / `renderHotspotRelatedResources()`）。

**数据契约（`data/news/output/hotspots.json`）**：

- `hot_score`（100/100）与 `evidence_excerpt`（99/100）已由构建脚本填充，热度排序与来源依据已生效。
- `related_resources` 由公开投影管线自动补充（`src/news/pipeline/projection.js` 的 URL 精确身份匹配 + 标题词边界匹配，合并去重、上限截断），命中目录工具/概念/场景时详情区渲染关联卡片，无命中显示「关联资料暂不可用」空态。

**理由**：平台是来源核验信息而非热点卡片的主阅读信息（决策 74/79）；来源核验默认收起、详情不新增独立路由（决策 75/87/88）；缺失数据不得伪造或伪装为最新（决策 76/93）。

## ADR-009：B16 高优先级差异修复

**状态**：静态演示边界、空状态、焦点管理与概念适配层条目现行有效；评分体系相关条目（对比「评分来源」行、关于页评分口径、工具发布时间占位）已随工具卡目录重构（`data/catalog/tool-cards.json` 取代 `tools.json`、人工 1–5 评分体系移除）被移除，对比图表现展示「资料来源 / 日期」。

**决策**：按 B16 决策 8.1/9.5/9.8.2/10.3/80/84/93/94/97/98 修复高优先级差异，不改变数据契约；缺失字段明确标注而非猜测补齐。

**实现与状态**：

- 结果页静态演示边界（决策 8.1）：`#searchResultsBoundary` 常驻提示「静态演示 · 不代表实时联网检索或 AI 生成结果」，不随搜索状态隐藏。
- 热点四类空状态「下一步操作」（决策 80）：`renderState()` 支持 `actions`，四类状态分别提供清除筛选 / 重新加载 / 了解规则 / 返回工具库。
- 局部「正在更新」反馈（决策 10.3）：`setRegionBusy()` 增加 `.is-updating` 覆盖与 `aria-busy`；同步重渲染不闪烁，仅防抖/异步时可见。
- 移动菜单与筛选焦点管理（决策 84/94）：菜单打开焦点移入首个可聚焦项、从菜单进入视图焦点转至标题；筛选面板打开移入首筛选项，`Escape` / 完成 / 清除全部关闭并回焦。
- 对比图表来源与更新时间（决策 9.5/93）：`renderCompareProvenance()` 逐项列出资料来源与资料日期（`src/web/js/views/compare.js`）；工具对比表提供「资料来源 / 日期」行。决策时实现为「评分来源 / 更新时间」并配人工 1–5 评分口径说明，工具评分体系后续重构移除后收敛为资料来源与日期。
- 概念 ID / aliases 适配层（决策 9.8.2）：见 ADR-007，前端适配层生成稳定概念 ID，不改写 `glossary.json`。

## ADR-010：热点 `content_type` 与 `source_type` 字段拆分（路径 B）

**状态**：双字段拆分契约现行有效；「当前统一置 `unclassified` 诚实占位、路径 A 待启动」已不再是现状——路径 A 已落地（`src/news/classify/` 的 L0 规则式 + L1 AI 两级分类与人工审核确认），公开数据 `content_type` 为真实分类值，内容类型筛选实际生效。热点管线已重构为 v2（`pipeline-min`），候选层 schema、B 站采集与 `--migrate-content-type` 迁移子命令均随 v1 清理演进。

**决策**：把「来源媒体类型」与「内容类型」拆成两个字段。采集时媒体类型写入 `source_type`（`youtube_video`/`x_post`/`bilibili_*`/`unknown`）；`content_type` 语义改为内容类型（决策 65 六类 + `unclassified`），决策落地时统一置 `unclassified` 诚实占位，待路径 A（AI 分类 + 人工审核确认）填充。`content_type_status` 记录 `ai_suggested`/`reviewed`/`unclassified`。

**实现（决策落地时基于 v1 管线；现状见状态行）**：

- 采集层：决策时 `normalizeRssItem`/`normalizeTweet`/历史导入模块输出 `source_type`；现为 `collector-youtube-normalize.js` / `collector-x-normalize.js` 输出，`source_type` 值域 `youtube_video`/`x_post`/`unknown`（B 站源随 v1 清理移除）。
- 校验：`SOURCE_TYPES` 与 `CONTENT_TYPES`（六类 + `unclassified`）拆分（`src/maintenance/validate-news.js`），`source_type` 必填、`content_type` 可选。
- 前端：`contentTypeLabels` 为内容类型映射（含 `unclassified: '类型待确认'`）；`SOURCE_TYPE_LABELS` 进来源核验层；全部未分类时类型筛选区隐藏（决策 80 空状态）。

**理由**：前端把「X 帖子 / YouTube 视频」当内容类型展示，等价于把平台作为列表级筛选，违背决策 65/74/79；`content_type` 的权威来源是决策 66 的「AI 建议 + 人工确认」，数据侧当时尚未具备，故先拆分字段并置 `unclassified` 诚实占位，不在前端硬编码分类（决策 79）。
