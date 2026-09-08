"use client";
import { useState } from "react";
import type { OpenmaiResult } from "./brainx-api";
import { OpenmaiMarkdown } from "./openmai-markdown";
import { DrawerSection } from "./workbench-controls";

export function OpenmaiPanel({jobId,openmai,mode,onRerun}:{jobId:string;openmai:OpenmaiResult|null;mode:"connecting"|"connected"|"offline";onRerun:(jobId:string,searchBrief?:string)=>void}){
 const [brief,setBrief]=useState(openmai?.search_brief||"");
 if(mode!=="connected"||!openmai||openmai.status==="none")return null;
 const running=openmai.status==="running";
 const needsInput=openmai.status==="needs_input";
 return <DrawerSection title="OpenMai 自动找人（开始跟进后触发）">
   {running&&<p className="muted" style={{margin:"0 0 10px"}}>找人中…约 1-2 分钟，完成后自动更新（也可关闭页面稍后回来看）。</p>}
   {openmai.status==="failed"&&<p className="muted" style={{margin:"0 0 10px",color:"#c64b59"}}>找人失败：{openmai.error||"未知错误"}</p>}
   {needsInput&&<p className="muted" style={{margin:"0 0 10px",color:"#9a6518"}}>现有职位信息不足，请补充岗位画像后重新找人。</p>}
   {openmai.status==="done"&&<OpenmaiMarkdown text={openmai.result_text||""}/>}
   <label style={{display:"grid",gap:"8px",margin:"12px 0"}}>
    <span style={{fontWeight:600}}>补充岗位画像</span>
    <textarea aria-label="补充岗位画像" value={brief} disabled={running} maxLength={2000} rows={5}
      placeholder="例如：寻找新能源汽车功率模块研发负责人；必须做过 SiC/IGBT 模块设计，优先斯达、英飞凌背景，可接受上海或无锡。"
      onChange={event=>setBrief(event.target.value)} style={{resize:"vertical",border:"1px solid rgba(23,107,88,.25)",borderRadius:"14px",padding:"12px",font:"inherit"}}/>
   </label>
   <button onClick={()=>onRerun(jobId,brief.trim())} disabled={running||!brief.trim()} style={{border:"1px solid rgba(23,107,88,.3)",background:"#fff",color:"#215a4c",borderRadius:"999px",padding:"6px 14px",fontSize:"12px",cursor:running||!brief.trim()?"not-allowed":"pointer"}}>{running?"找人中…":needsInput?"用此画像开始找人":"用此画像重新找人"}</button>
 </DrawerSection>
}
