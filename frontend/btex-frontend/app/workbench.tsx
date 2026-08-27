"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowLeft, BarChart3, Bell, BriefcaseBusiness,
  Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Database, Filter,
  MoreHorizontal, Plus, Search, Settings2,
  BellRing, CheckCircle2, CircleUserRound, ClipboardCheck, Send, ShieldCheck, SlidersHorizontal, Sparkles, Users, X, Zap,
} from "lucide-react";
import { actionLabel, seedAuth, seedNotifications, seedSync, stateLabel, type AuthStatus, type DecisionEvent, type EngagementCommand, type EngagementState, type Notification, type Outcome, type SyncStatus } from "./decision-demo";
import {
  FALLBACK_DISMISS_REASONS, BrainxApiError, brainxFetch, connectSSE, fetchJobDetail,
  getSnapshot, makeIdempotencyKey, mapReplayData, getRadar,
  getClients, getTalentSupply, updateWorkbenchPreferences, sendRecommendationFeedback,
  undoRecommendationFeedback, updateOpportunityMembership, rerunOpenmai,
  type TalentSupplySnapshot, type BackendConsultants, type BackendEngagementResponse,
  type BackendOutcomeResponse, type BackendRecommendationRun, type BackendReplay,
  type BackendSessionStatus, type BrainxReplay, type BrainxSnapshot, type OpenmaiResult,
  type BackendClientRow, type RadarPayload,
} from "./brainx-api";
import { streamAssistant, type AssistantMessage } from "./brainx-assistant-api";
import { actionSeed, clients, decisionGroupMeta, decisionJobs, DEFAULT_FOLDERS, engagementPrerequisite, events, initialEngagement, initialEvents, initialOutcomes, INITIAL_TRAY_IDS, legalActions, nextState, readSavedWorkbenchState, stateEvent, verificationJobs, type DecisionAction, type DecisionGroup, type DecisionJob, type MembershipRelation, type Page, type Panel, type PickFolder, type SourceMode } from "./workbench-model";
import { DirectGlassSegment, DrawerSection, FilterSelect, Heading, StatusTag, type FilterSelectOption } from "./workbench-controls";
import { ManualFactSection } from "./workbench-facts";
import { Rules } from "./workbench-rules";
import { CommitmentLoopPanel } from "./engagement-loop";
import Sources from "./workbench-sources";
import { WorkspaceEntry, type WorkspaceEntryKind } from "./workbench-entry";
import { TodayDecisionQueue } from "./workbench-today";
import { WorkbenchClientsPage, WorkbenchJobsPage } from "./workbench-fact-pages";
import { WorkspaceShell, type WorkspaceShellPage } from "./workspace-shell";
import { WorkbenchSettingsPage } from "./workbench-settings-page";


