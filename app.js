// 古物台帳（無料・登録不要）
// データはすべてこの端末の IndexedDB に保存する。外に送るのは「住所を入れる」の郵便番号だけ。

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- 定数 ----------
const CATEGORIES = [
  '美術品類', '衣類', '時計・宝飾品類', '自動車', '自動二輪車・原動機付自転車', '自転車類', '写真機類',
  '事務機器類', '機械工具類', '道具類', '皮革・ゴム製品類', '書籍', '金券類',
];
// 1万円未満でも記録が必要な品物（古物営業法施行規則 第16条。2025-10-01 から室外機などを追加）
const SPECIALS = [
  'バイク・原付（部品含む）', 'ゲームソフト', 'CD・DVD・BDなど', '書籍',
  'エアコン室外機・ヒートポンプ・電線・金属グレーチング',
];
const SPECIAL_BY_CATEGORY = { '書籍': '書籍', '自動二輪車・原動機付自転車': 'バイク・原付（部品含む）' };
const TX_TYPES = { '受入': ['買受け', '交換', '委託を受けた'], '払出': ['売却', '交換', '委託先への引渡し', 'その他'] };
const THRESHOLD = 10000;
const LS = { draft: 'kd-draft', backup: 'kd-last-backup', want: 'kd-want' };

// ---------- 小物 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (Number(n) || 0).toLocaleString('ja-JP');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => toISODate(new Date());
function toISODate(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 使えない環境では何もしない */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// 計測（アクセス解析を入れたときだけ動く。台帳の中身は送らない）
function track(name) {
  try { window.goatcounter?.count?.({ path: 'event/' + name, title: name, event: true }); } catch { /* なし */ }
}

function ageAt(birth, onDate) {
  if (!birth) return '';
  const b = new Date(birth), d = new Date(onDate || today());
  if (isNaN(b) || isNaN(d)) return '';
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a >= 0 && a < 130 ? String(a) : '';
}

// ---------- IndexedDB ----------
const dbp = new Promise((resolve, reject) => {
  if (!('indexedDB' in window)) return reject(new Error('no-idb'));
  const r = indexedDB.open('kobutsu-daicho', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('records', { keyPath: 'id' }).createIndex('date', 'date');
    db.createObjectStore('partners', { keyPath: 'id' });
    db.createObjectStore('photos', { keyPath: 'id' });
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function os(name, mode = 'readonly') { return (await dbp).transaction(name, mode).objectStore(name); }
const getAll = async (n) => req((await os(n)).getAll());
const getOne = async (n, k) => req((await os(n)).get(k));
const put = async (n, v) => req((await os(n, 'readwrite')).put(v));
const del = async (n, k) => req((await os(n, 'readwrite')).delete(k));
const clearStore = async (n) => req((await os(n, 'readwrite')).clear());

async function askPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* なし */ }
}

// ---------- タブ ----------
function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'list') renderList();
  if (name === 'stats') renderStats();
  if (name === 'partners') renderPartners();
  if (name === 'export') renderExportInfo();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- 記録フォーム ----------
const form = $('#recForm');
let editingId = null;          // 編集中の記録 id
let photos = [];               // { id, blob, url, isNew }
let removedPhotoIds = [];

function kind() { return form.kind.value; }

function fillTxTypes(selected) {
  form.txType.innerHTML = TX_TYPES[kind()].map((t) => `<option>${esc(t)}</option>`).join('');
  if (selected && TX_TYPES[kind()].includes(selected)) form.txType.value = selected;
}

function itemRow(it = {}) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = `
    <div class="item-head"><span class="item-no"></span><button type="button" class="link rm">この品物を消す</button></div>
    <div class="item-grid">
      <label>品目区分 <em class="req">必須</em>
        <select data-f="category"><option value="">選んでください</option>${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      </label>
      <label class="wide">品名 <em class="req">必須</em><input data-f="name" placeholder="例：腕時計 SEIKO"></label>
      <label class="full">特徴（色・型番・サイズ・傷など） <em class="req">必須</em><input data-f="features" placeholder="例：シルバー、型番SBGA211、裏ぶたに小傷"></label>
      <label class="half">数量 <em class="req">必須</em><input data-f="qty" inputmode="numeric" value="1"></label>
      <label class="half">金額（円）<input data-f="price" inputmode="numeric" placeholder="0"></label>
      <label class="wide">1万円未満でも記録が必要な品物
        <select data-f="special"><option value="">該当しない</option>${SPECIALS.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
      </label>
    </div>`;
  for (const [k, v] of Object.entries(it)) {
    const f = $(`[data-f="${k}"]`, el);
    if (f && v != null) f.value = v;
  }
  $('[data-f="category"]', el).addEventListener('change', (e) => {
    const sp = SPECIAL_BY_CATEGORY[e.target.value];
    if (sp) $('[data-f="special"]', el).value = sp;
    update();
  });
  $('.rm', el).addEventListener('click', () => {
    if ($$('#items .item').length <= 1) { clearItem(el); } else { el.remove(); }
    update();
  });
  return el;
}
function clearItem(el) { $$('[data-f]', el).forEach((f) => { f.value = f.dataset.f === 'qty' ? '1' : ''; }); }
function addItem(it) { $('#items').append(itemRow(it)); numberItems(); }
function numberItems() { $$('#items .item').forEach((el, i) => { $('.item-no', el).textContent = `品物 ${i + 1}`; }); }
function readItems() {
  return $$('#items .item').map((el) => {
    const o = {};
    $$('[data-f]', el).forEach((f) => { o[f.dataset.f] = f.value.trim(); });
    o.qty = o.qty.replace(/[^\d]/g, '') || '';
    o.price = o.price.replace(/[^\d]/g, '') || '';
    return o;
  }).filter((o) => o.name || o.category || o.features || o.price);
}

