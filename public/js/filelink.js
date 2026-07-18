/* filelink.js — 本文からプロジェクト内ファイルへのリンク (window.FileLink)
 * フェーズ15 Agent-Proj-Link。可能な限り自己完結。
 *   - document 委譲で filelink クリック(→ #file-viewer 表示)と
 *     #file-tree からのドラッグ&ドロップ(→ 本文へ filelink 挿入)を捕捉する。
 *   - #file-viewer が無ければ最低限のパネルを動的生成(防御)。
 *   - DOM 契約: .filelink 要素, #file-tree([data-path]), #file-viewer,
 *     /projects/:id/file?path= (Server), window.Projects.current()(Front)。
 * 実際の挿入(履歴/コメント専用モード整合)は window.Editor に委譲する。
 */
(function () {
  'use strict';
  if (window.FileLink) return; // 二重ロード防止(editor.js の動的注入と index.html の両方でも安全)

  var IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];

  function byId(id) { return document.getElementById(id); }

  function extOf(path) { return String(path || '').split('.').pop().toLowerCase(); }

  function baseName(path) {
    var p = String(path || '');
    var slash = p.lastIndexOf('/');
    return slash >= 0 ? p.slice(slash + 1) : p;
  }

  function iconFor(path) {
    var ext = extOf(path);
    if (ext === 'pdf') return '📄';
    if (ext === 'md' || ext === 'txt') return '📝';
    if (IMG_EXTS.indexOf(ext) !== -1) return '🖼';
    if (ext === 'bib') return '📚';
    if (ext === 'tex') return '📄';
    return '📎';
  }

  /* ---------- filelink 要素の生成 ---------- */

  function createElement(path, label, loc, tid) {
    var span = document.createElement('span');
    span.className = 'filelink';
    span.setAttribute('data-path', String(path || ''));
    span.setAttribute('data-loc', String(loc || ''));
    // フェーズ17: スレッド所属の filelink には data-tid を付与(未指定なら従来動作)。
    if (tid) span.setAttribute('data-tid', String(tid));
    span.setAttribute('contenteditable', 'false');
    span.setAttribute('title', String(path || '') + (loc ? ' (' + loc + ')' : ''));
    var icon = document.createElement('span');
    icon.className = 'filelink-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = iconFor(path);
    span.appendChild(icon);
    var lab = document.createElement('span');
    lab.className = 'filelink-label';
    lab.textContent = String(label || baseName(path) || path || '');
    span.appendChild(lab);
    return span;
  }

  /* ---------- 現在のプロジェクト ID ---------- */

  function currentProjectId() {
    try {
      if (window.Projects && typeof window.Projects.current === 'function') {
        var c = window.Projects.current();
        if (c && typeof c === 'object') return c.id || c.projectId || null;
        if (typeof c === 'string' && c) return c;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------- #file-viewer パネル(無ければ生成) ---------- */

  function ensureViewer() {
    var v = byId('file-viewer');
    if (v) return v;
    v = document.createElement('div');
    v.id = 'file-viewer';
    v.className = 'file-viewer filelink-fallback-viewer';
    v.style.cssText = 'position:fixed;top:0;right:0;width:360px;max-width:90vw;height:100%;' +
      'background:#fff;color:#111;border-left:1px solid #ccc;z-index:9998;display:flex;' +
      'flex-direction:column;box-shadow:-2px 0 8px rgba(0,0,0,.15);font-family:sans-serif;';
    var bar = document.createElement('div');
    bar.className = 'file-viewer-bar';
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
      'padding:6px 10px;border-bottom:1px solid #ddd;font-size:13px;font-weight:600;';
    var title = document.createElement('span');
    title.className = 'file-viewer-title';
    title.textContent = 'ファイルビューア';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '閉じる');
    close.style.cssText = 'border:none;background:none;font-size:20px;cursor:pointer;line-height:1;color:inherit;';
    close.addEventListener('click', function () { v.style.display = 'none'; });
    bar.appendChild(title);
    bar.appendChild(close);
    var body = document.createElement('div');
    body.className = 'file-viewer-body';
    body.style.cssText = 'flex:1;overflow:auto;background:#fafafa;';
    v.appendChild(bar);
    v.appendChild(body);
    document.body.appendChild(v);
    return v;
  }

  function viewerBody(v) {
    return byId('file-viewer-body') ||
      (v.querySelector && v.querySelector('.file-viewer-body,.viewer-body,.fv-body')) ||
      v;
  }

  function locToPdfHash(loc) {
    var m = /(\d+)/.exec(String(loc || ''));
    return m ? 'page=' + m[1] : '';
  }

  /* ---------- ファイルを #file-viewer に開く ---------- */

  function openFile(path, loc) {
    if (!path) return;
    // Front が open API を持っていれば全面委譲
    if (window.FileViewer && typeof window.FileViewer.open === 'function') {
      try { window.FileViewer.open(path, loc); return; } catch (e) { /* fall through */ }
    }
    var v = byId('file-viewer') || ensureViewer();
    // 表示状態にする(Front のクラス命名が不明なので複数手段を試す)
    try { v.hidden = false; v.removeAttribute('hidden'); } catch (e) { /* ignore */ }
    if (v.style && v.style.display === 'none') v.style.display = '';
    if (v.classList) { v.classList.add('open'); v.classList.remove('hidden'); }

    var titleEl = v.querySelector && v.querySelector('.file-viewer-title');
    if (titleEl) titleEl.textContent = baseName(path) + (loc ? ' (' + loc + ')' : '');

    var body = viewerBody(v);
    if (!body) return;
    body.innerHTML = '';

    var pid = currentProjectId();
    if (!pid) {
      var msg = document.createElement('div');
      msg.style.cssText = 'padding:12px;font-size:13px;color:#666;';
      msg.textContent = 'プロジェクトが開かれていないためファイルを表示できません: ' + path;
      body.appendChild(msg);
      return;
    }

    var ext = extOf(path);
    var url = '/projects/' + encodeURIComponent(pid) + '/file?path=' + encodeURIComponent(path);

    if (ext === 'pdf') {
      var iframe = document.createElement('iframe');
      var hash = loc ? locToPdfHash(loc) : '';
      iframe.src = url + (hash ? '#' + hash : '');
      iframe.title = baseName(path);
      iframe.style.cssText = 'width:100%;height:100%;border:none;';
      body.appendChild(iframe);
    } else if (IMG_EXTS.indexOf(ext) !== -1) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = baseName(path);
      img.style.cssText = 'max-width:100%;height:auto;display:block;margin:8px auto;';
      body.appendChild(img);
    } else {
      // テキスト/メモ
      var pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;padding:12px;margin:0;' +
        'font:13px/1.5 ui-monospace,Menlo,monospace;';
      pre.textContent = '読み込み中…';
      body.appendChild(pre);
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      }).then(function (txt) {
        pre.textContent = txt;
      }).catch(function (err) {
        pre.textContent = 'ファイルを読み込めませんでした (' + err.message + '): ' + path;
      });
    }
  }

  /* ---------- ファイルピッカー(挿入用) ---------- */
  // Front のツリーピッカー API があれば使う。無ければ prompt でパス入力(防御)。
  function pickFile(onPick, opts) {
    if (typeof onPick !== 'function') return;

    function withLoc(path) {
      if (path == null || String(path).trim() === '') return;
      var loc = window.prompt('ページ/位置(任意, 例 p.3)', '') || '';
      onPick(String(path).trim(), loc.trim());
    }

    // Front が明示的なピッカー API を提供している場合
    if (window.FileTree && typeof window.FileTree.pick === 'function') {
      try {
        window.FileTree.pick(function (path) { if (path) withLoc(path); });
        return;
      } catch (e) { /* fall through */ }
    }
    if (window.Projects && typeof window.Projects.pickFile === 'function') {
      try {
        window.Projects.pickFile(function (path) { if (path) withLoc(path); });
        return;
      } catch (e) { /* fall through */ }
    }

    // 防御: prompt でパス入力(Projects.tree があればヒントとして候補を示す)
    var hint = 'attachments/';
    try {
      if (window.Projects && typeof window.Projects.tree === 'function') {
        var t = window.Projects.tree();
        if (t && typeof t.then === 'function') { t = null; } // Promise は同期表示できないので割愛
        if (Array.isArray(t)) {
          var files = t.filter(function (n) { return n && n.type === 'file' && n.path; })
            .map(function (n) { return n.path; });
          if (files.length) hint = files[0];
        }
      }
    } catch (e) { /* ignore */ }
    var p = window.prompt('リンクするファイルのパス(プロジェクト内, 例 attachments/knuth.pdf)', hint);
    if (p == null || p.trim() === '') return;
    withLoc(p.trim());
  }

  /* ---------- ドラッグ&ドロップ: #file-tree → 本文 ---------- */

  var DND_TYPE = 'application/x-wordtex-file';

  // #file-tree のノードを掴めるように、mousedown 時に draggable を付与する(capture)。
  document.addEventListener('mousedown', function (e) {
    if (!e.target || !e.target.closest) return;
    var node = e.target.closest('#file-tree [data-path]');
    if (node && node.getAttribute('data-path') && !node.draggable) {
      node.draggable = true;
    }
  }, true);

  document.addEventListener('dragstart', function (e) {
    if (!e.target || !e.target.closest) return;
    var node = e.target.closest('#file-tree [data-path]');
    if (!node) return;
    var path = node.getAttribute('data-path');
    if (!path) return;
    try {
      e.dataTransfer.setData(DND_TYPE, path);
      e.dataTransfer.setData('text/plain', path);
      e.dataTransfer.effectAllowed = 'copy';
    } catch (err) { /* ignore */ }
  });

  function hasFilePayload(dt) {
    if (!dt) return false;
    try {
      if (dt.types) {
        for (var i = 0; i < dt.types.length; i++) {
          if (dt.types[i] === DND_TYPE) return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function placeCaretAtPoint(x, y) {
    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (range) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* ignore */ }
    }
  }

  // #doc 上での dragover / drop を document 委譲で捕捉
  document.addEventListener('dragover', function (e) {
    if (!e.target || !e.target.closest) return;
    if (!e.target.closest('#doc')) return;
    if (!hasFilePayload(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ }
  });

  document.addEventListener('drop', function (e) {
    if (!e.target || !e.target.closest) return;
    if (!e.target.closest('#doc')) return;
    var dt = e.dataTransfer;
    if (!dt) return;
    var path = '';
    try { path = dt.getData(DND_TYPE); } catch (err) { path = ''; }
    if (!path) return; // 独自ペイロードのみ処理(通常のテキストドロップは邪魔しない)
    e.preventDefault();
    placeCaretAtPoint(e.clientX, e.clientY);
    if (window.Editor && typeof window.Editor.insertFileLink === 'function') {
      window.Editor.insertFileLink(path, baseName(path), '');
    }
  });

  /* ---------- クリック: filelink → #file-viewer ---------- */

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var el = e.target.closest('.filelink');
    if (!el) return;
    // 本文(#doc)内の filelink のみ対象
    if (!el.closest('#doc')) return;
    e.preventDefault();
    // 本文リンクは個別ビューへ即遷移せず、全メモ・URL・論文を縦覧できる参照ストリームを開く。
    if (window.LinkOverview && typeof window.LinkOverview.open === 'function') {
      window.LinkOverview.open();
    } else {
      openFile(el.getAttribute('data-path'), el.getAttribute('data-loc'));
    }
    // フェーズ17: スレッド所属(data-tid)なら該当スレッドカードもハイライト
    var tid = el.getAttribute('data-tid');
    if (tid && window.Threads && typeof window.Threads.setActive === 'function') {
      try { window.Threads.setActive(tid, 'card'); } catch (err) { /* ignore */ }
    }
  });

  /* ---------- 既定スタイル(Front の css があればそちらが優先: @layer で低優先) ---------- */

  (function injectFallbackStyle() {
    if (byId('filelink-fallback-style')) return;
    var css =
      '@layer filelink-fallback {' +
      '.filelink{display:inline-flex;align-items:baseline;gap:.25em;padding:.03em .4em;' +
      'margin:0 .1em;border-radius:4px;background:#e8f0fe;color:#1a56db;' +
      'border:1px solid #c3d4f7;cursor:pointer;font-size:.95em;text-decoration:none;' +
      'user-select:none;white-space:nowrap;vertical-align:baseline;}' +
      '.filelink:hover{background:#d7e4fc;}' +
      '.filelink-icon{font-size:.9em;line-height:1;}' +
      '.filelink-label{text-decoration:none;}' +
      '}';
    var style = document.createElement('style');
    style.id = 'filelink-fallback-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  })();

  window.FileLink = {
    createElement: createElement,
    openFile: openFile,
    pickFile: pickFile,
    iconFor: iconFor,
    currentProjectId: currentProjectId
  };
})();