export default function DecisionWorkbench({demo=false}:{demo?:boolean}={}){
 const [hydrated,setHydrated]=useState(false);
 const [page,setPage]=useState<Page>("today");
 const [query,setQuery]=useState("");
 const [drawer,setDrawer]=useState<string|null>(null);
 const [toast,setToast]=useState<{text:string;actions?:{label:string;onClick:()=>void}[];input?:{placeholder:string;onSubmit:(text:string)=>void}}|null>(null);
 const toastInputRef=useRef<HTMLInputElement>(null);
 const toastTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [done,setDone]=useState<number[]>([]);
 const [snoozed,setSnoozed]=useState<number[]>([]);
 const [extraTasks,setExtraTasks]=useState<string[]>([]);
 const [weights,setWeights]=useState([60,25,15]);
 const [tray,setTray]=useState<string[]>([]);
 const [folders,setFolders]=useState<PickFolder[]>(DEFAULT_FOLDERS);
 const [folderMode,setFolderMode]=useState(false);
 const [panel,setPanel]=useState<Panel>(null);
 const [panelMotion,setPanelMotion]=useState<"idle"|"entering"|"open"|"closing">("idle");
 const panelAnimationFrame=useRef<number|null>(null);
 const panelCloseTimer=useRef<number|null>(null);
 const [decisionActions,setDecisionActions]=useState<string[]>([]);
 const [membershipRelations,setMembershipRelations]=useState<Record<string,MembershipRelation>>({});
 const [engagement,setEngagement]=useState<Record<string,EngagementState>>(initialEngagement);
 const [decisionEvents,setDecisionEvents]=useState<Record<string,DecisionEvent[]>>(initialEvents);
 const [outcomes,setOutcomes]=useState<Record<string,Outcome[]>>(initialOutcomes);
 const [openmaiByJob,setOpenmaiByJob]=useState<Record<string,OpenmaiResult|null>>({});
 const [sync,setSync]=useState<SyncStatus>(seedSync);
 const [auth,setAuth]=useState<AuthStatus>(seedAuth);
 const [notifications,setNotifications]=useState<Notification[]>(seedNotifications);
 const [pendingCommand,setPendingCommand]=useState<{job:DecisionJob;command:EngagementCommand}|null>(null);
 // Brain X 后端连接态：connecting（探测中）→ connected（API 驱动）/ offline（真实数据不可用）；演示数据仅由 demo 属性显式开启
 const [brainxMode,setBrainxMode]=useState<"connecting"|"connected"|"offline">("connecting");
 const [workspaceIssue,setWorkspaceIssue]=useState<Exclude<WorkspaceEntryKind,"connecting">|null>(null);
 const [connectAttempt,setConnectAttempt]=useState(0);
 const [assistantOpen,setAssistantOpen]=useState(false);
 const [assistantMessages,setAssistantMessages]=useState<AssistantMessage[]>([]);
 const [assistantInput,setAssistantInput]=useState("");
 const [assistantBusy,setAssistantBusy]=useState(false);
 const [assistantSettings,setAssistantSettings]=useState(false);
 const assistantAbort=useRef<AbortController|null>(null);
 const [brainxJobs,setBrainxJobs]=useState<DecisionJob[]|null>(null);
 const [brainxConsultantId,setBrainxConsultantId]=useState("");
 const [brainxRun,setBrainxRun]=useState<{snapshotId:string|null;policyVersion:string|null}>({snapshotId:null,policyVersion:null});
 const [brainxDismissReasons,setBrainxDismissReasons]=useState<string[]>(FALLBACK_DISMISS_REASONS);
 const [brainxReplay,setBrainxReplay]=useState<Record<string,BrainxReplay>>({});
 const [brainxKeywords,setBrainxKeywords]=useState<string[]>([]);
 const [brainxNote,setBrainxNote]=useState("");
 const [brainxRadar,setBrainxRadar]=useState<RadarPayload|null>(null);
 const [brainxClients,setBrainxClients]=useState<BackendClientRow[]|null>(null);
 const [jobCompanyFilter,setJobCompanyFilter]=useState<string|null>(null);
 const feedbackJob=(job:DecisionJob)=>{const doDelete=async(reason:string)=>{const clean=(reason||"").trim().slice(0,200);const snapshot=brainxJobs;try{if(brainxMode==="connected"){await sendRecommendationFeedback(job.id,clean,brainxRun.snapshotId,makeIdempotencyKey(`recommendation-feedback:${job.id}`))}setBrainxJobs(current=>current?current.filter(item=>item.id!==job.id):current);notify(brainxMode==="connected"?"已减少此类推荐":"演示模式已隐藏该职位（不会写入后端）",{actions:[{label:"撤销",onClick:()=>{setBrainxJobs(snapshot);if(brainxMode==="connected")void undoRecommendationFeedback(job.id).then(()=>notify("已撤销不感兴趣")).catch(error=>notify(`撤销已恢复本地显示，但后端删除失败：${error instanceof Error?error.message:"后端未响应"}`,undefined,4000));if(brainxMode!=="connected")notify("已撤销不感兴趣")}}]})}catch(error){notify(`反馈失败：${error instanceof Error?error.message:"后端未响应"}`)}};notify(`为什么删除「${job.company} · ${job.role}」？（必填）`,{input:{placeholder:"例如：方向不符 / 客户质量不足 / 当前没精力…",onSubmit:(text)=>{void doDelete(text)}}})};
 const loadBrainxSide=useRef(async()=>{await Promise.allSettled([
  getRadar().then(radar=>setBrainxRadar(radar)),
  getClients().then(clientsData=>setBrainxClients(clientsData.items)),
 ])});
 const brainxApply=useRef((snapshot:BrainxSnapshot)=>{setBrainxJobs(snapshot.jobs as DecisionJob[]);setBrainxConsultantId(snapshot.consultantId);setEngagement(snapshot.engagement);setOpenmaiByJob(snapshot.openmai||{});setDecisionEvents(snapshot.events);setOutcomes(snapshot.outcomes);setSync(snapshot.sync);setAuth(snapshot.auth);setNotifications(snapshot.notifications);setBrainxDismissReasons(snapshot.dismissReasons);setBrainxRun({snapshotId:snapshot.snapshotId,policyVersion:snapshot.policyVersion});setBrainxKeywords(snapshot.profileKeywords);setTray(snapshot.preferences.tray);setFolders(snapshot.preferences.folders.length?snapshot.preferences.folders:DEFAULT_FOLDERS);setFolderMode(!!snapshot.preferences.folderMode);setBrainxMode("connected")});
 const loadBrainxSnapshot=useRef(async()=>{const snapshot=await getSnapshot();brainxApply.current(snapshot)});
 useEffect(()=>{const savedState=readSavedWorkbenchState();setDone(savedState.done||[]);setSnoozed(savedState.snoozed||[]);setExtraTasks(savedState.extraTasks||[]);setWeights(savedState.weights?.length===3?savedState.weights:[60,25,15]);setDecisionActions(savedState.decisionActions||[]);setMembershipRelations(savedState.membershipRelations||{});setTray(savedState.tray??INITIAL_TRAY_IDS);setFolders(savedState.folders?.length?savedState.folders:DEFAULT_FOLDERS);setFolderMode(!!savedState.folderMode);setEngagement({...initialEngagement,...(savedState.engagement||{})});setDecisionEvents({...initialEvents,...(savedState.events||{})});setOutcomes({...initialOutcomes,...(savedState.outcomes||{})});setSync(savedState.sync||seedSync);setAuth(savedState.auth||seedAuth);setNotifications(savedState.notifications||seedNotifications);setHydrated(true)},[]);
 useEffect(()=>{const update=(event:Event)=>{const detail=(event as CustomEvent<{jobId:string;state:EngagementState}>).detail;if(detail?.jobId&&detail?.state)setEngagement(current=>({...current,[detail.jobId]:detail.state}))};window.addEventListener("brainx:commitment-updated",update);return()=>window.removeEventListener("brainx:commitment-updated",update)},[]);
 useEffect(()=>{if(!hydrated)return;if(brainxMode==="connected"){localStorage.setItem("decision-workbench",JSON.stringify({tray,folders,folderMode,weights,decisionActions,membershipRelations}));void updateWorkbenchPreferences({tray,folders,folderMode}).catch(()=>{});return}localStorage.setItem("decision-workbench",JSON.stringify({done,snoozed,extraTasks,weights,decisionActions,membershipRelations,tray,folders,folderMode,engagement,events:decisionEvents,outcomes,sync,auth,notifications}))},[hydrated,brainxMode,done,snoozed,extraTasks,weights,decisionActions,membershipRelations,tray,folders,folderMode,engagement,decisionEvents,outcomes,sync,auth,notifications]);
 // 正式工作台不再把演示数据作为失败回退；演示态只能由 Storybook 显式开启。
 useEffect(()=>{
  if(!hydrated)return;
  if(demo){setWorkspaceIssue(null);setBrainxMode("offline");return}
  let cancelled=false;
  setBrainxMode("connecting");
  setWorkspaceIssue(null);
  void(async()=>{try{
   await brainxFetch<BackendSessionStatus>("/api/v1/oauth/status");
   const snapshot=await getSnapshot();
   if(!cancelled)brainxApply.current(snapshot);
   void loadBrainxSide.current();
  }catch(error){
   if(cancelled)return;
   setBrainxMode("offline");
   setWorkspaceIssue(error instanceof BrainxApiError&&error.kind==="AUTH"?"auth":"unavailable");
  }})();
  return()=>{cancelled=true};
 },[hydrated,demo,connectAttempt]);
 // SSE 实时通知：同步/推荐事件 → 去抖刷新快照并插入提醒；组件卸载关闭连接
 useEffect(()=>{if(brainxMode!=="connected")return;const sub=connectSSE(event=>{if(!event.type||event.type==="hello")return;if(event.type==="openmai_result"){const pid=String((event as {project_id?:string}).project_id||"");setNotifications(current=>[{id:`sse-om-${Date.now()}`,kind:"SYNC_ALERT",title:(event as {status?:string}).status==="done"?"自动找人完成":"自动找人失败",detail:pid,read:false},...current]);if(pid)window.setTimeout(()=>{void fetchJobDetail(pid).then(d=>setOpenmaiByJob(current=>({...current,[pid]:d.openmai}))).catch(()=>{})},600);return}const title=event.type==="sync_error"?"同步异常":event.type==="recommend"?"推荐已更新":"同步完成";setNotifications(current=>[{id:`sse-${Date.now()}`,kind:"SYNC_ALERT",title,detail:String(event.message||""),read:false},...current]);window.setTimeout(()=>{void loadBrainxSnapshot.current().catch(()=>{});void loadBrainxSide.current()},800)});return()=>sub.close()},[brainxMode]);
 const notify=(s:string,opts?:{actions?:{label:string;onClick:()=>void}[];input?:{placeholder:string;onSubmit:(text:string)=>void}},ms?:number)=>{if(toastTimerRef.current){clearTimeout(toastTimerRef.current);toastTimerRef.current=null}setToast({text:s,actions:opts?.actions,input:opts?.input});if(!opts?.input)toastTimerRef.current=setTimeout(()=>{setToast(null);toastTimerRef.current=null},ms??(opts?.actions?.length?6000:2200))};
 const visibleActions=actionSeed.map((a,i)=>({a,i})).filter(x=>!done.includes(x.i)&&!snoozed.includes(x.i));
 const clearPanelMotion=()=>{if(typeof window==="undefined")return;if(panelAnimationFrame.current!==null){window.cancelAnimationFrame(panelAnimationFrame.current);panelAnimationFrame.current=null}if(panelCloseTimer.current!==null){window.clearTimeout(panelCloseTimer.current);panelCloseTimer.current=null}};
 const dismissPanelImmediately=()=>{clearPanelMotion();setPanel(null);setPanelMotion("idle")};
 const openPanel=(next:Panel)=>{if(!next)return;clearPanelMotion();if(panel&&panelMotion==="open"){setPanel(next);return}const animate=typeof window!=="undefined"&&window.matchMedia("(min-width: 961px)").matches;if(panelMotion==="closing"){setPanel(next);setPanelMotion("open");return}setPanel(next);if(!animate){setPanelMotion("open");return}setPanelMotion("entering");panelAnimationFrame.current=window.requestAnimationFrame(()=>{panelAnimationFrame.current=window.requestAnimationFrame(()=>{setPanelMotion("open");panelAnimationFrame.current=null})})};
 const closePanel=()=>{if(!panel)return;clearPanelMotion();const animate=typeof window!=="undefined"&&window.matchMedia("(min-width: 961px)").matches;if(!animate){dismissPanelImmediately();return}setPanelMotion("closing");panelCloseTimer.current=window.setTimeout(()=>{setPanel(null);setPanelMotion("idle");panelCloseTimer.current=null},380)};
 useEffect(()=>{const closeOnEscape=(event:KeyboardEvent)=>{if(event.key!=="Escape")return;closePanel();setPendingCommand(null);setDrawer(null)};window.addEventListener("keydown",closeOnEscape);return()=>window.removeEventListener("keydown",closeOnEscape)},[panel,panelMotion]);
 useEffect(()=>()=>clearPanelMotion(),[]);
 const go=(p:Page)=>{setPage(p);dismissPanelImmediately();setDrawer(null)};
 useEffect(()=>{try{const saved=localStorage.getItem("brainx-assistant-history");if(saved)setAssistantMessages(JSON.parse(saved))}catch{}},[]);
 useEffect(()=>{try{localStorage.setItem("brainx-assistant-history",JSON.stringify(assistantMessages.slice(-40)))}catch{}},[assistantMessages]);
 useEffect(()=>()=>assistantAbort.current?.abort(),[]);
 const sendAssistant=()=>{const question=assistantInput.trim();if(!question||assistantBusy)return;const user:AssistantMessage={role:"user",content:question};const controller=new AbortController();assistantAbort.current=controller;setAssistantInput("");setAssistantBusy(true);setAssistantMessages(current=>[...current,user,{role:"assistant",content:""}]);void streamAssistant({question,history:assistantMessages.slice(-12),context:{page,opportunity_id:selectedDecisionJob?.id||null},signal:controller.signal},text=>setAssistantMessages(current=>{const next=[...current];const last=next.length-1;if(last>=0&&next[last].role==="assistant")next[last]={...next[last],content:next[last].content+text};return next}),message=>setAssistantMessages(current=>{const next=[...current];const last=next.length-1;if(last>=0&&next[last].role==="assistant")next[last]={...next[last],content:message};return next})).catch(error=>{if(error?.name!=="AbortError")setAssistantMessages(current=>{const next=[...current];const last=next.length-1;if(last>=0&&next[last].role==="assistant")next[last]={...next[last],content:`助手暂不可用：${error instanceof Error?error.message:"后端未响应"}`};return next})}).finally(()=>{assistantAbort.current=null;setAssistantBusy(false)})};
 const runDecisionAction=(job:DecisionJob,action:DecisionAction)=>{const key=`${job.id}:${action.id}`;if(decisionActions.includes(key))return;const at=new Date().toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});setDecisionActions(v=>[...v,key]);setDecisionEvents(current=>({...current,[job.id]:[{id:`evt-${Date.now()}`,type:action.label,at,reason:action.detail},...(current[job.id]||[])]}));if(action.kind==="verify")window.dispatchEvent(new CustomEvent("brainx:edit-facts",{detail:job.id}));notify(`已记录：${action.label}`)};
 const toggleTray=(id:string)=>{setTray(current=>{const next=current.includes(id)?current.filter(x=>x!==id):[...current,id];notify(next.includes(id)?"已加入精选盘":"已移出精选盘");return next})};
 const removeTray=(id:string)=>{setTray(current=>current.filter(x=>x!==id));notify("已移出精选盘")};
 const assignFolder=(jobId:string,folderId:string)=>{setFolders(current=>current.map(f=>f.id===folderId?{...f,jobIds:Array.from(new Set([...f.jobIds,jobId]))}:{...f,jobIds:f.jobIds.filter(x=>x!==jobId)}));setTray(current=>current.filter(x=>x!==jobId));notify(folderId?"已放入文件夹":"已从文件夹移除")};
 const createFolder=(name:string)=>{const trimmed=name.trim();if(!trimmed)return;setFolders(current=>[...current,{id:`f-${Date.now()}`,name:trimmed,jobIds:[]}]);notify(`已新建文件夹「${trimmed}」`)};
 const confirmTray=async()=>{const jobs=activeDecisionJobs.filter(job=>tray.includes(job.id)&&(engagement[job.id]||"NEW")!=="ACCEPTED");if(!jobs.length){notify("盘里的职位都已接单");return}let done=0;const failReasons:string[]=[];const acceptedIds:string[]=[];let lastAcceptedId:string|null=null;for(const job of jobs){const state=engagement[job.id]||"NEW";const legal=legalActions(job,state);if(!legal.includes("ACCEPT")&&!legal.includes("WATCH")){failReasons.push(`${job.company}：需先完成核验`);continue}if(brainxMode!=="connected"){if(legal.includes("WATCH"))applyCommand(job,"WATCH");applyCommand(job,"ACCEPT");done++;lastAcceptedId=job.id;continue}try{const url=`/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`;if(legal.includes("WATCH"))await brainxFetch<BackendEngagementResponse>(url,{method:"POST",body:{action:"WATCH",idempotency_key:makeIdempotencyKey(`tray-watch:${job.id}`)}});const res=await brainxFetch<BackendEngagementResponse>(url,{method:"POST",body:{action:"ACCEPT",confirm:true,idempotency_key:makeIdempotencyKey(`tray-accept:${job.id}`)}});setEngagement(current=>({...current,[job.id]:res.state}));setTray(current=>current.filter(x=>x!==job.id));done++;lastAcceptedId=job.id;acceptedIds.push(job.id)}catch(error){const msg=error instanceof Error?error.message:"后端未响应";failReasons.push(`${job.company}：${msg}`)}}
  if(done){notify(`已接单 ${done} 个职位`);const acc=lastAcceptedId?activeDecisionJobs.find(j=>j.id===lastAcceptedId):null;if(acc)openDecision(acc,"engagement")}
  if(acceptedIds.length)await Promise.all(acceptedIds.map(id=>refreshBrainxJob(id).catch(()=>{})));
  if(failReasons.length)notify(`未能接单：${failReasons.slice(0,2).join("；")}${failReasons.length>2?" 等":""}`)};
 const activeDecisionJobs=useMemo(()=>(brainxJobs??(demo?decisionJobs:[])).map(job=>{const relation=membershipRelations[job.id];if(!relation)return job;return {...job,facts:{...job.facts,"职位关系":relation==="MY_JOB"?"我的职位":"团队共享"}}}),[brainxJobs,demo,membershipRelations]);
 const confirmJobMembership=async(job:DecisionJob,relation:MembershipRelation)=>{if(brainxMode==="connected"){await updateOpportunityMembership(job.id,relation,makeIdempotencyKey(`membership:${job.id}`));await loadBrainxSnapshot.current()}else{setMembershipRelations(current=>({...current,[job.id]:relation}));const at=new Date().toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});setDecisionEvents(current=>({...current,[job.id]:[{id:`evt-${Date.now()}`,type:"确认项目归属",at,reason:relation==="MY_JOB"?"我的职位":"团队共享"},...(current[job.id]||[])]}))}notify(`${job.company} · 已加入${relation==="MY_JOB"?"我的职位":"团队共享"}`)};
 const refreshBrainxJob=async(jobId:string)=>{if(brainxMode!=="connected")return;try{const detail=await fetchJobDetail(jobId);setEngagement(current=>({...current,[jobId]:detail.engagementState}));setDecisionEvents(current=>({...current,[jobId]:detail.events}));setOutcomes(current=>({...current,[jobId]:detail.outcomes}));setOpenmaiByJob(current=>({...current,[jobId]:detail.openmai}));setBrainxJobs(current=>current?current.map(job=>job.id===jobId?{...job,brainxLegal:detail.legal,brainxDecisionId:detail.decisionId||job.brainxDecisionId}:job):null)}catch{/* 详情刷新失败不打断交互，下次打开再试 */}};
 const rerunOpenmaiForJob=(jobId:string)=>{void(async()=>{try{await rerunOpenmai(jobId);const detail=await fetchJobDetail(jobId);setOpenmaiByJob(current=>({...current,[jobId]:detail.openmai}))}catch(error){notify(`重新找人失败：${error instanceof Error?error.message:"后端未响应"}`)}})()};
 const openDecision=(job:DecisionJob,tab:"judgement"|"engagement"|"trail"|"replay"="judgement")=>{if(panel?.kind==="job"&&panel.jobId===job.id&&panel.tab===tab&&panelMotion!=="closing"){closePanel();return}if(brainxMode==="connected")void brainxFetch<BackendEngagementResponse>(`/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`,{method:"POST",body:{action:"VIEW",idempotency_key:makeIdempotencyKey(`view:${job.id}`)}}).catch(()=>{});openPanel({kind:"job",jobId:job.id,tab})};
 const applyCommand=(job:DecisionJob,command:EngagementCommand,reason?:string)=>{if(brainxMode!=="connected"){const state=nextState(command);setEngagement(current=>({...current,[job.id]:state}));setDecisionEvents(current=>({...current,[job.id]:[{id:`evt-${Date.now()}`,type:stateEvent(command),at:new Date().toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}),reason},...(current[job.id]||[])]}));setPendingCommand(null);notify(`${job.company} · ${stateEvent(command)}`);return}const key=makeIdempotencyKey(`engage:${job.id}:${command}`);setPendingCommand(null);void(async()=>{try{const res=await brainxFetch<BackendEngagementResponse>(`/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`,{method:"POST",body:{action:command,confirm:command==="ACCEPT",reason,idempotency_key:key}});setEngagement(current=>({...current,[job.id]:res.state}));await refreshBrainxJob(job.id);notify(`${job.company} · ${stateEvent(command)}`)}catch(error){notify(`操作失败：${error instanceof Error?error.message:"后端未响应"}`)}})()};
 const requestCommand=(job:DecisionJob,command:EngagementCommand)=>{if(command==="ACCEPT"||command==="DISMISS"){setPendingCommand({job,command});return}applyCommand(job,command)};
 const recordOutcome=(job:DecisionJob,stage:Outcome["stage"],rating?:number,note?:string)=>{if(brainxMode!=="connected"){const item:Outcome={id:`out-${Date.now()}`,stage,rating,note,at:new Date().toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})};setOutcomes(current=>({...current,[job.id]:[item,...(current[job.id]||[])]}));setDecisionEvents(current=>({...current,[job.id]:[{id:`evt-${Date.now()}`,type:"记录结果",at:item.at,reason:stage},...(current[job.id]||[])]}));notify(`已记录${stage}`);return}void(async()=>{try{await brainxFetch<BackendOutcomeResponse>("/api/v1/outcomes",{method:"POST",body:{project_id:job.id,stage,value:{rating,note},idempotency_key:makeIdempotencyKey(`outcome:${job.id}`)}});await refreshBrainxJob(job.id);notify(`已记录${stage}`)}catch(error){notify(`记录失败：${error instanceof Error?error.message:"后端未响应"}`)}})()};
 const runSync=()=>{void(async()=>{if(brainxMode!=="connected"){setSync(current=>({...current,state:"RUNNING",errors:[]}));notify("正在生成演示快照…");window.setTimeout(()=>{setSync({...seedSync,updatedAt:new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})});notify("快照已更新，推荐已刷新")},650);return}setSync(current=>({...current,state:"RUNNING",errors:[]}));notify("正在同步后端快照…");try{await brainxFetch("/api/v1/sync-runs",{method:"POST",body:{source:"fixture"}});const rec=await brainxFetch<BackendRecommendationRun>("/api/v1/recommendations/run",{method:"POST"});if(rec?.blocked){setSync(current=>({...current,state:"INCOMPLETE",errors:[rec.reason||"本次同步不完整"]}));notify(rec.reason||"本次同步不完整");return}await loadBrainxSnapshot.current();void loadBrainxSide.current();notify("快照已更新，推荐已刷新")}catch(error){setSync(current=>({...current,state:"ERROR",errors:[error instanceof Error?error.message:"同步失败"]}));notify(`同步失败：${error instanceof Error?error.message:"后端未响应"}`)}})()};
 const openNotification=(item:Notification)=>{setNotifications(current=>current.map(note=>note.id===item.id?{...note,read:true}:note));if(item.jobId){const job=activeDecisionJobs.find(entry=>entry.id===item.jobId);if(job)openDecision(job,item.kind==="DAILY_TOP3"?"replay":"engagement")}else openPanel({kind:"sync"})};
 const selectedDecisionJob=panel?.kind==="job"?[...activeDecisionJobs,...verificationJobs].find(job=>job.id===panel.jobId)||null:null;
 const commitmentJobs=activeDecisionJobs.filter(job=>["WATCHED","ACCEPTED"].includes(engagement[job.id]||"NEW"));
 const acceptedJobs=activeDecisionJobs.filter(job=>engagement[job.id]==="ACCEPTED");
 const visibleAcceptedJobs=useMemo(()=>{
  const keyword=query.trim().toLocaleLowerCase();
  if(!keyword)return acceptedJobs;
  return acceptedJobs.filter(job=>`${job.company} ${job.role} ${job.recentSignal} ${Object.values(job.facts).join(" ")}`.toLocaleLowerCase().includes(keyword));
 },[acceptedJobs,query]);
 const shellPage:WorkspaceShellPage=page==="accepted"?"projects":page==="clients"?"clients":page==="jobs"?"jobs":page==="today"?"today":"settings";
 const navigateShell=(next:WorkspaceShellPage)=>{if(next==="jobs")setJobCompanyFilter(null);if(next==="settings")setAssistantOpen(false);go(next==="projects"?"accepted":next==="settings"?"settings":next)};
 return <div className="btex-app formal-workbench">
  {page==="settings"?<WorkbenchSettingsPage auth={auth} consultantId={brainxConsultantId||auth.consultant} keywords={brainxKeywords} note={brainxNote} policyVersion={brainxRun.policyVersion} sync={sync} fieldReport={brainxRadar?.fieldReport??null} onBack={()=>go("today")} onOpenConnections={()=>go("sources")} onRefresh={()=>{void loadBrainxSnapshot.current();void loadBrainxSide.current();notify("正在刷新同步诊断")}} notify={notify} />:<>
  <WorkspaceShell activePage={shellPage} onNavigate={navigateShell} consultant={auth.consultant} assistantOpen={assistantOpen} onAssistantToggle={()=>setAssistantOpen(value=>!value)} assistantPlacement="overlay">
   {["today","accepted","jobs","clients"].includes(page)&&(brainxMode==="connecting"||workspaceIssue)?
    <WorkspaceEntry kind={brainxMode==="connecting"?"connecting":workspaceIssue!} onRetry={()=>setConnectAttempt(value=>value+1)} onOpenSources={()=>go("sources")} />:<>
    {page==="today"&&<TodayDecisionQueue activeJobId={panel?.kind==="job"&&panelMotion!=="closing"?panel.jobId:null} completed={decisionActions} jobs={activeDecisionJobs} engagement={engagement} sync={sync} open={openDecision} onAction={runDecisionAction} onFeedback={feedbackJob} showVerification={demo} tray={tray} onToggleTray={toggleTray} onRemoveTray={removeTray} onConfirmTray={confirmTray} folders={folders} folderMode={folderMode} onFolderMode={()=>setFolderMode(value=>!value)} onAssignFolder={assignFolder} onCreateFolder={createFolder} mode={brainxMode} onOpenSources={()=>go("sources")} />}
    {page==="accepted"&&<AcceptedJobsView jobs={visibleAcceptedJobs} total={acceptedJobs.length} query={query} open={openDecision} />}
    {page==="jobs"&&<WorkbenchJobsPage items={brainxRadar?.items??[]} capabilities={brainxRadar?.fieldCapabilities??[]} company={jobCompanyFilter} />}
   {page==="clients"&&<WorkbenchClientsPage items={brainxClients??[]} onOpenJobs={company=>{setJobCompanyFilter(company);go("jobs")}} />}
   </>}
   {page==="alerts"&&<Alerts setExtraTasks={setExtraTasks} notify={notify} setDrawer={setDrawer}/>}
   {page==="rules"&&<Rules key={`${brainxKeywords.join("|")}:${brainxNote}`} notify={notify} mode={brainxMode} policy={brainxRun.policyVersion} keywords={brainxKeywords} note={brainxNote} onRefresh={async()=>{await loadBrainxSnapshot.current();void loadBrainxSide.current()}} onProfileSaved={(nextKeywords,nextNote)=>{setBrainxKeywords(nextKeywords);setBrainxNote(nextNote)}}/>}
   {page==="sources"&&<Sources notify={notify}/>}
  </WorkspaceShell>
     {panel&&<WorkbenchPanel panel={panel} motion={panelMotion} job={selectedDecisionJob} commitmentJobs={commitmentJobs} auth={auth} sync={sync} notifications={notifications} engagement={engagement} events={decisionEvents} outcomes={outcomes} completed={decisionActions} openmaiResults={openmaiByJob} onRerunOpenmai={rerunOpenmaiForJob} mode={brainxMode} legalMap={brainxJobs?Object.fromEntries(activeDecisionJobs.map(job=>[job.id,job.brainxLegal||[]])):{}} replayMap={brainxReplay} dismissReasons={brainxDismissReasons} onReplay={(jobId,data)=>setBrainxReplay(current=>({...current,[jobId]:data}))} onFactsUpdated={async()=>{await loadBrainxSnapshot.current();void loadBrainxSide.current()}} onMembership={confirmJobMembership} onClose={closePanel} onOpenJob={openDecision} onAction={runDecisionAction} onCommand={requestCommand} onOutcome={recordOutcome} onSync={runSync} onSetSync={setSync} onAuth={setAuth} onNotification={openNotification} notify={notify}/>}
  {assistantOpen&&<ChatbotDrawer messages={assistantMessages} input={assistantInput} setInput={setAssistantInput} busy={assistantBusy} onSend={sendAssistant} onStop={()=>assistantAbort.current?.abort()} onClear={()=>setAssistantMessages([])} onClose={()=>setAssistantOpen(false)} mode={brainxMode} page={page} settings={assistantSettings} setSettings={setAssistantSettings} contextJob={selectedDecisionJob}/>}
  {pendingCommand&&<CommandConfirm pending={pendingCommand} reasons={brainxDismissReasons} onClose={()=>setPendingCommand(null)} onConfirm={(reason?:string)=>applyCommand(pendingCommand.job,pendingCommand.command,reason)}/>}
  {drawer&&<><div className="drawer-backdrop" onClick={()=>setDrawer(null)}/><aside className="drawer"><button className="icon-btn" style={{float:"right"}} onClick={()=>setDrawer(null)}><X/></button><span className="eyebrow">Decision evidence</span><h2>判断依据</h2><div className="conclusion"><div className="spark"><Sparkles/></div><div><b>{drawer}</b><p>综合规则计算与AI结构化推断，置信度 91%</p></div></div><div className="score-bars">{["客户招聘意愿 18/20","职位新鲜度 14/15","HC与紧急程度 15/15","客户反馈速度 14/15","转化表现 16/20","竞争与风险 12/15"].map((x,i)=><div className="mini-item" key={x}><span className="num">0{i+1}</span><div><b>{x}</b><p>{i<4?"规则计算 · 内部项目驾驶舱":"AI推断 · 基于近30天事件"}</p></div></div>)}</div><button className="btn primary" style={{marginTop:18}} onClick={()=>{setDrawer(null);notify("依据已复制到项目备注")}}>复制到项目备注</button></aside></>}
  </>}
  {toast&&<div className="toast"><Check/> <span className="toast-text">{toast.text}</span>{toast.input?<>
    <input ref={toastInputRef} className="toast-input" placeholder={toast.input.placeholder} autoFocus onKeyDown={e=>{if(e.key==="Enter"){const v=e.currentTarget.value.trim();if(v){const fn=toast.input!.onSubmit;setToast(null);fn(v)}}else if(e.key==="Escape")setToast(null)}}/>
    <button className="toast-action" onClick={()=>{const v=toastInputRef.current?.value?.trim();if(v){const fn=toast.input!.onSubmit;setToast(null);fn(v)}}}>提交</button>
    <button className="toast-close" onClick={()=>setToast(null)} aria-label="关闭">×</button>
  </>:toast.actions?.map(a=><button key={a.label} className="toast-action" onClick={()=>{const fn=a.onClick;setToast(null);fn()}}>{a.label}</button>)}</div>}
 </div>
}

