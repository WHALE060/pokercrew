/* PokerCrew web client — vanilla JS, no build step. */
(() => {
  const $app = document.getElementById("app");
  const S = {
    token: localStorage.getItem("pc_token") || null,
    user: null,
    screen: "auth",
    params: {},
    clubs: [],
    invites: [],
    club: null,
    tables: [],
    requests: [],
    table: null,      // public table state
    you: null,        // private state
    ws: null,
    lastResult: null,
    raiseTo: 0,
    deviceId: localStorage.getItem("pc_device") || (localStorage.setItem("pc_device", crypto.randomUUID()), localStorage.getItem("pc_device")),
    admin: null,
  };

  // ---------- helpers ----------
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const initials = (n) => (n || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const PALETTE = ["#7F77DD", "#4FBFA0", "#EF9F27", "#C97B95", "#5DCAA5", "#D85A30", "#378ADD", "#D4537E", "#639922"];
  const colorFor = (code) => { let x = 0; for (const c of code || "") x = (x * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[x % PALETTE.length]; };
  const grad = (c) => `background: linear-gradient(160deg, ${c}cc, ${c} 60%, ${c}99)`;

  let toastT;
  function toast(msg, err = false) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const el = document.createElement("div");
    el.className = "toast" + (err ? " err" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastT);
    toastT = setTimeout(() => el.remove(), 3200);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-device-id": S.deviceId,
        ...(S.token ? { authorization: `Bearer ${S.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      if (res.status === 401 && S.token) { logout(false); }
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    return data;
  }

  function go(screen, params = {}) {
    S.screen = screen; S.params = params;
    render();
  }

  function setToken(t) { S.token = t; if (t) localStorage.setItem("pc_token", t); else localStorage.removeItem("pc_token"); }

  async function logout(callApi = true) {
    try { if (callApi) await api("POST", "/auth/logout"); } catch {}
    closeWs();
    setToken(null); S.user = null; go("auth");
  }

  // ---------- render root ----------
  function render() {
    const screens = { auth: renderAuth, lobby: renderLobby, club: renderClub, table: renderTable, profile: renderProfile, admin: renderAdmin };
    $app.innerHTML = "";
    (screens[S.screen] || renderLobby)();
  }

  function topbar(title, back) {
    return `<div class="topbar">
      ${back ? `<button class="back" data-go="${back}">&#8249;</button>` : `<div class="brand">PokerCrew<small>PRIVATE CLUBS</small></div>`}
      ${title ? `<div class="title">${h(title)}</div>` : ""}
      <div style="width:36px"></div>
    </div>`;
  }

  function nav(active) {
    const item = (id, label, path) => `<button class="${active === id ? "active" : ""}" data-go="${id}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>${label}</button>`;
    return `<div class="nav">
      ${item("lobby", "Clubs", '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/>')}
      ${item("profile", "Profile", '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>')}
      ${S.user?.role === "admin" ? item("admin", "Admin", '<path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 5-7"/>') : ""}
    </div>`;
  }

  // ---------- AUTH ----------
  let authTab = "login";
  let authMode = "code";
  let pending = null; // { email, displayName, password }

  function renderAuth() {
    $app.innerHTML = `<div class="screen">
      <div style="text-align:center;padding:28px 0 22px"><img src="/logo.svg" alt="PokerCrew" style="width:78%;max-width:340px"></div>
      <div class="tabs">
        <button class="${authTab === "login" ? "active" : ""}" data-tab="login">Sign in</button>
        <button class="${authTab === "signup" ? "active" : ""}" data-tab="signup">Create account</button>
      </div>
      <div class="card">
        ${authTab === "login" ? `
          <div class="tabs">
            <button class="${authMode === "code" ? "active" : ""}" data-mode="code">Email code</button>
            <button class="${authMode === "password" ? "active" : ""}" data-mode="password">Password</button>
          </div>
          <div class="field"><label>Email</label><input id="email" type="email" placeholder="you@example.com" autocomplete="email"></div>
          ${authMode === "password"
            ? `<div class="field"><label>Password</label><input id="password" type="password" autocomplete="current-password"></div>
               <button class="btn primary block" id="do-login-pw">Sign in</button>`
            : pending?.stage === "login-code"
              ? `<div class="field"><label>6-digit code sent to ${h(pending.email)}</label><input id="code" inputmode="numeric" maxlength="6" placeholder="123456"></div>
                 <button class="btn primary block" id="do-login-verify">Verify and sign in</button>
                 <p class="hint">Dev mode: the code is printed in the server console.</p>`
              : `<button class="btn primary block" id="do-login-request">Send me a code</button>`}
        ` : pending?.stage === "signup-code" ? `
          <p class="sub" style="margin:0 0 12px">We emailed a code to <b>${h(pending.email)}</b>. Your name <b>${h(pending.displayName)}</b> will be locked once confirmed.</p>
          <div class="field"><label>6-digit code</label><input id="code" inputmode="numeric" maxlength="6" placeholder="123456"></div>
          <button class="btn primary block" id="do-signup-complete">Confirm and create account</button>
          <p class="hint">Dev mode: the code is printed in the server console.</p>
        ` : `
          <div class="field"><label>Email</label><input id="email" type="email" placeholder="you@example.com"></div>
          <div class="field"><label>Display name (permanent — choose carefully)</label><input id="displayName" placeholder="3–16 letters, numbers, _"></div>
          <div class="field"><label>Password (optional — you can always sign in with an email code)</label><input id="password" type="password" placeholder="8+ characters"></div>
          <button class="btn primary block" id="do-signup-begin">Continue</button>
        `}
      </div>
    </div>`;

    $app.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { authTab = b.dataset.tab; pending = null; render(); });
    $app.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { authMode = b.dataset.mode; pending = null; render(); });
    const v = (id) => ($app.querySelector("#" + id)?.value || "").trim();

    bind("#do-signup-begin", async () => {
      const body = { email: v("email"), displayName: v("displayName") };
      if (v("password")) body.password = v("password");
      await api("POST", "/auth/signup/begin", body);
      pending = { ...body, stage: "signup-code" }; render();
    });
    bind("#do-signup-complete", async () => {
      const r = await api("POST", "/auth/signup/complete", { ...pending, code: v("code"), stage: undefined });
      await afterAuth(r); pending = null;
    });
    bind("#do-login-request", async () => {
      await api("POST", "/auth/login/code/request", { email: v("email") });
      pending = { email: v("email"), stage: "login-code" }; render();
      toast("If that email has an account, a code is on its way");
    });
    bind("#do-login-verify", async () => {
      const r = await api("POST", "/auth/login/code/verify", { email: pending.email, code: v("code") });
      await afterAuth(r); pending = null;
    });
    bind("#do-login-pw", async () => {
      const r = await api("POST", "/auth/login/password", { email: v("email"), password: v("password") });
      await afterAuth(r);
    });
  }

  function bind(sel, fn) {
    const el = $app.querySelector(sel);
    if (!el) return;
    el.onclick = async () => {
      el.disabled = true;
      try { await fn(); } catch (e) { toast(e.message, true); } finally { el.disabled = false; }
    };
  }

  async function afterAuth(r) {
    setToken(r.token); S.user = r.user;
    toast(`Welcome, ${r.user.displayName}`);
    await loadLobby(); go("lobby");
  }

  // ---------- LOBBY ----------
  async function loadLobby() {
    [S.clubs, S.invites] = await Promise.all([api("GET", "/clubs/mine"), api("GET", "/clubs/invites")]);
  }

  function renderLobby() {
    $app.innerHTML = `<div class="screen">
      ${topbar()}
      <div class="row" style="margin-bottom:12px">
        <div><div class="sub">Signed in as</div><div>${h(S.user.displayName)} <span class="pill mono">${h(S.user.playerCode)}</span></div></div>
        <div class="pill gold">${fmt(S.user.chips)} chips</div>
      </div>
      ${S.invites.length ? `<div class="sub" style="margin:6px 2px">Invitations</div>` +
        S.invites.map((c) => `<div class="card row"><div><b>${h(c.name)}</b><div class="sub">Invited by ${h(c.invitedBy)} · ${c.memberCount} members</div></div>
          <button class="btn sm primary" data-join="${h(c.clubCode)}">Join</button></div>`).join("") : ""}
      <div class="sub" style="margin:6px 2px">Your clubs</div>
      ${S.clubs.length ? S.clubs.map((c) => `<div class="card tap row" data-club="${c.clubId}">
          <div class="avatar" style="${grad(colorFor(c.clubCode))}">${initials(c.name)}</div>
          <div class="grow"><b>${h(c.name)}</b><div class="sub">${c.memberCount} members · <span class="mono">${h(c.clubCode)}</span></div></div>
          <span class="pill ${c.yourRole === "owner" ? "gold" : c.yourRole === "manager" ? "teal" : ""}">${c.yourRole}</span>
        </div>`).join("") : `<div class="empty">You're not in any clubs yet. Create one or join with a code.</div>`}
      <div class="btn-row" style="margin-top:8px">
        <button class="btn" id="join-club">Join with code</button>
        <button class="btn primary" id="create-club">Create a club</button>
      </div>
      ${nav("lobby")}
    </div>`;
    wireNav();
    $app.querySelectorAll("[data-club]").forEach((el) => el.onclick = () => openClub(el.dataset.club));
    $app.querySelectorAll("[data-join]").forEach((el) => el.onclick = () => joinByCode(el.dataset.join));
    bind("#join-club", () => modal(`
      <div class="title" style="margin-bottom:10px">Join a club</div>
      <div class="field"><label>Club code</label><input id="m-code" placeholder="CL-XXXXXX" class="mono"></div>
      <div class="field"><label>Message to the club (optional)</label><input id="m-msg" placeholder="Hey, it's me"></div>
      <button class="btn primary block" id="m-ok">Join</button>`,
      async (q) => joinByCode(q("#m-code").value, q("#m-msg").value)));
    bind("#create-club", () => modal(`
      <div class="title" style="margin-bottom:10px">Create a club</div>
      <div class="field"><label>Club name</label><input id="m-name" placeholder="Friday Night Crew"></div>
      <div class="field"><label>Description</label><input id="m-desc" placeholder="Optional"></div>
      <div class="field"><label>Who can join</label>
        <select id="m-mode"><option value="approval">Anyone can request, I approve</option><option value="open">Anyone with the code</option><option value="invite_only">Invite only</option></select></div>
      <button class="btn primary block" id="m-ok">Create</button>`,
      async (q) => {
        const c = await api("POST", "/clubs", { name: q("#m-name").value, description: q("#m-desc").value, joinMode: q("#m-mode").value });
        toast(`Club created · code ${c.clubCode}`);
        await loadLobby(); openClub(c.clubId);
      }));
  }

  async function joinByCode(code, message) {
    const r = await api("POST", `/clubs/code/${encodeURIComponent(code.trim())}/join`, { message: message || undefined });
    toast(r.status === "joined" ? `Joined ${r.club.name}` : `Request sent to ${r.club.name}`);
    await loadLobby(); render();
  }

  function modal(inner, onOk) {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal">${inner}</div>`;
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    document.body.appendChild(bg);
    const q = (s) => bg.querySelector(s);
    const ok = q("#m-ok");
    if (ok) ok.onclick = async () => {
      ok.disabled = true;
      try { await onOk(q); bg.remove(); } catch (e) { toast(e.message, true); ok.disabled = false; }
    };
    const first = bg.querySelector("input"); if (first) first.focus();
    return bg;
  }

  function wireNav() {
    $app.querySelectorAll("[data-go]").forEach((b) => b.onclick = async () => {
      const t = b.dataset.go;
      if (t === "lobby") { await loadLobby(); }
      if (t === "club" && S.club) { return openClub(S.club.clubId); }
      go(t);
    });
  }

  // ---------- CLUB ----------
  async function openClub(id) {
    S.club = await api("GET", `/clubs/${id}`);
    const staff = S.club.yourRole === "owner" || S.club.yourRole === "manager";
    [S.tables, S.requests] = await Promise.all([
      S.club.yourRole ? api("GET", `/clubs/${id}/tables`) : [],
      staff ? api("GET", `/clubs/${id}/requests`) : [],
    ]);
    go("club");
  }

  function renderClub() {
    const c = S.club, staff = c.yourRole === "owner" || c.yourRole === "manager", owner = c.yourRole === "owner";
    $app.innerHTML = `<div class="screen">
      ${topbar(c.name, "lobby")}
      <div class="card row">
        <div><div class="sub">Club code — share to invite</div><div class="code-big">${h(c.clubCode)}</div></div>
        <button class="btn sm" id="copy-code">Copy</button>
      </div>
      ${c.description ? `<p class="sub" style="margin:0 4px 12px">${h(c.description)}</p>` : ""}

      <div class="row" style="margin:8px 2px"><div class="sub">Tables</div>${staff ? `<button class="btn sm primary" id="new-table">New table</button>` : ""}</div>
      ${S.tables.length ? S.tables.map((t) => `<div class="card tap row" data-table="${t.tableId}">
          <div class="grow"><b>${h(t.name)}</b><div class="sub">Blinds ${fmt(t.blinds.small)}/${fmt(t.blinds.big)} · buy-in ${fmt(t.buyIn.min)}–${fmt(t.buyIn.max)}</div></div>
          <span class="pill ${t.seated ? "teal" : ""}">${t.seated}/${t.maxSeats} seated</span>
        </div>`).join("") : `<div class="empty">No tables running.${staff ? " Open one to get the game going." : ""}</div>`}

      ${staff && S.requests.length ? `<div class="sub" style="margin:14px 2px 8px">Join requests</div>` +
        S.requests.map((r) => `<div class="card row"><div class="grow"><b>${h(r.displayName)}</b> <span class="pill mono">${h(r.playerCode)}</span>${r.message ? `<div class="sub">“${h(r.message)}”</div>` : ""}</div>
          <button class="btn sm" data-reject="${h(r.playerCode)}">Decline</button><button class="btn sm primary" data-approve="${h(r.playerCode)}">Approve</button></div>`).join("") : ""}

      <div class="row" style="margin:14px 2px 8px"><div class="sub">Members (${c.memberCount})</div>${staff ? `<button class="btn sm" id="invite">Invite by player ID</button>` : ""}</div>
      ${(c.members || []).map((m) => `<div class="card row">
          <div class="avatar" style="${grad(colorFor(m.playerCode))}">${initials(m.displayName)}</div>
          <div class="grow"><b>${h(m.displayName)}</b><div class="sub mono">${h(m.playerCode)}</div></div>
          <span class="pill ${m.role === "owner" ? "gold" : m.role === "manager" ? "teal" : ""}">${m.role}</span>
          ${owner && m.role !== "owner" ? `<button class="btn sm ghost" data-role="${h(m.playerCode)}" data-to="${m.role === "manager" ? "member" : "manager"}">${m.role === "manager" ? "Demote" : "Promote"}</button>` : ""}
          ${staff && m.role === "member" ? `<button class="btn sm ghost danger" data-kick="${h(m.playerCode)}">Remove</button>` : ""}
        </div>`).join("")}

      <div class="divider"></div>
      ${c.yourRole && !owner ? `<button class="btn block danger" id="leave-club">Leave club</button>` : ""}
      ${owner ? `<button class="btn block danger" id="delete-club">Delete club</button>` : ""}
      ${nav("lobby")}
    </div>`;
    wireNav();
    const id = c.clubId;
    bind("#copy-code", async () => { await navigator.clipboard?.writeText(c.clubCode); toast("Club code copied"); });
    $app.querySelectorAll("[data-table]").forEach((el) => el.onclick = () => openTable(el.dataset.table));
    $app.querySelectorAll("[data-approve]").forEach((el) => el.onclick = async () => { try { await api("POST", `/clubs/${id}/requests/${el.dataset.approve}/approve`); toast("Approved"); openClub(id); } catch (e) { toast(e.message, true); } });
    $app.querySelectorAll("[data-reject]").forEach((el) => el.onclick = async () => { try { await api("POST", `/clubs/${id}/requests/${el.dataset.reject}/reject`); openClub(id); } catch (e) { toast(e.message, true); } });
    $app.querySelectorAll("[data-role]").forEach((el) => el.onclick = async () => { try { await api("POST", `/clubs/${id}/members/${el.dataset.role}/role`, { role: el.dataset.to }); openClub(id); } catch (e) { toast(e.message, true); } });
    $app.querySelectorAll("[data-kick]").forEach((el) => el.onclick = async () => { if (!confirm("Remove this member?")) return; try { await api("DELETE", `/clubs/${id}/members/${el.dataset.kick}`); openClub(id); } catch (e) { toast(e.message, true); } });
    bind("#invite", () => modal(`
      <div class="title" style="margin-bottom:10px">Invite a player</div>
      <div class="field"><label>Their player ID</label><input id="m-code" placeholder="PC-XXXXXX" class="mono"></div>
      <button class="btn primary block" id="m-ok">Send invite</button>`,
      async (q) => { const r = await api("POST", `/clubs/${id}/invite`, { playerCode: q("#m-code").value }); toast(`Invited ${r.displayName}`); }));
    bind("#new-table", () => modal(`
      <div class="title" style="margin-bottom:10px">Open a table</div>
      <div class="field"><label>Table name</label><input id="m-name" placeholder="Main table"></div>
      <div class="grid2">
        <div class="field"><label>Small blind</label><input id="m-sb" type="number" value="5"></div>
        <div class="field"><label>Big blind</label><input id="m-bb" type="number" value="10"></div>
        <div class="field"><label>Min buy-in</label><input id="m-min" type="number" value="200"></div>
        <div class="field"><label>Max buy-in</label><input id="m-max" type="number" value="2000"></div>
      </div>
      <div class="field"><label>Seats</label><select id="m-seats"><option>6</option><option selected>9</option><option>2</option></select></div>
      <button class="btn primary block" id="m-ok">Open table</button>`,
      async (q) => {
        const t = await api("POST", `/clubs/${id}/tables`, {
          name: q("#m-name").value, smallBlind: +q("#m-sb").value, bigBlind: +q("#m-bb").value,
          minBuyin: +q("#m-min").value, maxBuyin: +q("#m-max").value, maxSeats: +q("#m-seats").value,
        });
        toast("Table opened"); openTable(t.tableId);
      }));
    bind("#leave-club", async () => { if (!confirm("Leave this club?")) return; await api("POST", `/clubs/${id}/leave`); await loadLobby(); go("lobby"); });
    bind("#delete-club", async () => { if (!confirm("Delete this club for everyone?")) return; await api("DELETE", `/clubs/${id}`); await loadLobby(); go("lobby"); });
  }

  // ---------- TABLE (WebSocket) ----------
  function closeWs() { if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; } S.table = null; S.you = null; S.lastResult = null; }

  function openTable(tableId) {
    closeWs();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: "auth", token: S.token })); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "authed") ws.send(JSON.stringify({ type: "join", tableId }));
      else if (m.type === "state") { S.table = m.table; S.you = m.you; if (S.screen === "table") renderTable(); }
      else if (m.type === "hand_started") { S.lastResult = null; }
      else if (m.type === "hand_complete") { S.lastResult = m; if (S.screen === "table") renderTable(); }
      else if (m.type === "table_closed") { toast("Table closed"); closeWs(); openClub(S.club.clubId); }
      else if (m.type === "error") toast(m.message, true);
    };
    ws.onclose = () => { if (S.screen === "table" && S.ws === ws) toast("Disconnected from table", true); };
    go("table");
  }

  function wsSend(m) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(m)); }

  // seat positions around the racetrack (percentages of table-wrap), index 0 = bottom center (you)
  const SEAT_POS = {
    2: [[50, 92], [50, 8]],
    6: [[50, 92], [12, 70], [12, 30], [50, 8], [88, 30], [88, 70]],
    9: [[50, 92], [20, 84], [10, 55], [16, 22], [36, 7], [64, 7], [84, 22], [90, 55], [80, 84]],
  };

  function cardHtml(c, small) {
    if (!c) return `<div class="pcard back"></div>`;
    const r = c[0] === "T" ? "10" : c[0], s = c[1];
    const sym = { s: "♠", h: "♥", d: "♦", c: "♣" }[s];
    return `<div class="pcard ${s === "h" || s === "d" ? "rd" : "blk"}"><span>${r}</span><span>${sym}</span></div>`;
  }

  function renderTable() {
    const t = S.table;
    if (!t) { $app.innerHTML = `<div class="screen">${topbar("Connecting…", "club")}<div class="empty">Joining table…</div></div>`; wireNav(); return; }
    const me = S.user.playerCode;
    const mySeat = t.seats.find((s) => s.playerCode === me);
    const isMyTurn = t.currentPlayerCode === me;
    const legal = S.you?.legalActions || [];
    const maxSeats = t.maxSeats;
    const positions = SEAT_POS[maxSeats] || SEAT_POS[9];
    // rotate so my seat is at the bottom
    const offset = mySeat ? mySeat.seat : 0;
    const bySeat = new Map(t.seats.map((s) => [s.seat, s]));
    const winners = new Set((S.lastResult?.winners || []).map((w) => w.playerCode));
    const showdown = new Map((S.lastResult?.showdown || []).map((s) => [s.playerCode, s.holeCards]));
    const myStack = mySeat ? mySeat.stack : 0;
    const minRaise = t.minRaiseTo || t.blinds.big * 2;
    const maxRaise = mySeat ? (mySeat.streetBet + myStack) : 0;
    if (S.raiseTo < minRaise || S.raiseTo > maxRaise) S.raiseTo = Math.min(minRaise, maxRaise);

    const seatsHtml = positions.map((pos, i) => {
      const seatNo = (i + offset) % maxSeats;
      const s = bySeat.get(seatNo);
      const [x, y] = pos;
      if (!s) {
        return `<div class="seat empty" style="left:${x}%;top:${y}%"><div class="av" data-sit="${seatNo}">${mySeat ? "" : "Sit"}</div></div>`;
      }
      const isMe = s.playerCode === me;
      const cls = ["seat", s.folded ? "folded" : "", t.currentPlayerCode === s.playerCode ? "active" : "", winners.has(s.playerCode) ? "winner" : "", isMe ? "me" : ""].join(" ");
      const betPos = y < 50 ? "bottom:-16px;left:50%;transform:translateX(-50%)" : "top:-18px;left:50%;transform:translateX(-50%)";
      const shown = showdown.get(s.playerCode);
      const hole = isMe && S.you?.holeCards?.length ? S.you.holeCards : shown;
      return `<div class="${cls}" style="left:${x}%;top:${y}%">
        ${t.currentPlayerCode === s.playerCode && t.street !== "complete" ? `<div class="timer"><i></i></div>` : ""}
        <div class="av" style="${grad(colorFor(s.playerCode))}">${initials(s.displayName)}${t.dealerSeat === s.seat ? `<div class="dealer">D</div>` : ""}</div>
        <div class="nm">${h(s.displayName)}${s.sittingOut ? " (out)" : !s.connected ? " ⚡" : ""}</div>
        <div class="st"><div class="chip"></div>${fmt(s.stack)}</div>
        ${s.inHand && !s.folded && hole ? `<div class="hole">${hole.map((c) => cardHtml(c, true)).join("")}</div>` : s.inHand && !s.folded && !isMe ? `<div class="hole"><div class="pcard back"></div><div class="pcard back"></div></div>` : ""}
        ${s.streetBet ? `<div class="bet" style="${betPos}">${fmt(s.streetBet)}</div>` : ""}
      </div>`;
    }).join("");

    const streetLabel = { waiting: "waiting for players", preflop: "pre-flop", flop: "flop", turn: "turn", river: "river", showdown: "showdown", complete: "hand over" }[t.street] || t.street;
    const result = S.lastResult ? S.lastResult.winners.map((w) => `${h(t.seats.find((s) => s.playerCode === w.playerCode)?.displayName || w.playerCode)} wins ${fmt(w.amount)}${w.description ? ` · ${h(w.description)}` : ""}`).join(" · ") : "";

    $app.innerHTML = `<div class="screen table-screen">
      <div class="table-head">
        <button class="back" id="leave-table">&#8249;</button>
        <span style="font-family:Georgia,serif">${h(t.name)} · ${fmt(t.blinds.small)}/${fmt(t.blinds.big)}</span>
        <span class="pill">Hand #${t.handNo}</span>
      </div>
      <div class="table-wrap">
        <div class="table-shadow"></div><div class="rail"></div><div class="rail-trim"></div><div class="felt"></div><div class="felt-spot"></div><div class="felt-ring"></div>
        <div class="felt-logo">POKERCREW<small>PRIVATE CLUBS</small></div>
        <div class="center">
          <div class="pot" id="pot">Pot ${fmt(t.pot)}</div>
          <div class="board">${[0, 1, 2, 3, 4].map((i) => t.board[i] ? cardHtml(t.board[i]) : `<div class="pcard back" style="opacity:.25"></div>`).join("")}</div>
          <div class="street-label">${streetLabel}</div>
        </div>
        ${seatsHtml}
      </div>
      <div class="result">${result}</div>
      ${mySeat ? `
        <div class="you-strip">
          <div class="hole">${(S.you?.holeCards || []).map((c) => cardHtml(c)).join("") || `<span class="sub">Waiting for next hand…</span>`}</div>
          <div><span class="sub">Your stack</span> <b>${fmt(myStack)}</b></div>
        </div>
        <div class="actions">
          <button class="btn" id="act-fold" ${legal.includes("fold") ? "" : "disabled"}>Fold</button>
          ${legal.includes("check") ? `<button class="btn" id="act-check">Check</button>` : `<button class="btn" id="act-call" ${legal.includes("call") ? "" : "disabled"}>Call ${legal.includes("call") ? fmt(t.toCall) : ""}</button>`}
          <button class="btn primary" id="act-raise" ${legal.includes("bet") || legal.includes("raise") ? "" : "disabled"}>${legal.includes("bet") ? "Bet" : "Raise to"} ${legal.includes("bet") || legal.includes("raise") ? fmt(S.raiseTo) : ""}</button>
          <button class="btn" id="act-allin" ${legal.includes("allin") ? "" : "disabled"} style="flex:.7">All-in</button>
        </div>
        ${legal.includes("bet") || legal.includes("raise") ? `<div class="raise-row">
          <span class="sub">Min ${fmt(minRaise)}</span>
          <input type="range" id="raise" min="${minRaise}" max="${maxRaise}" step="${t.blinds.big}" value="${S.raiseTo}">
          <span class="amt">${fmt(S.raiseTo)}</span>
        </div>` : ""}
      ` : `<div class="empty">Tap an empty seat to sit down. Balance: ${fmt(S.user.chips)} chips.</div>`}
    </div>`;

    $app.querySelector("#leave-table").onclick = async () => {
      if (mySeat) wsSend({ type: "leave" });
      closeWs();
      try { S.user = await api("GET", "/me"); } catch {}
      openClub(S.club.clubId);
    };
    $app.querySelectorAll("[data-sit]").forEach((el) => el.onclick = () => {
      if (mySeat) return;
      const seat = +el.dataset.sit;
      modal(`
        <div class="title" style="margin-bottom:6px">Sit down</div>
        <p class="sub" style="margin:0 0 12px">Buy-in ${fmt(t.buyIn?.min ?? "")}. Your balance: ${fmt(S.user.chips)} chips.</p>
        <div class="field"><label>Chips to bring to the table</label><input id="m-buy" type="number" value="${Math.min(S.user.chips, 1000)}"></div>
        <button class="btn primary block" id="m-ok">Take seat ${seat + 1}</button>`,
        async (q) => { wsSend({ type: "sit", seat, buyIn: +q("#m-buy").value }); setTimeout(async () => { try { S.user = await api("GET", "/me"); } catch {} }, 300); });
    });
    const act = (action, amount) => wsSend({ type: "act", action, amount });
    bind("#act-fold", () => act("fold"));
    bind("#act-check", () => act("check"));
    bind("#act-call", () => act("call"));
    bind("#act-allin", () => act("allin"));
    bind("#act-raise", () => act(legal.includes("bet") ? "bet" : "raise", S.raiseTo));
    const slider = $app.querySelector("#raise");
    if (slider) slider.oninput = () => {
      S.raiseTo = +slider.value;
      $app.querySelector(".raise-row .amt").textContent = fmt(S.raiseTo);
      $app.querySelector("#act-raise").textContent = `${legal.includes("bet") ? "Bet" : "Raise to"} ${fmt(S.raiseTo)}`;
    };
  }

  // ---------- PROFILE ----------
  async function renderProfile() {
    try { S.user = await api("GET", "/me"); } catch {}
    const u = S.user;
    $app.innerHTML = `<div class="screen">
      ${topbar("Profile", "lobby")}
      <div class="card" style="text-align:center;padding:24px">
        <div class="avatar" style="${grad(colorFor(u.playerCode))};width:64px;height:64px;font-size:20px;margin:0 auto 10px">${initials(u.displayName)}</div>
        <div class="title">${h(u.displayName)}</div>
        <div class="sub">Display names are permanent</div>
        <div class="divider"></div>
        <div class="sub">Your player ID — share it to get invited</div>
        <div class="code-big">${h(u.playerCode)}</div>
        <button class="btn sm" id="copy-pc" style="margin-top:8px">Copy</button>
      </div>
      <div class="card row"><span class="sub">Email</span><span>${h(u.email)}</span></div>
      <div class="card row"><span class="sub">Chips</span><span class="pill gold">${fmt(u.chips)}</span></div>
      <div class="card row"><span class="sub">Member since</span><span>${new Date(u.createdAt).toLocaleDateString()}</span></div>
      <button class="btn block" id="set-pw">${u.hasPassword ? "Change password" : "Add a password"}</button>
      <div style="height:8px"></div>
      <button class="btn block danger" id="logout">Sign out</button>
      ${nav("profile")}
    </div>`;
    wireNav();
    bind("#copy-pc", async () => { await navigator.clipboard?.writeText(u.playerCode); toast("Player ID copied"); });
    bind("#logout", () => logout());
    bind("#set-pw", () => modal(`
      <div class="title" style="margin-bottom:10px">Set a password</div>
      <div class="field"><label>New password (8+ characters)</label><input id="m-pw" type="password"></div>
      <button class="btn primary block" id="m-ok">Save</button>`,
      async (q) => { await api("POST", "/me/password", { password: q("#m-pw").value }); toast("Password saved"); }));
  }

  // ---------- ADMIN ----------
  let adminTab = "rake";
  async function renderAdmin() {
    if (S.user?.role !== "admin") return go("lobby");
    $app.innerHTML = `<div class="screen">${topbar("Admin", "lobby")}<div class="empty">Loading…</div></div>`;
    try {
      if (adminTab === "rake") {
        const [summary, byClub, byTable, daily] = await Promise.all([
          api("GET", "/admin/rake/summary"), api("GET", "/admin/rake/by-club"), api("GET", "/admin/rake/by-table"), api("GET", "/admin/rake/daily?days=14"),
        ]);
        S.admin = { summary, byClub, byTable, daily };
      } else if (adminTab === "players") {
        S.admin = { players: await api("GET", "/admin/players?limit=200") };
      } else {
        S.admin = { clubs: await api("GET", "/admin/clubs") };
      }
    } catch (e) { toast(e.message, true); }
    const a = S.admin || {};
    $app.innerHTML = `<div class="screen">
      ${topbar("Admin", "lobby")}
      <div class="tabs">
        <button class="${adminTab === "rake" ? "active" : ""}" data-atab="rake">Rake</button>
        <button class="${adminTab === "players" ? "active" : ""}" data-atab="players">Players</button>
        <button class="${adminTab === "clubs" ? "active" : ""}" data-atab="clubs">Clubs</button>
      </div>
      ${adminTab === "rake" ? `
        <div class="grid2" style="margin-bottom:10px">
          <div class="stat"><div class="v">${fmt(a.summary?.totalRake)}</div><div class="k">Total rake (all time)</div></div>
          <div class="stat"><div class="v">${fmt(a.summary?.totalHands)}</div><div class="k">Hands played</div></div>
        </div>
        <div class="card"><div class="sub" style="margin-bottom:8px">By club</div>
          <table class="data"><tr><th>Club</th><th>Rake</th><th>Hands</th></tr>
          ${(a.byClub || []).map((r) => `<tr><td>${h(r.clubName)} <span class="mono sub">${h(r.clubCode)}</span></td><td>${fmt(r.rake)}</td><td>${fmt(r.rakedHands)}</td></tr>`).join("") || `<tr><td colspan=3 class="sub">No rake yet</td></tr>`}</table></div>
        <div class="card"><div class="sub" style="margin-bottom:8px">By table</div>
          <table class="data"><tr><th>Table</th><th>Blinds</th><th>Rake</th><th>Avg/hand</th></tr>
          ${(a.byTable || []).map((r) => `<tr><td>${h(r.tableName)} <span class="pill">${r.status}</span></td><td>${r.blinds.small}/${r.blinds.big}</td><td>${fmt(r.rake)}</td><td>${r.avgRakePerHand}</td></tr>`).join("") || `<tr><td colspan=4 class="sub">No rake yet</td></tr>`}</table></div>
        <div class="card"><div class="sub" style="margin-bottom:8px">Last 14 days</div>
          <table class="data"><tr><th>Day</th><th>Rake</th><th>Raked hands</th></tr>
          ${(a.daily || []).map((r) => `<tr><td>${r.day}</td><td>${fmt(r.rake)}</td><td>${fmt(r.rakedHands)}</td></tr>`).join("") || `<tr><td colspan=3 class="sub">Nothing yet</td></tr>`}</table></div>
      ` : adminTab === "players" ? `
        <div class="row" style="margin-bottom:8px"><span class="sub">${fmt(a.players?.total)} players</span><a class="btn sm" href="/admin/players/export.csv" id="csv">Export CSV</a></div>
        <div class="card"><table class="data"><tr><th>Player ID</th><th>Name</th><th>Email</th><th>Chips</th></tr>
          ${(a.players?.players || []).map((p) => `<tr><td class="mono">${h(p.playerCode)}</td><td>${h(p.displayName)}${p.role === "admin" ? " <span class='pill gold'>admin</span>" : ""}</td><td>${h(p.email)}</td><td>${fmt(p.chips)}</td></tr>`).join("")}</table></div>
      ` : `
        <div class="card"><table class="data"><tr><th>Club</th><th>Owner</th><th>Members</th></tr>
          ${(a.clubs || []).map((c) => `<tr><td>${h(c.name)} <span class="mono sub">${h(c.clubCode)}</span></td><td>${h(c.owner.displayName)}<div class="sub">${h(c.owner.email)}</div></td><td>${c.memberCount}</td></tr>`).join("") || `<tr><td colspan=3 class="sub">No clubs yet</td></tr>`}</table></div>
      `}
      ${nav("admin")}
    </div>`;
    wireNav();
    $app.querySelectorAll("[data-atab]").forEach((b) => b.onclick = () => { adminTab = b.dataset.atab; renderAdmin(); });
    const csv = $app.querySelector("#csv");
    if (csv) csv.onclick = async (e) => {
      e.preventDefault();
      const res = await fetch("/admin/players/export.csv", { headers: { authorization: `Bearer ${S.token}` } });
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a2 = document.createElement("a"); a2.href = url; a2.download = "pokercrew-players.csv"; a2.click(); URL.revokeObjectURL(url);
    };
  }

  // ---------- boot ----------
  (async () => {
    if (S.token) {
      try { S.user = await api("GET", "/me"); await loadLobby(); go("lobby"); return; } catch {}
    }
    go("auth");
  })();
})();
