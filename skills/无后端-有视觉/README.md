# agent / 无后端 · 有视觉

| 项 | 值 |
|---|---|
| 变体名 | `xiaoshen-agent-local-vision` |
| 存储 | 工作区本地 `.xs_local/`（JSON），**不联网、无凭证** |
| 看图 | **能** |
| 表情包 | 30 张，内嵌进页面 |
| 入口 | `SKILL.md` |
| 存储脚本 | `scripts/xs_local.cjs` |
| 版本 | V0.0330 |
| 基线 | 通用技能包 V0.0330 |

## 和基线差什么

1. **存储层换成本地文件**：`xs_local.cjs` 写 `.xs_local/log.json`（对话）与 `memory.json`（记忆/状态/期望）；命令名与 `xs_memory.cjs` 同形。
2. **删除** `scripts/xs_memory.cjs`、`scripts/vendor/`、`scripts/.xs_scope`——不再需要 IMA、网络、凭证。
3. `save` / `files` / `cat` 改为本地留档（`.xs_local/artifacts/`），替代知识库上传。
4. 重写存储相关章节（存储分工 / 作用域 / 每轮流程 / 命令速查 / 红线 / 环境依赖 / 已知限制）。
5. 新增「视觉核对」小节。
6. `writelog` **保留 `f`（文件卡片）字段**。

## 运行前提

- Node.js ≥ 18
- **不需要网络、不需要任何账号**

## 自检

```bash
node scripts/xs_local.cjs sid           # store_dir 指向工作区 .xs_local，artifact_name 应为 微信.html
node scripts/xs_local.cjs writelog turn.json && node scripts/xs_local.cjs readlog 5
node scripts/build_html.cjs --log .xs_local/render.json --out ./微信.html --title "微信"
```

## 怎么用

把这个目录整体挂进 Agent 的技能目录（或直接把目录丢给 Agent，让它读 `SKILL.md`），
然后说「跟小深聊天」。每轮它会自己拉上下文、扮演、写回、渲染页面。

## 维护规则

- **不改结构**：目录内文件位置与基线一致，只允许改 `SKILL.md` 的变体章节。
- **版本号跟基线走**：基线升到新号时，把 `assets/`、`scripts/build_html.cjs`、`persona.md` 同步过来，
  再把 `VERSION` 对齐，变体差异继续记在 `CHANGELOG.md` 顶部。
- **凭证永不入库**：任何 `.key` / 凭证块都不要出现在本目录。
