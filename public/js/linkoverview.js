/* linkoverview.js — 本文、メモ、ダウンロード論文の参照先を縦一覧に集約する。 */
(function () {
  'use strict';

  var noteCache = Object.create(null);
  var pdfObserver = null;
  var pdfModal = null;
  var modalPdfSrc = '';
  var modalPdfPage = 1;

  function byId(id) { return document.getElementById(id); }
  function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
  function baseName(path) { var p = String(path || ''); return p.slice(p.lastIndexOf('/') + 1); }
  function fileSize(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function closePdfModal() {
    if (!pdfModal) return;
    var frame = pdfModal.querySelector('iframe'); if (frame) frame.src = 'about:blank';
    pdfModal.hidden = true; document.body.classList.remove('lo-pdf-modal-open');
  }

  function showModalPdfPage(page) {
    if (!pdfModal || !modalPdfSrc) return;
    modalPdfPage = Math.max(1, parseInt(page, 10) || 1);
    var input = pdfModal.querySelector('.lo-pdf-page');
    var previous = pdfModal.querySelector('.lo-pdf-prev');
    if (input) input.value = modalPdfPage;
    if (previous) previous.disabled = modalPdfPage === 1;
    pdfModal.querySelector('iframe').src = modalPdfSrc + '#page=' + modalPdfPage + '&view=FitH&toolbar=0&navpanes=0';
  }

  function openPdfModal(src, label) {
    if (!pdfModal) {
      pdfModal = document.createElement('div'); pdfModal.className = 'lo-pdf-modal'; pdfModal.hidden = true;
      pdfModal.innerHTML = '<div class="lo-pdf-modal-head"><strong></strong><div class="lo-pdf-pager"><button class="lo-pdf-prev" type="button" aria-label="前のページ">‹</button><label>ページ <input class="lo-pdf-page" type="number" min="1" inputmode="numeric" aria-label="ページ番号"></label><button class="lo-pdf-next" type="button" aria-label="次のページ">›</button></div><button class="lo-pdf-modal-close" type="button" aria-label="PDFを閉じる">×</button></div><iframe title="論文PDFページ表示"></iframe>';
      document.body.appendChild(pdfModal);
      pdfModal.querySelector('.lo-pdf-modal-close').addEventListener('click', closePdfModal);
      pdfModal.querySelector('.lo-pdf-prev').addEventListener('click', function () { showModalPdfPage(modalPdfPage - 1); });
      pdfModal.querySelector('.lo-pdf-next').addEventListener('click', function () { showModalPdfPage(modalPdfPage + 1); });
      pdfModal.querySelector('.lo-pdf-page').addEventListener('change', function (e) { showModalPdfPage(e.target.value); });
    }
    var pageMatch = String(src || '').match(/#(?:[^#]*&)?page=(\d+)/);
    modalPdfSrc = String(src || '').split('#')[0];
    pdfModal.querySelector('strong').textContent = label || '論文PDF';
    pdfModal.hidden = false; document.body.classList.add('lo-pdf-modal-open');
    showModalPdfPage(pageMatch ? pageMatch[1] : 1);
  }

  function close() {
    var panel = byId('link-overview'); var toggle = byId('toggle-link-overview');
    if (panel) { panel.hidden = true; panel.classList.remove('is-fullscreen'); }
    document.body.classList.remove('link-overview-modal');
    var expand = document.querySelector('#link-overview .lo-expand');
    if (expand) { expand.setAttribute('aria-pressed', 'false'); expand.textContent = '⛶'; expand.setAttribute('aria-label', '参照リンク一覧を全画面で表示'); }
    if (toggle) toggle.setAttribute('aria-pressed', 'false');
  }

  function toggleFullscreen() {
    var panel = byId('link-overview'); var expand = document.querySelector('#link-overview .lo-expand');
    if (!panel) return;
    var full = panel.classList.toggle('is-fullscreen');
    document.body.classList.toggle('link-overview-modal', full);
    if (expand) {
      expand.setAttribute('aria-pressed', full ? 'true' : 'false');
      expand.textContent = full ? '🗗' : '⛶';
      expand.setAttribute('aria-label', full ? '右パネル表示に戻す' : '参照リンク一覧を全画面で表示');
      expand.setAttribute('title', full ? '右パネルに戻す' : '全画面で表示');
    }
  }

  function openProjectFile(path) {
    var page = /#page=(\d+)$/.exec(path);
    if (page) path = path.slice(0, page.index);
    if (window.FileTree && window.FileTree.openPath) window.FileTree.openPath(path, page ? { loc: 'p.' + page[1] } : {});
  }

  function bodyItems() {
    var doc = byId('doc'); if (!doc) return [];
    return Array.prototype.map.call(doc.querySelectorAll('a[href], .filelink[data-path]'), function (node, index) {
      var filePath = node.getAttribute('data-path');
      var href = filePath || node.getAttribute('href') || '';
      var block = node.closest('p,h1,h2,h3,li,td,blockquote') || node;
      return {
        label: short(node.textContent, 80) || href,
        location: '本文 · ' + (short(block.textContent, 90) || ('リンク ' + (index + 1))) +
          (!filePath && href ? ' · ' + href : ''),
        kind: filePath ? '資料' : 'URL',
        openLabel: '本文位置へ',
        action: function () {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node.classList.remove('anchor-jump-flash'); void node.offsetWidth; node.classList.add('anchor-jump-flash');
          setTimeout(function () { if (node && node.classList) node.classList.remove('anchor-jump-flash'); }, 1800);
          if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
          try { node.focus({ preventScroll: true }); } catch (e) { try { node.focus(); } catch (x) {} }
        }
      };
    });
  }

  function parseNoteLinks(path, text) {
    var out = []; var re = /\[([^\]]+)\]\(([^)]+)\)/g; var match;
    while ((match = re.exec(String(text || '')))) {
      var target = match[2].trim();
      var before = String(text || '').slice(0, match.index);
      var line = before.split(/\r?\n/).length;
      out.push({ label: match[1], target: target, source: path, line: line });
    }
    return out;
  }

  function mapLimited(items, limit, work) {
    var results = new Array(items.length); var next = 0;
    function worker() {
      var index = next++;
      if (index >= items.length) return Promise.resolve();
      return Promise.resolve(work(items[index], index)).then(function (value) {
        results[index] = value;
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  function projectItems() {
    var pid = window.Projects && window.Projects.current && window.Projects.current();
    if (!pid) return Promise.resolve({ notes: [], papers: [], links: [] });
    return window.Projects.tree(pid).then(function (tree) {
      var files = tree.filter(function (e) { return e && e.type === 'file'; });
      // 取り込み済みプロジェクトでは notes/・attachments/ 以外にも既存資料がある。
      // build 出力だけ除き、場所に依存せず全 Markdown / PDF を参照対象にする。
      function outsideBuild(e) { return !/(^|\/)build\//i.test(e.path); }
      var notes = files.filter(function (e) { return outsideBuild(e) && /\.md$/i.test(e.path); });
      var papers = files.filter(function (e) { return outsideBuild(e) && /\.pdf$/i.test(e.path); });
      return mapLimited(notes, 6, function (note) {
        var cacheKey = pid + ':' + note.path;
        var cached = noteCache[cacheKey];
        if (cached && cached.size === note.size) return { note: note, text: cached.text, links: cached.links };
        return window.Projects.readFile(pid, note.path, false).then(function (text) {
          var links = parseNoteLinks(note.path, text);
          noteCache[cacheKey] = { size: note.size, text: text, links: links };
          return { note: note, text: text, links: links };
        }).catch(function () { return { note: note, text: '', links: [] }; });
      }).then(function (read) {
        return {
          notes: read.map(function (r) { return {
            path: r.note.path,
            title: (/^#\s+(.+)$/m.exec(r.text) || [null, baseName(r.note.path)])[1],
            text: String(r.text || '').replace(/^#\s+.*(?:\r?\n)+/, '')
          }; }),
          papers: papers.map(function (p) { return { path: p.path, size: p.size || 0 }; }),
          links: read.reduce(function (all, r) { return all.concat(r.links); }, [])
        };
      });
    });
  }

  function addSection(body, title, items) {
    if (!items.length) return;
    var heading = document.createElement('h3'); heading.className = 'lo-section-title'; heading.textContent = title + ' (' + items.length + ')'; body.appendChild(heading);
    items.forEach(function (item) {
      var card = document.createElement('article'); card.className = 'lo-item'; card.tabIndex = 0;
      var label = document.createElement('span'); label.className = 'lo-label';
      var kind = document.createElement('span'); kind.className = 'lo-kind'; kind.textContent = item.kind || '';
      label.appendChild(kind); label.appendChild(document.createTextNode(item.label));
      var location = document.createElement('span'); location.className = 'lo-location'; location.textContent = item.location || '';
      card.appendChild(label); card.appendChild(location);
      if (item.preview != null) {
        var preview = document.createElement('div'); preview.className = 'lo-preview';
        var full = String(item.preview || ''); var collapsed = full.length > 1200;
        preview.textContent = collapsed ? full.slice(0, 1200) + '…' : full;
        card.appendChild(preview);
        if (collapsed) {
          var expand = document.createElement('button'); expand.type = 'button'; expand.className = 'lo-card-btn'; expand.textContent = '全文を展開';
          expand.addEventListener('click', function () {
            var open = expand.getAttribute('aria-expanded') === 'true';
            preview.textContent = open ? full.slice(0, 1200) + '…' : full;
            expand.textContent = open ? '全文を展開' : '折りたたむ'; expand.setAttribute('aria-expanded', open ? 'false' : 'true');
          });
          card.appendChild(expand);
        }
      }
      if (item.action) {
        var openButton = document.createElement('button'); openButton.type = 'button'; openButton.className = 'lo-card-btn lo-open-btn';
        openButton.textContent = item.openLabel || '個別に開く'; openButton.addEventListener('click', item.action); card.appendChild(openButton);
      }
      body.appendChild(card);
    });
  }

  function literaturePairs(data) {
    var noteMap = Object.create(null); var pdfMap = Object.create(null);
    data.notes.forEach(function (n) { noteMap[n.path] = n; });
    data.papers.forEach(function (p) { pdfMap[p.path] = p; });
    var seen = Object.create(null); var out = [];
    data.links.forEach(function (link) {
      var target = String(link.target || '').replace(/^project:/, '').replace(/#page=\d+$/, '');
      try { target = decodeURI(target); } catch (e) {}
      if (!/citations_verify\/factcheck_opus\/[^/]+\.md$/i.test(target)) return;
      var key = baseName(target).replace(/\.md$/i, ''); var pdfPath = 'citations_verify/' + key + '.pdf';
      if (!seen[key] && noteMap[target] && pdfMap[pdfPath]) { seen[key] = true; out.push({ key:key, note:noteMap[target], pdf:pdfMap[pdfPath] }); }
    });
    return out;
  }

  function observePdfSlots(body) {
    if (pdfObserver) pdfObserver.disconnect();
    if (!window.IntersectionObserver) {
      Array.prototype.forEach.call(body.querySelectorAll('.lo-pdf-slot'), function (slot) {
        var frame = document.createElement('iframe'); frame.className = 'lo-pdf-frame'; frame.loading = 'lazy';
        frame.title = '論文PDF: ' + slot.getAttribute('data-label'); frame.src = slot.getAttribute('data-src') + '#page=1&view=FitH';
        slot.textContent = ''; slot.appendChild(frame);
      });
      return;
    }
    pdfObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.target.querySelector('iframe')) return;
        var frame = document.createElement('iframe'); frame.className = 'lo-pdf-frame'; frame.loading = 'lazy';
        frame.title = '論文PDF: ' + entry.target.getAttribute('data-label');
        frame.src = entry.target.getAttribute('data-src') + '#page=1&view=FitH&toolbar=0';
        entry.target.textContent = ''; entry.target.appendChild(frame); pdfObserver.unobserve(entry.target);
      });
    }, { root: body, rootMargin: '900px 0px', threshold: 0.01 });
    Array.prototype.forEach.call(body.querySelectorAll('.lo-pdf-slot'), function (slot) { pdfObserver.observe(slot); });
  }

  function addLiteratureStream(body, pairs) {
    if (!pairs.length) return;
    var heading = document.createElement('h3'); heading.className = 'lo-section-title';
    heading.textContent = '論文メモ＋PDF · スクロール閲覧 (' + pairs.length + ')'; body.appendChild(heading);
    var pid = window.Projects && window.Projects.current && window.Projects.current();
    pairs.forEach(function (pair) {
      var card = document.createElement('article'); card.className = 'lo-item lo-literature-item';
      var title = document.createElement('h4'); title.className = 'lo-literature-title'; title.textContent = pair.key; card.appendChild(title);
      var noteLabel = document.createElement('div'); noteLabel.className = 'lo-stream-label'; noteLabel.textContent = '📝 論文メモ'; card.appendChild(noteLabel);
      var memo = document.createElement('div'); memo.className = 'lo-preview lo-literature-note'; memo.textContent = pair.note.text; card.appendChild(memo);
      var pdfLabel = document.createElement('div'); pdfLabel.className = 'lo-stream-label'; pdfLabel.textContent = '📄 論文PDF · ' + fileSize(pair.pdf.size); card.appendChild(pdfLabel);
      var slot = document.createElement('div'); slot.className = 'lo-pdf-slot'; slot.tabIndex = 0; slot.setAttribute('role', 'button'); slot.textContent = '1ページ目の軽量プレビューを読み込みます…';
      var pdfSrc = window.Projects.fileUrl(pid, pair.pdf.path);
      slot.setAttribute('data-label', pair.key); slot.setAttribute('data-src', pdfSrc); slot.setAttribute('aria-label', pair.key + ' のPDFを全画面で開く');
      slot.addEventListener('click', function () { openPdfModal(pdfSrc, pair.key); }); card.appendChild(slot);
      slot.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPdfModal(pdfSrc, pair.key); } });
      body.appendChild(card);
    });
    observePdfSlots(body);
  }

  function refresh() {
    var body = document.querySelector('#link-overview .lo-body'); var count = document.querySelector('#link-overview .lo-count');
    if (!body) return Promise.resolve();
    body.innerHTML = '<div class="lo-status">参照先を集めています…</div>';
    var inBody = bodyItems();
    return projectItems().then(function (data) {
      body.innerHTML = '';
      var pairs = literaturePairs(data);
      var pairedNotes = Object.create(null); var pairedPdfs = Object.create(null);
      pairs.forEach(function (p) { pairedNotes[p.note.path] = true; pairedPdfs[p.pdf.path] = true; });
      var notes = data.notes.map(function (n) { return {
        kind: 'メモ', label: n.title, location: n.path, preview: n.text,
        openLabel: '編集画面で開く', action: function () { openProjectFile(n.path); }
      }; }).filter(function (n) { return !pairedNotes[n.location]; });
      var papers = data.papers.filter(function (p) { return !pairedPdfs[p.path]; }).map(function (p) { return { kind: 'PDF', label: baseName(p.path), location: p.path, openLabel: 'PDFを開く', action: function () { openProjectFile(p.path); } }; });
      var noteLinks = data.links.filter(function (l) { return l.source !== 'notes/literature/論文メモとPDF.md'; }).map(function (l) {
        var internal = l.target.indexOf('project:') === 0 || !/^https?:\/\//i.test(l.target);
        return { kind: internal ? '資料' : 'URL', label: l.label,
          location: l.source + ' · ' + l.line + '行目' + (!internal ? ' · ' + l.target : ''),
          openLabel: internal ? '資料を開く' : '外部URLを開く', action: function () {
          var target = l.target.indexOf('project:') === 0 ? l.target.slice(8) : l.target;
          try { target = decodeURI(target); } catch (e) { /* keep original */ }
          if (internal) openProjectFile(target); else window.open(target, '_blank', 'noopener');
        } };
      });
      addLiteratureStream(body, pairs);
      addSection(body, '本文のリンク箇所', inBody);
      addSection(body, 'メモ内のリンク', noteLinks);
      addSection(body, 'メモ', notes);
      addSection(body, 'ダウンロード済み論文', papers);
      var total = pairs.length + inBody.length + noteLinks.length + notes.length + papers.length;
      if (!total) body.innerHTML = '<div class="lo-empty">リンク、メモ、論文はまだありません。</div>';
      if (count) count.textContent = total + '件 · 縦にスクロールできます';
    }).catch(function (e) {
      body.innerHTML = '<div class="lo-status">一覧を読み込めませんでした (' + short(e && e.message, 80) + ')</div>';
      if (count) count.textContent = '';
    });
  }

  function toggle() {
    var panel = byId('link-overview'); var button = byId('toggle-link-overview'); if (!panel) return;
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    if (button) button.setAttribute('aria-pressed', 'true');
    refresh();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var toggleButton = byId('toggle-link-overview'); if (toggleButton) toggleButton.addEventListener('click', toggle);
    var closeButton = document.querySelector('#link-overview .lo-close'); if (closeButton) closeButton.addEventListener('click', close);
    var refreshButton = document.querySelector('#link-overview .lo-refresh'); if (refreshButton) refreshButton.addEventListener('click', refresh);
    var expandButton = document.querySelector('#link-overview .lo-expand'); if (expandButton) expandButton.addEventListener('click', toggleFullscreen);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && pdfModal && !pdfModal.hidden) { e.preventDefault(); closePdfModal(); return; }
      if (e.key !== 'Escape') return;
      var panel = byId('link-overview');
      if (panel && panel.classList.contains('is-fullscreen')) { e.preventDefault(); toggleFullscreen(); }
    });
  });

  // 本文中の通常URLも、まず個別ページではなく参照ストリームへ集約する。
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest && e.target.closest('#doc a[href]:not(.filelink)');
    if (!link) return;
    e.preventDefault();
    var panel = byId('link-overview'); var button = byId('toggle-link-overview');
    if (panel) { panel.hidden = false; if (button) button.setAttribute('aria-pressed', 'true'); refresh(); }
  });

  window.LinkOverview = { open: function () {
    var p = byId('link-overview'); var b = byId('toggle-link-overview');
    if (p) { p.hidden = false; if (b) b.setAttribute('aria-pressed', 'true'); refresh(); }
  }, close: close, refresh: refresh };
})();
