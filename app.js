/* Asset Manager - plain JavaScript, no build step. Talks to Supabase.
   Built for about 100,000 assets: lists are paged, totals are calculated in the database,
   and a scan fetches only the one asset it needs. */
const CFG = window.APP_CONFIG;
const view = document.getElementById('view');
const $ = (s, el = document) => el.querySelector(s);
const S = { profile: null, props: [], rooms: [], types: null, printPre: null };
let sb = null;
const LABEL_TITLE = (CFG && CFG.LABEL_TITLE) || 'CLSPL Asset';
document.documentElement.style.setProperty('--lbl', ((window.APP_CONFIG && Number(window.APP_CONFIG.LABEL_MM)) || 50) + 'mm');
const PAGE = 50;        // rows per page in the asset list
const LABEL_MM = (window.APP_CONFIG && Number(window.APP_CONFIG.LABEL_MM)) || 50; // label size in mm
const LABELS_PER = 90;  // labels per print batch (6 A4 sheets of 15)
const CHUNK = 500;      // rows per request when creating many assets

const TABS = {
  procurement: [['summary', 'Summary'], ['assets', 'Assets'], ['print', 'Print QR'], ['import', 'Import'], ['scan', 'Scan'], ['audit', 'To audit'], ['report', 'Report'], ['users', 'Users']],
  projects: [['summary', 'Summary'], ['assets', 'Assets'], ['print', 'Print QR'], ['import', 'Import'], ['scan', 'Scan'], ['audit', 'To audit'], ['report', 'Report']],
  auditor: [['scan', 'Scan'], ['audit', 'To audit'], ['report', 'Report'], ['assets', 'Assets'], ['summary', 'Summary']]
};
const ROLE_LABEL = { pending: 'Waiting for approval', procurement: 'Procurement', projects: 'Projects team', auditor: 'Auditor' };
const STATUSES = ['working', 'repairable', 'damaged'];

/* ---------- small helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tagOf = a => 'AST-' + String(a.tag_no).padStart(5, '0');
const money = n => (n == null || n === '') ? '-' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const can = (...roles) => roles.includes(S.profile && S.profile.role);
const canEdit = () => can('procurement', 'projects');
const propById = id => S.props.find(p => p.id === id);
const roomById = id => S.rooms.find(r => r.id === id);
const propName = id => !id ? 'Unassigned' : ((propById(id) || {}).name || '-');
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const badge = st => st ? `<span class="badge ${esc(st)}">${esc(cap(st))}</span>` : '<span class="badge unassigned">Unassigned</span>';
const today = () => new Date().toISOString().slice(0, 10);

function roomLabel(a) {
  if (a.in_store) { const p = propById(a.property_id); return 'Store' + (p && p.store_location ? ' (' + p.store_location + ')' : ''); }
  const r = roomById(a.room_id); return r ? r.name : '-';
}
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 4000);
}
const fail = e => { console.error(e); toast((e && e.message) || String(e), true); };
const go = h => { location.hash = h; };
const warrantyText = a => {
  if (!a.warranty_until) return '-';
  return a.warranty_until < today() ? a.warranty_until + ' (expired)' : a.warranty_until;
};

function getPos(timeout = 8000) {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';

/* resize a photo to max 1024px JPEG so it uses little free storage */
function compress(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('Photo could not be read')); }, 'image/jpeg', 0.75);
    };
    img.onerror = () => reject(new Error('Photo could not be read'));
    img.src = url;
  });
}

