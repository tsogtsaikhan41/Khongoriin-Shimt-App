/* Хонгорын Шимт V6 - static PWA, Supabase + IndexedDB */
(function(){
'use strict';

const CONFIG = window.APP_CONFIG || {};
const SB = window.supabase;
const TABLES = ['herders','animals','processing_events','materials','transports','transport_items','receivings','products','sales','audit_logs'];
const REMOTE_VIEWS = {transports:'transport_summary', products:'product_balances'};
const OFFLINE_MUTATIONS = new Set(['herder_create','animal_create','processing_create','transport_create']);
const SOUMS = [
  {name:'Богд',code:'BOG'}, {name:'Жинст',code:'JIN'}, {name:'Бөмбөгөр',code:'BUM'}, {name:'Баян-Цагаан',code:'BTS'}
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
const today=()=>new Date().toISOString().slice(0,10);
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
  const pr=await c.from('profiles').select('id,role,full_name').eq('id',session.user.id).maybeSingle();
  if(pr.error){renderError('Профайл уншихад алдаа гарлаа',pr.error.message);return false}
  profile=pr.data;
  if(!profile){renderError('Хэрэглэгчийн профайл тохируулаагүй байна','Supabase дээр profiles хүснэгтэд таны хэрэглэгчийн мөрийг үүсгэнэ үү.');return false}
  return true;
}

function renderSetup(){
  $('app').innerHTML=`<main><div class="card"><h2 class="section-title">⚙️ Холболтын тохиргоо</h2><p class="section-note">Эхлээд <b>config.js</b> файлд Supabase Project URL болон зөвхөн frontend-д ашиглах Publishable/Anon key-гээ оруулна уу.</p><ol class="muted"><li>Supabase → Project Settings → API</li><li>Project URL-ийг хуул.</li><li>Publishable/Anon key-ийг хуул.</li><li>config.js файлд оруул.</li></ol><div class="warn">⚠️ Service Role key-г frontend-д хэзээ ч бүү хий.</div></div></main>`;
}
function renderError(title,msg){$('app').innerHTML=`<main><div class="card"><h2 class="section-title">⚠️ ${esc(title)}</h2><p>${esc(msg)}</p><button class="btn-secondary" onclick="location.reload()">Дахин оролдох</button></div></main>`}
function renderLogin(){
  $('app').innerHTML=`<main><div class="card" style="max-width:420px;margin:50px auto"><div style="font-size:32px">🐑</div><h2 class="section-title">Хонгорын Шимт</h2><p class="section-note">Махны мөшгөлт ба үйл ажиллагаа</p><form id="loginForm"><label>Имэйл</label><input type="email" name="email" required autocomplete="username"><label>Нууц үг</label><input type="password" name="password" required autocomplete="current-password"><button class="btn-primary">Нэвтрэх</button></form></div></main>`;
  $('loginForm').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);const r=await supa().auth.signInWithPassword({email:f.get('email'),password:f.get('password')});if(r.error)throw r.error;await boot()}catch(err){toast('Нэвтрэхэд алдаа: '+err.message)}};
}

