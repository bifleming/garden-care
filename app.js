/* Garden Care PWA — full app. Client-side only: plants/tasks/settings in
   localStorage, photos in IndexedDB (idb.js), reminders via Google Tasks
   (gsync.js). Ports the desktop app's behaviour to the browser. */
"use strict";

// ─────────────────────────── store ───────────────────────────
const DB = {
  get settings() { return JSON.parse(localStorage.getItem("gc_settings") || "{}"); },
  set settings(v) { localStorage.setItem("gc_settings", JSON.stringify(v)); },
  get plants() { return JSON.parse(localStorage.getItem("gc_plants") || "[]"); },
  set plants(v) { localStorage.setItem("gc_plants", JSON.stringify(v)); },
  get tasks() { return JSON.parse(localStorage.getItem("gc_tasks") || "[]"); },
  set tasks(v) { localStorage.setItem("gc_tasks", JSON.stringify(v)); },
};
let LIBRARY = { plants: {} };
let PHOTOS = {};   // {plantName: dataURL} loaded from IndexedDB
const USDA_ZONES = ["1a","1b","2a","2b","3a","3b","4a","4b","5a","5b","6a","6b",
  "7a","7b","8a","8b","9a","9b","10a","10b","11a","11b","12a","12b","13a","13b"];
const CADENCES = ["once","weekly","biweekly","every 2 weeks","every 3 weeks","every 4 weeks","every 6 weeks","monthly"];
const SKIP_SYNC = ["deadhead","water"];   // not pushed to Google Tasks (info-only)

// ─────────────────────────── helpers ───────────────────────────
const $ = (s, el=document) => el.querySelector(s);
const esc = s => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const enc = encodeURIComponent;
const linkify = s => esc(s||"").replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,
  (_,l,u)=>`<a class="link" target="_blank" rel="noopener" href="${u}">${l||"link"}</a>`);
function toast(m){ const t=document.createElement("div"); t.className="toast"; t.textContent=m;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2400); }
const MONTHS={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const MONTH_NAMES=["January","February","March","April","May","June","July","August","September","October","November","December"];
function parseMD(s,y){ if(!s) return null; const m=String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2})/); if(!m) return null;
  const mo=MONTHS[m[1].toLowerCase()]; if(!mo) return null; const d=new Date(y,mo-1,+m[2]); return isNaN(d)?null:d; }
function saturdayFor(d){ const b=(d.getDay()+1)%7; const r=new Date(d); r.setDate(d.getDate()-b); r.setHours(0,0,0,0); return r; }
const CAD_DAYS={weekly:7,biweekly:14,"every 2 weeks":14,"every 3 weeks":21,"every 4 weeks":28,"every 6 weeks":42};
function* occurrences(start,end,cadence){
  const c=(cadence||"").toLowerCase().trim();
  if(c==="once"||!c||!end){ yield start; return; }
  if(c==="monthly"){ let d=new Date(start); while(d<=end){ yield new Date(d); d=new Date(d.getFullYear(),d.getMonth()+1,d.getDate()); } return; }
  let iv=CAD_DAYS[c]||7; const m=c.match(/every\s+(\d+)\s+(week|day)s?/); if(m) iv=(+m[1])*(m[2]==="week"?7:1);
  let d=new Date(start); while(d<=end){ yield new Date(d); d=new Date(d); d.setDate(d.getDate()+iv); }
}
const fmtSat=d=>d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
const isoDay=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const skip=t=>SKIP_SYNC.some(p=>(t||"").toLowerCase().includes(p));
function photoFor(p){ return PHOTOS[p.name] || (p.photo_path&&p.photo_path.startsWith("http")?p.photo_path:""); }
function nonFeeders(){ const feed=new Set(DB.tasks.filter(t=>/fertil|feed/i.test(t.task)).map(t=>t.plant));
  return DB.plants.map(p=>p.name).filter(n=>!feed.has(n)).sort((a,b)=>a.localeCompare(b)); }
function plantByName(n){ return DB.plants.find(p=>p.name.toLowerCase()===(n||"").toLowerCase()); }
function tasksOf(n){ return DB.tasks.filter(t=>t.plant.toLowerCase()===(n||"").toLowerCase()); }
function nextTaskId(){ return DB.tasks.reduce((m,t)=>Math.max(m,t.id||0),0)+1; }

