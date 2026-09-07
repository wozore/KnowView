# Codex 项目工作流程

本目录集中保存五个可按任务读取的工作流程。`.codex/config.toml` 引导读取 `.codex/AGENTS.md`，由其中的索引选择并完整读取相应 `SKILL.md` 和 `.codex/roles/` 契约。

此目录不是 Codex 原生自动扫描的 `.agents/skills`，不保证出现在技能选择菜单中；可直接要求“按 team-run / research / implement / code-review / software-lifecycle-guard 执行”。不为自动发现另建目录或符号链接。
