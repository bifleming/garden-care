/* Google Tasks sync for the Garden Care PWA.
   Uses Google Identity Services (browser token model — no client secret) to get
   a Tasks API access token, then pushes the Saturday-batched schedule to a
   "Garden Care" task list. Idempotent: each task embeds [gardenCareId:xxx] in
   its notes; re-syncs patch existing tasks and delete orphans. Mirrors the
   desktop sync_tasks.py behaviour, adapted to run entirely in the browser. */
"use strict";
const GSync = (() => {
  const SCOPE = "https://www.googleapis.com/auth/tasks";
  const LIST_NAME = "Garden Care";
  let tokenClient = null, accessToken = null, tokenExpiry = 0;

  const clientId = () => (window.GC_CONFIG && window.GC_CONFIG.googleClientId) || "";
  const available = () => !!clientId();

  // cheap stable hash (cyrb53) -> hex; gardenCareId need only be stable, not crypto
  function gid(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }
  const stripLinks = s => (s || "").replace(/\s*\[[^\]]*\]\([^)]*\)/g, "").trim();

  function ensureClient() {
    if (tokenClient) return;
    if (!window.google || !google.accounts || !google.accounts.oauth2)
      throw new Error("Google sign-in didn't load. Check your connection and retry.");
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(), scope: SCOPE, callback: () => {},
    });
  }
  function getToken(interactive) {
    return new Promise((resolve, reject) => {
      if (accessToken && Date.now() < tokenExpiry - 60000) return resolve(accessToken);
      ensureClient();
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        localStorage.setItem("gc_google_connected", "1");
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    });
  }
  async function api(token, method, path, body) {
    const r = await fetch("https://tasks.googleapis.com/tasks/v1/" + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`Tasks API ${method} ${path} -> ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }

  async function ensureList(token) {
    const r = await api(token, "GET", "users/@me/lists?maxResults=100");
    const found = (r.items || []).find(l => l.title === LIST_NAME);
    if (found) return found.id;
    const made = await api(token, "POST", "users/@me/lists", { title: LIST_NAME });
    return made.id;
  }
  async function indexExisting(token, listId) {
    const idx = {}; let pageToken = null;
    do {
      const q = `lists/${listId}/tasks?showCompleted=true&showHidden=true&maxResults=100` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const r = await api(token, "GET", q);
      for (const t of (r.items || [])) {
        const m = (t.notes || "").match(/\[gardenCareId:([a-f0-9]+)\]/);
        if (m) idx[m[1]] = t;
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    return idx;
  }
  function notesFor(items, id, taskName, nonFeeders) {
    const isFert = /fertil|feed/i.test(taskName);
    const lines = items
      .slice().sort((a, b) => a.plant.localeCompare(b.plant))
      .map(it => `• ${it.plant}` + (it.product ? ` — ${stripLinks(it.product)}` : ""));
    if (isFert && nonFeeders.length) {
      lines.push("", "⚠ DO NOT FERTILIZE: " + nonFeeders.join(", "),
        "(drought-tolerant natives / Mediterranean herbs — feeding causes floppy growth or rot)");
    }
    lines.push("", `[gardenCareId:${id}]`);
    let body = lines.join("\n");
    if (body.length > 7800) body = body.slice(0, 7740) + "\n… (open Garden Care for the full list)\n[gardenCareId:" + id + "]";
    return body;
  }

  // units: [{sat: Date, satISO: "YYYY-MM-DD", task, items:[{plant,product}]}]
  async function sync(units, nonFeeders, log = () => {}) {
    if (!available()) throw new Error("Google sign-in isn't configured yet (no Client ID).");
    log("Connecting to Google…");
    const token = await getToken(false).catch(() => getToken(true));
    log("Opening your Garden Care task list…");
    const listId = await ensureList(token);
    const existing = await indexExisting(token, listId);
    let created = 0, updated = 0, unchanged = 0, deleted = 0;
    const seen = new Set();
    for (const u of units) {
      const id = gid(u.satISO + "|" + u.task.toLowerCase().trim());
      seen.add(id);
      const due = u.satISO + "T00:00:00.000Z";
      const notes = notesFor(u.items, id, u.task, nonFeeders);
      const ex = existing[id];
      if (ex) {
        if ((ex.title || "") !== u.task || (ex.notes || "") !== notes || (ex.due || "").slice(0, 10) !== u.satISO) {
          await api(token, "PATCH", `lists/${listId}/tasks/${ex.id}`, { title: u.task, notes, due });
          updated++;
        } else unchanged++;
      } else {
        await api(token, "POST", `lists/${listId}/tasks`, { title: u.task, notes, due, status: "needsAction" });
        created++;
      }
    }
    for (const [id, t] of Object.entries(existing)) {
      if (!seen.has(id)) { await api(token, "DELETE", `lists/${listId}/tasks/${t.id}`); deleted++; }
    }
    const summary = `Synced: +${created} new, ~${updated} updated, −${deleted} removed, ${unchanged} unchanged.`;
    log(summary);
    return { created, updated, deleted, unchanged, summary };
  }

  function disconnect() {
    if (accessToken && window.google) google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; tokenExpiry = 0; localStorage.removeItem("gc_google_connected");
  }
  const isConnected = () => localStorage.getItem("gc_google_connected") === "1";
  return { available, sync, disconnect, isConnected };
})();