/* ---------- data loading (only properties, rooms and item types are kept in memory) ---------- */
async function fetchAll(table, order) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) return out;
    from += 1000;
  }
}
async function loadMaster() {
  S.props = await fetchAll('properties', 'name');
  S.rooms = await fetchAll('rooms', 'name');
}
async function loadTypes() {
  const { data, error } = await sb.rpc('item_types');
  if (error) throw error;
  S.types = data || [];
}
async function getAsset(id) {
  const { data, error } = await sb.from('assets').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------- auth and boot ---------- */
async function boot() {
  if (!CFG || String(CFG.SUPABASE_URL).startsWith('PASTE')) {
    view.innerHTML = '<div class="card"><h2>Setup needed</h2><p>Open <b>config.js</b> and paste your Supabase URL and anon key. See SETUP.md.</p></div>'; return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  $('#logout').onclick = async () => { await sb.auth.signOut(); S.profile = null; showLogin(); };
  const { data: { session } } = await sb.auth.getSession();
  if (session) await afterLogin(); else showLogin();
  window.addEventListener('hashchange', route);
}

function showLogin() {
  $('#nav').innerHTML = ''; $('#who').textContent = ''; $('#logout').style.display = 'none';
  view.innerHTML = `<div class="card" style="max-width:420px;margin:30px auto">
    <h2>Sign in</h2>
    <label>Email</label><input id="em" type="email" autocomplete="username">
    <label>Password</label><input id="pw" type="password" autocomplete="current-password">
    <button class="btn" id="si">Sign in</button>
    <hr style="margin:18px 0;border:0;border-top:1px solid #ddd">
    <h3>New user? Create an account</h3>
    <label>Your name</label><input id="nm" autocomplete="name">
    <label>Email</label><input id="nem" type="email" autocomplete="off">
    <label>Choose a password (at least 6 characters)</label><input id="npw" type="password" autocomplete="new-password">
    <button class="btn sec" id="su">Create account</button>
    <p class="mute">After you create an account, Procurement must approve it and give you a role (Users tab). Until then you cannot see any data.</p></div>`;
  $('#si').onclick = async () => {
    const { error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
    if (error) return fail(error); await afterLogin();
  };
  $('#su').onclick = async () => {
    const nem = $('#nem').value.trim(), npw = $('#npw').value;
    if (!$('#nm').value.trim() || !nem || !npw) return fail(new Error('Enter your name, email and a password in the New user box'));
    const { data, error } = await sb.auth.signUp({ email: nem, password: npw, options: { data: { full_name: $('#nm').value.trim() } } });
    if (error) return fail(error);
    if (data.session) await afterLogin(); else toast('Account created. Check your email to confirm, then sign in.');
  };
}

async function afterLogin() {
  try {
    const { data: { user } } = await sb.auth.getUser();
    const { data: pf, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    if (!pf) { view.innerHTML = '<div class="card">Your profile was not created. Run schema.sql again, then sign up again.</div>'; return; }
    S.profile = pf;
    $('#who').textContent = (pf.full_name || pf.email) + ' - ' + ROLE_LABEL[pf.role];
    $('#logout').style.display = '';
    if (pf.role === 'pending') {
      $('#nav').innerHTML = '';
      view.innerHTML = '<div class="card" style="max-width:480px;margin:30px auto"><h2>Waiting for approval</h2><p>Your account is created, but you have no access yet. Ask Procurement to give you a role in the Users tab, then sign in again.</p></div>';
      return;
    }
    await loadMaster();
    $('#nav').innerHTML = TABS[pf.role].map(([k, t]) => `<button data-v="${k}">${t}</button>`).join('');
    $('#nav').onclick = e => { const b = e.target.closest('button'); if (b) go('#/' + b.dataset.v); };
    route();
  } catch (e) { fail(e); }
}

/* ---------- router ---------- */
async function stopScanner() {
  if (stopScanner.s) { try { await stopScanner.s.stop(); } catch (e) { /* already stopped */ } try { stopScanner.s.clear(); } catch (e) { /* ignore */ } stopScanner.s = null; }
}
async function route() {
  if (!S.profile || S.profile.role === 'pending') return;
  await stopScanner();
  view.onclick = null; view.onchange = null;
  const parts = (location.hash || '').split('/');
  const v = parts[1] || TABS[S.profile.role][0][0], arg = parts[2];
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  try {
    if (v === 'summary') await viewSummary();
    else if (v === 'assets') await viewAssets();
    else if (v === 'asset') await viewAsset(arg);
    else if (v === 'form') await viewForm(arg);
    else if (v === 'print') await viewPrint(arg);
    else if (v === 'import') viewImport();
    else if (v === 'scan') viewScan();
    else if (v === 'audit') await viewAudit();
    else if (v === 'report') await viewReport();
    else if (v === 'properties') go('#/assets');   // merged into the Assets tab
    else if (v === 'users' && can('procurement')) await viewUsers();
    else view.innerHTML = '<p>Page not available for your role.</p>';
  } catch (e) { fail(e); }
}

/* ---------- Summary (calculated in the database) ---------- */
async function viewSummary() {
  view.innerHTML = '<p class="mute">Calculating...</p>';
  const { data: s, error } = await sb.rpc('asset_summary');
  if (error) throw error;
  const types = s.by_item.map(x => x.item_type);
  const cell = new Map(s.matrix.map(m => [m.property_id + '|' + m.item_type, m.n]));
  const row = (name, x, aud) => `<tr><td>${esc(name)}</td><td class="num">${x.total}</td><td class="num">${x.working}</td><td class="num">${x.repairable}</td><td class="num">${x.damaged}</td>${aud ? `<td class="num">${x.audited}</td><td class="num">${x.total - x.audited}</td>` : ''}<td class="num">${money(x.cost)}</td></tr>`;
  const head = (first, aud) => `<tr><th>${first}</th><th class="num">Total</th><th class="num">Working</th><th class="num">Repairable</th><th class="num">Damaged</th>${aud ? '<th class="num">Audited</th><th class="num">Not audited</th>' : ''}<th class="num">Cost</th></tr>`;
  const matrix = s.by_property.map(p => `<tr><td>${esc(p.name)}</td>${types.map(t => `<td class="num">${cell.get(p.id + '|' + t) || ''}</td>`).join('')}<td class="num"><b>${p.total}</b></td></tr>`).join('');
  const matrixU = s.unassigned.total ? `<tr><td><i>Unassigned</i></td>${types.map(t => `<td class="num">${cell.get('null|' + t) || ''}</td>`).join('')}<td class="num"><b>${s.unassigned.total}</b></td></tr>` : '';
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${s.total}</b><span>Total assets</span></div>
      <div class="stat"><b>${s.unassigned.total}</b><span>Unassigned (not placed yet)</span></div>
      <div class="stat"><b>${s.working}</b><span>Working</span></div>
      <div class="stat"><b>${s.repairable}</b><span>Repairable</span></div>
      <div class="stat"><b>${s.damaged}</b><span>Damaged</span></div>
      <div class="stat"><b>${s.audited}</b><span>Audited at least once</span></div>
      <div class="stat"><b>${s.total - s.unassigned.total - s.audited}</b><span>Placed but never audited</span></div>
      <div class="stat"><b>${money(s.cost)}</b><span>Total purchase cost</span></div>
      <div class="stat"><b>${s.warranty_90}</b><span>Warranty ends in 90 days</span></div>
    </div>
    <div class="card"><h2>Property-wise</h2><div class="tw"><table>${head('Property', true)}${s.by_property.map(p => row(p.name, p, true)).join('') || '<tr><td>No properties yet</td></tr>'}${s.unassigned.total ? `<tr><td><i>Unassigned</i></td><td class="num">${s.unassigned.total}</td><td></td><td></td><td></td><td></td><td></td><td class="num">${money(s.unassigned.cost)}</td></tr>` : ''}</table></div></div>
    <div class="card"><h2>Item-wise</h2><div class="tw"><table>${head('Item')}${s.by_item.map(i => row(i.item_type, i)).join('') || '<tr><td>No assets yet</td></tr>'}</table></div></div>
    <div class="card"><h2>Property x Item (count)</h2><div class="tw"><table><tr><th>Property</th>${types.map(t => `<th class="num">${esc(t)}</th>`).join('')}<th class="num">Total</th></tr>${matrix}${matrixU}</table></div></div>`;
}

/* ---------- Asset list (paged, filtered in the database) + bulk assign ---------- */
const L = { page: 0, q: '', fp: '', ft: '', fs: '', fa: '', fd: '', fr: '', frn: '' };   // fr: room id or 'STORE' (set from the To audit tab)   // fa: '' | yes | no | before (with date fd)
const auditArgs = () => (L.fa === 'yes' || L.fa === 'no') ? { audit: L.fa, before: null } : (L.fa === 'before' && /^\d{4}-\d{2}-\d{2}$/.test(L.fd) ? { audit: 'before', before: L.fd } : { audit: null, before: null });
const SEL = new Set();   // ticked unassigned assets (bulk assign)
const BULK_CHUNK = 2000; // assets per request when bulk assigning
const searchText = () => { const t = L.q.trim(); return /^(?:ast-?)?0*\d+$/i.test(t) ? '' : t.replace(/[,()%*]/g, ' ').trim(); };
function applyFilters(q) {
  if (L.fp === '__none') q = q.is('property_id', null); else if (L.fp) q = q.eq('property_id', L.fp);
  if (L.ft) q = q.eq('item_type', L.ft);
  if (L.fs) q = q.eq('status', L.fs);
  if (L.fr === 'STORE') q = q.eq('in_store', true); else if (L.fr) q = q.eq('room_id', L.fr);
  const au = auditArgs();
  if (au.audit === 'yes') q = q.not('last_audited_at', 'is', null);
  else if (au.audit === 'no') q = q.is('last_audited_at', null);
  else if (au.audit === 'before') q = q.or(`last_audited_at.is.null,last_audited_at.lt.${au.before}`);
  const t = L.q.trim();
  if (t) {
    const n = t.match(/^(?:ast-?)?0*(\d+)$/i);
    if (n) q = q.eq('tag_no', Number(n[1]));
    else { const w = searchText(); if (w) q = q.or(`item_type.ilike.%${w}%,name.ilike.%${w}%,description.ilike.%${w}%,vendor.ilike.%${w}%`); }
  }
  return q;
}
/* counts the unassigned assets that bulk assign would use: Unassigned + Item filter + text search */
function bulkQuery() {
  let q = sb.from('assets').select('id', { count: 'exact', head: true }).is('property_id', null);
  if (L.ft) q = q.eq('item_type', L.ft);
  const w = searchText(); if (w) q = q.or(`item_type.ilike.%${w}%,name.ilike.%${w}%,description.ilike.%${w}%,vendor.ilike.%${w}%`);
  return q;
}
const naturalRooms = pid => S.rooms.filter(r => r.property_id === pid).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

async function viewAssets() {
  if (!S.types) await loadTypes();
  const bulkOn = () => L.fp === '__none' && canEdit();
  const canDel = can('procurement');
  view.innerHTML = `<div class="card">
    <h2>Assets ${canEdit() ? '<button class="btn" id="add" style="float:right;margin:0">+ Add asset</button>' : ''}</h2>
    <label>Property</label><div id="pchips" class="chips"><span class="mute">Loading...</span></div>
    <div id="rchips" class="chips"></div>
    <div class="row">
      <div><label>Search</label><input id="q" value="${esc(L.q)}" placeholder="tag no., item, description, vendor"></div>
      <div><label>Item</label><select id="ft"><option value="">All</option>${S.types.map(t => `<option ${t === L.ft ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div><label>Status</label><select id="fs"><option value="">All</option>${STATUSES.map(s => `<option value="${s}" ${s === L.fs ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></div>
      <div><label>Audit</label><select id="fa"><option value="">All</option><option value="yes" ${L.fa === 'yes' ? 'selected' : ''}>Audited at least once</option><option value="no" ${L.fa === 'no' ? 'selected' : ''}>Never audited</option><option value="before" ${L.fa === 'before' ? 'selected' : ''}>Not audited since...</option></select></div>
      <div id="fdbox" style="${L.fa === 'before' ? '' : 'display:none'}"><label>Date</label><input id="fd" type="date" value="${esc(L.fd)}"></div>
    </div></div>
    <div id="psettings"></div>
    <div id="bulkbox"></div>
    <div id="delbox"></div>
    <div class="card">
    <p class="mute" id="count"></p>
    ${canEdit() && L.fp && L.fp !== '__none' ? '<button class="btn sec" id="lprint">Print labels for these</button>' : ''}
    <div class="tw"><table><thead id="thead"></thead><tbody id="rows"></tbody></table></div>
    <button class="btn sec" id="prev">Previous</button><button class="btn sec" id="next">Next</button></div>`;
  if ($('#add')) $('#add').onclick = () => go('#/form');

  const draw = async () => {
    const sel = bulkOn() || canDel;
    const from = L.page * PAGE;
    const { data, count, error } = await applyFilters(sb.from('assets').select('*', { count: 'exact' })).order('tag_no').range(from, from + PAGE - 1);
    if (error) return fail(error);
    $('#thead').innerHTML = `<tr>${sel ? '<th><input type="checkbox" id="selall" title="Tick all on this page"></th>' : ''}<th>Tag</th><th>Item</th><th>Size</th><th>Description</th><th>Property</th><th>Room</th><th>Status</th><th>Last audited</th><th>Warranty</th></tr>`;
    $('#count').textContent = count === 0 ? 'No assets match.' : `Showing ${from + 1}-${from + data.length} of ${count}`;
    $('#rows').innerHTML = data.map(a => `<tr class="click" data-id="${a.id}">${sel ? `<td><input type="checkbox" class="sel" data-id="${a.id}" ${SEL.has(a.id) ? 'checked' : ''}></td>` : ''}<td>${tagOf(a)}</td><td>${esc(a.item_type)}${a.name ? '<br><span class="mute">' + esc(a.name) + '</span>' : ''}</td><td>${esc(a.size)}</td><td>${esc(a.description)}</td><td>${esc(propName(a.property_id))}</td><td>${esc(roomLabel(a))}</td><td>${badge(a.status)}</td><td>${a.last_audited_at ? esc(new Date(a.last_audited_at).toLocaleDateString()) : '<span class="mute">-</span>'}</td><td>${esc(warrantyText(a))}</td></tr>`).join('');
    $('#prev').disabled = L.page === 0; $('#next').disabled = from + data.length >= count;
    if ($('#selall')) $('#selall').onchange = () => {
      document.querySelectorAll('#rows input.sel').forEach(c => { c.checked = $('#selall').checked; if (c.checked) SEL.add(c.dataset.id); else SEL.delete(c.dataset.id); });
      updateSelNote(); updateDelNote();
    };
  };

  /* ----- bulk assign panel (only while the Unassigned filter is on) ----- */
  const updateSelNote = () => {
    if (!$('#bsel')) return;
    $('#bsel').textContent = SEL.size ? `${SEL.size} row(s) are ticked in the list below. Only those will be assigned (the "How many" box is ignored).` : 'Nothing ticked: the first N matching assets (lowest tag numbers) are assigned. You can also tick rows in the list below.';
  };
  const updateBulkInfo = async () => {
    if (!$('#bm')) return;
    const { count, error } = await bulkQuery(); if (error) return;
    $('#bm').textContent = `${count} unassigned asset(s) match the Item and Search filters.` + (L.ft ? '' : ' Tip: choose an Item above (for example Chair) so only that item is assigned.');
  };
  const fillBulkPlaces = () => {
    const p = $('#bp').value;
    $('#br').innerHTML = p ? '<option value="">Choose room...</option><option value="STORE">Store</option>' + naturalRooms(p).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('') : '<option value="">Choose a property first</option>';
    $('#brooms').innerHTML = p
      ? naturalRooms(p).map(r => `<label class="chk"><input type="checkbox" class="rm" value="${r.id}" checked> ${esc(r.name)}</label>`).join('') + '<label class="chk"><input type="checkbox" id="bstore"> Store</label>'
      : '<span class="mute">Choose a property first</span>';
  };
  const renderBulk = () => {
    const box = $('#bulkbox');
    if (!bulkOn()) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card"><h2>Bulk assign</h2>
      <p id="bm" class="mute"></p>
      <label class="chk"><input type="radio" name="bmode" value="one" checked> Put them all in one place</label>
      <label class="chk"><input type="radio" name="bmode" value="spread"> Spread across rooms: the same number in each room that stays ticked</label>
      <div class="row">
        <div><label>Property *</label><select id="bp"><option value="">Choose property...</option>${S.props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div><label>Status *</label><select id="bs"><option value="">Choose status...</option>${STATUSES.map(s => `<option value="${s}">${cap(s)}</option>`).join('')}</select></div>
        <div><label>Note (optional)</label><input id="bnote"></div>
      </div>
      <div id="bone"><div class="row">
        <div><label>Room / area *</label><select id="br"><option value="">Choose a property first</option></select></div>
        <div><label>How many (blank = all matching)</label><input id="bq" type="number" min="1" placeholder="e.g. 100"></div></div>
        <p id="bsel" class="mute"></p></div>
      <div id="bspread" style="display:none">
        <div class="row"><div><label>Items per room *</label><input id="bk" type="number" min="1" value="2"></div></div>
        <label>Rooms that get items (untick the rooms to leave out; Store is only used if you tick it)</label>
        <p><a href="#" id="rall">Tick all rooms</a> &nbsp; <a href="#" id="rnone">Untick all</a></p>
        <div id="brooms" class="roomlist"><span class="mute">Choose a property first</span></div>
        <p class="mute">The Item filter above must be set (for example Chair). If there are not enough assets for every ticked room, nothing is assigned.</p>
      </div>
      <button class="btn" id="bgo">Assign</button>
      <div id="bres" style="margin-top:10px"></div></div>`;
    document.querySelectorAll('input[name=bmode]').forEach(r => { r.onchange = () => { const sp = document.querySelector('input[name=bmode]:checked').value === 'spread'; $('#bone').style.display = sp ? 'none' : ''; $('#bspread').style.display = sp ? '' : 'none'; }; });
    $('#bp').onchange = fillBulkPlaces;
    $('#rall').onclick = e => { e.preventDefault(); document.querySelectorAll('#brooms input.rm').forEach(c => { c.checked = true; }); };
    $('#rnone').onclick = e => { e.preventDefault(); document.querySelectorAll('#brooms input').forEach(c => { c.checked = false; }); };
    $('#bgo').onclick = runBulk;
    updateSelNote(); updateBulkInfo();
  };

  const runBulk = async () => {
    const mode = document.querySelector('input[name=bmode]:checked').value;
    const prop = $('#bp').value, st = $('#bs').value, note = $('#bnote').value.trim() || null;
    if (!prop || !st) return fail(new Error('Choose a property and a status'));
    const search = searchText() || null, item = L.ft || null, btn = $('#bgo');
    let ids = [];
    try {
      if (mode === 'one') {
        const r = $('#br').value; if (!r) return fail(new Error('Choose a room (or Store)'));
        const toStore = r === 'STORE', room = toStore ? null : r;
        const where = propName(prop) + ' / ' + (toStore ? 'Store' : roomById(room).name);
        if (SEL.size) {
          const picked = [...SEL];
          if (!confirm(`Assign the ${picked.length} ticked asset(s) to ${where} as ${st}?`)) return;
          btn.disabled = true;
          for (let i = 0; i < picked.length; i += BULK_CHUNK) {
            btn.textContent = `Assigning ${i} of ${picked.length}...`;
            const { data, error } = await sb.rpc('assign_bulk', { p_ids: picked.slice(i, i + BULK_CHUNK), p_item_type: null, p_search: null, p_qty: null, p_property: prop, p_room: room, p_to_store: toStore, p_status: st, p_note: note });
            if (error) throw error;
            ids = ids.concat(data || []);
          }
        } else {
          const { count, error: ce } = await bulkQuery(); if (ce) throw ce;
          const want = $('#bq').value ? Math.floor(Number($('#bq').value)) : count;
          const qty = Math.min(want, count);
          if (!(qty >= 1)) return fail(new Error('No unassigned assets match, or the quantity is not valid'));
          if (!confirm(`Assign ${qty} ${item || 'unassigned asset(s)'} (of ${count} matching) to ${where} as ${st}?`)) return;
          btn.disabled = true;
          let left = qty;
          while (left > 0) {
            const n = Math.min(left, BULK_CHUNK);
            btn.textContent = `Assigning ${ids.length} of ${qty}...`;
            const { data, error } = await sb.rpc('assign_bulk', { p_ids: null, p_item_type: item, p_search: search, p_qty: n, p_property: prop, p_room: room, p_to_store: toStore, p_status: st, p_note: note });
            if (error) throw error;
            const got = (data || []).length; ids = ids.concat(data || []); left -= got;
            if (got < n) break;
          }
        }
      } else {
        const per = Math.floor(Number($('#bk').value));
        const rooms = [...document.querySelectorAll('#brooms input.rm:checked')].map(c => c.value);
        const incStore = !!($('#bstore') && $('#bstore').checked);
        if (!item) return fail(new Error('Choose an Item in the filters above (for example Chair) so only that item is spread'));
        if (!(per >= 1)) return fail(new Error('Items per room must be 1 or more'));
        if (!rooms.length && !incStore) return fail(new Error('Tick at least one room'));
        const places = rooms.length + (incStore ? 1 : 0), need = per * places;
        const { count, error: ce } = await bulkQuery(); if (ce) throw ce;
        if (count < need) return fail(new Error(`Only ${count} unassigned ${item} are available, but ${need} are needed (${per} per place x ${places} places).`));
        const left = naturalRooms(prop).filter(r => !rooms.includes(r.id)).map(r => r.name);
        if (!confirm(`Assign ${per} ${item} to each of ${places} place(s) in ${propName(prop)}: ${need} in total, as ${st}.\n${left.length ? 'Rooms left out: ' + left.join(', ') + '.\n' : ''}${count - need} ${item} will stay unassigned.\n\nContinue?`)) return;
        btn.disabled = true; btn.textContent = 'Assigning...';
        const { data, error } = await sb.rpc('assign_spread', { p_item_type: item, p_search: search, p_per_room: per, p_property: prop, p_rooms: rooms, p_include_store: incStore, p_status: st, p_note: note });
        if (error) throw error;
        ids = data || [];
      }
      SEL.clear();
      btn.disabled = false; btn.textContent = 'Assign';
      $('#bres').innerHTML = `<p><b>${ids.length} asset(s) assigned.</b></p><button class="btn" id="bpr">Print labels for these</button>`;
      $('#bpr').onclick = () => { S.printPre = { ids }; go('#/print'); };
      updateSelNote(); updateBulkInfo(); draw();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Assign';
      fail(ids.length ? new Error(`Stopped after ${ids.length} asset(s) were assigned: ${e.message || e}. Check the list before running again.`) : e);
      if (ids.length) { updateBulkInfo(); draw(); }
    }
  };

  /* ----- bulk delete (Procurement only) ----- */
  const delFilterActive = () => !!(L.fp || L.ft || L.fs || L.q.trim() || auditArgs().audit);
  const delArgs = ids => {
    const t = L.q.trim(), n = t.match(/^(?:ast-?)?0*(\d+)$/i), au = auditArgs();
    return { p_ids: ids || null, p_property: ids ? null : (L.fp && L.fp !== '__none' ? L.fp : null), p_unassigned: ids ? false : L.fp === '__none',
      p_item_type: ids ? null : (L.ft || null), p_status: ids ? null : (L.fs || null), p_search: ids ? null : (n ? null : (searchText() || null)),
      p_tag: ids ? null : (n ? Number(n[1]) : null), p_audit: ids ? null : au.audit, p_before: ids ? null : au.before, p_limit: BULK_CHUNK };
  };
  const updateDelNote = async () => {
    if (!$('#dn')) return;
    if (SEL.size) { $('#dn').textContent = `${SEL.size} ticked asset(s) will be deleted.`; $('#dgo').disabled = false; return; }
    if (L.fr) { $('#dn').textContent = 'A room filter is on. Tick the rows to delete, or clear the room filter first.'; $('#dgo').disabled = true; return; }
    if (!delFilterActive()) { $('#dn').textContent = 'Tick rows in the list, or choose at least one filter above. Then every asset matching the filters is deleted.'; $('#dgo').disabled = true; return; }
    const { count, error } = await applyFilters(sb.from('assets').select('id', { count: 'exact', head: true }));
    if (error || !$('#dn')) return;
    $('#dn').textContent = `Nothing ticked: all ${count} asset(s) matching the current filters will be deleted.`; $('#dgo').disabled = !count;
  };
  const renderDel = () => {
    const box = $('#delbox');
    if (!canDel) { box.innerHTML = ''; return; }
    box.innerHTML = `<details class="card"><summary><b>Bulk delete (Procurement only)</b></summary>
      <p class="mute">Permanently deletes the assets and their history. This cannot be undone.</p>
      <p id="dn" class="mute"></p>
      <button class="btn red" id="dgo">Delete</button><div id="dres" style="margin-top:10px"></div></details>`;
    $('#dgo').onclick = runDelete;
    updateDelNote();
  };
  const runDelete = async () => {
    const btn = $('#dgo');
    try {
      let total, ids = null;
      if (SEL.size) { ids = [...SEL]; total = ids.length; }
      else {
        if (L.fr) return fail(new Error('A room filter is on. Tick the rows to delete, or clear the room filter first.'));
        if (!delFilterActive()) return fail(new Error('Tick rows or choose a filter first'));
        const { count, error } = await applyFilters(sb.from('assets').select('id', { count: 'exact', head: true })); if (error) throw error;
        total = count;
      }
      if (!total) return fail(new Error('Nothing to delete'));
      const what = ids ? `${total} ticked asset(s)` : `${total} asset(s) matching the current filters`;
      if (total > 20) {
        const w = prompt(`This will permanently delete ${what} and their history.\n\nType DELETE to confirm.`);
        if (w !== 'DELETE') return;
      } else if (!confirm(`Permanently delete ${what} and their history?`)) return;
      btn.disabled = true;
      let done = 0;
      try {
        if (ids) {
          for (let i = 0; i < ids.length; i += BULK_CHUNK) {
            btn.textContent = `Deleting ${done} of ${total}...`;
            const { data, error } = await sb.rpc('delete_assets', delArgs(ids.slice(i, i + BULK_CHUNK)));
            if (error) throw error; done += data || 0;
          }
        } else {
          while (done < total) {
            btn.textContent = `Deleting ${done} of ${total}...`;
            const { data, error } = await sb.rpc('delete_assets', delArgs(null));
            if (error) throw error; if (!data) break; done += data;
          }
        }
      } catch (e) { throw new Error(done ? `Stopped after ${done} asset(s) were deleted: ${e.message || e}` : (e.message || e)); }
      SEL.clear(); S.types = null; toast(`${done} asset(s) deleted`);
      viewAssets();
    } catch (e) { btn.disabled = false; btn.textContent = 'Delete'; fail(e); if ($('#dn')) { draw(); updateDelNote(); } }
  };

  let timer;
  const changed = () => { SEL.clear(); L.page = 0; updateSelNote(); updateDelNote(); draw(); updateBulkInfo(); };
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { L.q = $('#q').value; changed(); }, 350); };
  $('#fa').onchange = () => { L.fa = $('#fa').value; $('#fdbox').style.display = L.fa === 'before' ? '' : 'none'; if (L.fa === 'before' && !L.fd) { L.fd = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10); $('#fd').value = L.fd; } changed(); };
  $('#fd').onchange = () => { L.fd = $('#fd').value; changed(); };
  ['ft', 'fs'].forEach(i => { $('#' + i).onchange = () => { L[i] = $('#' + i).value; changed(); }; });
  $('#prev').onclick = () => { L.page--; draw(); }; $('#next').onclick = () => { L.page++; draw(); };
  $('#rows').onclick = e => {
    const cb = e.target.closest('input.sel');
    if (cb) { if (cb.checked) SEL.add(cb.dataset.id); else SEL.delete(cb.dataset.id); updateSelNote(); updateDelNote(); return; }
    const tr = e.target.closest('tr[data-id]'); if (tr) go('#/asset/' + tr.dataset.id);
  };
  renderBulk(); renderDel();

  /* ----- property and room chips, property settings ----- */
  const goFilter = (fp, fr, frn) => { Object.assign(L, { fp, fr: fr || '', frn: frn || '', page: 0 }); SEL.clear(); viewAssets(); };
  const renderPlaces = async () => {
    const { data: s, error } = await sb.rpc('asset_summary'); if (error) return fail(error);
    const by = new Map(s.by_property.map(x => [x.id, x]));
    const chip = (on, attrs, label, n) => `<button class="chip ${on ? 'on' : ''}" ${attrs}>${esc(label)} <small>${n}</small></button>`;
    $('#pchips').innerHTML = chip(!L.fp, 'data-p=""', 'All', s.total)
      + S.props.map(p => chip(L.fp === p.id, `data-p="${p.id}"`, p.name, (by.get(p.id) || { total: 0 }).total)).join('')
      + (s.unassigned.total || L.fp === '__none' ? chip(L.fp === '__none', 'data-p="__none"', 'Not assigned yet', s.unassigned.total) : '');
    $('#pchips').onclick = e => { const b = e.target.closest('button[data-p]'); if (b) goFilter(b.dataset.p); };
    const real = L.fp && L.fp !== '__none' ? propById(L.fp) : null;
    if (real) {
      const { data, error: er } = await sb.rpc('audit_pending', { p_property: real.id, p_before: null }); if (er) return fail(er);
      const rows = (data || []).filter(r => !r.in_store || Number(r.total) > 0).sort((x, y) => x.in_store - y.in_store || x.room_name.localeCompare(y.room_name, undefined, { numeric: true }));
      $('#rchips').innerHTML = '<label style="width:100%">Room / area</label>' + chip(!L.fr, 'data-r=""', 'All rooms', rows.reduce((n, r) => n + Number(r.total), 0))
        + rows.map(r => chip(r.in_store ? L.fr === 'STORE' : L.fr === r.room_id, `data-r="${r.in_store ? 'STORE' : r.room_id}" data-n="${esc(r.room_name)}"`, r.room_name, r.total)).join('');
      $('#rchips').onclick = e => { const b = e.target.closest('button[data-r]'); if (b) goFilter(real.id, b.dataset.r, b.dataset.n); };
    } else $('#rchips').innerHTML = '';
    renderSettings(real);
  };
  const renderSettings = real => {
    const box = $('#psettings'), full = can('procurement');
    if (!real) {
      box.innerHTML = full && !L.fp ? `<details class="card"><summary><b>+ Add property</b></summary>${propFormHtml}</details>` : '';
      if (box.innerHTML) wirePropForm(null, () => viewAssets());
      return;
    }
    const rooms = naturalRooms(real.id);
    box.innerHTML = full || canEdit() ? `<details class="card"><summary><b>${esc(real.name)}: settings and rooms</b></summary>
      ${full ? `<p class="mute">${real.latitude != null ? 'Map pin saved' : 'No map pin yet'} &middot; audit radius ${real.audit_radius_m || 500} m</p>${propFormHtml}<hr style="margin:16px 0;border:0;border-top:1px solid #ddd">` : ''}
      ${canEdit() ? `<h3>Rooms / areas</h3><div id="rl" style="margin:8px 0">${rooms.map(r => `<span class="badge working" style="margin:2px">${esc(r.name)} <a href="#" data-dr="${r.id}" style="color:inherit">x</a></span>`).join(' ') || '<span class="mute">No rooms yet.</span>'}</div>
      <label>Add rooms (separate with commas or new lines; words like Lobby are fine)</label><textarea id="rn" placeholder="101, 102, Lobby, Gym"></textarea><button class="btn" id="ar">Add rooms</button>` : ''}</details>` : '';
    if (full) wirePropForm(real, () => viewAssets());
    if (!canEdit()) return;
    $('#rl').onclick = async e => {
      const d = e.target.closest('[data-dr]'); if (!d) return; e.preventDefault();
      if (!confirm('Delete this room? Assets in it will show no room.')) return;
      const { error } = await sb.from('rooms').delete().eq('id', d.dataset.dr); if (error) return fail(error);
      if (L.fr === d.dataset.dr) { L.fr = ''; L.frn = ''; }
      await loadMaster(); viewAssets();
    };
    $('#ar').onclick = async () => {
      try {
        const names = [...new Set($('#rn').value.split(/[,\n]/).map(x => x.trim()).filter(Boolean))];
        if (!names.length) return;
        const { error } = await sb.from('rooms').upsert(names.map(n => ({ property_id: real.id, name: n })), { onConflict: 'property_id,name', ignoreDuplicates: true });
        if (error) throw error;
        await loadMaster(); toast(names.length + ' room(s) added'); viewAssets();
      } catch (e) { fail(e); }
    };
  };
  if ($('#lprint')) $('#lprint').onclick = async () => {
    try {
      let ids = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await applyFilters(sb.from('assets').select('id')).order('tag_no').range(from, from + 999); if (error) throw error;
        ids = ids.concat(data.map(x => x.id)); if (data.length < 1000) break;
      }
      if (!ids.length) return fail(new Error('No assets match'));
      S.printPre = { ids }; go('#/print');
    } catch (e) { fail(e); }
  };
  renderPlaces();
  draw();
}

/* ---------- Asset detail: view, assign, status change, transfer ---------- */
async function viewAsset(id) {
  const a = await getAsset(id);
  if (!a) { view.innerHTML = '<div class="card">Asset not found. It may have been deleted.</div>'; return; }
  const assigned = !!a.property_id;
  const { data: mv } = await sb.from('movements').select('*').eq('asset_id', id).neq('kind', 'audit').order('done_at', { ascending: false }).limit(30);
  const { data: au } = await sb.from('movements').select('*').eq('asset_id', id).eq('kind', 'audit').order('done_at', { ascending: false }).limit(50);
  const where = (p, r, st) => !p ? 'Unassigned' : propName(p) + ' / ' + (st ? 'Store' : (roomById(r) || {}).name || '-');
  const moveText = m => m.kind === 'transfer'
    ? 'Moved: ' + where(m.from_property, m.from_room, m.from_store) + ' → ' + where(m.to_property, m.to_room, m.to_store)
    : m.kind === 'assign' ? 'Assigned to ' + where(m.to_property, m.to_room, m.to_store) + ', status ' + m.new_status
      : 'Status: ' + m.old_status + ' → ' + m.new_status;
  const hist = (mv || []).map(m => `<tr><td>${new Date(m.done_at).toLocaleString()}</td><td>${esc(m.done_by_name)}</td><td>${esc(moveText(m))}${m.note ? '<br><span class="mute">' + esc(m.note) + '</span>' : ''}</td></tr>`).join('');
  const auHist = (au || []).map(m => `<tr><td>${new Date(m.done_at).toLocaleString()}</td><td>${esc(m.done_by_name)}</td><td>Audited OK at ${esc(where(m.to_property, m.to_room, m.to_store))}, status ${esc(m.new_status)}${m.loc_verified ? ' <span class="mute">(location verified)</span>' : ' <span class="err">(location not verified)</span>'}${m.note ? '<br><span class="mute">' + esc(m.note) + '</span>' : ''}</td></tr>`).join('');

  const auditCard = `<div class="card"><h2>Audit</h2>
      <p>${a.last_audited_at ? 'Last audited <b>' + esc(new Date(a.last_audited_at).toLocaleString()) + '</b> by ' + esc(a.last_audited_by) + (a.last_audit_verified ? '' : ' <span class="err">(location not verified)</span>') : 'Never audited'}</p>
      <div id="geo" class="mute">Checking your location...</div>
      <div id="xfer"></div>
      <div class="row"><div><label>Note (optional)</label><input id="aun"></div></div>
      <button class="btn" id="aud" disabled>Audited OK</button>
      <p class="mute">Press this after you have physically checked the asset. Each press is saved in the audit history with the date, your name, and the place and status recorded at that moment.</p>
      <button class="btn sec" id="loc">Check my location again</button>
      <h3>Change status</h3>
      <div class="row"><div><label>New status</label><select id="ns">${STATUSES.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></div>
      <div><label>Note (optional)</label><input id="sn"></div></div>
      <button class="btn" id="ss">Save status</button>
      <h3>Transfer (physical location is different)</h3>
      <div class="row"><div><label>To property</label><select id="tp">${S.props.map(p => `<option value="${p.id}" ${p.id === a.property_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>To room / store</label><select id="tr"></select></div>
      <div><label>Note (optional)</label><input id="tn"></div></div>
      <button class="btn" id="tt">Transfer</button>
    </div>`;
  const assignCard = canEdit()
    ? `<div class="card"><h2>Assign this asset</h2>
      <p class="mute">This asset has been purchased but not placed yet. Choose where it goes and its condition, then assign. You can print its QR label now or later.</p>
      <div class="row">
        <div><label>Property *</label><select id="ap"><option value="">Choose property...</option>${S.props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div><label>Room / area *</label><select id="ar"></select></div>
        <div><label>Status *</label><select id="as"><option value="">Choose status...</option>${STATUSES.map(s => `<option value="${s}">${cap(s)}</option>`).join('')}</select></div>
        <div><label>Note (optional)</label><input id="an"></div>
      </div>
      <button class="btn" id="asg">Assign</button> <button class="btn sec" id="asgp">Assign and print label</button></div>`
    : '<div class="card"><h2>Not assigned yet</h2><p>This asset has not been placed in a property yet. The Projects team will assign it.</p></div>';

  view.innerHTML = `
    <div class="card">
      <h2>${tagOf(a)} - ${esc(a.name || a.item_type)} ${badge(a.status)}</h2>
      ${a.photo_url ? `<img class="photo" src="${esc(a.photo_url)}" alt="asset photo">` : ''}
      <div class="tw"><table>
        <tr><th>Item type</th><td>${esc(a.item_type)}</td></tr>
        <tr><th>Name</th><td>${esc(a.name) || '-'}</td></tr>
        <tr><th>Size</th><td>${esc(a.size) || '-'}</td></tr>
        <tr><th>Description</th><td>${esc(a.description) || '-'}</td></tr>
        <tr><th>Property</th><td>${esc(propName(a.property_id))}</td></tr>
        <tr><th>Location</th><td>${esc(roomLabel(a))}</td></tr>
        <tr><th>Purchase date</th><td>${esc(a.purchase_date) || '-'}</td></tr>
        <tr><th>Purchase cost</th><td>${money(a.purchase_cost)}</td></tr>
        <tr><th>Vendor</th><td>${esc(a.vendor) || '-'}</td></tr>
        <tr><th>Warranty until</th><td>${esc(warrantyText(a))}</td></tr>
        <tr><th>Last audited</th><td>${a.last_audited_at ? esc(new Date(a.last_audited_at).toLocaleDateString()) + ' by ' + esc(a.last_audited_by) + (a.last_audit_verified ? '' : ' (location not verified)') : '-'}</td></tr>
        <tr><th>Notes</th><td>${esc(a.notes) || '-'}</td></tr></table></div>
      ${canEdit() ? `<button class="btn sec" id="edit">Edit</button>${assigned ? '<button class="btn sec" id="prt">Print QR</button>' : ''}` : ''}
    </div>
    ${assigned ? auditCard : assignCard}
    ${assigned ? `<div class="card"><h2>Audit history</h2><div class="tw"><table>${auHist || '<tr><td class="mute">Not audited yet.</td></tr>'}</table></div></div>` : ''}
    <div class="card"><h2>History</h2><div class="tw"><table>${hist || '<tr><td class="mute">No changes recorded yet.</td></tr>'}</table></div></div>`;

  if ($('#edit')) $('#edit').onclick = () => go('#/form/' + a.id);
  if ($('#prt')) $('#prt').onclick = () => go('#/print/' + a.id);

  if (!assigned) {
    if (!canEdit()) return;
    const fillAr = () => {
      const p = $('#ap').value;
      $('#ar').innerHTML = p
        ? '<option value="">Choose room...</option><option value="STORE">Store</option>' + S.rooms.filter(r => r.property_id === p).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')
        : '<option value="">Choose a property first</option>';
    };
    $('#ap').onchange = fillAr; fillAr();
    const doAssign = async print => {
      try {
        const p = $('#ap').value, r = $('#ar').value, st = $('#as').value;
        if (!p || !r || !st) return fail(new Error('Choose a property, a room (or Store) and a status'));
        $('#asg').disabled = true; $('#asgp').disabled = true;
        const toStore = r === 'STORE';
        const { error } = await sb.rpc('assign_asset', { p_asset: a.id, p_property: p, p_room: toStore ? null : r, p_to_store: toStore, p_status: st, p_note: $('#an').value.trim() || null });
        if (error) throw error;
        if (print) { toast('Assigned. The label is ready to print.'); go('#/print/' + a.id); }
        else { toast('Assigned.'); viewAsset(a.id); }
      } catch (e) { $('#asg').disabled = false; $('#asgp').disabled = false; fail(e); }
    };
    $('#asg').onclick = () => doAssign(false);
    $('#asgp').onclick = () => doAssign(true);
    return;
  }

  const fillDest = () => {
    const p = propById($('#tp').value);
    const rooms = S.rooms.filter(r => r.property_id === $('#tp').value);
    $('#tr').innerHTML = `<option value="STORE">Store${p && p.store_location ? ' - ' + esc(p.store_location) : ''}</option>` +
      rooms.map(r => `<option value="${r.id}" ${r.id === a.room_id && !a.in_store && $('#tp').value === a.property_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    if (a.in_store && $('#tp').value === a.property_id) $('#tr').value = 'STORE';
  };
  $('#tp').onchange = fillDest; fillDest();

  /* Location check: runs when the asset opens. Audited OK is allowed only at the recorded property. */
  const runGeo = async () => {
    const geo = $('#geo'), aud = $('#aud'), xf = $('#xfer');
    aud.disabled = true; xf.innerHTML = ''; geo.className = 'mute'; geo.textContent = 'Checking your location...';
    const pos = await getPos(8000);
    if (!$('#geo')) return;
    const rp = propById(a.property_id), radius = p => p.audit_radius_m || 500, hasPin = p => p && p.latitude != null && p.longitude != null;
    if (!pos) { geo.textContent = 'Your location is not available. You can still audit, but the entry will be marked "location not verified". Allow location access in the browser to verify.'; aud.disabled = false; return; }
    const near = S.props.filter(hasPin).map(p => ({ p, d: distM(pos.lat, pos.lng, p.latitude, p.longitude) })).filter(x => x.d <= radius(x.p)).sort((x, y) => x.d - y.d);
    if (hasPin(rp)) {
      const d = distM(pos.lat, pos.lng, rp.latitude, rp.longitude);
      if (d <= radius(rp)) { geo.className = 'ok'; geo.textContent = 'You are at ' + rp.name + ' (' + fmtDist(d) + ' from its pin). You can mark this asset audited.'; aud.disabled = false; return; }
    } else if (!near.length) {
      geo.textContent = rp.name + ' has no map pin yet, so your location cannot be verified. You can still audit; the entry will be marked "location not verified".'; aud.disabled = false; return;
    }
    const other = near.find(x => x.p.id !== a.property_id);
    if (other) {
      geo.className = 'err'; geo.innerHTML = 'This asset is recorded at <b>' + esc(rp.name) + '</b>, but you are at <b>' + esc(other.p.name) + '</b>. It needs to be transferred before it can be audited.';
      const rooms = S.rooms.filter(r => r.property_id === other.p.id);
      xf.innerHTML = `<div class="row"><div><label>Transfer to ${esc(other.p.name)}: room / store</label><select id="xr"><option value="STORE">Store</option>${rooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div></div><button class="btn" id="xgo">Transfer to ${esc(other.p.name)} now</button>`;
      $('#xgo').onclick = async () => {
        try {
          $('#xgo').disabled = true;
          const toStore = $('#xr').value === 'STORE';
          const { error } = await sb.rpc('transfer_asset', { p_asset: a.id, p_property: other.p.id, p_room: toStore ? null : $('#xr').value, p_to_store: toStore, p_note: 'Transferred during audit', p_lat: pos.lat, p_lng: pos.lng });
          if (error) throw error;
          toast('Transferred. You can now audit it.'); route();
        } catch (e) { $('#xgo').disabled = false; fail(e); }
      };
      return;
    }
    const d = distM(pos.lat, pos.lng, rp.latitude, rp.longitude);
    geo.className = 'err'; geo.textContent = 'You are ' + fmtDist(d) + ' from ' + rp.name + '. Audited OK is only allowed within ' + radius(rp) + ' m of the property. Go to the property to audit this asset.';
  };
  $('#loc').onclick = runGeo;
  runGeo();

  $('#aud').onclick = async () => {
    try {
      $('#aud').disabled = true;
      const pos = await getPos(3000);
      const { error } = await sb.rpc('audit_asset', { p_asset: a.id, p_note: $('#aun').value.trim() || null, p_lat: pos && pos.lat, p_lng: pos && pos.lng });
      if (error) throw error;
      toast('Audited OK saved'); route();
    } catch (e) { $('#aud').disabled = false; fail(e); }
  };
  $('#ss').onclick = async () => {
    try {
      const pos = await getPos(3000);
      const { error } = await sb.rpc('change_asset_status', { p_asset: a.id, p_status: $('#ns').value, p_note: $('#sn').value.trim() || null, p_lat: pos && pos.lat, p_lng: pos && pos.lng });
      if (error) throw error;
      toast('Status updated'); route();
    } catch (e) { fail(e); }
  };
  $('#tt').onclick = async () => {
    try {
      const toStore = $('#tr').value === 'STORE';
      const pos = await getPos(3000);
      const { error } = await sb.rpc('transfer_asset', { p_asset: a.id, p_property: $('#tp').value, p_room: toStore ? null : $('#tr').value, p_to_store: toStore, p_note: $('#tn').value.trim() || null, p_lat: pos && pos.lat, p_lng: pos && pos.lng });
      if (error) throw error;
      toast('Asset transferred'); route();
    } catch (e) { fail(e); }
  };
}

/* ---------- Add / edit asset (property, room and status are optional until assigned) ---------- */
async function viewForm(id) {
  if (!canEdit()) { view.innerHTML = '<p>Page not available for your role.</p>'; return; }
  if (!S.types) await loadTypes();
  const a = id ? await getAsset(id) : null;
  if (id && !a) { view.innerHTML = '<div class="card">Asset not found.</div>'; return; }
  const addMode = !a, unassignedEdit = !!a && !a.property_id;
  const v = a || {};
  const locFields = unassignedEdit
    ? '<div><label>Location</label><p class="mute">Not assigned yet. Assign property, room and status from the asset page.</p></div>'
    : `<div><label>Property ${addMode ? '(optional)' : '*'}</label><select id="pr">${addMode ? '<option value="">Not assigned (assign later)</option>' : ''}${S.props.map(p => `<option value="${p.id}" ${p.id === v.property_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>Room / area ${addMode ? '(if property chosen)' : '*'}</label><select id="rm"></select></div>
      <div><label>Status ${addMode ? '(if property chosen)' : '*'}</label><select id="st"></select></div>`;
  view.innerHTML = `<div class="card"><h2>${a ? 'Edit ' + tagOf(a) : 'Add asset'}</h2>
    ${addMode ? '<p class="mute">Leave Property as "Not assigned" if the asset is only purchased. The Projects team assigns the property, room and status later, when they print its label.</p>' : ''}
    <div class="row">
      <div><label>Item type *</label><input id="it" list="tl" value="${esc(v.item_type)}" placeholder="e.g. Split AC, Chair, TV"><datalist id="tl">${S.types.map(t => `<option value="${esc(t)}">`).join('')}</datalist></div>
      <div><label>Name (optional)</label><input id="nm2" value="${esc(v.name)}" placeholder="e.g. Executive chair, Queen bed sheet"></div>
      <div><label>Size (optional)</label><input id="sz" value="${esc(v.size)}" placeholder="e.g. 6 x 3 ft, King, 1.5 ton"></div>
      <div><label>Description / model / serial</label><input id="ds" value="${esc(v.description)}"></div>
      ${locFields}
      <div><label>Purchase date</label><input id="pd" type="date" value="${esc(v.purchase_date)}"></div>
      <div><label>Purchase cost (per item)</label><input id="pc" type="number" step="0.01" value="${esc(v.purchase_cost)}"></div>
      <div><label>Vendor name</label><input id="vn" value="${esc(v.vendor)}"></div>
      <div><label>Warranty valid until</label><input id="wu" type="date" value="${esc(v.warranty_until)}"></div>
      ${addMode ? '<div><label>Number of copies (each gets its own tag and QR)</label><input id="nc" type="number" min="1" max="10000" value="1"></div>' : ''}
    </div>
    <label>Notes</label><textarea id="nt">${esc(v.notes)}</textarea>
    <label>Photo (optional) ${v.photo_url ? '- a photo exists; choose a new one to replace it' : ''}</label>
    <input id="ph" type="file" accept="image/*" capture="environment">
    ${v.photo_url ? `<p><img class="photo" src="${esc(v.photo_url)}"></p>` : ''}
    <button class="btn" id="save">Save</button><button class="btn sec" id="cancel">Cancel</button>
    ${a && can('procurement') ? '<button class="btn red" id="del">Delete</button>' : ''}</div>`;

  const statusOpts = (placeholder, sel) => `<option value="">${placeholder}</option>` + STATUSES.map(s => `<option value="${s}" ${s === sel ? 'selected' : ''}>${cap(s)}</option>`).join('');
  const syncLoc = first => {
    if (unassignedEdit) return;
    const p = $('#pr').value;
    if (!p) {
      $('#rm').innerHTML = '<option value="">-</option>'; $('#rm').disabled = true;
      $('#st').innerHTML = statusOpts('Not set (set when assigned)', ''); $('#st').disabled = true;
      return;
    }
    const keepStatus = $('#st').value || (first && a ? a.status : '');
    $('#rm').disabled = false; $('#st').disabled = false;
    $('#rm').innerHTML = '<option value="">Choose room...</option><option value="STORE">Store</option>' + S.rooms.filter(r => r.property_id === p).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    $('#st').innerHTML = statusOpts('Choose status...', keepStatus);
    if (a && a.property_id === p) $('#rm').value = a.in_store ? 'STORE' : (a.room_id || '');
  };
  if (!unassignedEdit) { $('#pr').onchange = () => syncLoc(false); syncLoc(true); }
  $('#cancel').onclick = () => history.back();
  if ($('#del')) $('#del').onclick = async () => {
    if (!confirm('Delete this asset and its history?')) return;
    const { error } = await sb.from('assets').delete().eq('id', a.id); if (error) return fail(error);
    S.types = null; go('#/assets');
  };
  $('#save').onclick = async () => {
    try {
      if (!$('#it').value.trim()) return fail(new Error('Item type is required'));
      const copies = a ? 1 : Math.floor(Number($('#nc').value));
      if (!a && !(copies >= 1 && copies <= 10000)) return fail(new Error('Number of copies must be between 1 and 10,000'));
      let loc = {};
      if (!unassignedEdit) {
        const p = $('#pr').value;
        if (!p) loc = { property_id: null, room_id: null, in_store: false, status: null };
        else {
          const r = $('#rm').value, st = $('#st').value;
          if (!r || !st) return fail(new Error('Choose a room (or Store) and a status, or set Property to "Not assigned"'));
          loc = { property_id: p, room_id: r === 'STORE' ? null : r, in_store: r === 'STORE', status: st };
        }
      }
      $('#save').disabled = true;
      let photo_url = v.photo_url || null;
      const f = $('#ph').files[0];
      if (f) {
        const blob = await compress(f), path = crypto.randomUUID() + '.jpg';
        const up = await sb.storage.from('asset-photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        photo_url = sb.storage.from('asset-photos').getPublicUrl(path).data.publicUrl;
      }
      const row = {
        item_type: $('#it').value.trim(), name: $('#nm2').value.trim() || null, size: $('#sz').value.trim() || null, description: $('#ds').value.trim() || null, ...loc,
        purchase_date: $('#pd').value || null, purchase_cost: $('#pc').value === '' ? null : Number($('#pc').value),
        vendor: $('#vn').value.trim() || null, warranty_until: $('#wu').value || null, notes: $('#nt').value.trim() || null,
        photo_url, updated_at: new Date().toISOString()
      };
      S.types = null;
      if (a) {
        const { error } = await sb.from('assets').update(row).eq('id', a.id); if (error) throw error;
        toast('Saved'); go('#/asset/' + a.id);
      } else {
        const data = [];
        try {
          for (let i = 0; i < copies; i += CHUNK) {
            if (copies > CHUNK) $('#save').textContent = `Creating ${i} of ${copies}...`;
            const n = Math.min(CHUNK, copies - i);
            const { data: part, error } = await sb.from('assets').insert(Array.from({ length: n }, () => row)).select('id');
            if (error) throw error;
            data.push(...part);
          }
        } catch (e) {
          throw new Error(data.length ? `Stopped after ${data.length} of ${copies} assets were created: ${e.message || e}. Check the asset list before trying again.` : e.message || e);
        }
        if (copies === 1) { toast('Saved'); go('#/asset/' + data[0].id); }
        else if (loc.property_id) { S.printPre = { ids: data.map(x => x.id) }; toast(copies + ' assets created. Labels are ready to print.'); go('#/print'); }
        else { L.fp = '__none'; L.q = ''; L.ft = ''; L.fs = ''; L.fa = ''; L.fd = ''; L.fr = ''; L.page = 0; toast(copies + ' unassigned assets created. Assign each one before printing its label.'); go('#/assets'); }
      }
    } catch (e) { $('#save').disabled = false; $('#save').textContent = 'Save'; fail(e); }
  };
}

/* ---------- Print QR labels ---------- */
function qrLink(id) {
  const base = (CFG.APP_URL || (location.origin + location.pathname)).replace(/#.*$/, '');
  return base + '#/asset/' + id;
}
async function viewPrint(preId) {
  if (!canEdit()) { view.innerHTML = '<p>Page not available for your role.</p>'; return; }
  const pre = S.printPre; S.printPre = null;
  const st = { ids: preId ? [preId] : (pre && pre.ids) || null, page: 0 };
  view.innerHTML = `<div class="card noprint"><h2>Print QR labels</h2>
    <p id="bn" class="mute"></p>
    <p id="un" class="mute"></p>
    <div class="row">
      <div><label>1. Property</label><select id="pp">${S.props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>2. Room / area</label><select id="pr"></select></div>
      <div><label>3. Asset</label><select id="pa"></select></div>
    </div>
    <button class="btn" id="gen">Show labels</button><button class="btn sec" id="prt">Print this page of labels</button>
    <p class="mute">Every label reads "${esc(LABEL_TITLE)}" with the QR and tag number. Labels are ${LABEL_MM} mm square, 15 per A4 sheet. ${LABELS_PER} labels (6 sheets) are shown at a time; use Next labels for the rest. In the print window choose A4, Scale 100%, Margins None, and untick Headers and footers.</p></div>
    <div id="labels" class="labels"></div>
    <div class="noprint"><p id="pg" class="mute"></p><button class="btn sec" id="lprev">Previous labels</button><button class="btn sec" id="lnext">Next labels</button></div>`;
  const roomFilter = q => { const r = $('#pr').value; return r === 'STORE' ? q.eq('in_store', true) : (r ? q.eq('room_id', r) : q); };
  const fillRooms = () => {
    const rooms = S.rooms.filter(r => r.property_id === $('#pp').value);
    $('#pr').innerHTML = '<option value="">All rooms</option><option value="STORE">Store</option>' + rooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  };
  const fillAssets = async () => {
    if (!$('#pp').value) return;
    const { data, count, error } = await roomFilter(sb.from('assets').select('id,tag_no,item_type,description', { count: 'exact' }).eq('property_id', $('#pp').value)).order('tag_no').limit(300);
    if (error) return fail(error);
    $('#pa').innerHTML = `<option value="">All assets (${count})</option>` + data.map(a => `<option value="${a.id}">${tagOf(a)} - ${esc(a.item_type)}${a.description ? ' - ' + esc(a.description) : ''}</option>`).join('') +
      (count > 300 ? '<option disabled>(only the first 300 are listed; choose All to print the rest in pages)</option>' : '');
  };
  const leaveIds = () => { st.ids = null; st.page = 0; $('#bn').textContent = ''; };
  const showLabels = async () => {
    const box = $('#labels'); box.innerHTML = '<p class="mute">Loading...</p>';
    let rows, total;
    const from = st.page * LABELS_PER;
    if (st.ids) {
      total = st.ids.length;
      const r = await sb.from('assets').select('*').in('id', st.ids.slice(from, from + LABELS_PER)).order('tag_no');
      if (r.error) return fail(r.error); rows = r.data;
    } else {
      let q = roomFilter(sb.from('assets').select('*', { count: 'exact' }).eq('property_id', $('#pp').value));
      if ($('#pa').value) q = q.eq('id', $('#pa').value);
      const r = await q.order('tag_no').range(from, from + LABELS_PER - 1);
      if (r.error) return fail(r.error); rows = r.data; total = r.count;
    }
    box.innerHTML = '';
    const got = rows.length, skipped = rows.filter(a => !a.property_id).length;
    rows = rows.filter(a => a.property_id); // an asset needs a property and room before its label prints
    if (!rows.length) { box.innerHTML = '<p class="mute">No assets with a property and room match.</p>'; $('#pg').textContent = skipped ? skipped + ' unassigned asset(s) skipped. Assign them first.' : ''; return; }
    let sheet = null;
    rows.forEach((a, i) => {
      if (i % 15 === 0) { sheet = document.createElement('div'); sheet.className = 'sheet'; box.appendChild(sheet); }
      const d = document.createElement('div'); d.className = 'label';
      d.innerHTML = '<span class="ttl">' + esc(LABEL_TITLE) + '</span><div class="qr"></div><b>' + tagOf(a) + '</b><span class="ln">' + esc(a.name || a.item_type) + (a.size ? ' (' + esc(a.size) + ')' : '') + '</span><span class="ln">' + esc(propName(a.property_id)) + ' / ' + esc(roomLabel(a)) + '</span>';
      sheet.appendChild(d);
      new QRCode(d.querySelector('.qr'), { text: qrLink(a.id), width: 113, height: 113, correctLevel: QRCode.CorrectLevel.M });
    });
    $('#pg').textContent = `Labels ${from + 1}-${from + got} of ${total}` + (skipped ? ` (${skipped} unassigned skipped - assign them first)` : '');
    $('#lprev').disabled = st.page === 0; $('#lnext').disabled = from + got >= total;
  };
  $('#pp').onchange = () => { leaveIds(); fillRooms(); fillAssets(); };
  $('#pr').onchange = () => { leaveIds(); fillAssets(); };
  $('#pa').onchange = () => leaveIds();
  $('#gen').onclick = () => { st.page = 0; showLabels(); };
  $('#lprev').onclick = () => { st.page--; showLabels(); }; $('#lnext').onclick = () => { st.page++; showLabels(); };
  $('#prt').onclick = async () => { if (!$('#labels').querySelector('.label')) await showLabels(); setTimeout(() => window.print(), 300); };
  $('#lprev').disabled = true; $('#lnext').disabled = true;

  sb.from('assets').select('id', { count: 'exact', head: true }).is('property_id', null).then(({ count }) => {
    if (count && $('#un')) { $('#un').innerHTML = `<b>${count}</b> asset(s) are waiting to be assigned and cannot print yet. <button class="btn sec" id="seeun" style="margin:0">Show them</button>`; $('#seeun').onclick = () => { L.fp = '__none'; L.q = ''; L.ft = ''; L.fs = ''; L.fa = ''; L.fd = ''; L.fr = ''; L.page = 0; go('#/assets'); }; }
  });
  if (S.props.length) { fillRooms(); await fillAssets(); }
  if (st.ids) {
    $('#bn').textContent = st.ids.length === 1 ? 'Showing the label for the selected asset. Change the dropdowns and press Show labels to print others.' : `Showing labels for the ${st.ids.length} assets you just created, imported or assigned. Change the dropdowns and press Show labels to print others.`;
    showLabels();
  }
}

/* ---------- Scan ---------- */
function parseId(txt) {
  const m = String(txt).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}
function viewScan() {
  view.innerHTML = `<div class="card"><h2>Scan asset QR</h2>
    <div id="reader"></div><p class="mute" id="smsg">Starting camera...</p>
    <h3>Or type the tag number</h3>
    <div class="row"><input id="tg" placeholder="e.g. 12 or AST-00012"></div><button class="btn sec" id="find">Open</button></div>`;
  $('#find').onclick = async () => {
    const n = parseInt(($('#tg').value.match(/\d+/) || [])[0], 10);
    if (!n) return toast('Type a tag number', true);
    const { data, error } = await sb.from('assets').select('id').eq('tag_no', n).maybeSingle();
    if (error) return fail(error);
    if (data) go('#/asset/' + data.id); else toast('No asset with that tag', true);
  };
  const sc = new Html5Qrcode('reader'); stopScanner.s = sc;
  sc.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } },
    txt => { const id = parseId(txt); if (id) { stopScanner(); go('#/asset/' + id); } },
    () => {})
    .then(() => { $('#smsg').textContent = 'Point the camera at the QR label.'; })
    .catch(() => { $('#smsg').innerHTML = '<span class="err">Camera not available. Allow camera access, or type the tag number below.</span>'; });
}

/* ---------- Import from Excel / CSV ---------- */
const IMPORT_COLS = [
  ['item_type', 'Yes', 'What the item is', 'Chair, Split AC, Ceiling Fan'],
  ['name', 'No', 'Specific name of the item', 'Executive chair'],
  ['size', 'No', 'Size', '6 x 3 ft, King, 1.5 ton'],
  ['description', 'No', 'Make / model / serial', 'Voltas 1.5 ton'],
  ['property', 'If placed', 'Property name, spelled exactly as in the Properties tab. Empty = not assigned yet', 'Property A'],
  ['room', 'If placed', 'Room / area name exactly as in the app, or the word STORE for the property store. Empty = not assigned yet', '101, Lobby, STORE'],
  ['status', 'If placed', 'working, repairable or damaged. Empty = not assigned yet', 'working'],
  ['purchase_date', 'No', 'YYYY-MM-DD (DD/MM/YYYY also works)', '2025-04-15'],
  ['purchase_cost', 'No', 'Cost of ONE item, numbers only', '2500'],
  ['vendor', 'No', 'Vendor name', 'ABC Furniture'],
  ['warranty_until', 'No', 'Last day of warranty, YYYY-MM-DD', '2027-04-14'],
  ['notes', 'No', 'Any note', ''],
  ['quantity', 'No', 'How many identical items this row creates; each gets its own tag and QR (blank = 1, max 10,000)', '10']
];
const IMPORT_REQUIRED = ['item_type', 'property', 'room', 'status']; // these headers must exist in row 1
const normKey = k => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
const isBlank = v => v === '' || v == null;

function parseDate(v) {
  if (isBlank(v)) return { ok: true, val: null };
  const pad = n => String(n).padStart(2, '0');
  const valid = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  if (v instanceof Date) {
    if (isNaN(v)) return { ok: false };
    const t = new Date(v.getTime() + 12 * 3600e3); // noon shift keeps the intended day
    return { ok: true, val: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` };
  }
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return { ok: false };
    const t = new Date(Math.round((v - 25569) * 86400e3));
    return { ok: true, val: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m && valid(+m[1], +m[2], +m[3])) return { ok: true, val: `${m[1]}-${pad(m[2])}-${pad(m[3])}` };
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m && valid(+m[3], +m[2], +m[1])) return { ok: true, val: `${m[3]}-${pad(m[2])}-${pad(m[1])}` };
  return { ok: false };
}
function parseCost(v) {
  if (isBlank(v)) return { ok: true, val: null };
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? { ok: true, val: v } : { ok: false };
  const n = Number(String(v).replace(/[,\s]|rs\.?|inr|₹/gi, ''));
  return isFinite(n) && n >= 0 && String(v).trim() !== '' ? { ok: true, val: n } : { ok: false };
}

/* Checks every row and returns { rows, errors, units, newRooms }. Nothing is saved here. */
function validateRows(rawRows, autoRooms) {
  const errors = [], rows = [], newRooms = new Map();
  if (!rawRows.length) return { rows, errors: ['The file has no data rows.'], units: 0, newRooms };
  const firstKeys = Object.keys(rawRows[0]).map(normKey);
  const missing = IMPORT_REQUIRED.filter(c => !firstKeys.includes(c));
  if (missing.length) return { rows, errors: ['Missing column header(s): ' + missing.join(', ') + '. Headers found: ' + firstKeys.join(', ')], units: 0, newRooms };
  const propMap = new Map(S.props.map(p => [p.name.trim().toLowerCase(), p]));
  const roomMap = new Map(S.rooms.map(r => [r.property_id + '|' + r.name.trim().toLowerCase(), r]));
  let units = 0;
  rawRows.forEach((raw, i) => {
    const r = {}; Object.keys(raw).forEach(k => { r[normKey(k)] = raw[k]; });
    if (Object.values(r).every(isBlank)) return;
    const line = i + 2, bad = [];
    const item = String(r.item_type ?? '').trim(); if (!item) bad.push('item_type is empty');
    const propTxt = String(r.property ?? '').trim(), roomTxt = String(r.room ?? '').trim(), statusTxt = String(r.status ?? '').trim().toLowerCase();
    let prop = null, inStore = false, roomId = null, roomName = null, status = null;
    if (!propTxt) {
      if (roomTxt || statusTxt) bad.push('property is empty but room or status is filled (leave all three empty for an unassigned asset)');
    } else {
      prop = propMap.get(propTxt.toLowerCase());
      if (!prop) bad.push(`property "${propTxt}" does not exist`);
      if (!roomTxt) bad.push('room is empty (use a room name or STORE)');
      else if (roomTxt.toUpperCase() === 'STORE') inStore = true;
      else if (prop) {
        const rm = roomMap.get(prop.id + '|' + roomTxt.toLowerCase());
        if (rm) roomId = rm.id;
        else if (autoRooms) { roomName = roomTxt; newRooms.set(prop.id + '|' + roomTxt.toLowerCase(), { property_id: prop.id, name: roomTxt }); }
        else bad.push(`room "${roomTxt}" does not exist in ${prop.name}`);
      }
      if (!statusTxt) bad.push('status is required when a property is given (working, repairable or damaged)');
      else if (!STATUSES.includes(statusTxt)) bad.push(`status "${statusTxt}" must be working, repairable or damaged`);
      else status = statusTxt;
    }
    const pd = parseDate(r.purchase_date); if (!pd.ok) bad.push('purchase_date is not a valid date');
    const wu = parseDate(r.warranty_until); if (!wu.ok) bad.push('warranty_until is not a valid date');
    const pc = parseCost(r.purchase_cost); if (!pc.ok) bad.push('purchase_cost must be a number');
    let qty = 1;
    if (!isBlank(r.quantity)) { qty = Number(r.quantity); if (!Number.isInteger(qty) || qty < 1 || qty > 10000) bad.push('quantity must be a whole number from 1 to 10,000'); }
    if (bad.length) { errors.push(`Row ${line}: ` + bad.join('; ')); return; }
    units += qty;
    rows.push({
      qty, roomKey: roomName ? prop.id + '|' + roomName.toLowerCase() : null,
      data: {
        item_type: item, name: String(r.name ?? '').trim() || null, size: String(r.size ?? '').trim() || null, description: String(r.description ?? '').trim() || null, property_id: prop ? prop.id : null, room_id: roomId, in_store: inStore,
        status, purchase_date: pd.val, purchase_cost: pc.val, vendor: String(r.vendor ?? '').trim() || null,
        warranty_until: wu.val, notes: String(r.notes ?? '').trim() || null
      }
    });
  });
  if (!rows.length && !errors.length) errors.push('The file has no data rows.');
  return { rows, errors, units, newRooms };
}

function templateCsv() {
  return IMPORT_COLS.map(c => c[0]).join(',') + '\n' +
    'Chair,Dining chair,Standard,Wooden dining chair,Property A,Lobby,working,2025-04-15,2500,ABC Furniture,2027-04-14,,10\n' +
    'Split AC,Bedroom AC,1.5 ton,Voltas 1.5 ton,Property A,STORE,working,2024-06-01,38000,XYZ Traders,2029-05-31,Spare unit,1\n' +
    'Ceiling Fan,,1200 mm,Purchased - not placed yet,,,,2025-09-10,3200,Fan Mart,2027-09-09,,20\n';
}

function viewImport() {
  if (!canEdit()) { view.innerHTML = '<p>Page not available for your role.</p>'; return; }
  view.innerHTML = `<div class="card"><h2>Import assets from Excel or CSV</h2>
    <p>Use an .xlsx or .csv file. <b>Row 1 must be the headers below, spelled exactly like this</b> (small letters, underscores, no spaces). The first sheet is read. One row = one item, or several identical items if you use <b>quantity</b>.</p>
    <p><b>Placed or not placed:</b> the columns <b>property, room and status must exist</b> in row 1. For an asset that is only purchased, leave all three cells empty; the Projects team assigns it later. If <b>property</b> is filled, then <b>room</b> and <b>status</b> must be filled too.</p>
    <div class="tw"><table><tr><th>Header</th><th>Required?</th><th>What to enter</th><th>Example</th></tr>
    ${IMPORT_COLS.map(c => `<tr><td><b>${c[0]}</b></td><td>${c[1]}</td><td>${esc(c[2])}</td><td>${esc(c[3])}</td></tr>`).join('')}</table></div>
    <p class="mute">Properties must already exist (Properties tab). ${can('procurement') ? 'Missing rooms can be created automatically (tick the box below).' : 'Rooms must already exist; ask Procurement to add new ones.'} The whole file is checked first; nothing is saved if any row has a mistake. Dates typed as text should be YYYY-MM-DD.</p>
    <button class="btn sec" id="tpl">Download template (CSV)</button>
    <h3>Choose your file</h3>
    <input id="fl" type="file" accept=".xlsx,.xls,.csv">
    ${can('procurement') ? '<label style="display:flex;gap:8px;align-items:center"><input id="ar" type="checkbox" style="width:auto"> Create rooms that do not exist yet</label>' : ''}
    <div id="out" style="margin-top:12px"></div></div>`;
  $('#tpl').onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([templateCsv()], { type: 'text/csv' })); a.download = 'asset_import_template.csv'; a.click();
  };
  let current = null;
  const check = async () => {
    const f = $('#fl').files[0]; if (!f) return;
    $('#out').innerHTML = '<p class="mute">Reading file...</p>';
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
      const res = validateRows(raw, $('#ar') && $('#ar').checked);
      current = res;
      const errHtml = res.errors.length ? `<p class="err"><b>${res.errors.length} problem(s) found. Fix the file and choose it again.</b></p><div class="tw"><table>${res.errors.slice(0, 50).map(e => `<tr><td class="err">${esc(e)}</td></tr>`).join('')}</table></div>${res.errors.length > 50 ? '<p class="mute">Showing first 50.</p>' : ''}` : '';
      const okHtml = !res.errors.length ? `<p><b>File is OK.</b> ${res.rows.length} row(s) will create <b>${res.units}</b> asset(s).${res.newRooms.size ? ' ' + res.newRooms.size + ' new room(s) will be created.' : ''}</p>
        <div class="tw"><table><tr><th>Item</th><th>Property</th><th>Room</th><th>Status</th><th>Date</th><th>Cost</th><th>Warranty</th><th>Qty</th></tr>
        ${res.rows.slice(0, 5).map(x => `<tr><td>${esc(x.data.item_type)}</td><td>${esc(propName(x.data.property_id))}</td><td>${x.data.in_store ? 'STORE' : esc(x.roomKey ? x.roomKey.split('|')[1] : (roomById(x.data.room_id) || {}).name) || '-'}</td><td>${x.data.status || '-'}</td><td>${esc(x.data.purchase_date) || '-'}</td><td>${money(x.data.purchase_cost)}</td><td>${esc(x.data.warranty_until) || '-'}</td><td>${x.qty}</td></tr>`).join('')}</table></div>
        <p class="mute">Check the first rows above (especially the dates), then import.</p><button class="btn" id="go">Import ${res.units} asset(s)</button>` : '';
      $('#out').innerHTML = errHtml + okHtml;
      if ($('#go')) $('#go').onclick = () => runImport(current);
    } catch (e) { $('#out').innerHTML = ''; fail(e); }
  };
  $('#fl').onchange = check;
  if ($('#ar')) $('#ar').onchange = check;
}

