# Claude Code 项目适配入口

项目共同规则位于仓库根目录 `AGENTS.md`，角色契约位于 `.agents/roles/`。开始工作前先完整阅读 `AGENTS.md`、`CODEBASE-MAP.md`，再按任务读取相关技能。

Claude Code 专用约定：

- 项目数据目录包括 `data/catalog/`、`data/comparison/`、`data/manual/`、`data/news/` 和 `data/shared/`；数据变更仍须遵守 `AGENTS.md` 的 fail-closed 与构建约束。
- `.claude/agents/` 是本机角色适配层；角色职责和不变量以 `.agents/roles/` 为准，避免在这里发展出第二套项目规则。
- `.claude/skills/` 可能包含第三方或本机缓存，不作为 Codex 技能源；可复用内容应迁移到 `.agents/skills/` 并纳入版本控制。
- Agent Teams 的模型与工具参数属于 Claude 运行时配置，不得写入共享角色契约，也不得覆盖 `AGENTS.md` 的项目边界。
- 保持原有 Claude 运行习惯时，仍须遵守 `AGENTS.md` 中的凭据、数据生成、`dist/` 和 Git 操作约束。
