/* collab.js — フェーズ6: ライブ共同編集(Word co-authoring 方式・段落ロック)
 *
 * ホスト(http://localhost:3000/)とゲスト(/edit/:id)の両方で動く単一クライアント。
 *   - ホスト: 共有ダイアログに「共同編集を開始」を動的挿入 → /edit/:id/start でセッション開始。
 *   - ゲスト: window.__COLLAB__.mode==='guest' を検出し、ダッシュボード/共有/MCP を無効化。
 * サーバーの SSE(/edit-events/:id)を購読し、変更は POST /edit/:id/op。
 * 文書は #doc 直下ブロック(data-bid)の列として同期。フォーカス中ブロックをロック宣言し、
 * 他クライアントでは contenteditable=false + 色付き左ブラケット + 名前フラグを表示する。
 *
 * editor.js/app.js は公開 API(window.Editor / window.App)経由でのみ利用する。
 */
(function () {
  'use strict';

  var COLLAB = window.__COLLAB__ || null;
  var isGuest = !!(COLLAB && COLLAB.mode === 'guest');
  // フェーズ13b: 共有権限("view"|"comment"|"edit")。ゲストのみ意味を持つ。
  function normalizePerm(v) { return (v === 'view' || v === 'comment') ? v : 'edit'; }
  var permission = isGuest ? normalizePerm(COLLAB.permission) : 'edit';
  var commentOnly = isGuest && permission === 'comment';

  /* ===================== 識別子・色・名前 ===================== */

  var PALETTE = ['#d13438', '#0f7b0f', '#8764b8', '#c239b3', '#e3008c',
    '#005ba1', '#498205', '#ca5010', '#004e8c', '#986f0b'];

  function colorFor(pid) {
    var h = 0;
    for (var i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function getPid() {
    var k = 'wordtex-collab-pid';
    var v = '';
    try { v = localStorage.getItem(k) || ''; } catch (e) { /* ignore */ }
    if (!v) {
      v = 'p' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }
    return v;
  }

  function getName() {
    var k = 'wordtex-collab-name';
    var v = '';
    try { v = localStorage.getItem(k) || ''; } catch (e) { /* ignore */ }
    if (!v) {
      v = (window.prompt('共同編集で表示する名前を入力してください', 'ゲスト') || 'ゲスト').slice(0, 40);
      try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }
    return v;
  }

  var pid = getPid();
  var myName = '';
  var myColor = colorFor(pid);

  /* ===================== 状態 ===================== */

  var shareId = isGuest ? COLLAB.shareId : null;
  var active = false;             // ライブセッション接続中か
  var es = null;
  var reconnectTimer = null;

  var users = {};                 // pid -> {name, color, ts}
  var locks = {};                 // bid -> {pid, name, color, ts}
  var lastKnownUsers = {};        // 参加/離脱通知用

  var lockedBid = null;           // 自分がロック中のブロック bid
  var lockHeartbeat = null;
  var pendingRemote = {};         // ロック中に無視したリモート更新 bid -> html

  var lastSentBlocks = {};        // bid -> 送信済み(既知)outerHTML
  var lastOrder = [];             // 送信済みブロック順
  var lastCommentsJson = null;    // 送信済みコメント JSON
  var remoteComments = {};        // サーバー最新のコメント全体(アンカー未取得分の保持用)

  var applying = false;           // リモート適用中(自分の input と誤検知しない)
  var bidSeq = 0;

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

  // collab 専用の装飾(ロックフラグ・属性)を除いた純粋なブロック outerHTML
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

  function findBlock(bid) {
    var d = doc();
    return d ? d.querySelector(':scope > [data-bid="' + cssEsc(bid) + '"]') : null;
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function applySnapshot(snap) {
    withApply(function () {
      users = snap.users || {};
      locks = snap.locks || {};
      rebuild(snap.order || [], snap.blocks || {});
      if (window.Editor && window.Editor.setComments) {
        try { window.Editor.setComments(snap.comments || {}); } catch (e) { /* ignore */ }
      }
      lastOrder = (snap.order || []).slice();
      lastSentBlocks = Object.assign({}, snap.blocks || {});
      remoteComments = snap.comments || {};
      lastCommentsJson = JSON.stringify(snap.comments || {});
    });
    renderPresence();
    decorate();
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
      // 自分がロック中のブロックはローカルの編集内容を保持
      if (bid === lockedBid && existing[bid]) { frag.appendChild(existing[bid]); continue; }
      var html = blocks[bid];
      var nu = html != null ? elFromHtml(html) : (existing[bid] || null);
      if (nu) frag.appendChild(nu);
    }
    d.innerHTML = '';
    if (frag.childNodes.length === 0) frag.appendChild(elFromHtml('<p><br></p>'));
    d.appendChild(frag);
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
    // 自分のロックが失効していたら、保留中のリモート更新を反映
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
    // 参加/離脱の通知
    for (var k in users) {
      if (!lastKnownUsers[k] && k !== pid) announce((users[k].name || '参加者') + ' さんが参加しました');
    }
    for (var g in lastKnownUsers) {
      if (!users[g] && g !== pid) announce((lastKnownUsers[g].name || '参加者') + ' さんが退出しました');
    }
    lastKnownUsers = {};
    for (var m in users) lastKnownUsers[m] = { name: users[m].name };
    renderPresence();
  }

  function announce(text) {
    if (window.A11y && window.A11y.announce) { try { window.A11y.announce(text); } catch (e) { /* ignore */ } }
  }

  /* ===================== プレゼンス表示 ===================== */

  function renderPresence() {
    var strip = byId('presence-strip');
    if (!strip) return;
    var ids = Object.keys(users);
    strip.innerHTML = '';
    if (!active && ids.length === 0) { strip.hidden = true; return; }
    strip.hidden = false;
    var max = 5;
    for (var i = 0; i < ids.length && i < max; i++) {
      var u = users[ids[i]];
      var av = document.createElement('span');
      av.className = 'collab-avatar';
      av.style.background = u.color || colorFor(ids[i]);
      av.textContent = (u.name || '?').slice(0, 1);
      av.title = u.name + (ids[i] === pid ? '(あなた)' : '');
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
    body.pid = pid;
    return fetch('/edit/' + shareId + '/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () { /* ignore */ });
  }

  var syncTimer = null;
  function scheduleSync() {
    if (!active || applying) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncLocal, 400);
  }

  function syncLocal() {
    syncTimer = null;
    if (!active) return;
    // コメント専用: 本文ブロックは同期しない(サーバーも block/structure を 403)。コメントのみ同期。
    if (commentOnly) { syncComments(); return; }
    var snap = snapshotBlocks();
    // 構造(順序)変化 → 全体を structure で送る
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
      // 変更のあったブロックのみ送る(自分がロック中/リモート同一のものは除外)
      for (var b = 0; b < snap.order.length; b++) {
        var bid = snap.order[b];
        if (locks[bid] && locks[bid].pid !== pid) continue; // 他者ロック中は触らない
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
    // フェーズ13b: 自分がアンカー(#doc の comment-ref)を持たないリモートコメントは保持する。
    //   comment 権限ゲストは本文ブロックを同期できないため、ホスト側にはアンカーが無い。
    //   これが無いとアンカー未取得クライアントが空マップを送り、他者のコメントを消してしまう。
    //   通常の共同編集では全ブロックが同期されるため差分は生じず、挙動は不変。
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
    if (commentOnly) return; // コメント専用: ブロックは編集しないためロックしない
    var block = blockOfSelection();
    if (!block) { releaseLock(); return; }
    ensureBids();
    var bid = block.getAttribute('data-bid');
    if (!bid) return;
    if (locks[bid] && locks[bid].pid !== pid) return; // 他者ロック中には入れない
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
      // 保留リモート更新があれば反映
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
    var url = '/edit-events/' + shareId
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

  function startSession() {
    active = true;
    myName = myName || getName();
    // 入力・選択・コメントの監視
    var d = doc();
    if (d) {
      d.addEventListener('input', scheduleSync);
    }
    document.addEventListener('selectionchange', updateLock);
    // コメント等 input を伴わない変更のバックストップ
    setInterval(function () { if (active && !applying) syncComments(); }, 1500);
    // ロック heartbeat(5秒)+ プレゼンス ts 更新
    lockHeartbeat = setInterval(function () {
      if (!active) return;
      if (lockedBid) sendOp({ type: 'lock', bid: lockedBid });
      else sendOp({ type: 'presence' });
    }, 5000);
    window.addEventListener('beforeunload', function () { releaseLock(); });
    connect();
  }

  /* ===================== ホスト: セッション開始 ===================== */

  function currentLatex() {
    var d = doc();
    if (!d || !window.LatexGen) return '\\documentclass{article}\\begin{document}\\end{document}';
    var opt = (window.App && window.App.getOptions) ? window.App.getOptions() : {};
    try {
      return window.LatexGen.generate(d, {
        margin: opt.margin, landscape: opt.landscape, toc: opt.toc,
        comments: (window.Editor && window.Editor.getComments) ? window.Editor.getComments() : null,
        bibStyle: (window.App && window.App.bib) ? window.App.bib.getStyle() : 'plain',
      });
    } catch (e) {
      return '\\documentclass{article}\\begin{document}\\end{document}';
    }
  }

  function docTitle() {
    var el = byId('doc-title');
    var t = el ? (el.textContent || '') : '';
    return t.replace(/\s*[-–]\s*(?:Word風LaTeX|RaTeX|TailorTeX)\s*$/, '').trim() || '無題の文書';
  }

  function hostStatus(text) {
    var el = byId('collab-status');
    if (el) el.textContent = text;
  }

  function startHostSession() {
    myName = myName || getName();
    hostStatus('共同編集セッションを準備しています…');
    // 既存の /s/:id リンクがあれば再利用、無ければ新規共有を作成
    var existing = byId('share-link-input');
    var m = existing && existing.value ? existing.value.match(/\/s\/([A-Za-z0-9]{8})/) : null;
    var p;
    if (m) {
      p = Promise.resolve(m[1]);
    } else {
      var d = doc();
      p = fetch('/share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: d ? d.innerHTML : '', latex: currentLatex(), title: docTitle() }),
      }).then(function (r) { return r.json(); }).then(function (j) { return j.id; });
    }
    p.then(function (id) {
      shareId = id;
      var snap = snapshotBlocks();
      return fetch('/edit/' + id + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: snap.order, blocks: snap.blocks, comments: commentMap() }),
      }).then(function () { return id; });
    }).then(function (id) {
      lastOrder = [];
      lastSentBlocks = {};
      lastCommentsJson = null;
      remoteComments = {};
      startSession();
      var editUrl = location.origin + '/edit/' + id;
      var row = byId('collab-link-row');
      var input = byId('collab-link-input');
      if (row) row.hidden = false;
      if (input) input.value = editUrl;
      var startBtn = byId('collab-start-btn');
      if (startBtn) { startBtn.textContent = '共同編集を実行中'; startBtn.disabled = true; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(editUrl).then(function () { hostStatus('編集リンクをコピーしました。'); },
          function () { hostStatus('編集リンクを発行しました(手動コピー)。'); });
      } else {
        hostStatus('編集リンクを発行しました。');
      }
      announce('共同編集を開始しました');
    }).catch(function (err) {
      hostStatus('開始に失敗しました: ' + (err && err.message ? err.message : err));
    });
  }

  function injectHostUI() {
    var dlg = byId('share-dialog');
    if (!dlg) return;
    var body = dlg.querySelector('.dlg-body');
    if (!body || byId('collab-share')) return;
    var wrap = document.createElement('div');
    wrap.id = 'collab-share';
    wrap.innerHTML =
      '<div class="dlg-sep"></div>' +
      '<div class="collab-share-head">共同編集(ライブ)</div>' +
      '<button type="button" class="collab-start-btn" id="collab-start-btn">共同編集を開始</button>' +
      '<div class="share-row" id="collab-link-row" hidden>' +
      '  <input type="text" id="collab-link-input" readonly spellcheck="false">' +
      '  <button type="button" class="share-copy-btn" id="collab-copy-btn">リンクのコピー</button>' +
      '</div>' +
      '<div id="collab-status" class="share-status" role="status"></div>';
    body.appendChild(wrap);
    byId('collab-start-btn').addEventListener('click', startHostSession);
    byId('collab-copy-btn').addEventListener('click', function () {
      var input = byId('collab-link-input');
      if (input && navigator.clipboard) navigator.clipboard.writeText(input.value).then(function () { hostStatus('コピーしました。'); });
    });
  }

  /* ===================== ゲスト: UI 制限 ===================== */

  function applyGuestRestrictions() {
    var hideIds = ['share-btn', 'agent-indicator'];
    hideIds.forEach(function (id) { var el = byId(id); if (el) el.hidden = true; });
    // ファイル(バックステージ/ダッシュボード)はゲストでは無効化
    var fileTab = document.querySelector('.ribbon-tab.file-tab');
    if (fileTab) fileTab.style.display = 'none';
    document.documentElement.setAttribute('data-collab-guest', '1');
  }

  // フェーズ13b: コメント専用モード(permission=comment)。本文編集は不可、コメントのみ。
  function applyCommentOnlyMode() {
    document.documentElement.setAttribute('data-collab-comment', '1');
    var d = doc();
    if (d) d.setAttribute('contenteditable', 'false');
    // editor に本文改変コマンドの無効化を依頼
    if (window.Editor && window.Editor.setCommentOnlyMode) {
      try { window.Editor.setCommentOnlyMode(true); } catch (e) { /* ignore */ }
    }
    // 校閲タブ以外のリボンパネルの操作ボタンを無効表示(コメント系だけ有効)
    var COMMENT_CMDS = { insertComment: 1, deleteComment: 1, prevComment: 1, nextComment: 1, wordCount: 1 };
    var btns = document.querySelectorAll('#ribbon [data-command], #ribbon [data-cmd]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var cmd = b.getAttribute('data-command') || b.getAttribute('data-cmd') || '';
      // 校閲(コメント/文字カウント)とプレビュー/コンパイル系は残す
      if (COMMENT_CMDS[cmd] || cmd === 'togglePreview' || cmd === 'compile') continue;
      b.setAttribute('disabled', 'disabled');
      b.classList.add('collab-comment-disabled');
    }
    showCommentBadge();
  }

  function showCommentBadge() {
    if (byId('collab-comment-badge')) return;
    var badge = document.createElement('div');
    badge.id = 'collab-comment-badge';
    badge.textContent = 'コメントモードで表示中';
    badge.setAttribute('role', 'status');
    document.body.appendChild(badge);
  }

  /* ===================== 起動 ===================== */

  function start() {
    if (isGuest) {
      applyGuestRestrictions();
      if (commentOnly) applyCommentOnlyMode();
      myName = getName();
      startSession();
    } else {
      injectHostUI();
      renderPresence();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // 検証用に最小限を公開
  window.Collab = {
    isGuest: isGuest,
    permission: permission,
    commentOnly: commentOnly,
    startHost: startHostSession,
    state: function () { return { active: active, shareId: shareId, pid: pid, users: users, locks: locks, lockedBid: lockedBid, permission: permission, commentOnly: commentOnly }; },
  };
})();