// Saturday batches across a window — used by home & month
function batchesBetween(from,to,opts={}){
  const year=from.getFullYear(); const out={};
  for(const t of DB.tasks){
    if(opts.skipSync && skip(t.task)) continue;
    const s=parseMD(t.start,year); if(!s) continue;
    const end=t.end?parseMD(t.end,year):null;
    for(const o of occurrences(s,end,t.cadence)){
      const sat=saturdayFor(o); if(sat<from||sat>to) continue;
      const k=isoDay(sat); const b=out[k]||(out[k]={date:sat,byTask:{}});
      (b.byTask[t.task]||(b.byTask[t.task]=[])).push({plant:t.plant,product:t.product,notes:t.notes,date:o});
    }
  }
  return Object.values(out).sort((a,b)=>a.date-b.date);
}
function dedupeItems(items){ const seen=new Set(); return items.filter(it=>{const k=it.plant.toLowerCase();
  if(seen.has(k))return false; seen.add(k); return true;}).sort((a,b)=>a.plant.localeCompare(b.plant)); }

// sync units for the whole year (skip info-only tasks)
function buildSyncUnits(){
  const year=new Date().getFullYear();
  const from=new Date(year,0,1), to=new Date(year,11,31);
  const batches=batchesBetween(from,to,{skipSync:true});
  const units=[];
  for(const b of batches) for(const task of Object.keys(b.byTask))
    units.push({sat:b.date, satISO:isoDay(b.date), task, items:dedupeItems(b.byTask[task])});
  return units;
}

// ─────────────────────────── views ───────────────────────────
function viewSetup(){ const s=DB.settings; return `<h1>Welcome 🌻</h1>
  <div class="card"><p class="muted">Pick your USDA hardiness zone so every plant's care dates are tuned to your climate.</p>
  <label>Hardiness zone</label><select id="f-zone">${USDA_ZONES.map(z=>`<option ${z===s.zone?"selected":""}>${z}</option>`).join("")}</select>
  <label>Region (optional)</label><input id="f-region" value="${esc(s.region||"")}" placeholder="e.g. Pacific NW, Seattle">
  <label>Climate notes (optional)</label><textarea id="f-notes" placeholder="anything special about your spot">${esc(s.notes||"")}</textarea>
  <p></p><button class="full" id="save-zone">Save & pick plants</button></div>`; }

function emptyPlants(){ return `<div class="empty"><div class="big">🌱</div><p>No plants yet.</p>
  <a class="btn" href="#/add">Add plants from the library</a></div>`; }

