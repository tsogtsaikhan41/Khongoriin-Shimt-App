"use strict";
/* ============================================================
   CONFIG
   ============================================================ */
const SOUMS = [
  { name: "Богд", code: "BOG" },
  { name: "Жинст", code: "JIN" },
  { name: "Бүмбүгэр", code: "BUM" },
  { name: "Баян-Цагаан", code: "BTS" }
];
const KHORKHOG_SIZES = { "Хорхог 1.5кг": 1.5, "Хорхог 2.3кг": 2.3, "Хорхог 3.3кг": 3.3 };

// which forms are usable in which self-selected working context
const CONTEXT_FORMS = {
  soum: ["purchase", "slaughter", "transport", "inventory"],
  shop: ["receiving", "packaging", "sale", "inventory"]
};

/* ============================================================
   SUPABASE CLIENT
   ============================================================ */
const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
function emailFor(username) {
  return `${username.trim().toLowerCase()}@${window.AUTH_EMAIL_DOMAIN}`;
}

/* ============================================================
   INDEXEDDB -- offline queue + local cache
   ============================================================ */
const IDB_NAME = "khongorshimt_db";
const IDB_VERSION = 1;
let idbPromise = null;
function idb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "key" });
      if (!db.objectStoreNames.contains("localseq")) db.createObjectStore("localseq", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
async function idbTx(storeName, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}
async function queueAdd(entry) {
  entry.id = entry.id || uid();
  entry.createdAt = Date.now();
  await idbTx("queue", "readwrite", (s) => s.put(entry));
  updatePendingBadge();
  return entry;
}
async function queueGetAll() {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction("queue", "readonly");
    const store = tx.objectStore("queue");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
  });
}
async function queueRemove(id) {
  await idbTx("queue", "readwrite", (s) => s.delete(id));
  updatePendingBadge();
}
async function cacheSet(key, value) {
  await idbTx("cache", "readwrite", (s) => s.put({ key, value }));
}
async function cacheGet(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction("cache", "readonly");
    const req = tx.objectStore("cache").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
  });
}
async function localSeqNext(key) {
  return idbTx("localseq", "readwrite", (store) => {
    return new Promise((resolve) => {
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const cur = getReq.result ? getReq.result.seq : 900; // offline codes start at 900+ to be visually distinct
        const next = cur + 1;
        store.put({ key, seq: next });
        resolve(next);
      };
    });
  }).then((p) => p); // resolves inner promise value through idbTx's fn return
}

function uid() {
  // Database columns are type `uuid`, so IDs generated here (needed
  // upfront for offline-safe writes) must actually be valid UUIDs --
  // crypto.randomUUID() is built into every modern browser for this.
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  // Fallback for older browsers without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function fmt(n) {
  n = Number(n) || 0;
  return Math.round(n).toLocaleString("mn-MN");
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

/* ============================================================
   ONLINE / OFFLINE STATE + SYNC LOOP
   ============================================================ */
let isOnline = navigator.onLine;
function setOnlineBar() {
  document.getElementById("offlineBar").classList.toggle("show", !isOnline);
}
window.addEventListener("online", () => { isOnline = true; setOnlineBar(); flushQueue(); });
window.addEventListener("offline", () => { isOnline = false; setOnlineBar(); });

async function updatePendingBadge() {
  const q = await queueGetAll();
  const el = document.getElementById("pendingBadge");
  if (q.length > 0) {
    el.textContent = `${q.length} хүлээгдэж буй`;
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}

// Attempt a Supabase insert; if it fails for network reasons, queue it.
// `steps` = array of {table, payload} executed in order (for compound ops
// like a slaughter session + its per-animal items + animal status updates).
async function runSteps(steps) {
  if (!isOnline) {
    await queueAdd({ steps });
    toast("Интернэтгүй -- төхөөрөмж дээр хадгаллаа");
    return { queued: true };
  }
  try {
    for (const step of steps) {
      await execStep(step);
    }
    return { queued: false };
  } catch (err) {
    await queueAdd({ steps });
    isOnline = false;
    setOnlineBar();
    toast("Сүлжээ тасарлаа -- төхөөрөмж дээр хадгаллаа");
    return { queued: true };
  }
}
async function execStep(step) {
  if (step.op === "update") {
    const { error } = await sb.from(step.table).update(step.payload).eq("id", step.match.id);
    if (error) throw error;
  } else {
    const { error } = await sb.from(step.table).insert(step.payload);
    if (error) throw error;
  }
}
async function flushQueue() {
  const q = await queueGetAll();
  for (const entry of q) {
    try {
      for (const step of entry.steps) await execStep(step);
      await queueRemove(entry.id);
    } catch (err) {
      isOnline = false;
      setOnlineBar();
      return; // stop; will retry later
    }
  }
  if (q.length > 0) toast("Синк амжилттай боллоо");
  await loadAllData();
  renderCurrentScreen();
}
// Always attempt -- never gate on the isOnline flag itself, since that
// flag can only be trusted as a result of trying, not as a precondition
// for trying. This is what makes the app self-heal after a real fix.
setInterval(() => { flushQueue(); }, 20000);

/* ============================================================
   AUTH
   ============================================================ */
let currentUser = null; // {id, username, display_name, role}
let workContext = null; // {type:'soum'|'shop', soum: string|null}

document.getElementById("form-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById("setup-error");
  errEl.style.display = "none";
  const username = fd.get("username").trim().toLowerCase();
  try {
    const { data: signData, error: signErr } = await sb.auth.signUp({
      email: emailFor(username), password: fd.get("password")
    });
    if (signErr) throw signErr;
    const userId = signData.user.id;
    const { error: profErr } = await sb.from("profiles").insert({
      id: userId, username, display_name: fd.get("displayName"), role: "admin"
    });
    if (profErr) throw profErr;
    toast("Админ үүслээ");
    await afterLogin();
  } catch (err) {
    errEl.textContent = err.message || "Алдаа гарлаа";
    errEl.style.display = "block";
  }
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById("login-error");
  errEl.style.display = "none";
  const username = fd.get("username").trim().toLowerCase();
  try {
    const { error } = await sb.auth.signInWithPassword({
      email: emailFor(username), password: fd.get("password")
    });
    if (error) throw error;
    await afterLogin();
  } catch (err) {
    errEl.textContent = "Нэвтрэх нэр эсвэл нууц үг буруу байна";
    errEl.style.display = "block";
  }
});

async function afterLogin() {
  let profile = null;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error("no user");
    const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (error) throw error;
    profile = data;
    await cacheSet("session_profile", profile);
  } catch (err) {
    // Supabase unreachable (e.g. token needed refreshing but we're offline).
    // Fall back to the last profile we know logged in on this device, so
    // losing signal mid-session never locks someone out of their own app.
    profile = await cacheGet("session_profile");
    if (!profile) { toast("Профайл ачаалах боломжгүй -- интернэтээ шалгаад дахин оролдоно уу"); return; }
    isOnline = false;
    setOnlineBar();
    toast("Офлайн горимоор нэвтэрлээ (өмнө нэвтэрсэн профайл ашиглаж байна)");
  }
  currentUser = profile;

  document.getElementById("topbar").style.display = "flex";
  document.getElementById("userLabel").innerHTML =
    `${profile.display_name} <span class="role-badge">${profile.role === "admin" ? "СУПЕР АДМИН" : "Ажилтан"}</span>`;
  document.getElementById("tile-admin").style.display = profile.role === "admin" ? "flex" : "none";
  document.getElementById("tile-requests").style.display = profile.role === "admin" ? "flex" : "none";
  document.getElementById("tile-activity").style.display = profile.role === "admin" ? "flex" : "none";

  // Access is appointed by the admin at account-creation time -- no more
  // self-service picker. Admin has no fixed context (sees everything);
  // staff's context comes straight from their profile row.
  workContext = profile.role === "admin"
    ? { type: "admin", soum: SOUMS[0].name }
    : { type: profile.context_type, soum: profile.soum };

  await loadAllData();
  nav("home");
}

function logout() {
  if (!isOnline) {
    const proceed = confirm("Та одоо интернэтгүй байна. Гарвал дахин холбогдох хүртэл нэвтэрч чадахгүй болно. Гарах уу?");
    if (!proceed) return;
  }
  sb.auth.signOut();
  currentUser = null;
  document.getElementById("topbar").style.display = "none";
  document.getElementById("form-login").reset();
  showScreen("login");
}

