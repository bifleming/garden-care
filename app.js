/* Garden Care PWA (proof-of-concept) — client-side only, data in localStorage.
   Ports the essentials from the Flask app: zone-keyed library import, the
   Saturday-batching "this week" view, plant list, add-plant. No server. */
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
const USDA_ZONES = ["1a","1b","2a","2b","3a","3b","4a","4b","5a","5b","6a","6b",
  "7a","7b","8a","8b","9a","9b","10a","10b","11a","11b","12a","12b","13a","13b"];

// ─────────────────────────── helpers ───────────────────────────
const $ = (sel, el=document) => el.querySelector(sel);
const esc = s => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const linkify = s => esc(s||"").replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,
  (_,l,u)=>`<a class="link" target="_blank" rel="noopener" href="${u}">${l||"link"}</a>`);
function toast(msg) {
  const t = document.createElement("div"); t.className="toast"; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(), 2200);
}
const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
  september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,
  aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
function parseMD(s, year) {
  if (!s) return null;
  const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()]; if (!mo) return null;
  const d = new Date(year, mo-1, +m[2]);
  return isNaN(d) ? null : d;
}
function saturdayFor(d) {              // most recent Saturday on/before d
  const back = (d.getDay()+1)%7;       // JS Sat=6 -> 0
  const r = new Date(d); r.setDate(d.getDate()-back); r.setHours(0,0,0,0); return r;
}
const CAD_DAYS = {weekly:7, biweekly:14, "every 2 weeks":14, "every 3 weeks":21,
  "every 4 weeks":28, "every 6 weeks":42};
function* occurrences(start, end, cadence) {
  const c = (cadence||"").toLowerCase().trim();
  if (c==="once" || !c || !end) { yield start; return; }
  if (c==="monthly") {
    let d = new Date(start);
    while (d <= end) { yield new Date(d); d = new Date(d.getFullYear(), d.getMonth()+1, d.getDate()); }
    return;
  }
  let interval = CAD_DAYS[c] || 7;
  const m = c.match(/every\s+(\d+)\s+(week|day)s?/);
  if (m) interval = (+m[1]) * (m[2]==="week"?7:1);
  let d = new Date(start);
  while (d <= end) { yield new Date(d); d = new Date(d); d.setDate(d.getDate()+interval); }
}
const fmtSat = d => d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
const sameDay = (a,b) => a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();

// group all tasks into the Saturday batches that fall in [from, to]
function saturdayBatches(from, to) {
  const year = from.getFullYear();
  const batches = {};   // isoSat -> {date, byTask: {task:[{plant,product,notes,date}]}}
  for (const t of DB.tasks) {
    const start = parseMD(t.start, year); if (!start) continue;
    const end = t.end ? parseMD(t.end, year) : null;
    for (const occ of occurrences(start, end, t.cadence)) {
      const sat = saturdayFor(occ);
      if (sat < from || sat > to) continue;
      const key = sat.toISOString().slice(0,10);
      const b = batches[key] || (batches[key] = {date: sat, byTask:{}});
      (b.byTask[t.task] || (b.byTask[t.task]=[])).push(
        {plant:t.plant, product:t.product, notes:t.notes, date:occ});
    }
  }
  return Object.values(batches).sort((a,b)=>a.date-b.date);
}
function nonFeeders() {                // plants with no Fertilize task (mirror sync_tasks)
  const feed = new Set(DB.tasks.filter(t=>/fertil|feed/i.test(t.task)).map(t=>t.plant));
  return DB.plants.map(p=>p.name).filter(n=>!feed.has(n)).sort();
}

