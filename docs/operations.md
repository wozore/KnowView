# 运维状态

知览已停止主动维护，仓库保留为项目经验与静态资料展示。

## 已关闭能力

- `src/shared/external-operation-policy.js` 将外网访问和 GitHub 仓库操作设为关闭。
- AI 服务、Web Search、YouTube、X、公开数据源、官方网页和 GitHub API 的请求入口都会在发送请求前停止。
- GitHub Actions 工作流、Issue 模板和 Pull Request 模板已从当前工作树移除。
- 新闻 Data PR 与 Codex 联网查证入口会返回关闭错误。
- 静态页面的本地数据读取、搜索、筛选和比较仍可使用。

这些仓库文件变更上传后才会影响 GitHub 上的工作流配置。此前已部署的 Pages 页面可能继续在线展示最后发布的数据；关闭 Pages 托管需要在 GitHub 仓库设置中单独操作。

## 本地查看

从项目根目录构建静态页面并仅在本机启动服务器：

```bash
node scripts/build-dist.js
python -m http.server 8000 --bind 127.0.0.1
```

浏览器打开 `http://127.0.0.1:8000/dist/`。此服务器只用于本机预览，不会启动数据采集服务。

## 本地校验

```bash
node scripts/check-document-policy.js
node scripts/validate.js
```

数据采集、对比抓取、目录研究、工具更新扫描、概念缓存刷新、AI 调用与 GitHub Data PR 命令均已停用。