/* ============================================================
   ACTIVITY LOG -- lightweight helper called from key actions
   ============================================================ */
async function logActivity(action, description) {
  const payload = {
    id: uid(), actor_id: currentUser.id, actor_name: currentUser.display_name,
    action, description, created_at: new Date().toISOString()
  };
  DATA.activity_log = DATA.activity_log || [];
  DATA.activity_log.push(payload);
  await runSteps([{ table: "activity_log", payload }]);
}


/* ============================================================
   DATA LOADING (cached in IndexedDB for offline reads)
   ============================================================ */
let DATA = {
  animals: [], slaughter_sessions: [], slaughter_items: [],
  transport_sessions: [], transport_items: [], receiving_sessions: [],
  packagings: [], sales: [], profiles: [],
  activity_log: [], messages: [], change_requests: []
};

async function loadAllData() {
  {
    try {
      const tables = ["animals","slaughter_sessions","slaughter_items","transport_sessions",
        "transport_items","receiving_sessions","packagings","sales","profiles",
        "activity_log","messages","change_requests"];
      const results = await Promise.all(tables.map(t => sb.from(t).select("*")));
      for (const r of results) if (r.error) throw r.error;
      tables.forEach((t, i) => { DATA[t] = results[i].data || []; });
      await cacheSet("data_snapshot", DATA);
      // A request just genuinely succeeded -- whatever we thought before,
      // we're online now. Don't wait for a real browser online/offline
      // event that may never fire if the connection never truly dropped.
      if (!isOnline) { isOnline = true; setOnlineBar(); toast("Холболт сэргэлээ"); }
      return;
    } catch (err) {
      isOnline = false; setOnlineBar();
    }
  }
  const cached = await cacheGet("data_snapshot");
  if (cached) DATA = cached;
}

/* ============================================================
   ANIMAL CODE GENERATION
   Format: SOUMCODE-YYMMDD-HERINITIALS-### (### per herder)
   Online: atomic via RPC. Offline: local counter starting at 900+
   so offline-generated codes are visually distinguishable and
   never collide with server-assigned ones.
   ============================================================ */
function herderInitials(name) {
  const clean = (name || "").trim().replace(/[^A-Za-zА-Яа-яЁёӨөҮү\s]/g, "");
  const letters = clean.replace(/\s/g, "").slice(0, 3).toUpperCase();
  return letters.padEnd(3, "X");
}
async function nextAnimalCode(soumName, dateStr, herderName) {
  const soum = SOUMS.find((s) => s.name === soumName);
  const code = soum ? soum.code : "GEN";
  const ymd = dateStr.replace(/-/g, "").slice(2); // YYMMDD
  const her = herderInitials(herderName);
  const key = `${code}-${ymd}-${her}`;
  let seq;
  if (isOnline) {
    try {
      const { data, error } = await sb.rpc("next_seq", { p_key: key });
      if (error) throw error;
      seq = data;
    } catch (err) {
      seq = await localSeqNext(key);
    }
  } else {
    seq = await localSeqNext(key);
  }
  return `${key}-${String(seq).padStart(3, "0")}`;
}

/* ============================================================
   NAVIGATION + PERMISSIONS
   ============================================================ */
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
}
let currentScreen = "home";
async function nav(screen) {
  currentScreen = screen;
  if (!["home", "admin"].includes(screen) && isOnline) {
    await loadAllData();
  }
  showScreen(screen);
  document.getElementById("backBtn").style.display = screen === "home" ? "none" : "inline-block";
  applyHomeGating();
  renderCurrentScreen();
  window.scrollTo(0, 0);
}
function formAllowed(formName) {
  if (currentUser && currentUser.role === "admin") return true;
  if (formName === "inventory") return true;
  if (!workContext || !workContext.type) return false;
  return CONTEXT_FORMS[workContext.type].includes(formName);
}
function tryNav(formName) {
  if (!formAllowed(formName)) {
    toast("Энэ форм таны одоогийн ажиллах газарт хамаарахгүй байна");
    return;
  }
  nav(formName);
}
function applyHomeGating() {
  document.querySelectorAll(".tile[data-form]").forEach((tile) => {
    const f = tile.getAttribute("data-form");
    tile.classList.toggle("disabled", !formAllowed(f));
  });
}
function renderCurrentScreen() {
  setDefaultDates();
  if (currentScreen === "purchase") { populatePurchaseSoumFilter(); purchaseTab(purchaseActiveTab); }
  if (currentScreen === "slaughter") { renderSlaughterAnimalPicker(); renderList("slaughter"); }
  if (currentScreen === "transport") { renderTransportAnimalPicker(); renderList("transport"); }
  if (currentScreen === "receiving") { populateReceivingSessions(); renderList("receiving"); }
  if (currentScreen === "packaging") { populatePackagingSelects(); renderList("packaging"); }
  if (currentScreen === "sale") { populateSaleProducts(); renderList("sale"); }
  if (currentScreen === "inventory") renderInventory();
  if (currentScreen === "dashboard") renderDashboard();
  if (currentScreen === "admin") renderUserList();
  if (currentScreen === "activity") renderActivityLog();
  if (currentScreen === "requests") renderChangeRequests();
  if (currentScreen === "chat") renderChat();
}
function setDefaultDates() {
  document.querySelectorAll('input[type=date]').forEach((inp) => { if (!inp.value) inp.value = todayStr(); });
}

/* ============================================================
   ADMIN: USER MANAGEMENT (via secure Edge Function -- no email)
   ============================================================ */
function toggleAddUserFields() {
  const isAdmin = document.getElementById("au-role").value === "admin";
  document.getElementById("au-context-block").style.display = isAdmin ? "none" : "block";
}
function toggleAddUserSoum() {
  document.getElementById("au-soum-block").style.display =
    document.getElementById("au-context-type").value === "soum" ? "block" : "none";
}
function initAddUserSoumOptions() {
  const sel = document.getElementById("au-soum");
  if (sel && !sel.dataset.filled) {
    sel.innerHTML = SOUMS.map((s) => `<option value="${s.name}">${s.name}</option>`).join("");
    sel.dataset.filled = "1";
  }
}
document.getElementById("form-adduser").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const username = fd.get("username").trim().toLowerCase();
  const role = fd.get("role");
  const contextType = document.getElementById("au-context-type").value;
  const soum = document.getElementById("au-soum").value;
  try {
    const { data, error } = await sb.functions.invoke("admin-users", {
      body: { action: "create_user", username, password: fd.get("password"),
        displayName: fd.get("displayName"), role, contextType, soum }
    });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    toast("Хэрэглэгч нэмэгдлээ");
    await logActivity("user_created", `${currentUser.display_name} шинэ хэрэглэгч (${fd.get("displayName")}) нэмлээ`);
    e.target.reset();
    toggleAddUserFields();
    await loadAllData();
    renderUserList();
  } catch (err) {
    alert("АЛДАА:\n\n" + (err.message || "Тодорхойгүй алдаа") + "\n\n(Энэ мессежийг Claude-д хуулж илгээнэ үү)");
  }
});
async function resetUserPassword(userId, displayName) {
  const newPass = prompt(`${displayName}-ийн шинэ нууц үгийг оруулна уу (доод тал нь 6 тэмдэгт):`);
  if (!newPass || newPass.length < 6) { if (newPass !== null) toast("Хамгийн багадаа 6 тэмдэгт байх ёстой"); return; }
  try {
    const { data, error } = await sb.functions.invoke("admin-users", {
      body: { action: "reset_password", userId, newPassword: newPass }
    });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    toast("Нууц үг шинэчлэгдлээ");
    await logActivity("password_reset", `${currentUser.display_name} ${displayName}-ийн нууц үгийг шинэчлэлээ`);
  } catch (err) {
    alert("АЛДАА:\n\n" + (err.message || "Тодорхойгүй алдаа") + "\n\n(Энэ мессежийг Claude-д хуулж илгээнэ үү)");
  }
}
function renderUserList() {
  initAddUserSoumOptions();
  const el = document.getElementById("user-list");
  el.innerHTML = DATA.profiles.map((u) => `
    <div class="list-item">
      <div class="top-row"><div class="batch">${u.display_name} ${u.role === "admin" ? "(Админ)" : ""}</div><div class="date">${u.username}</div></div>
      <div class="details">${u.role === "admin" ? "Супер Админ" : "Ажилтан -- " + (u.context_type === "shop" ? "Дэлгүүр" : "Сум: " + (u.soum || "--"))}</div>
      <div class="actions"><button class="btn-ghost" onclick="resetUserPassword('${u.id}','${u.display_name}')">Нууц үг шинэчлэх</button></div>
    </div>
  `).join("") || `<div class="empty-state"><div class="big">--</div>Хэрэглэгч алга</div>`;
}

