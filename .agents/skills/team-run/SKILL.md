---
name: team-run
description: 为复杂任务规划并执行 Research、Architecture、Implementation、Verification、Review 阶段。
---

# 项目团队调度

先阅读 `AGENTS.md`、`CODEBASE-MAP.md` 和 `.agents/roles/` 中相关契约，评估任务的范围、不确定性、耦合、验证难度和风险。低风险单文件任务直接执行；只有存在独立工作流、上下文隔离或独立验证价值时才委派子任务。

调度规则：

1. 研究和架构可以并行，但实现必须等待契约明确。
2. 并行任务必须拥有不重叠的文件所有权；同一文件始终只有一个写者。
3. 实现完成后由 Verifier 执行针对性检查和必要的全量验证，Reviewer 独立审查。
4. 不复制 Claude 的 `subagent_type`、`opus`、`sonnet`、`fable` 绑定；使用当前 Codex 的可用模型和工具。
5. 每个阶段输出简短报告：改动、证据、未验证范围、下一步依赖。发现需要付费 API、发布或用户产品决策时暂停并报告。

最终报告必须说明实际执行的命令、退出码、工作树中与本任务相关的文件，以及仍需人工决定的事项。
