# KnowView · Codex 项目说明

本目录集中保存 Codex 专用规则、工作流程、角色和 hook；不得将 Codex 配置校验接入项目业务验证。项目通用约束的唯一来源是 `docs/manual/codebase-standards.md`。

## 开始工作

- 完整读取 `docs/manual/codebase-standards.md` 和 `CODEBASE-MAP.md`，执行规范 §6 的文件操作前置检查、数据安全及验证要求。
- 必要读取或检查失败时停止依赖操作，工具恢复后先补查；此要求也适用于本地计划和配置。
- 根据下表选择工作流程，完整读取对应文件及它要求的角色契约；用户指定名称时按指定流程执行。低风险任务不机械套用团队流程。

| 工作流程 | 使用场景 | 文件 |
| --- | --- | --- |
| research | 只读调查项目与官方资料 | `.codex/skills/research/SKILL.md` |
| implement | 实施授权范围内的变更 | `.codex/skills/implement/SKILL.md` |
| code-review | 只读审查 | `.codex/skills/code-review/SKILL.md` |
| software-lifecycle-guard | 核对任务阶段与验收边界 | `.codex/skills/software-lifecycle-guard/SKILL.md` |
| team-run | 有独立验证或分工价值的复杂任务 | `.codex/skills/team-run/SKILL.md` |

## 专用配置维护

- 工作流程位于 `.codex/skills/`，角色位于 `.codex/roles/`；修改职责时先改角色，再同步工作流程。
- 这些是由本入口显式索引的本地工作流程，不依赖原生技能自动扫描，也不承诺在技能菜单出现。
- 不绑定 Claude 的模型或 `subagent_type` 参数，模型沿用当前 Codex 设置。
- `config.toml` 只保存项目行为设置；MCP 登录、凭据和本机权限继续留在用户级配置。
- 配置改动后执行 `node .codex/scripts/check-config.js` 和 `node --test ".codex/tests/*.test.js"`。它们与项目的 `scripts/validate.js` 独立运行。
- hook 只做轻量只读提醒，保持 fail-open；不读取 `.env`、调用付费 API、修改文件或替代授权与前置检查。
- 修改 `.codex/config.toml` 后，新任务或重启应用才会重新加载；当前任务应主动读取更新后的文件。不得将静态文件检查说成新会话已实际加载。