/* ============================================================
   ACTIVITY LOG, CHANGE REQUESTS, CHAT
   ============================================================ */
function renderActivityLog() {
  const el = document.getElementById("activity-list");
  const items = (DATA.activity_log || []).slice().reverse();
  el.innerHTML = items.map(a => `
    <div class="list-item">
      <div class="top-row"><div class="batch">${a.actor_name}</div><div class="date">${new Date(a.created_at).toLocaleString("mn-MN")}</div></div>
      <div class="details">${a.description}</div>
    </div>
  `).join("") || `<div class="empty-state"><div class="big">--</div>Түүх алга байна</div>`;
}

const EDITABLE_FIELDS = {
  animals: [["live_weight_kg", "Амьд жин (кг)", "number"], ["price_per_kg", "Үнэ/кг (₮)", "number"], ["herder_name", "Малчны нэр", "text"], ["animal_type", "Мал төрөл", "text"]],
  slaughter_items: [["carcass_weight_kg", "Гулуузын жин (кг)", "number"]],
  transport_items: [["weight_sent_kg", "Илгээсэн жин (кг)", "number"]],
  receiving_sessions: [["total_weight_received", "Хүлээн авсан жин (кг)", "number"]],
  packagings: [["weight_kg", "Жин (кг)", "number"], ["packaging_cost", "Зардал (₮)", "number"]],
  sales: [["qty", "Тоо хэмжээ", "number"], ["unit_price", "Нэгжийн үнэ (₮)", "number"]]
};
function openRequestChange(tableName, recordId) {
  const fields = EDITABLE_FIELDS[tableName];
  if (!fields) { toast("Энэ бичлэгийг засах боломжгүй"); return; }
  const record = DATA[tableName].find(r => r.id === recordId);
  if (!record) return;
  const body = document.getElementById("ticket-modal-body");
  body.innerHTML = `
    <h2 class="section-title">Засвар хүсэх</h2>
    <label>Аль талбарыг засах вэ</label>
    <select id="rc-field">${fields.map(([key, label]) => `<option value="${key}">${label} (одоо: ${record[key]})</option>`).join("")}</select>
    <label>Шинэ утга</label>
    <input type="text" id="rc-newvalue">
    <label>Шалтгаан (заавал биш)</label>
    <textarea id="rc-reason" rows="2"></textarea>
    <button class="btn-primary" onclick="submitChangeRequest('${tableName}','${recordId}')">Хүсэлт илгээх</button>
    <button class="btn-ghost" style="width:100%;margin-top:8px;" onclick="closeTicketModal()">Болих</button>
  `;
  document.getElementById("ticket-modal").style.display = "flex";
}
function closeTicketModal() { document.getElementById("ticket-modal").style.display = "none"; }
async function submitChangeRequest(tableName, recordId) {
  const field = document.getElementById("rc-field").value;
  const newValue = document.getElementById("rc-newvalue").value;
  const reason = document.getElementById("rc-reason").value;
  if (!newValue) { toast("Шинэ утгаа оруулна уу"); return; }
  const record = DATA[tableName].find(r => r.id === recordId);
  const payload = {
    id: uid(), table_name: tableName, record_id: recordId, field_name: field,
    old_value: String(record ? record[field] : ""), new_value: newValue, reason,
    requested_by: currentUser.id, requested_by_name: currentUser.display_name,
    status: "pending", created_at: new Date().toISOString()
  };
  DATA.change_requests = DATA.change_requests || [];
  DATA.change_requests.push(payload);
  await runSteps([{ table: "change_requests", payload }]);
  await logActivity("change_requested", `${currentUser.display_name} засвар хүслээ: ${field} -> ${newValue}`);
  toast("Хүсэлт илгээгдлээ, Супер Админ хянана");
  closeTicketModal();
}
function renderChangeRequests() {
  const el = document.getElementById("requests-list");
  const items = (DATA.change_requests || []).filter(r => r.status === "pending").slice().reverse();
  el.innerHTML = items.map(r => `
    <div class="list-item">
      <div class="top-row"><div class="batch">${r.table_name} / ${r.field_name}</div><div class="date">${new Date(r.created_at).toLocaleString("mn-MN")}</div></div>
      <div class="details">${r.requested_by_name}: "${r.old_value}" -> "${r.new_value}"${r.reason ? " (" + r.reason + ")" : ""}</div>
      <div class="actions">
        <button class="btn-primary" style="width:auto;margin:0;padding:8px 14px;" onclick="reviewChangeRequest('${r.id}', true)">Зөвшөөрөх</button>
        <button class="btn-danger" onclick="reviewChangeRequest('${r.id}', false)">Татгалзах</button>
      </div>
    </div>
  `).join("") || `<div class="empty-state"><div class="big">--</div>Хүлээгдэж буй хүсэлт алга</div>`;
}
async function reviewChangeRequest(reqId, approve) {
  const cr = (DATA.change_requests || []).find(r => r.id === reqId);
  if (!cr) return;
  const steps = [];
  if (approve) {
    const fieldDef = (EDITABLE_FIELDS[cr.table_name] || []).find(f => f[0] === cr.field_name);
    const parsedValue = fieldDef && fieldDef[2] === "number" ? parseFloat(cr.new_value) : cr.new_value;
    steps.push({ table: cr.table_name, op: "update", match: { id: cr.record_id }, payload: { [cr.field_name]: parsedValue } });
    const rec = DATA[cr.table_name].find(r => r.id === cr.record_id);
    if (rec) rec[cr.field_name] = parsedValue;
  }
  cr.status = approve ? "approved" : "rejected";
  cr.reviewed_by = currentUser.id; cr.reviewed_by_name = currentUser.display_name; cr.reviewed_at = new Date().toISOString();
  steps.push({ table: "change_requests", op: "update", match: { id: reqId },
    payload: { status: cr.status, reviewed_by: currentUser.id, reviewed_by_name: currentUser.display_name, reviewed_at: cr.reviewed_at } });
  await runSteps(steps);
  await logActivity(approve ? "change_approved" : "change_rejected", `${currentUser.display_name} ${cr.requested_by_name}-ийн хүсэлтийг ${approve ? "зөвшөөрлөө" : "татгалзлаа"}`);
  toast(approve ? "Зөвшөөрөгдлөө" : "Татгалзлаа");
  renderChangeRequests();
}

async function renderChat() {
  const el = document.getElementById("chat-messages");
  const items = (DATA.messages || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  el.innerHTML = items.map(m => `
    <div class="list-item">
      <div class="top-row"><div class="batch">${m.sender_name}</div><div class="date">${new Date(m.created_at).toLocaleString("mn-MN")}</div></div>
      <div class="details">${m.body}</div>
    </div>
  `).join("") || `<div class="empty-state"><div class="big">--</div>Мессеж алга байна, эхнийхийг бичээрэй</div>`;
  el.scrollTop = el.scrollHeight;
}
async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const body = input.value.trim();
  if (!body) return;
  const payload = { id: uid(), sender_id: currentUser.id, sender_name: currentUser.display_name, body, created_at: new Date().toISOString() };
  DATA.messages = DATA.messages || [];
  DATA.messages.push(payload);
  await runSteps([{ table: "messages", payload }]);
  input.value = "";
  renderChat();
}
setInterval(() => { if (isOnline && currentScreen === "chat") { loadAllData().then(renderChat); } }, 15000);

/* ============================================================
   PURCHASE
   ============================================================ */
