import Link from "next/link";
import { ArrowRight, Check, Download, ExternalLink, ShieldCheck } from "lucide-react";
import "./join.css";

const steps = [
  { index: "01", title: "进入 BrainX", detail: "从团队邀请链接打开这个入口，无需配置接口或复制 token。" },
  { index: "02", title: "使用飞书登录", detail: "在飞书官方页面确认身份和权限，再自动返回工作台。" },
  { index: "03", title: "连接找人来源", detail: "在连接中心检查 OpenMai、SuperMai 与 Reloop；需要个人登录时才打开官方页面。" },
];

export default function JoinPage() {
  return <main className="join-page">
    <nav className="join-nav" aria-label="入口导航">
      <Link className="join-brand" href="/"><span aria-hidden="true" />BrainTex</Link>
      <Link className="join-existing" href="/">已经登录？进入工作台 <ArrowRight /></Link>
    </nav>

    <section className="join-hero">
      <div className="join-hero-copy">
        <p className="join-eyebrow">BRANTEX WORKSPACE</p>
        <h1>一次登录，<br />把找人链路带进同一个工作台。</h1>
        <p className="join-lead">不用收集第三方账号密码，也不用让顾问理解接口。飞书负责 BrainX 身份，招聘平台登录留在各自的官方页面。</p>
        <div className="join-actions">
          <a className="join-primary" href="/api/v1/oauth/authorize">使用飞书进入 <ExternalLink /></a>
          <Link className="join-secondary" href="/">查看当前工作台</Link>
        </div>
        <p className="join-assurance"><ShieldCheck />BrainX 不接收招聘平台密码、验证码或浏览器 Cookie</p>
      </div>

      <div className="join-product-preview" aria-label="产品连接预览">
        <div className="join-preview-top"><span>连接中心</span><small>3 / 4 已就绪</small></div>
        <div className="join-preview-identity"><i>飞</i><div><b>飞书身份</b><small>当前 BrainX 登录</small></div><em><Check />已连接</em></div>
        <div className="join-preview-sources">
          <div><span>O</span><b>OpenMai</b><small>已连接</small></div>
          <div className="needs-action"><span>S</span><b>SuperMai</b><small>等待平台登录</small></div>
          <div><span>R</span><b>Reloop</b><small>组织已连接</small></div>
        </div>
        <div className="join-preview-note"><Download /><span><b>桌面能力按需启用</b><small>当前最小版本复用已安装的 SuperMai；正式安装包将在体验验证后提供。</small></span></div>
      </div>
    </section>

    <section className="join-steps" aria-labelledby="join-steps-title">
      <header><p>FIRST RUN</p><h2 id="join-steps-title">第一次进入，只走三步</h2></header>
      <div>{steps.map(step => <article key={step.index}><span>{step.index}</span><h3>{step.title}</h3><p>{step.detail}</p></article>)}</div>
    </section>
  </main>;
}
