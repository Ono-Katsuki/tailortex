/* live.js — フェーズ20: クロスデバイス・ライブセッション(projectId 基準)
 *
 * 「Claude が Mac で MCP 作業 + ユーザーが iPad(同一LAN)で作業」を同時ライブに。
 * 同一プロジェクトを開いた全デバイス(Macブラウザ・iPad・Claude)を 1 つのライブ
 * セッションに繋ぎ、誰の編集も全員へリアルタイム反映する。
 *
 * フェーズ6(collab.js / 共有ID基準の /edit/:id)とは別チャネル・非破壊で共存する。
 *   - 本ファイルは通常のエディタ(ホストページ)でプロジェクトを開いたときだけ動く。
 *   - ゲスト(/edit/:id, window.__COLLAB__.mode==='guest')では動かない(collab.js に委譲)。
 *   - エンドポイント: GET /projects/:id/live-events(SSE)/ POST /projects/:id/live-op。
 *
 * コスト設計(SPEC「コスト設計」節):
 *   - 同期はサーバーSSE(メモリ中継)のみ。Firestore / Storage / onSnapshot を使わない。
 *   - presence はサーバーメモリ+SSE のみで、永続化しない(課金対象の書き込みにしない)。
 *   - 本文送信は per-keystroke ではなく 400ms デバウンスでブロック単位に集約(サーバー側は
 *     さらに 8秒デバウンスでローカル main.html に 1 書き込み)。
 */