/** 1万円ルールの目安（受け入れのときだけ） */
function judge(items) {
  const total = items.reduce((s, it) => s + (Number(it.price) || 0), 0);
  if (kind() !== '受入' || items.length === 0) return { total, need: null };
  const special = items.find((it) => it.special);
  if (special) return { total, need: true, why: `「${special.special}」は金額に関係なく記録が必要です` };
  if (total >= THRESHOLD) return { total, need: true, why: '総額が1万円以上なので、本人確認と記録が必要です' };
  if (total === 0) return { total, need: null };
  return { total, need: false, why: '総額1万円未満で、特定の品物もないので、原則は記録不要です（記録しておくのは自由です）。迷ったら管轄の警察署へ。' };
}

function update() {
  numberItems();
  const items = readItems();
  const j = judge(items);
  $('#totalYen').textContent = yen(j.total);
  const badge = $('#judge'), note = $('#judgeNote');
  if (j.need === null) { badge.hidden = true; note.hidden = true; }
  else {
    badge.hidden = false; note.hidden = false;
    badge.className = 'judge ' + (j.need ? 'need' : 'free');
    badge.textContent = j.need ? '記録が必要です' : '原則 記録不要（目安）';
    note.textContent = j.why;
  }
  // 払い出しは品目によって相手方の記録が必要なので「必須」表示を外す
  $$('[data-req]', form).forEach((e) => e.classList.toggle('off', kind() !== '受入'));
  // 生年月日から年齢
  const a = ageAt(form.pBirth.value, form.date.value);
  if (a) form.pAge.value = a;
  saveDraft();
}

function formState() {
  return {
    kind: kind(), txType: form.txType.value, date: form.date.value, items: readItems(),
    partner: {
      name: form.pName.value.trim(), zip: form.pZip.value.trim(), address: form.pAddress.value.trim(),
      job: form.pJob.value.trim(), birth: form.pBirth.value, age: form.pAge.value.replace(/[^\d]/g, ''),
      phone: form.pPhone.value.trim(),
    },
    partnerId: $('#partnerPick').value || null,
    idMethod: form.idMethod.value, idNote: form.idNote.value.trim(),
    staff: form.staff.value.trim(), memo: form.memo.value.trim(),
    savePartner: form.savePartner.checked,
  };
}

