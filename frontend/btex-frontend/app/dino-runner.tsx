"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type GamePhase = "idle"|"running"|"over";

function PixelDino(){
 return <svg viewBox="0 0 48 52" aria-hidden="true">
  <path d="M24 3h17v4h4v17H29v4h8v5H25v8h-5v8h-5v-9h-5v9H5V36H1V19h5v10h5V15h5v9h4V7h4V3Zm12 7h4v4h-4v-4Z" fill="currentColor" fillRule="evenodd"/>
 </svg>
}

function PixelCactus(){
 return <svg viewBox="0 0 30 52" aria-hidden="true">
  <path d="M11 1h8v22h4V12h6v21H19v18h-8V35H1V16h6v10h4V1Z" fill="currentColor"/>
 </svg>
}

export function DinoRunner(){
 const [phase,setPhase]=useState<GamePhase>("idle");
 const [jumping,setJumping]=useState(false);
 const [score,setScore]=useState(0);
 const [best,setBest]=useState(0);
 const [runId,setRunId]=useState(0);
 const dinoRef=useRef<HTMLDivElement|null>(null);
 const obstacleRef=useRef<HTMLDivElement|null>(null);
 const jumpTimerRef=useRef<number|null>(null);
 const scoreRef=useRef(0);

 useEffect(()=>{scoreRef.current=score},[score]);
 useEffect(()=>()=>{if(jumpTimerRef.current)window.clearTimeout(jumpTimerRef.current)},[]);

 const jump=useCallback(()=>{
  if(phase!=="running"){
   setScore(0);
   scoreRef.current=0;
   setRunId(value=>value+1);
   setPhase("running");
  }
  if(jumping)return;
  setJumping(true);
  if(jumpTimerRef.current)window.clearTimeout(jumpTimerRef.current);
  jumpTimerRef.current=window.setTimeout(()=>{setJumping(false);jumpTimerRef.current=null},560);
 },[jumping,phase]);

 useEffect(()=>{
  if(phase!=="running")return;
  const scoreTimer=window.setInterval(()=>setScore(value=>value+1),100);
  const collisionTimer=window.setInterval(()=>{
   const dino=dinoRef.current?.getBoundingClientRect();
   const obstacle=obstacleRef.current?.getBoundingClientRect();
   if(!dino||!obstacle)return;
   const collided=dino.right-7>obstacle.left&&dino.left+7<obstacle.right&&dino.bottom-5>obstacle.top&&dino.top+5<obstacle.bottom;
   if(collided){setBest(value=>Math.max(value,scoreRef.current));setPhase("over")}
  },32);
  return()=>{window.clearInterval(scoreTimer);window.clearInterval(collisionTimer)};
 },[phase,runId]);

 const onKeyDown=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  if(event.code==="Space"||event.code==="ArrowUp"){event.preventDefault();jump()}
 };
 const prompt=phase==="idle"?"点击或按空格开始":phase==="over"?"撞到了 · 点击重新开始":"点击或按空格跳跃";

 return <div className={`dino-runner is-${phase}`} role="button" tabIndex={0} aria-label={prompt} onClick={jump} onKeyDown={onKeyDown}>
  <div className="dino-scoreboard"><span>得分 {String(score).padStart(4,"0")}</span><span>最佳 {String(best).padStart(4,"0")}</span></div>
  <div className="dino-cloud cloud-one"/><div className="dino-cloud cloud-two"/>
  <div className="dino-track">
   <div ref={dinoRef} className={`dino-character${jumping?" is-jumping":""}`}><PixelDino/></div>
   <div key={runId} ref={obstacleRef} className="dino-obstacle"><PixelCactus/></div>
   <div className="dino-ground"/>
  </div>
  <span className="dino-prompt">{prompt}</span>
 </div>
}
