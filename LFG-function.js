'use strict';
import { db, auth } from "./firebase.js";
import { signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
         query as fsQuery, where, writeBatch, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

async function saveProfile() {
  if (!me.id) return;
  try {
    await setDoc(doc(db, 'users', me.id), { name: me.name, updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.warn('profile', e); }
}

/* =====================================================================
   KababayanQueue  |  LFG-function.js   (Firestore version)
   ---------------------------------------------------------------------
   Firestore layout:
     posts/{postId}                  public post data (+ accepted count)
     posts/{postId}/secret/gameid    {gameId}  UID / IGN / party link.
                                     Readable only by the host and accepted players.
     requests/{postId}_{userId}      {postId,hostId,userId,name,info,status,at}
                                     Readable only by the host and the requester.
     blocks/{byId}_{blockedId}       {by,id,name}
     admins/{userId}                 empty doc = admin (create it by hand in the console)
   Users sign in anonymously (Firebase Auth), so the user id is stable per browser.
   Security is enforced by firestore.rules (included in this project).
   ===================================================================== */

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = d => new Date(d).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
const localMin = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/* ---------- game rules ---------- */
const GAMES = {
  genshin:  { label: 'Genshin',  color: 'yellow', max: 4,  idLabel: 'UID (User Identification Number)', idHint: 'e.g. 812345678',
              activities: ['Daily Commissions', 'Weekly Bosses', 'Artifact Farming', 'Stygian Onslaught', 'Ascension Material', 'Casual', 'Random'],
              icon: '<path d="M12 1l3 8 8 3-8 3-3 8-3-8-8-3 8-3z"/>' },
  valorant: { label: 'Valorant', color: 'red',    max: 5,  idLabel: 'Party code or party link', idHint: 'Paste your party code or link',
              activities: ['Competitive', 'Unrated', 'Custom'],
              icon: '<path d="M2 4h6l4 10 4-10h6L14 21h-4z"/>' },
  roblox:   { label: 'Roblox',   color: 'blue',   max: 12, idLabel: 'In Game Name (IGN)', idHint: 'Your Roblox username',
              activities: null, /* free text: preferred Roblox game */
              icon: '<path d="M5 3l16 4-4 16L1 19z"/>' }
};
const ic = g => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${GAMES[g].icon}</svg>`;
const idWord = g => GAMES[g].idLabel.split(' (')[0];

/* ---------- local storage (display name only) ---------- */
const store = {
  get(k, def) { try { return JSON.parse(localStorage.getItem('kq3_' + k)) ?? def; } catch { return def; } },
  set(k, v)   { try { localStorage.setItem('kq3_' + k, JSON.stringify(v)); } catch { /* ignore */ } }
};

/* ---------- state ---------- */
let me = { id: '', name: String(store.get('name', '') || ('Player' + (100 + Math.floor(Math.random() * 900)))).slice(0, 24) };
let canAdmin = false;          /* real admin (admins/{uid} exists) */
let isAdmin = false;           /* admin mode switch, only possible when canAdmin */
let posts = [], myRequests = [], hostReqs = [], blocksByMe = [], blocksOnMe = [];
const secrets = {};            /* postId -> gameId text (only for posts I host or was accepted in) */
let view = 'home', filter = 'all', query = '';
let started = false;

/* ---------- derived helpers ---------- */
function cleanPost(p) {
  const g = GAMES[p.game];
  if (!g || !p.id) return null;
  return {
    ...p,
    hostId: String(p.hostId ?? ''), hostName: String(p.hostName ?? 'Unknown'),
    activity: String(p.activity ?? ''), total: Math.min(Math.max(+p.total || 2, 2), g.max),
    req: String(p.req ?? ''), desc: String(p.desc ?? ''),
    date: p.date || localMin(), accepted: Math.max(+p.accepted || 0, 0),
    flags: Array.isArray(p.flags) ? p.flags : [], flagged: !!p.flagged
  };
}
const acceptedCount = p => Math.min(+p.accepted || 0, p.total - 1);
const filled   = p => 1 + acceptedCount(p);              /* host counts automatically */
const isFull   = p => filled(p) >= p.total;
const myReq    = p => myRequests.find(r => r.postId === p.id);
const reqsOf   = p => hostReqs.filter(r => r.postId === p.id);
const hostAccepted = p => reqsOf(p).filter(r => r.status === 'accepted').length;
const iBlocked  = id => blocksByMe.some(b => b.id === id);
const blockedMe = id => blocksOnMe.some(b => b.by === id);
const hiddenHost = id => iBlocked(id) || blockedMe(id);  /* blocked either way = never in the same queue */
const upcoming = p => new Date(p.date).getTime() >= Date.now() - 3600000;
const byId = id => posts.find(p => p.id === id);
const colorOf = p => (p.flagged ? 'flagged' : GAMES[p.game].color);
const reqDoc = (postId, userId) => doc(db, 'requests', postId + '_' + userId);

/* ---------- toast + dialog ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}
const dlg = $('#dlg');
function openDlg(html) {
  dlg.innerHTML = `<button type="button" class="x" data-close aria-label="Close">&times;</button>${html}`;
  if (!dlg.open) dlg.showModal();
}
const closeDlg = () => { if (dlg.open) dlg.close(); };
const needLogin = () => { if (!me.id) { toast('Connecting... try again in a moment.'); return true; } return false; };

/* ---------- Firestore actions ---------- */
async function addBlock(id, name) {
  if (id === me.id || iBlocked(id)) return;
  const batch = writeBatch(db);
  batch.set(doc(db, 'blocks', me.id + '_' + id), { by: me.id, id, name });
  /* drop my requests on their posts, and their requests on my posts */
  myRequests.filter(r => r.hostId === id).forEach(r => batch.delete(doc(db, 'requests', r.id)));
  hostReqs.filter(r => r.userId === id).forEach(r => batch.delete(doc(db, 'requests', r.id)));
  await batch.commit();
}

async function deletePost(p) {
  const batch = writeBatch(db);
  const reqs = p.hostId === me.id
    ? reqsOf(p)
    : (await getDocs(fsQuery(collection(db, 'requests'), where('postId', '==', p.id)))).docs.map(d => ({ id: d.id }));
  reqs.forEach(r => batch.delete(doc(db, 'requests', r.id)));
  batch.delete(doc(db, 'posts', p.id, 'secret', 'gameid'));
  batch.delete(doc(db, 'posts', p.id));
  await batch.commit();
}

/* The host keeps posts/{id}.accepted in sync with the real accepted requests
   (other players can only read the count, not the requests themselves). */
function reconcile() {
  if (!me.id) return;
  posts.filter(p => p.hostId === me.id).forEach(p => {
    const n = hostAccepted(p);
    if (n !== (+p.accepted || 0)) updateDoc(doc(db, 'posts', p.id), { accepted: n }).catch(e => console.warn('reconcile', e));
  });
}

/* Live subscription to the private game id (UID / IGN / party link) of posts I host or was accepted in */
const secretSubs = {};
function syncSecrets() {
  const want = {};
  posts.forEach(p => {
    if (p.hostId === me.id) want[p.id] = 'host';
    else { const r = myReq(p); if (r && r.status === 'accepted') want[p.id] = 'acc'; }
  });
  Object.keys(secretSubs).forEach(id => {
    if (want[id] !== secretSubs[id].key) { secretSubs[id].unsub(); delete secretSubs[id]; delete secrets[id]; }
  });
  Object.entries(want).forEach(([id, key]) => {
    if (secretSubs[id]) return;
    const unsub = onSnapshot(doc(db, 'posts', id, 'secret', 'gameid'),
      s => { secrets[id] = s.exists() ? String(s.data().gameId ?? '') : ''; renderAll(); },
      e => console.warn('secret', id, e.code));
    secretSubs[id] = { key, unsub };
  });
}

/* ---------- card rendering ---------- */
function pipsHTML(p) {
  const f = filled(p);
  return `<p class="pips" aria-label="${f} of ${p.total} players in party">` +
    Array.from({ length: p.total }, (_, i) => `<i class="${i < f ? 'on' : ''}"></i>`).join('') + '</p>';
}

function detailsHTML(p) {
  return `<ul>
    <li><b>Host:</b> ${esc(p.hostName)}</li>
    <li><b>When:</b> ${esc(fmt(p.date))}</li>
    <li><b>Party:</b> ${filled(p)}/${p.total} &middot; ${p.total - filled(p)} slot${p.total - filled(p) === 1 ? '' : 's'} left</li>
    ${p.req  ? `<li><b>Requirements:</b> ${esc(p.req)}</li>` : ''}
    ${p.desc ? `<li>${esc(p.desc)}</li>` : ''}
  </ul>`;
}

function titleHTML(p) {
  return `<h3>${ic(p.game)}<span>${esc(GAMES[p.game].label)}: ${esc(p.activity)}</span></h3>` +
    (p.flagged ? '<span class="tag flag">Flagged and closed</span>' : '');
}

function adminFlagInfo(p) {
  return `<ul>${p.flags.map(f => `<li>Reported: ${esc(f.reason)}${f.note ? ' - ' + esc(f.note) : ''}</li>`).join('')}</ul>
    <div class="mini"><button data-act="adminClear">Dismiss flags</button></div>`;
}

function cardHTML(p, o = {}) {
  let actions = '';
  if (!o.demo) {
    const r = myReq(p), full = isFull(p);
    actions = r
      ? `<div class="row"><span class="tag ${r.status}">${r.status}</span><button class="btn" data-act="cancel">Cancel request</button></div>`
      : `<div class="row"><button class="btn" data-act="join" ${full ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>${full ? 'Party full' : 'Join'}</button></div>`;
    actions += `<div class="mini"><button data-act="flag">Flag post</button><button data-act="block">Block host</button>${isAdmin ? '<button data-act="adminDel">Admin delete</button>' : ''}</div>`;
    if (isAdmin && p.flagged) actions += adminFlagInfo(p);
  }
  return `<article class="card ${colorOf(p)}" data-id="${p.id}">${titleHTML(p)}${detailsHTML(p)}${pipsHTML(p)}${actions}</article>`;
}

/* ---------- filter chips (home + browse) ---------- */
function renderChips() {
  const opts = [['all', 'All'], ...Object.entries(GAMES).map(([k, g]) => [k, g.label])];
  $$('.fchips').forEach(box => {
    box.innerHTML = opts.map(([k, l]) => `<button type="button" class="btn ${filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('');
  });
}

/* ---------- browse / search ---------- */
function visiblePosts() {
  const q = query.trim().toLowerCase();
  return posts
    .filter(p => p.hostId !== me.id)                 /* own posts live in My LFG only */
    .filter(p => !hiddenHost(p.hostId))              /* blocked either way */
    .filter(p => !p.flagged)                         /* flagged = auto-closed + hidden until admin reviews */
    .filter(p => upcoming(p))
    .filter(p => filter === 'all' || p.game === filter)
    .filter(p => !q || [p.activity, p.hostName, p.req, p.desc, GAMES[p.game].label].join(' ').toLowerCase().includes(q))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}
function renderBrowse() {
  const list = visiblePosts();
  $('#listCount').textContent = list.length;
  $('#list').innerHTML = list.length ? list.map(p => cardHTML(p)).join('') : '<p class="empty">No groups match. Try another filter or create your own LFG!</p>';
}

/* ---------- recommended (suggestions only) ---------- */
function renderRecs() {
  const fav = {};
  posts.forEach(p => { if (p.hostId === me.id || myReq(p)) fav[p.game] = (fav[p.game] || 0) + 1; });
  const recs = posts
    .filter(p => p.hostId !== me.id && !myReq(p) && !p.flagged && !isFull(p) && upcoming(p) && !hiddenHost(p.hostId))
    .map(p => ({ p, score: (fav[p.game] || 0) * 10 - (new Date(p.date) - Date.now()) / 3600000 / 24 + (filled(p) / p.total) }))
    .sort((a, b) => b.score - a.score).slice(0, 6).map(x => x.p);
  $('#recCount').textContent = recs.length;
  $('#recs').innerHTML = recs.length ? recs.map(p => cardHTML(p)).join('') : '<p class="empty">No suggestions yet. Check back soon!</p>';
}

/* ---------- My LFG ---------- */
function requestRow(p, r) {
  const info = esc(r.info) || '<i>no info sent</i>';
  const btns = r.status === 'pending'
    ? `<button class="btn" data-act="accept">Accept</button><button class="btn red" data-act="decline">Decline</button>`
    : `<span class="tag ${r.status}">${r.status}</span>${r.status === 'accepted' ? '<button class="btn red" data-act="decline">Remove</button>' : '<button class="btn" data-act="accept">Accept</button>'}`;
  return `<div class="req" data-rid="${esc(r.id)}"><b>${esc(r.name)}</b> &middot; ${esc(idWord(p.game))}: ${info} ${btns}<button class="btn" data-act="blockReq">Block</button></div>`;
}

/* Manage group tray: one card per post I host (update UID/IGN/party link, delete) */
function hostCard(p) {
  const g = GAMES[p.game], pend = reqsOf(p).filter(r => r.status === 'pending').length;
  return `<article class="card ${colorOf(p)}" data-id="${p.id}">
    ${titleHTML(p)}${detailsHTML(p)}${pipsHTML(p)}
    <form class="idf" data-form="gameid">
      <label>${esc(g.idLabel)}<input name="gid" value="${esc(secrets[p.id] ?? '')}" placeholder="${esc(g.idHint)}" maxlength="200"></label>
      <button class="btn">Update</button>
    </form>
    <p style="margin:0"><span class="tag ${pend ? 'pending' : ''}">${pend} pending request${pend === 1 ? '' : 's'}</span></p>
    <div class="row"><button class="btn red del" data-act="del">Delete post</button></div>
  </article>`;
}

/* Join requests tray: requests sent to my posts, grouped per post (accept / decline / block) */
function requestGroup(p) {
  return `<div class="reqgroup" data-id="${p.id}">
    <h3>${ic(p.game)}<span>${esc(GAMES[p.game].label)}: ${esc(p.activity)}</span><span class="tag">${filled(p)}/${p.total}</span></h3>
    ${reqsOf(p).map(r => requestRow(p, r)).join('')}
  </div>`;
}

function joinedCard(p) {
  const r = myReq(p);
  let reveal = '';
  if (r.status === 'accepted') {   /* host details are only shown after being accepted */
    const v = secrets[p.id] || '';
    const link = /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>` : esc(v);
    reveal = `<ul><li><b>Host ${esc(idWord(p.game))}:</b> ${link || '<i>host has not sent one yet</i>'}</li></ul>`;
  }
  return `<article class="card ${colorOf(p)}" data-id="${p.id}">${titleHTML(p)}${detailsHTML(p)}${pipsHTML(p)}${reveal}
    <div class="row"><span class="tag ${r.status}">${r.status}</span><button class="btn" data-act="cancel">${r.status === 'pending' ? 'Cancel request' : 'Leave group'}</button></div>
    <div class="mini"><button data-act="flag">Flag post</button></div></article>`;
}

/* Fills one tray: list (or empty message) + its count badge. Ids match the trays in LFG.html. */
function fillTray(name, items, html, empty) {
  $('#' + name + 'Out').innerHTML = items.length ? items.map(html).join('') : `<p class="empty">${empty}</p>`;
  $('#' + name + 'Count').textContent = items.length;
}

function renderMine() {
  const hosting = posts.filter(p => p.hostId === me.id);
  $('#adminTray').hidden = !isAdmin;
  if (isAdmin) {
    fillTray('admin', posts.filter(p => p.flagged),
      p => `<article class="card flagged" data-id="${p.id}">${titleHTML(p)}${detailsHTML(p)}${adminFlagInfo(p)}<div class="row"><button class="btn red" data-act="adminDel">Delete post</button></div></article>`,
      'No flagged posts.');
  }
  fillTray('host', hosting, hostCard, 'You are not hosting any LFG. Press <b>+ LFG</b> to create one.');
  fillTray('req', hosting.filter(p => reqsOf(p).length), requestGroup, 'No join requests yet.');
  fillTray('join', posts.filter(p => p.hostId !== me.id && myReq(p) && !p.flagged), joinedCard, 'You have not joined any group yet.');
  fillTray('block', blocksByMe,
    b => `<span class="tag flag">${esc(b.name)} <button class="x" style="position:static;color:#fff" data-act="unblock" data-uid="${esc(b.id)}">unblock</button></span> `,
    'No blocked players.');
}

/* ---------- demo marquee ("Live from the queue") ---------- */
const demoPosts = [
  { id: 'd1', hostName: 'Ate Juls',  game: 'genshin',  activity: 'Weekly Bosses', total: 4, req: 'AR 45+',  desc: '', date: localMin(), accepted: 0 },
  { id: 'd2', hostName: 'Kuya Waki', game: 'valorant', activity: 'Competitive',   total: 5, req: 'Gold+',   desc: '', date: localMin(), accepted: 0 },
  { id: 'd3', hostName: 'Payi',      game: 'roblox',   activity: 'Blox Fruits',   total: 6, req: 'Lv 700+', desc: '', date: localMin(), accepted: 0 }
];
function renderDemo() {
  const one = demoPosts.map(p => cardHTML(p, { demo: true })).join('');
  $('#demo').innerHTML = one + `<div style="display:contents" aria-hidden="true">${one}</div>`;
}
function tickDemo() {
  const p = demoPosts[Math.floor(Math.random() * demoPosts.length)];
  if (isFull(p)) p.accepted = 0; else p.accepted++;
  renderDemo();
}

/* ---------- master render + router ---------- */
function renderAll() {
  syncSecrets();
  renderChips(); renderRecs(); renderBrowse(); renderMine();
  $('#userBtn').textContent = 'Hi, ' + me.name;
  $('#adminBtn').hidden = !canAdmin;
  $('#adminBtn').textContent = 'Admin: ' + (isAdmin ? 'ON' : 'OFF');
}
function show(v) {
  view = v;
  $$('.view').forEach(s => (s.hidden = s.id !== v));
  $$('nav [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  renderAll(); window.scrollTo(0, 0);
}

/* ---------- dialogs ---------- */
function openCreate() {
  const f = { game: '', total: 2 };
  openDlg(`<h2>Create LFG</h2>
  <form id="cf">
    <label>Your name<input name="name" required maxlength="24" value="${esc(me.name)}"></label>
    <label>Game</label>
    <div class="chips" id="cg">${Object.entries(GAMES).map(([k, g]) => `<button type="button" class="btn" data-g="${k}">${g.label}</button>`).join('')}</div>
    <label>Activity</label><div id="actBox"><input disabled placeholder="Choose a game first"></div>
    <label>Number of players in party (you are included)</label>
    <div id="pipBox"></div><small id="pipTxt"></small>
    <label>Requirements<input name="req" maxlength="120" placeholder="e.g. AR 45+, Gold and up"></label>
    <label>Schedule<input type="datetime-local" name="date" required min="${localMin()}"></label>
    <label>Description<textarea name="desc" rows="3" maxlength="300"></textarea></label>
    <label id="gidL">Game ID (choose a game first)<input name="gid" maxlength="200" disabled></label>
    <button class="btn red">Post LFG</button>
  </form>`);

  const drawPips = () => {
    const max = f.game ? GAMES[f.game].max : 5;
    f.total = Math.min(Math.max(f.total, 2), max);
    $('#pipBox').innerHTML = '<p class="pips big"><b title="You (host)">H</b>' +
      Array.from({ length: max - 1 }, (_, i) => `<button type="button" data-n="${i + 2}" class="${i + 2 <= f.total ? 'on' : ''}" aria-label="Party of ${i + 2}"></button>`).join('') + '</p>';
    $('#pipTxt').textContent = `Party size: ${f.total} (you + ${f.total - 1} more needed)`;
  };
  drawPips();

  $('#cg').onclick = e => {
    const b = e.target.closest('[data-g]'); if (!b) return;
    f.game = b.dataset.g; const g = GAMES[f.game];
    $$('#cg .btn').forEach(x => x.classList.toggle('on', x === b));
    $('#actBox').innerHTML = g.activities
      ? `<select name="activity" required>${g.activities.map(a => `<option>${esc(a)}</option>`).join('')}</select>`
      : `<input name="activity" required maxlength="60" placeholder="Which Roblox game? e.g. Blox Fruits">`;
    $('#gidL').firstChild.textContent = g.idLabel + ' (optional, you can update it later)';
    const gi = $('#cf [name=gid]'); gi.disabled = false; gi.placeholder = g.idHint;
    drawPips();
  };
  $('#pipBox').onclick = e => {
    const b = e.target.closest('[data-n]'); if (!b) return;
    f.total = +b.dataset.n; drawPips();
  };
  $('#cf').onsubmit = async e => {
    e.preventDefault();
    if (needLogin()) return;
    const d = Object.fromEntries(new FormData(e.target));
    if (!f.game) return toast('Pick a game first.');
    if (!d.date || new Date(d.date) < new Date()) return toast('Pick a schedule in the future.');
    me.name = d.name.trim() || me.name; store.set('name', me.name);
    const post = {
      hostId: me.id, hostName: me.name, game: f.game, activity: (d.activity || '').trim(),
      total: f.total, req: (d.req || '').trim(), date: d.date, desc: (d.desc || '').trim(),
      accepted: 0, flagged: false, flags: [], created: Date.now()
    };
    try {
      const ref = doc(collection(db, 'posts'));
      await setDoc(ref, post);
      await setDoc(doc(db, 'posts', ref.id, 'secret', 'gameid'), { gameId: (d.gid || '').trim() });
      closeDlg(); toast('LFG posted!'); show('mine');
    } catch (err) { console.error(err); toast('Could not post: ' + (err.code || err.message)); }
  };
}

function openJoin(p) {
  const g = GAMES[p.game];
  openDlg(`<h2>Join ${esc(p.activity)}</h2>
  <p>Host: <b>${esc(p.hostName)}</b> &middot; ${esc(fmt(p.date))}</p>
  <form id="jf">
    <label>${esc(g.idLabel)}<input name="info" required maxlength="200" placeholder="${esc(g.idHint)}"></label>
    <small>Only the host can see this. They will send you theirs once they accept.</small>
    <button class="btn red">Send join request</button>
  </form>`);
  $('#jf').onsubmit = async e => {
    e.preventDefault();
    if (needLogin()) return;
    const cur = byId(p.id);
    if (!cur || cur.flagged || isFull(cur) || myReq(cur) || hiddenHost(cur.hostId)) return toast('You cannot join this group.');
    try {
      await setDoc(reqDoc(cur.id, me.id), {
        postId: cur.id, hostId: cur.hostId, userId: me.id, name: me.name,
        info: new FormData(e.target).get('info').trim(), status: 'pending', at: Date.now()
      });
      closeDlg(); toast('Request sent!');
    } catch (err) { console.error(err); toast('Could not send: ' + (err.code || err.message)); }
  };
}

function openFlag(p) {
  openDlg(`<h2>Flag post</h2>
  <form id="ff">
    <label>Reason<select name="reason"><option>Spam or scam</option><option>Harassment or hate speech</option><option>Fake details</option><option>Inappropriate content</option><option>Other</option></select></label>
    <label>Details (optional)<textarea name="note" rows="3" maxlength="300"></textarea></label>
    <label><input type="checkbox" name="blk" style="display:inline;width:auto"> Also block ${esc(p.hostName)}</label>
    <button class="btn red">Submit report</button>
  </form>`);
  $('#ff').onsubmit = async e => {
    e.preventDefault();
    if (needLogin()) return;
    const d = Object.fromEntries(new FormData(e.target)), cur = byId(p.id); if (!cur) return;
    if (cur.flags.some(x => x.by === me.id)) { closeDlg(); return toast('You already flagged this post.'); }
    try {
      await updateDoc(doc(db, 'posts', cur.id), {
        flagged: true,
        flags: arrayUnion({ by: me.id, reason: d.reason, note: (d.note || '').trim(), at: Date.now() })
      });
      if (d.blk && cur.hostId !== me.id) await addBlock(cur.hostId, cur.hostName);
      closeDlg(); toast('Reported. Admin will review it.');
    } catch (err) { console.error(err); toast('Could not report: ' + (err.code || err.message)); }
  };
}

function openUser() {
  openDlg(`<h2>Your profile</h2>
  <form id="uf"><label>Display name<input name="name" required maxlength="24" value="${esc(me.name)}"></label>
  <button class="btn red">Save</button></form>`);
  $('#uf').onsubmit = e => {
    e.preventDefault();
    me.name = new FormData(e.target).get('name').trim() || me.name;
    store.set('name', me.name);
    closeDlg(); renderAll(); toast('Name updated.');
  };
}

/* ---------- click actions (event delegation) ---------- */
document.addEventListener('click', async e => {
  if (e.target === dlg || e.target.closest('[data-close]')) return closeDlg();

  const nav = e.target.closest('[data-view]');
  if (nav) { e.preventDefault(); return show(nav.dataset.view); }

  const chip = e.target.closest('[data-filter]');
  if (chip) { filter = chip.dataset.filter; return view === 'home' ? show('browse') : renderAll(); }

  const a = e.target.closest('[data-act]'); if (!a) return;
  if (needLogin()) return;
  const card = a.closest('[data-id]'), p = card && byId(card.dataset.id);
  const act = a.dataset.act;
  const rowEl = a.closest('[data-rid]');
  const rq = rowEl ? hostReqs.find(r => r.id === rowEl.dataset.rid) : null;
  const setStatus = status => updateDoc(doc(db, 'requests', rq.id), { status });

  try {
    switch (act) {
      case 'join':   if (p && !isFull(p)) openJoin(p); break;
      case 'flag':   if (p) openFlag(p); break;
      case 'cancel': {
        const r = p && myReq(p);
        if (r) { await deleteDoc(doc(db, 'requests', r.id)); toast('Request cancelled.'); }
        break;
      }
      case 'block':
        if (p && confirm(`Block ${p.hostName}? You will never see each other's posts.`)) { await addBlock(p.hostId, p.hostName); toast(p.hostName + ' blocked.'); }
        break;
      case 'unblock':
        await deleteDoc(doc(db, 'blocks', me.id + '_' + a.dataset.uid)); toast('Unblocked.'); break;
      case 'del':
        if (p && p.hostId === me.id && confirm('Delete this LFG post?')) { await deletePost(p); toast('Post deleted.'); }
        break;
      case 'adminDel':
        if (isAdmin && p && confirm('Admin: delete this post?')) { await deletePost(p); toast('Post removed by admin.'); }
        break;
      case 'adminClear':
        if (isAdmin && p) { await updateDoc(doc(db, 'posts', p.id), { flagged: false, flags: [] }); toast('Flags dismissed.'); }
        break;
      case 'accept':
        if (rq && p && p.hostId === me.id) {
          if (p.flagged) toast('This post is closed while an admin reviews it.');
          else if (rq.status !== 'accepted' && 1 + hostAccepted(p) >= p.total) toast('Party is already full.');
          else { await setStatus('accepted'); toast(rq.name + ' accepted.'); }
        }
        break;
      case 'decline':
        if (rq && p && p.hostId === me.id) { await setStatus('declined'); toast(rq.name + ' declined.'); }
        break;
      case 'blockReq':
        if (rq && p && p.hostId === me.id && confirm(`Block ${rq.name}?`)) { await addBlock(rq.userId, rq.name); toast(rq.name + ' blocked.'); }
        break;
    }
  } catch (err) { console.error(err); toast('Action failed: ' + (err.code || err.message)); }
});

