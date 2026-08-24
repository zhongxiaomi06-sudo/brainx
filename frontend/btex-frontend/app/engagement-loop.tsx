"use client";

import { useEffect, useMemo, useState } from "react";
import { brainxFetch, fetchJobDetail, makeIdempotencyKey, type BackendProgressResponse } from "./brainx-api";
import { stateLabel, type CommitmentAction, type CommitmentSnapshot, type EngagementCommand, type EngagementState, type Outcome } from "./decision-demo";

type JobRef = { id:string; company:string; role:string; facts:Record<string,string>; eligibility?:string; brainxDecisionId?:string };
type Mode = "connecting"|"connected"|"offline";
type Editor = "accept"|"progress"|"blocked"|"terminal"|"release"|null;
type MembershipRelation = "MY_JOB"|"TEAM_SHARED";

const releaseReasons=["资源不足","优先级调整","转交其他顾问","客户/职位变化","当前无法投入","其他"];
const closeReasons=["职位关闭","HC 已满","客户暂停","需求取消","其他"];
const progressStages=["推荐采纳","面试","Offer","反馈"] as const;

function localDateTime(days=1){const d=new Date();d.setDate(d.getDate()+days);d.setHours(18,0,0,0);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}T18:00`}
function toInput(iso?:string|null){if(!iso)return localDateTime(1);const d=new Date(iso);if(Number.isNaN(d.getTime()))return localDateTime(1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}T${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`}
function toIso(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?"":d.toISOString()}
function dueError(value:string){const time=Date.parse(toIso(value));if(!Number.isFinite(time))return "请选择截止时间";if(time<=Date.now())return "截止时间必须晚于现在";if(time-Date.now()>90*86400000)return "截止时间需在未来 90 天内";return ""}
function formatAt(value?:string|null){if(!value)return "—";const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}
function fallbackAction(job:JobRef):CommitmentAction{return {actionId:`local-${job.id}`,title:job.facts["下一步动作"]||"确认下一步负责人、目标和反馈时间",dueAt:toIso(localDateTime(1)),status:"OPEN",source:"MANUAL",createdAt:new Date().toISOString()}}
function emptySnapshot(job:JobRef,state:EngagementState,outcomes:Outcome[]=[]):CommitmentSnapshot{const hasTerminal=outcomes.some(item=>item.stage==="入职"||item.stage==="关闭");return {goal:state==="ACCEPTED"?"推进本轮交付":null,activeAction:state==="ACCEPTED"?fallbackAction(job):null,actionHistory:[],suggestedAction:null,terminalResultMissing:state==="COMPLETED"&&!hasTerminal,terminalResult:null}}
function localSuggestion(job:JobRef,kind:"STAGE"|"BLOCKED",stage:string){const real=job.facts["下一步动作"];if(real)return {title:real,dueAt:toIso(localDateTime(1)),source:"MANUAL" as const,rule:"CURRENT_FACT_NEXT_ACTION"};if(kind==="BLOCKED")return {title:"解除阻塞并更新处理结果",dueAt:toIso(localDateTime(1)),source:"RULE" as const,rule:"BLOCKED_NEXT_DAY"};const map:Record<string,[string,number,string]>={"推荐采纳":["跟进客户反馈并确认面试转化",2,"RECOMMENDED_FOLLOW_UP"],"面试":["确认面试反馈和下一轮安排",2,"INTERVIEW_FOLLOW_UP"],"Offer":["确认 Offer 接受结果和入职计划",1,"OFFER_FOLLOW_UP"]};const [title,days,rule]=map[stage]||["确认下一步负责人、目标和反馈时间",1,"DEFAULT_NEXT_ACTION"];return {title,dueAt:toIso(localDateTime(days)),source:"RULE" as const,rule}}