function shell(){
  $('app').innerHTML=`
  <header class="topbar"><div class="brand"><span class="logo">🐑</span><div class="titles"><b>Мах Хяналт</b><span id="userLabel"></span></div></div><div class="top-actions"><span id="netDot" class="status-dot"></span><select class="top-select" id="soumSelect"><option value="">Сум сонгох</option></select><button class="backbtn" id="logoutBtn">Гарах</button></div></header>
  <main id="main"></main>`;
  SOUMS.forEach(s=>{const o=document.createElement('option');o.value=s.name;o.textContent=s.name;$('soumSelect').appendChild(o)});const sh=document.createElement('option');sh.value='Дэлгүүр';sh.textContent='Дэлгүүр (төв)';$('soumSelect').appendChild(sh);
  $('soumSelect').value=settings.soum||''; $('soumSelect').onchange=()=>{settings.soum=$('soumSelect').value;saveSettings();renderHome()};
  $('logoutBtn').onclick=async()=>{if((await idbGetAll('outbox')).length){if(!confirm('Синк хүлээж буй мэдээлэл байна. Гарахдаа үргэлжлүүлэх үү?'))return}await supa().auth.signOut();location.reload()};
  $('userLabel').textContent=`${profile?.full_name||session?.user?.email||''} · ${profile?.role||''}`;
  updateNet();window.addEventListener('online',()=>{updateNet();syncNow().then(refreshAll)});window.addEventListener('offline',updateNet);
}
function updateNet(){const d=$('netDot');if(!d)return;d.className='status-dot '+(isOnline()?'status-online':'status-offline');d.title=isOnline()?'Интернэттэй':'Интернэтгүй'}
function renderHome(){
 const soum=settings.soum||'Сум сонгоогүй';
 $('main').innerHTML=`<div class="syncbar"><span class="status-dot ${isOnline()?'status-online':'status-offline'}"></span><span>${isOnline()?'Интернэттэй':'Интернэтгүй'} · ${settings.lastSync?'Сүүлд синк: '+new Date(settings.lastSync).toLocaleString('mn-MN'):'Одоогоор синк хийгдээгүй'}</span><span style="margin-left:auto"><button class="btn-ghost" onclick="syncNow().then(refreshAll)">🔄 Синк</button></span></div>
 <div class="grid">
 <div class="tile wide dashboard" onclick="navigate('dashboard')"><div><div class="label">📊 Хянах самбар</div><div class="sub">Зардал, борлуулалт, гарц</div></div><div style="font-size:26px">›</div></div>
 <div class="tile" onclick="navigate('purchase')"><div class="icon">🛒</div><div class="label">Худалдан авалт</div><div class="sub">Малчнаас мал авах</div></div>
 <div class="tile" onclick="navigate('processing')"><div class="icon">🔪</div><div class="label">Нядалга</div><div class="sub">Мал бэлтгэх</div></div>
 <div class="tile" onclick="navigate('transport')"><div class="icon">🚚</div><div class="label">Тээвэрлэлт</div><div class="sub">Дэлгүүр рүү илгээх</div></div>
 <div class="tile" onclick="navigate('receiving')"><div class="icon">📥</div><div class="label">Хүлээн авалт</div><div class="sub">Дэлгүүрт хүлээн авах</div></div>
 <div class="tile" onclick="navigate('packaging')"><div class="icon">📦</div><div class="label">Баглаа боодол</div><div class="sub">Мах бэлдэх, савлах</div></div>
 <div class="tile" onclick="navigate('sales')"><div class="icon">💰</div><div class="label">Борлуулалт</div><div class="sub">Хэрэглэгчид зарах</div></div>
 <div class="tile" onclick="navigate('inventory')"><div class="icon">🗃️</div><div class="label">Агуулах</div><div class="sub">Одоогийн нөөц</div></div>
 <div class="tile" onclick="navigate('history')"><div class="icon">🧾</div><div class="label">Түүх</div><div class="sub">Хэн, хэзээ өөрчилсөн</div></div>
 </div><div class="card" style="margin-top:14px"><b>Одоогийн байрлал:</b> ${esc(soum)}<div class="helper">Сум дээр худалдан авалт, нядалга, тээвэрлэлтийг offline хийж болно.</div></div>`;
}
function navigate(screen){
  if(screen==='home')return renderHome();
  if(screen==='history'&&profile?.role!=='superadmin'){toast('Энэ хэсэг зөвхөн Superadmin-д нээлттэй');return}
  if(['receiving','packaging','sales','dashboard','inventory','history'].includes(screen)&&!isOnline()){toast('Энэ хэсэг интернэттэй үед ажиллана');return}
  const names={purchase:'Худалдан авалт',processing:'Нядалга',transport:'Тээвэрлэлт',receiving:'Хүлээн авалт',packaging:'Баглаа боодол',sales:'Борлуулалт',inventory:'Агуулах',dashboard:'Хянах самбар',history:'Үйл ажиллагааны түүх'};
  $('main').innerHTML=`<div class="split"><div><h2 class="section-title">${names[screen]}</h2></div><button class="btn-secondary" onclick="renderHome()">← Нүүр</button></div><div id="view"></div>`;
  ({purchase:renderPurchase,processing:renderProcessing,transport:renderTransport,receiving:renderReceiving,packaging:renderPackaging,sales:renderSales,inventory:renderInventory,dashboard:renderDashboard,history:renderHistory})[screen]?.();
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
 <label>Малчны нэр</label><input name="herderName" required placeholder="Жишээ: Батбаяр">
 <label>Сум</label><select name="soum" required>${SOUMS.map(s=>`<option ${settings.soum===s.name?'selected':''}>${s.name}</option>`).join('')}</select>
 <label>Мал төрөл</label><select name="animalType" required><option value="">-- сонгох --</option><option>Ямаа</option><option>Хонь</option><option>Үхэр</option><option>Адуу</option><option>Тэмээ</option></select>
 <div class="row2"><div><label>Амьд жин (кг)</label><input type="number" name="liveWeight" min="0.1" step="0.1" required></div><div><label>Үнэ / кг (₮)</label><input type="number" name="pricePerKg" min="0" step="1" required></div></div>
 <div class="calc-box"><span>Нийт үнэ:</span><b id="purchaseTotal">0 ₮</b></div>
 <label>Тайлбар (заавал биш)</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`)+`<div id="purchaseList"></div>`;
 const f=$('purchaseForm');function c(){ $('purchaseTotal').textContent=fmt(num(f.liveWeight.value)*num(f.pricePerKg.value),0)+' ₮'};f.oninput=c;
 f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);await createPurchase(fd)};renderPurchaseList();
}
async function createPurchase(fd){
 const herderName=String(fd.get('herderName')).trim(), soum=String(fd.get('soum')), animalType=String(fd.get('animalType'));
 const herder={id:uuid(),full_name:herderName,soum,location_detail:null,herd_size:null,last_vaccination_date:null,certified:false,created_by:session.user.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
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
 }
 const live=num(fd.get('liveWeight')), price=num(fd.get('pricePerKg'));
 const animal={id:uuid(),animal_code:`${(SOUMS.find(s=>s.name===soum)?.code||'GEN')}-${new Date(fd.get('date')+'T00:00:00').toISOString().slice(2,10).replace(/-/g,'')}-${crypto.randomUUID().slice(0,6).toUpperCase()}`,herder_id:existing.id,soum,purchase_date:String(fd.get('date')),animal_type:animalType,estimated_age_years:null,live_weight_kg:live,price_per_kg:price,total_cost:live*price,status:'PURCHASED',note:fd.get('note')||null,created_by:session.user.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 cache.animals.push({...animal,_sync_state:'pending'});await saveLocalRecord('animals',animal,'pending');
 if(isOnline()){try{const saved=await upsertDirect('animals',animal);cache.animals=cache.animals.filter(a=>a.id!==animal.id).concat({...saved,_sync_state:'synced'});await saveLocalRecord('animals',saved,'synced');toast('Хадгалагдлаа')}catch(err){await addOutbox('animal_create',animal);toast('Локалд хадгаллаа — синк хүлээж байна')}} else {await addOutbox('animal_create',animal);toast('Offline хадгаллаа — интернэт ормогц синк хийнэ')}
 $('purchaseForm').reset();$('purchaseTotal').textContent='0 ₮';renderPurchaseList();
}
function renderPurchaseList(){const el=$('purchaseList');if(!el)return;const items=cache.animals.slice().reverse();el.innerHTML=items.length?items.map(a=>`<div class="list-item"><div class="top-row"><div class="batch">${esc(a.animal_code)}</div><div class="date">${esc(a.purchase_date)}</div></div><div class="details">${esc(cache.herders.find(h=>h.id===a.herder_id)?.full_name||'—')} · ${esc(a.soum)} · ${esc(a.animal_type)} · ${fmt(a.live_weight_kg)} кг · ${fmt(a.total_cost,0)}₮ ${a._sync_state!=='synced'?'<span class="badge neutral">Синк хүлээж байна</span>':''}</div></div>`).join(''):'<div class="empty"><div class="big">🗒️</div>Бичлэг алга байна</div>'}

function renderProcessing(){
 const animals=sourceAnimalOptions().filter(a=>a.status==='PURCHASED');
 $('view').innerHTML=(isOnline()?'':`<div class="warn">⚠️ Offline горим. Энэ амьтны худалдан авалт өмнө нь төв сервертэй синк болсон байх ёстой.</div>`)+formCard(`<form id="processingForm"><label>Амьтан</label><select name="animal_id" required>${animals.map(a=>`<option value="${a.id}">${esc(a.animal_code)} · ${esc(a.animal_type)} · ${fmt(a.live_weight_kg)} кг</option>`).join('')||'<option value="">Боломжит амьтан алга</option>'}</select><label>Огноо</label><input type="date" name="date" value="${today()}" required><label>Нядалга хийсэн газар</label><input name="location" placeholder="Жишээ: сумын төв"><div class="row2"><div><label>Махны гарц (кг)</label><input type="number" name="meat_kg" min="0" step="0.1" required></div><div><label>Дайвар (кг)</label><input type="number" name="byproduct_kg" min="0" step="0.1" value="0" required></div></div><div class="calc-box"><span>Боловсруулалтын зөрүү:</span><b id="procDiff">—</b></div><label>Зардал (₮)</label><input type="number" name="cost" min="0" step="1" value="0"><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('processingForm');function calc(){const a=cache.animals.find(x=>x.id===f.animal_id.value);const d=a?num(a.live_weight_kg)-num(f.meat_kg.value)-num(f.byproduct_kg.value):0;$('procDiff').textContent=fmt(d)+' кг'}f.oninput=calc;f.onsubmit=async e=>{e.preventDefault();await createProcessing(new FormData(f))};calc();
}
async function createProcessing(fd){
 const aid=String(fd.get('animal_id')), a=cache.animals.find(x=>x.id===aid);if(!a)return toast('Амьтан сонгоно уу');if(a._sync_state!=='synced')return toast('Энэ амьтны худалдан авалт төв сервертэй синк болоогүй байна');
 const payload={processing:{id:uuid(),animal_id:aid,processing_date:String(fd.get('date')),location:String(fd.get('location')||''),responsible_user:session.user.id,processing_cost:num(fd.get('cost')),note:fd.get('note')||null},outputs:[{id:uuid(),animal_id:aid,material_type:'MEAT',quantity_kg:num(fd.get('meat_kg'))},{id:uuid(),animal_id:aid,material_type:'BYPRODUCT',quantity_kg:num(fd.get('byproduct_kg'))}]};
 if(isOnline()){try{await rpc('create_processing_bundle',{p_payload:payload});await pullData();toast('Хадгалагдлаа')}catch(err){toast('Хадгалах алдаа: '+err.message);return}}
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
 $('view').innerHTML=formCard(`<form id="transportForm"><label>Эх материал</label><select name="material_id" required>${mats.map(m=>`<option value="${m.id}">${esc(m.animal_code||m.id.slice(0,8))} · ${m.material_type==='MEAT'?'Мах':'Дайвар'} · ${fmt(m.current_available)} кг</option>`).join('')||'<option value="">Тээвэрлэх нөөц алга</option>'}</select><label>Огноо</label><input type="date" name="date" value="${today()}" required><label>Илгээсэн жин (кг)</label><input type="number" name="weight" min="0.1" step="0.1" required><label>Тээврийн зардал (₮)</label><input type="number" name="cost" min="0" step="1" value="0"><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('transportForm');f.onsubmit=async e=>{e.preventDefault();await createTransport(new FormData(f))}
}
async function createTransport(fd){
 const mid=String(fd.get('material_id')),m=cache.materials.find(x=>x.id===mid);const w=num(fd.get('weight'));if(!m||w<=0)return toast('Материал/жин буруу');if(w>num(m.current_available)+.0001)return toast('Үлдэгдлээс их байна');
 const payload={transport:{id:uuid(),transport_date:String(fd.get('date')),source_location:m.location_type,destination_location:'SHOP',responsible_user:session.user.id,cost:num(fd.get('cost')),note:fd.get('note')||null},items:[{id:uuid(),source_material_id:mid,animal_id:m.animal_id,quantity_sent_kg:w}]};
 if(isOnline()){try{await rpc('create_transport_bundle',{p_payload:payload});await pullData();toast('Хадгалагдлаа')}catch(err){toast('Хадгалах алдаа: '+err.message);return}}else{await addOutbox('transport_create',payload);toast('Offline хадгалаглаа — дараа синк хийнэ')}
 renderTransport();
}

function renderReceiving(){
 const ts=cache.transports.filter(t=>t.destination_location==='SHOP').sort((a,b)=>b.transport_date?.localeCompare(a.transport_date||'')||0);
 $('view').innerHTML=formCard(`<form id="receivingForm"><label>Тээвэр</label><select name="transport_id" required>${ts.map(t=>`<option value="${t.id}">${esc(t.id.slice(0,8))} · ${esc(t.transport_date)} · ${fmt(t.total_sent_kg||0)} кг</option>`).join('')||'<option>Тээвэр алга</option>'}</select><label>Хүлээн авсан огноо</label><input type="date" name="date" value="${today()}" required><label>Хүлээн авсан жин (кг)</label><input type="number" name="weight" min="0" step="0.1" required><div class="calc-box"><span>Тээврийн зөрүү:</span><b id="recvDiff">—</b></div><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('receivingForm');function c(){const t=cache.transports.find(x=>x.id===f.transport_id.value);$('recvDiff').textContent=t?fmt(num(t.total_sent_kg)-num(f.weight.value))+' кг':'—'}f.oninput=c;f.onchange=c;f.onsubmit=async e=>{e.preventDefault();const t=cache.transports.find(x=>x.id===f.transport_id.value);if(!t)return;try{await rpc('receive_transport',{p_transport_id:t.id,p_received_date:String(f.date.value),p_note:f.note.value||null,p_user_id:session.user.id,p_received_weight_kg:num(f.weight.value)});await pullData();toast('Хүлээн авалт хадгалагдлаа');renderReceiving()}catch(err){toast('Алдаа: '+err.message)}};c();
}

function renderPackaging(){
 const mats=cache.materials.filter(m=>m.location_type==='SHOP'&&num(m.current_available)>0);const products=cache.products.filter(p=>num(p.current_available)>0);
 $('view').innerHTML=formCard(`<form id="packForm"><label>Эх сурвалж</label><select name="material_id" required>${mats.map(m=>`<option value="${m.id}">${esc(m.animal_code||m.id.slice(0,8))} · ${esc(m.material_type==='MEAT'?'Мах':'Дайвар')} · ${fmt(m.current_available)} кг</option>`).join('')||'<option value="">Дэлгүүрт материал алга</option>'}</select><label>Бүтээгдэхүүний төрөл</label><select name="product_type" id="productType" required><option value="">-- сонгох --</option><option>Гулууз (бүтэн)</option><option>Өрөөл - Гуя</option><option>Өрөөл - Хаа</option><option>Өрөөл - Мөр</option><option>Өрөөл - Нуруу</option><option>Өрөөл - Цээж</option><option>Өрөөл - Дал</option><option>Өрөөл - Хавирга</option><option>Жижиглэн</option><option>Хорхог 1.5кг</option><option>Хорхог 2.3кг</option><option>Хорхог 3.3кг</option></select><label>Нийт жин (кг)</label><input name="weight" id="packWeight" type="number" min="0.1" step="0.1" required><div id="khQtyWrap" class="hidden"><label>Баглааны тоо</label><input id="khQty" type="number" min="1" step="1"></div><div class="calc-box"><span>Нийт бүтээгдэхүүний жин:</span><b id="packTotal">0 кг</b></div><label>Савлагааны зардал (₮)</label><input name="cost" type="number" min="0" step="1" value="0"><label>Огноо</label><input name="date" type="date" value="${today()}" required><label>Тайлбар</label><textarea name="note" rows="2"></textarea><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('packForm');const type=$('productType');type.onchange=()=>{const size=KHORKHOG[type.value];$('khQtyWrap').classList.toggle('hidden',!size);if(size){$('packWeight').readOnly=true}else{$('packWeight').readOnly=false;$('khQty').value='';}calc()};function calc(){const size=KHORKHOG[type.value];const w=size?num($('khQty').value)*size:num($('packWeight').value);$('packTotal').textContent=fmt(w)+' кг'}$('khQty').oninput=calc;$('packWeight').oninput=calc;f.onsubmit=async e=>{e.preventDefault();await createProduct(new FormData(f))};
 if(!isOnline())$('view').insertAdjacentHTML('afterbegin','<div class="warn">⚠️ Баглаа боодол нь online-only хэсэг.</div>');
}
async function createProduct(fd){
 const mid=String(fd.get('material_id')),w=num(fd.get('weight'));const m=cache.materials.find(x=>x.id===mid);if(!m||w<=0)return toast('Материал/жин буруу');if(w>num(m.current_available)+.0001)return toast('Үлдэгдлээс их байна');
 try{const productId=uuid();const srcAnimal=cache.animals.find(a=>a.id===m.animal_id);const productCode=`${srcAnimal?.animal_code||m.animal_id.slice(0,8)}-P${productId.slice(0,6).toUpperCase()}`;await rpc('create_product',{p_product_id:productId,p_product_code:productCode,p_material_id:mid,p_weight_kg:w,p_product_type:String(fd.get('product_type')),p_packaging_date:String(fd.get('date')),p_packaging_cost:num(fd.get('cost')),p_note:fd.get('note')||null,p_qty:KHORKHOG[fd.get('product_type')]?num($('khQty').value):1,p_unit:KHORKHOG[fd.get('product_type')]?'ширхэг':'кг',p_unit_weight_kg:KHORKHOG[fd.get('product_type')]||null,p_user_id:session.user.id});await pullData();toast('Бүтээгдэхүүн хадгалагдлаа');renderPackaging()}catch(err){toast('Алдаа: '+err.message)}
}

function renderSales(){
 const ps=cache.products.filter(p=>num(p.current_available)>0);
 $('view').innerHTML=formCard(`<form id="saleForm"><label>Бүтээгдэхүүн</label><select name="product_id" id="saleProduct" required>${ps.map(p=>`<option value="${p.id}">${esc(p.product_code)} · ${esc(p.product_type)} · ${fmt(p.current_available)} ${esc(p.unit)}</option>`).join('')||'<option value="">Зарах бүтээгдэхүүн алга</option>'}</select><div class="helper" id="saleRemain"></div><label>Тоо хэмжээ</label><input name="qty" id="saleQty" type="number" min="0.1" step="0.1" required><label>Нэгжийн үнэ (₮)</label><input name="price" type="number" min="0" step="1" required><div class="calc-box"><span>Нийт дүн:</span><b id="saleTotal">0 ₮</b></div><label>Огноо</label><input name="date" type="date" value="${today()}" required><label>Хэрэглэгч (заавал биш)</label><input name="customer"><label>Утас (заавал биш)</label><input name="customer_phone"><button class="btn-primary">Хадгалах</button></form>`);
 const f=$('saleForm');function c(){const p=cache.products.find(x=>x.id===f.product_id.value);$('saleRemain').textContent=p?`Үлдэгдэл: ${fmt(p.current_available)} ${p.unit}`:'';$('saleQty').max=p?.current_available||'';$('saleTotal').textContent=fmt(num(f.qty.value)*num(f.price.value),0)+' ₮'}f.oninput=c;f.onchange=c;f.onsubmit=async e=>{e.preventDefault();const p=cache.products.find(x=>x.id===f.product_id.value);if(!p)return;const q=num(f.qty.value);if(q>num(p.current_available)+.0001)return toast('Үлдэгдлээс их байна');try{await rpc('create_sale',{p_sale_id:uuid(),p_product_id:p.id,p_qty:q,p_unit_price:num(f.price.value),p_sale_date:String(f.date.value),p_customer:String(f.customer.value||''),p_customer_phone:String(f.customer_phone.value||''),p_user_id:session.user.id});await pullData();toast('Борлуулалт хадгалагдлаа');renderSales()}catch(err){toast('Алдаа: '+err.message)}};c();
}

function renderInventory(){
 const mats=cache.materials.filter(m=>num(m.current_available)>0);const ps=cache.products.filter(p=>num(p.current_available)>0);$('view').innerHTML=`<div class="card"><h3 style="margin-top:0">Материал</h3>${mats.length?`<table><tr><th>Амьтан</th><th>Төрөл</th><th>Байршил</th><th>Үлдэгдэл</th></tr>${mats.map(m=>`<tr><td>${esc(m.animal_code||m.animal_id?.slice(0,8))}</td><td>${esc(m.material_type==='MEAT'?'Мах':'Дайвар')}</td><td>${esc(m.location_type||'')}</td><td><b>${fmt(m.current_available)} кг</b></td></tr>`).join('')}</table>`:'<div class="empty">Материалын үлдэгдэл алга</div>'}</div><div class="card"><h3 style="margin-top:0">Бүтээгдэхүүн</h3>${ps.length?`<table><tr><th>Код</th><th>Төрөл</th><th>Амьтан</th><th>Үлдэгдэл</th><th></th></tr>${ps.map(p=>`<tr><td>${esc(p.product_code)}</td><td>${esc(p.product_type)}</td><td>${esc(p.animal_code||p.animal_id?.slice(0,8))}</td><td><b>${fmt(p.current_available)} ${esc(p.unit)}</b></td><td><button class="btn-ghost" onclick="showQR('${esc(p.product_code)}')">QR</button></td></tr>`).join('')}</table>`:'<div class="empty">Бүтээгдэхүүний үлдэгдэл алга</div>'}</div>`;
}
function renderDashboard(){
 const purchased=cache.animals.filter(a=>a.purchase_date).length;const meat=cache.materials.filter(m=>m.material_type==='MEAT'&&m.source_processing_id).reduce((s,m)=>s+num(m.original_quantity_kg),0);const byp=cache.materials.filter(m=>m.material_type==='BYPRODUCT'&&m.source_processing_id).reduce((s,m)=>s+num(m.original_quantity_kg),0);const revenue=cache.sales.reduce((s,x)=>s+num(x.total_amount),0);const costs=cache.animals.reduce((s,x)=>s+num(x.total_cost),0)+cache.processing_events.reduce((s,x)=>s+num(x.processing_cost),0)+cache.transports.reduce((s,x)=>s+num(x.cost),0)+cache.products.reduce((s,x)=>s+num(x.packaging_cost),0);$('view').innerHTML=`<div class="stat-grid"><div class="stat"><div class="n">${fmt(purchased,0)}</div><div class="l">Худалдан авсан амьтан</div></div><div class="stat"><div class="n">${fmt(meat)}</div><div class="l">Махны гарц, кг</div></div><div class="stat"><div class="n">${fmt(byp)}</div><div class="l">Дайвар, кг</div></div><div class="stat"><div class="n">${fmt(revenue,0)}₮</div><div class="l">Борлуулалт</div></div><div class="stat"><div class="n">${fmt(costs,0)}₮</div><div class="l">Бүртгэгдсэн зардал</div></div><div class="stat"><div class="n">${fmt(revenue-costs,0)}₮</div><div class="l">Энгийн зөрүү</div></div></div><div class="card"><b>Мэдээллийн төлөв</b><div class="helper">Тооцоолол нь одоогийн бүртгэл дээр тулгуурлана. Санхүүгийн бүрэн нягтлан бодох бүртгэл биш.</div></div>`;
}
function renderHistory(){const logs=cache.audit_logs.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));$('view').innerHTML=formCard(logs.length?logs.slice(0,150).map(x=>`<div class="list-item"><div class="top-row"><b>${esc(x.action)}</b><span class="date">${new Date(x.created_at).toLocaleString('mn-MN')}</span></div><div class="details">${esc(x.entity_type)} · ${esc(x.entity_id?.slice(0,8)||'')} · ${esc(x.user_label||x.user_id?.slice(0,8)||'')}</div>${x.old_data||x.new_data?`<div class="helper">${esc(JSON.stringify(x.old_data||{}))} → ${esc(JSON.stringify(x.new_data||{}))}</div>`:''}</div>`).join(''):'<div class="empty"><div class="big">🧾</div>Түүх алга</div>')}

async function upsertDirect(table,row){const r=await supa().from(table).upsert(row,{onConflict:'id'}).select().single();if(r.error)throw r.error;await saveLocalRecord(table,r.data,'synced');return r.data}
async function rpc(fn,args){const r=await supa().rpc(fn,args);if(r.error)throw r.error;return r.data}
async function pullTable(table){const remote=REMOTE_VIEWS[table]||table;const r=await supa().from(remote).select('*');if(r.error)throw r.error;cache[table]=r.data||[];for(const row of cache[table])await saveLocalRecord(table,row,'synced')}
async function pullData(){if(!isOnline())return;for(const t of TABLES.filter(x=>x!=='audit_logs'))await pullTable(t);try{await pullTable('audit_logs')}catch(_){}settings.lastSync=new Date().toISOString();await saveSettings();await loadLocal()}
async function syncNow(){if(syncing||!isOnline()||!supa())return;syncing=true;try{
  const events=(await idbGetAll('outbox')).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const order={herder_create:1,animal_create:2,processing_create:3,transport_create:4};
  events.sort((a,b)=>(order[a.type]||99)-(order[b.type]||99)||new Date(a.created_at)-new Date(b.created_at));
  for(const ev of events){try{ev.status='syncing';ev.attempts++;await idbPut('outbox',ev);if(ev.type==='herder_create'){await upsertDirect('herders',ev.payload)}else if(ev.type==='animal_create'){await upsertDirect('animals',ev.payload);}else if(ev.type==='processing_create')await rpc('create_processing_bundle',{p_payload:ev.payload});else if(ev.type==='transport_create')await rpc('create_transport_bundle',{p_payload:ev.payload});else throw new Error('Unknown outbox event '+ev.type);await removeOutbox(ev.event_id)}catch(err){ev.status='failed';ev.error=err.message;await idbPut('outbox',ev)}}
  const failed=(await idbGetAll('outbox')).filter(x=>x.status==='failed').length;if(failed)toast(`${failed} бичлэг синк хийгдээгүй үлдлээ`);else if(events.length)toast('Синк амжилттай');settings.lastSync=new Date().toISOString();await saveSettings();await pullData();
 }finally{syncing=false}}
async function refreshAll(){await loadLocal();const active=location.hash.slice(1);if(active)navigate(active);else renderHome()}

function showQR(code){
 const url=new URL('./public.html',location.href);url.searchParams.set('code',code);
 const root=document.getElementById('modal-root');root.innerHTML=`<div class="modal-back"><div class="modal"><div class="modal-head"><b>QR — ${esc(code)}</b><button class="x" onclick="document.getElementById('modal-root').innerHTML=''">×</button></div><div id="qrBox" style="text-align:center;padding:18px"></div><div class="helper" style="word-break:break-all">${esc(url.href)}</div><div class="actions" style="margin-top:14px"><button class="btn-secondary" onclick="window.open('${url.href.replace(/'/g,"%27")}','_blank')">Нийтийн хуудас нээх</button><button class="btn-secondary" onclick="window.print()">Хэвлэх</button></div></div></div>`;
 if(window.QRCode){QRCode.toCanvas(document.getElementById('qrBox'),url.href,{width:220,margin:2},()=>{});}
}
window.showQR=showQR;
window.navigate=navigate;window.renderHome=renderHome;window.syncNow=syncNow;window.refreshAll=refreshAll;
async function boot(){idb=await openIDB();await loadLocal();const ok=await ensureAuth();if(!ok)return;shell();await pullData().catch(()=>{});renderHome();if(isOnline())syncNow().then(refreshAll)}
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').then(reg=>{console.log('[sw] registered',reg.scope)}).catch(err=>{console.error('[sw] registration FAILED:',err)}));
boot().catch(err=>renderError('Апп эхлүүлэхэд алдаа гарлаа',err.message));
})();