/* host updates UID / IGN / party link after posting */
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form="gameid"]'); if (!f) return;
  e.preventDefault();
  if (needLogin()) return;
  const p = byId(f.closest('[data-id]').dataset.id);
  if (!p || p.hostId !== me.id) return;
  try {
    await setDoc(doc(db, 'posts', p.id, 'secret', 'gameid'), { gameId: new FormData(f).get('gid').trim() });
    toast(idWord(p.game) + ' updated.');
  } catch (err) { console.error(err); toast('Could not update: ' + (err.code || err.message)); }
});

/* ---------- top bar + search wiring ---------- */
$('#newBtn').onclick = () => { if (!needLogin()) openCreate(); };
$('#userBtn').onclick = openUser;
$('#adminBtn').onclick = () => { if (!canAdmin) return; isAdmin = !isAdmin; renderAll(); toast('Admin mode ' + (isAdmin ? 'ON' : 'OFF')); };
$('#homeSearch').onsubmit = e => { e.preventDefault(); query = $('#q').value; $('#q2').value = query; show('browse'); };
$('#q2').oninput = e => { query = e.target.value; renderBrowse(); };

/* ---------- live data ---------- */
function startListening() {
  if (started) return; started = true;
  const fail = label => e => { console.error(label, e); toast(`Database error (${label}): ${e.code || e.message}`); };
  const rows = s => s.docs.map(d => ({ id: d.id, ...d.data() }));

  onSnapshot(collection(db, 'posts'), s => {
    posts = rows(s).map(cleanPost).filter(Boolean);
    reconcile(); renderAll();
  }, fail('posts'));
  onSnapshot(fsQuery(collection(db, 'requests'), where('userId', '==', me.id)), s => {
    myRequests = rows(s); renderAll();
  }, fail('my requests'));
  onSnapshot(fsQuery(collection(db, 'requests'), where('hostId', '==', me.id)), s => {
    hostReqs = rows(s); reconcile(); renderAll();
  }, fail('join requests'));
  onSnapshot(fsQuery(collection(db, 'blocks'), where('by', '==', me.id)), s => {
    blocksByMe = rows(s); renderAll();
  }, fail('blocks'));
  onSnapshot(fsQuery(collection(db, 'blocks'), where('id', '==', me.id)), s => {
    blocksOnMe = rows(s); renderAll();
  }, fail('blocks'));

  getDoc(doc(db, 'admins', me.id))
    .then(s => { canAdmin = s.exists(); if (!canAdmin) isAdmin = false; renderAll(); })
    .catch(() => { /* not an admin */ });
}

onAuthStateChanged(auth, user => {
  if (user) { me.id = user.uid; startListening(); renderAll(); }
  else signInAnonymously(auth).catch(e => {
    console.error(e);
    toast('Login failed. Enable Anonymous sign-in in Firebase Authentication.');
  });
});

/* ---------- start ---------- */
renderDemo();
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(tickDemo, 2500);
show('home');