export function CommitmentLoopPanel({job,state,outcomes,mode,legal,onCommand,onMembership,onVerify,onUpdated,notify}:{job:JobRef;state:EngagementState;outcomes:Outcome[];mode:Mode;legal:EngagementCommand[];onCommand:(command:EngagementCommand)=>void;onMembership:(relation:MembershipRelation)=>Promise<void>;onVerify:()=>void;onUpdated:()=>Promise<void>;notify:(text:string)=>void}){
 const storageKey=`brainx-commitment:${job.id}`;
 const [displayState,setDisplayState]=useState(state);
 const [snapshot,setSnapshot]=useState<CommitmentSnapshot>(()=>emptySnapshot(job,state,outcomes));
 const [editor,setEditor]=useState<Editor>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [goal,setGoal]=useState("");
 const [actionTitle,setActionTitle]=useState(job.facts["下一步动作"]||"");
 const [dueAt,setDueAt]=useState(localDateTime(1));
 const [summary,setSummary]=useState("");
 const [stage,setStage]=useState<typeof progressStages[number]>("推荐采纳");
 const [rating,setRating]=useState(4);
 const [nextTitle,setNextTitle]=useState("");
 const [nextDue,setNextDue]=useState(localDateTime(2));
 const [nextSource,setNextSource]=useState<"RULE"|"MANUAL">("RULE");
 const [step,setStep]=useState<1|2>(1);
 const [terminalStage,setTerminalStage]=useState<"入职"|"关闭">("入职");
 const [closeReason,setCloseReason]=useState(closeReasons[0]);
 const [releaseReason,setReleaseReason]=useState(releaseReasons[0]);
 const [membershipOpen,setMembershipOpen]=useState(false);
 const [membershipRelation,setMembershipRelation]=useState<MembershipRelation>("MY_JOB");

 const load=async()=>{if(mode==="connected"){const detail=await fetchJobDetail(job.id);setDisplayState(detail.engagementState);setSnapshot(detail.commitment);return}if(mode==="offline"&&typeof window!=="undefined"){try{const saved=JSON.parse(localStorage.getItem(storageKey)||"null");if(saved?.snapshot){const savedState=(saved.state||state) as EngagementState;const hasTerminal=!!saved.snapshot.terminalResult||outcomes.some(item=>item.stage==="入职"||item.stage==="关闭");setSnapshot({...saved.snapshot,terminalResult:saved.snapshot.terminalResult||null,terminalResultMissing:savedState==="COMPLETED"?!hasTerminal:!!saved.snapshot.terminalResultMissing});setDisplayState(savedState);return}}catch{}setSnapshot(emptySnapshot(job,state,outcomes));setDisplayState(state)}};
 useEffect(()=>{void load().catch(()=>setSnapshot(emptySnapshot(job,state,outcomes)))},[job.id,mode,state]);
 useEffect(()=>{if(mode!=="offline"||typeof window==="undefined")return;localStorage.setItem(storageKey,JSON.stringify({state:displayState,snapshot}))},[mode,storageKey,displayState,snapshot]);
 const dispatchLocal=(next:EngagementState)=>{setDisplayState(next);if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("brainx:commitment-updated",{detail:{jobId:job.id,state:next}}))};
 const refresh=async(message:string)=>{if(mode==="connected"){await load();await onUpdated()}notify(message);setEditor(null);setStep(1);setSummary("");setError("")};
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError("");try{await fn()}catch(e){setError(e instanceof Error?e.message:"操作失败，请稍后再试")}finally{setBusy(false)}};
 const overdue=!!snapshot.activeAction&&Date.parse(snapshot.activeAction.dueAt)<Date.now();
 const remaining=useMemo(()=>snapshot.activeAction?Math.ceil((Date.parse(snapshot.activeAction.dueAt)-Date.now())/86400000):0,[snapshot.activeAction]);
 const membershipNeedsConfirmation=["未加入","NOT_JOINED","待确认","UNKNOWN"].includes(job.facts["职位关系"]||"");
 const requiresFactVerification=job.eligibility==="VERIFY_REQUIRED";

 const submitMembership=()=>run(async()=>{await onMembership(membershipRelation);setMembershipOpen(false)});

 const submitAccept=()=>run(async()=>{if(!goal.trim()||!actionTitle.trim()){setError("请完整填写本轮目标和第一条行动");return}const invalid=dueError(dueAt);if(invalid){setError(invalid);return}if(mode==="connected"){await brainxFetch(`/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`,{method:"POST",body:{action:"ACCEPT",goal:goal.trim(),action_title:actionTitle.trim(),due_at:toIso(dueAt),idempotency_key:makeIdempotencyKey(`accept:${job.id}`)}});await refresh("已接单，第一条行动已建立");return}const action:CommitmentAction={actionId:`local-${Date.now()}`,title:actionTitle.trim(),dueAt:toIso(dueAt),status:"OPEN",source:"MANUAL",createdAt:new Date().toISOString()};setSnapshot({goal:goal.trim(),activeAction:action,actionHistory:[],suggestedAction:null,terminalResultMissing:false,terminalResult:null});dispatchLocal("ACCEPTED");notify("已接单");setEditor(null)});

 const buildSuggestion=()=>run(async()=>{if(!summary.trim()){setError("请先填写本次结果");return}let suggestion;if(mode==="connected"){const out=await brainxFetch<{suggestion:{title:string;due_at:string;source:"RULE"|"MANUAL"}}>(`/api/v1/opportunities/${encodeURIComponent(job.id)}/progress/suggestion`,{method:"POST",body:{kind:editor==="blocked"?"BLOCKED":"STAGE",stage}});suggestion={title:out.suggestion.title,dueAt:out.suggestion.due_at,source:out.suggestion.source}}else suggestion=localSuggestion(job,editor==="blocked"?"BLOCKED":"STAGE",stage);setNextTitle(suggestion.title);setNextDue(toInput(suggestion.dueAt));setNextSource(suggestion.source);setStep(2)});

 const submitProgress=()=>run(async()=>{const current=snapshot.activeAction;if(!current){setError("当前行动不存在，请刷新后重试");return}if(!nextTitle.trim()){setError("请确认下一行动");return}const invalid=dueError(nextDue);if(invalid){setError(invalid);return}const kind=editor==="blocked"?"BLOCKED":"STAGE";if(mode==="connected"){await brainxFetch<BackendProgressResponse>(`/api/v1/opportunities/${encodeURIComponent(job.id)}/progress`,{method:"POST",body:{action_id:current.actionId,kind,stage,summary:summary.trim(),rating,next_action:{title:nextTitle.trim(),due_at:toIso(nextDue),source:nextSource},decision_id:job.brainxDecisionId,idempotency_key:makeIdempotencyKey(`progress:${job.id}`)}});await refresh("进展已记录，并建立下一行动");return}const done={...current,status:"DONE" as const,completedAt:new Date().toISOString(),completionNote:summary.trim()};const next:CommitmentAction={actionId:`local-${Date.now()}`,title:nextTitle.trim(),dueAt:toIso(nextDue),status:kind==="BLOCKED"?"BLOCKED":"OPEN",source:nextSource,createdAt:new Date().toISOString()};setSnapshot(currentSnap=>({...currentSnap,activeAction:next,actionHistory:[done,...currentSnap.actionHistory],suggestedAction:null}));notify("进展已记录，并建立下一行动");setEditor(null);setStep(1);setSummary("")});

 const submitTerminal=()=>run(async()=>{if(!summary.trim()){setError("请填写终局摘要");return}if(mode==="connected"){await brainxFetch(`/api/v1/opportunities/${encodeURIComponent(job.id)}/terminal-result`,{method:"POST",body:{stage:terminalStage,summary:summary.trim(),close_reason:terminalStage==="关闭"?closeReason:undefined,decision_id:job.brainxDecisionId,idempotency_key:makeIdempotencyKey(`terminal:${job.id}`)}});await refresh(snapshot.terminalResultMissing?"终局结果已补录":"承接已完成，结果已归档");return}const at=new Date().toISOString();const current=snapshot.activeAction;const done=current?{...current,status:"DONE" as const,completedAt:at,completionNote:summary.trim()}:null;setSnapshot(s=>({...s,activeAction:null,actionHistory:done?[done,...s.actionHistory]:s.actionHistory,terminalResultMissing:false,terminalResult:{stage:terminalStage,summary:summary.trim(),at}}));dispatchLocal("COMPLETED");notify("终局结果已记录");setEditor(null)});

 const submitRelease=()=>run(async()=>{if(!summary.trim()){setError("请填写释放说明");return}if(mode==="connected"){await brainxFetch(`/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`,{method:"POST",body:{action:"RELEASE",reason:releaseReason,summary:summary.trim(),idempotency_key:makeIdempotencyKey(`release:${job.id}`)}});await refresh("承接已释放，当前行动已取消");return}const current=snapshot.activeAction;const cancelled=current?{...current,status:"CANCELLED" as const,completedAt:new Date().toISOString(),completionNote:`${releaseReason}：${summary.trim()}`}:null;setSnapshot(s=>({...s,activeAction:null,actionHistory:cancelled?[cancelled,...s.actionHistory]:s.actionHistory}));dispatchLocal("RELEASED");notify("承接已释放");setEditor(null)});

 const deadlineButtons=(set:(value:string)=>void)=><div className="commitment-deadline-options"><button type="button" onClick={()=>set(localDateTime(0))}>今天 18:00</button><button type="button" onClick={()=>set(localDateTime(1))}>明天 18:00</button><button type="button" onClick={()=>set(localDateTime(3))}>3 天后 18:00</button></div>;
 const timeline=[...(snapshot.terminalResult?[{id:`terminal-${snapshot.terminalResult.at}`,title:snapshot.terminalResult.stage,detail:snapshot.terminalResult.summary,at:snapshot.terminalResult.at}]:[]),...snapshot.actionHistory.map(a=>({id:a.actionId,title:a.status==="DONE"?"行动完成":"行动取消",detail:a.completionNote||a.title,at:a.completedAt||a.createdAt})),...outcomes.map(o=>({id:o.id,title:o.stage,detail:o.note==="结果已记录"?"":o.note||"",at:o.at}))].sort((a,b)=>String(b.at).localeCompare(String(a.at)));

 return <div className="commitment-loop">
  {membershipNeedsConfirmation&&<section className={`commitment-membership${membershipOpen?" editing":""}`}><div className="commitment-membership-head"><h2>确认项目归属</h2>{!membershipOpen&&<button className="primary" onClick={()=>setMembershipOpen(true)}>加入项目</button>}</div>{membershipOpen&&<div className="commitment-membership-form"><div className="commitment-membership-options"><button className={membershipRelation==="MY_JOB"?"selected":""} aria-pressed={membershipRelation==="MY_JOB"} onClick={()=>setMembershipRelation("MY_JOB")}><b>我的职位</b></button><button className={membershipRelation==="TEAM_SHARED"?"selected":""} aria-pressed={membershipRelation==="TEAM_SHARED"} onClick={()=>setMembershipRelation("TEAM_SHARED")}><b>团队共享</b></button></div><div className="commitment-membership-actions"><button onClick={()=>setMembershipOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={submitMembership}>{busy?"保存中…":"确认加入"}</button></div></div>}{error&&membershipOpen&&<p className="commitment-error">{error}</p>}</section>}

  {requiresFactVerification&&displayState!=="ACCEPTED"&&displayState!=="COMPLETED"?<section className="commitment-onboarding commitment-verification"><span>{stateLabel[displayState]}</span><h2>核验关键事实</h2><div className="commitment-command-row"><button className="primary" onClick={onVerify}>去核验</button></div></section>:null}

  {!membershipNeedsConfirmation&&!requiresFactVerification&&displayState!=="ACCEPTED"&&displayState!=="COMPLETED"?<section className="commitment-onboarding"><span>{stateLabel[displayState]}</span><h2>承接设置</h2><div className="commitment-command-row">{legal.includes("ACCEPT")&&<button className="primary" onClick={()=>setEditor("accept")}>接单并设定行动</button>}{legal.filter(a=>["WATCH","UNWATCH","DISMISS"].includes(a)).map(a=><button key={a} onClick={()=>onCommand(a)}>{a==="WATCH"?"加入关注":a==="UNWATCH"?"取消关注":"暂不考虑"}</button>)}{legal.length===0&&<button className="primary" onClick={onVerify}>查看并修正事实</button>}</div></section>:null}

  {displayState==="ACCEPTED"&&<><section className={`current-action-card${overdue?" overdue":snapshot.activeAction?.status==="BLOCKED"?" blocked":""}`}><div className="current-action-head"><span>当前行动</span><em>{snapshot.activeAction?snapshot.activeAction.status==="BLOCKED"?"阻塞中":overdue?`逾期 ${Math.abs(remaining)} 天`:remaining<=1?"今天需处理":`剩余 ${remaining} 天`:"待补建"}</em></div><p className="commitment-goal"><small>本轮目标</small>{snapshot.goal||"待补充"}</p><h2>{snapshot.activeAction?.title||"当前缺少行动"}</h2>{snapshot.activeAction?<time>截止 {formatAt(snapshot.activeAction.dueAt)}</time>:<button className="primary" onClick={()=>{setGoal(snapshot.goal||"继续当前承接");setEditor("accept")}}>补建当前行动</button>}</section>{snapshot.activeAction&&<div className="commitment-primary-actions"><button className="primary" onClick={()=>{setEditor("progress");setStep(1)}}>回写进展</button><button onClick={()=>{setEditor("blocked");setStep(1)}}>遇到阻塞</button><button onClick={()=>setEditor("terminal")}>终局结果</button><button className="quiet" onClick={()=>setEditor("release")}>释放承接</button></div>}</>}

  {displayState==="COMPLETED"&&snapshot.terminalResultMissing&&<section className="commitment-completed"><h2>待补录终局结果</h2><button className="primary" onClick={()=>setEditor("terminal")}>补录</button></section>}

  {editor&&<section className="commitment-editor">
   <div className="commitment-editor-head"><h2>{editor==="accept"?"建立承接":editor==="progress"?step===1?"填写本次结果":"确认下一行动":editor==="blocked"?step===1?"记录阻塞":"确认下一行动":editor==="terminal"?"记录终局结果":"释放承接"}</h2><button aria-label="关闭编辑" onClick={()=>{setEditor(null);setError("")}}>×</button></div>
   {editor==="accept"&&<div className="commitment-fields"><label>本轮目标<textarea value={goal} onChange={e=>setGoal(e.target.value)} placeholder="例如：两周内确认至少 2 位候选人的面试结果"/></label><label>第一条行动<input value={actionTitle} onChange={e=>setActionTitle(e.target.value)} placeholder="下一步具体做什么"/></label><label>截止时间<input type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)}/></label>{deadlineButtons(setDueAt)}<button className="primary" disabled={busy} onClick={submitAccept}>{busy?"保存中…":"确认接单并建立行动"}</button></div>}
   {(editor==="progress"||editor==="blocked")&&step===1&&<div className="commitment-fields"><label>本次结果<textarea value={summary} onChange={e=>setSummary(e.target.value)} placeholder={editor==="blocked"?"卡在哪里、已做过什么":"发生了什么、得到什么结论"}/></label>{editor==="progress"&&<><label>结果标签<select value={stage} onChange={e=>setStage(e.target.value as typeof stage)}>{progressStages.map(v=><option key={v}>{v}</option>)}</select></label><label>结果质量<input type="range" min="1" max="5" value={rating} onChange={e=>setRating(Number(e.target.value))}/><span>{rating} / 5</span></label></>}<button className="primary" disabled={busy} onClick={buildSuggestion}>{busy?"生成中…":"生成下一行动建议"}</button></div>}
   {(editor==="progress"||editor==="blocked")&&step===2&&<div className="commitment-fields"><label>下一行动<input value={nextTitle} onChange={e=>{setNextTitle(e.target.value);setNextSource("MANUAL")}}/></label><label>截止时间<input type="datetime-local" value={nextDue} onChange={e=>setNextDue(e.target.value)}/></label>{deadlineButtons(setNextDue)}<div className="commitment-editor-actions"><button onClick={()=>setStep(1)}>返回修改结果</button><button className="primary" disabled={busy} onClick={submitProgress}>{busy?"提交中…":"确认结果与下一行动"}</button></div></div>}
   {editor==="terminal"&&<div className="commitment-fields"><label>终局结果<select value={terminalStage} onChange={e=>setTerminalStage(e.target.value as "入职"|"关闭")}><option>入职</option><option>关闭</option></select></label>{terminalStage==="关闭"&&<label>关闭原因<select value={closeReason} onChange={e=>setCloseReason(e.target.value)}>{closeReasons.map(v=><option key={v}>{v}</option>)}</select></label>}<label>结果摘要<textarea value={summary} onChange={e=>setSummary(e.target.value)} placeholder="记录最终发生了什么，以及必要的上下文"/></label><button className="primary" disabled={busy} onClick={submitTerminal}>{busy?"提交中…":"确认终局并完成承接"}</button></div>}
   {editor==="release"&&<div className="commitment-fields"><label>释放原因<select value={releaseReason} onChange={e=>setReleaseReason(e.target.value)}>{releaseReasons.map(v=><option key={v}>{v}</option>)}</select></label><label>说明<textarea value={summary} onChange={e=>setSummary(e.target.value)} placeholder="为什么释放、后续由谁或何时再看"/></label><button className="danger" disabled={busy} onClick={submitRelease}>{busy?"提交中…":"确认释放并取消当前行动"}</button></div>}
   {error&&<p className="commitment-error">{error}</p>}
  </section>}

  <section className="commitment-timeline"><h2>行动与结果</h2>{timeline.length?timeline.map(item=><article key={`${item.id}-${item.at}`}><i/><div><b>{item.title}</b>{item.detail&&<p>{item.detail}</p>}</div><time>{formatAt(item.at)}</time></article>):<p className="muted">暂无记录</p>}</section>
 </div>
}
