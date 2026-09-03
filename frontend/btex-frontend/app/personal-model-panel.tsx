"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, KeyRound, LoaderCircle, Power } from "lucide-react";
import {
  disablePersonalModelProfile, getPersonalModelProfile, savePersonalModelProfile,
  type PersonalModelProfile,
} from "./personal-model-api";
import "./personal-model-panel.css";

export function PersonalModelPanel({ initialProfile }: { initialProfile?: PersonalModelProfile }) {
  const [profile, setProfile] = useState<PersonalModelProfile | null>(initialProfile || null);
  const [provider, setProvider] = useState(initialProfile?.provider_id || initialProfile?.providers[0]?.id || "");
  const [model, setModel] = useState(initialProfile?.model_id || initialProfile?.providers[0]?.example_models[0] || "");
  const [apiKey, setApiKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selected = useMemo(() => profile?.providers.find((item) => item.id === provider), [profile, provider]);

  useEffect(() => {
    if (initialProfile) return;
    let active = true;
    void getPersonalModelProfile().then((next) => {
      if (!active) return;
      setProfile(next);
      setProvider(next.provider_id || next.providers[0]?.id || "");
      setModel(next.model_id || next.providers[0]?.example_models[0] || "");
    }).catch((error) => active && setMessage(error instanceof Error ? error.message : "读取失败"));
    return () => { active = false; };
  }, [initialProfile]);

  const changeProvider = (value: string) => {
    setProvider(value);
    setModel(profile?.providers.find((item) => item.id === value)?.example_models[0] || "");
  };
  const save = async () => {
    if (!profile || !provider || !model.trim() || !apiKey || !consent) return;
    setBusy(true); setMessage("");
    try {
      const next = await savePersonalModelProfile({
        provider_id: provider, model_id: model.trim(), api_key: apiKey,
        consent: true, consent_version: profile.consent_version,
      });
      setProfile(next); setApiKey(""); setConsent(false);
      setMessage("已保存。回到飞书私聊机器人即可使用这个模型。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请稍后重试");
    } finally { setBusy(false); }
  };
  const disable = async () => {
    if (!window.confirm("停用后，飞书个人 Agent 将不再调用这个模型。确定继续吗？")) return;
    setBusy(true); setMessage("");
    try {
      setProfile(await disablePersonalModelProfile());
      setMessage("个人模型已停用。你可以随时重新配置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "停用失败，请稍后重试");
    } finally { setBusy(false); }
  };

  if (!profile) return <div className="personal-model-loading"><LoaderCircle />{message || "正在读取个人 Agent…"}</div>;
  return <div className="personal-model-panel">
    <section className="personal-model-summary">
      <div className="personal-model-icon"><Bot /></div>
      <div><span>你的飞书私聊 Agent</span><h2>{profile.ready ? `${profile.provider_id} / ${profile.model_id}` : "尚未配置模型"}</h2>
        <p>每位顾问独立保存模型和密钥，其他人及群聊不会共用。</p></div>
      <span className={profile.ready ? "model-ready" : "model-waiting"}>
        {profile.ready ? <CheckCircle2 /> : <AlertTriangle />}{profile.ready ? "可使用" : "待配置"}
      </span>
    </section>
    {!profile.agent_ready && <div className="personal-model-notice"><AlertTriangle />先在飞书私聊“braintex的小机器人”发送任意消息，再回来刷新本页。</div>}
    <section className="personal-model-form" aria-label="个人模型配置">
      <label><span>模型供应商</span><select value={provider} onChange={(event) => changeProvider(event.target.value)} disabled={busy}>
        {profile.providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label><span>模型名称</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder={selected?.example_models[0] || "输入模型 ID"} disabled={busy} /></label>
      <label><span>API Key</span><div className="personal-model-key"><KeyRound /><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={profile.ready ? "输入新 Key 可替换当前配置" : "只会写入你的个人 Agent"} disabled={busy} /></div></label>
      <label className="personal-model-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /><span>我确认：与该 Agent 对话时，完成任务所需的脱敏业务内容会发送给所选模型供应商处理。</span></label>
      <div className="personal-model-actions"><button className="model-save" type="button" onClick={save} disabled={busy || !profile.agent_ready || !model.trim() || !apiKey || !consent}>{busy ? <LoaderCircle /> : <KeyRound />}{profile.ready ? "更新我的模型" : "保存并启用"}</button>
        {profile.status !== "UNCONFIGURED" && profile.status !== "DISABLED" && <button className="model-disable" type="button" onClick={disable} disabled={busy}><Power />停用</button>}</div>
      {message && <p className="personal-model-message" role="status">{message}</p>}
    </section>
    <p className="personal-model-footnote">密钥不会显示在页面、网址、聊天记录或 BrainX 业务数据库中。管理员只能看到配置状态。</p>
  </div>;
}