let purchaseActiveTab = "add";
function purchaseTab(tab) {
  purchaseActiveTab = tab;
  document.querySelectorAll('#screen-purchase .btn-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('purchase-add-panel').style.display = tab === 'add' ? 'block' : 'none';
  document.getElementById('purchase-view-panel').style.display = tab === 'view' ? 'block' : 'none';
  if (tab === 'view') renderPurchaseView();
}
function calcPurchase() {
  const w = parseFloat(document.getElementById("p-weight").value) || 0;
  const p = parseFloat(document.getElementById("p-price").value) || 0;
  document.getElementById("p-total").textContent = fmt(w * p) + " ₮";
}
document.getElementById("form-purchase").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const soum = workContext && workContext.type === "soum" ? workContext.soum : (workContext ? workContext.soum : SOUMS[0].name);
  const liveWeight = parseFloat(fd.get("live_weight_kg")) || 0;
  const price = parseFloat(fd.get("price_per_kg")) || 0;
  const purchaseDate = fd.get("purchase_date");
  const herderName = fd.get("herder_name");
  const code = await nextAnimalCode(soum, purchaseDate, herderName);
  const payload = {
    id: uid(), animal_code: code, soum, purchase_date: purchaseDate,
    herder_name: herderName, animal_type: fd.get("animal_type"),
    live_weight_kg: liveWeight, price_per_kg: price, total_cost: liveWeight * price,
    purchasing_agent: fd.get("purchasing_agent"), note: fd.get("note"),
    status: "purchased", created_by: currentUser.id
  };
  DATA.animals.push(payload); // optimistic local update
  await runSteps([{ table: "animals", payload }]);
  toast("Хадгалагдлаа: " + code);
  await logActivity("purchase", currentUser.display_name + " мал худалдан авлаа: " + code);
  e.target.reset();
  document.getElementById("p-total").textContent = "0 ₮";
  setDefaultDates();
  renderList("purchase-add-noop"); // no-op guard, real refresh below
  populatePurchaseSoumFilter();
});
function populatePurchaseSoumFilter() {
  const sel = document.getElementById("pv-soum-filter");
  if (!sel || sel.dataset.filled) return;
  sel.innerHTML = '<option value="">Бүх сум</option>' + SOUMS.map(s => `<option value="${s.name}">${s.name}</option>`).join("");
  sel.dataset.filled = "1";
}
function renderPurchaseView() {
  const filterSoum = document.getElementById("pv-soum-filter").value;
  let animals = DATA.animals.slice();
  if (filterSoum) animals = animals.filter(a => a.soum === filterSoum);

  const count = animals.length;
  const totalWeight = animals.reduce((a, x) => a + Number(x.live_weight_kg || 0), 0);
  const totalCost = animals.reduce((a, x) => a + Number(x.total_cost || 0), 0);
  const avgWeight = count ? totalWeight / count : 0;
  const avgPrice = count ? totalCost / totalWeight : 0;

  document.getElementById("pv-stats").innerHTML = `
    <div class="stat"><div class="n">${count}</div><div class="l">Нийт мал</div></div>
    <div class="stat"><div class="n">${avgWeight.toFixed(1)} кг</div><div class="l">Дундаж жин</div></div>
    <div class="stat"><div class="n">${fmt(totalCost)}₮</div><div class="l">Нийт зарцуулалт</div></div>
    <div class="stat"><div class="n">${fmt(avgPrice)}₮</div><div class="l">Дундаж үнэ/кг</div></div>
  `;

  const bySoum = {};
  animals.forEach(a => { bySoum[a.soum] = (bySoum[a.soum] || 0) + 1; });
  const ctx = document.getElementById("pv-chart");
  if (window._pvChart) window._pvChart.destroy();
  window._pvChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: Object.keys(bySoum),
      datasets: [{ label: "Малын тоо", data: Object.values(bySoum), backgroundColor: "#1E5B4F" }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
  renderPurchaseList();
}
function renderPurchaseList(filterText) {
  const filterSoum = document.getElementById("pv-soum-filter").value;
  let items = DATA.animals.slice().reverse();
  if (filterSoum) items = items.filter(a => a.soum === filterSoum);
  if (filterText) {
    const f = filterText.toLowerCase();
    items = items.filter(a => JSON.stringify(a).toLowerCase().includes(f));
  }
  const el = document.getElementById("list-purchase");
  if (!el) return;
  if (items.length === 0) { el.innerHTML = `<div class="empty-state"><div class="big">--</div>Бичлэг алга</div>`; return; }
  el.innerHTML = items.map(a => `
    <div class="list-item">
      <div class="top-row"><div class="batch">${a.animal_code}</div><div class="date">${a.purchase_date}</div></div>
      <div class="details">${a.soum} · ${a.herder_name} · ${a.animal_type} · ${a.live_weight_kg} кг · ${fmt(a.price_per_kg)}₮/кг · нийт ${fmt(a.total_cost)}₮</div>
      <div class="details">Худ. авсан: ${a.purchasing_agent}${a.note ? " · " + a.note : ""} · төлөв: ${a.status}</div>
      <div class="actions">${editOrRequestButton("animals", a.id)}</div>
    </div>
  `).join("");
}

/* ============================================================
   SLAUGHTER (Мал бэлтгэл) -- bundled selection, per-animal weight
   ============================================================ */
function renderSlaughterAnimalPicker() {
  const el = document.getElementById("slaughter-animal-pick");
  const eligible = DATA.animals.filter(a => a.status === "purchased");
  if (eligible.length === 0) { el.innerHTML = `<div class="helper-text">Бэлтгэх мал алга</div>`; return; }
  el.innerHTML = eligible.map(a => `
    <div class="animal-row">
      <input type="checkbox" class="s-pick" value="${a.id}" onchange="calcSlaughterCost()">
      <div class="info"><b>${a.animal_code}</b><br>${a.herder_name} · ${a.animal_type} · ${a.live_weight_kg}кг амьд</div>
      <input type="number" step="0.1" min="0" class="s-carcass" data-animal="${a.id}" placeholder="Гулуузын жин">
    </div>
  `).join("");
}
function calcSlaughterCost() {
  const checked = document.querySelectorAll(".s-pick:checked").length;
  const total = parseFloat(document.getElementById("s-totalcost").value) || 0;
  document.getElementById("s-costshare").textContent = checked ? fmt(total / checked) + " ₮ / толгой" : "--";
}
async function submitSlaughter() {
  const checked = Array.from(document.querySelectorAll(".s-pick:checked"));
  if (checked.length === 0) { toast("Мал сонгоно уу"); return; }
  const totalCost = parseFloat(document.getElementById("s-totalcost").value) || 0;
  const sessionDate = document.querySelector('#form-slaughter input[name=session_date]').value;
  const location = document.querySelector('#form-slaughter input[name=location]').value;
  const note = document.getElementById("s-note").value;
  const costShare = totalCost / checked.length;

  const items = [];
  for (const cb of checked) {
    const animalId = cb.value;
    const input = document.querySelector(`.s-carcass[data-animal="${animalId}"]`);
    const carcassWeight = parseFloat(input.value) || 0;
    if (carcassWeight <= 0) { toast("Бүх сонгосон малын гулуузын жинг бөглөнө үү"); return; }
    const animal = DATA.animals.find(a => a.id === animalId);
    const yieldPct = animal && animal.live_weight_kg ? (carcassWeight / animal.live_weight_kg * 100) : null;
    items.push({ animalId, carcassWeight, yieldPct });
  }

  const sessionId = uid();
  const steps = [{ table: "slaughter_sessions", payload: {
    id: sessionId, session_date: sessionDate, location, total_cost: totalCost, note, created_by: currentUser.id
  }}];
  items.forEach(it => {
    steps.push({ table: "slaughter_items", payload: {
      id: uid(), session_id: sessionId, animal_id: it.animalId,
      carcass_weight_kg: it.carcassWeight, cost_share: costShare, yield_pct: it.yieldPct
    }});
    steps.push({ table: "animals", op: "update", match: { id: it.animalId }, payload: { status: "slaughtered" } });
  });

  // optimistic local update
  DATA.slaughter_sessions.push({ id: sessionId, session_date: sessionDate, location, total_cost: totalCost, note });
  items.forEach(it => {
    DATA.slaughter_items.push({ id: uid(), session_id: sessionId, animal_id: it.animalId, carcass_weight_kg: it.carcassWeight, cost_share: costShare, yield_pct: it.yieldPct });
    const a = DATA.animals.find(x => x.id === it.animalId);
    if (a) a.status = "slaughtered";
  });

  await runSteps(steps);
  toast("Хадгалагдлаа -- " + items.length + " мал");
  await logActivity("slaughter", currentUser.display_name + " " + items.length + " малын бэлтгэл хийлээ");
  document.getElementById("s-totalcost").value = "";
  document.getElementById("s-note").value = "";
  document.getElementById("s-costshare").textContent = "--";
  renderSlaughterAnimalPicker();
  renderList("slaughter");
}

/* ============================================================
   TRANSPORT -- bundled, live cost-per-kg red warning
   ============================================================ */
function renderTransportAnimalPicker() {
  const el = document.getElementById("transport-animal-pick");
  const eligible = DATA.animals.filter(a => a.status === "slaughtered");
  if (eligible.length === 0) { el.innerHTML = `<div class="helper-text">Тээвэрлэх мал алга</div>`; return; }
  el.innerHTML = eligible.map(a => {
    const item = DATA.slaughter_items.find(si => si.animal_id === a.id);
    const cw = item ? item.carcass_weight_kg : 0;
    return `
    <div class="animal-row">
      <input type="checkbox" class="t-pick" value="${a.id}" data-weight="${cw}" onchange="calcTransportWeight()">
      <div class="info"><b>${a.animal_code}</b><br>${a.herder_name} · Гулууз: ${cw}кг</div>
    </div>`;
  }).join("");
}
function calcTransportWeight() {
  const checked = Array.from(document.querySelectorAll(".t-pick:checked"));
  const totalW = checked.reduce((a, cb) => a + parseFloat(cb.dataset.weight || 0), 0);
  document.getElementById("t-totalweight").textContent = fmt(totalW) + " кг";
  calcTransportCost();
}
function calcTransportCost() {
  const checked = document.querySelectorAll(".t-pick:checked").length;
  const totalW = parseFloat(document.getElementById("t-totalweight").textContent) || 0;
  const cost = parseFloat(document.getElementById("t-totalcost").value) || 0;
  const warnEl = document.getElementById("t-perkg-warn");
  if (cost > 0 && totalW > 0) {
    const perKg = cost / totalW;
    document.getElementById("t-perkg").textContent = fmt(perKg) + " ₮ / кг";
    warnEl.style.display = "flex";
  } else {
    warnEl.style.display = "none";
  }
}
async function submitTransport() {
  const checked = Array.from(document.querySelectorAll(".t-pick:checked"));
  if (checked.length === 0) { toast("Мал сонгоно уу"); return; }
  const totalCost = parseFloat(document.getElementById("t-totalcost").value) || 0;
  const sessionDate = document.querySelector('#form-transport input[name=session_date]').value;
  const note = document.getElementById("t-note").value;
  const costShare = totalCost / checked.length;
  const sessionId = uid();

  const steps = [{ table: "transport_sessions", payload: {
    id: sessionId, session_date: sessionDate, total_cost: totalCost, note, created_by: currentUser.id
  }}];
  const localItems = [];
  checked.forEach(cb => {
    const animalId = cb.value;
    const weight = parseFloat(cb.dataset.weight) || 0;
    const itemId = uid();
    steps.push({ table: "transport_items", payload: {
      id: itemId, session_id: sessionId, animal_id: animalId, weight_sent_kg: weight, cost_share: costShare
    }});
    steps.push({ table: "animals", op: "update", match: { id: animalId }, payload: { status: "transported" } });
    localItems.push({ id: itemId, session_id: sessionId, animal_id: animalId, weight_sent_kg: weight, cost_share: costShare });
  });

  DATA.transport_sessions.push({ id: sessionId, session_date: sessionDate, total_cost: totalCost, note });
  localItems.forEach(it => {
    DATA.transport_items.push(it);
    const a = DATA.animals.find(x => x.id === it.animal_id);
    if (a) a.status = "transported";
  });

  await runSteps(steps);
  toast("Хадгалагдлаа -- " + checked.length + " мал");
  await logActivity("transport", currentUser.display_name + " " + checked.length + " малыг тээвэрлэлээ");
  document.getElementById("t-totalcost").value = "";
  document.getElementById("t-note").value = "";
  document.getElementById("t-totalweight").textContent = "0 кг";
  document.getElementById("t-perkg-warn").style.display = "none";
  renderTransportAnimalPicker();
  renderList("transport");
}

/* ============================================================
   RECEIVING
   ============================================================ */
function populateReceivingSessions() {
  const sel = document.getElementById("r-session");
  const covered = new Set(DATA.receiving_sessions.map(r => r.transport_session_id));
  const pending = DATA.transport_sessions.filter(t => !covered.has(t.id));
  sel.innerHTML = '<option value="">-- сонгох --</option>' + pending.map(t => {
    const items = DATA.transport_items.filter(ti => ti.session_id === t.id);
    const w = items.reduce((a, x) => a + Number(x.weight_sent_kg || 0), 0);
    return `<option value="${t.id}">${t.session_date} · ${items.length} мал · ${fmt(w)}кг илгээсэн</option>`;
  }).join("");
}
function calcReceiving() {
  const sessionId = document.getElementById("r-session").value;
  const items = DATA.transport_items.filter(ti => ti.session_id === sessionId);
  const sentW = items.reduce((a, x) => a + Number(x.weight_sent_kg || 0), 0);
  const recvW = parseFloat(document.getElementById("r-weight").value) || 0;
  const lossEl = document.getElementById("r-loss");
  if (sessionId && recvW) {
    const loss = sentW - recvW;
    const pct = sentW ? (loss / sentW * 100) : 0;
    lossEl.textContent = `${fmt(loss)} кг (${pct.toFixed(1)}%)`;
  } else {
    lossEl.textContent = "--";
  }
}
async function submitReceiving() {
  const sessionId = document.getElementById("r-session").value;
  if (!sessionId) { toast("Тээврийн бүлэг сонгоно уу"); return; }
  const recvW = parseFloat(document.getElementById("r-weight").value) || 0;
  const receivedDate = document.querySelector('#form-receiving input[name=received_date]').value;
  const note = document.getElementById("r-note").value;
  const id = uid();

  const items = DATA.transport_items.filter(ti => ti.session_id === sessionId);
  const steps = [{ table: "receiving_sessions", payload: {
    id, transport_session_id: sessionId, received_date: receivedDate,
    total_weight_received: recvW, note, created_by: currentUser.id
  }}];
  items.forEach(it => {
    steps.push({ table: "animals", op: "update", match: { id: it.animal_id }, payload: { status: "received" } });
  });

  DATA.receiving_sessions.push({ id, transport_session_id: sessionId, received_date: receivedDate, total_weight_received: recvW, note });
  items.forEach(it => { const a = DATA.animals.find(x => x.id === it.animal_id); if (a) a.status = "received"; });

  await runSteps(steps);
  toast("Хадгалагдлаа");
  await logActivity("receiving", currentUser.display_name + " хүлээн авалт бүртгэлээ");
  document.getElementById("r-weight").value = "";
  document.getElementById("r-note").value = "";
  document.getElementById("r-loss").textContent = "--";
  populateReceivingSessions();
  renderList("receiving");
}

/* ============================================================
   PACKAGING
   ============================================================ */
function packagingRemaining(pkg) {
  const soldQty = DATA.sales.filter(s => s.packaging_id === pkg.id).reduce((a, s) => a + Number(s.qty || 0), 0);
  if (pkg.unit === "ширхэг") return Math.max(0, pkg.qty - soldQty);
  const repackagedOut = DATA.packagings.filter(p => p.source_packaging_id === pkg.id).reduce((a, p) => a + Number(p.weight_kg || 0), 0);
  return Math.max(0, pkg.weight_kg - soldQty - repackagedOut);
}
function toggleOrigin() {
  const isRepack = document.getElementById("pk-origin").value === "repackage";
  document.getElementById("pk-receiving-block").style.display = isRepack ? "none" : "block";
  document.getElementById("pk-source-block").style.display = isRepack ? "block" : "none";
  if (isRepack) populateSourceSelect();
  calcPackaging();
}
function populatePackagingSelects() {
  const sel = document.getElementById("pk-receiving");
  sel.innerHTML = DATA.receiving_sessions.map(r => {
    const t = DATA.transport_sessions.find(x => x.id === r.transport_session_id);
    return `<option value="${r.id}">${r.received_date} · ${fmt(r.total_weight_received)}кг хүлээж авсан</option>`;
  }).join("") || '<option value="">-- хүлээн авалт алга --</option>';
  populateSourceSelect();
}
function populateSourceSelect() {
  const sel = document.getElementById("pk-source");
  const cur = sel.value;
  sel.innerHTML = '<option value="">-- сонгох --</option>' + DATA.packagings
    .filter(p => p.unit === "кг" && packagingRemaining(p) > 0)
    .map(p => `<option value="${p.id}">${p.product_type} · ${fmt(packagingRemaining(p))} кг үлдсэн</option>`).join("");
  if (cur) sel.value = cur;
  updateSourceRemainingLabel();
}
function updateSourceRemainingLabel() {
  const src = DATA.packagings.find(p => p.id === document.getElementById("pk-source").value);
  document.getElementById("pk-source-remaining").textContent = src ? `Үлдэгдэл: ${fmt(packagingRemaining(src))} кг` : "";
}
function toggleKhorkhogUI() {
  const type = document.getElementById("pk-type").value;
  const isKh = !!KHORKHOG_SIZES[type];
  document.getElementById("pk-weight-block").style.display = isKh ? "none" : "block";
  document.getElementById("pk-qty-block").style.display = isKh ? "block" : "none";
}
document.getElementById("pk-type").addEventListener("change", () => { toggleKhorkhogUI(); calcPackaging(); });
function calcPackaging() {
  updateSourceRemainingLabel();
  toggleKhorkhogUI();
  const type = document.getElementById("pk-type").value;
  const isKh = !!KHORKHOG_SIZES[type];
  let totalWeight = 0;
  if (isKh) {
    const qty = parseFloat(document.getElementById("pk-qty").value) || 0;
    totalWeight = qty * KHORKHOG_SIZES[type];
  } else {
    totalWeight = parseFloat(document.getElementById("pk-weight").value) || 0;
  }
  document.getElementById("pk-totalweight").textContent = fmt(totalWeight) + " кг";
}
async function submitPackaging() {
  const type = document.getElementById("pk-type").value;
  if (!type) { toast("Бүтээгдэхүүний төрөл сонгоно уу"); return; }
  const isKh = !!KHORKHOG_SIZES[type];
  const qty = isKh ? (parseFloat(document.getElementById("pk-qty").value) || 0) : (parseFloat(document.getElementById("pk-weight").value) || 0);
  const weight = isKh ? qty * KHORKHOG_SIZES[type] : qty;
  const unit = isKh ? "ширхэг" : "кг";
  if (weight <= 0) { toast("Жин эсвэл тоог бөглөнө үү"); return; }

  const isRepack = document.getElementById("pk-origin").value === "repackage";
  let receivingSessionId = null, sourcePackagingId = null;
  if (isRepack) {
    sourcePackagingId = document.getElementById("pk-source").value;
    const src = DATA.packagings.find(p => p.id === sourcePackagingId);
    if (!src) { toast("Эх сурвалж сонгоно уу"); return; }
    if (weight > packagingRemaining(src) + 0.001) { toast("Эх сурвалжийн үлдэгдлээс их байна!"); return; }
  } else {
    receivingSessionId = document.getElementById("pk-receiving").value;
    if (!receivingSessionId) { toast("Хүлээн авалт сонгоно уу"); return; }
  }

  const date = document.querySelector('#form-packaging input[name=packaging_date]').value;
  const cost = parseFloat(document.querySelector('#form-packaging input[name=packaging_cost]').value) || 0;
  const note = document.querySelector('#form-packaging textarea[name=note]').value;
  const payload = {
    id: uid(), animal_id: null, receiving_session_id: receivingSessionId, source_packaging_id: sourcePackagingId,
    product_type: type, weight_kg: weight, unit, qty, packaging_date: date, packaging_cost: cost, note,
    created_by: currentUser.id
  };
  DATA.packagings.push(payload);
  await runSteps([{ table: "packagings", payload }]);
  toast("Хадгалагдлаа");
  await logActivity("packaging", currentUser.display_name + " баглаа боодол бэлдлээ");
  document.getElementById("pk-weight").value = "";
  document.getElementById("pk-qty").value = "";
  document.getElementById("pk-totalweight").textContent = "0 кг";
  document.querySelector('#form-packaging input[name=packaging_cost]').value = "";
  document.querySelector('#form-packaging textarea[name=note]').value = "";
  renderList("packaging");
  populatePackagingSelects();
}

/* ============================================================
   SALE
   ============================================================ */
function populateSaleProducts() {
  const sel = document.getElementById("sl-product");
  const cur = sel.value;
  sel.innerHTML = '<option value="">-- сонгох --</option>' + DATA.packagings
    .filter(p => packagingRemaining(p) > 0)
    .map(p => `<option value="${p.id}">${p.product_type} · ${fmt(packagingRemaining(p))} ${p.unit} үлдсэн</option>`).join("");
  if (cur) sel.value = cur;
}
function calcSale() {
  const pkg = DATA.packagings.find(p => p.id === document.getElementById("sl-product").value);
  const qty = parseFloat(document.getElementById("sl-qty").value) || 0;
  const price = parseFloat(document.getElementById("sl-price").value) || 0;
  document.getElementById("sl-total").textContent = fmt(qty * price) + " ₮";
  if (pkg) {
    document.getElementById("sl-remaining").textContent = `Үлдэгдэл: ${fmt(packagingRemaining(pkg))} ${pkg.unit}`;
    document.getElementById("sl-qty-label").textContent = "Тоо хэмжээ (" + pkg.unit + ")";
  } else {
    document.getElementById("sl-remaining").textContent = "";
  }
}
async function submitSale() {
  const pkgId = document.getElementById("sl-product").value;
  const pkg = DATA.packagings.find(p => p.id === pkgId);
  const qty = parseFloat(document.getElementById("sl-qty").value) || 0;
  if (!pkg) { toast("Бүтээгдэхүүн сонгоно уу"); return; }
  if (qty > packagingRemaining(pkg) + 0.001) { toast("Үлдэгдлээс их байна!"); return; }
  const price = parseFloat(document.getElementById("sl-price").value) || 0;
  const date = document.querySelector('#form-sale input[name=sale_date]').value;
  const customer = document.querySelector('#form-sale input[name=customer_name]').value;
  const phone = document.querySelector('#form-sale input[name=customer_phone]').value;
  const payload = {
    id: uid(), packaging_id: pkgId, qty, unit_price: price, total: qty * price,
    sale_date: date, customer_name: customer, customer_phone: phone, created_by: currentUser.id
  };
  DATA.sales.push(payload);
  await runSteps([{ table: "sales", payload }]);
  toast("Хадгалагдлаа");
  await logActivity("sale", currentUser.display_name + " борлуулалт бүртгэлээ");
  document.getElementById("sl-qty").value = "";
  document.getElementById("sl-price").value = "";
  document.getElementById("sl-total").textContent = "0 ₮";
  document.querySelector('#form-sale input[name=customer_name]').value = "";
  document.querySelector('#form-sale input[name=customer_phone]').value = "";
  populateSaleProducts();
  renderList("sale");
}

/* ============================================================
   GENERIC LIST RENDERING (Мал бэлтгэл / Тээвэрлэлт / Хүлээн авалт / Баглаа / Борлуулалт)
   ============================================================ */
async function quickAdminEdit(tableName, recordId) {
  const fields = EDITABLE_FIELDS[tableName];
  if (!fields) { toast("Энэ бичлэгийг засах боломжгүй"); return; }
  const record = DATA[tableName].find(r => r.id === recordId);
  if (!record) return;
  const fieldList = fields.map(([key, label], i) => `${i + 1}. ${label} (одоо: ${record[key]})`).join("\n");
  const choice = prompt(`Аль талбарыг засах вэ?\n${fieldList}\n\nДугаараа оруулна уу:`);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || !fields[idx]) return;
  const [key, label, type] = fields[idx];
  const newValRaw = prompt(`${label} -- шинэ утга (одоо: ${record[key]}):`);
  if (newValRaw === null || newValRaw === "") return;
  const newVal = type === "number" ? parseFloat(newValRaw) : newValRaw;
  record[key] = newVal;
  await runSteps([{ table: tableName, op: "update", match: { id: recordId }, payload: { [key]: newVal } }]);
  await logActivity("direct_edit", `${currentUser.display_name} засварлав: ${label} -> ${newVal}`);
  toast("Шинэчлэгдлээ");
  renderCurrentScreen();
}
function editOrRequestButton(tableName, recordId) {
  if (!EDITABLE_FIELDS[tableName]) return "";
  if (currentUser.role === "admin") {
    return `<button class="btn-ghost" onclick="quickAdminEdit('${tableName}','${recordId}')">Засах</button>`;
  }
  return `<button class="btn-ghost" onclick="openRequestChange('${tableName}','${recordId}')">Засвар хүсэх</button>`;
}
function renderList(key, filter) {
  const containers = {
    slaughter: "list-slaughter", transport: "list-transport", receiving: "list-receiving",
    packaging: "list-packaging", sale: "list-sale"
  };
  const el = document.getElementById(containers[key]);
  if (!el) return;
  let html = "";
  if (key === "slaughter") {
    let sessions = DATA.slaughter_sessions.slice().reverse();
    html = sessions.map(s => {
      const items = DATA.slaughter_items.filter(i => i.session_id === s.id);
      return `<div class="list-item">
        <div class="top-row"><div class="batch">${s.location || "Мал бэлтгэл"}</div><div class="date">${s.session_date}</div></div>
        <div class="details">${items.length} мал · Нийт зардал ${fmt(s.total_cost)}₮ · Толгой тутам ${fmt(s.total_cost / (items.length || 1))}₮</div>
        ${items.map(i => {
          const a = DATA.animals.find(x => x.id === i.animal_id);
          return `<div class="details" style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span>${a ? a.animal_code : "?"} (${i.carcass_weight_kg}кг, ${i.yield_pct ? i.yield_pct.toFixed(1) + "%" : "--"})</span>
            ${editOrRequestButton("slaughter_items", i.id)}
          </div>`;
        }).join("")}
      </div>`;
    }).join("");
  } else if (key === "transport") {
    html = DATA.transport_sessions.slice().reverse().map(s => {
      const items = DATA.transport_items.filter(i => i.session_id === s.id);
      const w = items.reduce((a, x) => a + Number(x.weight_sent_kg || 0), 0);
      return `<div class="list-item">
        <div class="top-row"><div class="batch">Тээвэр</div><div class="date">${s.session_date}</div></div>
        <div class="details">${items.length} мал · ${fmt(w)}кг · Зардал ${fmt(s.total_cost)}₮ (${fmt(s.total_cost / (w || 1))}₮/кг)</div>
      </div>`;
    }).join("");
  } else if (key === "receiving") {
    html = DATA.receiving_sessions.slice().reverse().map(r => {
      const t = DATA.transport_sessions.find(x => x.id === r.transport_session_id);
      const items = t ? DATA.transport_items.filter(i => i.session_id === t.id) : [];
      const sentW = items.reduce((a, x) => a + Number(x.weight_sent_kg || 0), 0);
      const loss = sentW - r.total_weight_received;
      return `<div class="list-item">
        <div class="top-row"><div class="batch">Хүлээн авалт</div><div class="date">${r.received_date}</div></div>
        <div class="details">${fmt(r.total_weight_received)}кг хүлээн авсан · Гарз ${fmt(loss)}кг</div>
        <div class="actions">${editOrRequestButton("receiving_sessions", r.id)}</div>
      </div>`;
    }).join("");
  } else if (key === "packaging") {
    let items = DATA.packagings.slice().reverse();
    if (filter) { const f = filter.toLowerCase(); items = items.filter(p => JSON.stringify(p).toLowerCase().includes(f)); }
    html = items.map(p => {
      const src = p.source_packaging_id ? DATA.packagings.find(x => x.id === p.source_packaging_id) : null;
      return `<div class="list-item">
        <div class="top-row"><div class="batch">${p.product_type}</div><div class="date">${p.packaging_date}</div></div>
        <div class="details">${fmt(p.weight_kg)}кг · Зардал ${fmt(p.packaging_cost)}₮ · Үлдэгдэл ${fmt(packagingRemaining(p))} ${p.unit}${src ? " · Эх сурвалж: " + src.product_type : ""}${p.note ? " · " + p.note : ""}</div>
        <div class="actions">${editOrRequestButton("packagings", p.id)}</div>
      </div>`;
    }).join("");
  } else if (key === "sale") {
    let items = DATA.sales.slice().reverse();
    if (filter) { const f = filter.toLowerCase(); items = items.filter(s => JSON.stringify(s).toLowerCase().includes(f)); }
    html = items.map(s => {
      const p = DATA.packagings.find(x => x.id === s.packaging_id);
      return `<div class="list-item">
        <div class="top-row"><div class="batch">${p ? p.product_type : "?"}</div><div class="date">${s.sale_date}</div></div>
        <div class="details">${s.qty} × ${fmt(s.unit_price)}₮ = ${fmt(s.total)}₮${s.customer_name ? " · " + s.customer_name : ""}${s.customer_phone ? " · ☎" + s.customer_phone : ""}</div>
        <div class="actions">${editOrRequestButton("sales", s.id)}</div>
      </div>`;
    }).join("");
  }
  el.innerHTML = html || `<div class="empty-state"><div class="big">--</div>Бичлэг алга байна</div>`;
}