function viewHome(){
  const today=new Date(); today.setHours(0,0,0,0); const thisSat=saturdayFor(today);
  const to=new Date(thisSat); to.setDate(to.getDate()+28);
  const batches=batchesBetween(thisSat,to); const nf=nonFeeders();
  let html=`<h1>This week & ahead</h1>`;
  if(!DB.plants.length) return html+emptyPlants();
  if(!GSync.isConnected())
    html+=`<div class="banner row-between"><span>📲 Get these as phone reminders</span><a class="btn" href="#/settings">Set up</a></div>`;
  if(!batches.length) html+=`<div class="card muted">Nothing scheduled in the next few weeks. 🌿</div>`;
  for(const b of batches){
    const label=sameDay(b.date,thisSat)?`${fmtSat(b.date)} · this week`:fmtSat(b.date);
    html+=`<h2>${label}</h2><div class="card">`;
    for(const task of Object.keys(b.byTask).sort((a,b)=>a.localeCompare(b))){
      const items=dedupeItems(b.byTask[task]);
      html+=`<div class="task-line"><b>${esc(task)}</b> <span class="pill">${items.length}</span>`+
        items.map(it=>`<div class="muted">• ${esc(it.plant)}${it.product?` — ${linkify(it.product)}`:""}</div>`).join("");
      if(/fertil|feed/i.test(task)&&nf.length) html+=`<div class="warn">⚠ Do not fertilize: ${esc(nf.join(", "))}</div>`;
      html+=`</div>`;
    }
    html+=`</div>`;
  }
  return html;
}
function viewPlants(){
  const plants=DB.plants.slice().sort((a,b)=>a.name.localeCompare(b.name));
  if(!plants.length) return `<h1>My plants</h1>`+emptyPlants();
  const counts={}; DB.tasks.forEach(t=>counts[t.plant]=(counts[t.plant]||0)+1);
  return `<div class="row-between"><h1>My plants <span class="pill">${plants.length}</span></h1>
    <a class="btn secondary" href="#/add">Add</a></div>`+
    plants.map(p=>{ const ph=photoFor(p); return `<a class="card plant-row" href="#/plant/${enc(p.name)}">
      ${ph?`<img src="${esc(ph)}" loading="lazy" alt="">`:`<img alt="">`}
      <div><div class="pname">${esc(p.name)}</div>
      <div class="muted">${counts[p.name]||0} care task${(counts[p.name]||0)===1?"":"s"}</div></div></a>`; }).join("");
}
function viewPlant(name){
  const p=plantByName(name); if(!p) return `<p class="muted">Plant not found.</p><a class="btn" href="#/plants">Back</a>`;
  const ph=photoFor(p); const ts=tasksOf(p.name);
  let html=`<a class="link" href="#/plants">‹ Plants</a><h1>${esc(p.name)}</h1>
   <div class="card">${ph?`<img src="${esc(ph)}" alt="" style="width:100%;max-height:240px;object-fit:cover;border-radius:10px">`:""}
     ${p.description?`<p class="muted">${esc(p.description)}</p>`:""}
     <div class="row-between"><label style="margin:0">Photo</label>
       <span><button class="secondary" id="up-photo">Upload</button>${PHOTOS[p.name]?` <button class="secondary" id="rm-photo">Remove</button>`:""}</span></div>
     <input type="file" id="photo-file" accept="image/*" hidden>
   </div>
   <div class="row-between"><h2 style="margin:0">Care tasks</h2><a class="btn secondary" href="#/addtask/${enc(p.name)}">+ Task</a></div>`;
  if(!ts.length) html+=`<div class="card muted">No tasks yet.</div>`;
  for(const t of ts){
    html+=`<div class="card"><div class="row-between"><b>${esc(t.task)}</b>
      <span><a class="link" href="#/edit/${t.id}">Edit</a> · <a class="link" data-del="${t.id}" href="#">Delete</a></span></div>
      <div class="muted">${esc(t.cadence||"once")} · ${esc(t.start||"?")}${t.end?` → ${esc(t.end)}`:""}</div>
      ${t.product?`<div class="muted">How: ${linkify(t.product)}</div>`:""}
      ${t.notes?`<div class="muted">${linkify(t.notes)}</div>`:""}</div>`;
  }
  html+=`<p></p><button class="secondary" id="del-plant">Delete this plant</button>`;
  return html;
}
function taskForm(t,heading,plantName){
  return `<h1>${heading}</h1><div class="card">
   <label>Task</label><input id="t-task" value="${esc(t.task||"")}" placeholder="e.g. Prune">
   <label>Product / how</label><input id="t-product" value="${esc(t.product||"")}" placeholder="optional">
   <label>Cadence</label><select id="t-cadence">${CADENCES.map(c=>`<option ${c===(t.cadence||"once")?"selected":""}>${c}</option>`).join("")}</select>
   <label>Start (Month Day)</label><input id="t-start" value="${esc(t.start||"")}" placeholder="e.g. April 1">
   <label>End (optional, for repeating)</label><input id="t-end" value="${esc(t.end||"")}" placeholder="e.g. August 31">
   <label>Notes</label><textarea id="t-notes">${esc(t.notes||"")}</textarea>
   <p></p><div class="row-between"><button id="t-save">Save</button>
     <a class="btn secondary" href="#/plant/${enc(plantName)}">Cancel</a></div></div>`;
}
function viewEdit(id){ const t=DB.tasks.find(x=>x.id===+id); if(!t) return `<p>Task not found.</p>`;
  return taskForm(t,"Edit task",t.plant); }
function viewAddTask(name){ return taskForm({},"Add task — "+name,name); }