async function runImport(res) {
  const btn = $('#go'); btn.disabled = true;
  const ids = [];
  try {
    if (res.newRooms.size) {
      const { error } = await sb.from('rooms').upsert([...res.newRooms.values()], { onConflict: 'property_id,name', ignoreDuplicates: true });
      if (error) throw error;
      await loadMaster();
    }
    const roomMap = new Map(S.rooms.map(r => [r.property_id + '|' + r.name.trim().toLowerCase(), r.id]));
    const all = [];
    res.rows.forEach(x => {
      const d = { ...x.data };
      if (x.roomKey) d.room_id = roomMap.get(x.roomKey) || null;
      for (let i = 0; i < x.qty; i++) all.push(d);
    });
    for (let i = 0; i < all.length; i += CHUNK) {
      btn.textContent = `Importing... ${Math.min(i + CHUNK, all.length)} of ${all.length}`;
      const { data, error } = await sb.from('assets').insert(all.slice(i, i + CHUNK)).select('id');
      if (error) throw error;
      data.forEach(x => ids.push(x.id));
    }
    S.types = null;
    $('#out').innerHTML = `<p><b>Done. ${ids.length} assets created.</b></p><button class="btn" id="pl">Print their QR labels</button><button class="btn sec" id="va">View assets</button>`;
    $('#pl').onclick = () => { S.printPre = { ids }; go('#/print'); };
    $('#va').onclick = () => go('#/assets');
  } catch (e) {
    $('#out').innerHTML = `<p class="err"><b>Import stopped: ${esc(e.message || e)}</b></p><p>${ids.length} asset(s) were created before the error. Check the Assets list before trying again so nothing is duplicated.</p>`;
  }
}