/* ============================================================
   INVENTORY -- with simple next-week demand forecast
   ============================================================ */
function renderInventory() {
  const el = document.getElementById("inventory-content");
  const items = DATA.packagings.filter(p => packagingRemaining(p) > 0);

  const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const recentSales = DATA.sales.filter(s => new Date(s.sale_date) >= fourWeeksAgo);
  const soldByProduct = {};
  recentSales.forEach(s => {
    const p = DATA.packagings.find(x => x.id === s.packaging_id);
    if (!p) return;
    soldByProduct[p.product_type] = (soldByProduct[p.product_type] || 0) + Number(s.qty || 0);
  });
  const forecastRows = Object.entries(soldByProduct).map(([type, sold4wk]) => {
    const weeklyAvg = sold4wk / 4;
    const remaining = items.filter(p => p.product_type === type).reduce((a, p) => a + packagingRemaining(p), 0);
    const gap = weeklyAvg - remaining;
    return { type, weeklyAvg, remaining, gap };
  });

  let html = `<div class="card"><b style="font-size:14px;">Дараа долоо хоногийн хэрэгцээний төлөвлөгөө</b>
    <div class="helper-text">Сүүлийн 4 долоо хоногийн дундаж борлуулалт дээр үндэслэв</div>
    <table class="simple" style="margin-top:10px;">
    <tr><th>Бүтээгдэхүүн</th><th>7хоног/дундаж</th><th>Одоо үлдэгдэл</th><th>Нэмж хэрэгтэй</th></tr>
    ${forecastRows.map(r => `<tr><td>${r.type}</td><td>${fmt(r.weeklyAvg)}</td><td>${fmt(r.remaining)}</td>
      <td><span class="badge ${r.gap > 0 ? "bad" : "good"}">${r.gap > 0 ? fmt(r.gap) + " дутна" : "хангалттай"}</span></td></tr>`).join("")}
    ${forecastRows.length === 0 ? '<tr><td colspan="4">Мэдээлэл хараахан хангалтгүй</td></tr>' : ""}
    </table></div>`;

  html += `<table class="simple">
    <tr><th>Төрөл</th><th>Эх сурвалж</th><th>Үлдэгдэл</th></tr>
    ${items.slice().reverse().map(p => {
      const src = p.source_packaging_id ? DATA.packagings.find(x => x.id === p.source_packaging_id) : null;
      return `<tr><td>${p.product_type}</td><td>${src ? src.product_type : "Хүлээн авалтаас"}</td><td><b>${fmt(packagingRemaining(p))} ${p.unit}</b></td></tr>`;
    }).join("")}
  </table>`;
  if (items.length === 0) html = `<div class="empty-state"><div class="big">--</div>Агуулахад мах алга байна</div>`;
  el.innerHTML = html;
}