function setForm(s) {
  form.querySelector(`input[name="kind"][value="${s.kind || '受入'}"]`).checked = true;
  fillTxTypes(s.txType);
  form.date.value = s.date || today();
  $('#items').innerHTML = '';
  (s.items?.length ? s.items : [{}]).forEach((it) => addItem(it));
  const p = s.partner || {};
  form.pName.value = p.name || ''; form.pZip.value = p.zip || ''; form.pAddress.value = p.address || '';
  form.pJob.value = p.job || ''; form.pBirth.value = p.birth || ''; form.pAge.value = p.age || ''; form.pPhone.value = p.phone || '';
  $('#partnerPick').value = s.partnerId || '';
  form.idMethod.value = s.idMethod || ''; form.idNote.value = s.idNote || '';
  form.staff.value = s.staff || ''; form.memo.value = s.memo || '';
  form.savePartner.checked = s.savePartner !== false;
  update();
}

function saveDraft() {
  if (editingId) return;
  lsSet(LS.draft, JSON.stringify(formState()));
}

function readDraft() {
  try {
    const d = JSON.parse(lsGet(LS.draft) || 'null');
    return d && (d.items?.length || d.partner?.name) ? d : null;
  } catch { return null; }
}

function clearPhotos() {
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = []; removedPhotoIds = [];
  renderPhotos();
}

/** 新しく書く状態に戻す。編集から戻るときは、書きかけの下書きがあればそれを戻す */
function resetForm() {
  const wasEditing = !!editingId;
  editingId = null;
  clearPhotos();
  $('#editNote').hidden = true; $('#deleteBtn').hidden = true; $('#saveBtn').textContent = '保存する';
  // 担当者は続けて使うことが多いので残す
  const staff = form.staff.value;
  const draft = wasEditing ? readDraft() : null;
  if (draft) { setForm(draft); return; }
  setForm({ staff });
  lsDel(LS.draft);
}

form.addEventListener('input', update);
form.addEventListener('change', (e) => {
  if (e.target.name === 'kind') fillTxTypes();
  update();
});
$('#addItem').addEventListener('click', () => { addItem(); $('#items .item:last-child [data-f="category"]').focus(); });
$('#clearBtn').addEventListener('click', () => {
  if (confirm('入力中の内容を消しますか？')) { resetForm(); }
});
$('#cancelEdit').addEventListener('click', resetForm);

// ---------- 写真 ----------
async function shrink(file, max = 1280) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.82));
  } catch { return file; }
}
$('#photoInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    if (!f.type.startsWith('image/')) continue;
    const blob = await shrink(f);
    photos.push({ id: uid(), blob, url: URL.createObjectURL(blob), isNew: true });
  }
  e.target.value = '';
  renderPhotos();
});
function renderPhotos() {
  const list = $('#photoList');
  list.innerHTML = '';
  photos.forEach((p, i) => {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img src="${p.url}" alt="品物の写真 ${i + 1}"><button type="button" aria-label="写真を外す">×</button>`;
    $('button', fig).addEventListener('click', () => {
      if (!p.isNew) removedPhotoIds.push(p.id);
      URL.revokeObjectURL(p.url);
      photos.splice(i, 1);
      renderPhotos();
    });
    list.append(fig);
  });
}

// ---------- 郵便番号 → 住所 ----------
$('#zipBtn').addEventListener('click', async () => {
  const zip = form.pZip.value.replace(/[^\d]/g, '');
  if (zip.length !== 7) { toast('郵便番号を7桁で入れてください'); return; }
  try {
    const r = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`);
    const d = await r.json();
    const a = d.results?.[0];
    if (!a) { toast('住所が見つかりませんでした'); return; }
    form.pAddress.value = `${a.address1}${a.address2}${a.address3}`;
    form.pAddress.focus();
    update();
  } catch { toast('住所を取得できませんでした（通信を確認してください）'); }
});

