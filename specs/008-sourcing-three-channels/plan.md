# 008 — Plan

## 改动文件

1. `specs/008-sourcing-three-channels/spec.md`（三通道决议与边界）
2. `skills/brainx-sourcing-reloop/SKILL.md`（通道 1：内部人才库，brainx_candidate_shortlist）
3. `skills/brainx-sourcing-openmai/SKILL.md`（通道 2：OpenMai 按职位，brainx_openmai_search）
4. `skills/brainx-sourcing-supermai/SKILL.md`（通道 3：SuperMai 按判据，brainx_supermai_scout）

## 不改

- 工具逻辑与参数（三工具已在 specs/007 及此前接线完毕）。
- tests/agent-tools.test.mjs 的 installable 白名单与 allowed 工具集（新 skill 不上 openclaw 安装集）。

## 验证

- `node --test tests/agent-tools.test.mjs`（skills 发现/frontmatter/安装集断言不受影响）。
- `npm run verify:quick`。
