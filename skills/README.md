# BrainX 助手技能目录

本目录技能供产品内嵌 agent(src/agent/)发现与加载,随仓库部署(Dockerfile COPY . .)。

- 来源:改写自桌面全局技能 `~/.agents/skills/brainx-*`(原版的写操作配方已替换为
  「建议 + 指引去工作台」——产品内机器人严格只读,无确认 UI)。
- 契约:`SKILL.md` 以 `---` frontmatter 开头,仅 `name:` / `description:` 两个单行字段
  必需(解析器 src/agent/skills.js 不读其他 YAML),正文 Markdown 任意,加载时截 20k。
- 新增技能:一个目录一个技能,目录名随意,`name` 全局唯一;改完重启服务生效。
- 桌面全局技能(`~/.agents/skills/brainx-*`)默认不参与发现,本地调试可设
  `BRAINX_AGENT_GLOBAL_SKILLS=1` 加扫(云版勿开)。