/* ============================================================
   DASHBOARD -- timeframe filter + interactive charts
   ============================================================ */
let dashTimeframe = "all";
function setDashTimeframe(tf) {
  dashTimeframe = tf;
  document.querySelectorAll("#dash-timeframe .btn-tab").forEach(b => b.classList.toggle("active", b.dataset.tf === tf));
  renderDashboard();
}
function withinTimeframe(dateStr) {
  if (dashTimeframe === "all" || !dateStr) return true;
  const d = new Date(dateStr);
  const now = new Date();
  const days = { week: 7, month: 30, quarter: 90, year: 365 }[dashTimeframe];
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}
function weekKey(dateStr) {
  const d = new Date(dateStr);
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
function renderDashboard() {
  const el = document.getElementById("dashboard-content");
  const animals = DATA.animals.filter(a => withinTimeframe(a.purchase_date));
  const slaughterSessions = DATA.slaughter_sessions.filter(s => withinTimeframe(s.session_date));
  const transportSessions = DATA.transport_sessions.filter(s => withinTimeframe(s.session_date));
  const packagings = DATA.packagings.filter(p => withinTimeframe(p.packaging_date));
  const sales = DATA.sales.filter(s => withinTimeframe(s.sale_date));

  const purchaseCost = animals.reduce((a, x) => a + Number(x.total_cost || 0), 0);
  const slaughterCost = slaughterSessions.reduce((a, x) => a + Number(x.total_cost || 0), 0);
  const transportCost = transportSessions.reduce((a, x) => a + Number(x.total_cost || 0), 0);
  const packagingCost = packagings.reduce((a, x) => a + Number(x.packaging_cost || 0), 0);
  const totalCost = purchaseCost + slaughterCost + transportCost + packagingCost;
  const revenue = sales.reduce((a, x) => a + Number(x.total || 0), 0);
  const profit = revenue - totalCost;

  let html = `<div class="stat-grid">
    <div class="stat"><div class="n">${animals.length}</div><div class="l">Худалдаж авсан мал</div></div>
    <div class="stat"><div class="n">${fmt(totalCost)}₮</div><div class="l">Нийт зардал</div></div>
    <div class="stat"><div class="n">${fmt(revenue)}₮</div><div class="l">Нийт орлого</div></div>
    <div class="stat"><div class="n" style="color:${profit >= 0 ? "#3F7A5C" : "#B4463B"}">${fmt(profit)}₮</div><div class="l">Цэвэр ашиг</div></div>
  </div>`;
  html += `<div class="chart-wrap"><canvas id="dash-cost-chart"></canvas></div>`;
  html += `<div class="chart-wrap"><canvas id="dash-trend-chart"></canvas></div>`;
  html += `<div class="chart-wrap"><canvas id="dash-soum-chart"></canvas></div>`;

  const yields = slaughterSessions.length
    ? DATA.slaughter_items.filter(i => slaughterSessions.some(s => s.id === i.session_id) && i.yield_pct != null)
    : [];
  const avgYield = yields.length ? yields.reduce((a, x) => a + x.yield_pct, 0) / yields.length : null;
  const sentTotal = transportSessions.reduce((a, s) => a + DATA.transport_items.filter(i => i.session_id === s.id).reduce((b, i) => b + Number(i.weight_sent_kg || 0), 0), 0);
  const recvSessions = DATA.receiving_sessions.filter(r => transportSessions.some(t => t.id === r.transport_session_id));
  const recvTotal = recvSessions.reduce((a, r) => a + Number(r.total_weight_received || 0), 0);
  const loss = sentTotal - recvTotal;

  html += `<div class="stat-grid">
    <div class="stat"><div class="n">${avgYield != null ? avgYield.toFixed(1) + "%" : "--"}</div><div class="l">Дундаж гарц</div></div>
    <div class="stat"><div class="n">${recvSessions.length ? fmt(loss) + " кг" : "--"}</div><div class="l">Тээврийн гарз</div></div>
  </div>`;

  el.innerHTML = html;

  if (window._dashCost) window._dashCost.destroy();
  window._dashCost = new Chart(document.getElementById("dash-cost-chart"), {
    type: "bar",
    data: { labels: ["Худалдан авалт", "Мал бэлтгэл", "Тээвэрлэлт", "Баглаа боодол"],
      datasets: [{ data: [purchaseCost, slaughterCost, transportCost, packagingCost], backgroundColor: "#B96E3B" }] },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, responsive: true }
  });

  const weekMap = {};
  sales.forEach(s => { const k = weekKey(s.sale_date); weekMap[k] = weekMap[k] || { rev: 0, cost: 0 }; weekMap[k].rev += Number(s.total || 0); });
  animals.forEach(a => { const k = weekKey(a.purchase_date); weekMap[k] = weekMap[k] || { rev: 0, cost: 0 }; weekMap[k].cost += Number(a.total_cost || 0); });
  const weeks = Object.keys(weekMap).sort();
  if (window._dashTrend) window._dashTrend.destroy();
  window._dashTrend = new Chart(document.getElementById("dash-trend-chart"), {
    type: "line",
    data: { labels: weeks, datasets: [
      { label: "Орлого", data: weeks.map(w => weekMap[w].rev), borderColor: "#3F7A5C", tension: 0.2 },
      { label: "Зардал", data: weeks.map(w => weekMap[w].cost), borderColor: "#B4463B", tension: 0.2 }
    ]},
    options: { responsive: true }
  });

  const soumMap = {};
  animals.forEach(a => { soumMap[a.soum] = (soumMap[a.soum] || 0) + Number(a.total_cost || 0); });
  if (window._dashSoum) window._dashSoum.destroy();
  window._dashSoum = new Chart(document.getElementById("dash-soum-chart"), {
    type: "bar",
    data: { labels: Object.keys(soumMap), datasets: [{ label: "Худалдан авалтын зардал", data: Object.values(soumMap), backgroundColor: "#1E5B4F" }] },
    options: { plugins: { legend: { display: false } }, responsive: true }
  });
}

