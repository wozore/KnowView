---
name: implement
description: 按项目契约实施最小必要代码变更并运行针对性验证。
---

先读 `.codex/AGENTS.md`、`CODEBASE-MAP.md`、`.codex/roles/implementer.md` 和任务契约。确认文件所有权后再编辑；优先复用现有模块，不引入 npm 依赖，不手改 `dist/`，不触碰 `.env` 或调度配置。完成后报告实际修改文件、命令、退出码、契约偏差和验证缺口。

文档与配置也属于实施范围，按 `.codex/AGENTS.md` 执行前置条件、失败处理和落盘验证；必要检查未完成时，不得以可用写入工具继续依赖操作。
