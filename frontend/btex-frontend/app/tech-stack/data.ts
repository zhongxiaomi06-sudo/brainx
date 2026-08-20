// 技术选型内容 —— 结构化数据，页面渲染与内容分离，便于后续维护。

export type Candidate = { name: string; recommended?: boolean };
export type Row = { label: string; cells: string[] };
export type Layer = {
  id: string; no: string; title: string; desc: string;
  candidates: Candidate[]; rows: Row[]; advice: string; redline?: string;
};

export const techStackData: {
  updatedAt: string;
  layers: Layer[];
  conclusion: { layer: string; pick: string; reason: string }[];
} = {
  updatedAt: "2026-08-18",
  layers: [
    {
      id: "cred",
      no: "①",
      title: "凭证层 —— 无头浏览器 + 登录态复用",
      desc: "目标：登录态一把存、一把复用，并对冲 Public 仓库的凭据泄漏风险。",
      candidates: [
        { name: "agent-browser (vercel-labs)" },
        { name: "puppeteer-extra + stealth" },
        { name: "Playwright storageState", recommended: true },
      ],
      rows: [
        { label: "Stars / 维护", cells: ["⭐40.9k · 活跃 · Apache-2.0", "⭐7.4k · 2024 后趋缓", "微软官方 · 极活跃"] },
        { label: "形态", cells: ["Rust CLI（batch/eval/CDP）", "Node 库，需自搭框架", "Node / Python 库"] },
        { label: "登录态持久化", cells: ["✅ state 文件可复用", "⚠️ 需手写 cookies 存取", "✅ storageState 原生（cookie+localStorage 一把存）"] },
        { label: "静态加密", cells: ["✅ 内置 ENCRYPTION_KEY", "❌ 自行实现", "❌ 自行实现"] },
        { label: "反检测（飞书扫码页）", cells: ["一般（需配合）", "✅✅ 同类最强", "⚠️ 需额外 patch"] },
        { label: "上手成本", cells: ["低（AI 易生成脚本）", "中", "中"] },
      ],
      advice:
        "主选 Playwright 做登录态存取内核 + stealth 思路做反检测 + 参考 agent-browser 的加密与 CLI 编排模式。storageState 就是为「一把存、一把复用」而生，比手写 cookies 稳；飞书扫码页反检测用 playwright-extra + stealth；agent-browser 最值得借鉴的是其加密静态存储（直接对冲 Public 仓库风险）。",
    },
    {
      id: "api",
      no: "②",
      title: "接口层 —— 抓 HAR 逆向私有接口",
      desc: "目标：把「页面上点操作」逆向成可调用的接口契约，替代手写字段。",
      candidates: [
        { name: "mitmproxy2swagger", recommended: true },
        { name: "capturePageState（Chrome 扩展）" },
        { name: "mswjs/source" },
      ],
      rows: [
        { label: "Stars / 许可", cells: ["⭐9.6k · MIT · 支持 HAR 输入", "小众 · 扩展模板", "msw 生态 · 活跃"] },
        { label: "输入", cells: ["HAR / mitmproxy flow", "页面 → 一键导 HAR+console+截图", "HAR / OpenAPI"] },
        { label: "输出", cells: ["OpenAPI 3.0 规范", "原始 HAR", "可调用的 request handler"] },
        { label: "敏感数据风险", cells: ["⚠️ --headers 会写入 token，默认不加即安全", "⚠️ HAR 含明文凭证", "—"] },
        { label: "适配场景", cells: ["✅ 把「发起找人」逆向成接口契约", "✅ 作为自研扩展起点", "✅ 逆向后快速生成调用桩"] },
      ],
      advice:
        "抓包起步（或直接 DevTools 导 HAR）→ mitmproxy2swagger 逆向出 OpenAPI → mswjs/source 生成调用桩。三者组合，全链路 MIT/开源、职责清晰。",
      redline: "跑 mitmproxy2swagger 时不要加 --headers，避免 token 写进 spec；HAR 逆向完立即删除。",
    },
    {
      id: "orchestrate",
      no: "③",
      title: "编排层 —— 触发 → 映射 → 调用 → 回写 闭环",
      desc: "目标：先跑通最小闭环，避免过度工程。",
      candidates: [
        { name: "轻量自研（Node/TS 事件驱动）", recommended: true },
        { name: "n8n / Temporal 工作流引擎" },
      ],
      rows: [
        { label: "说明", cells: ["触发器 → 字段映射 → 调用 → 回写", "可视化 / 可靠重试"] },
        { label: "当前阶段评价", cells: ["✅ 逻辑简单，不值得引重框架", "⚠️ 过度工程，闭环稳定后再上"] },
      ],
      advice:
        "先自研最小事件流跑通闭环；稳定后如需要「失败重试 / 可观测」再评估引入 Temporal。",
    },
  ],
  conclusion: [
    { layer: "凭证", pick: "Playwright storageState + stealth 反检测 + 抄加密存储", reason: "一把存复用最稳，加密直接堵 Public 泄漏。" },
    { layer: "接口", pick: "HAR → mitmproxy2swagger → mswjs/source", reason: "全开源，把「页面点」变「代码调」，替代手写字段。" },
    { layer: "编排", pick: "轻量自研事件流，暂不上重引擎", reason: "避免过度工程，闭环优先。" },
  ],
};