(function () {
  'use strict';

  // ゲスト(共有編集ページ)では collab.js が担うため live.js は無効。
  var COLLAB = window.__COLLAB__ || null;
  if (COLLAB && COLLAB.mode === 'guest') return;
  if (typeof window.EventSource === 'undefined') return;

  /* ===================== 識別子・デバイス名・色 ===================== */

  var PALETTE = ['#0f7b0f', '#8764b8', '#005ba1', '#498205', '#ca5010', '#004e8c', '#986f0b', '#c239b3'];
  function colorFor(pid) {
    var h = 0;
    for (var i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // 参加者 pid = デバイスID(localStorage・端末で安定)+ タブID(sessionStorage・タブ毎に一意)。
  //   同一端末で複数タブ/ウィンドウを開いても各々が独立した参加者(独立ロック)になる。
  //   collab.js(共有ID基準)とはキーを分けて非干渉。
  function stable(store, key, prefix) {
    var v = '';
    try { v = store.getItem(key) || ''; } catch (e) { /* ignore */ }
    if (!v) {
      v = prefix + Math.random().toString(36).slice(2, 10);
      try { store.setItem(key, v); } catch (e) { /* ignore */ }
    }
    return v;
  }
  function getPid() {
    var device = stable(window.localStorage, 'wordtex-live-device', 'd');
    var tab = stable(window.sessionStorage, 'wordtex-live-tab', 't');
    return device + '-' + tab;
  }

  // デバイス名(presence 表示用)。iPad/タブレット/モバイルは 'iPad'、それ以外は 'Mac'。
  function deviceName() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return 'iPad';
    // iPadOS 13+ の Safari は Macintosh を名乗るがタッチを持つ
    if (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document) return 'iPad';
    if (/iPhone|Android|Mobile|Tablet/.test(ua)) return 'iPad';
    return 'Mac';
  }

  // 表示名。sessionStorage 'wordtex-live-name'(タブ毎の明示指定)を優先、無ければ自動判定。
  function displayName() {
    var v = '';
    try { v = window.sessionStorage.getItem('wordtex-live-name') || ''; } catch (e) { /* ignore */ }
    return (v || deviceName()).slice(0, 40);
  }

  var pid = getPid();
  var myName = displayName();
  var myColor = colorFor(pid);

  /* ===================== 状態 ===================== */

  var projectId = null;           // 現在ライブ中の projectId
  var active = false;
  var es = null;
  var reconnectTimer = null;
  var joinPollTimer = null;

  var users = {};                 // pid -> {name, color, ts}
  var locks = {};                 // bid -> {pid, name, color, ts}

  var lockedBid = null;
  var lockHeartbeat = null;
  var pendingRemote = {};

  var lastSentBlocks = {};
  var lastOrder = [];
  var lastCommentsJson = null;
  var remoteComments = {};

  var applying = false;
  var bidSeq = 0;
  var seeded = false;             // このセッションで seed(初期構造送信)済みか

  // MCP(Claude)在席のハートビート期限。agent-bridge が編集する度に延長される。
  var agentActiveUntil = 0;

  function byId(id) { return document.getElementById(id); }
  function doc() { return byId('doc'); }

  /* ===================== ブロック採番 / スナップショット ===================== */

  function ensureBids() {
    var d = doc();
    if (!d) return;
    var kids = d.children;
    for (var i = 0; i < kids.length; i++) {
      if (!kids[i].getAttribute('data-bid')) {
        kids[i].setAttribute('data-bid', pid + '-' + (bidSeq++));
      }
    }
  }

  function cleanOuterHtml(el) {
    var c = el.cloneNode(true);
    if (c.nodeType !== 1) return '';
    c.classList.remove('collab-locked');
    c.removeAttribute('contenteditable');
    c.removeAttribute('data-lock-name');
    c.removeAttribute('data-lock-color');
    c.style.removeProperty('--lock-color');
    if (!c.getAttribute('style')) c.removeAttribute('style');
    var flags = c.querySelectorAll('.collab-lock-flag');
    for (var i = 0; i < flags.length; i++) flags[i].parentNode.removeChild(flags[i]);
    return c.outerHTML;
  }

  function snapshotBlocks() {
    ensureBids();
    var d = doc();
    var order = [];
    var blocks = {};
    if (!d) return { order: order, blocks: blocks };
    var kids = d.children;
    for (var i = 0; i < kids.length; i++) {
      var bid = kids[i].getAttribute('data-bid');
      if (!bid) continue;
      order.push(bid);
      blocks[bid] = cleanOuterHtml(kids[i]);
    }
    return { order: order, blocks: blocks };
  }

  function commentMap() {
    if (window.Editor && window.Editor.getCommentMap) {
      try { return window.Editor.getCommentMap(); } catch (e) { /* ignore */ }
    }
    return {};
  }

  /* ===================== ロック装飾 ===================== */

  function decorate() {
    var d = doc();
    if (!d) return;
    var kids = d.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var bid = el.getAttribute('data-bid');
      var lock = bid ? locks[bid] : null;
      var lockedByOther = lock && lock.pid !== pid;
      if (lockedByOther) {
        el.classList.add('collab-locked');
        el.setAttribute('contenteditable', 'false');
        el.style.setProperty('--lock-color', lock.color || '#888');
        var flag = el.querySelector(':scope > .collab-lock-flag');
        if (!flag) {
          flag = document.createElement('span');
          flag.className = 'collab-lock-flag';
          flag.setAttribute('contenteditable', 'false');
          el.insertBefore(flag, el.firstChild);
        }
        flag.textContent = lock.name || '編集中';
        flag.style.background = lock.color || '#888';
      } else {
        if (el.classList.contains('collab-locked')) {
          el.classList.remove('collab-locked');
          el.removeAttribute('contenteditable');
          el.style.removeProperty('--lock-color');
          if (!el.getAttribute('style')) el.removeAttribute('style');
        }
        var f = el.querySelector(':scope > .collab-lock-flag');
        if (f) f.parentNode.removeChild(f);
      }
    }
  }

  /* ===================== リモート適用 ===================== */

  function withApply(fn) {
    applying = true;
    try { fn(); } finally { applying = false; }
    if (window.Editor && window.Editor.refresh) { try { window.Editor.refresh(); } catch (e) { /* ignore */ } }
  }

  function elFromHtml(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.firstElementChild;
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function findBlock(bid) {
    var d = doc();
    return d ? d.querySelector(':scope > [data-bid="' + cssEsc(bid) + '"]') : null;
  }

  function rebuild(order, blocks) {
    var d = doc();
    if (!d) return;
    var existing = {};
    var kids = d.children;
    for (var i = 0; i < kids.length; i++) {
      var b = kids[i].getAttribute('data-bid');
      if (b) existing[b] = kids[i];
    }
    var frag = document.createDocumentFragment();
    for (var j = 0; j < order.length; j++) {
      var bid = order[j];
      if (bid === lockedBid && existing[bid]) { frag.appendChild(existing[bid]); continue; }
      var html = blocks[bid];
      var nu = html != null ? elFromHtml(html) : (existing[bid] || null);
      if (nu) frag.appendChild(nu);
    }
    d.innerHTML = '';
    if (frag.childNodes.length === 0) frag.appendChild(elFromHtml('<p><br></p>'));
    d.appendChild(frag);
  }

  // 参加時のスナップショット。空(誰も seed していない)なら自分の #doc で seed する。
  function applySnapshot(snap) {
    users = snap.users || {};
    locks = snap.locks || {};
    var order = snap.order || [];
    if (!order.length) {
      // サーバー側が空 → このデバイスの現在の内容を初期構造として送る(seed)
      renderPresence();
      decorate();
      seedFromLocal();
      return;
    }
    withApply(function () {
      rebuild(order, snap.blocks || {});
      if (window.Editor && window.Editor.setComments) {
        try { window.Editor.setComments(snap.comments || {}); } catch (e) { /* ignore */ }
      }
      lastOrder = order.slice();
      lastSentBlocks = Object.assign({}, snap.blocks || {});
      remoteComments = snap.comments || {};
      lastCommentsJson = JSON.stringify(snap.comments || {});
    });
    seeded = true;
    renderPresence();
    decorate();
  }

  function seedFromLocal() {
    var snap = snapshotBlocks();
    if (!snap.order.length) return;
    lastOrder = snap.order.slice();
    lastSentBlocks = Object.assign({}, snap.blocks);
    remoteComments = {};
    lastCommentsJson = null;
    seeded = true;
    sendOp({ type: 'structure', order: snap.order, blocks: snap.blocks });
    syncComments();
  }

  function applyBlock(msg) {
    if (msg.by === pid) { lastSentBlocks[msg.bid] = msg.html; return; }
    if (msg.bid === lockedBid) { pendingRemote[msg.bid] = msg.html; return; }
    withApply(function () {
      var old = findBlock(msg.bid);
      var nu = elFromHtml(msg.html);
      if (!nu) return;
      if (old) old.parentNode.replaceChild(nu, old);
      else doc().appendChild(nu);
      lastSentBlocks[msg.bid] = msg.html;
      if (lastOrder.indexOf(msg.bid) === -1) lastOrder.push(msg.bid);
    });
    decorate();
  }

  function applyStructure(msg) {
    if (msg.by === pid) { lastOrder = (msg.order || []).slice(); lastSentBlocks = Object.assign({}, msg.blocks || {}); return; }
    withApply(function () {
      rebuild(msg.order || [], msg.blocks || {});
      lastOrder = (msg.order || []).slice();
      lastSentBlocks = Object.assign({}, msg.blocks || {});
    });
    seeded = true;
    decorate();
  }

  function applyComments(msg) {
    remoteComments = msg.comments || {};
    if (msg.by === pid) { lastCommentsJson = JSON.stringify(msg.comments || {}); return; }
    withApply(function () {
      if (window.Editor && window.Editor.setComments) {
        try { window.Editor.setComments(msg.comments || {}); } catch (e) { /* ignore */ }
      }
      lastCommentsJson = JSON.stringify(msg.comments || {});
    });
  }

  function applyLocks(msg) {
    locks = msg.locks || {};
    if (lockedBid && (!locks[lockedBid] || locks[lockedBid].pid !== pid)) {
      var pend = pendingRemote[lockedBid];
      var lost = lockedBid;
      lockedBid = null;
      if (pend != null) {
        delete pendingRemote[lost];
        applyBlock({ bid: lost, html: pend, by: '__remote__' });
      }
    }
    decorate();
  }

  function applyPresence(msg) {
    users = msg.users || {};
    renderPresence();
  }

  /* ===================== プレゼンス表示(#live-presence) ===================== */

  function renderPresence() {
    var strip = byId('live-presence');
    if (!strip) return;
    var ids = Object.keys(users);
    strip.innerHTML = '';
    if (!active && ids.length === 0) { strip.hidden = true; return; }
    strip.hidden = false;
    var max = 6;
    for (var i = 0; i < ids.length && i < max; i++) {
      var u = users[ids[i]];
      var av = document.createElement('span');
      av.className = 'collab-avatar';
      av.style.background = u.color || colorFor(ids[i]);
      av.textContent = (u.name || '?').slice(0, 1);
      av.title = (u.name || '?') + (ids[i] === pid ? '(このデバイス)' : '');
      if (ids[i] === pid) av.classList.add('is-self');
      strip.appendChild(av);
    }
    if (ids.length > max) {
      var more = document.createElement('span');
      more.className = 'collab-avatar collab-more';
      more.textContent = '+' + (ids.length - max);
      strip.appendChild(more);
    }
  }

  /* ===================== ローカル → 送信 ===================== */

  function sendOp(body) {
    if (!projectId) return Promise.resolve();
    body.pid = pid;
    return fetch('/projects/' + encodeURIComponent(projectId) + '/live-op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () { /* ignore */ });
  }

  var syncTimer = null;
  function scheduleSync() {
    if (!active || applying) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncLocal, 400);   // per-keystroke ではなくブロック単位に集約
  }

  function syncLocal() {
    syncTimer = null;
    if (!active) return;
    if (!seeded) { seedFromLocal(); return; }
    var snap = snapshotBlocks();
    var orderChanged = snap.order.length !== lastOrder.length;
    if (!orderChanged) {
      for (var i = 0; i < snap.order.length; i++) {
        if (snap.order[i] !== lastOrder[i]) { orderChanged = true; break; }
      }
    }
    if (orderChanged) {
      sendOp({ type: 'structure', order: snap.order, blocks: snap.blocks });
      lastOrder = snap.order.slice();
      lastSentBlocks = Object.assign({}, snap.blocks);
    } else {
      for (var b = 0; b < snap.order.length; b++) {
        var bid = snap.order[b];
        if (locks[bid] && locks[bid].pid !== pid) continue;
        if (snap.blocks[bid] !== lastSentBlocks[bid]) {
          sendOp({ type: 'block', bid: bid, html: snap.blocks[bid] });
          lastSentBlocks[bid] = snap.blocks[bid];
        }
      }
    }
    syncComments();
  }

  function syncComments() {
    if (!active) return;
    var map = commentMap();
    if (remoteComments) {
      for (var cid in remoteComments) {
        if (Object.prototype.hasOwnProperty.call(remoteComments, cid) && !map[cid]) {
          map[cid] = remoteComments[cid];
        }
      }
    }
    var json = JSON.stringify(map);
    if (json !== lastCommentsJson) {
      lastCommentsJson = json;
      sendOp({ type: 'comments', comments: map });
    }
  }

  /* ===================== ロック(フォーカス宣言) ===================== */

  function blockOfSelection() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var n = sel.anchorNode;
    var d = doc();
    if (!n || !d || !d.contains(n)) return null;
    var el = n.nodeType === 1 ? n : n.parentNode;
    while (el && el.parentNode !== d) el = el.parentNode;
    return (el && el.parentNode === d) ? el : null;
  }

  function updateLock() {
    if (!active) return;
    var block = blockOfSelection();
    if (!block) { releaseLock(); return; }
    ensureBids();
    var bid = block.getAttribute('data-bid');
    if (!bid) return;
    if (locks[bid] && locks[bid].pid !== pid) return;
    if (bid === lockedBid) return;
    releaseLock();
    lockedBid = bid;
    sendOp({ type: 'lock', bid: bid });
  }

  function releaseLock() {
    if (lockedBid) {
      var bid = lockedBid;
      lockedBid = null;
      sendOp({ type: 'unlock', bid: bid });
      if (pendingRemote[bid] != null) {
        var html = pendingRemote[bid];
        delete pendingRemote[bid];
        applyBlock({ bid: bid, html: html, by: '__remote__' });
      }
    }
  }

  /* ===================== SSE 接続 ===================== */

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (!projectId) return;
    var url = '/projects/' + encodeURIComponent(projectId) + '/live-events'
      + '?pid=' + encodeURIComponent(pid)
      + '&name=' + encodeURIComponent(myName)
      + '&color=' + encodeURIComponent(myColor);
    try { es = new EventSource(url); } catch (e) { scheduleReconnect(); return; }
    es.addEventListener('snapshot', function (e) { try { applySnapshot(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('block', function (e) { try { applyBlock(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('structure', function (e) { try { applyStructure(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('comments', function (e) { try { applyComments(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('locks', function (e) { try { applyLocks(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('presence', function (e) { try { applyPresence(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('error', function () {
      if (es && es.readyState === 2) { es = null; scheduleReconnect(); }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer || !active) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; if (active) connect(); }, 3000);
  }

  /* ===================== セッション開始 / プロジェクト切替 ===================== */

  function startSession(pjId) {
    projectId = pjId;
    active = true;
    seeded = false;
    lastOrder = [];
    lastSentBlocks = {};
    lastCommentsJson = null;
    remoteComments = {};

    var d = doc();
    if (d && !d._liveBound) {
      d.addEventListener('input', scheduleSync);
      d._liveBound = true;
    }
    if (!document._liveSelBound) {
      document.addEventListener('selectionchange', updateLock);
      document._liveSelBound = true;
    }
    if (!lockHeartbeat) {
      lockHeartbeat = setInterval(function () {
        if (!active) return;
        if (lockedBid) sendOp({ type: 'lock', bid: lockedBid });
        else sendOp({ type: 'presence' });
        // MCP(Claude)在席のハートビート(agent-bridge が最近編集していれば延長)
        if (Date.now() < agentActiveUntil) sendOp({ type: 'agent' });
      }, 5000);
    }
    if (!window._liveUnloadBound) {
      window.addEventListener('beforeunload', function () { releaseLock(); });
      window._liveUnloadBound = true;
    }
    connect();
  }

  function stopSession() {
    active = false;
    if (es) { try { es.close(); } catch (e) {} es = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    users = {}; locks = {}; lockedBid = null; pendingRemote = {};
    renderPresence();
  }

  function currentProject() {
    try {
      if (window.Projects && typeof window.Projects.current === 'function') return window.Projects.current() || null;
    } catch (e) { /* ignore */ }
    return null;
  }

  // 現在プロジェクトを監視し、開いたら自動参加・切り替わったら再参加する。
  function pollProject() {
    var pj = currentProject();
    if (pj && pj !== projectId) {
      if (active) stopSession();
      startSession(pj);
    } else if (!pj && active) {
      stopSession();
      projectId = null;
    }
  }

  /* ===================== MCP(Claude)連携 ===================== */

  // agent-bridge.js が MCP 編集を適用した直後に呼ぶ。Claude 在席を登録・延長し、
  // 直後の本文同期を促す(編集内容は #doc の input 監視でも拾うが、即時性を高める)。
  function markAgentEdit() {
    agentActiveUntil = Date.now() + 30000;   // 30秒間 Claude 在席を維持
    if (active) {
      sendOp({ type: 'agent' });
      scheduleSync();
    }
  }

  /* ===================== 起動 ===================== */

  function start() {
    pollProject();
    joinPollTimer = setInterval(pollProject, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.Live = {
    markAgentEdit: markAgentEdit,
    deviceName: deviceName,
    state: function () {
      return { active: active, projectId: projectId, pid: pid, name: myName, users: users, locks: locks, lockedBid: lockedBid, seeded: seeded };
    },
  };
})();