/* ---------- Properties and rooms (Procurement) ---------- */
/* ---------- To audit: what is still not audited ---------- */
const AUD = { prop: '', days: 'never' };
async function viewAudit() {
  if (!S.props.length) { view.innerHTML = '<div class="card"><p>No properties yet.</p></div>'; return; }
  if (!AUD.prop || !propById(AUD.prop)) AUD.prop = S.props[0].id;
  const sinceDate = () => AUD.days === 'never' ? null : new Date(Date.now() - Number(AUD.days) * 864e5).toISOString().slice(0, 10);
  view.innerHTML = `<div class="card"><h2>To audit</h2>
    <div class="row">
      <div><label>Property</label><select id="aprop">${S.props.map(p => `<option value="${p.id}" ${p.id === AUD.prop ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>Count an asset as not audited if</label><select id="adays">
        <option value="never" ${AUD.days === 'never' ? 'selected' : ''}>it was never audited</option>
        ${[30, 90, 180, 365].map(d => `<option value="${d}" ${String(d) === String(AUD.days) ? 'selected' : ''}>it was not audited in the last ${d} days</option>`).join('')}
      </select></div>
    </div>
    <p id="asum" class="mute">Loading...</p>
    <div class="tw"><table><thead><tr><th>Room / area</th><th class="num">Assets</th><th class="num">Not audited</th></tr></thead><tbody id="arows"></tbody></table></div>
    <p class="mute">Tap a room to see which assets in it are not audited. Then scan each one at the property and press Audited OK.</p></div>`;
  const openList = (roomId, roomName) => {
    Object.assign(L, { page: 0, q: '', fp: AUD.prop, ft: '', fs: '', fr: roomId || '', frn: roomName || '' });
    const d = sinceDate(); L.fa = d ? 'before' : 'no'; L.fd = d || '';
    go('#/assets');
  };
  const draw = async () => {
    const { data, error } = await sb.rpc('audit_pending', { p_property: AUD.prop, p_before: sinceDate() });
    if (error) return fail(error);
    const rows = (data || []).filter(r => r.total > 0 || !r.in_store).sort((x, y) => (y.pending - x.pending) || x.room_name.localeCompare(y.room_name, undefined, { numeric: true }));
    const total = rows.reduce((n, r) => n + Number(r.total), 0), pend = rows.reduce((n, r) => n + Number(r.pending), 0);
    $('#asum').innerHTML = `<b>${pend}</b> of ${total} asset(s) at ${esc(propName(AUD.prop))} are not audited. ${pend ? '<a href="#" id="aall">Show all of them</a>' : ''}`;
    $('#arows').innerHTML = rows.map((r, i) => `<tr class="click" data-i="${i}"><td>${esc(r.room_name)}</td><td class="num">${r.total}</td><td class="num">${r.pending ? '<b>' + r.pending + '</b>' : '<span class="mute">0</span>'}</td></tr>`).join('') || '<tr><td colspan="3" class="mute">No rooms or assets yet.</td></tr>';
    $('#arows').onclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr) { const r = rows[Number(tr.dataset.i)]; openList(r.in_store ? 'STORE' : r.room_id, r.room_name); } };
    if ($('#aall')) $('#aall').onclick = e => { e.preventDefault(); openList('', ''); };
  };
  $('#aprop').onchange = () => { AUD.prop = $('#aprop').value; draw(); };
  $('#adays').onchange = () => { AUD.days = $('#adays').value; draw(); };
  draw();
}

/* ---------- Audit report: audited vs not audited, on screen + Excel ---------- */
const REP = { prop: '' };
async function viewReport() {
  const sinceDate = () => AUD.days === 'never' ? null : new Date(Date.now() - Number(AUD.days) * 864e5).toISOString().slice(0, 10);
  const pct = (a, t) => Number(t) ? Math.round(1000 * Number(a) / Number(t)) / 10 : null;
  const dt = x => x ? new Date(x).toLocaleDateString() : '';
  if (REP.prop && !propById(REP.prop)) REP.prop = '';
  view.innerHTML = `<div class="card"><h2>Audit report</h2>
    <div class="row">
      <div><label>Property</label><select id="rprop"><option value="">All properties</option>${S.props.map(p => `<option value="${p.id}" ${p.id === REP.prop ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>An asset counts as audited if it was</label><select id="rdays">
        <option value="never" ${AUD.days === 'never' ? 'selected' : ''}>audited at least once</option>
        ${[30, 90, 180, 365].map(d => `<option value="${d}" ${String(d) === String(AUD.days) ? 'selected' : ''}>audited in the last ${d} days</option>`).join('')}
      </select></div>
    </div>
    <button class="btn" id="rxl">Download Excel</button>
    <p class="mute">Assets that are not assigned to a property yet cannot be audited and are not counted.</p>
    <div id="rbody"><p class="mute">Loading...</p></div></div>`;
  const notAuditedQ = (count, head) => {
    let q = sb.from('assets').select('id,tag_no,item_type,name,size,property_id,room_id,in_store,status,last_audited_at', count ? { count: 'exact' } : undefined).not('property_id', 'is', null);
    if (REP.prop) q = q.eq('property_id', REP.prop);
    const d = sinceDate();
    q = d ? q.or(`last_audited_at.is.null,last_audited_at.lt.${d}`) : q.is('last_audited_at', null);
    return head ? q : q.order('tag_no');
  };
  let report = null;
  const load = async () => {
    $('#rbody').innerHTML = '<p class="mute">Loading...</p>';
    const [rp, na] = await Promise.all([sb.rpc('audit_report', { p_before: sinceDate() }), notAuditedQ(true).range(0, 199)]);
    if (rp.error) return fail(rp.error); if (na.error) return fail(na.error);
    const rows = rp.data || [], props = new Map();
    rows.forEach(r => {
      const x = props.get(r.property_id) || { id: r.property_id, name: r.property_name, total: 0, audited: 0, last: null };
      x.total += Number(r.total); x.audited += Number(r.audited); if (r.last_audit && (!x.last || r.last_audit > x.last)) x.last = r.last_audit;
      props.set(r.property_id, x);
    });
    const plist = [...props.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const shown = REP.prop ? plist.filter(x => x.id === REP.prop) : plist;
    const T = shown.reduce((n, x) => n + x.total, 0), A = shown.reduce((n, x) => n + x.audited, 0);
    const roomRows = rows.filter(r => (!REP.prop || r.property_id === REP.prop) && (Number(r.total) > 0 || (!r.in_store && r.room_name !== '(no room)')))
      .sort((x, y) => x.property_name.localeCompare(y.property_name, undefined, { numeric: true }) || (x.in_store - y.in_store) || x.room_name.localeCompare(y.room_name, undefined, { numeric: true }));
    report = { shown, roomRows, T, A, pct };
    const pc = v => v === null ? '-' : v + '%';
    $('#rbody').innerHTML = `
      <div class="stats"><div class="stat"><b>${T}</b><span>Assets placed</span></div><div class="stat"><b>${A}</b><span>Audited</span></div><div class="stat"><b>${T - A}</b><span>Not audited</span></div><div class="stat"><b>${pc(pct(A, T))}</b><span>Audited</span></div></div>
      <h3>By property</h3>
      <div class="tw"><table><thead><tr><th>Property</th><th class="num">Assets</th><th class="num">Audited</th><th class="num">Not audited</th><th class="num">% audited</th><th>Last audit</th></tr></thead><tbody>
      ${shown.map(x => `<tr class="click" data-p="${x.id}"><td>${esc(x.name)}</td><td class="num">${x.total}</td><td class="num">${x.audited}</td><td class="num">${x.total - x.audited}</td><td class="num">${pc(pct(x.audited, x.total))}</td><td>${esc(dt(x.last))}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">No data.</td></tr>'}</tbody></table></div>
      ${REP.prop ? `<h3>By room</h3><div class="tw"><table><thead><tr><th>Room / area</th><th class="num">Assets</th><th class="num">Audited</th><th class="num">Not audited</th><th class="num">% audited</th><th>Last audit</th></tr></thead><tbody>
      ${roomRows.map(r => `<tr><td>${esc(r.room_name)}</td><td class="num">${r.total}</td><td class="num">${r.audited}</td><td class="num">${r.total - r.audited}</td><td class="num">${pc(pct(r.audited, r.total))}</td><td>${esc(dt(r.last_audit))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mute">Pick a property above to see the room-by-room breakdown.</p>'}
      <h3>Not audited assets</h3>
      <p class="mute">${na.count ? `Showing ${na.data.length} of ${na.count}.${na.count > na.data.length ? ' The Excel file has the full list.' : ''}` : 'Nothing is waiting to be audited.'}</p>
      <div class="tw"><table><thead><tr><th>Tag</th><th>Item</th><th>Property</th><th>Room</th><th>Status</th><th>Last audited</th></tr></thead><tbody>
      ${na.data.map(a => `<tr class="click" data-id="${a.id}"><td>${tagOf(a)}</td><td>${esc(a.item_type)}${a.name ? '<br><span class="mute">' + esc(a.name) + '</span>' : ''}</td><td>${esc(propName(a.property_id))}</td><td>${esc(roomLabel(a))}</td><td>${badge(a.status)}</td><td>${a.last_audited_at ? esc(dt(a.last_audited_at)) : '<span class="mute">never</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    $('#rbody').onclick = e => {
      const tr = e.target.closest('tr[data-p],tr[data-id]'); if (!tr) return;
      if (tr.dataset.id) go('#/asset/' + tr.dataset.id); else { REP.prop = tr.dataset.p; $('#rprop').value = REP.prop; load(); }
    };
  };
  const toExcel = async () => {
    const btn = $('#rxl'); btn.disabled = true;
    try {
      if (!report) await load();
      const defn = AUD.days === 'never' ? 'audited at least once' : 'audited in the last ' + AUD.days + ' days';
      const wb = XLSX.utils.book_new();
      const sum = [['Audit report'], ['Generated', new Date().toLocaleString()], ['Property', REP.prop ? propName(REP.prop) : 'All properties'], ['Counted as audited if', defn], [],
        ['Property', 'Assets', 'Audited', 'Not audited', '% audited', 'Last audit']];
      report.shown.forEach(x => sum.push([x.name, x.total, x.audited, x.total - x.audited, pct(x.audited, x.total), dt(x.last)]));
      sum.push(['Total', report.T, report.A, report.T - report.A, pct(report.A, report.T), '']);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'By property');
      const rm = [['Property', 'Room / area', 'Assets', 'Audited', 'Not audited', '% audited', 'Last audit']];
      report.roomRows.forEach(r => rm.push([r.property_name, r.room_name, Number(r.total), Number(r.audited), r.total - r.audited, pct(r.audited, r.total), dt(r.last_audit)]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rm), 'By room');
      const na = [['Tag', 'Item type', 'Name', 'Size', 'Property', 'Room / area', 'Status', 'Last audited']];
      for (let from = 0; ; from += 1000) {
        btn.textContent = `Preparing... ${na.length - 1} assets`;
        const { data, error } = await notAuditedQ(false).range(from, from + 999); if (error) throw error;
        data.forEach(a => na.push([tagOf(a), a.item_type, a.name || '', a.size || '', propName(a.property_id), roomLabel(a), a.status || '', a.last_audited_at ? dt(a.last_audited_at) : 'never']));
        if (data.length < 1000) break;
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(na), 'Not audited assets');
      XLSX.writeFile(wb, 'audit-report-' + new Date().toISOString().slice(0, 10) + '.xlsx');
      toast('Excel file downloaded');
    } catch (e) { fail(e); }
    btn.disabled = false; btn.textContent = 'Download Excel';
  };
  $('#rprop').onchange = () => { REP.prop = $('#rprop').value; load(); };
  $('#rdays').onchange = () => { AUD.days = $('#rdays').value; load(); };
  $('#rxl').onclick = toExcel;
  load();
}

/* ---------- Property form (used inside the Assets tab) ---------- */
const propFormHtml = `<div class="row">
    <div><label>Property name *</label><input id="pn"></div>
    <div><label>Store location (name or description)</label><input id="ps" placeholder="e.g. Basement store room"></div>
    <div><label>Latitude</label><input id="la" type="number" step="any"></div>
    <div><label>Longitude</label><input id="lo" type="number" step="any"></div>
    <div><label>Audit radius (metres)</label><input id="rad" type="number" min="50" step="10" value="500"></div>
  </div>
  <p class="mute">Auditors must be within this distance of the property pin to mark an asset audited. Use a larger value for a big campus.</p>
  <button class="btn sec" id="here">Use my current location</button><button class="btn" id="sp">Save property</button>`;
function wirePropForm(p, after) {
  $('#pn').value = p ? p.name : ''; $('#ps').value = p ? (p.store_location || '') : ''; $('#la').value = p ? (p.latitude ?? '') : ''; $('#lo').value = p ? (p.longitude ?? '') : ''; $('#rad').value = p ? (p.audit_radius_m || 500) : 500;
  $('#here').onclick = async () => {
    toast('Getting location...'); const pos = await getPos(12000);
    if (!pos) return fail(new Error('Could not get location. Allow location access.'));
    $('#la').value = pos.lat.toFixed(6); $('#lo').value = pos.lng.toFixed(6); toast('Location filled (accuracy about ' + Math.round(pos.acc) + ' m)');
  };
  $('#sp').onclick = async () => {
    try {
      if (!$('#pn').value.trim()) return fail(new Error('Property name is required'));
      const row = { name: $('#pn').value.trim(), store_location: $('#ps').value.trim() || null, latitude: $('#la').value === '' ? null : Number($('#la').value), longitude: $('#lo').value === '' ? null : Number($('#lo').value), audit_radius_m: Math.max(50, Math.floor(Number($('#rad').value) || 500)) };
      const { error } = p ? await sb.from('properties').update(row).eq('id', p.id) : await sb.from('properties').insert(row);
      if (error) throw error;
      await loadMaster(); toast('Property saved'); after();
    } catch (e) { fail(e); }
  };
}

/* ---------- Users (Procurement) ---------- */
async function viewUsers() {
  const { data: raw, error } = await sb.from('profiles').select('*').order('created_at'); if (error) throw error;
  const data = raw.filter(u => u.role === 'pending').concat(raw.filter(u => u.role !== 'pending'));
  view.innerHTML = `<div class="card"><h2>Users and roles</h2>
    <p class="mute">New sign-ups are "Waiting for approval" and see nothing until you give them a role here.</p>
    <div class="tw"><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>
    ${data.map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td><select data-u="${u.id}" ${u.id === S.profile.id ? 'disabled' : ''}>${Object.keys(ROLE_LABEL).map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></td></tr>`).join('')}
    </table></div></div>`;
  view.onchange = async e => {
    const s = e.target.closest('select[data-u]'); if (!s) return;
    const { error: er } = await sb.from('profiles').update({ role: s.value }).eq('id', s.dataset.u);
    if (er) fail(er); else toast('Role updated');
  };
}

boot();
