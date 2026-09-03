/* Хонгорын Шимт V6 - static PWA, Supabase + IndexedDB */
(function(){
'use strict';

const CONFIG = window.APP_CONFIG || {};
const SB = window.supabase;
const TABLES = ['herders','animals','processing_events','materials','transports','transport_items','receivings','products','sales','audit_logs'];
const REMOTE_VIEWS = {transports:'transport_summary', products:'product_balances', audit_logs:'audit_feed'};
const OFFLINE_MUTATIONS = new Set(['herder_create','animal_create','processing_create','transport_create']);
const SOUMS = [
  {name:'Богд',code:'BOG'}, {name:'Жинст',code:'JIN'}, {name:'Бөмбөгөр',code:'BUM'}, {name:'Баянцагаан',code:'BTS'}
];
const KHORKHOG = {'Хорхог 1.5кг':1.5,'Хорхог 2.3кг':2.3,'Хорхог 3.3кг':3.3};
const IDB_NAME='khongor_shimt_v6'; const IDB_VERSION=1;
let idb, client=null, session=null, profile=null, syncing=false;
let cache={herders:[],animals:[],processing_events:[],materials:[],transports:[],transport_items:[],receivings:[],products:[],sales:[],audit_logs:[]};
let settings={soum:'', lastSync:null};

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v)=>Number.isFinite(Number(v))?Number(v):0;
const fmt=(v,dec=1)=>num(v).toLocaleString('mn-MN',{maximumFractionDigits:dec});
// Weights always show 3 decimals (12 -> 12.000) so partial cuts like
// 3.545 kg are never silently rounded. Money stays whole tögrög.
const fmtKg=v=>num(v).toLocaleString('mn-MN',{minimumFractionDigits:3,maximumFractionDigits:3});
// Local calendar date, not UTC. Mongolia is UTC+8, so toISOString() would
// return the previous day for any local time before 08:00 -- which silently
// pre-filled forms with yesterday's date during early-morning work.
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}
function isOnline(){return navigator.onLine}
function uuid(){return crypto.randomUUID()}
function appConfigReady(){return !!(CONFIG.SUPABASE_URL&&CONFIG.SUPABASE_ANON_KEY&&SB)}