// ---------- 取引相手 ----------
async function refreshPartnerPick() {
  const ps = (await getAll('partners')).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const sel = $('#partnerPick'), cur = sel.value;
  sel.innerHTML = '<option value="">（新しい相手を入力）</option>' +
    ps.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.address ? '（' + esc(p.address.slice(0, 14)) + '）' : ''}</option>`).join('');
  if (ps.some((p) => p.id === cur)) sel.value = cur;
}
$('#partnerPick').addEventListener('change', async (e) => {
  const p = e.target.value ? await getOne('partners', e.target.value) : null;
  const P = p || {};
  form.pName.value = P.name || ''; form.pZip.value = P.zip || ''; form.pAddress.value = P.address || '';
  form.pJob.value = P.job || ''; form.pBirth.value = P.birth || ''; form.pPhone.value = P.phone || '';
  form.pAge.value = P.birth ? ageAt(P.birth, form.date.value) : '';
  update();
});

async function upsertPartner(s) {
  const p = s.partner;
  if (!p.name) return null;
  const all = await getAll('partners');
  const found = (s.partnerId && all.find((x) => x.id === s.partnerId)) ||
    all.find((x) => x.name === p.name && x.address === p.address);
  const rec = { ...(found || { id: uid(), createdAt: Date.now() }), name: p.name, zip: p.zip, address: p.address, job: p.job, birth: p.birth, phone: p.phone, updatedAt: Date.now() };
  await put('partners', rec);
  return rec.id;
}

// ---------- 保存・削除 ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = formState();
  if (!s.date) { toast('取引年月日を入れてください'); form.date.focus(); return; }
  if (s.items.length === 0 || s.items.some((it) => !it.name)) { toast('品物の品名を入れてください'); $('#items [data-f="name"]').focus(); return; }

  if (s.kind === '受入' && judge(s.items).need !== false) {
    const miss = [];
    if (s.items.some((it) => !it.category)) miss.push('品目区分');
    if (s.items.some((it) => !it.features)) miss.push('特徴');
    if (!s.partner.name) miss.push('相手の氏名');
    if (!s.partner.address) miss.push('住所');
    if (!s.partner.job) miss.push('職業');
    if (!s.partner.age) miss.push('年齢');
    if (!s.idMethod) miss.push('本人確認の方法');
    if (miss.length && !confirm(`法律で記録が必要な項目が未記入です：\n${miss.join('、')}\n\nこのまま保存しますか？（あとで直せます）`)) return;
  }

  try {
    const partnerId = s.savePartner ? await upsertPartner(s) : s.partnerId;
    for (const p of photos.filter((x) => x.isNew)) await put('photos', { id: p.id, blob: p.blob, type: p.blob.type });
    for (const id of removedPhotoIds) await del('photos', id);
    const old = editingId ? await getOne('records', editingId) : null;
    const rec = {
      id: editingId || uid(),
      kind: s.kind, txType: s.txType, date: s.date,
      items: s.items, total: judge(s.items).total,
      partner: { ...s.partner }, partnerId: partnerId || null,
      idMethod: s.idMethod, idNote: s.idNote, staff: s.staff, memo: s.memo,
      photoIds: photos.map((p) => p.id),
      createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    await put('records', rec);
    track(editingId ? 'record-update' : 'record-save');
    askPersist();
    toast(editingId ? '記録を直しました' : '保存しました');
    resetForm();
    refreshPartnerPick();
    checkBackupBanner();
  } catch (err) {
    console.error(err);
    alert('保存できませんでした。ブラウザの空き容量やプライベートモードを確認してください。');
  }
});

async function openRecord(id) {
  const r = await getOne('records', id);
  if (!r) return;
  clearPhotos();
  editingId = r.id;
  setForm({ ...r, savePartner: false });
  for (const pid of r.photoIds || []) {
    const ph = await getOne('photos', pid);
    if (ph) photos.push({ id: pid, blob: ph.blob, url: URL.createObjectURL(ph.blob), isNew: false });
  }
  renderPhotos();
  $('#editNote').hidden = false; $('#deleteBtn').hidden = false; $('#saveBtn').textContent = '直して保存';
  showTab('form');
  $('#app').scrollIntoView();
}

$('#deleteBtn').addEventListener('click', async () => {
  if (!editingId || !confirm('この記録を削除しますか？（元に戻せません）')) return;
  const r = await getOne('records', editingId);
  for (const pid of r?.photoIds || []) await del('photos', pid);
  await del('records', editingId);
  toast('削除しました');
  resetForm();
  showTab('list');
});

// ---------- 台帳一覧 ----------
function itemsLabel(r) { return r.items.map((it) => it.name).filter(Boolean).join('、'); }

async function renderList() {
  const month = $('#fMonth').value, all = $('#fAll').checked, k = $('#fKind').value, q = $('#fText').value.trim().toLowerCase();
  $('#fMonth').disabled = all;
  let rs = await getAll('records');
  rs = rs.filter((r) => (all || !month || r.date.startsWith(month)) && (!k || r.kind === k));
  if (q) {
    rs = rs.filter((r) => [itemsLabel(r), r.partner?.name, r.partner?.address, r.memo, ...r.items.map((it) => it.features)]
      .join(' ').toLowerCase().includes(q));
  }
  rs.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const total = rs.reduce((s, r) => s + (r.total || 0), 0);
  $('#listSummary').textContent = `${rs.length}件　合計 ${yen(total)}円`;
  const box = $('#recList');
  if (rs.length === 0) { box.innerHTML = '<p class="empty">この条件の記録はありません。</p>'; return; }
  box.innerHTML = rs.map((r) => `
    <button class="rec" data-id="${esc(r.id)}">
      <span class="d">${esc(r.date.replaceAll('-', '/'))}</span>
      <span class="t"><span class="tag ${r.kind === '払出' ? 'out' : ''}">${esc(r.kind)}</span>${esc(itemsLabel(r))}</span>
      <span class="y">${yen(r.total)}円</span>
      <span class="s">${esc(r.partner?.name || '相手方なし')}${r.photoIds?.length ? '　📷' + r.photoIds.length : ''}</span>
    </button>`).join('');
  $$('.rec', box).forEach((b) => b.addEventListener('click', () => openRecord(b.dataset.id)));
}
['#fMonth', '#fAll', '#fKind'].forEach((s) => $(s).addEventListener('change', renderList));
$('#fText').addEventListener('input', renderList);

// ---------- 集計・グラフ ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
/** 目盛りが切りのいい数になる上限 */
function niceMax(v) {
  if (v <= 0) return 10000;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}
const shortYen = (n) => (n >= 10000 ? `${+(n / 10000).toFixed(1)}万` : yen(n));

function monthKeys(range, rs) {
  const now = new Date();
  const key = (d) => toISODate(d).slice(0, 7);
  let start;
  if (range === 'year') start = new Date(now.getFullYear(), 0, 1);
  else if (range === 'all') {
    const first = rs.map((r) => r.date).sort()[0];
    start = first ? new Date(first.slice(0, 7) + '-01T00:00') : new Date(now.getFullYear(), now.getMonth(), 1);
  } else start = new Date(now.getFullYear(), now.getMonth() - (Number(range) - 1), 1);
  const keys = [];
  for (let d = new Date(start); key(d) <= key(now); d.setMonth(d.getMonth() + 1)) keys.push(key(d));
  return keys.slice(-36); // 多すぎると読めないので最大3年
}

function drawMonthly(keys, inBy, outBy) {
  const W = 640, H = 240, L = 48, B = 28, T = 12, R = 8;
  const max = niceMax(Math.max(0, ...keys.map((k) => Math.max(inBy[k] || 0, outBy[k] || 0))));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '月ごとの仕入れと売上の棒グラフ' });
  const plotH = H - B - T, slot = (W - L - R) / keys.length, bw = Math.max(3, Math.min(18, slot * 0.36));
  for (let i = 0; i <= 4; i++) {
    const y = T + plotH - (plotH * i) / 4;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'grid-line' }));
    svg.append(svgEl('text', { x: L - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }, shortYen((max * i) / 4)));
  }
  const every = Math.ceil(keys.length / 12);
  keys.forEach((k, i) => {
    const cx = L + slot * i + slot / 2;
    const vals = [[inBy[k] || 0, 'bar-in', '仕入れ'], [outBy[k] || 0, 'bar-out', '売上']];
    vals.forEach(([v, cls, label], j) => {
      const h = (plotH * v) / max;
      const rect = svgEl('rect', { x: cx - bw + j * bw, y: T + plotH - h, width: bw - 1, height: Math.max(0, h), class: cls, rx: 2 });
      rect.append(svgEl('title', {}, `${k.replace('-', '年')}月 ${label} ${yen(v)}円`));
      svg.append(rect);
    });
    if (i % every === 0) {
      const m = Number(k.slice(5));
      svg.append(svgEl('text', { x: cx, y: H - 8, class: 'axis', 'text-anchor': 'middle' }, m === 1 || i === 0 ? `${k.slice(2, 4)}/${m}` : `${m}月`));
    }
  });
  return svg;
}

function drawHBars(rows) {
  // rows: [{ label, a, b }]  a=仕入れ b=売上
  const W = 640, rowH = 34, L = 150, R = 90, H = rows.length * rowH + 4;
  const max = niceMax(Math.max(1, ...rows.map((r) => Math.max(r.a, r.b))));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '品目区分ごとの仕入れと売上' });
  rows.forEach((r, i) => {
    const y = i * rowH + 4, span = W - L - R;
    svg.append(svgEl('text', { x: L - 8, y: y + 18, class: 'label', 'text-anchor': 'end' }, r.label.length > 10 ? r.label.slice(0, 10) + '…' : r.label));
    svg.append(svgEl('rect', { x: L, y, width: Math.max(r.a ? 2 : 0, (span * r.a) / max), height: 12, class: 'bar-in', rx: 2 }));
    svg.append(svgEl('rect', { x: L, y: y + 14, width: Math.max(r.b ? 2 : 0, (span * r.b) / max), height: 12, class: 'bar-out', rx: 2 }));
    svg.append(svgEl('text', { x: W - R + 6, y: y + 11, class: 'axis' }, r.a ? shortYen(r.a) + '円' : ''));
    svg.append(svgEl('text', { x: W - R + 6, y: y + 25, class: 'axis' }, r.b ? shortYen(r.b) + '円' : ''));
  });
  return svg;
}

async function renderStats() {
  const range = $('#sRange').value;
  const all = await getAll('records');
  const keys = monthKeys(range, all);
  const from = keys[0], to = keys[keys.length - 1];
  const rs = all.filter((r) => r.date.slice(0, 7) >= from && r.date.slice(0, 7) <= to);
  const ins = rs.filter((r) => r.kind === '受入'), outs = rs.filter((r) => r.kind === '払出');
  const sum = (a) => a.reduce((s, r) => s + (r.total || 0), 0);
  const tIn = sum(ins), tOut = sum(outs);
  $('#sIn').textContent = `${yen(tIn)}円`; $('#sInN').textContent = `${ins.length}件`;
  $('#sOut').textContent = `${yen(tOut)}円`; $('#sOutN').textContent = `${outs.length}件`;
  $('#sDiff').textContent = `${tOut - tIn < 0 ? '−' : ''}${yen(Math.abs(tOut - tIn))}円`;

  const inBy = {}, outBy = {};
  for (const r of rs) {
    const m = r.date.slice(0, 7), t = r.kind === '受入' ? inBy : outBy;
    t[m] = (t[m] || 0) + (r.total || 0);
  }
  const mBox = $('#chartMonthly');
  mBox.replaceChildren(rs.length ? drawMonthly(keys, inBy, outBy) : Object.assign(document.createElement('p'), { className: 'empty', textContent: 'この期間の記録はまだありません。' }));

  const cat = {};
  for (const r of rs) for (const it of r.items) {
    const c = it.category || '未分類';
    cat[c] ??= { label: c, a: 0, b: 0 };
    cat[c][r.kind === '受入' ? 'a' : 'b'] += Number(it.price) || 0;
  }
  const catRows = Object.values(cat).sort((x, y) => (y.a + y.b) - (x.a + x.b)).slice(0, 8);
  $('#chartCategory').replaceChildren(catRows.length ? drawHBars(catRows) : Object.assign(document.createElement('p'), { className: 'empty', textContent: '—' }));

  const byP = {};
  for (const r of ins) {
    const n = r.partner?.name;
    if (!n) continue;
    byP[n] ??= { n: 0, y: 0 };
    byP[n].n++; byP[n].y += r.total || 0;
  }
  const top = Object.entries(byP).sort((a, b) => b[1].n - a[1].n || b[1].y - a[1].y).slice(0, 5);
  $('#topPartners').innerHTML = top.length
    ? `<ol class="top-list">${top.map(([n, v]) => `<li><span>${esc(n)}</span><span>${v.n}件・${yen(v.y)}円</span></li>`).join('')}</ol>`
    : '<p class="empty">—</p>';
  track('stats-view');
}
$('#sRange').addEventListener('change', renderStats);

// ---------- 取引相手の一覧 ----------
async function renderPartners() {
  const [ps, rs] = await Promise.all([getAll('partners'), getAll('records')]);
  const count = {};
  rs.forEach((r) => { if (r.partnerId) count[r.partnerId] = (count[r.partnerId] || 0) + 1; });
  ps.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const box = $('#partnerList');
  if (ps.length === 0) { box.innerHTML = '<p class="empty">保存した相手はまだいません。記録するときに「この相手を保存」にチェックすると、ここに出ます。</p>'; return; }
  box.innerHTML = ps.map((p) => `
    <div class="box" data-id="${esc(p.id)}">
      <div class="grid2">
        <label>氏名<input data-k="name" value="${esc(p.name)}"></label>
        <label>職業<input data-k="job" value="${esc(p.job)}"></label>
        <label>郵便番号<input data-k="zip" value="${esc(p.zip)}"></label>
        <label>住所<input data-k="address" value="${esc(p.address)}"></label>
        <label>生年月日<input type="date" data-k="birth" value="${esc(p.birth)}"></label>
        <label>電話<input data-k="phone" value="${esc(p.phone)}"></label>
      </div>
      <p class="summary">取引 ${count[p.id] || 0}件</p>
      <div class="actions">
        <button class="btn primary small" data-act="save">直して保存</button>
        <button class="btn danger small" data-act="del">この相手を消す</button>
      </div>
    </div>`).join('');
  $$('.box', box).forEach((el) => {
    el.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      const id = el.dataset.id;
      if (act === 'save') {
        const p = await getOne('partners', id);
        $$('[data-k]', el).forEach((f) => { p[f.dataset.k] = f.value.trim(); });
        p.updatedAt = Date.now();
        await put('partners', p);
        toast('相手の情報を直しました');
      } else if (act === 'del' && confirm('この相手を保存リストから消しますか？（過去の記録は消えません）')) {
        await del('partners', id);
        renderPartners();
      }
      refreshPartnerPick();
    });
  });
}

// ---------- 出力（印刷・PDF・CSV） ----------
async function recordsInRange() {
  const from = $('#exFrom').value, to = $('#exTo').value, k = $('#exKind').value;
  const rs = (await getAll('records'))
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to) && (!k || r.kind === k))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  return { rs, from, to };
}
const COLS = ['取引年月日', '区分', '取引の種類', '品目区分', '品名', '特徴', '数量', '金額', '相手方の住所', '相手方の氏名', '職業', '年齢', '確認の方法', '担当者', '備考'];
function rowsOf(rs) {
  const rows = [];
  for (const r of rs) {
    for (const it of r.items) {
      rows.push([r.date, r.kind, r.txType, it.category, it.name, it.features, it.qty, it.price,
        r.partner?.address, r.partner?.name, r.partner?.job, r.partner?.age, [r.idMethod, r.idNote].filter(Boolean).join(' '), r.staff, r.memo]);
    }
  }
  return rows;
}

$('#printBtn').addEventListener('click', async () => {
  const { rs, from, to } = await recordsInRange();
  if (rs.length === 0) { toast('この期間の記録はありません'); return; }
  const rows = rowsOf(rs);
  const cols = COLS.filter((c) => c !== '備考');
  $('#print').innerHTML = `
    <h1>古物台帳</h1>
    <p class="meta">期間：${esc(from || '最初')} 〜 ${esc(to || '最後')}　件数：${rs.length}件　出力日：${today()}</p>
    <table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.slice(0, cols.length).map((v, i) => `<td class="${i === 6 || i === 7 ? 'num' : ''}">${esc(i === 7 && v ? yen(v) : v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  track('export-print');
  window.print();
});

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

$('#csvBtn').addEventListener('click', async () => {
  const { rs, from, to } = await recordsInRange();
  if (rs.length === 0) { toast('この期間の記録はありません'); return; }
  const lines = [COLS, ...rowsOf(rs)].map((r) => r.map(csvCell).join(','));
  // Excel で文字化けしないよう BOM を付ける
  download(`古物台帳_${from || 'all'}_${to || today()}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
  track('export-csv');
});

