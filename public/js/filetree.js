/* filetree.js — フェーズ15: プロジェクトのファイルツリー UI と #file-viewer
 * VS Code / GitHub リポジトリ風のサイドバー。window.Projects(API ラッパ)に依存。
 * DOM 契約: #file-tree(サイドバー) / #toggle-tree(トグル) / #attach-input(アップロード)
 *           / #file-viewer(ファイル表示パネル) / ノードの data-path(D&D 用)
 * 公開: window.FileTree = { load, reload, setProject, currentProject, openPath }
 *       window.FileViewer = { open, close }  ← Agent-Proj-Link がファイルリンククリックで使用
 */
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }
  function t(key, fb) {
    try { return (window.I18n && window.I18n.t) ? window.I18n.t(key, fb) : fb; } catch (e) { return fb; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var projectId = null;
  var treeData = [];
  var collapsed = {};      // path -> true(折りたたみ状態)
  var collapseOnLoad = true;
  var selectedPath = '';   // 現在選択中ノードのパス(新規作成の基準フォルダ)
  var selectedIsDir = false;

  /* ================= アイコン ================= */
  function extOf(path) {
    var m = /\.([a-z0-9]+)$/i.exec(String(path || ''));
    return m ? m[1].toLowerCase() : '';
  }
  var IMG_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, svg: 1, webp: 1, bmp: 1 };
  function kindOf(node) {
    if (node.type === 'dir') return 'dir';
    var e = extOf(node.path);
    if (node.path === 'main.html') return 'doc';
    if (e === 'tex') return 'tex';
    if (e === 'bib') return 'bib';
    if (e === 'pdf') return 'pdf';
    if (e === 'md' || e === 'txt') return 'note';
    if (e === 'html' || e === 'htm') return 'doc';
    if (IMG_EXT[e]) return 'img';
    return 'file';
  }
  function iconSvg(kind, open) {
    switch (kind) {
      case 'dir':
        return open
          ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4l1.2 1.4h7.8v1H1.5z" fill="currentColor" opacity=".9"/><path d="M1.5 5.5h13l-1.4 7H2.4z" fill="currentColor" opacity=".55"/></svg>'
          : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4l1.2 1.4h7.8v8.6H1.5z" fill="currentColor" opacity=".8"/></svg>';
      case 'doc':
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M5.5 8h5M5.5 10.3h5" stroke="currentColor" stroke-width=".9"/></svg>';
      case 'tex':
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1"/><text x="8" y="11" font-size="7" text-anchor="middle" fill="currentColor" font-family="serif">TeX</text></svg>';
      case 'bib':
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7a1.5 1.5 0 0 1 1.5 1.5v9.5l-2.5-1.6-2.5 1.6V4A1.5 1.5 0 0 1 8 2.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
      case 'pdf':
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.1"/><text x="8" y="12.5" font-size="4.5" text-anchor="middle" fill="currentColor">PDF</text></svg>';
      case 'note':
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" stroke="currentColor" stroke-width=".9"/></svg>';
      case 'img':
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="5.5" cy="6.5" r="1.1" fill="currentColor"/><path d="M3 12l3.5-3.5 2.5 2.5L11 9l2 2" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
      default:
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
    }
  }

  /* ================= ツリー構築 ================= */
  // 平坦な [{path,type,ext,size}] を入れ子ノードへ。build/ と隠しは除外。
  function buildNested(flat) {
    var root = { name: '', path: '', type: 'dir', children: [], childMap: {} };
    (flat || []).forEach(function (item) {
      if (!item || !item.path) return;
      if (item.hidden) return;
      var parts = String(item.path).split('/').filter(Boolean);
      if (parts[0] === 'build') return;               // ビルド成果物は非表示
      if (parts.length === 1 && parts[0] === 'project.json') return; // 内部メタデータは隠す
      if (parts.some(function (p) { return p.charAt(0) === '.'; })) return; // 隠しファイル
      var node = root, acc = '';
      for (var i = 0; i < parts.length; i++) {
        acc = acc ? (acc + '/' + parts[i]) : parts[i];
        var last = (i === parts.length - 1);
        var isDir = last ? (item.type === 'dir') : true;
        var child = node.childMap[parts[i]];
        if (!child) {
          child = { name: parts[i], path: acc, type: isDir ? 'dir' : 'file', ext: last ? item.ext : '', children: [], childMap: {} };
          node.childMap[parts[i]] = child;
          node.children.push(child);
        }
        if (last && !isDir) { child.type = 'file'; child.ext = item.ext || extOf(acc); child.size = item.size; }
        node = child;
      }
    });
    return root;
  }

  function sortChildren(node) {
    node.children.sort(function (a, b) {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      // main.* を先頭に
      var am = /^main\./.test(a.name) ? 0 : 1, bm = /^main\./.test(b.name) ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.name.localeCompare(b.name, 'ja');
    });
    node.children.forEach(sortChildren);
  }

  function collapseAll(flat) {
    collapsed = {};
    (flat || []).forEach(function (item) {
      if (!item || !item.path) return;
      var parts = String(item.path).split('/').filter(Boolean);
      var dirCount = item.type === 'dir' ? parts.length : parts.length - 1;
      var acc = '';
      for (var i = 0; i < dirCount; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        collapsed[acc] = true;
      }
    });
  }

  function renderNode(node, depth) {
    var html = '';
    node.children.forEach(function (child) {
      var kind = kindOf(child);
      var pad = 6 + depth * 14;
      var selected = child.path === selectedPath;
      if (child.type === 'dir') {
        var isCol = !!collapsed[child.path];
        html += '<div class="ft-node ft-dir' + (selected ? ' is-selected' : '') + '" role="treeitem" aria-expanded="' + (!isCol) + '" aria-selected="' + selected + '" tabindex="' + (selected ? '0' : '-1') + '" data-path="' + esc(child.path) + '" data-type="dir" draggable="true">' +
          '<div class="ft-row" style="padding-left:' + pad + 'px">' +
          '<span class="ft-twist' + (isCol ? ' is-collapsed' : '') + '" aria-hidden="true">' +
          '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
          '<span class="ft-icon">' + iconSvg('dir', !isCol) + '</span>' +
          '<span class="ft-name">' + esc(child.name) + '</span>' +
          '<button type="button" class="ft-more" title="' + esc(t('ft.more', 'その他')) + '" aria-label="' + esc(t('ft.more', 'その他')) + '">&#8943;</button>' +
          '</div>';
        // フェーズ22: treeitem の親チェーンを保つ(tree > treeitem > group > treeitem)。
        if (!isCol) html += '<div class="ft-children" role="group">' + renderNode(child, depth + 1) + '</div>';
        html += '</div>';
      } else {
        html += '<div class="ft-node ft-file' + (selected ? ' is-selected' : '') + '" role="treeitem" aria-selected="' + selected + '" tabindex="' + (selected ? '0' : '-1') + '" data-path="' + esc(child.path) + '" data-type="file" data-kind="' + kind + '" draggable="true" title="' + esc(child.path) + '">' +
          '<div class="ft-row" style="padding-left:' + (pad + 14) + 'px">' +
          '<span class="ft-icon ft-icon-' + kind + '">' + iconSvg(kind) + '</span>' +
          '<span class="ft-name">' + esc(child.name) + '</span>' +
          '<button type="button" class="ft-more" title="' + esc(t('ft.more', 'その他')) + '" aria-label="' + esc(t('ft.more', 'その他')) + '">&#8943;</button>' +
          '</div></div>';
      }
    });
    return html;
  }

  function render() {
    var host = byId('file-tree');
    if (!host) return;
    var body = host.querySelector('.ft-body');
    if (!body) return;
    if (!projectId) {
      body.innerHTML = '<div class="ft-empty">' + esc(t('ft.noProject', 'プロジェクトがありません')) + '</div>';
      return;
    }
    var root = buildNested(treeData);
    sortChildren(root);
    if (!root.children.length) {
      body.innerHTML = '<div class="ft-empty">' + esc(t('ft.emptyTree', 'ファイルがありません')) + '</div>';
      return;
    }
    body.innerHTML = renderNode(root, 0);
    if (!body.querySelector('.ft-node[tabindex="0"]')) {
      var first = body.querySelector('.ft-node');
      if (first) first.tabIndex = 0;
    }
    updateLocation();
  }

  function updateLocation() {
    var host = byId('file-tree');
    var el = host && host.querySelector('.ft-location-path');
    if (el) el.textContent = selectedPath ? ('/ ' + selectedPath.split('/').join(' / ')) : '/';
  }

  function selectNode(node, focusIt) {
    var host = byId('file-tree');
    if (!host || !node) return;
    var prev = host.querySelectorAll('.ft-node.is-selected');
    for (var i = 0; i < prev.length; i++) {
      prev[i].classList.remove('is-selected'); prev[i].setAttribute('aria-selected', 'false'); prev[i].tabIndex = -1;
    }
    selectedPath = node.getAttribute('data-path') || '';
    selectedIsDir = node.getAttribute('data-type') === 'dir';
    node.classList.add('is-selected'); node.setAttribute('aria-selected', 'true'); node.tabIndex = 0;
    updateLocation();
    if (focusIt) node.focus();
  }

  function nodeByPath(host, path) {
    var nodes = host.querySelectorAll('.ft-node');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute('data-path') === path) return nodes[i];
    return null;
  }

  /* ================= 読み込み ================= */
  function reload() {
    if (!projectId || !window.Projects) { render(); return Promise.resolve(); }
    return window.Projects.tree(projectId).then(function (arr) {
      treeData = arr || [];
      if (collapseOnLoad) { collapseAll(treeData); collapseOnLoad = false; }
      render();
    }).catch(function () {
      // API 未実装/失敗でも UI は落とさない
      treeData = [];
      render();
    });
  }

  function setProject(id) {
    projectId = id || null;
    collapsed = {};
    collapseOnLoad = true;
    selectedPath = '';
    selectedIsDir = false;
    return reload();
  }
  function load(id) { return setProject(id); }
  function currentProject() { return projectId; }

  /* ================= #file-viewer ================= */
  var viewerState = { path: null, kind: null, editable: false, dirty: false };

  function viewerEl() { return byId('file-viewer'); }

  function showViewer() {
    var v = viewerEl();
    if (v) v.hidden = false;
    if (byId('workspace')) byId('workspace').classList.add('has-fileviewer');
  }
  function closeViewer() {
    var v = viewerEl();
    if (v) v.hidden = true;
    if (byId('workspace')) byId('workspace').classList.remove('has-fileviewer');
    viewerState = { path: null, kind: null, editable: false, dirty: false };
  }

  function setViewerTitle(path) {
    var v = viewerEl(); if (!v) return;
    var titleEl = v.querySelector('.fv-title');
    if (titleEl) titleEl.textContent = path || '';
    var dl = v.querySelector('.fv-download');
    if (dl && projectId) dl.setAttribute('href', window.Projects.fileUrl(projectId, path));
  }

  function appendMarkdownInline(host, text) {
    var source = String(text || '');
    var re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
    var last = 0;
    var match;
    while ((match = re.exec(source))) {
      if (match.index > last) host.appendChild(document.createTextNode(source.slice(last, match.index)));
      if (match[3] != null) {
        var strong = document.createElement('strong'); strong.textContent = match[3]; host.appendChild(strong);
        last = re.lastIndex; continue;
      }
      if (match[4] != null) {
        var code = document.createElement('code'); code.textContent = match[4]; host.appendChild(code);
        last = re.lastIndex; continue;
      }
      var href = match[2].trim();
      var link = document.createElement('a');
      link.textContent = match[1];
      if (href.indexOf('project:') === 0) {
        var projectPath = href.slice(8);
        try { projectPath = decodeURI(projectPath); } catch (e) { /* keep encoded path */ }
        link.href = '#';
        link.setAttribute('data-project-path', projectPath);
      } else if (/^https?:\/\//i.test(href)) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.href = '#';
        link.setAttribute('data-project-path', href);
      }
      host.appendChild(link);
      last = re.lastIndex;
    }
    if (last < source.length) host.appendChild(document.createTextNode(source.slice(last)));
  }

  function renderMarkdown(body, text) {
    body.innerHTML = '';
    var article = document.createElement('article');
    article.className = 'fv-markdown';
    var list = null; var fence = null; var fenceLines = []; var tableBody = null; var skipTableRule = false;
    var markdownLines = String(text || '').split(/\r?\n/);
    function tableCells(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim(); });
    }
    function appendTableRow(section, cells, tag) {
      var row = document.createElement('tr');
      cells.forEach(function (cell) {
        var el = document.createElement(tag); appendMarkdownInline(el, cell); row.appendChild(el);
      });
      section.appendChild(row);
    }
    markdownLines.forEach(function (line, lineIndex) {
      if (skipTableRule) { skipTableRule = false; return; }
      var fenceHit = /^```\s*([\w-]*)/.exec(line);
      if (fenceHit) {
        if (fence) {
          var pre = document.createElement('pre'); var code = document.createElement('code');
          code.textContent = fenceLines.join('\n'); pre.appendChild(code); article.appendChild(pre);
          fence = null; fenceLines = [];
        } else { fence = fenceHit[1] || 'text'; fenceLines = []; }
        list = null; return;
      }
      if (fence) { fenceLines.push(line); return; }
      var nextLine = markdownLines[lineIndex + 1] || '';
      var isPipeRow = /\|/.test(line) && line.trim().charAt(0) === '|';
      var isTableRule = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine);
      if (isPipeRow && isTableRule) {
        list = null; tableBody = null; skipTableRule = true;
        var wrap = document.createElement('div'); wrap.className = 'fv-table-wrap';
        var table = document.createElement('table'); var head = document.createElement('thead');
        tableBody = document.createElement('tbody'); appendTableRow(head, tableCells(line), 'th');
        table.appendChild(head); table.appendChild(tableBody); wrap.appendChild(table); article.appendChild(wrap); return;
      }
      if (tableBody && isPipeRow) { appendTableRow(tableBody, tableCells(line), 'td'); return; }
      tableBody = null;
      var heading = /^(#{1,3})\s+(.+)$/.exec(line);
      var item = /^\s*[-*]\s+(.+)$/.exec(line);
      var ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      var quote = /^>\s?(.*)$/.exec(line);
      if (heading) {
        list = null;
        var h = document.createElement('h' + heading[1].length);
        appendMarkdownInline(h, heading[2]); article.appendChild(h);
      } else if (item || ordered) {
        var listTag = ordered ? 'OL' : 'UL';
        if (!list || list.tagName !== listTag) { list = document.createElement(listTag.toLowerCase()); article.appendChild(list); }
        var li = document.createElement('li'); appendMarkdownInline(li, (item || ordered)[1]); list.appendChild(li);
      } else if (quote) {
        list = null;
        var blockquote = document.createElement('blockquote'); appendMarkdownInline(blockquote, quote[1]); article.appendChild(blockquote);
      } else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        list = null; article.appendChild(document.createElement('hr'));
      } else if (line.trim()) {
        list = null;
        var p = document.createElement('p'); appendMarkdownInline(p, line); article.appendChild(p);
      } else {
        list = null;
      }
    });
    if (fence) {
      var trailingPre = document.createElement('pre'); var trailingCode = document.createElement('code');
      trailingCode.textContent = fenceLines.join('\n'); trailingPre.appendChild(trailingCode); article.appendChild(trailingPre);
    }
    article.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('a[data-project-path]');
      if (!link) return;
      e.preventDefault();
      var target = link.getAttribute('data-project-path');
      var page = /#page=(\d+)$/.exec(target);
      if (page) target = target.slice(0, page.index);
      openPath(target, page ? { loc: 'p.' + page[1] } : {});
    });
    body.appendChild(article);
  }

  function setMarkdownMode(preview) {
    var v = viewerEl();
    if (!v || viewerState.kind !== 'note' || !viewerState.path) return;
    var body = v.querySelector('.fv-body');
    var modeBtn = v.querySelector('.fv-mode');
    var saveBtn = v.querySelector('.fv-save');
    if (!body || !modeBtn) return;
    if (preview) {
      var ta = body.querySelector('.fv-text');
      if (ta) viewerState.text = ta.value;
      renderMarkdown(body, viewerState.text || '');
      modeBtn.textContent = '編集';
      modeBtn.setAttribute('aria-pressed', 'true');
      if (saveBtn) saveBtn.hidden = true;
    } else {
      body.innerHTML = '<textarea class="fv-text" spellcheck="false"></textarea>';
      var edit = body.querySelector('.fv-text');
      edit.value = viewerState.text || '';
      edit.addEventListener('input', function () { viewerState.dirty = true; viewerState.text = edit.value; });
      modeBtn.textContent = 'プレビュー';
      modeBtn.setAttribute('aria-pressed', 'false');
      if (saveBtn) saveBtn.hidden = false;
    }
  }

  function openViewer(path, opts) {
    opts = opts || {};
    if (!projectId) projectId = (window.Projects && window.Projects.current && window.Projects.current()) || projectId;
    if (!projectId) return;
    var v = viewerEl();
    if (!v) return;
    var body = v.querySelector('.fv-body');
    if (!body) return;
    var kind = kindOf({ path: path, type: 'file' });
    viewerState = { path: path, kind: kind, editable: false, dirty: false, text: '' };
    setViewerTitle(path);
    showViewer();
    var saveBtn = v.querySelector('.fv-save');
    var modeBtn = v.querySelector('.fv-mode');
    if (modeBtn) modeBtn.hidden = kind !== 'note';

    if (kind === 'pdf') {
      if (saveBtn) saveBtn.hidden = true;
      var src = window.Projects.fileUrl(projectId, path);
      if (opts.loc) {
        var m = /p\.?\s*(\d+)/i.exec(opts.loc);
        if (m) src += '#page=' + m[1];
      }
      body.innerHTML = '<iframe class="fv-frame" title="' + esc(path) + '"></iframe>';
      body.querySelector('.fv-frame').src = src;
      return;
    }
    if (kind === 'img') {
      if (saveBtn) saveBtn.hidden = true;
      body.innerHTML = '<div class="fv-imgwrap"><img alt="' + esc(path) + '" src="' + esc(window.Projects.fileUrl(projectId, path)) + '"></div>';
      return;
    }
    // テキスト系: tex は読み取り専用、bib/md/txt/その他は編集可
    var editable = (kind !== 'tex');
    body.innerHTML = '<div class="fv-loading">' + esc(t('ft.loading', '読み込み中…')) + '</div>';
    if (saveBtn) saveBtn.hidden = !editable;
    window.Projects.readFile(projectId, path, false).then(function (text) {
      if (viewerState.path !== path) return;
      viewerState.editable = editable;
      viewerState.text = text;
      if (editable) {
        if (kind === 'note') setMarkdownMode(true);
        else {
          body.innerHTML = '<textarea class="fv-text" spellcheck="false"></textarea>';
          var ta = body.querySelector('.fv-text');
          ta.value = text;
          ta.addEventListener('input', function () { viewerState.dirty = true; viewerState.text = ta.value; });
        }
      } else {
        body.innerHTML = '<pre class="fv-pre"><code></code></pre>';
        body.querySelector('code').textContent = text;
      }
    }).catch(function (e) {
      if (viewerState.path !== path) return;
      body.innerHTML = '<div class="fv-error">' + esc(t('ft.loadError', '読み込めませんでした')) + ' (' + esc(e && e.message || '') + ')</div>';
      if (saveBtn) saveBtn.hidden = true;
    });
  }

  function saveViewer() {
    var v = viewerEl(); if (!v || !viewerState.path || !viewerState.editable) return;
    var ta = v.querySelector('.fv-text');
    if (!ta || !projectId) return;
    window.Projects.writeFile(projectId, viewerState.path, ta.value).then(function () {
      viewerState.dirty = false;
      if (window.App && window.App.notify) window.App.notify(t('ft.saved', '保存しました'));
      // bib を編集した場合、本文の文献に反映される可能性があるので通知のみ
    }).catch(function (e) {
      if (window.App && window.App.notify) window.App.notify(t('ft.saveFailed', '保存に失敗しました'));
    });
  }

  // main.html はエディタで開く。.tex / .bib は中央のソースエディタで開く。
  // それ以外はビューアで開く。
  function openPath(path, opts) {
    if (path === 'main.html') {
      closeViewer();
      if (window.App && window.App.showMainDoc) window.App.showMainDoc();
      return;
    }
    // TeX と BibTeX はプロジェクトモードなら中央の広いソースエディタで開く。
    if ((extOf(path) === 'tex' || extOf(path) === 'bib') && window.App && window.App.openTexSource &&
        window.App.isProjectMode && window.App.isProjectMode()) {
      closeViewer();
      window.App.openTexSource(path);
      return;
    }
    openViewer(path, opts);
  }

  /* ================= ツールバー操作 ================= */
  function ensureProject() {
    if (!projectId && window.Projects && window.Projects.current) projectId = window.Projects.current();
    return projectId;
  }

  // 新規作成の基準フォルダ: 選択中がフォルダならそれ、ファイルならその親、無ければルート。
  function baseDir() {
    if (selectedIsDir && selectedPath) return selectedPath;
    if (selectedPath) {
      var i = selectedPath.lastIndexOf('/');
      return i > 0 ? selectedPath.slice(0, i) : '';
    }
    return '';
  }
  function joinPath(base, name) {
    name = String(name).replace(/^\/+/, '');
    return base ? (base.replace(/\/+$/, '') + '/' + name) : name;
  }

  function newFile(base) {
    if (!ensureProject()) return;
    base = (base != null) ? base : baseDir();
    var hint = base ? (base + '/ の中の新しいファイル名') : '新しいファイル名(例: notes/memo.md)';
    var name = window.prompt(t('ft.newFilePrompt', hint), 'memo.md');
    if (!name) return;
    var path = joinPath(base, name);
    window.Projects.writeFile(projectId, path, '').then(function () {
      reload().then(function () { openPath(path); });
    }).catch(function () { alert(t('ft.opFailed', '操作に失敗しました')); });
  }

  function newFolder(base) {
    if (!ensureProject()) return;
    base = (base != null) ? base : baseDir();
    var hint = base ? (base + '/ の中の新しいフォルダ名') : '新しいフォルダ名(例: 文献解釈)';
    var name = window.prompt(t('ft.newFolderPrompt', hint), '新しいフォルダ');
    if (!name) return;
    var path = joinPath(base, name).replace(/\/+$/, '');
    var doMkdir = window.Projects.mkdir
      ? window.Projects.mkdir(projectId, path)
      : Promise.reject(new Error('no mkdir'));
    doMkdir.then(function () {
      if (path) collapsed[path] = false;
      reload();
    }).catch(function () {
      // mkdir 未実装(404 等)→ .gitkeep を置いてフォルダを表現(フォールバック)
      window.Projects.writeFile(projectId, path + '/.gitkeep', '').then(function () {
        reload();
      }).catch(function () { alert(t('ft.opFailed', '操作に失敗しました')); });
    });
  }

  function triggerUpload() {
    var input = byId('attach-input');
    if (input) input.click();
  }

  function handleUploadFiles(files) {
    if (!ensureProject() || !files || !files.length) return;
    var jobs = [];
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        var isImg = IMG_EXT[extOf(file.name)];
        jobs.push(window.Projects.upload(projectId, isImg ? 'assets' : 'attachments', file));
      })(files[i]);
    }
    Promise.all(jobs).then(function (paths) {
      reload().then(function () { if (paths[0]) openPath(paths[0]); });
      if (window.App && window.App.notify) window.App.notify(t('ft.uploaded', 'アップロードしました'));
    }).catch(function () { alert(t('ft.uploadFailed', 'アップロードに失敗しました')); });
  }

  function downloadZip() {
    if (!ensureProject()) return;
    window.Projects.download(projectId).then(function (result) {
      if (result && result.clientFallback) return clientZip();
      if (result instanceof Blob) {
        var url = URL.createObjectURL(result);
        var a = document.createElement('a');
        a.href = url; a.download = projectId + '.zip';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      }
    }).catch(function () {
      // サーバー download 未実装(404 等)→ クライアント生成にフォールバック
      clientZip();
    });
  }

  // JSZip でツリーを走査してクライアント側 zip 生成
  function clientZip() {
    if (!window.JSZip) { alert(t('ft.zipUnavailable', 'ダウンロードに失敗しました')); return; }
    var zip = new window.JSZip();
    var files = (treeData || []).filter(function (n) {
      if (n.type !== 'file') return false;
      var parts = n.path.split('/');
      if (parts[0] === 'build') return false;
      if (parts.some(function (p) { return p.charAt(0) === '.'; })) return false;
      return true;
    });
    var jobs = files.map(function (n) {
      var isBin = (n.ext === 'pdf') || IMG_EXT[n.ext];
      return window.Projects.readFile(projectId, n.path, isBin).then(function (data) {
        zip.file(n.path, data, isBin ? { binary: false } : {});
      }).catch(function () {});
    });
    Promise.all(jobs).then(function () {
      return zip.generateAsync({ type: 'blob' });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = (projectId || 'project') + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }).catch(function () { alert(t('ft.zipFailed', 'ZIP 生成に失敗しました')); });
  }

  /* ================= フォルダごとの取り込み(フェーズ15c) ================= */
  function notify(msg) {
    if (window.App && window.App.notify) window.App.notify(msg);
  }
  function fmtBytes(n) {
    n = n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  var MAX_FOLDER_BYTES = 200 * 1024 * 1024;

  // items: [{path, file}]。path は取り込み後の相対パス(階層保持)。
  function ingestFolderItems(items, targetDir) {
    if (!ensureProject()) return;
    if (!window.JSZip) { alert(t('ft.zipUnavailable', 'ZIP 機能を利用できません')); return; }
    // build/ と隠しファイルはクライアント側でも除外(サーバーも除外する)
    var filtered = (items || []).filter(function (it) {
      if (!it || !it.path || !it.file) return false;
      var parts = String(it.path).split('/').filter(Boolean);
      if (!parts.length) return false;
      if (parts.indexOf('build') !== -1) return false;
      if (parts.some(function (p) { return p.charAt(0) === '.'; })) return false;
      return true;
    });
    if (!filtered.length) { alert(t('ft.folderEmpty', '取り込めるファイルがありません')); return; }
    var count = filtered.length;
    var total = 0;
    filtered.forEach(function (it) { total += (it.file && it.file.size) || 0; });
    if (total > MAX_FOLDER_BYTES) {
      alert(t('ft.folderTooLarge', 'フォルダが大きすぎます(上限 200MB)') + ' — ' + fmtBytes(total));
      return;
    }
    notify(t('ft.folderZipping', 'フォルダを圧縮中…') + ' (' + count + ' / ' + fmtBytes(total) + ')');
    var zip = new window.JSZip();
    filtered.forEach(function (it) { zip.file(it.path, it.file); });
    zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } })
      .then(function (blob) {
        notify(t('ft.folderUploading', 'アップロード中…') + ' (' + fmtBytes(blob.size) + ')');
        return window.Projects.uploadFolder(projectId, targetDir, blob, function (loaded, tot) {
          if (tot) {
            var pct = Math.round((loaded / tot) * 100);
            notify(t('ft.folderUploading', 'アップロード中…') + ' ' + pct + '%');
          }
        });
      })
      .then(function (r) {
        return reload().then(function () {
          var n = (r && r.fileCount != null) ? r.fileCount : count;
          notify(t('ft.folderAdded', 'フォルダを追加しました') + ' (' + count + ' ' + t('ft.filesUnit', 'ファイル') + ')');
        });
      })
      .catch(function (e) {
        alert(t('ft.folderFailed', 'フォルダの追加に失敗しました') + ' (' + (e && e.message || '') + ')');
      });
  }

  // <input webkitdirectory> の FileList → items(webkitRelativePath で階層保持)
  function handleFolderInput(fileList) {
    if (!fileList || !fileList.length) return;
    var items = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rel = f.webkitRelativePath || f.name;
      items.push({ path: rel, file: f });
    }
    ingestFolderItems(items, baseDir());
  }

  // ---- D&D: DataTransferItem.webkitGetAsEntry() で再帰走査 ----
  function readAllEntries(dirReader) {
    return new Promise(function (resolve) {
      var all = [];
      (function batch() {
        dirReader.readEntries(function (entries) {
          if (!entries || !entries.length) { resolve(all); return; }
          all = all.concat(entries);
          batch();
        }, function () { resolve(all); });
      })();
    });
  }
  function walkEntry(entry, items) {
    if (!entry) return Promise.resolve();
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(function (file) {
          var p = String(entry.fullPath || ('/' + file.name)).replace(/^\/+/, '');
          items.push({ path: p, file: file });
          resolve();
        }, function () { resolve(); });
      });
    }
    if (entry.isDirectory) {
      return readAllEntries(entry.createReader()).then(function (entries) {
        return Promise.all(entries.map(function (e) { return walkEntry(e, items); }));
      });
    }
    return Promise.resolve();
  }
  function dtHasFiles(dt) {
    try { return dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0; }
    catch (e) { return false; }
  }
  // OS からのフォルダ/ファイルドロップを処理。処理したら true。
  function handleOsDrop(e, targetDir) {
    var dt = e.dataTransfer;
    if (!dt || !dt.items || !dt.items.length) return false;
    var entries = [];
    var sawDir = false;
    for (var i = 0; i < dt.items.length; i++) {
      var it = dt.items[i];
      if (it.kind === 'file' && it.webkitGetAsEntry) {
        var en = it.webkitGetAsEntry();
        if (en) { entries.push(en); if (en.isDirectory) sawDir = true; }
      }
    }
    // フォルダを含むドロップのみ「フォルダ取り込み」として扱う。
    // (単一ファイルのドロップは既存の添付アップロードに委ねる/邪魔しない)
    if (!entries.length || !sawDir) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    var collected = [];
    Promise.all(entries.map(function (en) { return walkEntry(en, collected); }))
      .then(function () { if (collected.length) ingestFolderItems(collected, targetDir); });
    return true;
  }

  function triggerAddFolder() {
    var input = byId('folder-input');
    if (input) input.click();
  }

  /* ================= ノードの … メニュー(リネーム/削除) ================= */
  function closeNodeMenu() {
    var old = document.querySelector('.ft-context-menu');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  function renameNode(node) {
    var path = node.getAttribute('data-path');
    var to = window.prompt(t('ft.renamePrompt', '新しい名前(パス)'), path);
    if (!to || to === path) return;
    to = to.replace(/^\/+/, '');
    window.Projects.rename(projectId, path, to).then(function () {
      if (viewerState.path === path) closeViewer();
      selectedPath = to;
      reload();
    }).catch(function () { alert(t('ft.opFailed', '操作に失敗しました')); });
  }

  function deleteNode(node) {
    var path = node.getAttribute('data-path');
    if (path === 'main.html') { alert(t('ft.cannotDeleteMain', 'main.html は削除できません')); return; }
    if (!window.confirm(t('ft.confirmDelete', '削除しますか?') + '\n' + path)) return;
    window.Projects.deleteFile(projectId, path).then(function () {
      if (viewerState.path === path) closeViewer();
      selectedPath = ''; selectedIsDir = false;
      reload();
    }).catch(function () { alert(t('ft.opFailed', '操作に失敗しました')); });
  }

  function nodeMenu(node, anchor) {
    closeNodeMenu();
    selectNode(node, false);
    var isDir = node.getAttribute('data-type') === 'dir';
    var menu = document.createElement('div');
    menu.className = 'ft-context-menu'; menu.setAttribute('role', 'menu');
    var actions = [];
    if (isDir) {
      actions.push({ label: t('ft.newFile', '新規ファイル'), run: function () { newFile(selectedPath); } });
      actions.push({ label: t('ft.newFolder', '新規フォルダ'), run: function () { newFolder(selectedPath); } });
    }
    actions.push({ label: t('ft.rename', '名前を変更'), run: function () { renameNode(node); } });
    actions.push({ label: t('ft.delete', '削除'), danger: true, run: function () { deleteNode(node); } });
    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ft-context-item' + (action.danger ? ' danger' : '');
      btn.setAttribute('role', 'menuitem'); btn.textContent = action.label;
      btn.addEventListener('click', function () { closeNodeMenu(); action.run(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    var rect = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button'));
      var idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx <= 0 ? items.length : idx) - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeNodeMenu(); anchor.focus(); }
    });
    var first = menu.querySelector('button'); if (first) first.focus();
  }

  /* ================= イベント ================= */
  function wire() {
    var host = byId('file-tree');
    if (host) {
      // ノード/フォルダ/…クリック
      host.addEventListener('click', function (e) {
        var more = e.target.closest('.ft-more');
        if (more) {
          e.stopPropagation();
          var n = more.closest('.ft-node');
          if (n) nodeMenu(n, more);
          return;
        }
        var node = e.target.closest('.ft-node');
        if (!node) return;
        selectNode(node, false);
        if (node.classList.contains('ft-dir')) {
          var dp = node.getAttribute('data-path');
          collapsed[dp] = !collapsed[dp];
          render();
          var same = nodeByPath(host, dp); if (same) same.focus();
          return;
        }
        var path = node.getAttribute('data-path');
        if (path) openPath(path);
      });

      host.addEventListener('keydown', function (e) {
        var node = e.target.closest && e.target.closest('.ft-node');
        if (!node) return;
        var visible = Array.prototype.slice.call(host.querySelectorAll('.ft-node')).filter(function (n) { return n.offsetParent !== null; });
        var idx = visible.indexOf(node);
        if (e.key === 'ArrowDown' && idx < visible.length - 1) { e.preventDefault(); selectNode(visible[idx + 1], true); }
        else if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); selectNode(visible[idx - 1], true); }
        else if (e.key === 'ArrowRight' && node.classList.contains('ft-dir')) {
          e.preventDefault();
          var p = node.getAttribute('data-path');
          if (collapsed[p]) {
            collapsed[p] = false; render();
            var reopened = nodeByPath(host, p); if (reopened) reopened.focus();
          } else {
            var child = node.querySelector('.ft-children > .ft-node'); if (child) selectNode(child, true);
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          var path = node.getAttribute('data-path');
          if (node.classList.contains('ft-dir') && !collapsed[path]) {
            collapsed[path] = true; render();
            var closed = nodeByPath(host, path); if (closed) closed.focus();
          } else {
            var parent = node.parentElement && node.parentElement.closest('.ft-dir'); if (parent) selectNode(parent, true);
          }
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); var row = node.querySelector('.ft-row'); if (row) row.click();
        }
      });

      // ドラッグ開始: data-path を dataTransfer に載せる(Link がドロップ処理)
      host.addEventListener('dragstart', function (e) {
        var node = e.target.closest ? e.target.closest('.ft-node') : null;
        if (!node) return;
        var path = node.getAttribute('data-path');
        if (!path || node.getAttribute('data-type') !== 'file') { e.preventDefault(); return; }
        try {
          e.dataTransfer.setData('application/x-filelink-path', path);
          e.dataTransfer.setData('text/plain', path);
          e.dataTransfer.effectAllowed = 'copy';
        } catch (err) {}
      });

      // ツールバー
      var tb = host.querySelector('.ft-toolbar');
      if (tb) {
        tb.addEventListener('click', function (e) {
          var btn = e.target.closest('button[data-ft]');
          if (!btn) return;
          var act = btn.getAttribute('data-ft');
          if (act === 'new-file') newFile();
          else if (act === 'new-folder') newFolder();
          else if (act === 'upload') triggerUpload();
          else if (act === 'add-folder') triggerAddFolder();
          else if (act === 'refresh') reload();
          else if (act === 'download') downloadZip();
        });
      }
    }

    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest || (!e.target.closest('.ft-context-menu') && !e.target.closest('.ft-more'))) closeNodeMenu();
    });

    // アップロード input
    var input = byId('attach-input');
    if (input) {
      input.addEventListener('change', function () {
        handleUploadFiles(input.files);
        input.value = '';
      });
    }

    // フォルダ選択 input(webkitdirectory)
    var folderInput = byId('folder-input');
    if (folderInput) {
      folderInput.addEventListener('change', function () {
        handleFolderInput(folderInput.files);
        folderInput.value = '';
      });
    }

    // フォルダの D&D(#file-tree / #doc)。フォルダを含むドロップのみ取り込む。
    document.addEventListener('dragover', function (e) {
      if (!e.target || !e.target.closest) return;
      var inTree = e.target.closest('#file-tree');
      var inDoc = e.target.closest('#doc');
      if (!inTree && !inDoc) return;
      if (!dtHasFiles(e.dataTransfer)) return; // OS ファイル/フォルダのみ
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
    });
    document.addEventListener('drop', function (e) {
      if (!e.target || !e.target.closest) return;
      var treeHost = e.target.closest('#file-tree');
      var inDoc = e.target.closest('#doc');
      if (!treeHost && !inDoc) return;
      if (!dtHasFiles(e.dataTransfer)) return;
      // 展開先: ツリーのフォルダノードにドロップならそのフォルダ、それ以外は選択中/ルート
      var targetDir = baseDir();
      if (treeHost) {
        var dirNode = e.target.closest('.ft-dir');
        if (dirNode) targetDir = dirNode.getAttribute('data-path') || '';
      }
      handleOsDrop(e, targetDir);
    }, true); // capture: filelink の #doc drop より先に判定(フォルダのみ横取り)

    // トグル
    var toggle = byId('toggle-tree');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var ws = byId('workspace');
        var ft = byId('file-tree');
        if (!ws || !ft) return;
        var hidden = ws.classList.toggle('tree-hidden');
        toggle.setAttribute('aria-pressed', hidden ? 'false' : 'true');
      });
    }

    // #file-viewer のボタン
    var v = viewerEl();
    if (v) {
      var closeBtn = v.querySelector('.fv-close');
      if (closeBtn) closeBtn.addEventListener('click', closeViewer);
      var saveBtn = v.querySelector('.fv-save');
      if (saveBtn) saveBtn.addEventListener('click', saveViewer);
      var modeBtn = v.querySelector('.fv-mode');
      if (modeBtn) modeBtn.addEventListener('click', function () {
        setMarkdownMode(modeBtn.getAttribute('aria-pressed') !== 'true');
      });
    }
  }

  function init() {
    wire();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.FileTree = {
    load: load,
    reload: reload,
    setProject: setProject,
    currentProject: currentProject,
    openPath: openPath
  };
  // Agent-Proj-Link 用: ファイルリンククリックでファイルを開く
  window.FileViewer = {
    open: function (path, opts) { openViewer(path, opts); },
    close: closeViewer
  };
})();
