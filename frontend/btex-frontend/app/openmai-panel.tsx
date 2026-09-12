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
 // T6：推荐字段按「、」切分，输入上限 20 字；切分结果实时可见。
 const tags=brief.split("、").map(item=>item.trim()).filter(Boolean);
 return <DrawerSection title="OpenMai 自动找人（开始跟进后触发）">
   {running&&<p className="muted" style={{margin:"0 0 10px"}}>找人中…约 1-2 分钟，完成后自动更新（也可关闭页面稍后回来看）。</p>}
   {openmai.status==="failed"&&<p className="muted" style={{margin:"0 0 10px",color:"#c64b59"}}>找人失败：{openmai.error||"未知错误"}</p>}
   {needsInput&&<p className="muted" style={{margin:"0 0 10px",color:"#9a6518"}}>现有职位信息不足，请补充职位信息后重新找人。</p>}
   {openmai.status==="done"&&<OpenmaiMarkdown text={openmai.result_text||""}/>}
   <label style={{display:"grid",gap:"8px",margin:"12px 0"}}>
    <span style={{fontWeight:600}}>补充职位信息</span>
    <input aria-label="补充职位信息" value={brief} disabled={running} maxLength={20}
      placeholder="顿号分隔，≤ 20 字，例如：北京、半导体、总监"
      onChange={event=>setBrief(event.target.value)} style={{border:"1px solid rgba(23,107,88,.25)",borderRadius:"14px",padding:"12px",font:"inherit"}}/>
   </label>
   {tags.length>0&&<div aria-label="推荐字段" style={{display:"flex",flexWrap:"wrap",gap:"6px",margin:"0 0 10px"}}>{tags.map(tag=><span key={tag} style={{padding:"4px 10px",borderRadius:"999px",background:"rgba(23,107,88,.08)",color:"#215a4c",fontSize:"12px"}}>{tag}</span>)}</div>}
   <button onClick={()=>onRerun(jobId,brief.trim())} disabled={running||!tags.length} style={{border:"1px solid rgba(23,107,88,.3)",background:"#fff",color:"#215a4c",borderRadius:"999px",padding:"6px 14px",fontSize:"12px",cursor:running||!tags.length?"not-allowed":"pointer"}}>{running?"找人中…":needsInput?"用此画像开始找人":"用此画像重新找人"}</button>
 </DrawerSection>
}
