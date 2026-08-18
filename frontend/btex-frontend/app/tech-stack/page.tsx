"use client";

import { techStackData } from "./data";
import "./tech-stack.css";

export default function TechStackPage() {
  const { updatedAt, layers, conclusion } = techStackData;
  return (
    <main className="ts-root">
      <div className="ts-wrap">
        <header className="ts-hero">
          <span className="ts-kicker">BRAINX · 技术选型</span>
          <h1>技术选型深度对比</h1>
          <p className="ts-sub">
            凭证层 · 接口层 · 编排层 —— 三层候选、真实数据与最终建议，可直接拍板。
          </p>
          <div className="ts-meta">
            <span>版本 v1</span>
            <span>更新于 {updatedAt}</span>
            <button className="ts-print" onClick={() => window.print()}>打印 / 存为 PDF</button>
          </div>
        </header>

        {layers.map((layer) => (
          <section className="ts-layer" key={layer.id}>
            <div className="ts-layer-head">
              <span className="ts-layer-no">{layer.no}</span>
              <div>
                <h2>{layer.title}</h2>
                <p>{layer.desc}</p>
              </div>
            </div>

            <div className="ts-table-scroll">
              <table className="ts-table">
                <thead>
                  <tr>
                    <th className="ts-dim">维度</th>
                    {layer.candidates.map((c) => (
                      <th key={c.name} className={c.recommended ? "ts-pick-col" : ""}>
                        {c.name}
                        {c.recommended && <em className="ts-pick-badge">推荐</em>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {layer.rows.map((row) => (
                    <tr key={row.label}>
                      <td className="ts-dim">{row.label}</td>
                      {row.cells.map((cell, i) => (
                        <td key={i} className={layer.candidates[i]?.recommended ? "ts-pick-col" : ""}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ts-advice">
              <span className="ts-advice-tag">我的建议</span>
              <p>{layer.advice}</p>
              {layer.redline && <p className="ts-redline">⚠️ 红线：{layer.redline}</p>}
            </div>
          </section>
        ))}

        <section className="ts-conclusion">
          <h2>最终选型结论（一句话拍板）</h2>
          <div className="ts-conc-grid">
            {conclusion.map((c) => (
              <div className="ts-conc-card" key={c.layer}>
                <span className="ts-conc-layer">{c.layer}</span>
                <b className="ts-conc-pick">{c.pick}</b>
                <p>{c.reason}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="ts-foot">
          <span>BrainX 职位决策 · 技术选型文档</span>
          <span>本页可直接分享 / 存档</span>
        </footer>
      </div>
    </main>
  );
}