function evidenceCoveragePercent(coverage:number|null){return coverage===null?null:Math.round(coverage<=1?coverage*100:coverage)}
function ChatbotDrawer({messages,input,setInput,busy,onSend,onStop,onClear,onClose,mode,page,settings,setSettings,contextJob}:{messages:AssistantMessage[];input:string;setInput:(value:string)=>void;busy:boolean;onSend:()=>void;onStop:()=>void;onClear:()=>void;onClose:()=>void;mode:"connecting"|"connected"|"offline";page:Page;settings:boolean;setSettings:(value:boolean)=>void;contextJob:DecisionJob|null}){
 const [tab,setTab]=useState<"profile"|"market">("profile");
 const contextLabel=contextJob?`${contextJob.company} · ${contextJob.role}`:page==="today"?"当前精选盘与未接单职位":"当前工作台页面";
 const coverage=contextJob?evidenceCoveragePercent(contextJob.evidenceCoverage):null;
 const tags=contextJob?[decisionGroupMeta[contextJob.group].title,contextJob.facts["职位关系"],contextJob.sourceMode==="COCKPIT_CONTEXT"?"驾驶舱上下文":"职位市场"]:["推荐评分","顾问可见范围","实时同步"];
 const insights=contextJob?[contextJob.recommendation,...contextJob.risks].slice(0,3):["推荐基于当前顾问可见的职位、推荐和状态。","硬规则优先于综合评分，UNKNOWN 不会被当成 0。"];
 return <>
  <div className="assistant-backdrop" onClick={onClose}/>
  <aside className="assistant-drawer" aria-label="BrainX 助手">
   <header><div className="assistant-heading"><span className="assistant-heading-icon"><Sparkles/></span><div><span className="assistant-kicker">BRAINX ASSISTANT</span><h2>BrainX 助手</h2></div></div><button className="icon-btn" onClick={onClose} aria-label="关闭助手"><X/></button></header>
   <div className="assistant-tabs" role="tablist" aria-label="BrainX 助手视图"><button className={tab==="profile"?"active":""} type="button" role="tab" aria-selected={tab==="profile"} onClick={()=>setTab("profile")}>岗位画像</button><button className={tab==="market"?"active":""} type="button" role="tab" aria-selected={tab==="market"} onClick={()=>setTab("market")}>职位市场</button></div>
   <div className="assistant-insight" role="tabpanel">{tab==="profile"?<><h3>岗位画像概览</h3><div className="assistant-context-card"><div className="assistant-context-title"><b>核心目标</b><span>{mode==="connected"?"已连接":"演示模式"}</span></div><strong>{contextLabel}</strong><small>{contextJob?`最终匹配 ${contextJob.finalScore} · 推进 ${contextJob.globalScore} · 证据覆盖 ${coverage===null?"待确认":`${coverage}%`}`:"基于当前顾问可见的职位、推荐与状态"}</small><div className="assistant-context-section"><b>关键能力要求</b><div>{tags.filter(Boolean).map(tag=><span key={tag}>{tag}</span>)}</div></div><div className="assistant-context-section"><b>当前建议</b><ul>{insights.map(item=><li key={item}>{item}</li>)}</ul></div></div><section className="assistant-ai-insights"><h3>AI 洞察</h3><ul>{insights.map(item=><li key={item}>{item}</li>)}</ul></section></>:<><h3>职位市场</h3><div className="assistant-context-card market-card"><strong>{contextJob?contextJob.company:"当前职位市场"}</strong><small>{contextJob?`${contextJob.role} · ${contextJob.recentSignal}`:"切换职位后，可在这里查看当前职位的市场信号。"}</small><div className="assistant-context-section"><b>市场信号</b><div><span>{contextJob?.facts["数据来源"]||"职位市场"}</span><span>{contextJob?.facts["当前阶段"]||"待同步"}</span><span>{contextJob?.facts["剩余 HC"]||"UNKNOWN"} HC</span></div></div></div><section className="assistant-ai-insights"><h3>使用提示</h3><ul><li>点击职位卡可同步右侧的岗位画像。</li><li>可以在底部询问当前职位、评分或允许动作。</li></ul></section></>}</div>
   {settings&&<div className="assistant-settings"><div className="assistant-settings-title"><b>模型服务</b><button className="icon-btn" onClick={()=>setSettings(false)} aria-label="关闭设置"><X/></button></div><small>模型和密钥由 BrainX 服务器统一配置，浏览器不会读取或保存供应商密钥。</small></div>}
   <div className="assistant-messages" aria-live="polite">{messages.map((message,index)=><div className={`assistant-message ${message.role}`} key={`${index}-${message.role}`}><span>{message.role==="user"?"你":"BrainX"}</span><p>{message.content||(busy&&index===messages.length-1?"正在思考…":"")}</p></div>)}</div>
   <form className="assistant-compose" onSubmit={event=>{event.preventDefault();onSend()}}><textarea value={input} onChange={event=>setInput(event.target.value)} placeholder="向 BrainX 助手提问…" rows={2} disabled={busy&&mode!=="connected"}/><div><button type="button" className="assistant-clear" onClick={onClear}>清空</button><button type="button" className="assistant-gear" onClick={()=>setSettings(!settings)} aria-label="模型设置"><Settings2/></button>{busy?<button type="button" className="btn" onClick={onStop}>停止</button>:<button type="submit" className="btn primary" disabled={!input.trim()||mode!=="connected"}><Send/>发送</button>}</div></form>
  </aside>
 </>}

