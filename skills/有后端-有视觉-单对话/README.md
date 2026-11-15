# agent / 有后端 · 有视觉

| 项 | 值 |
|---|---|
| 变体名 | `xiaoshen-agent-ima-vision-single` |
| 存储 | 腾讯 IMA（笔记 + 知识库），需联网与凭证 |
| 看图 | **能**——可以读用户截图、读自己渲染的截图 |
| 表情包 | 30 张，内嵌进页面 |
| 入口 | `SKILL.md` |
| 版本 | V0.0330 |
| 基线 | 通用技能包 V0.0330 |

## 和基线差什么

1. **SKILL.md 末尾保留 `<!-- IMA-CREDENTIALS -->` 凭证块**（本层唯一与官网的差别，开箱即用）；红线 11 与「环境依赖」第 3 条同步改成自用措辞。**对外分发前必须删掉这个块。**
2. **新增「视觉核对」小节**（HTML 硬约束之后、红线之前）：截图规范、取色取「平台色」、结论必须落到数值。
3. frontmatter `name` 改成 `xiaoshen-agent-ima-vision`，触发词补一行变体标识。
4. 其余正文、模板、脚本与基线**逐字相同**。

## 运行前提

- Node.js ≥ 18
- 能访问 `https://ima.qq.com`
- 凭证：本目录 `SKILL.md` 末尾已带 Key；`~/.config/ima/` 里若有同名字段会**优先于**它生效

## 自检

```bash
node scripts/xs_memory.cjs sid          # artifact_name 应为 微信.html
grep -c IMA-CREDENTIALS SKILL.md        # 官网格应为 0（自己用同格为 3）
grep -c "视觉核对" SKILL.md              # 应为 1
```

## 怎么用

把这个目录整体挂进 Agent 的技能目录（或直接把目录丢给 Agent，让它读 `SKILL.md`），
然后说「跟小深聊天」。每轮它会自己拉上下文、扮演、写回、渲染页面。

## 维护规则

- **不改结构**：目录内文件位置与基线一致，只允许改 `SKILL.md` 的变体章节。
- **版本号跟基线走**：基线升到新号时，把 `assets/`、`scripts/build_html.cjs`、`persona.md` 同步过来，
  再把 `VERSION` 对齐，变体差异继续记在 `CHANGELOG.md` 顶部。
- **凭证永不入库**：任何 `.key` / 凭证块都不要出现在本目录。