function viewAdd(){
  const zone=DB.settings.zone||"8b"; const existing=new Set(DB.plants.map(p=>p.name.toLowerCase()));
  const entries=Object.entries(LIBRARY.plants||{}).sort((a,b)=>a[0].localeCompare(b[0]));
  return `<div class="row-between"><h1>Add plants</h1><a class="btn secondary" href="#/addplant">Custom</a></div>
   <p class="muted">From the starter library, with dates for <b>Zone ${esc(zone)}</b>.</p>
   <div class="search"><input id="lib-search" placeholder="Search plants…"></div>
   <form id="lib-form"><div id="lib-list">${entries.map(([name,e])=>{
      const added=existing.has(name.toLowerCase()); const n=(e.zones&&(e.zones[zone]||e.zones["8b"])||[]).length;
      return `<label class="lib-item ${added?"added":""}" data-name="${esc(name.toLowerCase())}">
        <input type="checkbox" name="pick" value="${esc(name)}" ${added?"disabled":""}>
        ${e.photo_path&&e.photo_path.startsWith("http")?`<img src="${esc(e.photo_path)}" loading="lazy" alt="">`:`<img alt="">`}
        <div><div class="pname">${esc(name)} ${added?'<span class="pill">added</span>':""}</div>
        <div class="muted">${esc((e.description||"").slice(0,90))}${(e.description||"").length>90?"…":""}</div>
        <div class="muted">${n} task${n===1?"":"s"} for your zone</div></div></label>`;
    }).join("")}</div><p></p><button class="full" id="import-btn" type="submit">Add selected plants</button></form>`;
}
function viewAddPlant(){ return `<a class="link" href="#/add">‹ Library</a><h1>Add a custom plant</h1>
  <div class="card"><label>Plant name</label><input id="np-name" placeholder="e.g. Sweet pea">
   <label>Description (optional)</label><textarea id="np-desc"></textarea>
   <p></p><button id="np-save">Create plant</button>
   <p class="muted">You'll add its care tasks next.</p></div>`; }

function viewMonth(m){
  const year=new Date().getFullYear(); const from=new Date(year,0,1), to=new Date(year,11,31);
  const byTask={};
  for(const t of DB.tasks){ const s=parseMD(t.start,year); if(!s) continue; const end=t.end?parseMD(t.end,year):null;
    let hit=false; for(const o of occurrences(s,end,t.cadence)) if(o.getMonth()+1===m){hit=true;break;}
    if(hit)(byTask[t.task]||(byTask[t.task]=[])).push(t.plant); }
  const sel=MONTH_NAMES.map((nm,i)=>`<option value="${i+1}" ${i+1===m?"selected":""}>${nm}</option>`).join("");
  let html=`<h1>By month</h1><select id="month-sel">${sel}</select>`;
  const tasks=Object.keys(byTask).sort((a,b)=>a.localeCompare(b));
  if(!tasks.length) html+=`<div class="card muted">Nothing scheduled in ${MONTH_NAMES[m-1]}.</div>`;
  for(const task of tasks){ const plants=[...new Set(byTask[task])].sort();
    html+=`<div class="card"><b>${esc(task)}</b> <span class="pill">${plants.length}</span>
      <div class="muted">${esc(plants.join(", "))}</div></div>`; }
  return html;
}
function viewSettings(){ const s=DB.settings; const conn=GSync.isConnected(); const avail=GSync.available();
  return `<h1>Settings</h1>
   <div class="card"><div class="row-between"><div><b>Hardiness zone</b><div class="muted">${esc(s.zone||"not set")}${s.region?" · "+esc(s.region):""}</div></div>
     <a class="btn secondary" href="#/setup">Change</a></div></div>
   <div class="card"><b>📲 Phone reminders (Google Tasks)</b>
     <p class="muted">Push your care schedule to Google Tasks so it shows up in the Google Tasks / Calendar app on your phone.</p>
     ${!avail?`<div class="warn">Not set up yet — a Google sign-in Client ID is still being configured.</div>`
       :conn?`<div class="row-between"><button id="sync-btn">Sync now</button><button class="secondary" id="disc-btn">Disconnect</button></div>`
       :`<button id="connect-btn">Connect Google account</button>`}
     <div id="sync-log" class="muted" style="margin-top:8px;white-space:pre-wrap"></div></div>
   <div class="card"><a href="#/month/${new Date().getMonth()+1}" class="btn secondary">📅 Browse by month</a></div>
   <div class="card"><b>Backup</b><p class="muted">Your garden lives on this device. Export a copy or move it to another phone.</p>
     <div class="row-between"><button class="secondary" id="export-btn">Export</button><button class="secondary" id="import-file-btn">Import</button></div>
     <input type="file" id="import-file" accept="application/json" hidden></div>
   <div class="card muted">${DB.plants.length} plants · ${DB.tasks.length} tasks${conn?" · Google connected":""}</div>`;
}