function AcceptedJobsView({jobs,total,query,open}:{jobs:DecisionJob[];total:number;query:string;open:(job:DecisionJob,tab?:"judgement"|"engagement"|"trail"|"replay")=>void}){
 const isFiltered=Boolean(query.trim());
 return <div className="decision-home accepted-home">
  <Heading code="ACCEPTED / ACTIVE DELIVERY" title="已确定" desc="这里集中显示你已经确认接单、正在推进的职位。"/>
  <section className="accepted-summary"><div><span>{isFiltered?"当前显示":"当前已确定"}</span><b>{isFiltered?`${jobs.length}/${total}`:total}</b><small>{isFiltered?"个匹配职位":"个职位进入交付列表"}</small></div><p>从精选盘点击“确定”后的职位，会在这里持续跟进。</p></section>
  <div className="accepted-list">{jobs.length?jobs.map(job=><article className="accepted-card" key={job.id}>
   <div className="accepted-card-top"><span>{decisionGroupMeta[job.group].title}</span><strong>{job.finalScore}</strong></div>
   <h2>{job.company}</h2><p>{job.role}</p>
   <div className="accepted-card-fact"><span>当前进度</span><b>{job.recentSignal}</b></div>
   <button className="accepted-card-action" onClick={()=>open(job,"engagement")}>打开承接与结果 <ChevronRight/></button>
  </article>):<div className="empty accepted-empty"><Search/><b>没有匹配的已确定职位</b><p>试试输入公司名、职位名或当前阶段。</p></div>}</div>
 </div>;
}