/* ============================================================
   EXCEL EXPORT
   ============================================================ */
function exportExcel() {
  if (typeof XLSX === "undefined") { toast("Excel сан ачаалагдсангүй"); return; }
  const wb = XLSX.utils.book_new();
  const sheets = [
    ["Худалдан авалт", DATA.animals.map(a => ({
      Код: a.animal_code, Сум: a.soum, Огноо: a.purchase_date, Малчин: a.herder_name, Төрөл: a.animal_type,
      "Амьд жин": a.live_weight_kg, "Үнэ/кг": a.price_per_kg, "Нийт үнэ": a.total_cost,
      "Худ. авсан": a.purchasing_agent, Тайлбар: a.note, Төлөв: a.status
    }))],
    ["Мал бэлтгэл", DATA.slaughter_items.map(i => {
      const s = DATA.slaughter_sessions.find(x => x.id === i.session_id);
      const a = DATA.animals.find(x => x.id === i.animal_id);
      return { Код: a ? a.animal_code : "", Огноо: s ? s.session_date : "", "Гулуузын жин": i.carcass_weight_kg, "Гарц %": i.yield_pct, "Зардлын хувь": i.cost_share };
    })],
    ["Тээвэрлэлт", DATA.transport_items.map(i => {
      const s = DATA.transport_sessions.find(x => x.id === i.session_id);
      const a = DATA.animals.find(x => x.id === i.animal_id);
      return { Код: a ? a.animal_code : "", Огноо: s ? s.session_date : "", "Илгээсэн жин": i.weight_sent_kg, "Зардлын хувь": i.cost_share };
    })],
    ["Хүлээн авалт", DATA.receiving_sessions.map(r => ({ Огноо: r.received_date, "Хүлээн авсан жин": r.total_weight_received, Тайлбар: r.note }))],
    ["Баглаа боодол", DATA.packagings.map(p => ({
      Төрөл: p.product_type, Огноо: p.packaging_date, Жин: p.weight_kg, Нэгж: p.unit,
      Зардал: p.packaging_cost, Үлдэгдэл: packagingRemaining(p), Тайлбар: p.note
    }))],
    ["Борлуулалт", DATA.sales.map(s => {
      const p = DATA.packagings.find(x => x.id === s.packaging_id);
      return { Бүтээгдэхүүн: p ? p.product_type : "", Огноо: s.sale_date, "Тоо хэмжээ": s.qty, "Нэгж үнэ": s.unit_price, "Нийт дүн": s.total, Хэрэглэгч: s.customer_name, Утас: s.customer_phone };
    })]
  ];
  sheets.forEach(([name, data]) => {
    const ws = data.length ? XLSX.utils.json_to_sheet(data) : XLSX.utils.aoa_to_sheet([["Мэдээлэл алга"]]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  XLSX.writeFile(wb, `khongorshimt-${todayStr()}.xlsx`);
  toast("Excel файл татагдлаа");
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  setOnlineBar();
  updatePendingBadge();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  let session = null;
  try {
    const res = await sb.auth.getSession();
    session = res.data.session;
  } catch (err) { /* Supabase unreachable -- fall through to cache check below */ }

  const cachedProfile = await cacheGet("session_profile");
  if (session || (cachedProfile && !navigator.onLine)) {
    // Either a live session, or we're offline but this device has logged
    // in before -- trust the cache rather than lock the person out.
    await afterLogin();
    return;
  }
  // no session -- check if any profile exists yet to decide setup vs login
  try {
    const { count, error } = await sb.from("profiles").select("*", { count: "exact", head: true });
    if (error) throw error;
    showScreen(count === 0 ? "setup" : "login");
  } catch (err) {
    if (cachedProfile) { await afterLogin(); }
    else showScreen("login"); // truly offline with no prior login on this device -- nothing to do but wait for connection
  }
}
init();