// ─────────────────────────── actions ───────────────────────────
function importSelected(names){
  const zone=DB.settings.zone||"8b"; const plants=DB.plants, tasks=DB.tasks;
  const have=new Set(plants.map(p=>p.name.toLowerCase())); let id=nextTaskId(), added=0, addedTasks=0;
  for(const name of names){ if(have.has(name.toLowerCase())) continue; const e=LIBRARY.plants[name]; if(!e) continue;
    const zt=(e.zones&&(e.zones[zone]||e.zones["8b"]))||[]; if(!zt.length) continue;
    plants.push({name,description:e.description||"",photo_path:e.photo_path||""});
    for(const t of zt){ tasks.push({id:id++,plant:name,task:t.task||"",product:t.product||"",cadence:t.cadence||"",start:t.start||"",end:t.end||"",notes:t.notes||""}); addedTasks++; }
    have.add(name.toLowerCase()); added++; }
  DB.plants=plants; DB.tasks=tasks; return {added,addedTasks};
}
function resizeToDataURL(file,max=900){ return new Promise((res,rej)=>{ const img=new Image(); const rd=new FileReader();
  rd.onload=()=>{ img.onload=()=>{ const sc=Math.min(1,max/Math.max(img.width,img.height));
    const c=document.createElement("canvas"); c.width=Math.round(img.width*sc); c.height=Math.round(img.height*sc);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height); res(c.toDataURL("image/jpeg",0.82)); };
    img.onerror=rej; img.src=rd.result; }; rd.onerror=rej; rd.readAsDataURL(file); }); }

