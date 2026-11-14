/* Asset Manager - plain JavaScript, no build step. Talks to Supabase.
   Built for about 100,000 assets: lists are paged, totals are calculated in the database,
   and a scan fetches only the one asset it needs. */
const CFG = window.APP_CONFIG;
const view = document.getElementById('view');
const $ = (s, el = document) => el.querySelector(s);
const S = { profile: null, props: [], rooms: [], types: null, printPre: null };
let sb = null;
const LABEL_TITLE = (CFG && CFG.LABEL_TITLE) || 'CLSPL Asset';
const PAGE = 50;        // rows per page in the asset list
const LABELS_PER = 100; // labels per print page
const CHUNK = 500;      // rows per request when creating many assets

const TABS = {
  procurement: [['summary', 'Summary'], ['assets', 'Assets'], ['print', 'Print QR'], ['import', 'Import'], ['scan', 'Scan'], ['properties', 'Properties'], ['users', 'Users']],
  projects: [['summary', 'Summary'], ['assets', 'Assets'], ['print', 'Print QR'], ['import', 'Import'], ['scan', 'Scan']],
  auditor: [['scan', 'Scan'], ['assets', 'Assets'], ['summary', 'Summary']]
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
    <h3>New user?</h3>
    <label>Your name</label><input id="nm">
    <button class="btn sec" id="su">Create account</button>
    <p class="mute">After you create an account, Procurement must approve it and give you a role (Users tab). Until then you cannot see any data.</p></div>`;
  $('#si').onclick = async () => {
    const { error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
    if (error) return fail(error); await afterLogin();
  };
  $('#su').onclick = async () => {
    const { data, error } = await sb.auth.signUp({ email: $('#em').value.trim(), password: $('#pw').value, options: { data: { full_name: $('#nm').value.trim() } } });
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
    else if (v === 'properties' && can('procurement')) viewProperties();
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
  const row = (name, x) => `<tr><td>${esc(name)}</td><td class="num">${x.total}</td><td class="num">${x.working}</td><td class="num">${x.repairable}</td><td class="num">${x.damaged}</td><td class="num">${money(x.cost)}</td></tr>`;
  const head = first => `<tr><th>${first}</th><th class="num">Total</th><th class="num">Working</th><th class="num">Repairable</th><th class="num">Damaged</th><th class="num">Cost</th></tr>`;
  const matrix = s.by_property.map(p => `<tr><td>${esc(p.name)}</td>${types.map(t => `<td class="num">${cell.get(p.id + '|' + t) || ''}</td>`).join('')}<td class="num"><b>${p.total}</b></td></tr>`).join('');
  const matrixU = s.unassigned.total ? `<tr><td><i>Unassigned</i></td>${types.map(t => `<td class="num">${cell.get('null|' + t) || ''}</td>`).join('')}<td class="num"><b>${s.unassigned.total}</b></td></tr>` : '';
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${s.total}</b><span>Total assets</span></div>
      <div class="stat"><b>${s.unassigned.total}</b><span>Unassigned (not placed yet)</span></div>
      <div class="stat"><b>${s.working}</b><span>Working</span></div>
      <div class="stat"><b>${s.repairable}</b><span>Repairable</span></div>
      <div class="stat"><b>${s.damaged}</b><span>Damaged</span></div>
      <div class="stat"><b>${money(s.cost)}</b><span>Total purchase cost</span></div>
      <div class="stat"><b>${s.warranty_90}</b><span>Warranty ends in 90 days</span></div>
    </div>
    <div class="card"><h2>Property-wise</h2><div class="tw"><table>${head('Property')}${s.by_property.map(p => row(p.name, p)).join('') || '<tr><td>No properties yet</td></tr>'}${s.unassigned.total ? `<tr><td><i>Unassigned</i></td><td class="num">${s.unassigned.total}</td><td></td><td></td><td></td><td class="num">${money(s.unassigned.cost)}</td></tr>` : ''}</table></div></div>
    <div class="card"><h2>Item-wise</h2><div class="tw"><table>${head('Item')}${s.by_item.map(i => row(i.item_type, i)).join('') || '<tr><td>No assets yet</td></tr>'}</table></div></div>
    <div class="card"><h2>Property x Item (count)</h2><div class="tw"><table><tr><th>Property</th>${types.map(t => `<th class="num">${esc(t)}</th>`).join('')}<th class="num">Total</th></tr>${matrix}${matrixU}</table></div></div>`;
}

