/** openmai-markdown.ts — OpenMai 找人结果的 Markdown 渲染（2026-08-31）。
 *
 * 背景：后端 openmai.result_text 是 GFM（标题 + 候选人表格 + 链接），
 * 此前 DecisionDrawer 用 <pre> 原文直出——表格源码、机器 JSON 块、HTML 注释
 * 全部糊在用户脸上，不可读。
 *
 * 选型 marked（v18）：GFM 表格开箱即用，min ~90KB / gzip ~30KB，满足小包体要求；
 * 比 markdown-it 更轻，snarkdown（1KB）不支持表格被否。
 *
 * 清洗规则：
 *   ① ```openmai-table-artifact ... ``` 机器 JSON 块（给下游系统消费的，不是给人看的）；
 *   ② <!-- RECOMMENDED_IDS ... --> 等 HTML 注释（机器元数据）；
 *   ③ 链接一律新窗口 + noopener（候选人档案跳 ttcadvisory）。
 * 内容源是后端 openmai 任务输出（非任意用户输入），注入点仅此一处。
 * 文件用 .ts + createElement（非 JSX），让 node --experimental-strip-types 测试可直接 import。
 */
import { marked } from "marked";
import { createElement, type CSSProperties, type ReactElement } from "react";

const MACHINE_ARTIFACT = /```openmai-table-artifact[\s\S]*?```/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** result_text → 安全可读的 HTML（纯函数，单测直接覆盖）。 */
export function openmaiToHtml(text: string): string {
  const clean = (text || "").replace(MACHINE_ARTIFACT, "").replace(HTML_COMMENT, "").trim();
  const html = marked.parse(clean, { async: false, gfm: true }) as string;
  return html.replace(/<a\s+href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
}

const WRAP_STYLE: CSSProperties = {
  margin: "0 0 10px", padding: "12px", borderRadius: "10px",
  background: "rgba(23,107,88,.05)", border: "1px solid rgba(23,107,88,.18)",
  fontSize: "12px", lineHeight: "1.7", maxHeight: "420px", overflow: "auto",
};

/* 作用域表格/标题样式（GFM 表格是候选人列表的主体，无样式会挤成一团）。 */
const SCOPED_CSS = `
.openmai-md h2,.openmai-md h3{font-size:13px;margin:10px 0 6px;color:#215a4c}
.openmai-md p{margin:6px 0}
.openmai-md table{border-collapse:collapse;width:100%;margin:8px 0;font-size:11.5px}
.openmai-md th,.openmai-md td{border:1px solid rgba(23,107,88,.22);padding:5px 7px;text-align:left;vertical-align:top}
.openmai-md th{background:rgba(23,107,88,.1);white-space:nowrap}
.openmai-md a{color:#1a6b58;word-break:break-all}
.openmai-md strong{color:#173c33}
.openmai-md hr{border:none;border-top:1px solid rgba(23,107,88,.18);margin:10px 0}
`;

export function OpenmaiMarkdown({ text }: { text: string }): ReactElement {
  return createElement("div", { className: "openmai-md", style: WRAP_STYLE },
    createElement("style", null, SCOPED_CSS),
    createElement("div", { dangerouslySetInnerHTML: { __html: openmaiToHtml(text) } }));
}