// ─────────────────────────── router ───────────────────────────
function parseRoute(){ const raw=location.hash.replace(/^#\/?/,""); const parts=raw.split("/");
  return {name:parts[0]||"", arg:parts[1]?decodeURIComponent(parts[1]):""}; }
function render(){
  const app=$("#app"), tabbar=$("#tabbar"), chip=$("#zone-chip");
  const hasZone=!!DB.settings.zone; let {name:route,arg}=parseRoute();
  if(!route) route=hasZone?"home":"setup"; if(!hasZone&&route!=="setup") route="setup";
  chip.hidden=!hasZone; if(hasZone) chip.textContent="Zone "+DB.settings.zone;
  const TABS={home:1,plants:1,add:1,settings:1};
  tabbar.hidden=!hasZone||route==="setup";
  [...tabbar.querySelectorAll("a")].forEach(a=>a.classList.toggle("active",a.dataset.tab===route));
  const V={setup:viewSetup,home:viewHome,plants:viewPlants,plant:()=>viewPlant(arg),edit:()=>viewEdit(arg),
    addtask:()=>viewAddTask(arg),add:viewAdd,addplant:viewAddPlant,month:()=>viewMonth(+arg||new Date().getMonth()+1),
    settings:viewSettings};
  app.innerHTML=(V[route]||viewHome)(); window.scrollTo(0,0); wire(route,arg);
}
function wire(route,arg){
  if(route==="setup") $("#save-zone").onclick=()=>{ DB.settings={zone:$("#f-zone").value,region:$("#f-region").value.trim(),notes:$("#f-notes").value.trim()};
    location.hash=DB.plants.length?"#/home":"#/add"; toast("Zone saved"); };
  if(route==="add"){
    const s=$("#lib-search"); if(s) s.oninput=()=>{ const q=s.value.toLowerCase();
      $("#lib-list").querySelectorAll(".lib-item").forEach(el=>el.style.display=el.dataset.name.includes(q)?"":"none"); };
    $("#lib-form").onsubmit=e=>{ e.preventDefault();
      const picks=[...e.target.querySelectorAll('input[name=pick]:checked')].map(i=>i.value);
      if(!picks.length){ toast("Nothing selected"); return; }
      const r=importSelected(picks); toast(`Added ${r.added} plant${r.added===1?"":"s"} (${r.addedTasks} tasks)`); location.hash="#/plants"; };
  }
  if(route==="addplant") $("#np-save").onclick=()=>{ const name=$("#np-name").value.trim(); if(!name){toast("Name required");return;}
    if(plantByName(name)){ toast("Already exists"); return; }
    DB.plants=[...DB.plants,{name,description:$("#np-desc").value.trim(),photo_path:""}]; toast("Plant created"); location.hash=`#/addtask/${enc(name)}`; };
  if(route==="edit"||route==="addtask"){
    $("#t-save").onclick=()=>{ const data={task:$("#t-task").value.trim(),product:$("#t-product").value.trim(),
      cadence:$("#t-cadence").value,start:$("#t-start").value.trim(),end:$("#t-end").value.trim(),notes:$("#t-notes").value.trim()};
      if(!data.task){ toast("Task name required"); return; }
      if(route==="edit"){ const id=+arg; DB.tasks=DB.tasks.map(t=>t.id===id?{...t,...data}:t); var plant=DB.tasks.find(t=>t.id===id).plant; }
      else { const plant2=arg; DB.tasks=[...DB.tasks,{id:nextTaskId(),plant:plant2,...data}]; var plant=plant2; }
      toast("Saved"); location.hash=`#/plant/${enc(plant)}`; };
  }
  if(route==="plant"){
    const p=plantByName(arg);
    $("#up-photo").onclick=()=>$("#photo-file").click();
    $("#photo-file").onchange=async e=>{ const f=e.target.files[0]; if(!f)return; toast("Saving photo…");
      try{ const url=await resizeToDataURL(f); await Photos.set(p.name,url); PHOTOS[p.name]=url; render(); }catch{ toast("Couldn't read image"); } };
    const rm=$("#rm-photo"); if(rm) rm.onclick=async()=>{ await Photos.del(p.name); delete PHOTOS[p.name]; render(); };
    app.querySelectorAll("[data-del]").forEach(a=>a.onclick=ev=>{ ev.preventDefault();
      if(confirm("Delete this task?")){ DB.tasks=DB.tasks.filter(t=>t.id!==+a.dataset.del); render(); } });
    $("#del-plant").onclick=()=>{ if(confirm(`Delete ${p.name} and its tasks?`)){
      DB.tasks=DB.tasks.filter(t=>t.plant.toLowerCase()!==p.name.toLowerCase());
      DB.plants=DB.plants.filter(x=>x.name.toLowerCase()!==p.name.toLowerCase());
      Photos.del(p.name); delete PHOTOS[p.name]; location.hash="#/plants"; toast("Deleted"); } };
  }
  if(route==="month"){ const sel=$("#month-sel"); if(sel) sel.onchange=()=>location.hash=`#/month/${sel.value}`; }
  if(route==="settings"){
    const log=m=>{ const el=$("#sync-log"); if(el) el.textContent=m; };
    const cb=$("#connect-btn"); if(cb) cb.onclick=async()=>{ try{ await GSync.sync(buildSyncUnits(),nonFeeders(),log); render(); }
      catch(e){ log("⚠ "+e.message); } };
    const sb=$("#sync-btn"); if(sb) sb.onclick=async()=>{ sb.disabled=true; try{ const r=await GSync.sync(buildSyncUnits(),nonFeeders(),log); toast(r.summary); }
      catch(e){ log("⚠ "+e.message); } finally{ sb.disabled=false; } };
    const db_=$("#disc-btn"); if(db_) db_.onclick=()=>{ GSync.disconnect(); toast("Disconnected"); render(); };
    $("#export-btn").onclick=()=>{ const blob=new Blob([JSON.stringify({settings:DB.settings,plants:DB.plants,tasks:DB.tasks,photos:PHOTOS},null,2)],{type:"application/json"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="garden-care-backup.json"; a.click(); };
    $("#import-file-btn").onclick=()=>$("#import-file").click();
    $("#import-file").onchange=e=>{ const f=e.target.files[0]; if(!f)return; const rd=new FileReader();
      rd.onload=async()=>{ try{ const d=JSON.parse(rd.result); if(d.settings)DB.settings=d.settings; if(d.plants)DB.plants=d.plants; if(d.tasks)DB.tasks=d.tasks;
        if(d.photos){ for(const[k,v]of Object.entries(d.photos)){ await Photos.set(k,v); PHOTOS[k]=v; } } toast("Garden imported"); render(); }
        catch{ toast("Couldn't read that file"); } }; rd.readAsText(f); };
  }
}

// ─────────────────────────── boot ───────────────────────────
Promise.all([
  fetch("library.json").then(r=>r.json()).then(l=>LIBRARY=l).catch(()=>{}),
  Photos.all().then(p=>PHOTOS=p||{}).catch(()=>{}),
]).then(()=>{ render(); });
window.addEventListener("hashchange", render);