// ---------- バックアップ ----------
const blobToB64 = (b) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); });
function b64ToBlob(b64, type) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }

$('#backupBtn').addEventListener('click', async () => {
  const [records, partners, ph] = await Promise.all([getAll('records'), getAll('partners'), getAll('photos')]);
  const photosOut = [];
  for (const p of ph) photosOut.push({ id: p.id, type: p.type || p.blob.type, data: await blobToB64(p.blob) });
  const data = { app: 'kobutsu-daicho', version: 1, exportedAt: new Date().toISOString(), records, partners, photos: photosOut };
  download(`古物台帳バックアップ_${today()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
  lsSet(LS.backup, String(Date.now()));
  track('backup');
  renderExportInfo();
  checkBackupBanner();
});

$('#restoreInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { alert('バックアップのファイルを読めませんでした。'); return; }
  if (data?.app !== 'kobutsu-daicho' || !Array.isArray(data.records)) { alert('このアプリのバックアップではないようです。'); return; }
  if (!confirm(`記録${data.records.length}件・相手${data.partners?.length || 0}件を戻します。\n今のデータに追加されます（同じ記録は上書き）。よろしいですか？`)) return;
  try {
    for (const p of data.photos || []) await put('photos', { id: p.id, type: p.type, blob: b64ToBlob(p.data, p.type) });
    for (const p of data.partners || []) await put('partners', p);
    for (const r of data.records) await put('records', r);
    toast('バックアップから戻しました');
    refreshPartnerPick();
    renderExportInfo();
    checkBackupBanner();
  } catch (err) {
    console.error(err);
    alert('途中で失敗しました。もう一度試してください。');
  }
});

$('#wipeBtn').addEventListener('click', async () => {
  if (!confirm('この端末の古物台帳のデータをすべて消します。先にバックアップを保存しましたか？')) return;
  if (prompt('本当に消す場合は「消す」と入力してください') !== '消す') return;
  await Promise.all(['records', 'partners', 'photos'].map(clearStore));
  lsDel(LS.draft);
  toast('すべて消しました');
  resetForm();
  refreshPartnerPick();
  renderExportInfo();
});

async function renderExportInfo() {
  const n = (await getAll('records')).length;
  const last = Number(lsGet(LS.backup));
  $('#backupInfo').textContent = `記録 ${n}件　最後のバックアップ：${last ? new Date(last).toLocaleDateString('ja-JP') : 'まだありません'}`;
  let persisted = false;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* なし */ }
  $('#persistInfo').textContent = persisted ? 'このブラウザは、データを自動で消さない設定になっています。' : '';
}

async function checkBackupBanner() {
  const n = (await getAll('records')).length;
  const last = Number(lsGet(LS.backup));
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  const b = $('#banner');
  if (n >= 5 && (days === null || days >= 30)) {
    b.innerHTML = `${days === null ? 'まだバックアップがありません' : `最後のバックアップから${days}日たっています`}。データはこの端末の中だけにあるので、<button class="link" id="goBackup">出力・保存</button>からバックアップしてください。`;
    b.hidden = false;
    $('#goBackup').addEventListener('click', () => showTab('export'));
  } else { b.hidden = true; }
}

// ---------- 「払ってでも使いたい」ボタン ----------
(function wants() {
  let pressed = [];
  try { pressed = JSON.parse(lsGet(LS.want) || '[]'); } catch { /* なし */ }
  $$('[data-want]').forEach((b) => {
    if (pressed.includes(b.dataset.want)) b.classList.add('on');
    b.addEventListener('click', () => {
      if (pressed.includes(b.dataset.want)) return;
      pressed.push(b.dataset.want);
      lsSet(LS.want, JSON.stringify(pressed));
      b.classList.add('on');
      track('want-' + b.dataset.want);
      $('#wantThanks').hidden = false;
    });
  });
})();

// ---------- 起動 ----------
(async function init() {
  const now = new Date();
  $('#fMonth').value = toISODate(now).slice(0, 7);
  $('#exFrom').value = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  $('#exTo').value = today();

  try { await dbp; } catch {
    const b = $('#banner');
    b.textContent = 'このブラウザでは保存機能が使えません（プライベートモードの可能性があります）。通常のモードで開いてください。';
    b.hidden = false;
    $('#saveBtn').disabled = true;
    return;
  }

  const draft = readDraft();
  const hasDraft = !!draft;
  setForm(draft || {});
  if (hasDraft) toast('書きかけの下書きを戻しました');

  await refreshPartnerPick();
  if (hasDraft && draft.partnerId) $('#partnerPick').value = draft.partnerId;
  checkBackupBanner();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしでも動く */ });
  }
})();