/* ---------- Asset list (paged, filtered in the database) ---------- */
const L = { page: 0, q: '', fp: '', ft: '', fs: '' };
async function viewAssets() {
  if (!S.types) await loadTypes();
  view.innerHTML = `<div class="card">
    <h2>Assets ${canEdit() ? '<button class="btn" id="add" style="float:right;margin:0">+ Add asset</button>' : ''}</h2>
    <div class="row">
      <div><label>Search</label><input id="q" value="${esc(L.q)}" placeholder="tag no., item, description, vendor"></div>
      <div><label>Property</label><select id="fp"><option value="">All</option><option value="__none" ${L.fp === '__none' ? 'selected' : ''}>Unassigned (not placed yet)</option>${S.props.map(p => `<option value="${p.id}" ${p.id === L.fp ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>Item</label><select id="ft"><option value="">All</option>${S.types.map(t => `<option ${t === L.ft ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div><label>Status</label><select id="fs"><option value="">All</option>${STATUSES.map(s => `<option value="${s}" ${s === L.fs ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></div>
    </div>
    <p class="mute" id="count"></p>
    <div class="tw"><table><thead><tr><th>Tag</th><th>Item</th><th>Description</th><th>Property</th><th>Room</th><th>Status</th><th>Warranty</th></tr></thead><tbody id="rows"></tbody></table></div>
    <button class="btn sec" id="prev">Previous</button><button class="btn sec" id="next">Next</button></div>`;
  if ($('#add')) $('#add').onclick = () => go('#/form');
  const draw = async () => {
    let q = sb.from('assets').select('*', { count: 'exact' });
    if (L.fp === '__none') q = q.is('property_id', null); else if (L.fp) q = q.eq('property_id', L.fp);
    if (L.ft) q = q.eq('item_type', L.ft);
    if (L.fs) q = q.eq('status', L.fs);
    const t = L.q.trim();
    if (t) {
      const n = t.match(/^(?:ast-?)?0*(\d+)$/i);
      if (n) q = q.eq('tag_no', Number(n[1]));
      else { const w = t.replace(/[,()%*]/g, ' ').trim(); if (w) q = q.or(`item_type.ilike.%${w}%,description.ilike.%${w}%,vendor.ilike.%${w}%`); }
    }
    const from = L.page * PAGE;
    const { data, count, error } = await q.order('tag_no').range(from, from + PAGE - 1);
    if (error) return fail(error);
    $('#count').textContent = count === 0 ? 'No assets match.' : `Showing ${from + 1}-${from + data.length} of ${count}`;
    $('#rows').innerHTML = data.map(a => `<tr class="click" data-id="${a.id}"><td>${tagOf(a)}</td><td>${esc(a.item_type)}</td><td>${esc(a.description)}</td><td>${esc(propName(a.property_id))}</td><td>${esc(roomLabel(a))}</td><td>${badge(a.status)}</td><td>${esc(warrantyText(a))}</td></tr>`).join('');
    $('#prev').disabled = L.page === 0; $('#next').disabled = from + data.length >= count;
  };
  let timer;
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { L.q = $('#q').value; L.page = 0; draw(); }, 350); };
  ['fp', 'ft', 'fs'].forEach(i => $('#' + i).onchange = () => { L[i] = $('#' + i).value; L.page = 0; draw(); });
  $('#prev').onclick = () => { L.page--; draw(); }; $('#next').onclick = () => { L.page++; draw(); };
  $('#rows').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) go('#/asset/' + tr.dataset.id); };
  draw();
}

/* ---------- Asset detail: view, assign, status change, transfer ---------- */
async function viewAsset(id) {
  const a = await getAsset(id);
  if (!a) { view.innerHTML = '<div class="card">Asset not found. It may have been deleted.</div>'; return; }
  const assigned = !!a.property_id;
  const { data: mv } = await sb.from('movements').select('*').eq('asset_id', id).order('done_at', { ascending: false }).limit(30);
  const where = (p, r, st) => !p ? 'Unassigned' : propName(p) + ' / ' + (st ? 'Store' : (roomById(r) || {}).name || '-');
  const moveText = m => m.kind === 'transfer'
    ? 'Moved: ' + where(m.from_property, m.from_room, m.from_store) + ' → ' + where(m.to_property, m.to_room, m.to_store)
    : m.kind === 'assign' ? 'Assigned to ' + where(m.to_property, m.to_room, m.to_store) + ', status ' + m.new_status
      : 'Status: ' + m.old_status + ' → ' + m.new_status;
  const hist = (mv || []).map(m => `<tr><td>${new Date(m.done_at).toLocaleString()}</td><td>${esc(m.done_by_name)}</td><td>${esc(moveText(m))}${m.note ? '<br><span class="mute">' + esc(m.note) + '</span>' : ''}</td></tr>`).join('');

  const auditCard = `<div class="card"><h2>Audit</h2>
      <button class="btn sec" id="loc">Check my location</button>
      <p id="locmsg" class="mute">Tap to compare where you are with where this asset is recorded.</p>
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
      <p class="mute">This asset has been purchased but not placed yet. Choose where it goes and its condition, then print its QR label.</p>
      <div class="row">
        <div><label>Property *</label><select id="ap"><option value="">Choose property...</option>${S.props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div><label>Room / area *</label><select id="ar"></select></div>
        <div><label>Status *</label><select id="as"><option value="">Choose status...</option>${STATUSES.map(s => `<option value="${s}">${cap(s)}</option>`).join('')}</select></div>
        <div><label>Note (optional)</label><input id="an"></div>
      </div>
      <button class="btn" id="asg">Assign and go to label</button></div>`
    : '<div class="card"><h2>Not assigned yet</h2><p>This asset has not been placed in a property yet. The Projects team will assign it.</p></div>';

  view.innerHTML = `
    <div class="card">
      <h2>${tagOf(a)} - ${esc(a.item_type)} ${badge(a.status)}</h2>
      ${a.photo_url ? `<img class="photo" src="${esc(a.photo_url)}" alt="asset photo">` : ''}
      <div class="tw"><table>
        <tr><th>Description</th><td>${esc(a.description) || '-'}</td></tr>
        <tr><th>Property</th><td>${esc(propName(a.property_id))}</td></tr>
        <tr><th>Location</th><td>${esc(roomLabel(a))}</td></tr>
        <tr><th>Purchase date</th><td>${esc(a.purchase_date) || '-'}</td></tr>
        <tr><th>Purchase cost</th><td>${money(a.purchase_cost)}</td></tr>
        <tr><th>Vendor</th><td>${esc(a.vendor) || '-'}</td></tr>
        <tr><th>Warranty until</th><td>${esc(warrantyText(a))}</td></tr>
        <tr><th>Notes</th><td>${esc(a.notes) || '-'}</td></tr></table></div>
      ${canEdit() ? `<button class="btn sec" id="edit">Edit</button>${assigned ? '<button class="btn sec" id="prt">Print QR</button>' : ''}` : ''}
    </div>
    ${assigned ? auditCard : assignCard}
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
    $('#asg').onclick = async () => {
      try {
        const p = $('#ap').value, r = $('#ar').value, st = $('#as').value;
        if (!p || !r || !st) return fail(new Error('Choose a property, a room (or Store) and a status'));
        $('#asg').disabled = true;
        const toStore = r === 'STORE';
        const { error } = await sb.rpc('assign_asset', { p_asset: a.id, p_property: p, p_room: toStore ? null : r, p_to_store: toStore, p_status: st, p_note: $('#an').value.trim() || null });
        if (error) throw error;
        toast('Assigned. The label is ready to print.'); go('#/print/' + a.id);
      } catch (e) { $('#asg').disabled = false; fail(e); }
    };
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

  $('#loc').onclick = async () => {
    $('#locmsg').textContent = 'Getting your location...';
    const pos = await getPos();
    if (!pos) { $('#locmsg').innerHTML = '<span class="err">Could not get location. Allow location access in the browser.</span>'; return; }
    const withPin = S.props.filter(p => p.latitude != null && p.longitude != null)
      .map(p => ({ p, d: distM(pos.lat, pos.lng, p.latitude, p.longitude) })).sort((x, y) => x.d - y.d);
    if (!withPin.length) { $('#locmsg').textContent = 'No property has a geo location saved yet.'; return; }
    const near = withPin[0], rec = withPin.find(x => x.p.id === a.property_id);
    let msg = 'Nearest property to you: ' + near.p.name + ' (' + fmtDist(near.d) + ').';
    if (rec) msg += ' Recorded property ' + rec.p.name + ' is ' + fmtDist(rec.d) + ' away.';
    if (near.p.id !== a.property_id && near.d < 500) {
      msg += ' You appear to be at a different property than recorded - consider a transfer.';
      $('#tp').value = near.p.id; fillDest();
    }
    $('#locmsg').textContent = msg;
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
      <div><label>Description / model / serial</label><input id="ds" value="${esc(v.description)}"></div>
      ${locFields}
      <div><label>Purchase date</label><input id="pd" type="date" value="${esc(v.purchase_date)}"></div>
      <div><label>Purchase cost (per item)</label><input id="pc" type="number" step="0.01" value="${esc(v.purchase_cost)}"></div>
      <div><label>Vendor name</label><input id="vn" value="${esc(v.vendor)}"></div>
      <div><label>Warranty valid until</label><input id="wu" type="date" value="${esc(v.warranty_until)}"></div>
      ${addMode ? '<div><label>Number of copies (each gets its own tag and QR)</label><input id="nc" type="number" min="1" max="500" value="1"></div>' : ''}
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
      if (!a && !(copies >= 1 && copies <= 500)) return fail(new Error('Number of copies must be between 1 and 500'));
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
        item_type: $('#it').value.trim(), description: $('#ds').value.trim() || null, ...loc,
        purchase_date: $('#pd').value || null, purchase_cost: $('#pc').value === '' ? null : Number($('#pc').value),
        vendor: $('#vn').value.trim() || null, warranty_until: $('#wu').value || null, notes: $('#nt').value.trim() || null,
        photo_url, updated_at: new Date().toISOString()
      };
      S.types = null;
      if (a) {
        const { error } = await sb.from('assets').update(row).eq('id', a.id); if (error) throw error;
        toast('Saved'); go('#/asset/' + a.id);
      } else {
        const { data, error } = await sb.from('assets').insert(Array.from({ length: copies }, () => row)).select('id');
        if (error) throw error;
        if (copies === 1) { toast('Saved'); go('#/asset/' + data[0].id); }
        else if (loc.property_id) { S.printPre = { ids: data.map(x => x.id) }; toast(copies + ' assets created. Labels are ready to print.'); go('#/print'); }
        else { L.fp = '__none'; L.q = ''; L.ft = ''; L.fs = ''; L.page = 0; toast(copies + ' unassigned assets created. Assign each one before printing its label.'); go('#/assets'); }
      }
    } catch (e) { $('#save').disabled = false; fail(e); }
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
    <p class="mute">Every label reads "${esc(LABEL_TITLE)}" with the QR and tag number. Up to ${LABELS_PER} labels are shown per page; use Next for the rest. Print on A4 at 100% scale.</p></div>
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
    rows.forEach(a => {
      const d = document.createElement('div'); d.className = 'label';
      d.innerHTML = '<span class="ttl">' + esc(LABEL_TITLE) + '</span><div class="qr"></div><b>' + tagOf(a) + '</b><span>' + esc(a.item_type) + '</span><span>' + esc(propName(a.property_id)) + ' / ' + esc(roomLabel(a)) + '</span>';
      box.appendChild(d);
      new QRCode(d.querySelector('.qr'), { text: qrLink(a.id), width: 110, height: 110, correctLevel: QRCode.CorrectLevel.M });
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
    if (count && $('#un')) { $('#un').innerHTML = `<b>${count}</b> asset(s) are waiting to be assigned and cannot print yet. <button class="btn sec" id="seeun" style="margin:0">Show them</button>`; $('#seeun').onclick = () => { L.fp = '__none'; L.q = ''; L.ft = ''; L.fs = ''; L.page = 0; go('#/assets'); }; }
  });
  if (S.props.length) { fillRooms(); await fillAssets(); }
  if (st.ids) {
    $('#bn').textContent = st.ids.length === 1 ? 'Showing the label for the selected asset. Change the dropdowns and press Show labels to print others.' : `Showing labels for the ${st.ids.length} assets you just created or imported. Change the dropdowns and press Show labels to print others.`;
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
  ['description', 'No', 'Make / model / serial', 'Voltas 1.5 ton'],
  ['property', 'If placed', 'Property name, spelled exactly as in the Properties tab. Empty = not assigned yet', 'Property A'],
  ['room', 'If placed', 'Room / area name exactly as in the app, or the word STORE for the property store. Empty = not assigned yet', '101, Lobby, STORE'],
  ['status', 'If placed', 'working, repairable or damaged. Empty = not assigned yet', 'working'],
  ['purchase_date', 'No', 'YYYY-MM-DD (DD/MM/YYYY also works)', '2025-04-15'],
  ['purchase_cost', 'No', 'Cost of ONE item, numbers only', '2500'],
  ['vendor', 'No', 'Vendor name', 'ABC Furniture'],
  ['warranty_until', 'No', 'Last day of warranty, YYYY-MM-DD', '2027-04-14'],
  ['notes', 'No', 'Any note', ''],
  ['quantity', 'No', 'How many identical items this row creates; each gets its own tag and QR (blank = 1, max 1000)', '10']
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
    if (!isBlank(r.quantity)) { qty = Number(r.quantity); if (!Number.isInteger(qty) || qty < 1 || qty > 1000) bad.push('quantity must be a whole number from 1 to 1000'); }
    if (bad.length) { errors.push(`Row ${line}: ` + bad.join('; ')); return; }
    units += qty;
    rows.push({
      qty, roomKey: roomName ? prop.id + '|' + roomName.toLowerCase() : null,
      data: {
        item_type: item, description: String(r.description ?? '').trim() || null, property_id: prop ? prop.id : null, room_id: roomId, in_store: inStore,
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
    'Chair,Wooden dining chair,Property A,Lobby,working,2025-04-15,2500,ABC Furniture,2027-04-14,,10\n' +
    'Split AC,Voltas 1.5 ton,Property A,STORE,working,2024-06-01,38000,XYZ Traders,2029-05-31,Spare unit,1\n' +
    'Ceiling Fan,Purchased - not placed yet,,,,2025-09-10,3200,Fan Mart,2027-09-09,,20\n';
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
function viewProperties() {
  view.innerHTML = `<div class="card"><h2>Properties</h2>
    <div class="tw"><table><thead><tr><th>Name</th><th>Latitude</th><th>Longitude</th><th>Store location</th><th>Rooms</th><th></th></tr></thead><tbody>
    ${S.props.map(p => `<tr><td>${esc(p.name)}</td><td>${p.latitude ?? '-'}</td><td>${p.longitude ?? '-'}</td><td>${esc(p.store_location) || '-'}</td><td>${S.rooms.filter(r => r.property_id === p.id).length}</td><td><button class="btn sec" data-e="${p.id}" style="margin:0">Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="mute">No properties yet.</td></tr>'}
    </tbody></table></div></div>
    <div class="card"><h2 id="ft">Add property</h2>
    <div class="row">
      <div><label>Property name *</label><input id="pn"></div>
      <div><label>Store location (name or description)</label><input id="ps" placeholder="e.g. Basement store room"></div>
      <div><label>Latitude</label><input id="la" type="number" step="any"></div>
      <div><label>Longitude</label><input id="lo" type="number" step="any"></div>
    </div>
    <button class="btn sec" id="here">Use my current location</button><button class="btn" id="sp">Save property</button><button class="btn sec" id="np">Clear</button></div>
    <div class="card"><h2>Rooms / areas</h2>
    <label>Property</label><select id="rp">${S.props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
    <div id="rl" style="margin:10px 0"></div>
    <label>Add rooms (separate with commas or new lines; words like Lobby are fine)</label><textarea id="rn" placeholder="101, 102, Lobby, Gym"></textarea>
    <button class="btn" id="ar">Add rooms</button></div>`;
  let editing = null;
  const clear = () => { editing = null; ['pn', 'ps', 'la', 'lo'].forEach(i => { $('#' + i).value = ''; }); $('#ft').textContent = 'Add property'; };
  $('#np').onclick = clear;
  view.onclick = e => {
    const b = e.target.closest('button[data-e]'); if (b) {
      const p = propById(b.dataset.e); editing = p.id; $('#ft').textContent = 'Edit property';
      $('#pn').value = p.name; $('#ps').value = p.store_location || ''; $('#la').value = p.latitude ?? ''; $('#lo').value = p.longitude ?? '';
      $('#pn').scrollIntoView();
    }
  };
  $('#here').onclick = async () => {
    toast('Getting location...'); const p = await getPos(12000);
    if (!p) return fail(new Error('Could not get location. Allow location access.'));
    $('#la').value = p.lat.toFixed(6); $('#lo').value = p.lng.toFixed(6); toast('Location filled (accuracy about ' + Math.round(p.acc) + ' m)');
  };
  $('#sp').onclick = async () => {
    try {
      if (!$('#pn').value.trim()) return fail(new Error('Property name is required'));
      const row = { name: $('#pn').value.trim(), store_location: $('#ps').value.trim() || null, latitude: $('#la').value === '' ? null : Number($('#la').value), longitude: $('#lo').value === '' ? null : Number($('#lo').value) };
      const { error } = editing ? await sb.from('properties').update(row).eq('id', editing) : await sb.from('properties').insert(row);
      if (error) throw error;
      await loadMaster(); toast('Property saved'); viewProperties();
    } catch (e) { fail(e); }
  };
  const drawRooms = () => {
    const rooms = S.rooms.filter(r => r.property_id === $('#rp').value);
    $('#rl').innerHTML = rooms.length ? rooms.map(r => `<span class="badge working" style="margin:2px">${esc(r.name)} <a href="#" data-dr="${r.id}" style="color:inherit">x</a></span>`).join(' ') : '<span class="mute">No rooms yet.</span>';
  };
  const delRoom = async id => {
    if (!confirm('Delete this room? Assets in it will show no room.')) return;
    const { error } = await sb.from('rooms').delete().eq('id', id); if (error) return fail(error);
    await loadMaster(); drawRooms();
  };
  $('#rl').onclick = e => { const d = e.target.closest('[data-dr]'); if (d) { e.preventDefault(); delRoom(d.dataset.dr); } };
  $('#rp').onchange = drawRooms; drawRooms();
  $('#ar').onclick = async () => {
    try {
      const names = [...new Set($('#rn').value.split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
      if (!names.length || !$('#rp').value) return;
      const { error } = await sb.from('rooms').upsert(names.map(n => ({ property_id: $('#rp').value, name: n })), { onConflict: 'property_id,name', ignoreDuplicates: true });
      if (error) throw error;
      const keep = $('#rp').value; await loadMaster(); $('#rn').value = ''; $('#rp').value = keep; drawRooms(); toast(names.length + ' room(s) added');
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