function DecisionMetric({label,value,emphasis,helpOpen,onHelpToggle}:{label:string;value:string|number;emphasis?:string;helpOpen?:boolean;onHelpToggle?:()=>void}){return <div className="decision-metric"><small>{label}</small>{onHelpToggle&&<button className="metric-help" type="button" onClick={onHelpToggle} aria-label={`解释${label}`} aria-expanded={helpOpen}>!</button>}<b className={emphasis}>{value}</b></div>}

function WorkbenchPanel({panel,motion,job,commitmentJobs,auth,sync,notifications,engagement,events,outcomes,completed,openmaiResults,onRerunOpenmai,mode,legalMap,replayMap,dismissReasons,onReplay,onFactsUpdated,onMembership,onClose,onOpenJob,onAction,onCommand,onOutcome,onSync,onSetSync,onAuth,onNotification,notify}:{panel:Panel;motion:"idle"|"entering"|"open"|"closing";job:DecisionJob|null;commitmentJobs:DecisionJob[];auth:AuthStatus;sync:SyncStatus;notifications:Notification[];engagement:Record<string,EngagementState>;events:Record<string,DecisionEvent[]>;outcomes:Record<string,Outcome[]>;completed:string[];openmaiResults:Record<string,OpenmaiResult|null>;onRerunOpenmai:(jobId:string)=>void;mode:"connecting"|"connected"|"offline";legalMap:Record<string,EngagementCommand[]>;replayMap:Record<string,BrainxReplay>;dismissReasons:string[];onReplay:(jobId:string,data:BrainxReplay)=>void;onFactsUpdated:()=>Promise<void>;onMembership:(job:DecisionJob,relation:MembershipRelation)=>Promise<void>;onClose:()=>void;onOpenJob:(job:DecisionJob,tab?:"judgement"|"engagement"|"trail"|"replay")=>void;onAction:(job:DecisionJob,action:DecisionAction)=>void;onCommand:(job:DecisionJob,command:EngagementCommand)=>void;onOutcome:(job:DecisionJob,stage:Outcome["stage"],rating?:number,note?:string)=>void;onSync:()=>void;onSetSync:(sync:SyncStatus)=>void;onAuth:(auth:AuthStatus)=>void;onNotification:(notification:Notification)=>void;notify:(text:string)=>void}){
 const [dragOffset,setDragOffset]=useState<number|null>(null);
 const panelDrag=useRef<{pointerId:number;startX:number;lastX:number;lastAt:number;velocity:number}|null>(null);
 const startPanelDrag=(event:React.PointerEvent<HTMLDivElement>)=>{
  if(typeof window==="undefined"||window.innerWidth>720||event.button!==0)return;
  panelDrag.current={pointerId:event.pointerId,startX:event.clientX,lastX:event.clientX,lastAt:performance.now(),velocity:0};
  event.currentTarget.setPointerCapture(event.pointerId);
  setDragOffset(0);
 };
 const movePanelDrag=(event:React.PointerEvent<HTMLDivElement>)=>{
  const drag=panelDrag.current;
  if(!drag||drag.pointerId!==event.pointerId)return;
  const now=performance.now();
  const raw=Math.max(0,event.clientX-drag.startX);
  const offset=raw>260?260+(raw-260)*.28:raw;
  drag.velocity=(event.clientX-drag.lastX)/Math.max(1,now-drag.lastAt);
  drag.lastX=event.clientX;drag.lastAt=now;
  setDragOffset(offset);
 };
 const finishPanelDrag=(event:React.PointerEvent<HTMLDivElement>)=>{
  const drag=panelDrag.current;
  if(!drag||drag.pointerId!==event.pointerId)return;
  panelDrag.current=null;
  const distance=Math.max(0,event.clientX-drag.startX);
  const projected=distance+Math.max(0,drag.velocity)*150;
  setDragOffset(null);
  if(projected>window.innerWidth*.3)onClose();
 };
 return <aside className={`decision-drawer workbench-panel panel-${motion}${dragOffset!==null?" is-dragging":""}`} style={{"--panel-drag-offset":`${dragOffset??0}px`} as React.CSSProperties} aria-label="工作台详情面板"><div className="drawer-drag-handle" aria-label="向右滑动关闭详情" onPointerDown={startPanelDrag} onPointerMove={movePanelDrag} onPointerUp={finishPanelDrag} onPointerCancel={finishPanelDrag}><i/></div><button className="drawer-close" onClick={onClose} aria-label="关闭详情"><X/></button>{panel?.kind==="job"&&job?<DecisionDrawer job={job} tab={panel.tab} completed={completed} engagement={engagement[job.id]||"NEW"} events={events[job.id]||[]} outcomes={outcomes[job.id]||[]} openmai={openmaiResults[job.id]||null} onRerunOpenmai={onRerunOpenmai} mode={mode} legalMap={legalMap} replayData={replayMap[job.id]} onReplay={onReplay} onFactsUpdated={onFactsUpdated} onMembership={onMembership} notify={notify} onTab={tab=>onOpenJob(job,tab)} onAction={onAction} onCommand={onCommand} onOutcome={onOutcome}/>:panel?.kind==="sync"?<SyncPanel sync={sync} onSync={onSync} onSetSync={onSetSync} notify={notify} mode={mode}/>:panel?.kind==="identity"?<IdentityPanel auth={auth} onAuth={onAuth} notify={notify} mode={mode}/>:panel?.kind==="commitments"?<CommitmentsPanel jobs={commitmentJobs} engagement={engagement} onOpen={job=>onOpenJob(job,"engagement")}/>:<NotificationPanel items={notifications} onOpen={onNotification} notify={notify}/>}</aside>
}

