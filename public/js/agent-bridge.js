/* agent-bridge.js — フェーズ5: MCP ⇄ エディタ ブリッジ(ブラウザ側)
 *
 * サーバーの SSE(GET /events)に接続し、mcp-server.js からの RPC を受けて
 * #doc を操作し、結果を POST /agent/result で返す。編集は既存の公開 API
 * (window.Editor.exec / window.App / window.LatexGen / window.Docx / window.A11y)
 * のみを経由し、undo スタック・autosave 経路に乗せる(input イベント発火)。
 */
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }
  function doc() { return byId('doc'); }

  /* ================= HTML 正規化(許可 DOM) ================= */

  // docx.js の normalizeDocxHtml を流用(mammoth 出力 → 許可 DOM 変換だが、
  // 一般の HTML も許可 DOM へ落とし込める)。無ければ簡易正規化にフォールバック。
  function normalizeHtml(html) {
    if (window.Docx && typeof window.Docx.normalizeDocxHtml === 'function') {
      try { return window.Docx.normalizeDocxHtml(String(html || '')); } catch (e) { /* fall through */ }
    }
    return simpleNormalize(String(html || ''));
  }

  var ALLOWED_BLOCK = /^(P|H1|H2|H3|BLOCKQUOTE|PRE|UL|OL|LI|TABLE|TR|TD|TH|FIGURE|IMG|HR)$/;
  var ALLOWED_INLINE = /^(STRONG|EM|U|S|SUB|SUP|A|BR|SPAN)$/;

  function simpleNormalize(html) {
    var tpl = document.createElement('div');
    tpl.innerHTML = html;
    var out = [];
    var kids = tpl.childNodes;
    for (var i = 0; i < kids.length; i++) normBlockSimple(kids[i], out);
    var s = out.join('');
    return s.trim() ? s : '<p><br></p>';
  }
  function escText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inlineSimple(node) {
    if (node.nodeType === 3) return escText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    var tagn = node.nodeName;
    var inner = '';
    for (var i = 0; i < node.childNodes.length; i++) inner += inlineSimple(node.childNodes[i]);
    if (tagn === 'BR') return '<br>';
    if (tagn === 'A') {
      var href = node.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return inner;
      return '<a href="' + escText(href).replace(/"/g, '&quot;') + '">' + inner + '</a>';
    }
    if (tagn === 'SPAN') {
      var cls = node.className || '';
      if (/\b(hl|fc|ff-serif|ff-sans|ff-mono|fs|math-inline)\b/.test(cls)) {
        return '<span class="' + cls + '">' + inner + '</span>';
      }
      return inner;
    }
    if (ALLOWED_INLINE.test(tagn)) return '<' + tagn.toLowerCase() + '>' + inner + '</' + tagn.toLowerCase() + '>';
    return inner;
  }
  function normBlockSimple(node, out) {
    if (node.nodeType === 3) {
      if (node.nodeValue.trim()) out.push('<p>' + escText(node.nodeValue.trim()) + '</p>');
      return;
    }
    if (node.nodeType !== 1) return;
    var tagn = node.nodeName;
    if (tagn === 'DIV' || tagn === 'SECTION' || tagn === 'ARTICLE') {
      for (var i = 0; i < node.childNodes.length; i++) normBlockSimple(node.childNodes[i], out);
      return;
    }
    if (tagn === 'UL' || tagn === 'OL' || tagn === 'TABLE') { out.push(node.outerHTML); return; }
    if (tagn === 'HR') { out.push('<hr>'); return; }
    if (ALLOWED_BLOCK.test(tagn)) {
      var inner = '';
      for (var j = 0; j < node.childNodes.length; j++) inner += inlineSimple(node.childNodes[j]);
      var t = tagn.toLowerCase();
      var cls = '';
      if (tagn === 'P' && /\b(title|subtitle)\b/.test(node.className || '')) {
        cls = ' class="' + (/\btitle\b/.test(node.className) ? 'title' : 'subtitle') + '"';
      }
      if (tagn === 'PRE') cls = ' class="code"';
      out.push('<' + t + cls + '>' + (inner || '<br>') + '</' + t + '>');
      return;
    }
    // 不明ブロック: 子を辿る
    for (var k = 0; k < node.childNodes.length; k++) normBlockSimple(node.childNodes[k], out);
  }

  /* ================= 編集後の共通処理 ================= */

  // #doc を変更したら input を発火し、editor.js の自動スナップショット(undo)と
  // app.js の autosave/プレビュー再コンパイル経路へ乗せる。
  function afterEdit() {
    var d = doc();
    if (!d) return;
    // フェーズ20: MCP(Claude)の編集をライブセッションへ「Claude」在席として反映。
    //   live.js が起動していれば presence に Claude を登録し、直後の本文同期を促す。
    //   input イベントも live.js の #doc 監視で拾われ、他デバイスへ即ブロードキャストされる。
    if (window.Live && typeof window.Live.markAgentEdit === 'function') {
      try { window.Live.markAgentEdit(); } catch (e) { /* ignore */ }
    }
    d.dispatchEvent(new Event('input', { bubbles: true }));
    if (window.Editor && typeof window.Editor.refresh === 'function') {
      try { window.Editor.refresh(); } catch (e) { /* ignore */ }
    }
    if (window.A11y && typeof window.A11y.announce === 'function') {
      try { window.A11y.announce('Claudeが文書を編集しました'); } catch (e) { /* ignore */ }
    }
  }

  function docTitle() {
    var el = byId('doc-title');
    var t = el ? (el.textContent || '') : '';
    return t.replace(/\s*[-–]\s*(?:Word風LaTeX|RaTeX|TailorTeX)\s*$/, '').trim() || '無題の文書';
  }

  function currentLatex() {
    var d = doc();
    if (!d || !window.LatexGen) return '';
    var opt = (window.App && window.App.getOptions) ? window.App.getOptions() : {};
    return window.LatexGen.generate(d, {
      margin: opt.margin,
      landscape: opt.landscape,
      toc: opt.toc,
      comments: (window.Editor && window.Editor.getComments) ? window.Editor.getComments() : null,
      bibStyle: (window.App && window.App.bib) ? window.App.bib.getStyle() : 'plain',
    });
  }

  /* ================= テキスト探索ユーティリティ ================= */

  function skipContainer(node) {
    // math / cite / comment-ref など contenteditable=false や校閲マーカー内の
    // テキストは検索・置換の対象にしない(装飾タグまたぎ探索でも一貫して除外)。
    var el = node.parentNode;
    while (el && el !== doc()) {
      if (el.nodeType === 1 && el.classList &&
        (el.classList.contains('math-inline') || el.classList.contains('math-display') ||
         el.classList.contains('cite') || el.classList.contains('comment-ref'))) return true;
      el = el.parentNode;
    }
    return false;
  }

  function textNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var list = [];
    var n;
    while ((n = walker.nextNode())) { if (!skipContainer(n)) list.push(n); }
    return list;
  }

  // needle を最初に含むテキストノードと開始位置を返す
  function findTextNode(root, needle) {
    if (!needle) return null;
    var nodes = textNodes(root);
    for (var i = 0; i < nodes.length; i++) {
      var idx = nodes[i].nodeValue.indexOf(needle);
      if (idx !== -1) return { node: nodes[i], index: idx };
    }
    return null;
  }

  // needle を含む最上位ブロック要素を返す
  function findBlock(root, needle) {
    var hit = findTextNode(root, needle);
    if (!hit) return null;
    var el = hit.node.parentNode;
    while (el && el.parentNode !== root && el !== root) el = el.parentNode;
    return (el && el !== root) ? el : null;
  }

  function selectRange(node, start, end) {
    var range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
  }

  /* ---- 装飾タグまたぎ探索(テキストノード連結オフセット方式) ----
   * #doc 配下の(除外コンテナ以外の)テキストノードを文書順に連結し、
   * グローバルオフセット → {node, localOffset} の対応表を作る。これにより
   * 「太<strong>字</strong>」のように <strong> 等でテキストが分断されていても、
   * 連結後の文字列 "太字" に対して検索し、複数ノードにまたがる Range を組める。 */
  function buildTextMap(root) {
    var nodes = textNodes(root); // skipContainer(math/cite/comment-ref)は除外済み
    var full = '';
    var map = [];
    for (var i = 0; i < nodes.length; i++) {
      var v = nodes[i].nodeValue;
      map.push({ node: nodes[i], start: full.length, end: full.length + v.length });
      full += v;
    }
    return { full: full, map: map };
  }

  // グローバルオフセット pos を {node, offset} に解決する
  function locateOffset(map, pos) {
    for (var i = 0; i < map.length; i++) {
      if (pos >= map[i].start && pos <= map[i].end) {
        return { node: map[i].node, offset: pos - map[i].start };
      }
    }
    if (map.length) {
      var last = map[map.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    }
    return null;
  }

  // needle を fromPos 以降で連結文字列から探し、またぎ対応の Range を返す
  function findRangeAcross(root, needle, fromPos) {
    if (!needle) return null;
    var tm = buildTextMap(root);
    var idx = tm.full.indexOf(needle, fromPos || 0);
    if (idx === -1) return null;
    var s = locateOffset(tm.map, idx);
    var e = locateOffset(tm.map, idx + needle.length);
    if (!s || !e) return null;
    var range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return { range: range, index: idx, full: tm.full };
  }

  /* ---- ブロック構造ユーティリティ ---- */

  // #doc 直下のブロック要素から段落スタイル名を推定
  function blockStyle(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName;
    if (tag === 'H1') return 'h1';
    if (tag === 'H2') return 'h2';
    if (tag === 'H3') return 'h3';
    if (tag === 'BLOCKQUOTE') return 'quote';
    if (tag === 'PRE') return 'code';
    if (tag === 'P') {
      var c = el.className || '';
      if (/\btitle\b/.test(c)) return 'title';
      if (/\bsubtitle\b/.test(c)) return 'subtitle';
      return 'normal';
    }
    return null; // ul/ol/table/hr/figure/div など段落スタイル対象外
  }

  // 正規化済み HTML を DOM ノード配列に展開
  function htmlToNodes(html) {
    var norm = normalizeHtml(html);
    var holder = document.createElement('div');
    holder.innerHTML = norm;
    var nodes = [];
    for (var i = 0; i < holder.childNodes.length; i++) nodes.push(holder.childNodes[i]);
    return nodes;
  }

  // フェーズ25: ブロックノード群を position 指定で #doc に挿入する共通処理。
  //   insert_content / insert_math で共有。返り値は解決後の position。
  //   position: "end"(既定) / "start" / "after_heading"(heading 指定)。
  function insertBlocksAt(d, nodes, position, heading) {
    position = position || 'end';
    var i;
    if (position === 'start') {
      var first = d.firstChild;
      for (i = 0; i < nodes.length; i++) d.insertBefore(nodes[i], first);
    } else if (position === 'after_heading') {
      var target = null;
      var heads = d.querySelectorAll('h1, h2, h3, p.title, p.subtitle');
      var want = heading ? String(heading) : '';
      for (var h = 0; h < heads.length; h++) {
        if (!want || (heads[h].textContent || '').indexOf(want) !== -1) { target = heads[h]; break; }
      }
      if (target) {
        var ref = target.nextSibling;
        for (i = 0; i < nodes.length; i++) d.insertBefore(nodes[i], ref);
      } else {
        for (i = 0; i < nodes.length; i++) d.appendChild(nodes[i]);
        position = 'end';
      }
    } else {
      for (i = 0; i < nodes.length; i++) d.appendChild(nodes[i]);
      position = 'end';
    }
    return position;
  }

  // フェーズ25: インライン要素(数式 span・引用 span)を position 指定で挿入する。
  //   既存の本文ブロック(p/h1-3/blockquote/li)があればその中に入れ、無ければ
  //   <p> でくるんでブロックとして挿入する。返り値は解決後の position。
  var TEXT_BLOCK_SEL = 'p, h1, h2, h3, blockquote, li';
  function insertInlineByPosition(d, inlineNode, position, heading) {
    position = position || 'end';
    function isTextBlock(el) {
      return el && el.nodeType === 1 && el.matches && el.matches(TEXT_BLOCK_SEL);
    }
    if (position === 'after_heading') {
      var heads = d.querySelectorAll('h1, h2, h3, p.title, p.subtitle');
      var want = heading ? String(heading) : '';
      var target = null;
      for (var h = 0; h < heads.length; h++) {
        if (!want || (heads[h].textContent || '').indexOf(want) !== -1) { target = heads[h]; break; }
      }
      if (target) {
        var next = target.nextElementSibling;
        if (isTextBlock(next)) { next.appendChild(inlineNode); return 'after_heading'; }
        var wrap = document.createElement('p');
        wrap.appendChild(inlineNode);
        d.insertBefore(wrap, target.nextSibling);
        return 'after_heading';
      }
      position = 'end';
    }
    var block;
    if (position === 'start') block = d.firstElementChild;
    else block = d.lastElementChild;
    if (isTextBlock(block)) {
      if (position === 'start') block.insertBefore(inlineNode, block.firstChild);
      else block.appendChild(inlineNode);
      return position === 'start' ? 'start' : 'end';
    }
    var p = document.createElement('p');
    p.appendChild(inlineNode);
    if (position === 'start') d.insertBefore(p, d.firstChild);
    else d.appendChild(p);
    return position === 'start' ? 'start' : 'end';
  }

  // edit_html の not found ヒント: needle に近い箇所の周辺 ~80 字を返す
  function approxHint(haystack, needle) {
    if (!haystack || !needle) return '';
    var best = -1, bestLen = 0;
    // まず先頭からのプレフィックスで最長一致を探す
    for (var len = Math.min(needle.length, 400); len >= 4; len--) {
      var pos = haystack.indexOf(needle.slice(0, len));
      if (pos !== -1) { best = pos; bestLen = len; break; }
    }
    // 見つからなければ末尾からのサフィックスで探す
    if (best === -1) {
      for (var len2 = Math.min(needle.length, 400); len2 >= 4; len2--) {
        var sub = needle.slice(needle.length - len2);
        var pos2 = haystack.indexOf(sub);
        if (pos2 !== -1) { best = pos2; bestLen = len2; break; }
      }
    }
    if (best === -1) return '';
    var start = Math.max(0, best - 20);
    var end = Math.min(haystack.length, best + bestLen + 60);
    return haystack.slice(start, end);
  }

  /* ================= フェーズ12: 文書検索ユーティリティ ================= */

  // 検索対象テキストを要素から抽出する。<br> は改行に、数式(math-inline/
  // math-display)は include_math のとき data-tex を採用(既定は除外)、
  // cite / comment-ref は本文検索の対象外(buildTextMap の skipContainer と同方針)。
  function extractSearchText(node, includeMath) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    var el = node;
    if (el.tagName === 'BR') return '\n';
    var cls = el.classList;
    if (cls && (cls.contains('math-inline') || cls.contains('math-display'))) {
      return includeMath ? (el.getAttribute('data-tex') || '') : '';
    }
    if (cls && (cls.contains('cite') || cls.contains('comment-ref'))) return '';
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) s += extractSearchText(el.childNodes[i], includeMath);
    return s;
  }

  // 任意 HTML 文字列を本文プレーンテキスト化(ブロック境界に改行を挟む)
  function htmlToPlainText(html) {
    var holder = document.createElement('div');
    holder.innerHTML = String(html || '');
    var s = '';
    for (var i = 0; i < holder.childNodes.length; i++) {
      s += extractSearchText(holder.childNodes[i], false);
      s += '\n';
    }
    return s;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 検索用 RegExp を組み立てる。無効な正規表現は分かりやすいエラーを投げる。
  function buildSearchRegex(query, opts) {
    var flags = 'g' + (opts.ignoreCase ? 'i' : '');
    var src = opts.regex ? String(query) : escapeRegExp(query);
    if (opts.wholeWord) src = '\\b(?:' + src + ')\\b';
    try {
      return new RegExp(src, flags);
    } catch (e) {
      throw new Error('正規表現が無効です: ' + (e && e.message ? e.message : String(e)) +
        '(query=' + JSON.stringify(String(query)) + ')');
    }
  }

  // max_results を 1..200 に丸める(既定 50)
  function clampMaxResults(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 50;
    n = Math.floor(n);
    return n > 200 ? 200 : n;
  }

  // グローバルにマッチを収集(ゼロ幅一致での無限ループを防ぐ)。
  // cb(matchText, index) が false を返したら打ち切る。返り値は総ヒット数。
  function eachMatch(re, text, cb) {
    re.lastIndex = 0;
    var total = 0, m, guard = 0;
    while ((m = re.exec(text)) !== null) {
      total += 1;
      if (cb(m[0], m.index) === false) { /* 収集は打ち切るが総数は数え続ける */ }
      if (m.index === re.lastIndex) re.lastIndex += 1; // ゼロ幅対策
      if (++guard > 200000) break;
    }
    return total;
  }

  // block テキスト内オフセットから {line_text, char_offset, context} を作る
  function matchDetail(text, offset, matchText) {
    var lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    var nl = text.indexOf('\n', offset);
    var lineEnd = nl === -1 ? text.length : nl;
    var ctxStart = Math.max(0, offset - 40);
    var ctxEnd = Math.min(text.length, offset + matchText.length + 40);
    return {
      line_text: text.slice(lineStart, lineEnd),
      char_offset: offset - lineStart,
      context: text.slice(ctxStart, ctxEnd),
    };
  }

  // localStorage の文書ストア({ [id]: {title, html, ...} })を読む
  function readDocsStore() {
    try {
      var raw = window.localStorage.getItem('wordtex-docs');
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) { return {}; }
  }

  /* ================= フェーズ18: スレッド操作ユーティリティ ================= */

  // window.Threads が無ければ分かりやすいエラー(ブラウザ未接続とは別に、
  // スレッド機構が初期化されていないケース)。
  function requireThreads() {
    if (!window.Threads) {
      throw new Error('スレッド機能(window.Threads)が初期化されていません。ブラウザでエディタ(プロジェクト)を開いてください。');
    }
    return window.Threads;
  }

  // スレッド1件の要約 {tid, title, commentCount, fileCount, resolved, anchorCount}
  function threadSummary(t) {
    var comments = 0, files = 0;
    var items = (t && t.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type === 'file') files++; else comments++;
    }
    var anchorCount = 0;
    try {
      if (window.Threads && typeof window.Threads.anchorsFor === 'function') {
        anchorCount = window.Threads.anchorsFor(t.tid).length;
      }
    } catch (e) { /* ignore */ }
    return {
      tid: t.tid,
      title: t.title || '',
      commentCount: comments,
      fileCount: files,
      resolved: !!t.resolved,
      anchorCount: anchorCount,
    };
  }

  // 本文アンカー(thread-ref)のテキストを集める(filelink は除外)
  function anchorTexts(tid) {
    var out = [];
    var d = doc();
    if (!d) return out;
    var refs = d.querySelectorAll('.thread-ref[data-tid="' + tid + '"]');
    for (var i = 0; i < refs.length; i++) {
      var s = (refs[i].textContent || '').trim();
      if (s) out.push(s);
    }
    return out;
  }

  // Range に完全に含まれるテキストノードを集める(境界は splitText で分割)。
  // editor.js の collectRangeTextNodes と同方針(math/cite/comment-ref は除外)。
  function collectRangeTextNodesLocal(range, root) {
    if (range.startContainer.nodeType === 3 && range.startOffset > 0 &&
      range.startOffset < range.startContainer.length) {
      var right = range.startContainer.splitText(range.startOffset);
      range.setStart(right, 0);
    }
    if (range.endContainer.nodeType === 3 && range.endOffset > 0 &&
      range.endOffset < range.endContainer.length) {
      range.endContainer.splitText(range.endOffset);
    }
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.length === 0) continue;
      if (skipContainer(n)) continue;
      try {
        if (range.comparePoint(n, 0) === 0 && range.comparePoint(n, n.length) === 0) out.push(n);
      } catch (e) { /* comparePoint 範囲外 */ }
    }
    return out;
  }

  // anchor_text の最初の一致箇所を thread-ref[data-tid] で包む。包めた個数を返す。
  function wrapThreadAnchor(tid, anchorText) {
    var d = doc();
    if (!d || !anchorText) return 0;
    var found = findRangeAcross(d, anchorText, 0);
    if (!found) return 0;
    var texts = collectRangeTextNodesLocal(found.range, d);
    var wrapped = 0;
    for (var i = 0; i < texts.length; i++) {
      var w = document.createElement('span');
      w.className = 'thread-ref';
      w.setAttribute('data-tid', tid);
      var parent = texts[i].parentNode;
      if (!parent) continue;
      parent.insertBefore(w, texts[i]);
      w.appendChild(texts[i]);
      wrapped++;
    }
    if (wrapped) {
      // #doc を変更したので autosave/undo 経路に乗せ、アンカー表示を更新
      afterEdit();
      if (window.Editor && typeof window.Editor.renderThreads === 'function') {
        try { window.Editor.renderThreads(); } catch (e) { /* ignore */ }
      } else if (typeof window.Threads.render === 'function') {
        try { window.Threads.render(); } catch (e) { /* ignore */ }
      }
    }
    return wrapped;
  }

  /* ================= RPC メソッド実装 ================= */

  var METHODS = {
    get_document: function () {
      var d = doc();
      var text = d ? (d.innerText || d.textContent || '') : '';
      return {
        title: docTitle(),
        html: d ? d.innerHTML : '',
        text: text,
        charCount: (d ? (d.textContent || '') : '').replace(/[\s​]/g, '').length,
      };
    },

    get_latex: function () {
      return { latex: currentLatex() };
    },

    set_document: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var norm = normalizeHtml(p && p.html);
      d.innerHTML = norm && norm.trim() ? norm : '<p><br></p>';
      if (window.Editor && typeof window.Editor.clearComments === 'function') {
        try { window.Editor.clearComments(); } catch (e) { /* ignore */ }
      }
      afterEdit();
      return {};
    },

    insert_content: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var norm = normalizeHtml(p && p.html);
      var holder = document.createElement('div');
      holder.innerHTML = norm;
      var nodes = [];
      for (var i = 0; i < holder.childNodes.length; i++) nodes.push(holder.childNodes[i]);
      var position = insertBlocksAt(d, nodes, (p && p.position) || 'end', p && p.heading);
      afterEdit();
      return { position: position };
    },

    /* ===== フェーズ25: 数式ツール(ダイアログを介さず data-tex 数式を挿入/更新) ===== */

    // 数式を挿入して MathML 描画まで完了する。display=true で別行(.math-display)。
    insert_math: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var tex = String(p && p.tex != null ? p.tex : '');
      if (!tex.trim()) throw new Error('tex(LaTeX 数式)が空です。例: {"tex": "E=mc^2"}');
      var display = !!(p && p.display);
      var mathEl = document.createElement(display ? 'div' : 'span');
      mathEl.className = display ? 'math-display' : 'math-inline';
      mathEl.setAttribute('data-tex', tex);
      mathEl.setAttribute('contenteditable', 'false');
      mathEl.textContent = tex; // 描画前の生 TeX 表示(Temml 未ロード時のフォールバック)
      var position;
      if (display) {
        // display 数式はそれ自体がブロック。position 指定でブロック挿入。
        position = insertBlocksAt(d, [mathEl], (p && p.position) || 'end', p && p.heading);
      } else {
        position = insertInlineByPosition(d, mathEl, (p && p.position) || 'end', p && p.heading);
      }
      // フェーズ22 公開 API で MathML 描画(未ロード時は Temml を起動し生 TeX 維持)。
      if (window.Editor && typeof window.Editor.renderMath === 'function') {
        try { window.Editor.renderMath(d); } catch (e) { /* 生 TeX のまま */ }
      }
      afterEdit();
      return { inserted: true, display: display, position: position, tex: tex };
    },

    // 既存数式の data-tex を書き換えて再描画する。index(数式の並び順)または find(現 data-tex 部分一致)で対象指定。
    set_math: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var tex = String(p && p.tex != null ? p.tex : '');
      if (!tex.trim()) throw new Error('tex(新しい LaTeX 数式)が空です。');
      var els = d.querySelectorAll('.math-inline, .math-display');
      var target = null;
      var idx = -1;
      if (p && p.index != null && String(p.index) !== '') {
        idx = Number(p.index);
        target = els[idx] || null;
      } else if (p && p.find != null && String(p.find) !== '') {
        var find = String(p.find);
        for (var k = 0; k < els.length; k++) {
          if (String(els[k].getAttribute('data-tex') || '').indexOf(find) !== -1) { target = els[k]; idx = k; break; }
        }
      } else {
        throw new Error('index(数式の並び順・0始まり)または find(現在の data-tex 部分一致)を指定してください。');
      }
      if (!target) return { found: false, count: els.length };
      target.setAttribute('data-tex', tex);
      target.textContent = tex;
      target.removeAttribute('data-mathml-tex'); // 再描画を強制
      if (window.Editor && typeof window.Editor.renderMath === 'function') {
        try { window.Editor.renderMath(d); } catch (e) { /* 生 TeX のまま */ }
      }
      afterEdit();
      return { found: true, index: idx, display: target.classList.contains('math-display'), tex: tex };
    },

    // 引用 span(class="cite" data-key)を本文に挿入する。LaTeX 出力は \cite{key}。
    insert_citation: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var norm = String(p && p.key != null ? p.key : '')
        .split(',').map(function (k) { return k.trim(); })
        .filter(function (k) { return !!k; }).join(',');
      if (!norm) throw new Error('key(引用キー)が空です。例: {"key": "einstein1905"}');
      var span = document.createElement('span');
      span.className = 'cite';
      span.setAttribute('data-key', norm);
      span.setAttribute('contenteditable', 'false');
      span.textContent = '[' + norm + ']';
      var position = insertInlineByPosition(d, span, (p && p.position) || 'end', p && p.heading);
      // aria ラベル等の装飾(公開 API。LaTeX/docx 出力は data-key のみ参照で不変)。
      if (window.Editor && typeof window.Editor.decorateAnchors === 'function') {
        try { window.Editor.decorateAnchors(d); } catch (e) { /* ignore */ }
      }
      afterEdit();
      return { inserted: true, key: norm, position: position };
    },

    replace_text: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var find = String(p && p.find != null ? p.find : '');
      var repl = String(p && p.replace != null ? p.replace : '');
      if (!find) return { count: 0 };
      var all = !!(p && p.all);
      // 装飾タグまたぎ対応: 連結文字列から Range を組み、範囲を置換する。
      // (<strong> 等でテキストが分断されていても一致・置換できる)
      var count = 0;
      var fromPos = 0;
      var guard = 0;
      while (guard++ < 100000) {
        var found = findRangeAcross(d, find, fromPos);
        if (!found) break;
        found.range.deleteContents();
        if (repl) found.range.insertNode(document.createTextNode(repl));
        count += 1;
        if (!all) break;
        // 置換文字列が find を含む場合の無限ループを防ぐため置換直後から再探索
        fromPos = found.index + repl.length;
      }
      if (count > 0) { d.normalize(); afterEdit(); }
      return { count: count };
    },

    apply_style: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var target = String(p && p.target_text || '');
      var style = String(p && p.style || '');
      var hit = findTextNode(d, target);
      if (!hit) return { applied: false };
      d.focus();
      selectRange(hit.node, hit.index, hit.index); // ブロック内にキャレット
      if (window.Editor && typeof window.Editor.exec === 'function') {
        window.Editor.exec('style', style);
      }
      return { applied: true };
    },

    add_comment: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var anchor = String(p && p.anchor_text || '');
      var text = String(p && p.comment || '');
      // 装飾タグまたぎ対応: またぎ Range を選択してからコメントを挿入する
      var found = findRangeAcross(d, anchor, 0);
      if (!found || !anchor) return { added: false };

      var before = (window.Editor && window.Editor.getComments) ? window.Editor.getComments() : {};
      d.focus();
      var csel = window.getSelection();
      csel.removeAllRanges();
      csel.addRange(found.range);
      if (!(window.Editor && typeof window.Editor.exec === 'function')) {
        throw new Error('Editor.exec が利用できません');
      }
      window.Editor.exec('insertComment');

      // insertComment はカード本文入力欄にフォーカスする。フォーカス中は
      // renderComments が再構築をスキップするため、blur してから本文を設定する。
      if (document.activeElement && document.activeElement.blur) {
        try { document.activeElement.blur(); } catch (e) { /* ignore */ }
      }

      // 新規 cid を特定してコメント本文を設定
      var after = window.Editor.getComments ? window.Editor.getComments() : {};
      var newCid = null;
      for (var k in after) { if (!(k in before)) { newCid = k; break; } }
      if (newCid && window.Editor.getCommentMap && window.Editor.setComments) {
        var map = window.Editor.getCommentMap();
        if (map[newCid]) map[newCid].text = text;
        window.Editor.setComments(map);
      }
      // autosave 経路へ
      d.dispatchEvent(new Event('input', { bubbles: true }));
      return { added: true, cid: newCid };
    },

    compile_pdf: function () {
      return new Promise(function (resolve) {
        var frame = byId('pdf-frame');
        var errEl = byId('compile-error');
        var pane = byId('preview-pane');
        // プレビューが閉じていれば開く(結果を見せる)
        if (pane && pane.hidden && window.App && window.App.exec) {
          try { window.App.exec('togglePreview'); } catch (e) { /* ignore */ }
        }
        var initialSrc = frame ? frame.src : '';
        if (errEl) { errEl.hidden = true; errEl.textContent = ''; } // 保留状態にリセット

        if (window.App && typeof window.App.compile === 'function') window.App.compile();
        else if (window.App && window.App.exec) window.App.exec('compile');
        else if (window.Editor && window.Editor.exec) window.Editor.exec('compile');

        var t0 = Date.now();
        var timer = setInterval(function () {
          var f = byId('pdf-frame');
          var er = byId('compile-error');
          if (f && !f.hidden && f.src && f.src.indexOf('blob:') === 0 && f.src !== initialSrc) {
            clearInterval(timer);
            resolve({ ok: true });
            return;
          }
          if (er && !er.hidden && (er.textContent || '').trim()) {
            clearInterval(timer);
            resolve({ ok: false, log: er.textContent });
            return;
          }
          if (Date.now() - t0 > 60000) {
            clearInterval(timer);
            resolve({ ok: false, log: 'コンパイルがタイムアウトしました(60秒)。' });
          }
        }, 300);
      });
    },

    list_documents: function () {
      var list = (window.App && window.App.docs) ? window.App.docs.list() : [];
      return { documents: list };
    },

    open_document: function (p) {
      var id = String(p && p.id || '');
      if (!window.App || !window.App.docs) throw new Error('文書ストアが利用できません');
      var found = window.App.docs.list().filter(function (d) { return d.id === id; })[0];
      if (!found) return { opened: false };
      window.App.docs.open(id);
      return { opened: true, title: found.title };
    },

    create_document: function (p) {
      if (!window.App || !window.App.docs) throw new Error('文書ストアが利用できません');
      var id = window.App.docs.create((p && p.template) || 'blank');
      return { id: id };
    },

    // フェーズ25: 単体文書ストアから文書を削除(誤削除防止のため title 一致を要求)
    delete_document: function (p) {
      if (!window.App || !window.App.docs) throw new Error('文書ストアが利用できません');
      var id = String(p && p.id || '');
      var title = String(p && p.title != null ? p.title : '');
      var found = window.App.docs.list().filter(function (d) { return d.id === id; })[0];
      if (!found) return { found: false };
      var actual = found.title || '';
      // タイトル未指定、または実タイトルと不一致なら削除しない(確認)。
      if (title !== actual) return { found: true, titleMismatch: true, actualTitle: actual };
      window.App.docs.remove(id);
      return { found: true, deleted: true, title: actual };
    },

    /* ===== フェーズ16: MCP プロジェクト操作(ブリッジ側) ===== */

    // 現在エディタで開いているプロジェクトの {id, name} を返す(未選択なら id=null)
    get_current_project: function () {
      var pid = null;
      try {
        if (window.App && typeof window.App.getCurrentProjectId === 'function') {
          pid = window.App.getCurrentProjectId();
        }
      } catch (e) { /* ignore */ }
      if (!pid) {
        try {
          if (window.Projects && typeof window.Projects.current === 'function') pid = window.Projects.current();
        } catch (e) { /* ignore */ }
      }
      if (!pid) return { id: null, name: null };
      return { id: pid, name: docTitle() };
    },

    // 指定 id のプロジェクトをエディタで開く(App.openProject 経由で再読込)
    open_project: function (p) {
      var id = String(p && p.id || '');
      if (!id) throw new Error('id が空です。');
      if (!(window.App && typeof window.App.openProject === 'function')) {
        throw new Error('プロジェクト機能が利用できません(App.openProject が未定義)。プロジェクトモードで開いているか確認してください。');
      }
      window.App.openProject(id);
      return { opened: true, id: id };
    },

    // MCPがHTTP API経由でファイルを変更した直後に、開いているツリーと参照一覧を同期する。
    refresh_project_files: function (p) {
      var requested = String(p && p.id || '');
      var current = null;
      try { current = window.Projects && window.Projects.current && window.Projects.current(); } catch (e) { /* ignore */ }
      if (requested && current && requested !== current) return { refreshed: false, reason: 'different_project' };
      if (window.FileTree && typeof window.FileTree.reload === 'function') window.FileTree.reload();
      if (window.LinkOverview && typeof window.LinkOverview.refresh === 'function') window.LinkOverview.refresh();
      return { refreshed: true };
    },

    /* ===== フェーズ9: 自由度強化ツール ===== */

    // #doc の innerHTML への厳密文字列置換(ローカル .tex の Edit 相当)
    edit_html: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var oldStr = String(p && p.old_string != null ? p.old_string : '');
      var newStr = String(p && p.new_string != null ? p.new_string : '');
      var replaceAll = !!(p && p.replace_all);
      if (!oldStr) throw new Error('old_string が空です。');
      var html = d.innerHTML;
      // 出現回数を数える
      var count = 0, from = 0, at;
      while ((at = html.indexOf(oldStr, from)) !== -1) { count++; from = at + oldStr.length; }
      if (count === 0) {
        var hint = approxHint(html, oldStr);
        throw new Error('old_string が見つかりませんでした。' +
          (hint ? ('近い箇所のヒント(周辺): …' + hint + '…') :
            ' 現在の innerHTML に一致する箇所はありません。get_blocks / get_block で実際の HTML を確認してください。'));
      }
      if (count > 1 && !replaceAll) {
        throw new Error('old_string が ' + count + ' 箇所で一致しました(一意ではありません)。' +
          'より長い一意な文字列を指定するか、replace_all:true で全 ' + count + ' 箇所を置換してください。');
      }
      var out;
      if (replaceAll) {
        out = html.split(oldStr).join(newStr);
      } else {
        var i = html.indexOf(oldStr);
        out = html.slice(0, i) + newStr + html.slice(i + oldStr.length);
      }
      d.innerHTML = out && out.trim() ? out : '<p><br></p>';
      afterEdit();
      return { replaced: replaceAll ? count : 1 };
    },

    // 文書の構造マップ(#doc 直下ブロックの一覧)
    get_blocks: function () {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var out = [];
      var kids = d.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        out.push({
          index: i,
          tag: el.tagName.toLowerCase(),
          style: blockStyle(el),
          bid: el.getAttribute('data-bid') || null,
          text: (el.textContent || '').slice(0, 120),
          htmlLength: el.innerHTML.length,
        });
      }
      return { blocks: out, count: out.length };
    },

    // 1ブロックの完全な HTML を取得
    get_block: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var i = Number(p && p.index);
      var el = d.children[i];
      if (!el) return { found: false };
      return {
        found: true, index: i, tag: el.tagName.toLowerCase(),
        style: blockStyle(el), bid: el.getAttribute('data-bid') || null,
        html: el.innerHTML, outerHTML: el.outerHTML, text: el.textContent || '',
      };
    },

    // 1ブロックを新しい HTML で置き換える(許可DOMへ正規化)
    set_block: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var i = Number(p && p.index);
      var el = d.children[i];
      if (!el) return { found: false };
      var nodes = htmlToNodes(p && p.html);
      if (!nodes.length) { el.remove(); ensureNonEmpty(d); afterEdit(); return { found: true, blocks: 0 }; }
      for (var k = 0; k < nodes.length; k++) d.insertBefore(nodes[k], el);
      el.remove();
      afterEdit();
      return { found: true, blocks: nodes.length };
    },

    // 指定ブロックの前/後に新しいブロックを挿入
    insert_block: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var i = Number(p && p.index);
      var el = d.children[i];
      var pos = (p && p.position === 'before') ? 'before' : 'after';
      var nodes = htmlToNodes(p && p.html);
      if (!nodes.length) return { inserted: 0 };
      if (!el) {
        for (var a = 0; a < nodes.length; a++) d.appendChild(nodes[a]);
        pos = 'end';
      } else {
        var ref = (pos === 'before') ? el : el.nextSibling;
        for (var k = 0; k < nodes.length; k++) d.insertBefore(nodes[k], ref);
      }
      afterEdit();
      return { inserted: nodes.length, position: pos };
    },

    // 指定ブロックを削除
    delete_block: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var el = d.children[Number(p && p.index)];
      if (!el) return { found: false };
      el.remove();
      ensureNonEmpty(d);
      afterEdit();
      return { found: true };
    },

    // 装飾タグまたぎのテキストを選択して Editor.exec(command, value) を適用
    format_text: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var target = String(p && p.target_text || '');
      var command = String(p && p.command || '');
      var value = (p && p.value != null) ? String(p.value) : undefined;
      if (!target) return { applied: false };
      if (!(window.Editor && typeof window.Editor.exec === 'function')) {
        throw new Error('Editor.exec が利用できません');
      }
      var found = findRangeAcross(d, target, 0);
      if (!found) return { applied: false };
      d.focus();
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(found.range);
      window.Editor.exec(command, value);
      // Editor.exec 側で input を発火するが、念のため反映を保証
      return { applied: true, command: command };
    },

    // Editor.exec への生パススルー
    exec_command: function (p) {
      if (!(window.Editor && typeof window.Editor.exec === 'function')) {
        throw new Error('Editor.exec が利用できません');
      }
      var command = String(p && p.command || '');
      if (!command) throw new Error('command が空です。');
      var value = (p && p.value != null) ? String(p.value) : undefined;
      window.Editor.exec(command, value);
      return { executed: true, command: command };
    },

    undo: function () {
      if (!(window.Editor && typeof window.Editor.exec === 'function')) {
        throw new Error('Editor.exec が利用できません');
      }
      window.Editor.exec('undo');
      return { done: true };
    },

    redo: function () {
      if (!(window.Editor && typeof window.Editor.exec === 'function')) {
        throw new Error('Editor.exec が利用できません');
      }
      window.Editor.exec('redo');
      return { done: true };
    },

    // 見出しツリー(h1-h3 + title/subtitle)をインデックス付きで返す
    get_outline: function () {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var out = [];
      var kids = d.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        var st = blockStyle(el);
        var level = null;
        if (st === 'title') level = 0;
        else if (st === 'h1') level = 1;
        else if (st === 'h2') level = 2;
        else if (st === 'h3') level = 3;
        else if (st === 'subtitle') level = 0;
        if (level === null) continue;
        out.push({ index: i, level: level, style: st, text: (el.textContent || '').slice(0, 200) });
      }
      return { outline: out, count: out.length };
    },

    /* ===== フェーズ12: 文書検索(非破壊・位置特定) ===== */

    // 現在文書(#doc)をブロック単位で検索。block_index は get_blocks/get_block と一致。
    search_document: function (p) {
      var d = doc();
      if (!d) throw new Error('エディタが初期化されていません');
      var query = String(p && p.query != null ? p.query : '');
      if (!query) return { matches: [], count: 0, total: 0 };
      var opts = {
        regex: !!(p && p.regex),
        ignoreCase: !!(p && p.ignore_case),
        wholeWord: !!(p && p.whole_word),
      };
      var includeMath = !!(p && p.include_math);
      var max = clampMaxResults(p && p.max_results);
      var re = buildSearchRegex(query, opts); // 無効な正規表現はここで throw

      var matches = [];
      var total = 0;
      var kids = d.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        var tag = el.tagName.toLowerCase();
        var text = extractSearchText(el, includeMath);
        if (!text) continue;
        total += eachMatch(re, text, function (matchText, offset) {
          if (matches.length >= max) return false;
          var det = matchDetail(text, offset, matchText);
          matches.push({
            block_index: i,
            block_tag: tag,
            line_text: det.line_text,
            match_text: matchText,
            char_offset: det.char_offset,
            context: det.context,
          });
        });
      }
      return { matches: matches, count: matches.length, total: total };
    },

    // 保存済み全文書(wordtex-docs)を横断検索。現在文書は #doc の最新内容を使う。
    search_all_documents: function (p) {
      var query = String(p && p.query != null ? p.query : '');
      if (!query) return { documents: [], count: 0 };
      var opts = { regex: !!(p && p.regex), ignoreCase: !!(p && p.ignore_case), wholeWord: false };
      var max = clampMaxResults(p && p.max_results);
      var re = buildSearchRegex(query, opts); // 無効な正規表現はここで throw

      var list = (window.App && window.App.docs && window.App.docs.list) ? window.App.docs.list() : [];
      var currentId = (window.App && window.App.docs && window.App.docs.currentId)
        ? window.App.docs.currentId() : null;
      var storeData = readDocsStore();
      var d = doc();

      var results = [];
      for (var i = 0; i < list.length && results.length < max; i++) {
        var id = list[i].id;
        var html;
        if (id === currentId && d) {
          html = d.innerHTML; // 未保存の編集も検索対象にする
        } else {
          html = (storeData[id] && storeData[id].html) || '';
        }
        var text = htmlToPlainText(html);
        var samples = [];
        var count = eachMatch(re, text, function (matchText, offset) {
          if (samples.length >= 3) return false;
          var det = matchDetail(text, offset, matchText);
          samples.push({ line_text: det.line_text, context: det.context });
        });
        if (count > 0) {
          results.push({
            doc_id: id,
            title: list[i].title || '無題の文書',
            match_count: count,
            samples: samples,
          });
        }
      }
      return { documents: results, count: results.length };
    },

    /* ===== フェーズ18: スレッド操作(window.Threads 経由) ===== */

    // スレッド一覧の要約
    list_threads: function () {
      var T = requireThreads();
      var arr = T.list();
      return { threads: arr.map(threadSummary) };
    },

    // 1スレッドの詳細(タイトル / items / アンカー本文)
    get_thread: function (p) {
      var T = requireThreads();
      var tid = String(p && p.tid || '');
      var t = T.get(tid);
      if (!t) return { found: false };
      var items = (t.items || []).map(function (it, idx) {
        if (it.type === 'file') {
          return { index: idx, type: 'file', path: it.path, label: it.label || '', loc: it.loc || '' };
        }
        var replies = (it.replies || []).map(function (r) {
          return { author: r.author || '', text: r.text || '' };
        });
        return { index: idx, type: 'comment', author: it.author || '', text: it.text || '', replies: replies };
      });
      return {
        found: true,
        tid: t.tid,
        title: t.title || '',
        resolved: !!t.resolved,
        anchors: anchorTexts(tid),
        items: items,
        summary: threadSummary(t),
      };
    },

    // スレッド作成。anchor_text 指定時は本文の最初の一致箇所に thread-ref を張る。
    create_thread: function (p) {
      var T = requireThreads();
      var title = String(p && p.title != null ? p.title : '') || '新しいスレッド';
      var anchor = String(p && p.anchor_text != null ? p.anchor_text : '');
      var t = T.create(title);
      var anchored = 0;
      var anchorRequested = !!anchor;
      if (anchor) {
        try { anchored = wrapThreadAnchor(t.tid, anchor); } catch (e) { anchored = 0; }
      }
      return { tid: t.tid, title: t.title, anchorRequested: anchorRequested, anchored: anchored };
    },

    // コメント追加(著者は Claude)
    add_thread_comment: function (p) {
      var T = requireThreads();
      var tid = String(p && p.tid || '');
      if (!T.get(tid)) return { found: false };
      var item = T.addComment(tid, String(p && p.text != null ? p.text : ''), 'Claude');
      return { found: true, added: !!item, item_id: item ? item.id : null };
    },

    // 返信(item_index は items 配列内の index。コメント項目のみ返信可)
    reply_thread: function (p) {
      var T = requireThreads();
      var tid = String(p && p.tid || '');
      var t = T.get(tid);
      if (!t) return { found: false };
      var idx = Number(p && p.item_index);
      var item = t.items[idx];
      if (!item) return { found: true, itemFound: false, itemCount: t.items.length };
      if (item.type !== 'comment') {
        throw new Error('item_index=' + idx + ' はコメントではありません(type=' + item.type +
          ')。返信できるのはコメント項目のみです。get_thread で index を確認してください。');
      }
      var rep = T.reply(item.id, String(p && p.text != null ? p.text : ''), 'Claude');
      return { found: true, itemFound: true, replied: !!rep };
    },

    // プロジェクト内ファイルをスレッドに添付
    attach_file_to_thread: function (p) {
      var T = requireThreads();
      var tid = String(p && p.tid || '');
      if (!T.get(tid)) return { found: false };
      var path = String(p && p.path || '');
      if (!path) throw new Error('path が空です。');
      var loc = (p && p.loc != null) ? String(p.loc) : '';
      var label = (p && p.label != null && String(p.label)) ? String(p.label) : null;
      var item = T.addFile(tid, path, loc, label);
      return { found: true, attached: !!item, item_id: item ? item.id : null };
    },

    // 解決にする
    resolve_thread: function (p) {
      var T = requireThreads();
      var tid = String(p && p.tid || '');
      if (!T.get(tid)) return { found: false };
      T.resolve(tid, true);
      return { found: true, resolved: true };
    },

    // スレッド削除(本文アンカーも unwrap)
    delete_thread: function (p) {
      var T = requireThreads();
      var tid = String(p && p.tid || '');
      if (!T.get(tid)) return { found: false };
      if (window.Editor && typeof window.Editor.removeThreadAnchors === 'function') {
        try { window.Editor.removeThreadAnchors(tid); } catch (e) { /* ignore */ }
      }
      T.remove(tid);
      return { found: true, deleted: true };
    },
  };

  // #doc が空になったら空段落を補う(delete/set 後の保険)
  function ensureNonEmpty(d) {
    if (d && !d.firstChild) d.innerHTML = '<p><br></p>';
  }

  function dispatch(method, params) {
    var fn = METHODS[method];
    if (!fn) return Promise.reject(new Error('未知のメソッド: ' + method));
    try {
      return Promise.resolve(fn(params || {}));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* ================= SSE 接続 ================= */

  var es = null;
  var reconnectTimer = null;

  function setIndicator(on) {
    var ind = byId('agent-indicator');
    if (ind) ind.hidden = !on;
  }

  function sendResult(id, ok, payload) {
    var body = { id: id, ok: ok };
    if (ok) body.result = payload;
    else body.error = payload;
    fetch('/agent/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () { /* ignore */ });
  }

  function onRpc(evt) {
    var data;
    try { data = JSON.parse(evt.data); } catch (e) { return; }
    if (!data || data.id == null) return;
    dispatch(data.method, data.params).then(function (result) {
      sendResult(data.id, true, result != null ? result : {});
    }, function (err) {
      sendResult(data.id, false, (err && err.message) ? err.message : String(err));
    });
  }

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try {
      es = new EventSource('/events');
    } catch (e) {
      scheduleReconnect();
      return;
    }
    es.addEventListener('open', function () { setIndicator(true); });
    es.addEventListener('ready', function () { setIndicator(true); });
    es.addEventListener('rpc', onRpc);
    es.addEventListener('superseded', function () {
      // 別タブが接続した。こちらは静かに閉じる(再接続しない)
      setIndicator(false);
      if (es) { try { es.close(); } catch (e2) {} es = null; }
    });
    es.addEventListener('error', function () {
      setIndicator(false);
      // EventSource は自動再接続するが、閉じている場合は手動で
      if (es && es.readyState === 2) { es = null; scheduleReconnect(); }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 3000);
  }

  function start() {
    setIndicator(false);
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // デバッグ/検証用に最小限を公開
  window.AgentBridge = { dispatch: dispatch, connect: connect, pointTo: wrapThreadAnchor };
})();
