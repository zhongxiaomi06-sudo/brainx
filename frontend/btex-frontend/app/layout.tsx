import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import ErrorBoundary from "./error-boundary";
import "./globals.css";
import "./workbench-layout.css";
import "./engagement-loop.css";
import "./workbench-concept.css";

const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "B-tex · 职位决策工作台",
  description: "面向猎头顾问的职位优先级决策工作台前端原型",
  icons: { icon: "/favicon.svg" },
};

// 运行时错误探针：必须以内联经典脚本放在 body 最前，早于 deferred module 脚本执行，
// 才能捕获水合入口 chunk 404 / 动态 import 失败这类白屏事故特征。
// 上报走同源 /api/v1/meta/client-error（后端免登录聚合日志，不含业务数据）。
const MONITOR_SNIPPET = `(function(){
  if (window.__btexMon) return; window.__btexMon = 1;
  function report(kind, info) {
    try {
      var payload = JSON.stringify({
        kind: kind,
        message: String(info && info.message || '').slice(0, 500),
        source: String(info && info.source || '').slice(0, 300),
        line: Number(info && info.line) || 0,
        stack: String(info && info.stack || '').slice(0, 1000),
        url: location.pathname + location.search,
        chunk: /dynamically imported module|Loading chunk|ChunkLoadError/.test(String(info && info.message || ''))
      });
      navigator.sendBeacon('/api/v1/meta/client-error', new Blob([payload], { type: 'application/json' }));
    } catch (e) { /* 监控自身永不影响页面 */ }
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) {
      report('resource', { message: '资源加载失败: ' + (t.src || t.href), source: t.src || t.href });
    } else {
      report('error', { message: e.message, source: e.filename, line: e.lineno,
        stack: e.error && e.error.stack });
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('unhandledrejection', { message: (r && r.message) || String(r), stack: r && r.stack });
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      var len = ((document.body && document.body.innerText) || '').replace(/\\s+/g, '').length;
      if (len < 20) report('white-screen', { message: 'load 后正文为空（innerText=' + len + '），疑似白屏' });
    }, 3000);
  });
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={mono.variable}>
        <script dangerouslySetInnerHTML={{ __html: MONITOR_SNIPPET }} />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