function CommitmentsPanel({jobs,engagement,onOpen}:{jobs:DecisionJob[];engagement:Record<string,EngagementState>;onOpen:(job:DecisionJob)=>void}){return <><div className="panel-heading"><BriefcaseBusiness/><div><h1>我的承接</h1><p>关注、接单和需要继续处理的职位</p></div></div><div className="mobile-commitment-list">{jobs.length?jobs.map(job=><button key={job.id} onClick={()=>onOpen(job)}><span><b>{job.company} · {job.role}</b><small>{engagement[job.id]==="ACCEPTED"?"接单中 · 推进交付或记录结果":"关注中 · 评估后接单或取消关注"}</small></span><ChevronRight/></button>):<p>暂无承接职位。</p>}</div></>}

/** 接单自动找人面板（engagement tab）：接单后自动触发，SSE/刷新回传结果；done 可显式重跑。 */
function OpenmaiPanel({jobId,openmai,mode,onRerun}:{jobId:string;openmai:OpenmaiResult|null;mode:"connecting"|"connected"|"offline";onRerun:(jobId:string)=>void}){
 if(mode!=="connected")return null;
 if(!openmai||openmai.status==="none")return null;
 return <DrawerSection title="OpenMai 自动找人（接单后自动触发）">
   {openmai.status==="running"&&<p className="muted" style={{margin:"0 0 10px"}}>找人中…约 1-2 分钟，完成后自动更新（也可关闭页面稍后回来看）。</p>}
   {openmai.status==="failed"&&<p className="muted" style={{margin:"0 0 10px",color:"#c64b59"}}>找人失败：{openmai.error||"未知错误"}</p>}
   {openmai.status==="done"&&<pre style={{margin:"0 0 10px",padding:"12px",borderRadius:"10px",background:"rgba(23,107,88,.05)",border:"1px solid rgba(23,107,88,.18)",whiteSpace:"pre-wrap",wordBreak:"break-word",fontSize:"12px",lineHeight:"1.7",maxHeight:"420px",overflow:"auto"}}>{openmai.result_text}</pre>}
   <button onClick={()=>onRerun(jobId)} disabled={openmai.status==="running"} style={{border:"1px solid rgba(23,107,88,.3)",background:"#fff",color:"#215a4c",borderRadius:"999px",padding:"6px 14px",fontSize:"12px",cursor:openmai.status==="running"?"not-allowed":"pointer"}}>{openmai.status==="running"?"找人中…":"重新找人"}</button>
 </DrawerSection>
}

function DecisionDrawer({job,tab,completed,engagement,events,outcomes,openmai,onRerunOpenmai,mode,legalMap,replayData,onReplay,onFactsUpdated,onMembership,notify,onTab,onAction,onCommand,onOutcome}:{job:DecisionJob;tab:"judgement"|"engagement"|"trail"|"replay";completed:string[];engagement:EngagementState;events:DecisionEvent[];outcomes:Outcome[];openmai:OpenmaiResult|null;onRerunOpenmai:(jobId:string)=>void;mode:"connecting"|"connected"|"offline";legalMap:Record<string,EngagementCommand[]>;replayData?:BrainxReplay;onReplay:(jobId:string,data:BrainxReplay)=>void;onFactsUpdated:()=>Promise<void>;onMembership:(job:DecisionJob,relation:MembershipRelation)=>Promise<void>;notify:(text:string)=>void;onTab:(tab:"judgement"|"engagement"|"trail"|"replay")=>void;onAction:(job:DecisionJob,action:DecisionAction)=>void;onCommand:(job:DecisionJob,command:EngagementCommand)=>void;onOutcome:(job:DecisionJob,stage:Outcome["stage"],rating?:number,note?:string)=>void}){
 const [replayLoading,setReplayLoading]=useState(false);
 const [factEditRequest,setFactEditRequest]=useState(0);
 const requestFactEdit=()=>{setFactEditRequest(value=>value+1);onTab("judgement")};
 const verifyComplete=job.actions.some(action=>action.kind==="verify"&&completed.includes(`${job.id}:${action.id}`));
 useEffect(()=>{if(verifyComplete&&mode!=="connecting")requestFactEdit()},[job.id,verifyComplete,mode]);
 useEffect(()=>{if(mode!=="connected"||!job?.brainxDecisionId||replayData)return;let cancelled=false;setReplayLoading(true);brainxFetch<BackendReplay>(`/api/v1/decisions/${encodeURIComponent(job.brainxDecisionId)}/replay`).then(data=>{if(!cancelled)onReplay(job.id,mapReplayData(data))}).catch(()=>{}).finally(()=>{if(!cancelled)setReplayLoading(false)});return()=>{cancelled=true}},[mode,job?.id,job?.brainxDecisionId,replayData,onReplay]);
 const tabOptions=["judgement","engagement","trail","replay"] as const;
 const tabLabel={judgement:"判断",engagement:"承接与结果",trail:"决策轨迹",replay:"回放"} as const;
 return <><div className="drawer-title"><h1>{job.company} <span>·</span> {job.role}</h1><span className={`decision-state ${job.eligibility.toLowerCase()}`}>{stateLabel[engagement]} · {decisionGroupMeta[job.group].title}</span></div><DirectGlassSegment value={tab} options={tabOptions.map(value=>({value,label:tabLabel[value]}))} onChange={onTab} className="drawer-tabs" ariaLabel="职位详情视图"/>{tab==="judgement"?<><div className="drawer-metrics"><DecisionMetric label="项目推进" value={job.globalScore}/><DecisionMetric label="探索机会" value={job.explorationScore}/><DecisionMetric label="个人适配" value={job.personalScore}/><DecisionMetric label="最终得分" value={job.finalScore} emphasis="final"/></div><ManualFactSection job={job} mode={mode} onUpdated={onFactsUpdated} notify={notify} editRequest={factEditRequest}/><DrawerSection title="为什么现在做"><ul className="explanations">{job.scoreNotes.map(note=><li key={note}>{note}</li>)}</ul></DrawerSection>{job.risks.length>0&&<DrawerSection title="风险与缺失"><ul className="explanations risks">{job.risks.map(note=><li key={note}>{note}</li>)}</ul></DrawerSection>}<DrawerSection title="证据来源"><div className="evidence-list">{job.evidence.map(item=><span key={item}>{item}</span>)}</div></DrawerSection><TalentSupplySection job={job} mode={mode}/><DrawerSection title="当前建议"><div className="drawer-actions">{job.actions.map(action=>{const complete=completed.includes(`${job.id}:${action.id}`);return <button key={action.id} className={complete?"completed":""} onClick={()=>onAction(job,action)} disabled={complete}><span><b>{complete?"已记录：":""}{action.label}</b><small>{action.detail}</small></span>{complete?<Check/>:<ChevronRight/>}</button>})}</div></DrawerSection></>:tab==="engagement"?<><EngagementPanel job={job} state={engagement} outcomes={outcomes} mode={mode} legalMap={legalMap} onCommand={onCommand} onMembership={onMembership} onVerify={requestFactEdit} onUpdated={onFactsUpdated} notify={notify}/><OpenmaiPanel jobId={job.id} openmai={openmai} mode={mode} onRerun={onRerunOpenmai}/></>:tab==="trail"?<DrawerSection title="决策轨迹"><div className="trail-list">{events.length?events.map(event=><div key={event.id}><time>{event.at}</time><b>{event.type}</b><small>{event.reason||"顾问工作台"}</small></div>):<p className="muted">尚无操作记录</p>}</div></DrawerSection>:<ReplayPanel job={job} events={events} outcomes={outcomes} replayData={replayData} loading={replayLoading}/>}</>
}