// ─────────────────────────── views ───────────────────────────
function viewSetup() {
  const s = DB.settings;
  return `<h1>Welcome 🌻</h1>
  <div class="card">
    <p class="muted">Pick your USDA hardiness zone so every plant's care dates are tuned to your climate.</p>
    <label>Hardiness zone</label>
    <select id="f-zone">${USDA_ZONES.map(z=>`<option ${z===s.zone?"selected":""}>${z}</option>`).join("")}</select>
    <label>Region (optional)</label>
    <input id="f-region" value="${esc(s.region||"")}" placeholder="e.g. Pacific NW, Seattle">
    <label>Climate notes (optional)</label>
    <textarea id="f-notes" placeholder="anything special about your spot">${esc(s.notes||"")}</textarea>
    <p></p><button class="full" id="save-zone">Save & pick plants</button>
  </div>`;
}
function viewHome() {
  const today = new Date(); today.setHours(0,0,0,0);
  const thisSat = saturdayFor(today);
  const to = new Date(thisSat); to.setDate(to.getDate()+21);  // this week + next 3
  const batches = saturdayBatches(thisSat, to);
  const nf = nonFeeders();
  let html = `<h1>This week & ahead</h1>`;
  if (!DB.plants.length) return html + emptyPlants();
  if (!batches.length) html += `<div class="card muted">No scheduled tasks in the next few weeks. 🌿</div>`;
  for (const b of batches) {
    const label = sameDay(b.date, thisSat) ? `${fmtSat(b.date)} · this week` : fmtSat(b.date);
    html += `<h2>${label}</h2><div class="card">`;
    for (const task of Object.keys(b.byTask).sort((a,b)=>a.localeCompare(b))) {
      const seen = new Set();
      const items = b.byTask[task]
        .filter(it => { const k=it.plant.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a,b)=>a.plant.localeCompare(b.plant));
      html += `<div class="task-line"><b>${esc(task)}</b> <span class="pill">${items.length}</span>`;
      html += items.map(it=>`<div class="muted">• ${esc(it.plant)}${it.product?` — ${linkify(it.product)}`:""}</div>`).join("");
      if (/fertil|feed/i.test(task) && nf.length)
        html += `<div class="warn">⚠ Do not fertilize: ${esc(nf.join(", "))}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  return html;
}
function emptyPlants() {
  return `<div class="empty"><div class="big">🌱</div>
    <p>No plants yet.</p>
    <a class="btn" href="#/add">Add plants from the library</a></div>`;
}
function viewPlants() {
  const plants = DB.plants.slice().sort((a,b)=>a.name.localeCompare(b.name));
  if (!plants.length) return `<h1>My plants</h1>` + emptyPlants();
  const counts = {}; DB.tasks.forEach(t=>counts[t.plant]=(counts[t.plant]||0)+1);
  return `<h1>My plants <span class="pill">${plants.length}</span></h1>` +
    plants.map(p=>`<div class="card plant-row">
      ${p.photo_path&&p.photo_path.startsWith("http")?`<img src="${esc(p.photo_path)}" loading="lazy" alt="">`:`<img alt="">`}
      <div><div class="pname">${esc(p.name)}</div>
      <div class="muted">${counts[p.name]||0} care task${(counts[p.name]||0)===1?"":"s"}</div></div>
    </div>`).join("");
}
function viewAdd() {
  const zone = DB.settings.zone || "8b";
  const existing = new Set(DB.plants.map(p=>p.name.toLowerCase()));
  const entries = Object.entries(LIBRARY.plants||{}).sort((a,b)=>a[0].localeCompare(b[0]));
  return `<h1>Add plants</h1>
   <p class="muted">From the starter library, with care dates for <b>Zone ${esc(zone)}</b>.</p>
   <div class="search"><input id="lib-search" placeholder="Search plants…"></div>
   <form id="lib-form">
   <div id="lib-list">${entries.map(([name,e])=>{
      const added = existing.has(name.toLowerCase());
      const n = (e.zones&&(e.zones[zone]||e.zones["8b"])||[]).length;
      return `<label class="lib-item ${added?"added":""}" data-name="${esc(name.toLowerCase())}">
        <input type="checkbox" name="pick" value="${esc(name)}" ${added?"disabled":""}>
        ${e.photo_path&&e.photo_path.startsWith("http")?`<img src="${esc(e.photo_path)}" loading="lazy" alt="">`:`<img alt="">`}
        <div><div class="pname">${esc(name)} ${added?'<span class="pill">added</span>':""}</div>
        <div class="muted">${esc((e.description||"").slice(0,90))}${(e.description||"").length>90?"…":""}</div>
        <div class="muted">${n} task${n===1?"":"s"} for your zone</div></div>
      </label>`;
    }).join("")}</div>
   <p></p><button class="full" id="import-btn" type="submit">Add selected plants</button>
   </form>`;
}
function viewSettings() {
  const s = DB.settings;
  return `<h1>Settings</h1>
   <div class="card"><div class="row-between"><div><b>Hardiness zone</b><div class="muted">${esc(s.zone||"not set")}${s.region?" · "+esc(s.region):""}</div></div>
     <a class="btn secondary" href="#/setup">Change</a></div></div>
   <div class="card"><b>Your garden</b><div class="muted">${DB.plants.length} plants · ${DB.tasks.length} care tasks</div></div>
   <div class="card"><b>Backup</b>
     <p class="muted">Your garden lives on this device. Export a copy or move it to another phone.</p>
     <div class="row-between"><button class="secondary" id="export-btn">Export</button>
     <button class="secondary" id="import-file-btn">Import</button></div>
     <input type="file" id="import-file" accept="application/json" hidden>
   </div>
   <div class="card muted">Proof-of-concept · phone reminders (Google Tasks sync) come in the full version.</div>`;
}

// ─────────────────────────── actions ───────────────────────────
function importSelected(names) {
  const zone = DB.settings.zone || "8b";
  const plants = DB.plants, tasks = DB.tasks;
  const have = new Set(plants.map(p=>p.name.toLowerCase()));
  let nextId = tasks.reduce((m,t)=>Math.max(m,t.id||0),0)+1, added=0, addedTasks=0;
  for (const name of names) {
    if (have.has(name.toLowerCase())) continue;
    const e = LIBRARY.plants[name]; if (!e) continue;
    const zt = (e.zones&&(e.zones[zone]||e.zones["8b"]))||[];
    if (!zt.length) continue;
    plants.push({name, description:e.description||"", photo_path:e.photo_path||""});
    for (const t of zt) {
      tasks.push({id:nextId++, plant:name, task:t.task||"", product:t.product||"",
        cadence:t.cadence||"", start:t.start||"", end:t.end||"", notes:t.notes||""});
      addedTasks++;
    }
    have.add(name.toLowerCase()); added++;
  }
  DB.plants = plants; DB.tasks = tasks;
  return {added, addedTasks};
}

// ─────────────────────────── router ───────────────────────────
function render() {
  const app = $("#app"), tabbar = $("#tabbar"), zoneChip = $("#zone-chip");
  const hasZone = !!DB.settings.zone;
  let route = location.hash.replace(/^#\//,"") || (hasZone ? "home" : "setup");
  if (!hasZone && route!=="setup") route = "setup";

  zoneChip.hidden = !hasZone; if (hasZone) zoneChip.textContent = "Zone "+DB.settings.zone;
  tabbar.hidden = !hasZone || route==="setup";
  [...tabbar.querySelectorAll("a")].forEach(a=>a.classList.toggle("active", a.dataset.tab===route));

  const views = {setup:viewSetup, home:viewHome, plants:viewPlants, add:viewAdd, settings:viewSettings};
  app.innerHTML = (views[route]||viewHome)();
  app.scrollTo?.(0,0); window.scrollTo(0,0);
  wire(route);
}
function wire(route) {
  if (route==="setup") {
    $("#save-zone").onclick = () => {
      DB.settings = {zone:$("#f-zone").value, region:$("#f-region").value.trim(), notes:$("#f-notes").value.trim()};
      location.hash = DB.plants.length ? "#/home" : "#/add";
      toast("Zone saved");
    };
  }
  if (route==="add") {
    const search = $("#lib-search");
    if (search) search.oninput = () => {
      const q = search.value.toLowerCase();
      $("#lib-list").querySelectorAll(".lib-item").forEach(el=>
        el.style.display = el.dataset.name.includes(q) ? "" : "none");
    };
    $("#lib-form").onsubmit = (e) => {
      e.preventDefault();
      const picks = [...e.target.querySelectorAll('input[name=pick]:checked')].map(i=>i.value);
      if (!picks.length) { toast("Nothing selected"); return; }
      const r = importSelected(picks);
      toast(`Added ${r.added} plant${r.added===1?"":"s"} (${r.addedTasks} tasks)`);
      location.hash = "#/home";
    };
  }
  if (route==="settings") {
    $("#export-btn").onclick = () => {
      const blob = new Blob([JSON.stringify({settings:DB.settings,plants:DB.plants,tasks:DB.tasks},null,2)],
        {type:"application/json"});
      const a = document.createElement("a"); a.href=URL.createObjectURL(blob);
      a.download="garden-care-backup.json"; a.click();
    };
    $("#import-file-btn").onclick = () => $("#import-file").click();
    $("#import-file").onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { try {
        const d = JSON.parse(rd.result);
        if (d.settings) DB.settings=d.settings;
        if (d.plants) DB.plants=d.plants;
        if (d.tasks) DB.tasks=d.tasks;
        toast("Garden imported"); render();
      } catch { toast("Couldn't read that file"); } };
      rd.readAsText(f);
    };
  }
}

// ─────────────────────────── boot ───────────────────────────
fetch("library.json").then(r=>r.json()).then(lib=>{ LIBRARY = lib; render(); })
  .catch(()=>{ document.getElementById("app").innerHTML =
    '<div class="empty"><div class="big">⚠</div><p>Couldn\'t load the plant library.</p></div>'; });
window.addEventListener("hashchange", render);