function openIDB(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open(IDB_NAME,IDB_VERSION);
  req.onupgradeneeded=e=>{
    const db=e.target.result;
    if(!db.objectStoreNames.contains('records')) db.createObjectStore('records',{keyPath:'key'});
    if(!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox',{keyPath:'event_id'});
    if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings',{keyPath:'key'});
  };
  req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
})}
function tx(store,mode='readonly'){return idb.transaction(store,mode).objectStore(store)}
function idbPut(store,val){return new Promise((res,rej)=>{const r=tx(store,'readwrite').put(val);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function idbGet(store,key){return new Promise((res,rej)=>{const r=tx(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function idbGetAll(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function idbDelete(store,key){return new Promise((res,rej)=>{const r=tx(store,'readwrite').delete(key);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
async function saveLocalRecord(table,row,state='synced'){await idbPut('records',{key:`${table}:${row.id}`,table,row:{...row,_sync_state:state}})}
async function loadLocal(){
  const rows=await idbGetAll('records');
  for(const k of TABLES) cache[k]=[];
  rows.forEach(x=>{if(cache[x.table]) cache[x.table].push(x.row)});
  const s=await idbGet('settings','app'); if(s?.value) settings=s.value;
}
async function saveSettings(){await idbPut('settings',{key:'app',value:settings})}
async function addOutbox(type,payload){const event={event_id:uuid(),type,payload,created_at:new Date().toISOString(),status:'pending',attempts:0,error:null};await idbPut('outbox',event);return event}
async function removeOutbox(id){await idbDelete('outbox',id)}

function supa(){
  if(!appConfigReady()) return null;
  if(!client) client=SB.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  return client;
}
async function ensureAuth(){
  if(!appConfigReady()){renderSetup();return false}
  const c=supa(); const r=await c.auth.getSession(); session=r.data.session||null;
  if(!session){renderLogin();return false}
  // Offline-safe profile load. The Supabase session itself is persisted
  // locally, so being offline must not log anybody out. We cache the profile
  // on every successful online load and fall back to that cache when the
  // network is unavailable -- otherwise the app becomes unusable in exactly
  // the remote conditions it was built for.
  const cachedKey='ks_profile_'+session.user.id;
  try{
    const pr=await c.from('profiles').select('id,role,full_name,soum').eq('id',session.user.id).maybeSingle();
    if(pr.error) throw pr.error;
    if(pr.data){
      profile=pr.data;
      try{localStorage.setItem(cachedKey,JSON.stringify(profile))}catch(_){}
      return true;
    }
    renderError('Хэрэглэгчийн профайл тохируулаагүй байна','Supabase дээр profiles хүснэгтэд таны хэрэглэгчийн мөрийг үүсгэнэ үү.');
    return false;
  }catch(err){
    let cached=null;
    try{cached=JSON.parse(localStorage.getItem(cachedKey)||'null')}catch(_){}
    if(cached){ profile=cached; return true; }
    renderError('Профайл уншихад алдаа гарлаа', (err&&errMn(err))||'Сүлжээгүй байна. Нэг удаа онлайн орж нэвтэрнэ үү.');
    return false;
  }
}

function renderSetup(){
  $('app').innerHTML=`<main><div class="card"><h2 class="section-title">⚙️ Холболтын тохиргоо</h2><p class="section-note">Эхлээд <b>config.js</b> файлд Supabase Project URL болон зөвхөн frontend-д ашиглах Publishable/Anon key-гээ оруулна уу.</p><ol class="muted"><li>Supabase → Project Settings → API</li><li>Project URL-ийг хуул.</li><li>Publishable/Anon key-ийг хуул.</li><li>config.js файлд оруул.</li></ol><div class="warn">⚠️ Service Role key-г frontend-д хэзээ ч бүү хий.</div></div></main>`;
}
function renderError(title,msg){$('app').innerHTML=`<main><div class="card"><h2 class="section-title">⚠️ ${esc(title)}</h2><p>${esc(msg)}</p><button class="btn-secondary" onclick="location.reload()">Дахин оролдох</button></div></main>`}
function renderLogin(){
  $('app').innerHTML=`<main><div class="card" style="max-width:420px;margin:50px auto"><div style="font-size:32px">🐑</div><h2 class="section-title">Хонгорын Шимт</h2><p class="section-note">Махны мөшгөлт ба үйл ажиллагаа</p><form id="loginForm"><label>Имэйл</label><input type="email" name="email" required autocomplete="username"><label>Нууц үг</label><input type="password" name="password" required autocomplete="current-password"><button class="btn-primary">Нэвтрэх</button></form></div></main>`;
  $('loginForm').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);const r=await supa().auth.signInWithPassword({email:f.get('email'),password:f.get('password')});if(r.error)throw r.error;await boot()}catch(err){toast('Нэвтрэхэд алдаа: '+errMn(err))}};
}

function shell(){
  $('app').innerHTML=`
  <header class="topbar"><div class="brand"><img class="logo-img" src="./logo-mark.png" alt="Хонгорын Шимт"><div class="titles"><b>Мах Хяналт</b><span id="userLabel"></span></div></div><div class="top-actions"><span id="netDot" class="status-dot"></span><select class="top-select" id="soumSelect"><option value="">Сум сонгох</option></select><button class="backbtn" id="logoutBtn">Гарах</button></div></header>
  <main id="main"></main>`;
  SOUMS.forEach(s=>{const o=document.createElement('option');o.value=s.name;o.textContent=s.name;$('soumSelect').appendChild(o)});const sh=document.createElement('option');sh.value='Дэлгүүр';sh.textContent='Дэлгүүр (төв)';$('soumSelect').appendChild(sh);
  // An admin with an assigned soum works only from that location, so the
  // picker is replaced by a plain read-only label. Superadmin (and anyone
  // without an assigned soum) keeps the selector.
  if(profile?.role!=='superadmin' && profile?.soum){
    settings.soum=profile.soum; saveSettings();
    const sel=$('soumSelect'); const tag=document.createElement('span');
    tag.className='top-select'; tag.style.cssText='display:inline-block;padding:8px 10px;';
    tag.textContent=profile.soum;
    sel.replaceWith(tag);
  } else {
    $('soumSelect').value=settings.soum||''; $('soumSelect').onchange=()=>{settings.soum=$('soumSelect').value;saveSettings();renderHome()};
  }
  $('logoutBtn').onclick=async()=>{
    const pending=(await idbGetAll('outbox')).length;
    if(pending){
      if(!confirm(`Синк хүлээж буй ${pending} бичлэг байна. Гарвал энэ төхөөрөмжөөс алдагдаж болзошгүй.\n\nҮнэхээр гарах уу?`))return;
    } else if(!navigator.onLine){
      if(!confirm('Та одоо офлайн байна. Гарвал дахин интернэт холбогдох хүртэл нэвтэрч чадахгүй.\n\nҮнэхээр гарах уу?'))return;
    } else {
      if(!confirm('Системээс гарах уу?'))return;
    }
    await supa().auth.signOut();location.reload()};
  $('userLabel').textContent=`${profile?.full_name||session?.user?.email||''} · ${profile?.role||''}`;
  updateNet();window.addEventListener('online',()=>{updateNet();syncNow().then(refreshAll)});window.addEventListener('offline',updateNet);
}
function updateNet(){const d=$('netDot');if(!d)return;d.className='status-dot '+(isOnline()?'status-online':'status-offline');d.title=isOnline()?'Интернэттэй':'Интернэтгүй'}

// --- Brand line icons (inline SVG: consistent on every device, unlike emoji) ---
function ic(name){
 const P='stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
 const paths={
  dashboard:`<path ${P} d="M3 13h5v8H3zM10 3h5v18h-5zM17 9h5v12h-5z"/>`,
  purchase:`<path ${P} d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="10" cy="20" r="1.3" ${P}/><circle cx="17" cy="20" r="1.3" ${P}/>`,
  processing:`<path ${P} d="M14 3l7 7-4 4-7-7zM10.5 10.5L3 18v3h3l7.5-7.5"/>`,
  transport:`<path ${P} d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6" ${P}/><circle cx="17.5" cy="18" r="1.6" ${P}/>`,
  receiving:`<path ${P} d="M12 3v10m0 0l-3.5-3.5M12 13l3.5-3.5"/><path ${P} d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>`,
  packaging:`<path ${P} d="M3 8l9-4 9 4-9 4z"/><path ${P} d="M3 8v8l9 4 9-4V8"/><path ${P} d="M12 12v8"/>`,
  sales:`<circle cx="12" cy="12" r="8.5" ${P}/><path ${P} d="M12 7v10M14.5 9.5c0-1-1.1-1.6-2.5-1.6s-2.5.6-2.5 1.7c0 2.4 5 1.4 5 3.8 0 1.1-1.1 1.7-2.5 1.7s-2.5-.6-2.5-1.6"/>`,
  inventory:`<path ${P} d="M3 7h18v13H3zM3 7l2-3h14l2 3M9 12h6"/>`,
  history:`<path ${P} d="M5 5h11l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path ${P} d="M8 11h8M8 15h5"/>`,
  herders:`<circle cx="8.5" cy="8" r="3" ${P}/><circle cx="16" cy="9" r="2.4" ${P}/><path ${P} d="M2.5 19v-1c0-2.8 2.7-5 6-5s6 2.2 6 5v1"/><path ${P} d="M15 13.2c2.4.3 4.5 2.1 4.5 4.6v1.2"/>`
 };
 return `<svg class="ico" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">${paths[name]||''}</svg>`;
}

function renderHome(){
 const soum=settings.soum||'Сум сонгоогүй';
 $('main').innerHTML=`<div class="syncbar"><span class="status-dot ${isOnline()?'status-online':'status-offline'}"></span><span>${isOnline()?'Интернэттэй':'Интернэтгүй'} · ${settings.lastSync?'Сүүлд синк: '+new Date(settings.lastSync).toLocaleString('mn-MN'):'Одоогоор синк хийгдээгүй'}</span><span style="margin-left:auto"><button class="btn-ghost" onclick="syncNow().then(refreshAll)"><span class="ic">↻</span> Синк</button></span></div>
 <div class="grid">
 <div class="tile wide dashboard" onclick="navigate('dashboard')"><div style="display:flex;align-items:center;gap:12px"><span class="icon" style="color:#fff">${ic('dashboard')}</span><div><div class="label">Хянах самбар</div><div class="sub">Зардал, борлуулалт, гарц</div></div></div><div style="font-size:26px">›</div></div>
 <div class="tile" onclick="navigate('purchase')"><div class="icon">${ic('purchase')}</div><div class="label">Худалдан авалт</div><div class="sub">Малчнаас мал авах</div></div>
 <div class="tile" onclick="navigate('processing')"><div class="icon">${ic('processing')}</div><div class="label">Мал төхөөрөх ажиллагаа</div><div class="sub">Мах бэлтгэл</div></div>
 <div class="tile" onclick="navigate('transport')"><div class="icon">${ic('transport')}</div><div class="label">Тээвэрлэлт</div><div class="sub">Дэлгүүр рүү илгээх</div></div>
 <div class="tile" onclick="navigate('receiving')"><div class="icon">${ic('receiving')}</div><div class="label">Хүлээн авалт</div><div class="sub">Дэлгүүрт хүлээн авах</div></div>
 <div class="tile" onclick="navigate('packaging')"><div class="icon">${ic('packaging')}</div><div class="label">Баглаа боодол</div><div class="sub">Мах бэлдэх, савлах</div></div>
 <div class="tile" onclick="navigate('sales')"><div class="icon">${ic('sales')}</div><div class="label">Борлуулалт</div><div class="sub">Хэрэглэгчид зарах</div></div>
 <div class="tile" onclick="navigate('inventory')"><div class="icon">${ic('inventory')}</div><div class="label">Агуулах</div><div class="sub">Одоогийн нөөц</div></div>
 <div class="tile" onclick="navigate('history')"><div class="icon">${ic('history')}</div><div class="label">Түүх</div><div class="sub">Хэн, хэзээ өөрчилсөн</div></div>
 </div>
 <div class="tile wide" style="margin-top:12px" onclick="navigate('herders')"><div style="display:flex;align-items:center;gap:12px"><span class="icon">${ic('herders')}</span><div><div class="label">Малчид</div><div class="sub">Жагсаалт, хувь нэмэр</div></div></div><div style="font-size:26px">›</div></div>
 <div class="card" style="margin-top:14px"><b>Одоогийн байрлал:</b> ${esc(soum)}<div class="helper">Сум дээр худалдан авалт, нядалга, тээвэрлэлтийг offline хийж болно.</div></div>`;
}
function navigate(screen){
  if(screen==='home')return renderHome();
  if(['receiving','packaging','sales','dashboard','inventory','history','herders'].includes(screen)&&!isOnline()){toast('Энэ хэсэг интернэттэй үед ажиллана');return}
  const names={purchase:'Худалдан авалт',processing:'Мал төхөөрөх ажиллагаа',transport:'Тээвэрлэлт',receiving:'Хүлээн авалт',packaging:'Баглаа боодол',sales:'Борлуулалт',inventory:'Агуулах',dashboard:'Хянах самбар',history:'Үйл ажиллагааны түүх',herders:'Малчид'};
  $('main').innerHTML=`<div class="split"><div><h2 class="section-title">${names[screen]}</h2></div><button class="btn-secondary" onclick="renderHome()">← Нүүр</button></div><div id="view"></div>`;
  ({purchase:renderPurchase,processing:renderProcessing,transport:renderTransport,receiving:renderReceiving,packaging:renderPackaging,sales:renderSales,inventory:renderInventory,dashboard:renderDashboard,history:renderHistory,herders:renderHerders})[screen]?.();
}

function sourceAnimalOptions(){return cache.animals.filter(a=>a._sync_state==='synced').sort((a,b)=>b.purchase_date?.localeCompare(a.purchase_date||'')||0)}
function materialAvailable(materialId){
  // calculated using all central movements stored on materials. The material row has current_available refreshed by server RPC.
  const m=cache.materials.find(x=>x.id===materialId); return m?num(m.current_available):0;
}
function productAvailable(productId){const p=cache.products.find(x=>x.id===productId);return p?num(p.current_available):0}
function formCard(inner){return `<div class="card">${inner}</div>`}

function renderPurchase(){
 $('view').innerHTML=formCard(`<form id="purchaseForm">
 <label>Огноо</label><input type="date" name="date" value="${today()}" required>
 <label>Аймаг</label><input name="aimag" value="Баянхонгор" readonly>
 <label>Сум</label>${(profile?.role!=='superadmin'&&profile?.soum)?`<input name="soum" value="${esc(profile.soum)}" readonly>`:`<select name="soum" required><option value="" ${settings.soum?'':'selected'}>-- сум сонгох --</option>${SOUMS.map(s=>`<option ${settings.soum===s.name?'selected':''}>${s.name}</option>`).join('')}</select>`}
 <div class="row2"><div><label>Малчны овог</label><input name="herderSurname" required placeholder="Жишээ: Дондов"></div><div><label>Малчны нэр</label><input name="herderGiven" required placeholder="Жишээ: Батэрдэнэ"></div></div>
 <label>Хариуцлагатай Нүүдэлчин стандартаар баталгаажсан эсэх (MNS 6891)</label>
 <select name="certified"><option value="false">Үгүй</option><option value="true">Тийм</option></select>
 <label>Мал сүргийн вакцинд хамрагдсан огноо</label><input type="date" name="vaccinationDate" required>
 <label>Мал төрөл</label><select name="animalType" required><option value="">-- сонгох --</option><option>Ямаа</option><option>Хонь</option><option>Үхэр</option><option>Адуу</option><option>Тэмээ</option></select>
 <div class="row2"><div><label>Амьд жин (кг)</label><input type="number" name="liveWeight" min="0.1" step="0.001" required></div><div><label>Үнэ / кг (₮)</label><input type="number" name="pricePerKg" min="0" step="1" required></div></div>
 <div class="calc-box"><span>Нийт үнэ:</span><b id="purchaseTotal">0 ₮</b></div>
 <label>Тайлбар (заавал биш)</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`)+`<div id="purchaseList"></div>`;
 const f=$('purchaseForm');function c(){ $('purchaseTotal').textContent=fmt(num(f.liveWeight.value)*num(f.pricePerKg.value),0)+' ₮'};f.oninput=c;
 f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);await createPurchase(fd)};renderPurchaseList();
}
async function createPurchase(fd){
 const surname=String(fd.get('herderSurname')||'').trim();
 const givenName=String(fd.get('herderGiven')||'').trim();
 const herderName=[surname,givenName].filter(Boolean).join(' ');
 const soum=String(fd.get('soum')), animalType=String(fd.get('animalType'));
 const certified=String(fd.get('certified'))==='true';
 const vaccinationDate=String(fd.get('vaccinationDate')||'')||null;
 const aimag=String(fd.get('aimag')||'Баянхонгор');
 const herder={id:uuid(),full_name:herderName,surname,given_name:givenName,aimag,soum,location_detail:null,herd_size:null,last_vaccination_date:vaccinationDate,certified,created_by:session.user.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 // Reuse existing local/central herder by exact name+soum when possible.
 let existing=cache.herders.find(h=>h.full_name===herderName&&h.soum===soum);
 if(!existing){
   existing=herder; cache.herders.push({...existing,_sync_state:'pending'});
   await saveLocalRecord('herders',existing,'pending');
   if(isOnline()){try{existing=await upsertDirect('herders',existing);cache.herders=cache.herders.filter(h=>h.id!==existing.id).concat({...existing,_sync_state:'synced'});}catch(err){await addOutbox('herder_create',existing);toast('Малчны мэдээлэл түр хадгалагдлаа')}}
   else await addOutbox('herder_create',existing);
 } else if(existing._sync_state!=='synced'){
   if(isOnline()){try{await upsertDirect('herders',existing)}catch(err){return toast('Малчны мэдээллийг эхлээд синк хийнэ үү')}}
   else return toast('Энэ малчны мэдээлэл синк хийгдээгүй байна');
 } else {
   // Known herder: certification status and vaccination date can legitimately
   // change between purchases, so refresh them rather than silently keeping
   // whatever was recorded the first time this herder was entered.
   const changed = existing.certified!==certified ||
     (vaccinationDate && existing.last_vaccination_date!==vaccinationDate);
   if(changed && isOnline()){
     const upd={...existing,certified,last_vaccination_date:vaccinationDate||existing.last_vaccination_date,updated_at:new Date().toISOString()};
     try{
       const saved=await upsertDirect('herders',upd);
       cache.herders=cache.herders.filter(h=>h.id!==saved.id).concat({...saved,_sync_state:'synced'});
       existing=saved;
     }catch(err){ /* keep the purchase moving; herder detail can be corrected later */ }
   }
 }
 const live=num(fd.get('liveWeight')), price=num(fd.get('pricePerKg'));
 const animal={id:uuid(),animal_code:`${(SOUMS.find(s=>s.name===soum)?.code||'GEN')}-${String(fd.get('date')).slice(2).replace(/-/g,'')}-${crypto.randomUUID().slice(0,6).toUpperCase()}`,herder_id:existing.id,soum,purchase_date:String(fd.get('date')),animal_type:animalType,estimated_age_years:null,live_weight_kg:live,price_per_kg:price,total_cost:live*price,status:'PURCHASED',note:fd.get('note')||null,created_by:session.user.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 cache.animals.push({...animal,_sync_state:'pending'});await saveLocalRecord('animals',animal,'pending');
 if(isOnline()){try{const saved=await upsertDirect('animals',animal);cache.animals=cache.animals.filter(a=>a.id!==animal.id).concat({...saved,_sync_state:'synced'});await saveLocalRecord('animals',saved,'synced');toast('Хадгалагдлаа')}catch(err){await addOutbox('animal_create',animal);toast('Локалд хадгаллаа — синк хүлээж байна')}} else {await addOutbox('animal_create',animal);toast('Offline хадгаллаа — интернэт ормогц синк хийнэ')}
 $('purchaseForm').reset();$('purchaseTotal').textContent='0 ₮';renderPurchaseList();
}
function renderPurchaseList(){const el=$('purchaseList');if(!el)return;const items=cache.animals.slice().reverse();el.innerHTML=items.length?items.map(a=>`<div class="list-item"><div class="top-row"><div class="batch">${esc(a.animal_code)}</div><div class="date">${esc(a.purchase_date)}</div></div><div class="details">${esc(cache.herders.find(h=>h.id===a.herder_id)?.full_name||'—')} · ${esc(a.soum)} · ${esc(a.animal_type)} · ${fmtKg(a.live_weight_kg)} кг · ${fmt(a.total_cost,0)}₮ ${a._sync_state!=='synced'?'<span class="badge neutral">Синк хүлээж байна</span>':''}</div></div>`).join(''):'<div class="empty"><div class="big">🗒️</div>Бичлэг алга байна</div>'}

function renderProcessing(){
 const animals=sourceAnimalOptions().filter(a=>a.status==='PURCHASED');
 $('view').innerHTML=(isOnline()?'':`<div class="warn">⚠️ Offline горим. Энэ амьтны худалдан авалт өмнө нь төв сервертэй синк болсон байх ёстой.</div>`)+formCard(`<form id="processingForm"><label>Худалдан авсан малын жагсаалт</label><select name="animal_id" required>${animals.map(a=>`<option value="${a.id}">${esc(a.animal_code)} · ${esc(a.animal_type)} · ${fmtKg(a.live_weight_kg)} кг · ${esc(a.purchase_date||'')}</option>`).join('')||'<option value="">Боломжит амьтан алга</option>'}</select><label>Огноо</label><input type="date" name="date" value="${today()}" required><div class="row2"><div><label>Махны гарц (кг)</label><input type="number" name="meat_kg" min="0" step="0.001" required></div><div><label>Дайвар (кг)</label><input type="number" name="byproduct_kg" min="0" step="0.001" value="0" required></div></div><div class="calc-box"><span>Мал бэлтгэсний дараах жингийн зөрүү:</span><b id="procDiff">—</b></div><label>Зардал (₮)</label><input type="number" name="cost" min="0" step="1" value="0"><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('processingForm');function calc(){const a=cache.animals.find(x=>x.id===f.animal_id.value);const d=a?num(a.live_weight_kg)-num(f.meat_kg.value)-num(f.byproduct_kg.value):0;$('procDiff').textContent=fmtKg(d)+' кг'}f.oninput=calc;f.onsubmit=async e=>{e.preventDefault();await createProcessing(new FormData(f))};calc();
}
async function createProcessing(fd){
 const aid=String(fd.get('animal_id')), a=cache.animals.find(x=>x.id===aid);if(!a)return toast('Амьтан сонгоно уу');if(a._sync_state!=='synced')return toast('Энэ амьтны худалдан авалт төв сервертэй синк болоогүй байна');
 const payload={processing:{id:uuid(),animal_id:aid,processing_date:String(fd.get('date')),location:String(fd.get('location')||''),responsible_user:session.user.id,processing_cost:num(fd.get('cost')),note:fd.get('note')||null},outputs:[{id:uuid(),animal_id:aid,material_type:'MEAT',quantity_kg:num(fd.get('meat_kg'))},{id:uuid(),animal_id:aid,material_type:'BYPRODUCT',quantity_kg:num(fd.get('byproduct_kg'))}]};
 if(isOnline()){try{await rpc('create_processing_bundle',{p_payload:payload});await pullData();toast('Хадгалагдлаа')}catch(err){toast('Хадгалах алдаа: '+errMn(err));return}}
 else {
   const proc={...payload.processing,_sync_state:'pending'}; await saveLocalRecord('processing_events',proc,'pending');
   cache.processing_events.push(proc);
   for(const o of payload.outputs){const mat={id:o.id,animal_id:aid,animal_code:a.animal_code,source_processing_id:payload.processing.id,parent_lot_id:null,material_type:o.material_type,original_quantity_kg:o.quantity_kg,location_type:a.soum,current_available:o.quantity_kg,_sync_state:'pending'};cache.materials.push(mat);await saveLocalRecord('materials',mat,'pending');}
   a.status='PROCESSED'; await saveLocalRecord('animals',a,a._sync_state);
   await addOutbox('processing_create',payload);toast('Offline хадгаллаа — дараа синк хийнэ')
 }
 renderProcessing();
}

function renderTransport(){
 const mats=cache.materials.filter(m=>num(m.current_available)>0 && m.location_type!=='SHOP');
 $('view').innerHTML=formCard(`<form id="transportForm"><label>Тээвэрлэхэд бэлэн</label><select name="material_id" required>${mats.map(m=>`<option value="${m.id}">${esc(m.animal_code||'—')} · ${esc(m.animal_type||'')} · ${m.material_type==='MEAT'?'Мах':'Дайвар'} · ${fmtKg(m.current_available)} кг</option>`).join('')||'<option value="">Тээвэрлэх нөөц алга</option>'}</select><label>Огноо</label><input type="date" name="date" value="${today()}" required><label>Илгээсэн жин (кг)</label><input type="number" name="weight" min="0.001" step="0.001" required><div class="helper" id="transportAvail"></div><label>Тээврийн зардал (₮)</label><input type="number" name="cost" min="0" step="1" value="0"><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('transportForm');
 // Default the sent weight to everything available for the chosen material,
 // and cap it there, so "илгээсэн жин" always matches the listed amount
 // unless the user deliberately sends a partial load.
 const syncW=()=>{
   const m=cache.materials.find(x=>x.id===f.material_id.value);
   if(!m)return;
   const avail=num(m.current_available);
   f.weight.max=avail;
   f.weight.value=avail.toFixed(3);
   const hint=$('transportAvail');
   if(hint)hint.textContent=`Тээвэрлэхэд бэлэн: ${fmtKg(avail)} кг`;
 };
 f.material_id.onchange=syncW; syncW();
 f.onsubmit=async e=>{e.preventDefault();await createTransport(new FormData(f))}
}
async function createTransport(fd){
 const mid=String(fd.get('material_id')),m=cache.materials.find(x=>x.id===mid);const w=num(fd.get('weight'));if(!m||w<=0)return toast('Материал/жин буруу');if(w>num(m.current_available)+.0001)return toast('Үлдэгдлээс их байна');
 const payload={transport:{id:uuid(),transport_date:String(fd.get('date')),source_location:m.location_type,destination_location:'SHOP',responsible_user:session.user.id,cost:num(fd.get('cost')),note:fd.get('note')||null},items:[{id:uuid(),source_material_id:mid,animal_id:m.animal_id,quantity_sent_kg:w}]};
 if(isOnline()){try{await rpc('create_transport_bundle',{p_payload:payload});await pullData();toast('Хадгалагдлаа')}catch(err){toast('Хадгалах алдаа: '+errMn(err));return}}else{await addOutbox('transport_create',payload);toast('Offline хадгалаглаа — дараа синк хийнэ')}
 renderTransport();
}

function transportLabel(t){
 const items=cache.transport_items.filter(i=>i.transport_id===t.id);
 const codes=[...new Set(items.map(i=>{const a=cache.animals.find(x=>x.id===i.animal_id);return a?.animal_code||''}).filter(Boolean))];
 const who=codes.length?(codes.length>2?codes.slice(0,2).join(', ')+' +'+(codes.length-2):codes.join(', ')):'—';
 const types=[...new Set(items.map(i=>{const a=cache.animals.find(x=>x.id===i.animal_id);return a?.animal_type||''}).filter(Boolean))];
 return `${who} · ${types.join(', ')||''} · ${fmtKg(t.total_sent_kg||0)} кг · ${t.transport_date}`;
}
function renderReceiving(){
 const ts=cache.transports.filter(t=>t.destination_location==='SHOP'&&!t.is_received).sort((a,b)=>b.transport_date?.localeCompare(a.transport_date||'')||0);
 $('view').innerHTML=formCard(`<form id="receivingForm"><label>Тээвэр</label><select name="transport_id" required>${ts.map(t=>`<option value="${t.id}">${esc(transportLabel(t))}</option>`).join('')||'<option>Тээвэр алга</option>'}</select><label>Хүлээн авсан огноо</label><input type="date" name="date" value="${today()}" required><label>Хүлээн авсан жин (кг)</label><input type="number" name="weight" min="0" step="0.001" required><div class="calc-box"><span>Жингийн зөрүү (Дэлгүүрт хүлээн авах үеийн):</span><b id="recvDiff">—</b></div><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('receivingForm');function c(){const t=cache.transports.find(x=>x.id===f.transport_id.value);$('recvDiff').textContent=t?fmt(num(t.total_sent_kg)-num(f.weight.value))+' кг':'—'}f.oninput=c;f.onchange=c;f.onsubmit=async e=>{e.preventDefault();const t=cache.transports.find(x=>x.id===f.transport_id.value);if(!t)return;try{await rpc('receive_transport',{p_transport_id:t.id,p_received_date:String(f.date.value),p_note:f.note.value||null,p_user_id:session.user.id,p_received_weight_kg:num(f.weight.value)});await pullData();toast('Хүлээн авалт хадгалагдлаа');renderReceiving()}catch(err){toast('Алдаа: '+errMn(err))}};c();
}

function renderPackaging(){
 const mats=cache.materials.filter(m=>m.location_type==='SHOP'&&num(m.current_available)>0);  // shop stock: meat and byproduct alike, same list as Агуулахconst products=cache.products.filter(p=>num(p.current_available)>0);
 $('view').innerHTML=formCard(`<form id="packForm"><label>Хүлээн авсан махны нөөц</label><select name="material_id" required>${mats.map(m=>`<option value="${m.id}">${esc(m.animal_code||'—')} · ${esc(m.animal_type||'')} · ${esc(m.material_type==='MEAT'?'Мах':'Дайвар')} · ${fmtKg(m.current_available)} кг</option>`).join('')||'<option value="">Дэлгүүрт материал алга</option>'}</select><label>Бүтээгдэхүүний төрөл</label><select name="product_type" id="productType" required><option value="">-- сонгох --</option><option>Гулууз (бүтэн)</option><option>Өрөөл (хаа+гуя)</option><option>Жижиглэн</option><option>Хорхог багц</option></select><label>Нийт жин (кг)</label><input name="weight" id="packWeight" type="number" min="0.1" step="0.001" required><div id="khQtyWrap" class="hidden"><div class="row2"><div><label>Багцын жин (кг)</label><select id="khSize"><option value="1.5">1.5 кг</option><option value="2.3">2.3 кг</option><option value="3.3">3.3 кг</option><option value="custom">Бусад (гараар)</option></select></div><div><label>Баглааны тоо</label><input id="khQty" type="number" min="1" step="1" value="1"></div></div><div id="khCustomWrap" class="hidden"><label>Багцын жин гараар (кг)</label><input id="khCustom" type="number" min="0.001" step="0.001"></div></div><div class="calc-box"><span>Нийт бүтээгдэхүүний жин:</span><b id="packTotal">0 кг</b></div><label>Савлагааны зардал (₮)</label><input name="cost" type="number" min="0" step="1" value="0"><label>Огноо</label><input name="date" type="date" value="${today()}" required><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('packForm');const type=$('productType');
 const isKh=()=>type.value==='Хорхог багц';
 const unitSize=()=>{const v=$('khSize').value;return v==='custom'?num($('khCustom').value):num(v)};
 function calc(){
   const kh=isKh();
   $('khQtyWrap').classList.toggle('hidden',!kh);
   $('khCustomWrap').classList.toggle('hidden',!(kh&&$('khSize').value==='custom'));
   $('packWeight').readOnly=kh;
   // For Хорхог the total is derived (unit × count) and written straight into
   // the submitted field -- the previous version left it empty and readOnly,
   // which is why saving failed with "Материал/жин буруу".
   const w=kh?unitSize()*num($('khQty').value):num($('packWeight').value);
   if(kh)$('packWeight').value=w?w.toFixed(3):'';
   $('packTotal').textContent=fmtKg(w)+' кг';
 }
 type.onchange=calc;$('khSize').onchange=calc;$('khCustom').oninput=calc;$('khQty').oninput=calc;$('packWeight').oninput=calc;calc();f.onsubmit=async e=>{e.preventDefault();await createProduct(new FormData(f))};
 if(!isOnline())$('view').insertAdjacentHTML('afterbegin','<div class="warn">⚠️ Баглаа боодол нь online-only хэсэг.</div>');
}
async function createProduct(fd){
 const mid=String(fd.get('material_id')),w=num(fd.get('weight'));const m=cache.materials.find(x=>x.id===mid);if(!m||w<=0)return toast('Материал/жин буруу');if(w>num(m.current_available)+.0001)return toast('Үлдэгдлээс их байна');
 // Хорхог is sold as whole packages, so qty is the package COUNT and the
 // unit weight is fixed. Everything else is sold by weight, so qty is the
 // kilogram amount itself -- that keeps one product row honest either way.
 const isKhorkhog=String(fd.get('product_type'))==='Хорхог багц';
 const unitW=isKhorkhog?($('khSize').value==='custom'?num($('khCustom').value):num($('khSize').value)):null;
 if(isKhorkhog&&(!unitW||num($('khQty').value)<1))return toast('Багцын жин ба тоог зөв бөглөнө үү');
 try{const productId=uuid();const srcAnimal=cache.animals.find(a=>a.id===m.animal_id);const productCode=`${srcAnimal?.animal_code||m.animal_id.slice(0,8)}-P${productId.slice(0,6).toUpperCase()}`;await rpc('create_product',{p_product_id:productId,p_product_code:productCode,p_material_id:mid,p_weight_kg:w,p_product_type:String(fd.get('product_type')),p_packaging_date:String(fd.get('date')),p_packaging_cost:num(fd.get('cost')),p_note:fd.get('note')||null,p_qty:isKhorkhog?num($('khQty').value):w,p_unit:isKhorkhog?'ширхэг':'кг',p_unit_weight_kg:isKhorkhog?unitW:null,p_user_id:session.user.id});await pullData();toast('Бүтээгдэхүүн хадгалагдлаа');renderPackaging()}catch(err){toast('Алдаа: '+errMn(err))}
}

function renderSales(){
 // Only products with stock left can be sold. Sold-out items remain visible
 // in Агуулах (with a Дууссан badge and their QR) but not here.
 const ps=cache.products.filter(p=>num(p.current_available)>0);
 $('view').innerHTML=formCard(`<form id="saleForm"><label>Бүтээгдэхүүн</label><select name="product_id" id="saleProduct" required>${ps.map(p=>`<option value="${p.id}">${esc(p.product_code)} · ${esc(p.animal_type||'')} · ${esc(p.product_type)} · ${p.unit==='ширхэг'?fmt(p.current_available,0)+' ширхэг ('+fmtKg(p.unit_weight_kg||0)+' кг/ш)':fmtKg(p.current_available)+' кг'}</option>`).join('')||'<option value="">Зарах бүтээгдэхүүн алга</option>'}</select><div class="helper" id="saleRemain"></div><label id="saleQtyLabel">Тоо хэмжээ</label><input name="qty" id="saleQty" type="number" min="0.001" step="0.001" required><div class="helper" id="saleWeightHint"></div><label>Нэгжийн үнэ (₮)</label><input name="price" type="number" min="0" step="1" required><div class="calc-box"><span>Нийт дүн:</span><b id="saleTotal">0 ₮</b></div><label>Огноо</label><input name="date" type="date" value="${today()}" required><label>Хэрэглэгч (заавал биш)</label><input name="customer"><label>Утас (заавал биш)</label><input name="customer_phone"><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('saleForm');
 function c(){
   const p=cache.products.find(x=>x.id===f.product_id.value);
   const pack=p&&p.unit==='ширхэг';
   // Packaged goods sell as whole units -- a 1.5 kg Хорхог cannot be sold as
   // 1 kg. Everything else is weighed, so grams are allowed.
   $('saleQtyLabel').textContent=pack?'Хэдэн ширхэг':'Нийт жин (кг)';
   $('saleQty').step=pack?'1':'0.001';
   $('saleQty').min=pack?'1':'0.001';
   if(pack&&f.qty.value)f.qty.value=String(Math.max(1,Math.floor(num(f.qty.value))));
   $('saleRemain').textContent=p?(pack?`Үлдэгдэл: ${fmt(p.current_available,0)} ширхэг`:`Үлдэгдэл: ${fmtKg(p.current_available)} кг`):'';
   $('saleQty').max=p?.current_available||'';
   $('saleWeightHint').textContent=(pack&&p.unit_weight_kg&&f.qty.value)?`Нийт жин: ${fmtKg(num(f.qty.value)*num(p.unit_weight_kg))} кг`:'';
   $('saleTotal').textContent=fmt(num(f.qty.value)*num(f.price.value),0)+' ₮';
 }
 f.oninput=c;f.onchange=c;c();f.onsubmit=async e=>{e.preventDefault();const p=cache.products.find(x=>x.id===f.product_id.value);if(!p)return;const q=num(f.qty.value);if(q>num(p.current_available)+.0001)return toast('Үлдэгдлээс их байна');try{await rpc('create_sale',{p_sale_id:uuid(),p_product_id:p.id,p_qty:q,p_unit_price:num(f.price.value),p_sale_date:String(f.date.value),p_customer:String(f.customer.value||''),p_customer_phone:String(f.customer_phone.value||''),p_user_id:session.user.id});await pullData();toast('Борлуулалт хадгалагдлаа');renderSales()}catch(err){toast('Алдаа: '+errMn(err))}};c();
}

// Агуулах is now 4 dedicated pages behind tab buttons instead of one long
// scroll. Each tab is its own read model over data that already exists in
// `cache` -- no schema or sync changes, purely presentation.
const INV_TABS=[
 {id:'materials',label:'Хүлээн авсан мах'},
 {id:'products',label:'Бүтээгдэхүүн'},
 {id:'sales',label:'Борлуулсан'}
];
let INV_TAB='materials';
function renderInventory(){
 const tabs=INV_TABS.map(t=>`<button class="btn-secondary" style="flex:1;min-width:0;padding:9px 6px;font-size:12.5px;${INV_TAB===t.id?'background:var(--primary);color:#fff;border-color:var(--primary)':''}" onclick="invTab('${t.id}')">${t.label}</button>`).join('');
 $('view').innerHTML=`<div class="actions" style="margin-bottom:14px;gap:6px;flex-wrap:nowrap">${tabs}</div><div id="invBody"></div>`;
 renderInvBody();
}
function invTab(id){INV_TAB=id;renderInventory()}
function renderInvBody(){
 const body=$('invBody');if(!body)return;
 if(INV_TAB==='materials')return renderInvMaterials(body);
 if(INV_TAB==='products')return renderInvProducts(body);
 if(INV_TAB==='sales')return renderInvSales(body);
}
function renderInvMaterials(body){
 // Only lots that actually completed Хүлээн авалт → Дэлгүүрт хүлээн авах
 // (location_type SHOP) show up here -- material still sitting at a soum,
 // or already fully packaged into products, is intentionally excluded.
 const mats=cache.materials.filter(m=>m.location_type==='SHOP'&&num(m.current_available)>0);
 body.innerHTML=formCard(mats.length?`<table><tr><th>Амьтан</th><th>Мал</th><th>Төрөл</th><th>Үлдэгдэл</th></tr>${mats.map(m=>`<tr><td>${esc(m.animal_code||'—')}</td><td>${esc(m.animal_type||'')}</td><td>${esc(m.material_type==='MEAT'?'Мах':'Дайвар')}</td><td><b>${fmtKg(m.current_available)} кг</b></td></tr>`).join('')}</table>`:'<div class="empty">Дэлгүүрт хүлээн авсан материал алга</div>');
}
function renderInvProducts(body){
 const ps=cache.products.slice().sort((a,b)=>(num(b.current_available)>0)-(num(a.current_available)>0));
 body.innerHTML=formCard(ps.length?`<table><tr><th>Код</th><th>Мал</th><th>Төрөл</th><th>Амьтан</th><th>Үлдэгдэл</th><th></th></tr>${ps.map(p=>`<tr><td>${esc(p.product_code)}</td><td>${esc(p.animal_type||'')}</td><td>${esc(p.product_type)}</td><td>${esc(p.animal_code||'—')}</td><td><b>${num(p.current_available)>0?fmt(p.current_available)+' '+esc(p.unit):'<span class="badge bad">Дууссан</span>'}</b></td><td><button class="btn-ghost" onclick="showQR('${esc(p.product_code)}')">QR</button>${profile?.role==='superadmin'?`<button class="btn-ghost" style="margin-left:6px" onclick="deleteRecord('products','${p.id}','${esc(p.product_code)}')">Устгах</button>`:''}</td></tr>`).join('')}</table>`:'<div class="empty">Бүтээгдэхүүний үлдэгдэл алга</div>');
}
function renderInvSales(body){
 const items=cache.sales.slice().sort((a,b)=>(b.sale_date||'').localeCompare(a.sale_date||'')||new Date(b.created_at||0)-new Date(a.created_at||0));
 body.innerHTML=formCard(items.length?`<table><tr><th>Огноо</th><th>Бүтээгдэхүүн</th><th>Тоо хэмжээ</th><th>Дүн</th><th>Харилцагч</th><th></th></tr>${items.map(s=>{
   const p=cache.products.find(x=>x.id===s.product_id);
   const qtyLabel=p?.unit==='ширхэг'?`${fmt(s.qty,0)} ширхэг`:`${fmtKg(s.qty)} кг`;
   return `<tr><td>${esc(s.sale_date||'')}</td><td>${esc(p?.product_code||'—')}<div class="helper">${esc(p?.product_type||'')}</div></td><td>${qtyLabel}</td><td><b>${fmt(s.total_amount,0)}₮</b></td><td>${esc(s.customer||'—')}</td><td>${p?`<button class="btn-ghost" onclick="showQR('${esc(p.product_code)}')">QR</button>`:''}</td></tr>`;
 }).join('')}</table>`:'<div class="empty">Борлуулалт алга</div>');
}
// ---- Хянах самбар: 4 tabs sharing one date-range filter, charts via
// Chart.js (loaded from CDN in index.html, cached for offline in sw.js).
// Design rule kept consistent throughout: every stat/breakdown filters its
// own collection by ITS OWN business date (purchase_date for animals,
// sale_date for sales, etc) -- never a date inherited from a related table.
// Trend (line) charts always show the last 6 months regardless of the
// filter, since collapsing a trend to one month would just be one point.
const DASH_COLORS={primary:'#005A4C',primaryDark:'#00382F',accent:'#BB682B',good:'#2F7A5F',bad:'#B4463B',grid:'#DEE6E3',text:'#57676A'};
const DASH_TABS=[{id:'overall',label:'Ерөнхий'},{id:'purchase',label:'Худалдан авалт'},{id:'warehouse',label:'Агуулах'},{id:'sales',label:'Борлуулалт'}];
let DASH_TAB='overall',DASH_RANGE='all',DASH_FROM=null,DASH_TO=null;
let DASH_CHARTS={},DASH_CHART_INIT=false;
function dashInRange(d){
 if(!d)return false;
 if(DASH_RANGE==='month')return d.slice(0,7)===new Date().toISOString().slice(0,7);
 if(DASH_RANGE==='custom')return (!DASH_FROM||d>=DASH_FROM)&&(!DASH_TO||d<=DASH_TO);
 return true;
}
function dashLastMonths(n){
 const arr=[];const d=new Date();d.setDate(1);
 for(let i=0;i<n;i++){arr.unshift(d.toISOString().slice(0,7));d.setMonth(d.getMonth()-1)}
 return arr;
}
function dashMonthLabel(m){const[y,mo]=m.split('-');return `${mo}/${y.slice(2)}`}
function dashChart(id,config){
 if(DASH_CHARTS[id]){DASH_CHARTS[id].destroy();delete DASH_CHARTS[id]}
 const el=document.getElementById(id);
 if(!el||!window.Chart)return;
 if(!DASH_CHART_INIT){Chart.defaults.font.family="'Segoe UI','Noto Sans',Roboto,Arial,sans-serif";DASH_CHART_INIT=true}
 config.options=Object.assign({responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:DASH_COLORS.text}}},scales:config.type!=='pie'?{x:{grid:{color:DASH_COLORS.grid},ticks:{color:DASH_COLORS.text}},y:{grid:{color:DASH_COLORS.grid},ticks:{color:DASH_COLORS.text},beginAtZero:true}}:{}},config.options||{});
 DASH_CHARTS[id]=new Chart(el,config);
}
function canvasCard(title,id,h){return `<div class="card"><b>${esc(title)}</b><div style="height:${h||220}px;margin-top:10px"><canvas id="${id}"></canvas></div></div>`}
function renderDashboard(){
 const tabs=DASH_TABS.map(t=>`<button class="btn-secondary" style="flex:1;min-width:0;padding:9px 4px;font-size:12px;${DASH_TAB===t.id?'background:var(--primary);color:#fff;border-color:var(--primary)':''}" onclick="dashTab('${t.id}')">${t.label}</button>`).join('');
 const customInputs=DASH_RANGE==='custom'?`<input type="date" value="${DASH_FROM||''}" onchange="dashCustom(this.value,null)" style="max-width:145px"><input type="date" value="${DASH_TO||''}" onchange="dashCustom(null,this.value)" style="max-width:145px">`:'';
 $('view').innerHTML=`<div class="actions" style="margin-bottom:10px;gap:6px;flex-wrap:nowrap">${tabs}</div>
  <div class="split" style="margin-bottom:14px;gap:8px;flex-wrap:wrap">
   <select onchange="dashRange(this.value)" style="max-width:150px">
    <option value="all" ${DASH_RANGE==='all'?'selected':''}>Бүх хугацаа</option>
    <option value="month" ${DASH_RANGE==='month'?'selected':''}>Энэ сар</option>
    <option value="custom" ${DASH_RANGE==='custom'?'selected':''}>Огноо сонгох</option>
   </select>${customInputs}
  </div>
  <div id="dashBody"></div>`;
 renderDashBody();
}
function dashTab(id){DASH_TAB=id;renderDashboard()}
function dashRange(v){DASH_RANGE=v;renderDashboard()}
function dashCustom(f,t){if(f!==null)DASH_FROM=f;if(t!==null)DASH_TO=t;renderDashBody()}
function renderDashBody(){
 const el=$('dashBody');if(!el)return;
 if(DASH_TAB==='overall')return renderDashOverall(el);
 if(DASH_TAB==='purchase')return renderDashPurchase(el);
 if(DASH_TAB==='warehouse')return renderDashWarehouse(el);
 if(DASH_TAB==='sales')return renderDashSales(el);
}

function renderDashOverall(el){
 const animals=cache.animals.filter(a=>dashInRange(a.purchase_date));
 const animalIds=new Set(animals.map(a=>a.id));
 const procIds=new Set(cache.processing_events.filter(p=>dashInRange(p.processing_date)).map(p=>p.id));
 const materials=cache.materials.filter(m=>procIds.has(m.source_processing_id));
 const meat=materials.filter(m=>m.material_type==='MEAT').reduce((s,m)=>s+num(m.original_quantity_kg),0);
 const byp=materials.filter(m=>m.material_type==='BYPRODUCT').reduce((s,m)=>s+num(m.original_quantity_kg),0);
 const sales=cache.sales.filter(s=>dashInRange(s.sale_date));
 const revenue=sales.reduce((s,x)=>s+num(x.total_amount),0);
 const costs=animals.reduce((s,a)=>s+num(a.total_cost),0)
   +cache.processing_events.filter(p=>dashInRange(p.processing_date)).reduce((s,p)=>s+num(p.processing_cost),0)
   +cache.transports.filter(t=>dashInRange(t.transport_date)).reduce((s,t)=>s+num(t.cost),0)
   +cache.products.filter(p=>dashInRange(p.packaging_date)).reduce((s,p)=>s+num(p.packaging_cost),0);
 el.innerHTML=`<div class="stat-grid"><div class="stat"><div class="n">${fmt(animals.length,0)}</div><div class="l">Худалдан авсан амьтан</div></div><div class="stat"><div class="n">${fmt(meat)}</div><div class="l">Махны гарц, кг</div></div><div class="stat"><div class="n">${fmt(byp)}</div><div class="l">Дайвар, кг</div></div><div class="stat"><div class="n">${fmt(revenue,0)}₮</div><div class="l">Борлуулалт</div></div><div class="stat"><div class="n">${fmt(costs,0)}₮</div><div class="l">Бүртгэгдсэн зардал</div></div><div class="stat"><div class="n">${fmt(revenue-costs,0)}₮</div><div class="l">Энгийн зөрүү</div></div></div>
  ${canvasCard('Орлого ба зардал, сүүлийн 6 сар','dashOverallTrend')}
  <div class="card"><b>Мэдээллийн төлөв</b><div class="helper">Тооцоолол нь одоогийн бүртгэл дээр тулгуурлана. Санхүүгийн бүрэн нягтлан бодох бүртгэл биш.</div></div>`;
 const months=dashLastMonths(6);
 const rev=months.map(m=>cache.sales.filter(s=>(s.sale_date||'').slice(0,7)===m).reduce((s,x)=>s+num(x.total_amount),0));
 const cost=months.map(m=>
   cache.animals.filter(a=>(a.purchase_date||'').slice(0,7)===m).reduce((s,a)=>s+num(a.total_cost),0)
   +cache.processing_events.filter(p=>(p.processing_date||'').slice(0,7)===m).reduce((s,p)=>s+num(p.processing_cost),0)
   +cache.transports.filter(t=>(t.transport_date||'').slice(0,7)===m).reduce((s,t)=>s+num(t.cost),0)
   +cache.products.filter(p=>(p.packaging_date||'').slice(0,7)===m).reduce((s,p)=>s+num(p.packaging_cost),0));
 dashChart('dashOverallTrend',{type:'line',data:{labels:months.map(dashMonthLabel),datasets:[
   {label:'Орлого',data:rev,borderColor:DASH_COLORS.accent,backgroundColor:DASH_COLORS.accent,tension:.3},
   {label:'Зардал',data:cost,borderColor:DASH_COLORS.primary,backgroundColor:DASH_COLORS.primary,tension:.3}
 ]}});
}

function renderDashPurchase(el){
 const animals=cache.animals.filter(a=>dashInRange(a.purchase_date));
 const byType={};animals.forEach(a=>{byType[a.animal_type]=(byType[a.animal_type]||0)+1});
 const types=Object.keys(byType);
 const procIds=new Set(cache.processing_events.filter(p=>dashInRange(p.processing_date)).map(p=>p.id));
 const materials=cache.materials.filter(m=>procIds.has(m.source_processing_id));
 const yieldByType={};
 materials.forEach(m=>{
   const a=cache.animals.find(x=>x.id===m.animal_id);if(!a)return;
   yieldByType[a.animal_type]=yieldByType[a.animal_type]||{meat:0,byp:0};
   yieldByType[a.animal_type][m.material_type==='MEAT'?'meat':'byp']+=num(m.original_quantity_kg);
 });
 const yTypes=Object.keys(yieldByType);
 el.innerHTML=`<div class="stat-grid"><div class="stat"><div class="n">${fmt(animals.length,0)}</div><div class="l">Худалдан авсан мал</div></div><div class="stat"><div class="n">${fmt(animals.reduce((s,a)=>s+num(a.total_cost),0),0)}₮</div><div class="l">Худалдан авалтын зардал</div></div></div>
  ${canvasCard('Малын төрлөөр тоо','dashPurchaseType')}
  ${canvasCard('Мах ба дайврын гарц, төрлөөр (кг)','dashPurchaseYield')}`;
 dashChart('dashPurchaseType',{type:'bar',data:{labels:types,datasets:[{label:'Тоо',data:types.map(t=>byType[t]),backgroundColor:DASH_COLORS.primary}]}});
 dashChart('dashPurchaseYield',{type:'bar',data:{labels:yTypes,datasets:[
   {label:'Мах',data:yTypes.map(t=>yieldByType[t].meat),backgroundColor:DASH_COLORS.primary},
   {label:'Дайвар',data:yTypes.map(t=>yieldByType[t].byp),backgroundColor:DASH_COLORS.accent}
 ]}});
}

function renderDashWarehouse(el){
 // Weight loss = what left the soum (quantity_sent_kg) vs what actually
 // arrived at the shop (received_weight_kg), matched via transport_item_id.
 const receivings=cache.receivings.filter(r=>dashInRange(r.received_date));
 let sentSum=0,recvSum=0;
 receivings.forEach(r=>{
   const ti=cache.transport_items.find(t=>t.id===r.transport_item_id);
   if(!ti)return;
   sentSum+=num(ti.quantity_sent_kg);recvSum+=num(r.received_weight_kg);
 });
 const lossPct=sentSum>0?((sentSum-recvSum)/sentSum*100):0;
 const months=dashLastMonths(6);
 const sentByMonth=months.map(m=>{
   let s=0;
   cache.receivings.filter(r=>(r.received_date||'').slice(0,7)===m).forEach(r=>{
     const ti=cache.transport_items.find(t=>t.id===r.transport_item_id);if(ti)s+=num(ti.quantity_sent_kg);
   });
   return s;
 });
 const recvByMonth=months.map(m=>cache.receivings.filter(r=>(r.received_date||'').slice(0,7)===m).reduce((s,r)=>s+num(r.received_weight_kg),0));
 const stockByType={};
 cache.products.forEach(p=>{stockByType[p.product_type]=(stockByType[p.product_type]||0)+num(p.weight_kg)});
 const stypes=Object.keys(stockByType);
 el.innerHTML=`<div class="stat-grid"><div class="stat"><div class="n">${fmtKg(sentSum)}</div><div class="l">Илгээсэн жин, кг</div></div><div class="stat"><div class="n">${fmtKg(recvSum)}</div><div class="l">Хүлээн авсан жин, кг</div></div><div class="stat"><div class="n" style="color:${lossPct>3?DASH_COLORS.bad:DASH_COLORS.good}">${fmt(lossPct)}%</div><div class="l">Дундаж тээврийн алдагдал</div></div></div>
  ${canvasCard('Сар бүрийн илгээсэн ба хүлээн авсан жин (кг)','dashWarehouseTransport')}
  ${canvasCard('Одоогийн бүтээгдэхүүний нөөц, төрлөөр (кг)','dashWarehouseStock')}`;
 dashChart('dashWarehouseTransport',{type:'bar',data:{labels:months.map(dashMonthLabel),datasets:[
   {label:'Илгээсэн',data:sentByMonth,backgroundColor:DASH_COLORS.primary},
   {label:'Хүлээн авсан',data:recvByMonth,backgroundColor:DASH_COLORS.accent}
 ]}});
 dashChart('dashWarehouseStock',{type:'bar',data:{labels:stypes,datasets:[{label:'Нөөц, кг',data:stypes.map(t=>stockByType[t]),backgroundColor:DASH_COLORS.primary}]}});
}

function renderDashSales(el){
 const sales=cache.sales.filter(s=>dashInRange(s.sale_date));
 const revenue=sales.reduce((s,x)=>s+num(x.total_amount),0);
 const byType={};
 sales.forEach(s=>{
   const p=cache.products.find(x=>x.id===s.product_id);if(!p)return;
   byType[p.product_type]=(byType[p.product_type]||0)+num(s.total_amount);
 });
 const types=Object.keys(byType);
 const months=dashLastMonths(6);
 const revByMonth=months.map(m=>cache.sales.filter(s=>(s.sale_date||'').slice(0,7)===m).reduce((s,x)=>s+num(x.total_amount),0));
 el.innerHTML=`<div class="stat-grid"><div class="stat"><div class="n">${fmt(revenue,0)}₮</div><div class="l">Нийт орлого</div></div><div class="stat"><div class="n">${fmt(sales.length,0)}</div><div class="l">Худалдааны тоо</div></div></div>
  ${canvasCard('Орлогын тренд, сүүлийн 6 сар','dashSalesTrend')}
  ${canvasCard('Бүтээгдэхүүний төрлөөр орлого','dashSalesType')}`;
 dashChart('dashSalesTrend',{type:'line',data:{labels:months.map(dashMonthLabel),datasets:[{label:'Орлого',data:revByMonth,borderColor:DASH_COLORS.accent,backgroundColor:DASH_COLORS.accent,tension:.3}]}});
 dashChart('dashSalesType',{type:'bar',data:{labels:types,datasets:[{label:'Орлого',data:types.map(t=>byType[t]),backgroundColor:DASH_COLORS.primary}]}});
}
window.dashTab=dashTab;window.dashRange=dashRange;window.dashCustom=dashCustom;

// ---- Малчид: list (all admins), add (all admins), edit (superadmin),
// contribution stats derived from the same herder->animal->material->
// product->sale chain the finance report will use, all-time by default
// with an optional per-month view. ----
let HERD_FILTER='';
let HERD_DETAIL_ID=null, HERD_DETAIL_MONTH=null;
function herderAnimals(hid){return cache.animals.filter(a=>a.herder_id===hid)}
// monthKey null = all-time. Otherwise "YYYY-MM", scoped by the animal's
// purchase date -- downstream materials/products/sales follow whichever
// animals were purchased that month, even if they were processed or sold
// later, since that's the herder's actual contribution for that month.
function herderContribution(hid,monthKey){
 let animals=herderAnimals(hid);
 if(monthKey)animals=animals.filter(a=>(a.purchase_date||'').slice(0,7)===monthKey);
 const animalIds=new Set(animals.map(a=>a.id));
 const liveWeight=animals.reduce((s,a)=>s+num(a.live_weight_kg),0);
 const purchaseCost=animals.reduce((s,a)=>s+num(a.total_cost),0);
 const materials=cache.materials.filter(m=>animalIds.has(m.animal_id));
 const meatKg=materials.filter(m=>m.material_type==='MEAT').reduce((s,m)=>s+num(m.original_quantity_kg),0);
 const products=cache.products.filter(p=>animalIds.has(p.animal_id));
 const productIds=new Set(products.map(p=>p.id));
 const sales=cache.sales.filter(s=>productIds.has(s.product_id));
 const revenue=sales.reduce((s,x)=>s+num(x.total_amount),0);
 const soldQty=sales.reduce((s,x)=>s+num(x.qty),0);
 return {animalsCount:animals.length,liveWeight,purchaseCost,meatKg,productsCount:products.length,soldQty,revenue};
}
function herderMonths(hid){
 return [...new Set(herderAnimals(hid).map(a=>(a.purchase_date||'').slice(0,7)).filter(Boolean))].sort().reverse();
}
function renderHerders(){
 $('view').innerHTML=formCard(`<div class="split" style="margin-bottom:12px;gap:8px"><input id="herderSearch" placeholder="Нэр, сум хайх..." value="${esc(HERD_FILTER)}"><button class="btn-secondary" onclick="herderAddOpen()" style="white-space:nowrap">+ Нэмэх</button></div><div class="split" style="margin-bottom:12px"><span class="helper">Жагсаалтыг Excel-д татах</span><button class="btn-secondary" onclick="exportHerdersXLSX()">⬇ Excel</button></div><div id="herderList"></div>`);
 $('herderSearch').oninput=e=>{HERD_FILTER=e.target.value;renderHerderList()};
 renderHerderList();
}
function renderHerderList(){
 const el=$('herderList');if(!el)return;
 const q=HERD_FILTER.trim().toLowerCase();
 const items=cache.herders.filter(h=>!q||h.full_name.toLowerCase().includes(q)||(h.soum||'').toLowerCase().includes(q)||(h.aimag||'').toLowerCase().includes(q)).sort((a,b)=>a.full_name.localeCompare(b.full_name,'mn'));
 if(!items.length){el.innerHTML='<div class="empty"><div class="big">🧑\u200d🌾</div>Малчин олдсонгүй</div>';return}
 el.innerHTML=items.map(h=>{
   const c=herderContribution(h.id,null);
   return `<div class="list-item" style="cursor:pointer" onclick="herderOpen('${h.id}')"><div class="top-row"><b>${esc(h.full_name)}</b>${h.certified?'<span class="badge good">MNS 6891</span>':''}</div><div class="details">${esc(h.soum)} · ${fmt(c.animalsCount,0)} мал · ${fmt(c.revenue,0)}₮ борлуулалт</div></div>`;
 }).join('');
}
function herderDetailMonth(m){HERD_DETAIL_MONTH=m||null;renderHerderDetail()}
function herderOpen(id){HERD_DETAIL_ID=id;HERD_DETAIL_MONTH=null;renderHerderDetail()}
function renderHerderDetail(){
 const h=cache.herders.find(x=>x.id===HERD_DETAIL_ID);if(!h)return;
 const c=herderContribution(h.id,HERD_DETAIL_MONTH);
 const months=herderMonths(h.id);
 const monthLabel=m=>{const[y,mo]=m.split('-');return `${y}.${mo}`};
 const canEdit=profile?.role==='superadmin';
 $('modal-root').innerHTML=`<div class="modal-back"><div class="modal">
   <div class="modal-head"><b>${esc(h.full_name)}</b><button class="x" onclick="histClose()">×</button></div>
   <div class="helper" style="margin:4px 0 12px">${h.aimag?esc(h.aimag)+' · ':''}${esc(h.soum)}${h.herd_size?' · Сүрэг: '+fmt(h.herd_size,0):''}${h.last_vaccination_date?' · Вакцин: '+esc(h.last_vaccination_date):''}${h.certified?' · <span class="badge good">MNS 6891</span>':''}</div>
   <label style="margin-top:0">Хугацаа</label><select onchange="herderDetailMonth(this.value)"><option value="">Бүх хугацаа</option>${months.map(m=>`<option value="${m}" ${HERD_DETAIL_MONTH===m?'selected':''}>${monthLabel(m)}</option>`).join('')}</select>
   <div class="stat-grid" style="margin-top:12px">
     <div class="stat"><div class="n">${fmt(c.animalsCount,0)}</div><div class="l">Тоолсон мал</div></div>
     <div class="stat"><div class="n">${fmtKg(c.liveWeight)}</div><div class="l">Амьд жин, кг</div></div>
     <div class="stat"><div class="n">${fmt(c.purchaseCost,0)}₮</div><div class="l">Худалдан авалтын үнэ</div></div>
     <div class="stat"><div class="n">${fmtKg(c.meatKg)}</div><div class="l">Гарсан мах, кг</div></div>
     <div class="stat"><div class="n">${fmt(c.productsCount,0)}</div><div class="l">Баглагдсан бүтээгдэхүүн</div></div>
     <div class="stat"><div class="n">${fmt(c.revenue,0)}₮</div><div class="l">Борлуулалтын орлого</div></div>
   </div>
   ${canEdit?`<button class="btn-secondary" style="margin-top:14px" onclick="herderEditOpen('${h.id}')">Засварлах</button>`:''}
 </div></div>`;
}
function herderAddOpen(){
 $('modal-root').innerHTML=`<div class="modal-back"><div class="modal">
   <div class="modal-head"><b>Малчин нэмэх</b><button class="x" onclick="histClose()">×</button></div>
   <form id="herderAddForm">
   <label>Аймаг</label><input name="aimag" value="Баянхонгор" required>
   <label>Сум</label><select name="soum" required><option value="">-- сум сонгох --</option>${SOUMS.map(s=>`<option>${s.name}</option>`).join('')}</select>
   <div class="row2"><div><label>Малчны овог</label><input name="surname" required></div><div><label>Малчны нэр</label><input name="given" required></div></div>
   <label>Хариуцлагатай Нүүдэлчин стандартаар баталгаажсан эсэх (MNS 6891)</label>
   <select name="certified"><option value="false">Үгүй</option><option value="true">Тийм</option></select>
   <label>Мал сүргийн вакцинд хамрагдсан огноо</label><input name="last_vaccination_date" type="date" required>
   <label>Сүргийн хэмжээ (заавал биш)</label><input name="herd_size" type="number" min="0" step="1">
   <button class="btn-primary">Хадгалах</button></form>
 </div></div>`;
 $('herderAddForm').onsubmit=async e=>{
   e.preventDefault();
   const fd=new FormData(e.target);
   const surname=String(fd.get('surname')||'').trim(),given=String(fd.get('given')||'').trim();
   const full_name=[surname,given].filter(Boolean).join(' ');
   const soum=String(fd.get('soum')||''),aimag=String(fd.get('aimag')||'').trim();
   const vaccinationDate=String(fd.get('last_vaccination_date')||'');
   if(!full_name||!soum||!aimag||!vaccinationDate)return toast('Нэр, аймаг, сум, вакцины огноо шаардлагатай');
   const row={id:uuid(),full_name,surname,given_name:given,aimag,soum,location_detail:null,herd_size:fd.get('herd_size')?num(fd.get('herd_size')):null,last_vaccination_date:vaccinationDate,certified:String(fd.get('certified'))==='true',created_by:session.user.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
   try{
     const saved=await upsertDirect('herders',row);
     cache.herders.push(saved);
     histClose();toast('Малчин нэмэгдлээ');renderHerderList();
   }catch(err){toast('Алдаа: '+errMn(err))}
 };
}
function herderEditOpen(id){
 const h=cache.herders.find(x=>x.id===id);if(!h)return;
 // Older herders synced before this migration may not have surname/given_name
 // stored separately -- fall back to splitting full_name on the first space
 // so the form still has something sensible to edit.
 const fallbackSurname=h.surname??((h.full_name||'').split(' ')[0]||'');
 const fallbackGiven=h.given_name??((h.full_name||'').split(' ').slice(1).join(' ')||'');
 $('modal-root').innerHTML=`<div class="modal-back"><div class="modal">
   <div class="modal-head"><b>Малчин засварлах</b><button class="x" onclick="histClose()">×</button></div>
   <form id="herderEditForm">
   <label>Аймаг</label><input name="aimag" value="${esc(h.aimag||'Баянхонгор')}" required>
   <label>Сум</label><select name="soum" required>${SOUMS.map(s=>`<option ${h.soum===s.name?'selected':''}>${s.name}</option>`).join('')}</select>
   <div class="row2"><div><label>Малчны овог</label><input name="surname" value="${esc(fallbackSurname)}" required></div><div><label>Малчны нэр</label><input name="given" value="${esc(fallbackGiven)}" required></div></div>
   <label>Хариуцлагатай Нүүдэлчин стандартаар баталгаажсан эсэх (MNS 6891)</label>
   <select name="certified"><option value="false" ${!h.certified?'selected':''}>Үгүй</option><option value="true" ${h.certified?'selected':''}>Тийм</option></select>
   <label>Мал сүргийн вакцинд хамрагдсан огноо</label><input name="last_vaccination_date" type="date" value="${h.last_vaccination_date||''}" required>
   <label>Сүргийн хэмжээ (заавал биш)</label><input name="herd_size" type="number" min="0" step="1" value="${h.herd_size??''}">
   <button class="btn-primary">Хадгалах</button></form>
 </div></div>`;
 $('herderEditForm').onsubmit=async e=>{
   e.preventDefault();
   const fd=new FormData(e.target);
   const surname=String(fd.get('surname')||'').trim(),given=String(fd.get('given')||'').trim();
   const full_name=[surname,given].filter(Boolean).join(' ');
   const soum=String(fd.get('soum')||''),aimag=String(fd.get('aimag')||'').trim();
   const vaccinationDate=String(fd.get('last_vaccination_date')||'');
   if(!full_name||!soum||!aimag||!vaccinationDate)return toast('Нэр, аймаг, сум, вакцины огноо шаардлагатай');
   const row={id:h.id,full_name,surname,given_name:given,aimag,soum,location_detail:h.location_detail??null,herd_size:fd.get('herd_size')?num(fd.get('herd_size')):null,last_vaccination_date:vaccinationDate,certified:String(fd.get('certified'))==='true',created_by:h.created_by,created_at:h.created_at,updated_at:new Date().toISOString()};
   try{
     const saved=await upsertDirect('herders',row);
     cache.herders=cache.herders.filter(x=>x.id!==h.id).concat(saved);
     histClose();toast('Хадгалагдлаа');renderHerderDetail();
   }catch(err){toast('Алдаа: '+errMn(err))}
 };
}
function exportHerdersXLSX(){
 const rows=cache.herders.slice().sort((a,b)=>a.full_name.localeCompare(b.full_name,'mn')).map(h=>{
   const c=herderContribution(h.id,null);
   return {'Нэр':h.full_name,'Сум':h.soum,'Мал (тоо)':c.animalsCount,'Амьд жин (кг)':fmtKg(c.liveWeight),'Худалдан авалтын үнэ':c.purchaseCost,'Гарсан мах (кг)':fmtKg(c.meatKg),'Баглагдсан бүтээгдэхүүн':c.productsCount,'Зарагдсан тоо хэмжээ':c.soldQty,'Борлуулалтын орлого':c.revenue};
 });
 downloadXLSX(`malchid-${today()}.xlsx`,rows);
}
window.herderAddOpen=herderAddOpen;window.herderOpen=herderOpen;window.herderEditOpen=herderEditOpen;window.herderDetailMonth=herderDetailMonth;window.exportHerdersXLSX=exportHerdersXLSX;

const HIST_ENTITY={sales:'Борлуулалт',animals:'Худалдан авалт',herders:'Малчин',processing_events:'Мал төхөөрөх ажиллагаа',transports:'Тээвэрлэлт',transport_items:'Тээвэрлэлт',receivings:'Хүлээн авалт',products:'Баглаа боодол',material_lots:'Материал',profiles:'Хэрэглэгч'};
const HIST_ACTION={CREATE:'Бүртгэсэн',UPDATE:'Засварласан',DELETE:'Устгасан'};
const HIST_FIELD={qty:'Тоо хэмжээ',unit_price:'Нэгж үнэ',total_amount:'Нийт дүн',sale_date:'Огноо',customer:'Хэрэглэгч',customer_phone:'Утас',purchase_date:'Огноо',live_weight_kg:'Амьд жин (кг)',price_per_kg:'Үнэ/кг',total_cost:'Нийт зардал',animal_type:'Мал төрөл',soum:'Сум',animal_code:'Малын код',product_code:'Бүтээгдэхүүний код',product_type:'Бүтээгдэхүүн',quantity_kg:'Жин (кг)',weight_kg:'Жин (кг)',unit_weight_kg:'Нэгжийн жин (кг)',unit:'Нэгж',quantity_sent_kg:'Илгээсэн жин (кг)',received_weight_kg:'Хүлээн авсан жин (кг)',received_date:'Хүлээн авсан огноо',processing_date:'Нядалгын огноо',processing_cost:'Нядалгын зардал',transport_date:'Тээврийн огноо',cost:'Зардал',packaging_date:'Савласан огноо',packaging_cost:'Савлагааны зардал',note:'Тайлбар',location:'Байршил',full_name:'Нэр',surname:'Овог',given_name:'Нэр',aimag:'Аймаг',last_vaccination_date:'Вакцины огноо',herd_size:'Мал толгой',certified:'MNS 6891 баталгаажсан',status:'Төлөв',material_type:'Материалын төрөл',original_quantity_kg:'Анхны жин (кг)',estimated_age_years:'Нас (жил)',role:'Эрх'};
const HIST_SKIP=new Set(['id','created_at','updated_at','created_by','responsible_user','animal_id','product_id','herder_id','source_material_id','source_processing_id','transport_id','transport_item_id','lot_id','parent_lot_id','related_entity_id','related_entity_type','location_type','destination_location','source_location','_sync_state','user_id']);
// Raw columns already shown as a resolved, human-readable row by histLinked
// (Малын код, Бүтээгдэхүүний код, Байршил). Hidden from the CREATE table to
// avoid showing the same value twice; kept for UPDATE so an edit's
// before/after is still visible.
const HIST_LINKED_RAW={animals:['animal_code'],products:['product_code'],processing_events:['location']};
// Fields that establish identity or lineage. Correcting a typo is fine;
// silently repointing a product at a different animal is not -- that would
// break the traceability the whole system exists to guarantee.
const HIST_LOCKED=new Set(['animal_code','product_code','soum','status','total_amount','total_cost']);
const HIST_EDITABLE={
 animals:['live_weight_kg','price_per_kg','animal_type','estimated_age_years','purchase_date','note'],
 herders:['surname','given_name','herd_size','certified','last_vaccination_date'],
 processing_events:['processing_date','processing_cost','location','note'],
 transports:['transport_date','cost','note'],
 receivings:['received_date','received_weight_kg','note'],
 products:['product_type','packaging_date','note'],
 sales:['qty','unit_price','sale_date','customer','customer_phone']
};
// The record's own business date, shown as "Огноо" in the detail modal --
// distinct from "Хэзээ" (the audit event's system timestamp) below it.
const HIST_DATE_FIELD={animals:'purchase_date',processing_events:'processing_date',transports:'transport_date',receivings:'received_date',products:'packaging_date',sales:'sale_date'};
// Fixed field order per section so the detail modal reads the same way every
// time: identity/context first, money/weight in the middle, note always last.
const HIST_DETAIL_ORDER={
 herders:['surname','given_name','soum','aimag','herd_size','certified','last_vaccination_date','note'],
 animals:['animal_type','estimated_age_years','live_weight_kg','price_per_kg','total_cost','certified','note'],
 processing_events:['location','processing_cost','note'],
 transports:['cost','note'],
 transport_items:['quantity_sent_kg'],
 receivings:['received_weight_kg','note'],
 products:['product_type','weight_kg','unit','qty','unit_weight_kg','packaging_cost','note'],
 sales:['qty','unit_price','total_amount','customer','customer_phone','note']
};
let HIST_PAGE=0; const HIST_PER=15;

function histVal(k,v){
 if(v===null||v===undefined||v==='')return '—';
 if(typeof v==='boolean')return v?'Тийм':'Үгүй';
 if(k==='material_type')return v==='MEAT'?'Мах':'Дайвар';
 if(typeof v==='number')return fmt(v);
 return String(v);
}
// One "Тээвэрлэлт эхлүүлэх" click writes a transports row plus one
// transport_items row per material, so the raw feed shows 2+ audit rows for
// what is really a single action. This folds each transport_items CREATE
// into its parent transports CREATE row (as x._items) so the list, subject,
// and CSV export all show one merged entry instead of a scattered pair.
function buildHistoryFeed(){
 const itemsByTransport={};
 cache.audit_logs.forEach(x=>{
   if(x.entity_type==='transport_items'&&x.action==='CREATE'){
     const tid=x.new_data?.transport_id;
     if(tid)(itemsByTransport[tid]=itemsByTransport[tid]||[]).push(x);
   }
 });
 return cache.audit_logs
   .filter(x=>!(x.entity_type==='transport_items'&&x.action==='CREATE'))
   .map(x=>(x.entity_type==='transports'&&x.action==='CREATE'&&itemsByTransport[x.entity_id])?{...x,_items:itemsByTransport[x.entity_id]}:x);
}
function historyFeed(){return buildHistoryFeed().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))}
// Subject shown in the list row, resolved per section so it's always the
// name a person actually recognizes -- herder for a purchase, product code
// for a sale -- instead of whichever raw field happened to exist.
function histSubject(x){
 const d=x.new_data||x.old_data||{};
 switch(x.entity_type){
   case 'herders': return d.full_name||'';
   case 'animals': return cache.herders.find(h=>h.id===d.herder_id)?.full_name||d.animal_code||'';
   case 'processing_events': return cache.animals.find(a=>a.id===d.animal_id)?.animal_code||'';
   case 'transports': {
     if(x._items&&x._items.length){
       const codes=[...new Set(x._items.map(it=>cache.animals.find(a=>a.id===it.new_data?.animal_id)?.animal_code).filter(Boolean))];
       if(codes.length) return codes.length>2?codes.slice(0,2).join(', ')+' +'+(codes.length-2):codes.join(', ');
     }
     return `${d.source_location||'—'} → ${d.destination_location||'SHOP'}`;
   }
   case 'transport_items': return cache.animals.find(a=>a.id===d.animal_id)?.animal_code||'';
   case 'receivings': {
     const ti=cache.transport_items.find(t=>t.id===d.transport_item_id);
     return (ti&&cache.animals.find(a=>a.id===ti.animal_id)?.animal_code)||'';
   }
   case 'products': return d.product_code||'';
   case 'sales': return cache.products.find(p=>p.id===d.product_id)?.product_code||'';
   default: return d.animal_code||d.product_code||d.full_name||d.animal_type||d.product_type||'';
 }
}
// Foreign-key fields (herder_id, animal_id, ...) are deliberately excluded
// from the raw diff table -- a bare UUID tells nobody anything. This
// resolves them into readable "Малчин: Дондов Батаа" style rows instead.
function histLinked(x){
 const d=x.new_data||x.old_data||{};
 const rows=[];
 if(x.entity_type==='animals'){
   rows.push({label:'Малын код',value:d.animal_code||'—'});
   rows.push({label:'Малчин',value:cache.herders.find(h=>h.id===d.herder_id)?.full_name||'—'});
 } else if(x.entity_type==='processing_events'){
   rows.push({label:'Мал',value:cache.animals.find(a=>a.id===d.animal_id)?.animal_code||'—'});
   if(d.location)rows.push({label:'Байршил',value:d.location});
 } else if(x.entity_type==='transports'){
   rows.push({label:'Чиглэл',value:`${d.source_location||'—'} → ${d.destination_location||'SHOP'}`});
   if(x._items&&x._items.length){
     const list=x._items.map(it=>{
       const a=cache.animals.find(a=>a.id===it.new_data?.animal_id);
       return `${a?.animal_code||'—'} (${fmtKg(it.new_data?.quantity_sent_kg||0)} кг)`;
     }).join(', ');
     rows.push({label:'Тээвэрлэсэн',value:list});
   }
 } else if(x.entity_type==='transport_items'){
   rows.push({label:'Мал',value:cache.animals.find(a=>a.id===d.animal_id)?.animal_code||'—'});
 } else if(x.entity_type==='receivings'){
   const ti=cache.transport_items.find(t=>t.id===d.transport_item_id);
   rows.push({label:'Мал',value:(ti&&cache.animals.find(a=>a.id===ti.animal_id)?.animal_code)||'—'});
 } else if(x.entity_type==='products'){
   rows.push({label:'Бүтээгдэхүүний код',value:d.product_code||'—'});
   rows.push({label:'Эх мал',value:cache.animals.find(a=>a.id===d.animal_id)?.animal_code||'—'});
 } else if(x.entity_type==='sales'){
   const p=cache.products.find(p=>p.id===d.product_id);
   rows.push({label:'Бүтээгдэхүүн',value:p?p.product_code+(p.product_type?' · '+p.product_type:''):'—'});
 }
 return rows;
}
function histChanges(x){
 const nw=x.new_data||{},od=x.old_data||{};
 const order=HIST_DETAIL_ORDER[x.entity_type]||[];
 const dateField=HIST_DATE_FIELD[x.entity_type];
 const linkedRaw=new Set(HIST_LINKED_RAW[x.entity_type]||[]);
 // On CREATE, the business date and any linked-raw fields are already shown
 // as headline rows, so repeating them here would just be noise. On UPDATE
 // they stay -- seeing the before/after of a corrected value is exactly
 // what an audit trail is for.
 let keys=x.action==='UPDATE'
   ?Object.keys(nw).filter(k=>!HIST_SKIP.has(k)&&HIST_FIELD[k]&&JSON.stringify(od[k])!==JSON.stringify(nw[k]))
   :Object.keys(nw).filter(k=>!HIST_SKIP.has(k)&&HIST_FIELD[k]&&k!==dateField&&!linkedRaw.has(k));
 keys.sort((a,b)=>{const ia=order.indexOf(a),ib=order.indexOf(b);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return -1;return ia-ib});
 return keys.map(k=>x.action==='UPDATE'?{k,label:HIST_FIELD[k],from:histVal(k,od[k]),to:histVal(k,nw[k])}:{k,label:HIST_FIELD[k],to:histVal(k,nw[k])});
}
function histBrief(x){
 const ch=histChanges(x).filter(c=>c.k!=='note').slice(0,3);
 if(!ch.length)return '';
 return ch.map(c=>c.from!==undefined?`${c.label}: ${esc(c.from)}→${esc(c.to)}`:`${c.label}: ${esc(c.to)}`).join(' · ');
}
function renderHistory(){
 const logs=historyFeed();
 const pages=Math.max(1,Math.ceil(logs.length/HIST_PER));
 if(HIST_PAGE>=pages)HIST_PAGE=pages-1;
 const slice=logs.slice(HIST_PAGE*HIST_PER,(HIST_PAGE+1)*HIST_PER);
 let lastDay='';
 const rows=slice.map((x,i)=>{
   const ent=HIST_ENTITY[x.entity_type]||x.entity_type;
   const act=HIST_ACTION[x.action]||x.action;
   const subj=histSubject(x);
   const idx=HIST_PAGE*HIST_PER+i;
   const d=new Date(x.created_at);
   const day=d.toLocaleDateString('mn-MN');
   let head='';
   if(day!==lastDay){ lastDay=day; head=`<div class="helper" style="margin:14px 0 6px;font-weight:700;color:var(--primary-dark)">${esc(day)}</div>`; }
   const time=d.toLocaleTimeString('mn-MN',{hour:'2-digit',minute:'2-digit'});
   const who=x.user_label||'—';
   return head+`<div class="list-item" style="cursor:pointer" onclick="histOpen(${idx})">
     <div class="top-row"><b>${esc(who)}</b><span class="date">${esc(time)}</span></div>
     <div class="details"><b>${esc(act)}</b> · ${esc(ent)}${subj?' · '+esc(subj):''}</div>
     ${histBrief(x)?`<div class="helper">${histBrief(x)}</div>`:''}
   </div>`;
 }).join('');
 const tools=`<div class="split" style="margin-bottom:12px"><span class="helper">Түүхийг Excel-д татах</span><button class="btn-secondary" onclick="exportHistoryXLSX()">⬇ Excel</button></div>`;
 const nav=`<div class="split" style="margin-top:10px">
   <button class="btn-ghost" ${HIST_PAGE===0?'disabled':''} onclick="histPage(-1)">← Өмнөх</button>
   <span class="helper">${HIST_PAGE+1} / ${pages} · нийт ${logs.length}</span>
   <button class="btn-ghost" ${HIST_PAGE>=pages-1?'disabled':''} onclick="histPage(1)">Дараах →</button>
 </div>`;
 $('view').innerHTML=formCard(logs.length?tools+rows+nav:'<div class="empty"><div class="big">—</div>Түүх алга</div>');
}
function histPage(d){HIST_PAGE=Math.max(0,HIST_PAGE+d);renderHistory();window.scrollTo(0,0)}
function metaRow(label,value){return `<div class="split" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="muted">${esc(label)}</span><b style="text-align:right">${value}</b></div>`}
function histOpen(idx){
 const logs=historyFeed();
 const x=logs[idx]; if(!x)return;
 const ent=HIST_ENTITY[x.entity_type]||x.entity_type;
 const act=HIST_ACTION[x.action]||x.action;
 const d=x.new_data||x.old_data||{};
 const dateField=HIST_DATE_FIELD[x.entity_type];
 const bizDate=dateField&&d[dateField]?d[dateField]:null;
 const ch=histChanges(x);
 const noteRow=ch.find(c=>c.k==='note');
 const amountRows=ch.filter(c=>c.k!=='note');
 const canEdit=profile?.role==='superadmin'&&HIST_EDITABLE[x.entity_type];

 // Fixed order every time: Огноо (business date) -> Хэн -> Үйлдэл -> Хэзээ
 // (system timestamp) -> resolved identity fields (малчин/мал/бүтээгдэхүүн).
 const meta=[
   bizDate?metaRow('Огноо',esc(bizDate)):'',
   metaRow('Хэн',esc(x.user_label||'—')),
   metaRow('Үйлдэл',`${esc(act)} · ${esc(ent)}`),
   metaRow('Хэзээ',esc(new Date(x.created_at).toLocaleString('mn-MN'))),
   ...histLinked(x).map(r=>metaRow(r.label,esc(r.value)))
 ].join('');

 const amountsTable=amountRows.length?`<table style="margin-top:12px"><tr><th>Талбар</th>${x.action==='UPDATE'?'<th>Өмнө</th>':''}<th>${x.action==='UPDATE'?'Дараа':'Утга'}</th></tr>
   ${amountRows.map(c=>`<tr><td>${esc(c.label)}</td>${x.action==='UPDATE'?`<td class="muted">${esc(c.from)}</td>`:''}<td><b>${esc(c.to)}</b></td></tr>`).join('')}</table>`:'';

 $('modal-root').innerHTML=`<div class="modal-back"><div class="modal">
   <div class="modal-head"><b>${esc(ent)} — ${esc(act)}</b><button class="x" onclick="histClose()">×</button></div>
   <div style="margin-top:8px">${meta}</div>
   ${amountsTable}
   ${noteRow?`<div class="helper" style="margin-top:12px"><b>Тайлбар:</b> ${esc(noteRow.to)}</div>`:''}
   ${x.reason?`<div class="helper" style="margin-top:6px">Засварын шалтгаан: ${esc(x.reason)}</div>`:''}
   ${canEdit?`<button class="btn-primary" style="margin-top:14px" onclick="histEdit('${x.entity_type}','${x.entity_id}')">Засварлах</button>`:''}
 </div></div>`;
}
function histClose(){$('modal-root').innerHTML=''}
function histEdit(table,id){
 const fields=HIST_EDITABLE[table]||[];
 const row=(cache[table]||[]).find(r=>r.id===id);
 if(!row)return toast('Бичлэг олдсонгүй. Эхлээд синк хийнэ үү.');
 $('modal-root').innerHTML=`<div class="modal-back"><div class="modal">
   <div class="modal-head"><b>Засварлах — ${esc(HIST_ENTITY[table]||table)}</b><button class="x" onclick="histClose()">×</button></div>
   <form id="histEditForm">
   ${fields.map(f=>{
     const v=row[f]??'';
     const t=(typeof row[f]==='number')?'number':(String(f).includes('date')?'date':'text');
     if(typeof row[f]==='boolean')return `<label>${esc(HIST_FIELD[f]||f)}</label><select name="${f}"><option value="true" ${row[f]?'selected':''}>Тийм</option><option value="false" ${!row[f]?'selected':''}>Үгүй</option></select>`;
     return `<label>${esc(HIST_FIELD[f]||f)}</label><input name="${f}" type="${t}" ${t==='number'?'step="0.01"':''} value="${esc(v)}">`;
   }).join('')}
   <label>Засварын шалтгаан (заавал)</label><textarea name="__reason" rows="2" required></textarea>
   <button class="btn-primary">Хадгалах</button></form>
 </div></div>`;
 $('histEditForm').onsubmit=async e=>{
   e.preventDefault();
   const fd=new FormData(e.target);
   const reason=String(fd.get('__reason')||'').trim();
   if(!reason)return toast('Шалтгаан бөглөнө үү');
   const patch={};
   for(const f of fields){
     let v=fd.get(f);
     if(v===null)continue;
     if(typeof row[f]==='boolean')v=(v==='true');
     else if(typeof row[f]==='number')v=num(v);
     else v=(v===''?null:v);
     if(JSON.stringify(v)!==JSON.stringify(row[f]??null))patch[f]=v;
   }
   if(!Object.keys(patch).length)return toast('Өөрчлөлт алга');
   try{
     const r=await supa().from(table).update(patch).eq('id',id).select().single();
     if(r.error)throw r.error;
     await supa().from('audit_logs').insert({entity_type:table,entity_id:id,action:'UPDATE',user_id:session.user.id,old_data:row,new_data:r.data,reason});
     toast('Засварлагдлаа');
     histClose();
     await pullData(); renderHistory();
   }catch(err){ toast('Алдаа: '+errMn(err)) }
 };
}

// ---- Excel export (real .xlsx via SheetJS, loaded from CDN in index.html)
// CSV turned out to be a dead end here: the separator character and the
// text encoding are both interpreted differently depending on the
// computer's regional settings, which is exactly what produced the merged
// columns and the Cyrillic mojibake. A real .xlsx file stores both the
// column structure and the text as proper Unicode, so there's nothing left
// for Excel to guess.
function downloadXLSX(filename,rows){
 if(!rows.length)return toast('Татах мэдээлэл алга');
 if(!window.XLSX)return toast('Excel сан ачаалагдаагүй байна. Дахин оролдоно уу.');
 const ws=XLSX.utils.json_to_sheet(rows);
 const wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,ws,'Тайлан');
 XLSX.writeFile(wb,filename);
 toast('Татагдлаа');
}
function exportHistoryXLSX(){
 const logs=historyFeed();
 downloadXLSX(`tuuh-${today()}.xlsx`, logs.map(x=>({
   'Огноо':new Date(x.created_at).toLocaleString('mn-MN'),
   'Хэрэглэгч':x.user_label||'',
   'Үйлдэл':HIST_ACTION[x.action]||x.action,
   'Хэсэг':HIST_ENTITY[x.entity_type]||x.entity_type,
   'Обьект':histSubject(x),
   'Өөрчлөлт':histChanges(x).map(c=>c.from!==undefined?`${c.label}: ${c.from} -> ${c.to}`:`${c.label}: ${c.to}`).join(' | '),
   'Шалтгаан':x.reason||''
 })));
}
window.exportHistoryXLSX=exportHistoryXLSX;

// ---- Guarded delete (superadmin only) ----
// A record may only be removed while nothing downstream depends on it.
// Deleting a product that has already been sold -- or whose QR label is
// physically on a package -- would leave a scanned code pointing at nothing.
function deleteBlockers(table,id){
 const b=[];
 if(table==='products'){
   if(cache.sales.some(x=>x.product_id===id))b.push('борлуулалт бүртгэгдсэн');
 }
 if(table==='animals'){
   if(cache.processing_events.some(x=>x.animal_id===id))b.push('нядалга хийгдсэн');
   if(cache.products.some(x=>x.animal_id===id))b.push('бүтээгдэхүүн үүссэн');
 }
 if(table==='herders'){
   if(cache.animals.some(x=>x.herder_id===id))b.push('мал бүртгэгдсэн');
 }
 if(table==='material_lots'||table==='materials'){
   if(cache.products.some(x=>x.source_material_id===id))b.push('бүтээгдэхүүн үүссэн');
   if(cache.transport_items.some(x=>x.source_material_id===id))b.push('тээвэрлэгдсэн');
 }
 return b;
}
async function deleteRecord(table,id,label){
 if(profile?.role!=='superadmin')return toast('Зөвхөн супер админ устгах эрхтэй');
 const blockers=deleteBlockers(table,id);
 if(blockers.length){
   return alert(`Устгах боломжгүй.\n\nЭнэ бичлэг дээр аль хэдийн: ${blockers.join(', ')}.\n\nМөшгөлтийн бүрэн бүтэн байдлыг хамгаалахын тулд устгахыг зөвшөөрөхгүй. Оронд нь Түүх хэсгээс засварлана уу.`);
 }
 const reason=prompt(`"${label}" -г устгах шалтгаан:`);
 if(reason===null)return;
 if(!reason.trim())return toast('Шалтгаан бөглөнө үү');
 if(!confirm('Энэ үйлдлийг буцаах боломжгүй. Устгах уу?'))return;
 try{
   const row=(cache[table]||[]).find(r=>r.id===id)||null;
   const r=await supa().from(table).delete().eq('id',id);
   if(r.error)throw r.error;
   await supa().from('audit_logs').insert({entity_type:table,entity_id:id,action:'DELETE',user_id:session.user.id,old_data:row,new_data:null,reason:reason.trim()});
   toast('Устгагдлаа');
   await pullData(); renderHome();
 }catch(err){ alert('Устгах алдаа: '+errMn(err)) }
}
window.deleteRecord=deleteRecord;

window.histOpen=histOpen;window.histClose=histClose;window.histPage=histPage;window.histEdit=histEdit;
window.invTab=invTab;

async function upsertDirect(table,row){const r=await supa().from(table).upsert(row,{onConflict:'id'}).select().single();if(r.error)throw r.error;await saveLocalRecord(table,r.data,'synced');return r.data}
function errMn(err){
 const raw=(err&&err.message)||String(err||'');
 const m={
  'ANIMAL_ALREADY_PROCESSED':'Энэ мал аль хэдийн нядлагдсан байна.',
  'ANIMAL_NOT_FOUND':'Мал олдсонгүй.',
  'FORBIDDEN':'Танд энэ үйлдлийг хийх эрх алга.',
  'INVALID_WEIGHT':'Жин буруу байна.',
  'MATERIAL_NOT_AT_SHOP':'Энэ материал дэлгүүрт хүлээн авагдаагүй байна.',
  'MATERIAL_NOT_FOUND':'Материал олдсонгүй.',
  'NO_OUTPUTS':'Гарц оруулаагүй байна.',
  'PRODUCT_NOT_FOUND':'Бүтээгдэхүүн олдсонгүй.',
  'SOURCE_ALREADY_SHOP':'Энэ нөөц аль хэдийн дэлгүүрт байна.',
  'SOURCE_NOT_FOUND':'Эх үүсвэр олдсонгүй.',
  'TRANSPORT_NOT_FOUND':'Тээвэр олдсонгүй.'
 };
 for(const k in m){ if(raw.includes(k)) {
   if(k==='INSUFFICIENT_MATERIAL'||k==='INSUFFICIENT_PRODUCT') break;
   return m[k];
 }}
 let mm=raw.match(/INSUFFICIENT_MATERIAL:(?:[^:]*:)?([\d.]+)/);
 if(mm) return `Материалын үлдэгдэл хүрэлцэхгүй байна. Боломжит: ${fmtKg(mm[1])} кг`;
 mm=raw.match(/INSUFFICIENT_PRODUCT:([\d.]+)/);
 if(mm) return `Бүтээгдэхүүний үлдэгдэл хүрэлцэхгүй байна. Боломжит: ${fmt(mm[1])}`;
 if(/Failed to fetch|NetworkError|network/i.test(raw)) return 'Сүлжээний алдаа. Интернэт холболтоо шалгана уу.';
 if(/JWT|token|expired/i.test(raw)) return 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.';
 return raw;
}
async function rpc(fn,args){const r=await supa().rpc(fn,args);if(r.error)throw r.error;return r.data}
async function pullTable(table){const remote=REMOTE_VIEWS[table]||table;const r=await supa().from(remote).select('*');if(r.error)throw r.error;cache[table]=r.data||[];for(const row of cache[table])await saveLocalRecord(table,row,'synced')}
async function pullData(){if(!isOnline())return;for(const t of TABLES.filter(x=>x!=='audit_logs'))await pullTable(t);try{await pullTable('audit_logs')}catch(_){}settings.lastSync=new Date().toISOString();await saveSettings();await loadLocal()}
async function syncNow(){if(syncing||!isOnline()||!supa())return;syncing=true;try{
  const events=(await idbGetAll('outbox')).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const order={herder_create:1,animal_create:2,processing_create:3,transport_create:4};
  events.sort((a,b)=>(order[a.type]||99)-(order[b.type]||99)||new Date(a.created_at)-new Date(b.created_at));
  for(const ev of events){try{ev.status='syncing';ev.attempts++;await idbPut('outbox',ev);if(ev.type==='herder_create'){await upsertDirect('herders',ev.payload)}else if(ev.type==='animal_create'){await upsertDirect('animals',ev.payload);}else if(ev.type==='processing_create')await rpc('create_processing_bundle',{p_payload:ev.payload});else if(ev.type==='transport_create')await rpc('create_transport_bundle',{p_payload:ev.payload});else throw new Error('Unknown outbox event '+ev.type);await removeOutbox(ev.event_id)}catch(err){ev.status='failed';ev.error=errMn(err);await idbPut('outbox',ev)}}
  const failed=(await idbGetAll('outbox')).filter(x=>x.status==='failed').length;if(failed)toast(`${failed} бичлэг синк хийгдээгүй үлдлээ`);else if(events.length)toast('Синк амжилттай');settings.lastSync=new Date().toISOString();await saveSettings();await pullData();
 }finally{syncing=false}}
async function refreshAll(){await loadLocal();const active=location.hash.slice(1);if(active)navigate(active);else renderHome()}

function showQR(code){
 const url=new URL('./public.html',location.href);url.searchParams.set('code',code);
 const root=document.getElementById('modal-root');root.innerHTML=`<div class="modal-back"><div class="modal"><div class="modal-head"><b>QR — ${esc(code)}</b><button class="x" onclick="document.getElementById('modal-root').innerHTML=''">×</button></div><div id="qrBox" style="text-align:center;padding:18px"></div><div class="helper" style="word-break:break-all">${esc(url.href)}</div><div class="actions" style="margin-top:14px"><button class="btn-secondary" onclick="window.open('${url.href.replace(/'/g,"%27")}','_blank')">Нийтийн хуудас нээх</button><button class="btn-secondary" onclick="window.print()">Хэвлэх</button></div></div></div>`;
 if(window.QRCode){
   const box=document.getElementById('qrBox');
   const cv=document.createElement('canvas');
   box.appendChild(cv);
   QRCode.toCanvas(cv,url.href,{width:220,margin:2},err=>{
     if(err){console.error('[qr] failed',err);box.innerHTML='<div class="warn">QR үүсгэхэд алдаа гарлаа</div>'}
   });
 }else{
   document.getElementById('qrBox').innerHTML='<div class="warn">QR сан ачаалагдсангүй</div>';
 }
}
window.showQR=showQR;
window.navigate=navigate;window.renderHome=renderHome;window.syncNow=syncNow;window.refreshAll=refreshAll;
async function boot(){idb=await openIDB();await loadLocal();const ok=await ensureAuth();if(!ok)return;shell();await pullData().catch(()=>{});renderHome();if(isOnline())syncNow().then(refreshAll)}
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').then(reg=>{console.log('[sw] registered',reg.scope)}).catch(err=>{console.error('[sw] registration FAILED:',err)}));
boot().catch(err=>renderError('Апп эхлүүлэхэд алдаа гарлаа',errMn(err)));
})();