function engagementStateMessage(state:EngagementState){
 return ({
  NEW:"尚未纳入个人承接；可先关注，或在判断面板核验后再处理。",
  RECOMMENDED:"已获得推荐；可先关注，或在判断面板核验后再处理。",
  VIEWED:"已查看当前判断；可加入关注或暂不考虑。",
  WATCHED:"已保留关注位；评估完成后可接单。",
  ACCEPTED:"已进入你的交付列表；请持续推进并回写结果。",
  DISMISSED:"已记录暂不考虑；如出现新信号，可重新关注并回到承接流程。",
  RELEASED:"已从当前工作区释放；如需继续推进，可重新关注后再接单。",
  COMPLETED:"本轮承接已完成；结果已归档，可在回放中查看完整过程。",
  EXPIRED:"关注超过 90 天无动作，已自动过期；可重新关注后继续评估。",
 } satisfies Record<EngagementState,string>)[state];
}

function engagementCommandLabel(command:EngagementCommand,state:EngagementState){
 if(command==="WATCH"&&(state==="RELEASED"||state==="DISMISSED"))return "重新关注";
 if(command==="RELEASE"&&state==="ACCEPTED")return "退出承接";
 return actionLabel[command];
}

function EngagementPanel({job,state,outcomes,mode,legalMap,onCommand,onMembership,onVerify,onUpdated,notify}:{job:DecisionJob;state:EngagementState;outcomes:Outcome[];mode:"connecting"|"connected"|"offline";legalMap:Record<string,EngagementCommand[]>;onCommand:(job:DecisionJob,command:EngagementCommand)=>void;onMembership:(job:DecisionJob,relation:MembershipRelation)=>Promise<void>;onVerify:()=>void;onUpdated:()=>Promise<void>;notify:(text:string)=>void}){
 const actions=mode==="connected"?legalMap[job.id]||[]:legalActions(job,state).filter(action=>action!=="COMPLETE"&&action!=="RELEASE");
 return <CommitmentLoopPanel job={job} state={state} outcomes={outcomes} mode={mode} legal={actions} onCommand={command=>onCommand(job,command)} onMembership={relation=>onMembership(job,relation)} onVerify={onVerify} onUpdated={onUpdated} notify={notify}/>;
}

function ReplayPanel({job,events,outcomes,replayData,loading}:{job:DecisionJob;events:DecisionEvent[];outcomes:Outcome[];replayData?:BrainxReplay;loading?:boolean}){const replay=replayData?{decisionId:replayData.decisionId,runId:replayData.decisionId,snapshotAt:replayData.snapshotAt,policyVersion:replayData.policyVersion,rank:replayData.rank,reasons:replayData.reasons,risks:replayData.risks,evidence:replayData.evidence}:{decisionId:`D-${job.id.slice(4)}`,runId:"RUN-1842",snapshotAt:"2026-08-10 11:28",policyVersion:"Policy v1.2",rank:job.rank,reasons:job.scoreNotes,risks:job.scoreNotes.slice(0,1),evidence:job.evidence};const shownEvents=replayData?replayData.events:events;const shownOutcomes=replayData?replayData.outcomes:outcomes;return <><DrawerSection title="冻结决策快照"><dl className="facts"><div><dt>快照时间</dt><dd>{loading&&!replayData?"读取中…":replay.snapshotAt}</dd></div><div><dt>策略版本</dt><dd>{replay.policyVersion}</dd></div><div><dt>当时排名</dt><dd>第 {replay.rank} 位</dd></div><div><dt>决策编号</dt><dd>{replay.decisionId}</dd></div></dl></DrawerSection><DrawerSection title="当时理由与风险"><ul className="explanations">{replay.reasons.map(item=><li key={item}>{item}</li>)}</ul><div className="evidence-list">{replay.evidence.map(item=><span key={item}>{item}</span>)}</div></DrawerSection><DrawerSection title="后续操作"><div className="trail-list">{shownEvents.map(item=><div key={item.id}><time>{item.at}</time><b>{item.type}</b><small>{item.reason||"顾问工作台"}</small></div>)}</div></DrawerSection><DrawerSection title="后续结果">{shownOutcomes.length?<div className="outcome-list">{shownOutcomes.map(item=><div key={item.id}><b>{item.stage}</b><span>{item.note||"已记录"}</span><time>{item.at}</time></div>)}</div>:<p className="muted">暂无结果记录；回放以上方冻结数据为准。</p>}</DrawerSection></>}

function SyncPanel({sync,onSync,onSetSync,notify,mode}:{sync:SyncStatus;onSync:()=>void;onSetSync:(sync:SyncStatus)=>void;notify:(text:string)=>void;mode:"connecting"|"connected"|"offline"}){const setDemo=(state:SyncStatus["state"]):void=>{onSetSync({...sync,state,errors:state==="ERROR"?["飞书消息源超时"]:state==="INCOMPLETE"?["职位事实未完整返回"]:[]});notify(state==="INCOMPLETE"?"已切换为同步不完整演示状态":"已切换为同步失败演示状态")};return <><div className="panel-heading"><ShieldCheck/><div><h1>同步状态</h1><p>当前推荐只使用完整快照</p></div></div><DrawerSection title="当前快照"><dl className="facts"><div><dt>状态</dt><dd>{sync.state==="READY"?"已同步":sync.state==="RUNNING"?"同步中":sync.state==="INCOMPLETE"?"本次同步不完整":sync.state==="AUTH_EXPIRED"?"飞书授权已过期":sync.state==="ERROR"?"同步失败":"尚未同步"}</dd></div><div><dt>读取进度</dt><dd>{sync.rowsRead??0} / {sync.rowsExpected??"—"}</dd></div><div><dt>更新时间</dt><dd>{sync.updatedAt||"—"}</dd></div>{sync.errors&&sync.errors.length>0&&<div><dt>错误</dt><dd className="unknown">{sync.errors[0]}</dd></div>}</dl></DrawerSection><div className="drawer-actions"><button onClick={onSync}><span><b>重新同步</b><small>{mode==="connected"?"拉取 fixture 快照并生成新推荐":"生成新的完整推荐快照"}</small></span><ChevronRight/></button>{mode!=="connected"&&<><button onClick={()=>setDemo("INCOMPLETE")}><span><b>模拟同步不完整</b><small>验证推荐阻断界面</small></span><AlertTriangle/></button><button onClick={()=>setDemo("ERROR")}><span><b>模拟同步失败</b><small>验证异常与恢复提示</small></span><X/></button></>}</div><p className="panel-caption">{mode==="connected"?"已连接 Brain X 后端；状态来自 sync_runs，重新同步会触发 fixture 同步并冻结新推荐。":"当前为前端演示。后端接入后，这里映射 sync_runs 与推荐生成状态。"}</p></>}

