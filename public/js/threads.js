/* threads.js — スレッド(コメント・メモ・ダウンロードの統合注釈) (window.Threads)
 * フェーズ17 Agent-Threads-Model。純データモデル + パネル描画。
 *
 * データモデル:
 *   thread: { tid, title, items:[...], color, createdAt, updatedAt, resolved }
 *   item(comment): { id, type:'comment', text, author, ts, replies:[{id,text,author,ts}] }
 *   item(file):    { id, type:'file', path, loc, label }
 *
 * DOM 契約(Agent-Threads-UI と共有):
 *   #thread-panel(器) / .thread-card / thread-ref[data-tid] / filelink[data-tid] / #file-viewer
 *
 * 永続化は持たない。onChange(cb) で変更を通知し、app.js(UI)が localStorage /
 * notes/threads.json に保存する。load(data) で復元する。
 */
(function (global) {
  'use strict';
  if (global.Threads) return; // 二重ロード防止

  var threads = {};   // tid -> thread
  var order = [];     // tid の表示順
  var tidSeq = 0;
  var itemSeq = 0;
  var changeCbs = [];
  var activeTid = null;

  // スレッド色(薄い Word 風パステル。UI css があれば上書きされる)
  var PALETTE = ['#fde68a', '#bfdbfe', '#bbf7d0', '#fbcfe8', '#ddd6fe', '#fed7aa', '#fecaca', '#c7f9e5'];

  var hasDoc = (typeof document !== 'undefined');

  /* ---------- ユーティリティ ---------- */

  function now() { return Date.now(); }
  function nextTid() { tidSeq++; return 't' + tidSeq; }
  function nextItemId() { itemSeq++; return 'i' + itemSeq; }
  function bumpTid(tid) { var m = /^t(\d+)$/.exec(String(tid || '')); if (m) tidSeq = Math.max(tidSeq, parseInt(m[1], 10)); }
  function bumpItem(id) { var m = /^i(\d+)$/.exec(String(id || '')); if (m) itemSeq = Math.max(itemSeq, parseInt(m[1], 10) || 0); }

  function relTime(ts) {
    var s = Math.floor((now() - (Number(ts) || now())) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    if (s < 86400) return Math.floor(s / 3600) + ' 時間前';
    return Math.floor(s / 86400) + ' 日前';
  }

  function baseName(path) {
    var p = String(path || '');
    var i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function fileIcon(path) {
    if (global.FileLink && typeof global.FileLink.iconFor === 'function') {
      try { return global.FileLink.iconFor(path); } catch (e) { /* fall through */ }
    }
    var ext = String(path || '').split('.').pop().toLowerCase();
    if (ext === 'pdf') return '📄';
    if (ext === 'md' || ext === 'txt') return '📝';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].indexOf(ext) !== -1) return '🖼';
    if (ext === 'bib') return '📚';
    if (ext === 'tex') return '📄';
    return '📎';
  }

  function touch(t) { if (t) t.updatedAt = now(); }

  function emit() {
    var snap = toJSON();
    for (var i = 0; i < changeCbs.length; i++) {
      try { changeCbs[i](snap); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- スレッド検索 ---------- */

  function threadOfItem(itemId) {
    for (var k = 0; k < order.length; k++) {
      var t = threads[order[k]];
      if (!t) continue;
      for (var i = 0; i < t.items.length; i++) {
        if (t.items[i].id === itemId) return { thread: t, item: t.items[i], kind: 'item' };
        var reps = t.items[i].replies || [];
        for (var r = 0; r < reps.length; r++) {
          if (reps[r].id === itemId) return { thread: t, item: t.items[i], reply: reps[r], kind: 'reply' };
        }
      }
    }
    return null;
  }

  /* ---------- データ API ---------- */

  function list() {
    return order.map(function (tid) { return threads[tid]; }).filter(Boolean);
  }

  function get(tid) { return threads[tid] || null; }

  function create(title) {
    var tid = nextTid();
    var t = {
      tid: tid,
      title: String(title == null ? '' : title) || '新しいスレッド',
      items: [],
      color: PALETTE[(order.length) % PALETTE.length],
      createdAt: now(),
      updatedAt: now(),
      resolved: false
    };
    threads[tid] = t;
    order.push(tid);
    emit();
    return t;
  }

  function addComment(tid, text, author) {
    var t = threads[tid];
    if (!t) return null;
    var item = {
      id: nextItemId(),
      type: 'comment',
      text: String(text == null ? '' : text),
      author: String(author || 'あなた'),
      ts: now(),
      replies: []
    };
    t.items.push(item);
    touch(t);
    emit();
    return item;
  }

  function reply(itemId, text, author) {
    var found = threadOfItem(itemId);
    if (!found || found.kind !== 'item' || found.item.type !== 'comment') return null;
    var rep = {
      id: nextItemId(),
      text: String(text == null ? '' : text),
      author: String(author || 'あなた'),
      ts: now()
    };
    if (!found.item.replies) found.item.replies = [];
    found.item.replies.push(rep);
    touch(found.thread);
    emit();
    return rep;
  }

  function addFile(tid, path, loc, label) {
    var t = threads[tid];
    if (!t || !path) return null;
    var item = {
      id: nextItemId(),
      type: 'file',
      path: String(path),
      loc: String(loc == null ? '' : loc),
      label: String(label || baseName(path) || path)
    };
    t.items.push(item);
    touch(t);
    emit();
    return item;
  }

  function remove(tid) {
    if (!threads[tid]) return false;
    delete threads[tid];
    var i = order.indexOf(tid);
    if (i !== -1) order.splice(i, 1);
    if (activeTid === tid) activeTid = null;
    emit();
    return true;
  }

  function removeItem(itemId) {
    var found = threadOfItem(itemId);
    if (!found) return false;
    if (found.kind === 'reply') {
      var reps = found.item.replies;
      reps.splice(reps.indexOf(found.reply), 1);
    } else {
      var items = found.thread.items;
      items.splice(items.indexOf(found.item), 1);
    }
    touch(found.thread);
    emit();
    return true;
  }

  function setTitle(tid, title) {
    var t = threads[tid];
    if (!t) return false;
    t.title = String(title == null ? '' : title);
    touch(t);
    emit();
    return true;
  }

  function resolve(tid, val) {
    var t = threads[tid];
    if (!t) return false;
    t.resolved = (val == null) ? !t.resolved : !!val;
    touch(t);
    emit();
    return true;
  }

  /* ---------- 移行(comment-ref → thread) ----------
   * map: { cid: {text,time} | text } → 各 cid を 1 コメントスレッドに変換。
   * 戻り値 { cid: tid } の対応表。 */
  function migrateFromComments(map) {
    var mapping = {};
    if (!map || typeof map !== 'object') return mapping;
    Object.keys(map).forEach(function (cid) {
      var v = map[cid];
      var text = '', time = now();
      if (v && typeof v === 'object') { text = String(v.text || ''); time = Number(v.time) || now(); }
      else if (typeof v === 'string') { text = v; }
      var t = create('コメント');
      // create の updatedAt/createdAt を移行元時刻に寄せる
      t.createdAt = time;
      var item = addComment(t.tid, text);
      if (item) item.ts = time;
      t.updatedAt = time;
      mapping[cid] = t.tid;
    });
    return mapping;
  }

  /* ---------- 永続化フック ---------- */

  function onChange(cb) { if (typeof cb === 'function') changeCbs.push(cb); }

  function toJSON() {
    return { order: order.slice(), threads: order.map(function (tid) { return threads[tid]; }).filter(Boolean) };
  }

  function load(data) {
    threads = {}; order = []; activeTid = null;
    var arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.threads)) arr = data.threads;
    if (arr) {
      arr.forEach(function (t) {
        if (!t || !t.tid) return;
        var items = Array.isArray(t.items) ? t.items.map(function (it) {
          if (!it) return null;
          if (it.id) bumpItem(it.id);
          if (it.type === 'file') {
            return { id: it.id || nextItemId(), type: 'file', path: String(it.path || ''), loc: String(it.loc || ''), label: String(it.label || baseName(it.path)) };
          }
          var reps = Array.isArray(it.replies) ? it.replies.map(function (r) {
            if (r && r.id) bumpItem(r.id);
            return { id: (r && r.id) || nextItemId(), text: String((r && r.text) || ''), author: String((r && r.author) || 'あなた'), ts: Number(r && r.ts) || now() };
          }) : [];
          return { id: it.id || nextItemId(), type: 'comment', text: String(it.text || ''), author: String(it.author || 'あなた'), ts: Number(it.ts) || now(), replies: reps };
        }).filter(Boolean) : [];
        bumpTid(t.tid);
        threads[t.tid] = {
          tid: t.tid,
          title: String(t.title || '新しいスレッド'),
          items: items,
          color: t.color || PALETTE[order.length % PALETTE.length],
          createdAt: Number(t.createdAt) || now(),
          updatedAt: Number(t.updatedAt) || now(),
          resolved: !!t.resolved
        };
        order.push(t.tid);
      });
    }
    return list();
  }

  /* ---------- 本文アンカー(DOM) ---------- */

  function anchorsFor(tid) {
    if (!hasDoc || !tid) return [];
    var d = document.getElementById('doc') || document;
    var nodes = d.querySelectorAll('.thread-ref[data-tid="' + tid + '"], .filelink[data-tid="' + tid + '"]');
    return Array.prototype.slice.call(nodes);
  }

  function setActive(tid, scroll) {
    activeTid = tid || null;
    if (!hasDoc) return;
    // 本文アンカーの .active 同期
    var d = document.getElementById('doc');
    if (d) {
      var refs = d.querySelectorAll('.thread-ref[data-tid], .filelink[data-tid]');
      for (var i = 0; i < refs.length; i++) {
        refs[i].classList.toggle('active', !!activeTid && refs[i].getAttribute('data-tid') === activeTid);
      }
    }
    // カードの .active 同期
    var panel = panelEl();
    if (panel) {
      var cards = panel.querySelectorAll('.thread-card');
      for (var j = 0; j < cards.length; j++) {
        cards[j].classList.toggle('active', !!activeTid && cards[j].getAttribute('data-tid') === activeTid);
      }
    }
    if (activeTid && scroll === 'card' && panel) {
      var card = panel.querySelector('.thread-card[data-tid="' + activeTid + '"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (activeTid && scroll === 'ref') {
      var a = anchorsFor(activeTid)[0];
      if (a && a.scrollIntoView) {
        a.scrollIntoView({ block: 'center', behavior: 'smooth' });
        a.classList.remove('anchor-jump-flash');
        // class 再付与で連続ジャンプ時もアニメーションを再実行。
        void a.offsetWidth;
        a.classList.add('anchor-jump-flash');
        setTimeout(function () { if (a && a.classList) a.classList.remove('anchor-jump-flash'); }, 1800);
        if (!a.hasAttribute('tabindex')) a.setAttribute('tabindex', '-1');
        try { a.focus({ preventScroll: true }); } catch (e) { try { a.focus(); } catch (x) {} }
      }
    }
  }

  function getActive() { return activeTid; }

  /* ---------- パネル描画 ---------- */

  function panelEl() {
    if (!hasDoc) return null;
    return document.getElementById('thread-panel') || document.getElementById('comments-panel');
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // .tc-* は Agent-Threads-UI(index.html テンプレート + document.css)との DOM 契約。

  function templateEl() {
    var tpl = document.getElementById('thread-card-template');
    return (tpl && tpl.content && tpl.content.firstElementChild) ? tpl : null;
  }

  // コメント項目(.tc-comment)を構築
  function buildCommentItem(item) {
    var wrap = el('div', 'tc-comment');
    wrap.setAttribute('data-item-id', item.id);

    var avatar = el('span', 'tc-avatar', (item.author || 'あ').slice(0, 1));
    var cbody = el('div', 'tc-cbody');

    var meta = el('div', 'tc-cmeta');
    meta.appendChild(el('span', 'tc-author', item.author || 'あなた'));
    meta.appendChild(el('span', 'tc-time', relTime(item.ts)));
    var jump = el('button', 'tc-comment-jump', '本文へ');
    jump.type = 'button'; jump.setAttribute('data-thread-act', 'jump'); jump.setAttribute('title', 'このコメントの本文位置へ移動');
    meta.appendChild(jump);
    cbody.appendChild(meta);

    var text = el('div', 'tc-text');
    text.setAttribute('contenteditable', 'true');
    text.setAttribute('data-placeholder', 'コメントを入力');
    text.textContent = item.text || '';
    cbody.appendChild(text);

    var reps = item.replies || [];
    if (reps.length) {
      var repBox = el('div', 'tc-replies');
      for (var i = 0; i < reps.length; i++) {
        var r = reps[i];
        var rEl = el('div', 'tc-reply');
        rEl.setAttribute('data-item-id', r.id);
        var rMeta = el('div', 'tc-cmeta');
        rMeta.appendChild(el('span', 'tc-author', r.author || 'あなた'));
        rMeta.appendChild(el('span', 'tc-time', relTime(r.ts)));
        rEl.appendChild(rMeta);
        rEl.appendChild(el('div', 'tc-text', r.text || ''));
        repBox.appendChild(rEl);
      }
      cbody.appendChild(repBox);
    }

    var replyIn = document.createElement('input');
    replyIn.type = 'text';
    replyIn.className = 'tc-reply-input';
    replyIn.setAttribute('placeholder', '返信…');
    replyIn.setAttribute('data-item-id', item.id);
    cbody.appendChild(replyIn);

    wrap.appendChild(avatar);
    wrap.appendChild(cbody);
    return wrap;
  }

  // ファイルチップ(.tc-file-chip)を構築
  function buildFileChip(item) {
    var chip = el('div', 'tc-file-chip');
    chip.setAttribute('data-item-id', item.id);
    chip.setAttribute('data-path', item.path);
    chip.setAttribute('data-loc', item.loc || '');
    chip.setAttribute('title', item.path + (item.loc ? ' (' + item.loc + ')' : ''));
    chip.appendChild(el('span', 'tc-file-icon', fileIcon(item.path)));
    chip.appendChild(el('span', 'tc-file-label', item.label || baseName(item.path)));
    var rm = el('button', 'tc-file-remove', '×');
    rm.type = 'button';
    rm.setAttribute('title', '添付を削除');
    rm.setAttribute('data-thread-act', 'remove-file');
    chip.appendChild(rm);
    return chip;
  }

  // カードのシェルを用意(テンプレートがあれば複製、無ければ生成)
  function buildShell() {
    var tpl = templateEl();
    if (tpl) {
      return tpl.content.firstElementChild.cloneNode(true);
    }
    var card = el('div', 'thread-card');
    card.setAttribute('role', 'listitem');
    var head = el('div', 'tc-head');
    var jump = el('button', 'tc-jump', '⤴'); jump.type = 'button';
    jump.setAttribute('data-thread-act', 'jump'); jump.setAttribute('title', '本文アンカーへジャンプ');
    var title = document.createElement('input');
    title.type = 'text'; title.className = 'tc-title';
    title.setAttribute('data-thread-act', 'title');
    title.setAttribute('placeholder', 'スレッドのタイトル');
    var menu = el('button', 'tc-menu', '⋯'); menu.type = 'button';
    menu.setAttribute('data-thread-act', 'menu'); menu.setAttribute('aria-expanded', 'false');
    var pop = el('div', 'tc-menu-pop'); pop.hidden = true; pop.setAttribute('role', 'menu');
    var rs = el('button', 'tc-menu-item', '解決'); rs.type = 'button'; rs.setAttribute('data-thread-act', 'resolve');
    var dl = el('button', 'tc-menu-item tc-delete', '削除'); dl.type = 'button'; dl.setAttribute('data-thread-act', 'delete');
    pop.appendChild(rs); pop.appendChild(dl);
    head.appendChild(jump); head.appendChild(title); head.appendChild(menu); head.appendChild(pop);
    card.appendChild(head);
    card.appendChild(el('div', 'tc-items'));
    var foot = el('div', 'tc-foot');
    var fb1 = el('button', 'tc-foot-btn', 'コメント追加'); fb1.type = 'button'; fb1.setAttribute('data-thread-act', 'add-comment');
    var fb2 = el('button', 'tc-foot-btn', 'ファイルを添付'); fb2.type = 'button'; fb2.setAttribute('data-thread-act', 'attach-file');
    var fb3 = el('button', 'tc-foot-btn', 'メモを新規作成して添付'); fb3.type = 'button'; fb3.setAttribute('data-thread-act', 'new-note');
    foot.appendChild(fb1); foot.appendChild(fb2); foot.appendChild(fb3);
    card.appendChild(foot);
    return card;
  }

  function buildCard(t) {
    var card = buildShell();
    card.setAttribute('data-tid', t.tid);
    card.classList.add('thread-card');
    card.classList.toggle('active', t.tid === activeTid);
    card.classList.toggle('resolved', !!t.resolved);

    var titleEl = card.querySelector('.tc-title');
    if (titleEl) {
      if (titleEl.tagName === 'INPUT') titleEl.value = t.title || '';
      else titleEl.textContent = t.title || '';
    }
    var rs = card.querySelector('[data-thread-act="resolve"]');
    if (rs) rs.textContent = t.resolved ? '未解決に戻す' : '解決';
    var pop = card.querySelector('.tc-menu-pop');
    if (pop) pop.hidden = true;

    var itemsBox = card.querySelector('.tc-items');
    if (itemsBox) {
      itemsBox.textContent = '';
      var filesBox = null;
      for (var i = 0; i < t.items.length; i++) {
        var it = t.items[i];
        if (it.type === 'file') {
          if (!filesBox) { filesBox = el('div', 'tc-files'); itemsBox.appendChild(filesBox); }
          filesBox.appendChild(buildFileChip(it));
        } else {
          filesBox = null; // 連続しないファイルは別グループに
          itemsBox.appendChild(buildCommentItem(it));
        }
      }
    }
    return card;
  }

  /* ---------- イベント委譲(スタンドアロンで機能。app.js の配線と重複しても安全) ---------- */

  function closestWithClass(node, cls, stop) {
    while (node && node !== stop) {
      if (node.nodeType === 1 && node.classList && node.classList.contains(cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function actOf(node, stop) {
    while (node && node !== stop) {
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute('data-thread-act')) {
        return { act: node.getAttribute('data-thread-act'), node: node };
      }
      node = node.parentNode;
    }
    return null;
  }

  function tidOfNode(node, container) {
    var card = closestWithClass(node, 'thread-card', container);
    return card ? card.getAttribute('data-tid') : null;
  }

  function itemIdOfNode(node, container) {
    while (node && node !== container) {
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute('data-item-id')) {
        return node.getAttribute('data-item-id');
      }
      node = node.parentNode;
    }
    return null;
  }

  function bindContainer(container) {
    if (container.__threadsBound) return;
    container.__threadsBound = true;

    container.addEventListener('click', function (e) {
      var target = e.target;
      var tid = tidOfNode(target, container);
      if (!tid) return;
      var a = actOf(target, container);
      var act = a ? a.act : null;

      if (act === 'menu') {
        var card = container.querySelector('.thread-card[data-tid="' + tid + '"]');
        var pop = card && card.querySelector('.tc-menu-pop');
        if (pop) { pop.hidden = !pop.hidden; if (a.node.setAttribute) a.node.setAttribute('aria-expanded', String(!pop.hidden)); }
        return;
      }
      if (act === 'resolve') { resolve(tid); render(container); return; }
      if (act === 'delete') { deleteThread(tid); render(container); return; }
      if (act === 'jump') { setActive(tid, 'ref'); return; }
      if (act === 'remove-file') {
        var iid = itemIdOfNode(target, container);
        if (iid) { removeItem(iid); render(container); }
        return;
      }
      if (act === 'add-comment') {
        addComment(tid, '');
        render(container);
        var box = container.querySelector('.thread-card[data-tid="' + tid + '"] .tc-comment:last-of-type .tc-text');
        if (box && box.focus) box.focus();
        return;
      }
      if (act === 'attach-file') { attachFileTo(tid, container); return; }
      if (act === 'new-note') { addNoteTo(tid, container); return; }

      var chip = closestWithClass(target, 'tc-file-chip', container);
      if (chip) {
        if (global.FileLink && typeof global.FileLink.openFile === 'function') {
          global.FileLink.openFile(chip.getAttribute('data-path'), chip.getAttribute('data-loc'));
        }
        setActive(tid, null);
        return;
      }
      // カード本体クリック → 本文アンカーへジャンプ(編集要素以外)
      if (!closestWithClass(target, 'tc-title', container) &&
        !closestWithClass(target, 'tc-text', container) &&
        !closestWithClass(target, 'tc-reply-input', container)) {
        setActive(tid, 'ref');
      }
    });

    // タイトル / コメント本文の編集(再描画せず data のみ更新)
    container.addEventListener('input', function (e) {
      var target = e.target;
      if (!target.classList) return;
      var tid = tidOfNode(target, container);
      if (!tid) return;
      if (target.classList.contains('tc-title')) {
        setTitleQuiet(tid, target.tagName === 'INPUT' ? target.value : (target.textContent || ''));
        return;
      }
      if (target.classList.contains('tc-text') && !closestWithClass(target, 'tc-reply', container)) {
        var iid = itemIdOfNode(target, container);
        var found = iid && threadOfItem(iid);
        if (found && found.item) { found.item.text = target.textContent || ''; touch(found.thread); emitQuiet(); }
      }
    });

    // 返信の確定(Enter)
    container.addEventListener('keydown', function (e) {
      var target = e.target;
      if (!target.classList || !target.classList.contains('tc-reply-input')) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var text = (target.value != null ? target.value : target.textContent || '').trim();
        var iid = target.getAttribute('data-item-id');
        if (text && iid) { reply(iid, text); render(container); }
      }
    });
  }

  var quietTimer = null;
  function setTitleQuiet(tid, title) {
    var t = threads[tid]; if (!t) return;
    t.title = String(title == null ? '' : title); touch(t); emitQuiet();
  }
  function emitQuiet() {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(function () { quietTimer = null; emit(); }, 300);
  }

  function deleteThread(tid) {
    if (global.Editor && typeof global.Editor.removeThreadAnchors === 'function') {
      try { global.Editor.removeThreadAnchors(tid); } catch (e) { unwrapAnchors(tid); }
    } else {
      unwrapAnchors(tid);
    }
    remove(tid);
  }

  function unwrapAnchors(tid) {
    if (!hasDoc) return;
    var d = document.getElementById('doc');
    if (!d) return;
    var refs = d.querySelectorAll('.thread-ref[data-tid="' + tid + '"]');
    for (var i = 0; i < refs.length; i++) {
      var span = refs[i], parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      if (parent.normalize) parent.normalize();
    }
    var fls = d.querySelectorAll('.filelink[data-tid="' + tid + '"]');
    for (var j = 0; j < fls.length; j++) fls[j].removeAttribute('data-tid');
  }

  function attachFileTo(tid, container) {
    if (global.FileLink && typeof global.FileLink.pickFile === 'function') {
      global.FileLink.pickFile(function (path, loc) {
        if (!path) return;
        addFile(tid, path, loc, null);
        render(container);
      }, {});
    } else if (hasDoc) {
      var p = window.prompt('添付するファイルのパス(プロジェクト内)', 'attachments/');
      if (p && p.trim()) { addFile(tid, p.trim(), '', null); render(container); }
    }
  }

  function addNoteTo(tid, container) {
    if (typeof noteCreator === 'function') {
      try {
        noteCreator(tid, function (path, label) {
          if (path) { addFile(tid, path, '', label); render(container); }
        });
        return;
      } catch (e) { /* fall through */ }
    }
    if (!hasDoc) return;
    var name = window.prompt('新規メモの名前(.md)', 'idea.md');
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!/\.md$/i.test(name)) name += '.md';
    addFile(tid, 'notes/' + name, '', name);
    render(container);
  }

  var noteCreator = null;
  function onCreateNote(fn) { noteCreator = (typeof fn === 'function') ? fn : null; }

  // 本文アンカーの resolved クラスをスレッド状態に同期
  // フェーズ22: スレッドアンカーの要旨(タイトル or 先頭コメント)。aria-label 用。
  function threadSummary(th) {
    if (!th) return '';
    var s = String(th.title || '').trim();
    if (!s && th.items) {
      for (var i = 0; i < th.items.length; i++) {
        if (th.items[i] && th.items[i].type === 'comment' && String(th.items[i].text || '').trim()) {
          s = String(th.items[i].text).trim(); break;
        }
      }
    }
    return s.replace(/\s+/g, ' ').slice(0, 80);
  }

  // フェーズ22: スレッドパネルの該当カードへフォーカスを移す(キーボード動線)。
  function focusCard(tid) {
    var panel = panelEl();
    if (!panel || !tid) return;
    var card = panel.querySelector('.thread-card[data-tid="' + tid + '"]');
    if (!card) return;
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
    if (card.focus) { try { card.focus(); } catch (e) { } }
  }

  var docKeyBound = false; // #doc への Enter/Space ハンドラは一度だけ

  // フェーズ22: 本文アンカー(thread-ref / filelink[data-tid])に SR 属性を付与し、
  //  Enter/Space でスレッドカードへフォーカス移動できるようにする。
  function decorateThreadAnchor(el) {
    var tid = el.getAttribute('data-tid');
    if (!tid) return;
    var th = threads[tid];
    el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    var sum = threadSummary(th);
    el.setAttribute('aria-label', 'コメント: ' + (sum || '(空のスレッド)'));
  }

  function bindDocKeys() {
    if (docKeyBound) return;
    var d = document.getElementById('doc');
    if (!d) return;
    docKeyBound = true;
    d.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var t = e.target;
      while (t && t !== d && t.nodeType === 1) {
        if (t.classList &&
          (t.classList.contains('thread-ref') || t.classList.contains('filelink')) &&
          t.getAttribute('data-tid')) {
          e.preventDefault();
          var tid = t.getAttribute('data-tid');
          setActive(tid, 'card');
          focusCard(tid);
          return;
        }
        t = t.parentNode;
      }
    });
  }

  function syncAnchorClasses() {
    if (!hasDoc) return;
    var d = document.getElementById('doc');
    if (!d) return;
    bindDocKeys();
    var refs = d.querySelectorAll('.thread-ref[data-tid]');
    for (var i = 0; i < refs.length; i++) {
      var th = threads[refs[i].getAttribute('data-tid')];
      refs[i].classList.toggle('resolved', !!(th && th.resolved));
      decorateThreadAnchor(refs[i]); // フェーズ22: SR 属性
    }
    // スレッド接続の filelink にも同じアンカー属性を付与
    var fls = d.querySelectorAll('.filelink[data-tid]');
    for (var j = 0; j < fls.length; j++) decorateThreadAnchor(fls[j]);
  }

  function render(container) {
    if (!hasDoc) return;
    container = container || panelEl();
    if (!container) return;
    bindContainer(container);
    // 入力中(このコンテナ内の編集要素にフォーカス)は再構築しない
    var ae = document.activeElement;
    if (ae && container.contains(ae) &&
      (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
      syncAnchorClasses();
      return;
    }
    var listBox = container.querySelector('.thread-list') ||
      container.querySelector('#thread-list') ||
      container.querySelector('.tp-list') ||
      container.querySelector('.cp-list') ||
      container;
    var old = listBox.querySelectorAll('.thread-card');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    var arr = list();
    for (var j = 0; j < arr.length; j++) listBox.appendChild(buildCard(arr[j]));

    var emptyEl = document.getElementById('thread-empty');
    if (emptyEl) emptyEl.hidden = arr.length > 0;
    var countEl = document.getElementById('thread-count');
    if (countEl) countEl.textContent = arr.length ? String(arr.length) : '';
    syncAnchorClasses();
  }

  function clear() {
    threads = {}; order = []; activeTid = null; tidSeq = 0; itemSeq = 0;
    emit();
  }

  global.Threads = {
    list: list,
    get: get,
    create: create,
    addComment: addComment,
    reply: reply,
    addFile: addFile,
    remove: remove,
    removeItem: removeItem,
    setTitle: setTitle,
    resolve: resolve,
    anchorsFor: anchorsFor,
    render: render,
    migrateFromComments: migrateFromComments,
    // 拡張(UI/editor 連携用)
    onChange: onChange,
    onCreateNote: onCreateNote,
    toJSON: toJSON,
    load: load,
    clear: clear,
    setActive: setActive,
    getActive: getActive
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Threads;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
