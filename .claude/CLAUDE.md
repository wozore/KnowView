# Claude Code 项目适配入口

项目共同规则位于 `docs/manual/codebase-standards.md`。开始工作前先完整阅读该规范及 `CODEBASE-MAP.md`，再按任务读取 `.claude/agents/` 中的角色配置和相关技能。

所有文件操作（含文档和本地计划）均执行工程规范 §6 的前置检查、失败后停止依赖操作、落盘验证及如实交付要求，不以工具可写或 hook 放行替代必要检查。

Claude Code 专用约定：

- 项目数据目录包括 `data/catalog/`、`data/comparison/`、`data/manual/`、`data/news/` 和 `data/shared/`；数据变更遵守工程规范的 fail-closed 与构建约束。
- `.claude/agents/` 保存 Claude 角色，`.claude/skills/` 保存第三方或本机技能；工具参数不写入项目通用规范。
- Claude 配置独立维护，不依赖其他编码工具的配置目录；项目约束与事实仅引用工程文档，不另行复制。