function IdentityPanel({auth,onAuth,notify,mode}:{auth:AuthStatus;onAuth:(auth:AuthStatus)=>void;notify:(text:string)=>void;mode:"connecting"|"connected"|"offline"}){const [consultants,setConsultants]=useState<{consultant_id:string;display_name:string}[]|null>(null);const [loginBusy,setLoginBusy]=useState<string|null>(null);useEffect(()=>{brainxFetch<BackendConsultants>("/api/v1/consultants").then(d=>setConsultants(d.items||[])).catch(()=>setConsultants([]))},[]);const devLogin=(consultantId:string)=>void(async()=>{setLoginBusy(consultantId);try{await brainxFetch<null>("/api/v1/session",{method:"POST",body:{consultant_id:consultantId}});notify("已登录 Brain X，正在加载后端快照…");window.setTimeout(()=>window.location.reload(),600)}catch(error){notify(`登录失败：${error instanceof Error?error.message:"后端未响应"}`);setLoginBusy(null)}})();const logout=()=>void(async()=>{try{await brainxFetch<null>("/api/v1/session",{method:"DELETE"})}catch{}notify("已退出 Brain X 会话");window.setTimeout(()=>window.location.reload(),400)})();return <><div className="panel-heading"><CircleUserRound/><div><h1>{auth.consultant}</h1><p>{mode==="connected"?"Brain X 顾问会话与数据授权":"本地演示身份与后端登录"}</p></div></div><DrawerSection title="账户状态"><dl className="facts"><div><dt>登录状态</dt><dd>{mode==="connected"?"Brain X 已登录":mode==="connecting"?"正在探测后端…":"演示模式（未连接后端）"}</dd></div><div><dt>飞书授权</dt><dd className={auth.needsReauth?"unknown":""}>{mode==="connected"?auth.needsReauth?"已过期":"正常":"—"}</dd></div></dl></DrawerSection>{mode==="connected"?<div className="drawer-actions"><button onClick={logout}><span><b>退出登录</b><small>清除 Brain X 会话并回到演示模式</small></span><ChevronRight/></button></div>:<><DrawerSection title="飞书扫码登录（正式入口）"><p className="panel-caption">跳转飞书统一授权页，用你自己的飞书账号扫码授权。需在顾问花名册内，否则会被拒绝。</p><div className="drawer-actions"><button onClick={()=>{window.location.href="/api/v1/oauth/authorize"}}><span><b>飞书扫码登录</b><small>跳转飞书授权页 · 登录 Brain X 工作台</small></span><ChevronRight/></button></div></DrawerSection><DrawerSection title="登录 Brain X 后端（开发后门）"><p className="panel-caption">后端需以 BRAINX_DEV_AUTH=1 启动；正式环境请使用飞书授权登录。</p><div className="drawer-actions">{consultants===null?<p className="muted">正在读取顾问花名册…</p>:consultants.length?consultants.map(c=><button key={c.consultant_id} onClick={()=>devLogin(c.consultant_id)} disabled={loginBusy!==null}><span><b>{loginBusy===c.consultant_id?"登录中…":c.display_name}</b><small>以该顾问身份进入 Brain X 工作台</small></span>{loginBusy===c.consultant_id?<Clock3/>:<ChevronRight/>}</button>):<p className="muted">后端不可达或花名册为空。</p>}</div></DrawerSection><DrawerSection title="演示状态"><div className="drawer-actions"><button onClick={()=>{onAuth({...auth,needsReauth:!auth.needsReauth,authorized:auth.needsReauth});notify(auth.needsReauth?"已恢复授权演示状态":"已切换为授权过期演示状态")}}><span><b>{auth.needsReauth?"恢复授权状态":"模拟授权过期"}</b><small>用于验证后端授权恢复入口</small></span><ShieldCheck/></button><button onClick={()=>notify("已退出演示会话；刷新页面将恢复本地演示身份")}><span><b>退出演示</b><small>不影响任何外部账号</small></span><ChevronRight/></button></div></DrawerSection></>}</>}

function NotificationPanel({items,onOpen,notify}:{items:Notification[];onOpen:(item:Notification)=>void;notify:(text:string)=>void}){return <><div className="panel-heading"><BellRing/><div><h1>今日提醒</h1><p>同步、承接与每日推荐摘要</p></div></div><div className="notification-list">{items.map(item=><button key={item.id} className={item.read?"read":""} onClick={()=>onOpen(item)}><i/><span><b>{item.title}</b><small>{item.detail}</small></span><ChevronRight/></button>)}</div><DrawerSection title="推送预览"><div className="push-preview"><b>今日职位判断</b><span>Top 3 已生成 · 1 个承接待处理</span></div><button className="btn" onClick={()=>notify("已模拟发送到 Felix 的飞书提醒") }><Send/>模拟发送</button><p className="panel-caption">仅展示推送内容，不会发送到外部系统。</p></DrawerSection></>}

function CommandConfirm({pending,reasons,onClose,onConfirm}:{pending:{job:DecisionJob;command:EngagementCommand};reasons:string[];onClose:()=>void;onConfirm:(reason?:string)=>void}){const list=reasons&&reasons.length?reasons:["无资源","不符合方向","客户/职位质量不足","当前没精力","已有其他顾问推进","信息不完整","其他"];const [reason,setReason]=useState(list[0]);const dismiss=pending.command==="DISMISS";const reasonOptions:FilterSelectOption[]=list.map(value=>({value,label:value}));return <div className="command-mask" role="presentation"><section className="command-modal" role="dialog" aria-modal="true" aria-label="确认承接操作"><h2>{dismiss?"暂不考虑这个职位？":"确认接单？"}</h2><p>{dismiss?"选择原因后会记录到决策轨迹。":"接单后该职位将进入你的交付列表。"}</p>{dismiss&&<FilterSelect value={reason} onChange={setReason} ariaLabel="暂不考虑原因" options={reasonOptions}/>}<div><button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={()=>onConfirm(dismiss?reason:undefined)}>{dismiss?"记录原因":"确认接单"}</button></div></section></div>}

// —— 候选供给（人才侧适配层的前端呈现）——
// 数据形状对齐后端 talent-supply.js 的 TalentSupplySnapshot（GET /opportunities/:id/talent-supply）。
// 供给分析【旁路】：只做展示，绝不并入 job.finalScore（与后端「不进入基础评分」纪律一致）。
// 数据来源：真库匹配算法 supply-match-v1（技能0.5 + 意向0.3 + 摘要0.2）。前端不再造数——
// connected 且开关开启时拉真实结果；离线态不展示说明，未开启/失败只显示状态，绝不伪造数字。
const supplyDifficultyMeta:Record<"low"|"medium"|"high",{label:string;tone:string}>={low:{label:"供给充足",tone:"ok"},medium:{label:"供给适中",tone:"warn"},high:{label:"供给偏紧",tone:"risk"}};
function TalentSupplySection({job,mode}:{job:DecisionJob;mode:"connecting"|"connected"|"offline"}){
 const [snap,setSnap]=useState<TalentSupplySnapshot|null>(null);
 const [state,setState]=useState<"idle"|"loading"|"ready"|"disabled"|"error">("idle");
 useEffect(()=>{
  if(mode!=="connected"){setState("disabled");return;}
  let alive=true;setState("loading");
  getTalentSupply(job.id)
   .then(s=>{if(!alive)return;if(s&&s.enabled){setSnap(s);setState("ready");}else{setState("disabled");}})
   .catch(()=>{if(alive)setState("error");});
  return()=>{alive=false;};
 },[job.id,mode]);

 if(state==="ready"&&snap){
  const meta=supplyDifficultyMeta[snap.supplyDifficulty||"high"];
  return <DrawerSection title="候选供给（人才侧参考）">
   <div className="supply-head">
    <div className="supply-count"><strong>{snap.matchableTalentCount??0}</strong><span>可匹配候选</span></div>
    <span className={`supply-badge ${meta.tone}`}>{meta.label}</span>
    {(snap.reactivatableTalentCount??0)>0&&<span className="supply-reactivate">可激活沉睡 {snap.reactivatableTalentCount} 人</span>}
   </div>
   <p className="supply-suggestion">{snap.matchingSuggestion}</p>
   {(snap.topMatches?.length??0)>0&&<div className="supply-matches">{snap.topMatches!.map(m=><div key={m.talentId} className="supply-match"><b>{m.name}</b><span>匹配 {Math.round(m.score*100)}%{m.matched?.length?` · ${m.matched.slice(0,3).join("、")}`:""}</span></div>)}</div>}
   <p className="snapshot-note">来源 {snap.algo||"talent-supply"} · 真库匹配 · 不计入最终得分</p>
  </DrawerSection>;
 }
 return <DrawerSection title="候选供给（人才侧参考）">
  {mode==="connected"&&<p className="supply-suggestion muted">
   {state==="loading"?"正在从人才库计算候选供给…":
    state==="error"?"供给计算暂不可用（人才库接口未响应）":
    "供给分析未开启（需设 BRAINX_TALENT_SUPPLY=1）或人才库暂无候选。"}
 </p>}
 </DrawerSection>;
}

function Alerts({setExtraTasks,notify,setDrawer}:any){const alerts=["云帆智能连续7天未反馈","商业化增长经理转化率下降12%","海外增长负责人面试池已拥挤","星河科技进入招聘窗口期","Creator Partnership负责人新增2个HC","棱镜互动近14天需求变更3次","AI解决方案销售参与顾问增至6人","用户增长负责人产生Offer"];const [handled,setHandled]=useState<number[]>([]);const [riskFilter,setRiskFilter]=useState("全部风险等级");const [clientFilter,setClientFilter]=useState("全部客户");return <><Heading code="DYNAMIC ALERTS" title="动态预警" desc="聚合需要人工确认的机会、变化和失活信号。"/><div className="toolbar"><FilterSelect value={riskFilter} onChange={setRiskFilter} ariaLabel="预警风险等级" options={["全部风险等级","高风险","机会"].map(value=>({value,label:value}))}/><FilterSelect value={clientFilter} onChange={setClientFilter} ariaLabel="预警客户筛选" options={[{value:"全部客户",label:"全部客户"},...clients.map(client=>({value:client.name,label:client.name}))]}/></div><section className="card"><div className="actions">{alerts.map((x,i)=><div className="action-row" key={x} style={{opacity:handled.includes(i)?.5:1}}><StatusTag s={i%3===0?"高风险":i%3===1?"关注":"机会"}/><div className="action-main"><b>{x}</b><small>{i%2?"基于近7天业务事件变化":"超过预设阈值，建议今天确认"}</small></div><div className="impact"><strong>{i%3===2?"机会升温":"需人工确认"}</strong>置信度 {88+i}%</div><div className="row-actions"><button className="btn" onClick={()=>setDrawer(x)}>依据</button><button className="btn" onClick={()=>{setExtraTasks((v:string[])=>v.includes(x)?v:[...v,x]);notify("已转为今日任务")}}>转任务</button><button className="icon-btn" onClick={()=>{setHandled([...handled,i]);notify("预警已处理")}}><Check/></button></div></div>)}</div></section></>}
