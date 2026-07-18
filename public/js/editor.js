/* editor.js — 編集エンジン (window.Editor)
 * document.execCommand は不使用。Selection/Range API で自前実装。
 * DOM 契約: SPEC.md「コマンドディスパッチ契約」「editor.js の必須機能」
 */
(function () {
  'use strict';

  var FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
  var SHEET_GAP = 12;
  var UNDO_LIMIT = 100;

  var undoStack = [];
  var redoStack = [];
  var prevState = null;       // 最後に確定したスナップショット

  /* ================= コメント専用モード(フェーズ13b)=================
   * 共有 permission=comment のゲストで有効化(collab.js が setCommentOnlyMode(true))。
   * 本文ブロックを改変するコマンドは no-op にし、コメント系のみ通す。
   * 単独編集(既定 false)には一切影響しない。 */
  var commentOnly = false;
  // コメント専用モードで無効化する(本文ブロックを改変する)コマンド群
  var COMMENT_BLOCKED = {
    bold: 1, italic: 1, underline: 1, strikethrough: 1, subscript: 1, superscript: 1,
    highlight: 1, foreColor: 1, fontName: 1, fontSize: 1, growFont: 1, shrinkFont: 1,
    clearFormat: 1, alignLeft: 1, alignCenter: 1, alignRight: 1, alignJustify: 1,
    bulletList: 1, numberList: 1, indent: 1, outdent: 1, hr: 1, style: 1,
    insertTable: 1, insertImage: 1, insertLink: 1, insertMath: 1, insertDisplayMath: 1,
    insertFootnote: 1, pageBreak: 1, undo: 1, redo: 1, cut: 1, paste: 1, docLanguage: 1,
    linkFile: 1
  };
  function commentOnlyBlocked() {
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce('この文書ではコメントのみ可能です');
    }
  }
  var snapshotTimer = null;
  // フェーズ30: 用紙サイズ×向きごとにシート高(px)をキャッシュ(key: 'a4-p' 等)
  var sheetHeightCache = {};
  var PAGE_MM = {
    a4: { w: 210, h: 297 },
    b5: { w: 182, h: 257 },   // JIS B5
    letter: { w: 216, h: 279 }
  };
  // 現在の用紙寸法(mm, 向き反映)とキャッシュキーを返す
  function pageDims() {
    var paper = (document.body && document.body.dataset.paper) || 'a4';
    var dim = PAGE_MM[paper] || PAGE_MM.a4;
    var landscape = document.body.classList.contains('landscape');
    return {
      wMm: landscape ? dim.h : dim.w,
      hMm: landscape ? dim.w : dim.h,
      key: paper + (landscape ? '-l' : '-p')
    };
  }

  /* ================= 文書言語(フェーズ11)================= */
  // 8 言語。既定は ja(現行維持)。#doc の lang 属性と spellcheck を制御する。
  var VALID_LANGS = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'de', 'fr', 'es'];
  // ブラウザ内蔵スペルチェック用の BCP-47(CJK は下線校正が実質無いが lang は付ける)
  var LANG_BCP47 = {
    'ja': 'ja', 'en': 'en', 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant',
    'ko': 'ko', 'de': 'de', 'fr': 'fr', 'es': 'es'
  };
  var docLang = 'ja';

  function normDocLang(code) {
    var c = String(code == null ? '' : code);
    if (VALID_LANGS.indexOf(c) !== -1) return c;
    var low = c.toLowerCase();
    if (low === 'zh' || low === 'zh-cn' || low === 'zh-hans') return 'zh-Hans';
    if (low === 'zh-tw' || low === 'zh-hk' || low === 'zh-hant') return 'zh-Hant';
    var base = low.split(/[-_]/)[0];
    if (VALID_LANGS.indexOf(base) !== -1) return base;
    return 'ja';
  }

  // #doc に lang 属性と spellcheck を設定する。
  // 日本語は文中の分かち書きが無くブラウザ校正の誤検出が多いため spellcheck=false、
  // それ以外の言語は spellcheck=true(ブラウザ内蔵の言語別スペルチェック=実用範囲)。
  function applyDocLanguage(code) {
    docLang = normDocLang(code);
    var d = doc();
    if (!d) return docLang;
    d.setAttribute('lang', LANG_BCP47[docLang] || docLang);
    var useSpell = docLang !== 'ja';
    d.setAttribute('spellcheck', useSpell ? 'true' : 'false');
    return docLang;
  }

  function doc() { return document.getElementById('doc'); }

  function byId(id) { return document.getElementById(id); }

  /* ================= 選択ユーティリティ ================= */

  function currentRange() {
    var d = doc();
    if (!d) return null;
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var r = sel.getRangeAt(0);
    if (!d.contains(r.commonAncestorContainer)) return null;
    return r;
  }

  function setCaret(node, offset) {
    try {
      var sel = window.getSelection();
      var r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* 位置が無効でも他機能を止めない */ }
  }

  function caretToStartOf(el) {
    if (!el) return;
    if (el.nodeType === 3) { setCaret(el, 0); return; }
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var t = walker.nextNode();
    if (t) setCaret(t, 0);
    else setCaret(el, 0);
  }

  function selectRangeOf(firstNode, lastNode) {
    try {
      var sel = window.getSelection();
      var r = document.createRange();
      r.setStart(firstNode, 0);
      r.setEnd(lastNode, lastNode.nodeType === 3 ? lastNode.length : lastNode.childNodes.length);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { }
  }

  function isAtomic(node) {
    // 編集不可の原子要素(数式・脚注マーカー・改ページ)内は書式操作しない
    var el = node.nodeType === 1 ? node : node.parentNode;
    var d = doc();
    while (el && el !== d) {
      if (el.nodeType === 1) {
        var cl = el.classList;
        if (cl && (cl.contains('math-inline') || cl.contains('math-display') ||
          cl.contains('footnote') || cl.contains('page-break'))) return true;
        if (el.getAttribute && el.getAttribute('contenteditable') === 'false') return true;
      }
      el = el.parentNode;
    }
    return false;
  }

  // 範囲内の完全に含まれるテキストノードを収集(境界は splitText で分割)
  function collectRangeTextNodes(range) {
    var d = doc();
    if (!d) return [];
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
    var walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) {
      if (n.length === 0) continue;
      if (isAtomic(n)) continue;
      try {
        if (range.comparePoint(n, 0) === 0 && range.comparePoint(n, n.length) === 0) out.push(n);
      } catch (e) { }
    }
    return out;
  }

  /* ================= インライン書式 ================= */

  var INLINE_FORMATS = {
    bold: { match: function (el) { return el.nodeName === 'STRONG' || el.nodeName === 'B'; }, create: function () { return document.createElement('strong'); } },
    italic: { match: function (el) { return el.nodeName === 'EM' || el.nodeName === 'I'; }, create: function () { return document.createElement('em'); } },
    underline: { match: function (el) { return el.nodeName === 'U'; }, create: function () { return document.createElement('u'); } },
    strikethrough: { match: function (el) { return el.nodeName === 'S' || el.nodeName === 'STRIKE'; }, create: function () { return document.createElement('s'); } },
    subscript: { match: function (el) { return el.nodeName === 'SUB'; }, create: function () { return document.createElement('sub'); } },
    superscript: { match: function (el) { return el.nodeName === 'SUP'; }, create: function () { return document.createElement('sup'); } },
    highlight: { match: function (el) { return el.nodeName === 'SPAN' && el.classList.contains('hl'); }, create: function () { var s = document.createElement('span'); s.className = 'hl'; return s; } },
    foreColor: { match: function (el) { return el.nodeName === 'SPAN' && el.classList.contains('fc'); }, create: function () { var s = document.createElement('span'); s.className = 'fc'; return s; } }
  };

  function matchAncestor(node, matchFn) {
    var d = doc();
    var el = node.nodeType === 1 ? node : node.parentNode;
    while (el && el !== d) {
      if (el.nodeType === 1 && matchFn(el)) return el;
      el = el.parentNode;
    }
    return null;
  }

  // wrapper の中から node だけを外に出せるよう、親チェーンを分割して wrapper を除去
  function removeWrapperAround(node, wrapper) {
    var cur = node;
    while (cur !== wrapper) {
      var p = cur.parentNode;
      if (!p) return;
      if (cur.previousSibling) {
        var left = p.cloneNode(false);
        while (p.firstChild !== cur) left.appendChild(p.firstChild);
        p.parentNode.insertBefore(left, p);
      }
      if (cur.nextSibling) {
        var rightC = p.cloneNode(false);
        while (cur.nextSibling) rightC.appendChild(cur.nextSibling);
        p.parentNode.insertBefore(rightC, p.nextSibling);
      }
      cur = p;
    }
    // wrapper には目的ノードのチェーンだけが残っている → アンラップ
    var parent = wrapper.parentNode;
    if (!parent) return;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    parent.removeChild(wrapper);
  }

  function mergeAdjacentWrappers(nodes, matchFn) {
    // 同一書式の隣接ラッパーを結合して DOM を綺麗に保つ
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i].parentNode;
      if (!el || el.nodeType !== 1 || !matchFn(el)) continue;
      var prev = el.previousSibling;
      if (prev && prev.nodeType === 1 && prev.nodeName === el.nodeName &&
        prev.className === el.className && matchFn(prev)) {
        while (el.firstChild) prev.appendChild(el.firstChild);
        el.parentNode.removeChild(el);
      }
    }
  }

  function toggleInline(fmtKey) {
    var fmt = INLINE_FORMATS[fmtKey];
    if (!fmt) return;
    var range = currentRange();
    if (!range || range.collapsed) return; // 折りたたみ選択は no-op(仕様許容)
    beginEdit();
    var texts = collectRangeTextNodes(range);
    if (!texts.length) return;

    var allFormatted = texts.every(function (t) { return !!matchAncestor(t, fmt.match); });
    var i;
    if (allFormatted) {
      for (i = 0; i < texts.length; i++) {
        var w;
        while ((w = matchAncestor(texts[i], fmt.match))) removeWrapperAround(texts[i], w);
      }
    } else {
      for (i = 0; i < texts.length; i++) {
        if (matchAncestor(texts[i], fmt.match)) continue;
        var wrapper = fmt.create();
        texts[i].parentNode.insertBefore(wrapper, texts[i]);
        wrapper.appendChild(texts[i]);
      }
      mergeAdjacentWrappers(texts, fmt.match);
    }
    selectRangeOf(texts[0], texts[texts.length - 1]);
    endEdit();
  }

  // フォント名 / サイズ: 既存の同系ラッパーを外してから新しく適用(置換セマンティクス)
  function applyReplacingSpan(matchFn, createFn) {
    var range = currentRange();
    if (!range || range.collapsed) return;
    beginEdit();
    var texts = collectRangeTextNodes(range);
    if (!texts.length) return;
    var i, w;
    for (i = 0; i < texts.length; i++) {
      while ((w = matchAncestor(texts[i], matchFn))) removeWrapperAround(texts[i], w);
    }
    for (i = 0; i < texts.length; i++) {
      var wrapper = createFn();
      texts[i].parentNode.insertBefore(wrapper, texts[i]);
      wrapper.appendChild(texts[i]);
    }
    selectRangeOf(texts[0], texts[texts.length - 1]);
    endEdit();
  }

  function isFF(el) { return el.nodeName === 'SPAN' && /(^|\s)ff-(serif|sans|mono)(\s|$)/.test(el.className); }
  function isFS(el) { return el.nodeName === 'SPAN' && el.classList.contains('fs'); }

  function fontName(value) {
    var v = (value === 'sans' || value === 'mono') ? value : 'serif';
    applyReplacingSpan(isFF, function () {
      var s = document.createElement('span');
      s.className = 'ff-' + v;
      return s;
    });
  }

  function fontSize(value) {
    var pt = parseFloat(value);
    if (!pt || pt <= 0) return;
    applyReplacingSpan(isFS, function () {
      var s = document.createElement('span');
      s.className = 'fs';
      s.setAttribute('data-pt', String(pt));
      return s;
    });
  }

  function stepFont(dir) {
    var st = computeState();
    var cur = parseFloat(st.fontSize) || 10.5;
    var idx = -1;
    for (var i = 0; i < FONT_SIZES.length; i++) {
      if (Math.abs(FONT_SIZES[i] - cur) < 0.01) { idx = i; break; }
    }
    if (idx === -1) {
      // リスト外の値: 近い方向のサイズを探す
      idx = 0;
      for (i = 0; i < FONT_SIZES.length; i++) if (FONT_SIZES[i] < cur) idx = i;
    }
    var next = FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, idx + dir))];
    fontSize(next);
  }

  function clearFormat() {
    var range = currentRange();
    if (!range || range.collapsed) return;
    beginEdit();
    var texts = collectRangeTextNodes(range);
    if (!texts.length) return;
    var anyInline = function (el) {
      return /^(STRONG|B|EM|I|U|S|STRIKE|SUB|SUP|A)$/.test(el.nodeName) ||
        (el.nodeName === 'SPAN' && /(^|\s)(hl|fc|fs|ff-serif|ff-sans|ff-mono)(\s|$)/.test(el.className));
    };
    for (var i = 0; i < texts.length; i++) {
      var w;
      while ((w = matchAncestor(texts[i], anyInline))) removeWrapperAround(texts[i], w);
    }
    selectRangeOf(texts[0], texts[texts.length - 1]);
    endEdit();
  }

  /* ================= ブロック操作 ================= */

  function topBlockOf(node) {
    var d = doc();
    if (!d || !node) return null;
    var el = node.nodeType === 1 ? node : node.parentNode;
    if (el === d) return null;
    while (el && el.parentNode !== d) el = el.parentNode;
    return el;
  }

  function liOf(node) {
    var d = doc();
    var el = node && (node.nodeType === 1 ? node : node.parentNode);
    while (el && el !== d) {
      if (el.nodeName === 'LI') return el;
      el = el.parentNode;
    }
    return null;
  }

  // 選択に含まれる #doc 直下ブロックの一覧
  function selectedTopBlocks() {
    var d = doc();
    var range = currentRange();
    if (!d) return [];
    if (!range) {
      return d.firstElementChild ? [d.firstElementChild] : [];
    }
    var start = topBlockOf(range.startContainer);
    var end = topBlockOf(range.endContainer);
    if (!start && !end) return [];
    if (!start) start = end;
    if (!end) end = start;
    var out = [];
    var cur = start;
    while (cur) {
      out.push(cur);
      if (cur === end) break;
      cur = cur.nextElementSibling;
    }
    return out;
  }

  function isFormattableBlock(el) {
    return el && /^(P|H1|H2|H3|BLOCKQUOTE|PRE)$/.test(el.nodeName);
  }

  var STYLE_DEFS = {
    normal: { tag: 'p', cls: '' },
    h1: { tag: 'h1', cls: '' },
    h2: { tag: 'h2', cls: '' },
    h3: { tag: 'h3', cls: '' },
    title: { tag: 'p', cls: 'title' },
    subtitle: { tag: 'p', cls: 'subtitle' },
    quote: { tag: 'blockquote', cls: '' },
    code: { tag: 'pre', cls: 'code' }
  };

  function styleKeyOf(el) {
    if (!el) return 'normal';
    var n = el.nodeName;
    if (n === 'H1') return 'h1';
    if (n === 'H2') return 'h2';
    if (n === 'H3') return 'h3';
    if (n === 'BLOCKQUOTE') return 'quote';
    if (n === 'PRE') return 'code';
    if (n === 'P') {
      if (el.classList.contains('title')) return 'title';
      if (el.classList.contains('subtitle')) return 'subtitle';
    }
    return 'normal';
  }

  function convertBlock(block, def) {
    var el = document.createElement(def.tag);
    if (def.cls) el.className = def.cls;
    if (def.tag === 'pre') {
      el.textContent = block.textContent;
      if (!el.textContent) el.appendChild(document.createElement('br'));
    } else {
      while (block.firstChild) el.appendChild(block.firstChild);
      if (!el.firstChild) el.appendChild(document.createElement('br'));
    }
    block.parentNode.replaceChild(el, block);
    return el;
  }

  // list を li の位置で分割し、li を単独ブロック化するための土台
  function splitListAround(li) {
    var list = li.parentNode;
    var before = null, after = null;
    if (li.previousElementSibling) {
      before = list.cloneNode(false);
      while (list.firstChild !== li) before.appendChild(list.firstChild);
      list.parentNode.insertBefore(before, list);
    }
    if (li.nextElementSibling) {
      after = list.cloneNode(false);
      while (li.nextSibling) after.appendChild(li.nextSibling);
      list.parentNode.insertBefore(after, list.nextSibling);
    }
    return list; // list には li のみが残る
  }

  // li → ブロック要素(list がネストされていた場合は後続に展開)
  function liToBlock(li, def) {
    def = def || STYLE_DEFS.normal;
    var list = splitListAround(li);
    var el = document.createElement(def.tag);
    if (def.cls) el.className = def.cls;
    var nestedLists = [];
    while (li.firstChild) {
      var c = li.firstChild;
      if (c.nodeType === 1 && (c.nodeName === 'UL' || c.nodeName === 'OL')) {
        nestedLists.push(c);
        li.removeChild(c);
      } else {
        el.appendChild(c);
      }
    }
    if (!el.firstChild) el.appendChild(document.createElement('br'));
    list.parentNode.insertBefore(el, list);
    for (var i = 0; i < nestedLists.length; i++) {
      list.parentNode.insertBefore(nestedLists[i], list);
    }
    list.parentNode.removeChild(list);
    return el;
  }

  function applyStyle(value) {
    var def = STYLE_DEFS[value];
    if (!def) return;
    beginEdit();
    var range = currentRange();
    var li = range ? liOf(range.startContainer) : null;
    var result = null;
    if (li && topBlockOf(li) && /^(UL|OL)$/.test(topBlockOf(li).nodeName)) {
      result = liToBlock(li, def);
    } else {
      var blocks = selectedTopBlocks();
      for (var i = 0; i < blocks.length; i++) {
        if (isFormattableBlock(blocks[i])) {
          var converted = convertBlock(blocks[i], def);
          if (!result) result = converted;
        }
      }
    }
    if (result) caretToStartOf(result);
    endEdit();
    if (window.A11y && window.A11y.announce) {
      var A11Y_STYLE = { normal: '標準', h1: '見出し 1', h2: '見出し 2', h3: '見出し 3',
        title: '表題', subtitle: '副題', quote: '引用文', code: 'コード' };
      window.A11y.announce((A11Y_STYLE[value] || value) + ' を適用しました');
    }
  }

  function applyAlign(value) {
    beginEdit();
    var range = currentRange();
    var li = range ? liOf(range.startContainer) : null;
    var targets = li ? [li] : selectedTopBlocks();
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      if (!el || !el.style) continue;
      if (value === 'left') el.style.textAlign = '';
      else el.style.textAlign = value;
      if (el.getAttribute && el.getAttribute('style') === '') el.removeAttribute('style');
    }
    endEdit();
  }

  function toggleList(listTag) {
    beginEdit();
    var blocks = selectedTopBlocks();
    if (!blocks.length) { endEdit(); return; }

    var allSameList = blocks.every(function (b) { return b.nodeName === listTag.toUpperCase(); });
    var i;
    if (allSameList) {
      // 解除: 各 li → p
      var firstP = null;
      for (i = 0; i < blocks.length; i++) {
        var list = blocks[i];
        var frag = document.createDocumentFragment();
        var lis = [];
        var c;
        for (c = list.firstElementChild; c; c = c.nextElementSibling) {
          if (c.nodeName === 'LI') lis.push(c);
        }
        for (var j = 0; j < lis.length; j++) {
          var p = document.createElement('p');
          while (lis[j].firstChild) {
            var k = lis[j].firstChild;
            if (k.nodeType === 1 && (k.nodeName === 'UL' || k.nodeName === 'OL')) frag.appendChild(k);
            else p.appendChild(k);
          }
          if (!p.firstChild) p.appendChild(document.createElement('br'));
          frag.appendChild(p);
          if (!firstP) firstP = p;
        }
        list.parentNode.replaceChild(frag, list);
      }
      if (firstP) caretToStartOf(firstP);
    } else {
      var newList = document.createElement(listTag);
      blocks[0].parentNode.insertBefore(newList, blocks[0]);
      for (i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b.nodeName === 'UL' || b.nodeName === 'OL') {
          // 種類変換: li を移す
          while (b.firstChild) newList.appendChild(b.firstChild);
          b.parentNode.removeChild(b);
        } else if (/^(P|H1|H2|H3|BLOCKQUOTE)$/.test(b.nodeName)) {
          var liEl = document.createElement('li');
          while (b.firstChild) liEl.appendChild(b.firstChild);
          if (!liEl.firstChild) liEl.appendChild(document.createElement('br'));
          newList.appendChild(liEl);
          b.parentNode.removeChild(b);
        }
        // table / figure 等はリスト化しない
      }
      if (newList.firstElementChild) caretToStartOf(newList.firstElementChild);
      else newList.parentNode.removeChild(newList);
    }
    endEdit();
  }

  function indentLi(li) {
    var prev = li.previousElementSibling;
    if (!prev || prev.nodeName !== 'LI') return; // 先頭 li はネスト不可(Word同様)
    var listTag = li.parentNode.nodeName === 'OL' ? 'ol' : 'ul';
    var sub = null;
    var last = prev.lastElementChild;
    if (last && (last.nodeName === 'UL' || last.nodeName === 'OL')) sub = last;
    if (!sub) {
      sub = document.createElement(listTag);
      prev.appendChild(sub);
    }
    sub.appendChild(li);
  }

  function outdentLi(li) {
    var list = li.parentNode;
    var parentLi = list.parentNode && list.parentNode.nodeName === 'LI' ? list.parentNode : null;
    if (parentLi) {
      // ネスト解除: 親 li の直後へ移動
      var outerList = parentLi.parentNode;
      // li より後ろの兄弟は li の新しいサブリストへ(構造維持)
      if (li.nextElementSibling) {
        var carry = list.cloneNode(false);
        while (li.nextSibling) carry.appendChild(li.nextSibling);
        li.appendChild(carry);
      }
      outerList.insertBefore(li, parentLi.nextSibling);
      if (!list.firstElementChild) list.parentNode.removeChild(list);
    } else {
      // 最上位リスト → 段落へ
      liToBlock(li, STYLE_DEFS.normal);
    }
  }

  function indentOutdent(dir) {
    beginEdit();
    var range = currentRange();
    var li = range ? liOf(range.startContainer) : null;
    if (li) {
      var keepNode = range.startContainer;
      var keepOffset = range.startOffset;
      if (dir > 0) indentLi(li); else outdentLi(li);
      if (keepNode && keepNode.isConnected) setCaret(keepNode, keepOffset);
    } else {
      var blocks = selectedTopBlocks();
      for (var i = 0; i < blocks.length; i++) {
        var el = blocks[i];
        if (!el || !el.style) continue;
        var cur = parseInt(el.style.marginLeft, 10) || 0;
        var next = Math.max(0, cur + dir * 40);
        el.style.marginLeft = next ? next + 'px' : '';
      }
    }
    endEdit();
  }

  function insertHr() {
    beginEdit();
    var hr = document.createElement('hr');
    insertBlockAfterCaretBlock(hr);
    endEdit();
  }

  /* ================= ブロック挿入ヘルパ ================= */

  function ensureParagraphAfter(el) {
    var next = el.nextElementSibling;
    if (next) return next;
    var p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    el.parentNode.insertBefore(p, el.nextSibling);
    return p;
  }

  function insertBlockAfterCaretBlock(el) {
    var d = doc();
    if (!d) return null;
    var range = currentRange();
    var block = range ? topBlockOf(range.startContainer) : null;
    if (block) d.insertBefore(el, block.nextSibling);
    else d.appendChild(el);
    var after = ensureParagraphAfter(el);
    caretToStartOf(after);
    return el;
  }

  function insertInlineAtCaret(el) {
    var d = doc();
    if (!d) return null;
    var range = currentRange();
    if (!range) {
      // ドキュメント末尾の段落に追加
      var lastP = d.lastElementChild;
      if (!lastP) {
        lastP = document.createElement('p');
        d.appendChild(lastP);
      }
      lastP.appendChild(el);
      return el;
    }
    // 挿入位置が contenteditable=false のブロック(数式・引用・文献目録等)の
    // 内部に落ちている場合は、そのブロックの直後に退避する
    var host = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var locked = host && host.closest ? host.closest('#doc [contenteditable="false"]') : null;
    if (locked && locked !== d) {
      range = document.createRange();
      range.setStartAfter(locked);
      range.collapse(true);
    }
    if (!range.collapsed) range.deleteContents();
    range.insertNode(el);
    // キャレットを挿入要素の直後へ
    var r = document.createRange();
    r.setStartAfter(el);
    r.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return el;
  }

  /* ================= 挿入系コマンド ================= */

  function insertTable(value) {
    var m = /^(\d+)x(\d+)$/i.exec(String(value || '2x2'));
    var rows = m ? parseInt(m[1], 10) : 2;
    var cols = m ? parseInt(m[2], 10) : 2;
    rows = Math.max(1, Math.min(20, rows));
    cols = Math.max(1, Math.min(10, cols));
    beginEdit();
    var table = document.createElement('table');
    var tbody = document.createElement('tbody');
    for (var r = 0; r < rows; r++) {
      var tr = document.createElement('tr');
      for (var c = 0; c < cols; c++) {
        var td = document.createElement('td');
        td.appendChild(document.createElement('br'));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    insertBlockAfterCaretBlock(table);
    var firstTd = table.querySelector('td');
    if (firstTd) caretToStartOf(firstTd);
    endEdit();
  }

  function insertLink() {
    var range = currentRange();
    var url = window.prompt('リンク先の URL を入力してください', 'https://');
    if (!url) return;
    beginEdit();
    var a = document.createElement('a');
    a.setAttribute('href', url);
    if (range && !range.collapsed) {
      try {
        var frag = range.extractContents();
        a.appendChild(frag);
        range.insertNode(a);
      } catch (e) {
        a.textContent = url;
        insertInlineAtCaret(a);
      }
    } else {
      a.textContent = url;
      insertInlineAtCaret(a);
    }
    endEdit();
  }

  function insertMath() {
    beginEdit();
    var span = document.createElement('span');
    span.className = 'math-inline';
    span.setAttribute('data-tex', 'E=mc^2');
    span.setAttribute('contenteditable', 'false');
    span.textContent = 'E=mc^2';
    insertInlineAtCaret(span);
    endEdit();
    renderMathEl(span);
    openMathEditor(span);
  }

  function insertDisplayMath() {
    beginEdit();
    var div = document.createElement('div');
    div.className = 'math-display';
    div.setAttribute('data-tex', 'E=mc^2');
    div.setAttribute('contenteditable', 'false');
    div.textContent = 'E=mc^2';
    insertBlockAfterCaretBlock(div);
    endEdit();
    renderMathEl(div);
    openMathEditor(div);
  }

  function insertFootnote() {
    var note = window.prompt('脚注の内容を入力してください', '');
    if (note == null || note === '') return;
    beginEdit();
    var span = document.createElement('span');
    span.className = 'footnote';
    span.setAttribute('data-note', note);
    span.setAttribute('contenteditable', 'false');
    span.textContent = '*';
    decorateFootnote(span);
    insertInlineAtCaret(span);
    renumberFootnotes();
    endEdit();
  }

  function renumberFootnotes() {
    var d = doc();
    if (!d) return;
    var notes = d.querySelectorAll('span.footnote');
    for (var i = 0; i < notes.length; i++) notes[i].textContent = String(i + 1);
  }

  /* ================= フェーズ15: 本文→ファイルへのリンク ================= */

  // filelink 要素を生成。filelink.js(window.FileLink)が読み込まれていればそちらを
  // 使い、無ければ最低限の要素を自前で作る(防御)。
  function fallbackFileIcon(path) {
    var ext = String(path || '').split('.').pop().toLowerCase();
    if (ext === 'pdf') return '📄';
    if (ext === 'md' || ext === 'txt') return '📝';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].indexOf(ext) !== -1) return '🖼';
    if (ext === 'bib') return '📚';
    if (ext === 'tex') return '📄';
    return '📎';
  }

  function makeFileLinkElement(path, label, loc, tid) {
    if (window.FileLink && typeof window.FileLink.createElement === 'function') {
      try { return window.FileLink.createElement(path, label, loc, tid); } catch (e) { /* fall through */ }
    }
    var span = document.createElement('span');
    span.className = 'filelink';
    span.setAttribute('data-path', String(path || ''));
    span.setAttribute('data-loc', String(loc || ''));
    if (tid) span.setAttribute('data-tid', String(tid));
    span.setAttribute('contenteditable', 'false');
    span.setAttribute('title', String(path || '') + (loc ? ' (' + loc + ')' : ''));
    var icon = document.createElement('span');
    icon.className = 'filelink-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = fallbackFileIcon(path);
    span.appendChild(icon);
    var lab = document.createElement('span');
    lab.className = 'filelink-label';
    lab.textContent = String(label || String(path || '').split('/').pop() || path || '');
    span.appendChild(lab);
    if (!tid) decorateFileLink(span); // スレッド接続時は threads.js が装飾
    return span;
  }

  // filelink 要素を現在のキャレット/選択位置に挿入(履歴付き)。savedRange があれば
  // それを選択として復元してから挿入する(ピッカーのプロンプトで選択が失われるため)。
  function insertFileLinkElement(path, label, loc, savedRange, tid) {
    if (commentOnly) { commentOnlyBlocked(); return null; }
    if (!path) return null;
    beginEdit();
    if (savedRange) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      } catch (e) { /* 復元できなくてもキャレット位置に挿入する */ }
    }
    var el = makeFileLinkElement(path, label, loc, tid);
    insertInlineAtCaret(el);
    endEdit();
    return el;
  }

  // 「ファイルにリンク」コマンド: 選択テキストをラベルにして、プロジェクト内ファイルを
  // 選択 → filelink を挿入。ピッカーは filelink.js(FileLink.pickFile)を優先し、
  // 無ければ prompt でパス入力(防御)。
  function insertFileLink() {
    var range = currentRange();
    var labelText = range && !range.collapsed ? String(range.toString()) : '';
    var savedRange = range ? range.cloneRange() : null;

    function doInsert(path, loc) {
      if (path == null || String(path).trim() === '') return;
      var label = labelText || String(path).split('/').pop() || String(path);
      insertFileLinkElement(String(path).trim(), label, loc == null ? '' : String(loc).trim(), savedRange);
    }

    if (window.FileLink && typeof window.FileLink.pickFile === 'function') {
      window.FileLink.pickFile(doInsert, { label: labelText });
      return;
    }
    // 防御: filelink.js 未ロード時は prompt でパス入力
    var p = window.prompt('リンクするファイルのパス(プロジェクト内, 例 attachments/knuth.pdf)', 'attachments/');
    if (p == null || p.trim() === '') return;
    var lc = window.prompt('ページ/位置(任意, 例 p.3)', '') || '';
    doInsert(p.trim(), lc.trim());
  }

  function insertPageBreak() {
    beginEdit();
    var div = document.createElement('div');
    div.className = 'page-break';
    div.setAttribute('contenteditable', 'false');
    insertBlockAfterCaretBlock(div);
    endEdit();
  }

  /* ================= 引用 / 文献目録(フェーズ3b) ================= */

  // キャレット位置に引用 span を挿入。keys は "key1,key2"。表示は [key1,key2]。
  function insertCite(keys) {
    var norm = String(keys == null ? '' : keys)
      .split(',').map(function (k) { return k.trim(); })
      .filter(function (k) { return !!k; }).join(',');
    if (!norm) return;
    beginEdit();
    var span = document.createElement('span');
    span.className = 'cite';
    span.setAttribute('data-key', norm);
    span.setAttribute('contenteditable', 'false');
    span.textContent = '[' + norm + ']';
    decorateCite(span);
    insertInlineAtCaret(span);
    endEdit();
    return span;
  }

  // 文献目録ブロックを挿入(重複は作らない)。中身は app.js が renderBibliographies で描画。
  function insertBibliographyBlock() {
    var d = doc();
    if (!d) return null;
    var existing = d.querySelector('.bibliography');
    if (existing) { caretToStartOf(existing); return existing; }
    beginEdit();
    var div = document.createElement('div');
    div.className = 'bibliography';
    div.setAttribute('contenteditable', 'false');
    div.setAttribute('role', 'doc-bibliography');
    div.textContent = '参考文献';
    insertBlockAfterCaretBlock(div);
    endEdit();
    return div;
  }

  /* ================= 数式ポップオーバー ================= */

  var mathTarget = null;

  function getMathEditor() {
    var pop = byId('math-editor');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'math-editor';
    pop.setAttribute('hidden', '');
    // CSS が無くても最低限機能するようインラインで整える
    pop.style.position = 'absolute';
    pop.style.zIndex = '1000';
    pop.style.background = '#ffffff';
    pop.style.border = '1px solid #c8c8c8';
    pop.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
    pop.style.padding = '8px';
    pop.style.display = 'none';
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'math-editor-input';
    input.style.width = '260px';
    input.style.fontFamily = 'monospace';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.id = 'math-editor-ok';
    ok.textContent = 'OK';
    ok.style.marginLeft = '6px';
    pop.appendChild(input);
    pop.appendChild(ok);
    document.body.appendChild(pop);

    function commit() {
      if (mathTarget) {
        var v = input.value;
        mathTarget.setAttribute('data-tex', v);
        mathTarget.textContent = v || ' ';
        mathTarget.removeAttribute('data-mathml-tex'); // 再描画を強制
        renderMathEl(mathTarget);                      // MathML へ再変換(失敗時は生 TeX)
        var d = doc();
        if (d) d.dispatchEvent(new Event('input', { bubbles: true }));
        commitSnapshotNow();
      }
      closeMathEditor();
    }
    ok.addEventListener('click', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeMathEditor(); }
    });
    return pop;
  }

  function openMathEditor(target) {
    var pop = getMathEditor();
    mathTarget = target;
    var input = pop.querySelector('input');
    if (input) input.value = target.getAttribute('data-tex') || '';
    var rect = target.getBoundingClientRect();
    pop.style.left = (rect.left + window.scrollX) + 'px';
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.removeAttribute('hidden');
    pop.style.display = 'block';
    if (input) { input.focus(); input.select(); }
  }

  function closeMathEditor() {
    var pop = byId('math-editor');
    if (pop) {
      pop.setAttribute('hidden', '');
      pop.style.display = 'none';
    }
    mathTarget = null;
  }

  /* ================= フェーズ22: 数式の MathML 化(Temml 動的ロード) =================
   * .math-inline / .math-display は data-tex を真実源のまま保持し(latex.js /
   * docx.js は data-tex のみ参照)、表示 DOM だけ MathML Core に置換して
   * スクリーンリーダーに数式として読ませる。Temml は最初の数式描画時に
   * public/vendor/temml/ から動的ロードし、ロード完了後に取りこぼしを一括変換する。
   * 変換失敗・ロード失敗時は現行の生 TeX 表示のまま(回帰ゼロ)。 */

  var TEMML_SRC = 'vendor/temml/temml.min.js';
  var temmlState = 0; // 0=未ロード 1=ロード中 2=完了 3=失敗

  function temmlLib() {
    return (typeof window !== 'undefined') ? window.temml : null;
  }

  // Temml を一度だけ <script> 注入。ロード完了後に未変換の数式を一括変換する。
  function loadTemml() {
    if (temmlLib()) { temmlState = 2; return; }
    if (temmlState === 1 || temmlState === 3) return;
    temmlState = 1;
    var s = document.createElement('script');
    s.src = TEMML_SRC;
    s.async = true;
    s.setAttribute('data-temml', '1');
    s.onload = function () {
      temmlState = temmlLib() ? 2 : 3;
      if (temmlState === 2) renderAllMath(); // ロード前に描画された分を回収
    };
    s.onerror = function () { temmlState = 3; };
    document.head.appendChild(s);
  }

  // DOM 非依存の変換部: TeX 文字列 → MathML 文字列。Temml 未ロード/失敗時は null。
  // (node からも単体で呼べるよう window.temml のみに依存させる)
  function renderTexToMathML(tex, displayMode) {
    var lib = temmlLib();
    if (!lib || typeof lib.renderToString !== 'function') return null;
    try {
      return lib.renderToString(String(tex), {
        displayMode: !!displayMode,
        throwOnError: false
      });
    } catch (e) {
      return null;
    }
  }

  // 単一の数式要素を MathML 化。data-tex は保持、contenteditable=false / class は不変。
  function renderMathEl(el) {
    if (!el || el.nodeType !== 1 || !el.classList) return;
    var tex = el.getAttribute('data-tex');
    if (tex == null || String(tex).trim() === '') return; // 空は生表示のまま
    // 既に同じ TeX で描画済みなら何もしない(冪等・無限ループ防止)
    if (el.getAttribute('data-mathml-tex') === tex && el.querySelector('math')) return;
    var mml = renderTexToMathML(tex, el.classList.contains('math-display'));
    if (!mml) { loadTemml(); return; } // 未ロードなら起動し、現状(生 TeX)維持
    // クリックターゲット/編集不可を維持したまま中身だけ差し替える
    el.setAttribute('contenteditable', 'false');
    el.innerHTML = mml;
    el.setAttribute('data-mathml-tex', tex);
  }

  // #doc(または指定 root)内の全数式を MathML 化。未ロードなら Temml を起動。
  function renderAllMath(root) {
    if (typeof document === 'undefined') return;
    var scope = root || doc();
    if (!scope || !scope.querySelectorAll) return;
    var els = scope.querySelectorAll('.math-inline, .math-display');
    if (!els.length) return;
    if (!temmlLib()) {
      // 何か 1 つでも中身のある数式があればロードを起動
      for (var k = 0; k < els.length; k++) {
        if (String(els[k].getAttribute('data-tex') || '').trim()) { loadTemml(); break; }
      }
    }
    for (var i = 0; i < els.length; i++) renderMathEl(els[i]);
  }

  /* ---- フェーズ22: 脚注 / 引用 / ファイルリンクの SR アンカー属性 ----
   * data-tex 同様、latex.js / docx.js は class と data-* のみ参照するため
   * role / aria-label / tabindex を足しても LaTeX / docx 出力は不変更。
   * thread-ref / filelink[data-tid](スレッド系)は threads.js が装飾する。 */

  function decorateFootnote(el) {
    var note = el.getAttribute('data-note') || '';
    el.setAttribute('role', 'doc-noteref');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', '脚注: ' + String(note).slice(0, 80));
  }

  function decorateCite(el) {
    var key = el.getAttribute('data-key') || '';
    el.setAttribute('role', 'doc-biblioref');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', '引用: ' + key);
  }

  function decorateAnchors(root) {
    if (typeof document === 'undefined') return;
    var scope = root || doc();
    if (!scope || !scope.querySelectorAll) return;
    var notes = scope.querySelectorAll('span.footnote');
    for (var i = 0; i < notes.length; i++) decorateFootnote(notes[i]);
    var cites = scope.querySelectorAll('span.cite');
    for (var j = 0; j < cites.length; j++) decorateCite(cites[j]);
    // 参考文献ブロックに doc-bibliography ロール
    var bibs = scope.querySelectorAll('.bibliography');
    for (var b = 0; b < bibs.length; b++) bibs[b].setAttribute('role', 'doc-bibliography');
    // スレッド未接続の filelink(data-tid なし)はファイルリンクとして装飾
    var fls = scope.querySelectorAll('.filelink');
    for (var f = 0; f < fls.length; f++) {
      if (fls[f].getAttribute('data-tid')) continue; // スレッド系は threads.js が担当
      decorateFileLink(fls[f]);
    }
  }

  function decorateFileLink(el) {
    if (el.getAttribute('role') !== 'button') el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    var lab = el.querySelector('.filelink-label');
    var name = (lab && lab.textContent) || el.getAttribute('data-path') || '';
    el.setAttribute('aria-label', 'ファイル: ' + name);
  }

  /* ================= フェーズ31: tex-raw(原文温存)ブロック/インライン =================
   * 変換できない LaTeX は data-tex-raw に原文を保持し、表示だけ折りたたみチップに置換する。
   * latex.js / docx 出力は data-tex-raw のみ参照するため、表示 DOM を変えても出力は不変。 */

  function trEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function trI18n(key, fb) {
    try { return (window.I18n && typeof window.I18n.t === 'function') ? window.I18n.t(key, fb) : fb; }
    catch (e) { return fb; }
  }
  function texRawSummary(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    return s.length > 50 ? s.slice(0, 50) + '…' : s;
  }

  // 単一の tex-raw 要素を折りたたみチップに描画。data-tex-raw は不変(真実源)。
  function renderTexRawEl(el) {
    if (!el || el.nodeType !== 1 || !el.classList || !el.classList.contains('tex-raw')) return;
    var raw = el.getAttribute('data-tex-raw');
    if (raw == null) raw = '';
    var isBlock = el.tagName === 'DIV';
    var expanded = el.getAttribute('data-expanded') === '1';
    var sig = raw + ' ' + (expanded ? '1' : '0');
    if (el.getAttribute('data-rr') === sig) return;   // 冪等(MutationObserver ループ防止)
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    var summary = texRawSummary(raw);
    el.setAttribute('aria-label',
      (isBlock ? trI18n('texraw.blockAria', 'LaTeX ブロック: ') : trI18n('texraw.inlineAria', 'LaTeX: ')) + summary);
    el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (isBlock) {
      var chip = '<span class="tex-raw-chip">' +
        '<span class="tex-raw-tag">LaTeX</span>' +
        '<span class="tex-raw-sum">' + trEsc(summary) + '</span></span>';
      if (expanded) chip += '<pre class="tex-raw-src">' + trEsc(raw) + '</pre>';
      el.innerHTML = chip;
    } else {
      // インラインは原文をモノスペースでそのまま表示(短いので折りたたみ不要)
      el.innerHTML = '<span class="tex-raw-code">' + trEsc(raw) + '</span>';
    }
    el.setAttribute('data-rr', sig);
  }

  function renderTexRaw(root) {
    if (typeof document === 'undefined') return;
    var scope = root || doc();
    if (!scope || !scope.querySelectorAll) return;
    var els = scope.querySelectorAll('.tex-raw');
    for (var i = 0; i < els.length; i++) renderTexRawEl(els[i]);
  }

  function toggleTexRaw(el) {
    if (!el || !el.classList.contains('tex-raw') || el.tagName !== 'DIV') return; // 展開はブロックのみ
    el.setAttribute('data-expanded', el.getAttribute('data-expanded') === '1' ? '0' : '1');
    renderTexRawEl(el);
  }

  /* ---- tex-raw 原文編集ダイアログ(#math-editor と同系の小ポップオーバー) ---- */
  var texRawTarget = null;
  function getTexRawEditor() {
    var pop = byId('texraw-editor');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'texraw-editor';
    pop.setAttribute('hidden', '');
    pop.style.position = 'absolute';
    pop.style.zIndex = '1000';
    pop.style.display = 'none';
    var ta = document.createElement('textarea');
    ta.id = 'texraw-editor-input';
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', trI18n('texraw.editAria', 'LaTeX 原文の編集'));
    var row = document.createElement('div');
    row.className = 'texraw-editor-row';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.id = 'texraw-editor-ok';
    ok.textContent = trI18n('math.ok', 'OK');
    row.appendChild(ok);
    pop.appendChild(ta);
    pop.appendChild(row);
    document.body.appendChild(pop);

    function commit() {
      if (texRawTarget) {
        var v = ta.value;
        texRawTarget.setAttribute('data-tex-raw', v);
        texRawTarget.removeAttribute('data-rr'); // 再描画を強制
        renderTexRawEl(texRawTarget);
        var d = doc();
        if (d) d.dispatchEvent(new Event('input', { bubbles: true }));
        commitSnapshotNow();
      }
      closeTexRawEditor();
    }
    ok.addEventListener('click', commit);
    ta.addEventListener('keydown', function (e) {
      // Cmd/Ctrl+Enter で確定、Esc で取消(改行を入れられるよう素の Enter は許容)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeTexRawEditor(); }
    });
    return pop;
  }
  function openTexRawEditor(target) {
    var pop = getTexRawEditor();
    texRawTarget = target;
    var ta = pop.querySelector('textarea');
    if (ta) ta.value = target.getAttribute('data-tex-raw') || '';
    var rect = target.getBoundingClientRect();
    pop.style.left = (rect.left + window.scrollX) + 'px';
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.removeAttribute('hidden');
    pop.style.display = 'block';
    if (ta) { ta.focus(); ta.select(); }
  }
  function closeTexRawEditor() {
    var pop = byId('texraw-editor');
    if (pop) { pop.setAttribute('hidden', ''); pop.style.display = 'none'; }
    texRawTarget = null;
  }

  /* ================= 画像 ================= */

  function setupImageInput() {
    var input = byId('image-input');
    if (!input) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result || '');
        insertImageFromDataUrl(dataUrl, file.type);
      };
      reader.readAsDataURL(file);
    });
  }

  function insertImageFromDataUrl(dataUrl, mime) {
    var needsConvert = !/^image\/(png|jpeg)$/.test(mime || '');
    if (needsConvert) {
      // gif/webp 等は xelatex 非対応 → canvas 経由で PNG 化
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 1;
          canvas.height = img.naturalHeight || 1;
          canvas.getContext('2d').drawImage(img, 0, 0);
          placeImage(canvas.toDataURL('image/png'));
        } catch (e) {
          placeImage(dataUrl);
        }
      };
      img.onerror = function () { placeImage(dataUrl); };
      img.src = dataUrl;
    } else {
      placeImage(dataUrl);
    }
  }

  function placeImage(dataUrl) {
    // フェーズ4: 代替テキストを prompt で入力 (スキップ可)
    var alt = '';
    try { alt = window.prompt('画像の代替テキスト (アクセシビリティ用。スキップ可):', '') || ''; } catch (e) { alt = ''; }
    alt = alt.trim();

    // prompt / 非同期 put の間に選択が失われるため、挿入位置を退避しておく
    var range = currentRange();
    var savedRange = range ? range.cloneRange() : null;

    // フェーズ19: base64 を DOM に残さず、資産として外部化(ローカル=assets/、クラウド=Storage)し
    //   img.src を参照 URL に張り替える。バックエンドが無ければ従来どおり base64 を挿入(非破壊)。
    var A = window.Assets;
    if (A && A.canExternalize && A.canExternalize()) {
      A.put(dataUrl).then(function (res) {
        insertImageElement(res.url, alt, savedRange, res.ref);
      }).catch(function () {
        insertImageElement(dataUrl, alt, savedRange, null);
      });
    } else {
      insertImageElement(dataUrl, alt, savedRange, null);
    }
  }

  // <figure><img></figure> を退避した位置に挿入する。ref があれば data-asset に正準参照を保持。
  function insertImageElement(src, alt, savedRange, ref) {
    beginEdit();
    if (savedRange) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      } catch (e) { /* 復元できなくてもキャレット位置に挿入する */ }
    }
    var figure = document.createElement('figure');
    var img = document.createElement('img');
    img.src = src;
    if (ref) img.setAttribute('data-asset', ref);
    img.style.maxWidth = '100%';
    img.setAttribute('alt', alt || '');
    figure.appendChild(img);
    insertBlockAfterCaretBlock(figure);
    endEdit();
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce(alt ? '画像を挿入しました。代替テキスト: ' + alt : '画像を挿入しました。代替テキストは未設定です');
    }
  }

  // フェーズ4: 画像クリックで代替テキストを編集
  function editImageAlt(img) {
    if (!img) return;
    var cur = img.getAttribute('alt') || '';
    var next;
    try { next = window.prompt('画像の代替テキスト:', cur); } catch (e) { next = null; }
    if (next === null) return;   // キャンセル
    beginEdit();
    img.setAttribute('alt', next.trim());
    endEdit();
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce('代替テキストを更新しました');
    }
  }

  /* ================= undo / redo ================= */

  // コメント ref の一時ハイライト(.active)は編集内容ではないので履歴から除外する
  function cleanSnapshotHtml(html) {
    return String(html).replace(/(<span[^>]*class="[^"]*?)\s*\bactive\b([^"]*"[^>]*>)/g, '$1$2');
  }

  function snapshot() {
    var d = doc();
    return d ? cleanSnapshotHtml(d.innerHTML) : null;
  }

  function commitSnapshotNow() {
    var d = doc();
    if (!d) return;
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    var html = cleanSnapshotHtml(d.innerHTML);
    if (prevState === null) { prevState = html; return; }
    if (html === prevState) return;
    undoStack.push(prevState);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    prevState = html;
    redoStack.length = 0;
  }

  function scheduleSnapshot() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(commitSnapshotNow, 500);
  }

  // 編集コマンドの前後で確実に履歴を切る
  function beginEdit() { commitSnapshotNow(); }
  function endEdit() {
    commitSnapshotNow();
    var d = doc();
    if (d) d.dispatchEvent(new Event('input', { bubbles: true }));
    updateAll();
  }

  function restore(html) {
    var d = doc();
    if (!d || html == null) return;
    d.innerHTML = html;
    prevState = html;
    renumberFootnotes();
    renderAllMath(d);   // フェーズ22: undo/redo 後も数式を MathML 再描画(冪等)
    decorateAnchors(d); // 脚注/引用/ファイルリンクの SR 属性を再付与
    ensureNotEmpty();
    // undo/redo で comment-ref が出入りするためカードを Map から再構築する
    renderComments();
    updateAll();
    var first = d.firstElementChild;
    if (first) caretToStartOf(first);
    d.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function undo() {
    commitSnapshotNow();
    if (!undoStack.length) return;
    var cur = snapshot();
    redoStack.push(cur);
    restore(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length) return;
    var cur = snapshot();
    undoStack.push(cur);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    restore(redoStack.pop());
  }

  /* ================= クリップボード / 編集 ================= */

  function cmdCopy() {
    var sel = window.getSelection();
    var text = sel ? sel.toString() : '';
    if (text && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { });
    }
  }

  function cmdCut() {
    var range = currentRange();
    cmdCopy();
    if (range && !range.collapsed) {
      beginEdit();
      range.deleteContents();
      ensureNotEmpty();
      endEdit();
    }
  }

  function cmdPaste() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) {
        if (text) insertPlainText(text);
      }).catch(function () {
        // 権限がない場合は Ctrl+V(ネイティブ paste イベント)に任せる
      });
    }
  }

  function cmdFind() {
    var q = window.prompt('検索する文字列', '');
    if (q && typeof window.find === 'function') window.find(q);
  }

  function cmdSelectAll() {
    var d = doc();
    if (!d) return;
    var sel = window.getSelection();
    var r = document.createRange();
    r.selectNodeContents(d);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertPlainText(text) {
    var d = doc();
    if (!d) return;
    beginEdit();
    var range = currentRange();
    if (!range) {
      var p = document.createElement('p');
      p.textContent = text;
      d.appendChild(p);
      endEdit();
      return;
    }
    if (!range.collapsed) range.deleteContents();
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    var node = document.createTextNode(lines[0]);
    range.insertNode(node);
    setCaret(node, node.length);
    for (var i = 1; i < lines.length; i++) {
      var nb = splitBlockAtCaret();
      if (!nb) break;
      if (lines[i]) {
        var t = document.createTextNode(lines[i]);
        nb.insertBefore(t, nb.firstChild);
        // 空ブロック用の br が残っていれば除去
        var br = t.nextSibling;
        if (br && br.nodeName === 'BR') nb.removeChild(br);
        setCaret(t, t.length);
      }
    }
    endEdit();
  }

  /* ================= Enter / Tab キー ================= */

  function isEmptyBlock(el) {
    if (!el) return true;
    var text = el.textContent || '';
    if (text.replace(/[​\s]/g, '') !== '') return false;
    return !el.querySelector || !el.querySelector('img, .math-inline, .math-display');
  }

  // キャレット位置でブロック(または li)を分割し、後半ブロックを返す
  function splitBlockAtCaret() {
    var d = doc();
    var range = currentRange();
    if (!d || !range) return null;
    var li = liOf(range.startContainer);
    var block = li || topBlockOf(range.startContainer);
    if (!block) {
      var p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      d.appendChild(p);
      caretToStartOf(p);
      return p;
    }
    var r2 = document.createRange();
    r2.setStart(range.startContainer, range.startOffset);
    r2.setEnd(block, block.childNodes.length);
    var frag = r2.extractContents();

    var headingLike = /^(H1|H2|H3|BLOCKQUOTE)$/.test(block.nodeName) ||
      (block.nodeName === 'P' && (block.classList.contains('title') || block.classList.contains('subtitle')));
    var fragEmpty = !frag.textContent.replace(/[​\s]/g, '') && !frag.querySelector('img, .math-inline, .math-display');

    var newBlock;
    if (li) {
      newBlock = document.createElement('li');
    } else if (headingLike && fragEmpty) {
      newBlock = document.createElement('p'); // 見出し末尾で Enter → 標準に戻る
    } else {
      newBlock = block.cloneNode(false);
    }
    newBlock.appendChild(frag);
    if (!newBlock.firstChild) newBlock.appendChild(document.createElement('br'));
    if (!block.firstChild) block.appendChild(document.createElement('br'));
    block.parentNode.insertBefore(newBlock, block.nextSibling);
    caretToStartOf(newBlock);
    return newBlock;
  }

  function handleEnter(e) {
    var d = doc();
    var range = currentRange();
    if (!d || !range) return;
    e.preventDefault();
    beginEdit();
    if (!range.collapsed) {
      range.deleteContents();
      range = currentRange();
    }
    var li = range ? liOf(range.startContainer) : null;
    if (li && isEmptyBlock(li)) {
      // 空 li で Enter → リスト解除(Word挙動)
      outdentLi(li);
      endEdit();
      return;
    }
    // テーブルセル内では段落分割せず改行のみ
    var cellEl = range ? range.startContainer : null;
    cellEl = cellEl && cellEl.nodeType === 1 ? cellEl : (cellEl ? cellEl.parentNode : null);
    while (cellEl && cellEl !== d) {
      if (cellEl.nodeName === 'TD' || cellEl.nodeName === 'TH') {
        var brEl = document.createElement('br');
        range.insertNode(brEl);
        var rAfter = document.createRange();
        rAfter.setStartAfter(brEl);
        rAfter.collapse(true);
        var selA = window.getSelection();
        selA.removeAllRanges();
        selA.addRange(rAfter);
        endEdit();
        return;
      }
      cellEl = cellEl.parentNode;
    }
    var block = li || (range ? topBlockOf(range.startContainer) : null);
    if (block && block.nodeName === 'PRE') {
      // コードブロック内は改行文字を挿入
      var t = document.createTextNode('\n');
      range.insertNode(t);
      setCaret(t, 1);
      endEdit();
      return;
    }
    splitBlockAtCaret();
    endEdit();
  }

  function handleTab(e) {
    var range = currentRange();
    var li = range ? liOf(range.startContainer) : null;
    e.preventDefault();
    if (li) indentOutdent(e.shiftKey ? -1 : 1);
    // リスト外の Tab は無視(仕様)
  }

  function ensureNotEmpty() {
    var d = doc();
    if (!d) return;
    if (!d.firstElementChild) {
      var p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      d.appendChild(p);
      caretToStartOf(p);
    }
  }

  /* ================= 状態計算とリボン同期 ================= */

  function computeState() {
    var state = {
      bold: false, italic: false, underline: false, strikethrough: false,
      subscript: false, superscript: false, highlight: false, foreColor: false,
      align: 'left', list: '', styleKey: 'normal',
      fontFamily: 'serif', fontSize: '10.5',
      canUndo: undoStack.length > 0, canRedo: redoStack.length > 0
    };
    var d = doc();
    var sel = window.getSelection();
    if (!d || !sel || sel.rangeCount === 0) return state;
    var node = sel.anchorNode;
    if (!node || !d.contains(node)) return state;

    Object.keys(INLINE_FORMATS).forEach(function (key) {
      if (matchAncestor(node, INLINE_FORMATS[key].match)) state[key] = true;
    });
    var ff = matchAncestor(node, isFF);
    if (ff) {
      var m = /ff-(serif|sans|mono)/.exec(ff.className);
      if (m) state.fontFamily = m[1];
    }
    var fs = matchAncestor(node, isFS);
    if (fs) state.fontSize = fs.getAttribute('data-pt') || '10.5';

    var li = liOf(node);
    var block = li || topBlockOf(node);
    if (li) {
      var listEl = li.parentNode;
      state.list = listEl && listEl.nodeName === 'OL' ? 'ol' : 'ul';
    } else if (block && /^(UL|OL)$/.test(block.nodeName)) {
      state.list = block.nodeName.toLowerCase();
    }
    if (block && block.style && block.style.textAlign) state.align = block.style.textAlign;
    state.styleKey = li ? 'normal' : styleKeyOf(block);
    return state;
  }

  function setActive(cmd, on) {
    var btns = document.querySelectorAll('[data-command="' + cmd + '"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', !!on);
      // フェーズ4: トグル系ボタンの aria-pressed を .is-active と同期
      if (btns[i].hasAttribute('aria-pressed')) {
        btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }

  function updateRibbon() {
    var st = computeState();
    ['bold', 'italic', 'underline', 'strikethrough', 'subscript', 'superscript', 'highlight', 'foreColor']
      .forEach(function (k) { setActive(k, st[k]); });
    setActive('alignLeft', st.align === 'left' || st.align === '');
    setActive('alignCenter', st.align === 'center');
    setActive('alignRight', st.align === 'right');
    setActive('alignJustify', st.align === 'justify');
    setActive('bulletList', st.list === 'ul');
    setActive('numberList', st.list === 'ol');

    var styleBtns = document.querySelectorAll('[data-command="style"]');
    for (var i = 0; i < styleBtns.length; i++) {
      var v = styleBtns[i].getAttribute('data-value');
      var on = (v === st.styleKey);
      styleBtns[i].classList.toggle('is-active', on);
      // フェーズ4: role=option の aria-selected を同期
      if (styleBtns[i].hasAttribute('aria-selected')) {
        styleBtns[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }
    var ffSel = byId('font-family');
    if (ffSel && ffSel.value !== st.fontFamily) ffSel.value = st.fontFamily;
    var fsSel = byId('font-size');
    if (fsSel && String(fsSel.value) !== String(st.fontSize)) fsSel.value = String(st.fontSize);
  }

  /* ================= ページシート / ステータスバー ================= */

  function mmToPx(mm) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:' + mm + 'mm;width:1px;';
    document.body.appendChild(probe);
    var px = probe.offsetHeight;
    document.body.removeChild(probe);
    return px || mm * 3.7795;
  }

  function sheetHeightPx() {
    var d = pageDims();
    if (!sheetHeightCache[d.key]) sheetHeightCache[d.key] = mmToPx(d.hMm);
    return sheetHeightCache[d.key];
  }

  function updateSheets() {
    var d = doc();
    var sheets = byId('page-sheets');
    if (!d) return;
    var sheetH = sheetHeightPx();
    var docH = d.offsetHeight || d.scrollHeight;
    var pages = Math.max(1, Math.ceil((docH + SHEET_GAP) / (sheetH + SHEET_GAP)));

    if (sheets) {
      var dim = pageDims();
      while (sheets.children.length > pages) sheets.removeChild(sheets.lastChild);
      while (sheets.children.length < pages) {
        var sheet = document.createElement('div');
        sheet.className = 'sheet';
        sheets.appendChild(sheet);
      }
      for (var i = 0; i < sheets.children.length; i++) {
        var s = sheets.children[i];
        s.style.height = dim.hMm + 'mm';
        s.style.width = dim.wMm + 'mm';
        s.style.marginBottom = i < sheets.children.length - 1 ? SHEET_GAP + 'px' : '0';
      }
    }
    updateStatusbar(pages, sheetH);
  }

  function currentPageNumber(sheetH) {
    var d = doc();
    var range = currentRange();
    if (!d || !range) return 1;
    try {
      var rects = range.getClientRects();
      var y;
      if (rects.length) y = rects[0].top;
      else {
        var el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode;
        if (!el || !el.getBoundingClientRect) return 1;
        y = el.getBoundingClientRect().top;
      }
      var docTop = d.getBoundingClientRect().top;
      var zoomScale = 1;
      var pc = byId('page-container');
      if (pc) {
        var tf = window.getComputedStyle(pc).transform;
        var mt = /matrix\(([-0-9.]+)/.exec(tf);
        if (mt) zoomScale = parseFloat(mt[1]) || 1;
      }
      var offsetY = (y - docTop) / zoomScale;
      return Math.max(1, Math.floor(offsetY / (sheetH + SHEET_GAP)) + 1);
    } catch (e) {
      return 1;
    }
  }

  function updateStatusbar(pages, sheetH) {
    var d = doc();
    var pageInd = byId('page-indicator');
    if (pageInd) {
      var cur = Math.min(pages, currentPageNumber(sheetH || sheetHeightPx()));
      pageInd.textContent = cur + '/' + pages + ' ページ';
    }
    var charCount = byId('char-count');
    if (charCount && d) {
      var count = (d.textContent || '').replace(/[\n​]/g, '').length;
      charCount.textContent = count + ' 文字';
    }
  }

  function updateAll() {
    updateRibbon();
    updateSheets();
    scheduleCommentRender();
  }

  /* ================= コメント(フェーズ2) ================= */

  var COMMENTS_KEY = 'wordtex-comments';
  var comments = {};        // cid -> { text, time }
  var commentSeq = 0;
  var activeCid = null;
  var commentRenderTimer = null;

  function commentsPanel() { return byId('comments-panel'); }

  function loadComments() {
    try {
      var raw = localStorage.getItem(COMMENTS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          Object.keys(data).forEach(function (cid) {
            var v = data[cid];
            if (v && typeof v === 'object') {
              comments[cid] = { text: String(v.text || ''), time: Number(v.time) || Date.now() };
            } else if (typeof v === 'string') {
              comments[cid] = { text: v, time: Date.now() };
            }
          });
        }
      }
    } catch (e) { /* localStorage 不可でも続行 */ }
    Object.keys(comments).forEach(function (cid) {
      var m = /^c(\d+)$/.exec(cid);
      if (m) commentSeq = Math.max(commentSeq, parseInt(m[1], 10));
    });
  }

  function saveComments() {
    try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(comments)); } catch (e) { }
  }

  // 文書内に存在する(かつ Map にもある)cid を DOM 順で返す
  function presentCids() {
    var d = doc();
    var out = [];
    var seen = {};
    if (!d) return out;
    var refs = d.querySelectorAll('span.comment-ref[data-cid]');
    for (var i = 0; i < refs.length; i++) {
      var cid = refs[i].getAttribute('data-cid');
      if (cid && !seen[cid] && comments[cid]) { seen[cid] = true; out.push(cid); }
    }
    return out;
  }

  function refsFor(cid) {
    var d = doc();
    if (!d) return [];
    return d.querySelectorAll('span.comment-ref[data-cid="' + cid + '"]');
  }

  function relTime(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    if (s < 86400) return Math.floor(s / 3600) + ' 時間前';
    return Math.floor(s / 86400) + ' 日前';
  }

  function setActiveComment(cid, scrollTo) {
    activeCid = cid || null;
    var d = doc();
    if (d) {
      var refs = d.querySelectorAll('span.comment-ref');
      for (var i = 0; i < refs.length; i++) {
        refs[i].classList.toggle('active', !!activeCid && refs[i].getAttribute('data-cid') === activeCid);
      }
    }
    var panel = commentsPanel();
    if (panel) {
      var cards = panel.querySelectorAll('.comment-card');
      for (var j = 0; j < cards.length; j++) {
        cards[j].classList.toggle('active', !!activeCid && cards[j].getAttribute('data-cid') === activeCid);
      }
      if (scrollTo === 'card' && activeCid) {
        var card = panel.querySelector('.comment-card[data-cid="' + activeCid + '"]');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    if (scrollTo === 'ref' && activeCid) {
      var ref = refsFor(activeCid)[0];
      if (ref && ref.scrollIntoView) ref.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function buildCommentCard(cid) {
    var data = comments[cid];
    var card = document.createElement('div');
    card.className = 'comment-card' + (cid === activeCid ? ' active' : '');
    card.setAttribute('data-cid', cid);

    var head = document.createElement('div');
    head.className = 'comment-head';
    var avatar = document.createElement('span');
    avatar.className = 'comment-avatar';
    avatar.textContent = 'あ';
    var author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = 'あなた';
    var time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = relTime(data.time);
    var menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'comment-menu-btn';
    menuBtn.title = 'その他のスレッド操作';
    menuBtn.textContent = '…';
    var menu = document.createElement('div');
    menu.className = 'comment-menu';
    menu.hidden = true;
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'comment-delete';
    delBtn.textContent = 'スレッドの削除';
    menu.appendChild(delBtn);
    head.appendChild(avatar);
    head.appendChild(author);
    head.appendChild(time);
    head.appendChild(menuBtn);
    head.appendChild(menu);

    var body = document.createElement('div');
    body.className = 'comment-body';
    body.setAttribute('contenteditable', 'true');
    body.setAttribute('data-placeholder', 'コメントを入力');
    body.textContent = data.text || '';

    var reply = document.createElement('div');
    reply.className = 'comment-reply';
    reply.textContent = '返信…';

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(reply);
    return card;
  }

  function renderComments() {
    // フェーズ17: スレッドが有効なら旧コメントパネルではなくスレッドパネルを描画
    if (window.Threads) { renderThreads(); return; }
    var cids = presentCids();
    var d = doc();
    if (d) {
      // ref の .active 同期(active が消えた場合の掃除も兼ねる)
      if (activeCid && cids.indexOf(activeCid) === -1) activeCid = null;
      var refs = d.querySelectorAll('span.comment-ref');
      for (var i = 0; i < refs.length; i++) {
        refs[i].classList.toggle('active', !!activeCid && refs[i].getAttribute('data-cid') === activeCid);
      }
    }
    document.body.classList.toggle('has-comments', cids.length > 0);
    var panel = commentsPanel();
    if (!panel) return;
    panel.hidden = cids.length === 0;
    var list = panel.querySelector('.cp-list') || panel.querySelector('.comments-list') || panel;
    // 入力中のカードを壊さないよう、フォーカス中は再構築しない
    if (list.contains(document.activeElement) &&
      document.activeElement.classList &&
      document.activeElement.classList.contains('comment-body')) return;
    var cards = list.querySelectorAll('.comment-card');
    for (var k = 0; k < cards.length; k++) list.removeChild(cards[k]);
    for (var j = 0; j < cids.length; j++) list.appendChild(buildCommentCard(cids[j]));
  }

  function scheduleCommentRender() {
    if (commentRenderTimer) clearTimeout(commentRenderTimer);
    commentRenderTimer = setTimeout(renderComments, 200);
  }

  function removeCommentRefs(cid) {
    var refs = refsFor(cid);
    for (var i = 0; i < refs.length; i++) {
      var span = refs[i];
      var parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      if (parent.normalize) parent.normalize();
    }
  }

  function insertComment() {
    // フェーズ17: スレッドが有効なら新規スレッド(または caret 上のスレッドに追加)へ読み替え
    if (window.Threads) { insertThread(); return; }
    var d = doc();
    if (!d) return;
    var range = currentRange();
    var sel = window.getSelection();
    if (range && range.collapsed && sel && sel.modify) {
      // 選択なし → Word と同様にカーソル位置の単語へ
      try {
        sel.modify('move', 'backward', 'word');
        sel.modify('extend', 'forward', 'word');
      } catch (e) { }
      range = currentRange();
    }
    if (!range || range.collapsed) {
      window.alert('コメントを付ける文字列を選択してください。');
      return;
    }
    beginEdit();
    var texts = collectRangeTextNodes(range);
    if (!texts.length) { endEdit(); return; }
    commentSeq++;
    var cid = 'c' + commentSeq;
    for (var i = 0; i < texts.length; i++) {
      var w = document.createElement('span');
      w.className = 'comment-ref';
      w.setAttribute('data-cid', cid);
      texts[i].parentNode.insertBefore(w, texts[i]);
      w.appendChild(texts[i]);
    }
    comments[cid] = { text: '', time: Date.now() };
    saveComments();
    endEdit();
    if (window.A11y && window.A11y.announce) window.A11y.announce('コメントを追加しました');
    activeCid = cid;
    var panel = commentsPanel();
    if (panel) {
      renderComments();
      setActiveComment(cid, 'card');
      var input = panel.querySelector('.comment-card[data-cid="' + cid + '"] .comment-body');
      if (input && input.focus) input.focus();
    } else {
      var text = window.prompt('コメントを入力してください', '');
      if (text == null || text === '') {
        removeCommentRefs(cid);
        delete comments[cid];
        saveComments();
        commitSnapshotNow();
        renderComments();
        return;
      }
      comments[cid].text = text;
      saveComments();
      renderComments();
    }
  }

  function deleteCommentById(cid) {
    if (!cid || !comments[cid]) return;
    beginEdit();
    removeCommentRefs(cid);
    delete comments[cid];
    if (activeCid === cid) activeCid = null;
    saveComments();
    endEdit();
    renderComments();
    if (window.A11y && window.A11y.announce) window.A11y.announce('コメントを削除しました');
  }

  function commentAtCaret() {
    var range = currentRange();
    if (!range) return null;
    var el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode;
    var d = doc();
    while (el && el !== d) {
      if (el.nodeType === 1 && el.classList && el.classList.contains('comment-ref')) {
        return el.getAttribute('data-cid');
      }
      el = el.parentNode;
    }
    return null;
  }

  function deleteActiveComment() {
    var cid = commentAtCaret() || activeCid;
    if (!cid) {
      var cids = presentCids();
      if (!cids.length) return;
      cid = cids[cids.length - 1];
    }
    deleteCommentById(cid);
  }

  function stepComment(dir) {
    var cids = presentCids();
    if (!cids.length) return;
    var idx = cids.indexOf(commentAtCaret() || activeCid);
    var next;
    if (idx === -1) next = dir > 0 ? 0 : cids.length - 1;
    else next = (idx + dir + cids.length) % cids.length;
    setActiveComment(cids[next], 'ref');
    setActiveComment(cids[next], 'card');
    var ref = refsFor(cids[next])[0];
    if (ref) caretToStartOf(ref);
  }

  function initComments() {
    loadComments();
    var d = doc();
    if (d) {
      // 本文の comment-ref クリック → カードへジャンプ
      d.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== d) {
          if (t.nodeType === 1 && t.classList && t.classList.contains('thread-ref')) {
            if (window.Threads) window.Threads.setActive(t.getAttribute('data-tid'), 'card');
            return;
          }
          if (t.nodeType === 1 && t.classList && t.classList.contains('comment-ref')) {
            setActiveComment(t.getAttribute('data-cid'), 'card');
            return;
          }
          t = t.parentNode;
        }
      });
    }
    var panel = commentsPanel();
    if (panel) {
      panel.addEventListener('click', function (e) {
        var t = e.target;
        var card = null;
        var el = t;
        while (el && el !== panel) {
          if (el.nodeType === 1 && el.classList && el.classList.contains('comment-card')) { card = el; break; }
          el = el.parentNode;
        }
        if (!card) return;
        var cid = card.getAttribute('data-cid');
        if (t.classList && t.classList.contains('comment-menu-btn')) {
          var menu = card.querySelector('.comment-menu');
          if (menu) menu.hidden = !menu.hidden;
          return;
        }
        if (t.classList && t.classList.contains('comment-delete')) {
          deleteCommentById(cid);
          return;
        }
        // カードクリック → 本文 ref へジャンプ
        setActiveComment(cid, 'ref');
      });
      panel.addEventListener('input', function (e) {
        var t = e.target;
        if (!t.classList || !t.classList.contains('comment-body')) return;
        var el = t;
        while (el && el !== panel) {
          if (el.classList && el.classList.contains('comment-card')) {
            var cid = el.getAttribute('data-cid');
            if (comments[cid]) {
              comments[cid].text = t.textContent || '';
              saveComments();
            }
            return;
          }
          el = el.parentNode;
        }
      });
    }
    renderComments();
  }

  /* ================= スレッド(フェーズ17) =================
   * window.Threads(threads.js)が源。ここでは本文アンカー(.thread-ref[data-tid])
   * の挿入・移行・相互ハイライトと、スレッドパネルの描画呼び出しを担う。 */

  function threadPanel() { return byId('thread-panel') || byId('comments-panel'); }

  // スレッドパネルを描画。旧コメント(comment-ref)が残っていれば移行してから描く。
  function renderThreads() {
    if (!window.Threads) return false;
    migrateCommentRefsToThreads();
    var container = threadPanel();
    var count = window.Threads.list().length;
    document.body.classList.toggle('has-comments', count > 0);
    if (container) {
      container.hidden = count === 0;
      window.Threads.render(container);
    }
    return true;
  }

  // 既存 comment-ref[data-cid] → thread-ref[data-tid] + 1 コメントスレッドへ移行。
  function migrateCommentRefsToThreads() {
    if (!window.Threads || typeof window.Threads.migrateFromComments !== 'function') return;
    var d = doc();
    if (!d) return;
    var refs = d.querySelectorAll('span.comment-ref[data-cid]');
    if (!refs.length) return;
    var map = {};
    var i, cid;
    for (i = 0; i < refs.length; i++) {
      cid = refs[i].getAttribute('data-cid');
      if (cid && !map[cid]) map[cid] = comments[cid] || { text: '', time: Date.now() };
    }
    var mapping = window.Threads.migrateFromComments(map);
    for (i = 0; i < refs.length; i++) {
      var tid = mapping[refs[i].getAttribute('data-cid')];
      if (!tid) continue;
      refs[i].classList.remove('comment-ref');
      refs[i].classList.add('thread-ref');
      refs[i].removeAttribute('data-cid');
      refs[i].setAttribute('data-tid', tid);
    }
    // スレッド側が保持するので旧コメント Map をクリア(旧パネルを不活性化)
    comments = {};
    saveComments();
  }

  // 新規スレッドを作成し、選択範囲(なければ caret 上の単語)に thread-ref を付ける。
  function createThreadFromRange(range, comment, author, title) {
    var d = doc();
    if (!d || !window.Threads || !range || range.collapsed || !d.contains(range.commonAncestorContainer)) return null;
    beginEdit();
    var texts = collectRangeTextNodes(range);
    if (!texts.length) { endEdit(); return null; }
    var thread = window.Threads.create(String(title || range.toString() || 'AIとの会話').replace(/\s+/g, ' ').trim().slice(0, 60));
    for (var i = 0; i < texts.length; i++) {
      var w = document.createElement('span'); w.className = 'thread-ref'; w.setAttribute('data-tid', thread.tid);
      texts[i].parentNode.insertBefore(w, texts[i]); w.appendChild(texts[i]);
    }
    var item = window.Threads.addComment(thread.tid, String(comment || ''), String(author || 'あなた'));
    endEdit(); renderThreads();
    return { tid: thread.tid, itemId: item && item.id };
  }

  function insertThread() {
    var d = doc();
    if (!d || !window.Threads) return;
    var range = currentRange();
    var sel = window.getSelection();
    if (range && range.collapsed && sel && sel.modify) {
      try {
        sel.modify('move', 'backward', 'word');
        sel.modify('extend', 'forward', 'word');
      } catch (e) { }
      range = currentRange();
    }
    if (!range || range.collapsed) {
      window.alert('スレッドを付ける文字列を選択してください。');
      return;
    }
    beginEdit();
    var texts = collectRangeTextNodes(range);
    if (!texts.length) { endEdit(); return; }
    var selText = String(range.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    var thread = window.Threads.create(selText || '新しいスレッド');
    var tid = thread.tid;
    for (var i = 0; i < texts.length; i++) {
      var w = document.createElement('span');
      w.className = 'thread-ref';
      w.setAttribute('data-tid', tid);
      texts[i].parentNode.insertBefore(w, texts[i]);
      w.appendChild(texts[i]);
    }
    var item = window.Threads.addComment(tid, '');
    endEdit();
    if (window.A11y && window.A11y.announce) window.A11y.announce('スレッドを追加しました');
    renderThreads();
    window.Threads.setActive(tid, 'card');
    var container = threadPanel();
    var input = container && container.querySelector(
      '.thread-card[data-tid="' + tid + '"] .tc-comment .tc-text, ' +
      '.thread-card[data-tid="' + tid + '"] .thread-comment-body');
    if (input && input.focus) {
      input.focus();
    } else {
      // パネルが無い環境(防御): prompt で入力
      var text = window.prompt('コメントを入力してください', '');
      if (text == null || text === '') {
        removeThreadAnchors(tid);
        window.Threads.remove(tid);
        renderThreads();
        return;
      }
      if (item) item.text = text;
      renderThreads();
    }
  }

  // 指定スレッドの本文アンカー(thread-ref)を履歴付きで unwrap(filelink は data-tid を外す)。
  function removeThreadAnchors(tid) {
    var d = doc();
    if (!d || !tid) return;
    beginEdit();
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
    endEdit();
  }

  // threads.js を確実にロード(UI の index.html が読み込んでいなくても動く防御)。
  function ensureThreads() {
    if (window.Threads) { renderThreads(); return; }
    if (document.querySelector('script[data-threads]')) return;
    var th = document.createElement('script');
    th.src = 'js/threads.js';
    th.setAttribute('data-threads', '1');
    th.onload = function () { renderThreads(); };
    (document.head || document.documentElement).appendChild(th);
  }

  /* ================= 文字カウント(フェーズ2) ================= */

  function setTextById(id, value) {
    var el = byId(id);
    if (el) el.textContent = String(value);
  }

  function fillWordCount() {
    var d = doc();
    if (!d) return;
    var text = (d.textContent || '').replace(/​/g, '');
    var noBreak = text.replace(/\n/g, '');
    var charsWithSpaces = noBreak.length;
    var chars = noBreak.replace(/[ \t　]/g, '').length;

    var blocks = d.querySelectorAll('p, h1, h2, h3, blockquote, pre, li, figure, div.math-display');
    var paras = 0;
    var lines = 0;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var hasContent = (b.textContent || '').replace(/[\s​]/g, '') !== '' ||
        (b.querySelector && b.querySelector('img'));
      if (hasContent) paras++;
      var h = b.offsetHeight || 0;
      if (h > 0) {
        var lh = NaN;
        try { lh = parseFloat(window.getComputedStyle(b).lineHeight); } catch (e) { }
        if (!lh || isNaN(lh)) {
          var fs2 = 14;
          try { fs2 = parseFloat(window.getComputedStyle(b).fontSize) || 14; } catch (e2) { }
          lh = fs2 * 1.6;
        }
        lines += Math.max(1, Math.round(h / lh));
      } else if (hasContent) {
        lines += 1;
      }
    }
    var sheets = byId('page-sheets');
    var pages = sheets && sheets.children.length ? sheets.children.length : 1;

    setTextById('wc-pages', pages);
    setTextById('wc-chars', chars);
    setTextById('wc-chars-sp', charsWithSpaces);
    setTextById('wc-paras', paras);
    setTextById('wc-lines', lines);
  }

  /* ================= コマンドディスパッチ ================= */

  var APP_COMMANDS = {
    'new': 1, open: 1, downloadTex: 1, downloadPdf: 1, compile: 1,
    zoom: 1, zoomIn: 1, zoomOut: 1, zoomReset: 1,
    toggleSource: 1, togglePreview: 1, save: 1,
    margin: 1, orientLandscape: 1, orientPortrait: 1, toc: 1,
    /* フェーズ30: レイアウト強化(段組み・用紙・行間・段落間隔・行番号) */
    columns: 1, paper: 1, lineHeight: 1, paraSpace: 1, lineNumbers: 1,
    /* フェーズ2 */
    downloadDocx: 1, openDocx: 1, openProjectFolder: 1, shareLink: 1, sharePdf: 1,
    /* フェーズ3 / 3b */
    newFromTemplate: 1, addSource: 1, saveSource: 1, manageSources: 1,
    importBib: 1, exportBib: 1, insertCite: 1, insertBibliography: 1, bibStyle: 1,
    /* フェーズ3.5: バージョン履歴 / ダークモード */
    versionHistory: 1, restoreVersion: 1, exitVersionView: 1,
    darkMode: 1, darkPage: 1
    /* フェーズ11: docLanguage は exec 内で明示処理(DOM 即時適用 + app.js へ転送) */
  };

  function exec(cmd, value) {
    // フェーズ13b: コメント専用モードでは本文改変コマンドを無効化(announce のみ)
    if (commentOnly && COMMENT_BLOCKED[cmd]) {
      commentOnlyBlocked();
      return;
    }
    switch (cmd) {
      /* 書式 */
      case 'bold': case 'italic': case 'underline': case 'strikethrough':
      case 'subscript': case 'superscript': case 'highlight': case 'foreColor':
        toggleInline(cmd); break;
      case 'fontName': fontName(value); break;
      case 'fontSize': fontSize(value); break;
      case 'growFont': stepFont(1); break;
      case 'shrinkFont': stepFont(-1); break;
      case 'clearFormat': clearFormat(); break;

      /* 段落 */
      case 'alignLeft': applyAlign('left'); break;
      case 'alignCenter': applyAlign('center'); break;
      case 'alignRight': applyAlign('right'); break;
      case 'alignJustify': applyAlign('justify'); break;
      case 'bulletList': toggleList('ul'); break;
      case 'numberList': toggleList('ol'); break;
      case 'indent': indentOutdent(1); break;
      case 'outdent': indentOutdent(-1); break;
      case 'hr': insertHr(); break;

      /* スタイル */
      case 'style': applyStyle(value); break;

      /* 挿入 */
      case 'insertTable': insertTable(value); break;
      case 'insertImage': {
        var input = byId('image-input');
        if (input) input.click();
        break;
      }
      case 'insertLink': insertLink(); break;
      case 'insertMath': insertMath(); break;
      case 'insertDisplayMath': insertDisplayMath(); break;
      case 'insertFootnote': insertFootnote(); break;
      case 'pageBreak': insertPageBreak(); break;
      case 'linkFile': insertFileLink(); break;

      /* 編集 */
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'cut': cmdCut(); break;
      case 'copy': cmdCopy(); break;
      case 'paste': cmdPaste(); break;
      case 'find': cmdFind(); break;
      case 'selectAll': cmdSelectAll(); break;

      /* 校閲(フェーズ2) */
      case 'insertComment': insertComment(); break;
      case 'deleteComment': deleteActiveComment(); break;
      case 'prevComment': stepComment(-1); break;
      case 'nextComment': stepComment(1); break;
      case 'wordCount': fillWordCount(); break;

      /* フェーズ11: 文書言語。DOM(lang/spellcheck)は editor が即時適用し、
         永続化・再コンパイルは app.js へ転送する。 */
      case 'docLanguage':
        applyDocLanguage(value);
        if (window.App && typeof window.App.exec === 'function') window.App.exec('docLanguage', docLang);
        break;

      default:
        if (APP_COMMANDS[cmd] && window.App && typeof window.App.exec === 'function') {
          window.App.exec(cmd, value);
        }
        break;
    }
    updateRibbon();
  }

  /* ================= 初期化 ================= */

  function init() {
    var d = doc();
    if (!d) return;

    prevState = cleanSnapshotHtml(d.innerHTML);

    // フェーズ13b: コメント専用モードでは #doc への直接本文入力を抑止(選択は許可)。
    // beforeinput は本文変更操作のみ発火し、選択変更では発火しないため選択は妨げない。
    d.addEventListener('beforeinput', function (e) {
      if (commentOnly) { e.preventDefault(); }
    });

    d.addEventListener('input', function () {
      ensureNotEmpty();
      scheduleSnapshot();
      updateSheets();
      scheduleCommentRender();
    });

    d.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return; // IME変換中は触らない
      if (commentOnly) {
        // 本文を変える主なキー操作を抑止(コピー/検索等の修飾キー操作は妨げない)
        if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) { handleEnter(e); return; }
      if (e.key === 'Tab') { handleTab(e); return; }
    });

    d.addEventListener('paste', function (e) {
      e.preventDefault();
      if (commentOnly) return; // コメント専用モードでは貼り付け無効
      var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      window.PasteAudit && window.PasteAudit.record(text);
      if (text) insertPlainText(text);
    });

    // 数式クリック編集 / 画像クリックで代替テキスト編集 (フェーズ4)
    d.addEventListener('click', function (e) {
      if (e.target && e.target.nodeName === 'IMG') {
        e.preventDefault();
        editImageAlt(e.target);
        return;
      }
      var t = e.target;
      while (t && t !== d) {
        if (t.nodeType === 1 && t.classList &&
          (t.classList.contains('math-inline') || t.classList.contains('math-display'))) {
          e.preventDefault();
          openMathEditor(t);
          return;
        }
        // フェーズ31: tex-raw ブロックはクリックで展開/折りたたみ
        if (t.nodeType === 1 && t.classList && t.classList.contains('tex-raw')) {
          e.preventDefault();
          toggleTexRaw(t);
          return;
        }
        t = t.parentNode;
      }
    });

    // フェーズ31: tex-raw をダブルクリックで原文編集ダイアログ
    d.addEventListener('dblclick', function (e) {
      var t = e.target;
      while (t && t !== d) {
        if (t.nodeType === 1 && t.classList && t.classList.contains('tex-raw')) {
          e.preventDefault();
          openTexRawEditor(t);
          return;
        }
        t = t.parentNode;
      }
    });

    // ダイアログ外クリックで tex-raw エディタを閉じる
    document.addEventListener('mousedown', function (e) {
      var pop = byId('texraw-editor');
      if (!pop || pop.style.display === 'none') return;
      if (pop.contains(e.target)) return;
      closeTexRawEditor();
    });

    document.addEventListener('mousedown', function (e) {
      var pop = byId('math-editor');
      if (!pop || pop.style.display === 'none') return;
      if (pop.contains(e.target)) return;
      var t = e.target;
      var inMath = false;
      while (t) {
        if (t.nodeType === 1 && t.classList &&
          (t.classList.contains('math-inline') || t.classList.contains('math-display'))) { inMath = true; break; }
        t = t.parentNode;
      }
      if (!inMath) closeMathEditor();
    });

    // キーバインド
    document.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      var key = e.key.toLowerCase();
      if (key === 's') { e.preventDefault(); exec('save'); return; }
      // 以降は選択がエディタ内にある時だけ
      var sel = window.getSelection();
      var inDoc = sel && sel.anchorNode && d.contains(sel.anchorNode);
      var active = document.activeElement === d || d.contains(document.activeElement);
      if (!inDoc && !active) return;
      if (key === 'b') { e.preventDefault(); exec('bold'); }
      else if (key === 'i') { e.preventDefault(); exec('italic'); }
      else if (key === 'u') { e.preventDefault(); exec('underline'); }
      else if (key === 'z') { e.preventDefault(); if (e.shiftKey) exec('redo'); else exec('undo'); }
      else if (key === 'y') { e.preventDefault(); exec('redo'); }
    });

    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (sel && sel.anchorNode && d.contains(sel.anchorNode)) {
        updateRibbon();
        updateStatusbar(Math.max(1, byId('page-sheets') ? byId('page-sheets').children.length : 1));
      }
    });

    // フェーズ11: 起動時に文書言語(既定 ja)を #doc へ適用(ja は spellcheck=false で現状維持)
    applyDocLanguage(docLang);

    setupImageInput();
    initComments();

    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () { updateSheets(); });
      ro.observe(d);
    }
    window.addEventListener('resize', updateSheets);

    ensureNotEmpty();
    updateAll();

    // フェーズ15: filelink.js を確実にロードする(index.html が読み込んでいなくても
    // 動くよう防御。二重ロードは filelink.js 側が window.FileLink で弾く)。
    if (!window.FileLink && !document.querySelector('script[data-filelink]')) {
      var fl = document.createElement('script');
      fl.src = 'js/filelink.js';
      fl.setAttribute('data-filelink', '1');
      document.head.appendChild(fl);
    }

    // フェーズ17: スレッド(threads.js)を確実にロードし、旧コメントを移行・描画する。
    ensureThreads();

    // フェーズ22: 数式 MathML 化 + 脚注/引用アンカーの SR 属性付与。
    //  app.js が #doc.innerHTML を差し替える文書ロード経路(Editor 外)も拾うため、
    //  #doc を MutationObserver で監視して再描画する(冪等なので入力中も安全)。
    renderAllMath(d);
    decorateAnchors(d);
    renderTexRaw(d);
    if (typeof MutationObserver !== 'undefined') {
      var mathTimer = null;
      var mo = new MutationObserver(function () {
        if (mathTimer) clearTimeout(mathTimer);
        mathTimer = setTimeout(function () {
          renderAllMath(d);
          decorateAnchors(d);
          renderTexRaw(d);
        }, 200);
      });
      mo.observe(d, { childList: true, subtree: true });
    }

    // 脚注 / 引用 / ファイルリンクのキーボード操作: Enter / Space で既存クリック動線を発火。
    //  thread-ref / filelink[data-tid](スレッド系)は threads.js が担当するため除外。
    d.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var t = e.target;
      while (t && t !== d && t.nodeType === 1) {
        // フェーズ31: tex-raw ブロックは Enter/Space で展開、インラインは編集ダイアログ
        if (t.classList && t.classList.contains('tex-raw')) {
          e.preventDefault();
          if (t.tagName === 'DIV') toggleTexRaw(t); else openTexRawEditor(t);
          return;
        }
        if (t.classList && (t.classList.contains('footnote') || t.classList.contains('cite') ||
          (t.classList.contains('filelink') && !t.getAttribute('data-tid')) ||
          t.classList.contains('math-inline') || t.classList.contains('math-display'))) {
          e.preventDefault();
          t.click();
          return;
        }
        t = t.parentNode;
      }
    });
  }

  window.Editor = {
    exec: exec,
    getState: computeState,
    // app.js から利用する補助 API
    refresh: updateAll,
    resetHistory: function () {
      undoStack.length = 0;
      redoStack.length = 0;
      prevState = snapshot();
    },
    renumberFootnotes: renumberFootnotes,
    /* フェーズ22: 数式 MathML 化 / アンカー SR 属性(通常は MutationObserver が自動実行) */
    renderMath: renderAllMath,
    decorateAnchors: decorateAnchors,
    /* フェーズ31: tex-raw(原文温存)チップ描画 */
    renderTexRaw: renderTexRaw,
    /* フェーズ2: コメント / 文字カウント */
    getComments: function () {
      var out = {};
      var cids = presentCids();
      for (var i = 0; i < cids.length; i++) out[cids[i]] = comments[cids[i]].text || '';
      return out;
    },
    clearComments: function () {
      comments = {};
      activeCid = null;
      saveComments();
      renderComments();
    },
    renderComments: renderComments,
    fillWordCount: fillWordCount,
    /* フェーズ3: 複数文書ストア連携(app.js が文書切替時に使用) */
    getCommentMap: function () {
      // 現在 #doc に存在する comment-ref の cid のみ、text+time を返す
      var out = {};
      var cids = presentCids();
      for (var i = 0; i < cids.length; i++) {
        out[cids[i]] = { text: comments[cids[i]].text || '', time: comments[cids[i]].time || Date.now() };
      }
      return out;
    },
    setComments: function (obj) {
      comments = {};
      commentSeq = 0;
      activeCid = null;
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach(function (cid) {
          var v = obj[cid];
          if (v && typeof v === 'object') {
            comments[cid] = { text: String(v.text || ''), time: Number(v.time) || Date.now() };
          } else if (typeof v === 'string') {
            comments[cid] = { text: v, time: Date.now() };
          }
          var m = /^c(\d+)$/.exec(cid);
          if (m) commentSeq = Math.max(commentSeq, parseInt(m[1], 10));
        });
      }
      saveComments();
      renderComments();
    },
    /* フェーズ3b: 引用 / 文献目録の挿入(app.js から呼ぶ) */
    insertCite: insertCite,
    insertBibliographyBlock: insertBibliographyBlock,
    /* フェーズ11: 文書言語(app.js が文書切替・永続化時に使用) */
    setDocLanguage: applyDocLanguage,
    getDocLanguage: function () { return docLang; },
    /* フェーズ13b: コメント専用モード(collab.js のゲスト permission=comment で使用) */
    setCommentOnlyMode: function (on) { commentOnly = !!on; },
    isCommentOnlyMode: function () { return commentOnly; },
    /* フェーズ15: 本文→ファイルリンク。filelink.js のドラッグ&ドロップ受け口。
       キャレット位置(ドロップ位置)に filelink を挿入する。commentOnly では拒否。 */
    insertFileLink: function (path, label, loc, tid) {
      return insertFileLinkElement(path, label || (path ? String(path).split('/').pop() : ''),
        loc == null ? '' : loc, null, tid);
    },
    /* フェーズ17: スレッド連携。app.js / threads.js から利用する。 */
    renderThreads: renderThreads,
    removeThreadAnchors: removeThreadAnchors,
    insertThread: insertThread,
    createThreadFromRange: createThreadFromRange
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
