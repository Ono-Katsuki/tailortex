/* latex.js — DOM → LaTeX 変換エンジン (window.LatexGen)
 * 純粋関数として実装。DOM API のうち nodeType / nodeName / childNodes /
 * getAttribute / nodeValue のみに依存する(Node での単体テスト可能)。
 */
(function (global) {
  'use strict';

  /* ---------- 基本ヘルパ ---------- */

  function isText(n) { return !!n && n.nodeType === 3; }
  function isElem(n) { return !!n && n.nodeType === 1; }
  function tag(n) { return (n && n.nodeName ? String(n.nodeName) : '').toUpperCase(); }

  function attr(n, name) {
    if (n && typeof n.getAttribute === 'function') {
      var v = n.getAttribute(name);
      return v == null ? null : String(v);
    }
    return null;
  }

  function classes(n) {
    var c = attr(n, 'class');
    return c ? c.split(/\s+/) : [];
  }

  function hasClass(n, cls) { return classes(n).indexOf(cls) !== -1; }

  function children(n) {
    var out = [];
    var list = n && n.childNodes ? n.childNodes : [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function textOf(n) {
    if (isText(n)) return n.nodeValue == null ? '' : String(n.nodeValue);
    var s = '';
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) s += textOf(kids[i]);
    return s;
  }

  function textAlignOf(n) {
    var st = attr(n, 'style') || '';
    var m = st.match(/text-align\s*:\s*(left|center|right|justify)/i);
    return m ? m[1].toLowerCase() : '';
  }

  /* ---------- エスケープ ---------- */

  // \ を最初に退避してから # $ % & _ { } ~ ^ を処理する
  function escapeLatex(s) {
    return String(s)
      .replace(/\\/g, '\u0000')
      .replace(/([#$%&_{}])/g, '\\$1')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/\u0000/g, '\\textbackslash{}');
  }

  function escapeUrl(s) {
    return String(s).replace(/([%#{}\\])/g, '\\$1');
  }

  // hyperref の pdftitle 用。制御文字・波括弧・バックスラッシュを無害化する。
  // (LuaLaTeX + hyperref は UTF-8 をそのまま扱えるため日本語はエスケープ不要)
  function pdfMetaSanitize(s) {
    return String(s == null ? '' : s)
      .replace(/[\\{}]/g, ' ')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- 画像 ---------- */

  var DATA_IMG_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/;

  function extForMime(sub) {
    sub = String(sub).toLowerCase();
    if (sub === 'jpeg' || sub === 'jpg') return 'jpg';
    if (sub === 'png') return 'png';
    if (sub === 'pdf') return 'pdf';
    return null; // gif/webp 等は xelatex 非対応(editor.js 側で png に変換する前提)
  }

  function imageLatex(n, ctx) {
    var src = attr(n, 'src') || '';
    var m = src.match(DATA_IMG_RE);
    if (m) {
      var ext = extForMime(m[1]);
      if (ext) {
        ctx.imgIndex++;
        // \WLimg = 幅が \linewidth を超えるときだけ縮小(上限つき includegraphics)
        return '\\WLimg{img' + ctx.imgIndex + '.' + ext + '}';
      }
    }
    return '\\textit{[' + escapeLatex('画像') + ']}';
  }

  /* ---------- インライン変換 ---------- */

  function inlineChildren(n, ctx) {
    var out = '';
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) out += inlineNode(kids[i], ctx);
    return out;
  }

  // thread-ref の \todo に載せるテキスト(スレッドの comment を連結)を得る。
  // 優先: opts.threads マップ({tid: text})。無ければ global.Threads から取得。
  function threadTodoText(tid, ctx) {
    if (ctx.threads && Object.prototype.hasOwnProperty.call(ctx.threads, tid)) {
      return String(ctx.threads[tid] || '');
    }
    var T = global.Threads;
    if (T && typeof T.get === 'function') {
      var th = T.get(tid);
      if (th && th.items) {
        var parts = [];
        for (var i = 0; i < th.items.length; i++) {
          var it = th.items[i];
          if (it && it.type === 'comment' && it.text) parts.push(it.text);
        }
        return parts.join(' / ');
      }
    }
    return '';
  }

  function inlineNode(n, ctx) {
    if (isText(n)) return escapeLatex(n.nodeValue || '');
    if (!isElem(n)) return '';
    var t = tag(n);

    if (t === 'SPAN') {
      if (hasClass(n, 'tex-raw')) {
        // フェーズ31: インライン tex パススルー。原文(data-tex-raw)をそのまま出力する。
        // getAttribute はブラウザ側で HTML 実体参照を復号済みの生 LaTeX を返す。
        var rawI = attr(n, 'data-tex-raw');
        return rawI == null ? '' : String(rawI);
      }
      if (hasClass(n, 'thread-ref')) {
        // フェーズ17: スレッド参照。本文はそのまま出力する。
        // 作業用(finalOutput=false): スレッドの comment を最初の出現直後に \todo で置く。
        // 最終成果物(finalOutput=true): 注釈は一切出さず本文テキストのみ残す。
        var innerT = inlineChildren(n, ctx);
        if (ctx.finalOutput) return innerT;
        var tid = attr(n, 'data-tid');
        if (tid && !ctx.todoDone['T:' + tid]) {
          var todoText = threadTodoText(tid, ctx);
          if (todoText) {
            ctx.todoDone['T:' + tid] = true;
            ctx.todoCount++;
            return innerT + '\\todo[size=\\tiny]{' + escapeLatex(todoText) + '}';
          }
        }
        return innerT;
      }
      if (hasClass(n, 'comment-ref')) {
        // フェーズ2: コメント参照(後方互換)。本文はそのまま出力し、最初の出現直後に \todo を置く
        var innerRef = inlineChildren(n, ctx);
        var cid = attr(n, 'data-cid');
        if (cid && ctx.comments &&
          Object.prototype.hasOwnProperty.call(ctx.comments, cid) && !ctx.todoDone[cid]) {
          ctx.todoDone[cid] = true;
          ctx.todoCount++;
          return innerRef + '\\todo[size=\\tiny]{' + escapeLatex(String(ctx.comments[cid])) + '}';
        }
        return innerRef;
      }
      if (hasClass(n, 'cite')) {
        // フェーズ3b: 引用。data-key="key1,key2" → \cite{key1,key2}
        var keys = String(attr(n, 'data-key') || '')
          .split(',').map(function (k) { return k.trim(); })
          .filter(function (k) { return !!k; }).join(',');
        return keys ? '\\cite{' + keys + '}' : '';
      }
      if (hasClass(n, 'math-inline')) {
        var tex = attr(n, 'data-tex');
        if (tex == null || tex === '') tex = textOf(n);
        return String(tex).trim() ? '$' + tex + '$' : '';
      }
      if (hasClass(n, 'footnote')) {
        return '\\footnote{' + escapeLatex(attr(n, 'data-note') || '') + '}';
      }
      if (hasClass(n, 'filelink')) {
        // フェーズ15: 本文→ファイルへの作業リンク。既定では PDF に出力しない(無視)。
        // options.includeFileLinks が真なら ラベル + \footnote{参照: <path>} を出す(将来用)。
        if (ctx.includeFileLinks) {
          var flPath = attr(n, 'data-path') || '';
          var flLoc = attr(n, 'data-loc') || '';
          var flRef = flPath + (flLoc ? ' ' + flLoc : '');
          return inlineChildren(n, ctx) + '\\footnote{' + escapeLatex('参照: ' + flRef) + '}';
        }
        return '';
      }
      if (hasClass(n, 'hl')) return '\\colorbox{yellow}{' + inlineChildren(n, ctx) + '}';
      if (hasClass(n, 'fc')) return '\\textcolor{red}{' + inlineChildren(n, ctx) + '}';
      if (hasClass(n, 'ff-sans')) return '\\textsf{' + inlineChildren(n, ctx) + '}';
      if (hasClass(n, 'ff-mono')) return '\\texttt{' + inlineChildren(n, ctx) + '}';
      if (hasClass(n, 'ff-serif')) return '\\textrm{' + inlineChildren(n, ctx) + '}';
      if (hasClass(n, 'fs')) {
        var pt = parseFloat(attr(n, 'data-pt'));
        if (!pt || pt <= 0) pt = 10.5;
        var lh = Math.round(pt * 1.4 * 10) / 10;
        return '{\\fontsize{' + pt + '}{' + lh + '}\\selectfont ' + inlineChildren(n, ctx) + '}';
      }
      return inlineChildren(n, ctx);
    }

    switch (t) {
      case 'STRONG': case 'B': return '\\textbf{' + inlineChildren(n, ctx) + '}';
      case 'EM': case 'I': return '\\textit{' + inlineChildren(n, ctx) + '}';
      // 下線・取り消し線: CJK 言語(ja/zh/ko)の通常出力では xeCJKfntef の
      // \CJKunderline/\CJKsout を使う。欧文言語(en/de/fr/es、xeCJK 非使用)や
      // accessible(LuaLaTeX、xeCJKfntef 非対応)モードでは ulem の \uline/\sout
      // を使う(日本語でも動作し veraPDF PDF/UA-2 PASS を実測確認済み)。
      case 'U': return ((ctx.accessible || !ctx.cjk) ? '\\uline{' : '\\CJKunderline{') + inlineChildren(n, ctx) + '}';
      case 'S': case 'STRIKE': case 'DEL':
        return ((ctx.accessible || !ctx.cjk) ? '\\sout{' : '\\CJKsout{') + inlineChildren(n, ctx) + '}';
      case 'SUB': return '\\textsubscript{' + inlineChildren(n, ctx) + '}';
      case 'SUP': return '\\textsuperscript{' + inlineChildren(n, ctx) + '}';
      case 'A': {
        var href = attr(n, 'href');
        var inner = inlineChildren(n, ctx);
        return href ? '\\href{' + escapeUrl(href) + '}{' + inner + '}' : inner;
      }
      case 'BR': return '\\\\\n';
      case 'IMG': return imageLatex(n, ctx);
      default: return inlineChildren(n, ctx);
    }
  }

  // 段落先頭/末尾の強制改行 (\\) は "There's no line here to end" になるので除去
  function cleanupPara(s) {
    return String(s)
      .replace(/^(\s*\\\\\s*)+/, '')
      .replace(/(\s*\\\\\s*)+$/, '');
  }

  /* ---------- ブロック変換 ---------- */

  var BLOCK_TAGS_RE = /^(P|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|DIV|HR)$/;

  function hasBlockChild(n) {
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      if (isElem(kids[i]) && BLOCK_TAGS_RE.test(tag(kids[i]))) return true;
    }
    return false;
  }

  // 中央寄せブロック。accessible(tagpdf phase-III)モードでは center 環境が
  // text-unit para フックの不整合を招くため、{\centering ...\par} グループで包む。
  function centerBlock(content, ctx) {
    if (ctx && ctx.accessible) return '{\\centering ' + content + '\\par}';
    return '\\begin{center}\n' + content + '\n\\end{center}';
  }

  function wrapAlign(content, align, ctx) {
    if (!String(content).trim()) return content;
    if (ctx && ctx.accessible) {
      if (align === 'center') return '{\\centering ' + content + '\\par}';
      if (align === 'right') return '{\\raggedleft ' + content + '\\par}';
      if (align === 'left') return '{\\raggedright ' + content + '\\par}';
      return content;
    }
    if (align === 'center') return '\\begin{center}\n' + content + '\n\\end{center}';
    if (align === 'right') return '\\begin{flushright}\n' + content + '\n\\end{flushright}';
    if (align === 'left') return '\\begin{flushleft}\n' + content + '\n\\end{flushleft}';
    return content;
  }

  function blocksOf(nodes, ctx) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) out += blockNode(nodes[i], ctx);
    return out;
  }

  function blockNode(n, ctx) {
    if (isText(n)) {
      var raw = n.nodeValue || '';
      return raw.trim() ? escapeLatex(raw.trim()) + '\n\n' : '';
    }
    if (!isElem(n)) return '';
    var name = tag(n);

    switch (name) {
      case 'H1': return '\\section{' + cleanupPara(inlineChildren(n, ctx)) + '}\n\n';
      case 'H2': return '\\subsection{' + cleanupPara(inlineChildren(n, ctx)) + '}\n\n';
      case 'H3': return '\\subsubsection{' + cleanupPara(inlineChildren(n, ctx)) + '}\n\n';

      case 'P': {
        if (hasClass(n, 'title')) {
          return centerBlock('{\\Huge\\bfseries ' + cleanupPara(inlineChildren(n, ctx)) + '}', ctx) + '\n\n';
        }
        if (hasClass(n, 'subtitle')) {
          return centerBlock('{\\Large\\itshape ' + cleanupPara(inlineChildren(n, ctx)) + '}', ctx) + '\n\n';
        }
        var content = cleanupPara(inlineChildren(n, ctx));
        if (!content.trim()) {
          // 空段落は Word の空行と同様に 1 行分の高さを残す
          return '\\par\\vspace{\\baselineskip}\n\n';
        }
        return wrapAlign(content, textAlignOf(n), ctx) + '\n\n';
      }

      case 'BLOCKQUOTE': {
        var inner = hasBlockChild(n)
          ? blocksOf(children(n), ctx)
          : cleanupPara(inlineChildren(n, ctx)) + '\n';
        return '\\begin{quote}\n' + inner + '\\end{quote}\n\n';
      }

      case 'PRE': {
        var code = textOf(n).replace(/\\end\{verbatim\}/g, '\\end {verbatim}');
        code = code.replace(/\n+$/, '');
        return '\\begin{verbatim}\n' + code + '\n\\end{verbatim}\n\n';
      }

      case 'UL':
      case 'OL':
        return listLatex(n, ctx, 1) + '\n';

      case 'TABLE': return tableLatex(n, ctx);
      case 'FIGURE': return figureLatex(n, ctx);
      case 'IMG': return centerBlock(imageLatex(n, ctx), ctx) + '\n\n';
      case 'HR': return '\\noindent\\rule{\\linewidth}{0.4pt}\n\n';

      case 'DIV': {
        if (hasClass(n, 'tex-preamble')) {
          // フェーズ31: 温存プリアンブルの保管ノード。本文には一切出力しない
          //   (プリアンブルは generate() が opts.customPreamble として組み立てる)。
          return '';
        }
        if (hasClass(n, 'tex-raw')) {
          // フェーズ31: ブロック tex パススルー。原文(data-tex-raw)をそのまま本文位置へ。
          var rawB = attr(n, 'data-tex-raw');
          rawB = rawB == null ? '' : String(rawB);
          return rawB.trim() ? rawB + '\n\n' : '';
        }
        if (hasClass(n, 'bibliography')) {
          // フェーズ3b: 文献目録ブロック。この位置に \bibliographystyle + \bibliography を出す
          ctx.hasBib = true;
          return '\\bibliographystyle{' + ctx.bibStyle + '}\n\\bibliography{refs}\n\n';
        }
        if (hasClass(n, 'page-break')) return '\\newpage\n\n';
        if (hasClass(n, 'math-display')) {
          var tex = attr(n, 'data-tex');
          if (tex == null || tex === '') tex = textOf(n);
          if (!String(tex).trim()) return '';
          return '\\begin{equation}\n' + tex + '\n\\end{equation}\n\n';
        }
        if (hasBlockChild(n)) return blocksOf(children(n), ctx);
        var dc = cleanupPara(inlineChildren(n, ctx));
        return dc.trim() ? wrapAlign(dc, textAlignOf(n), ctx) + '\n\n' : '';
      }

      default: {
        if (hasBlockChild(n)) return blocksOf(children(n), ctx);
        var c = cleanupPara(inlineChildren(n, ctx));
        return c.trim() ? c + '\n\n' : '';
      }
    }
  }

  /* ---------- リスト ---------- */

  function listLatex(n, ctx, depth) {
    // itemize は 4 段、enumerate は 4 段まで。深すぎるネストはクランプ
    var env = tag(n) === 'OL' ? 'enumerate' : 'itemize';
    if (depth > 4) {
      // これ以上ネストできないので同じ深さで出す
      depth = 4;
    }
    var out = '\\begin{' + env + '}\n';
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isElem(kid) && tag(kid) === 'LI') {
        var itemInline = '';
        var nested = '';
        var lk = children(kid);
        for (var j = 0; j < lk.length; j++) {
          var c = lk[j];
          if (isElem(c) && (tag(c) === 'UL' || tag(c) === 'OL')) {
            nested += listLatex(c, ctx, depth + 1);
          } else {
            itemInline += inlineNode(c, ctx);
          }
        }
        itemInline = cleanupPara(itemInline);
        out += '\\item ' + (itemInline.trim() ? itemInline : '~') + '\n';
        if (nested) out += nested;
      } else if (isElem(kid) && (tag(kid) === 'UL' || tag(kid) === 'OL')) {
        out += listLatex(kid, ctx, depth + 1);
      }
    }
    out += '\\end{' + env + '}\n';
    return out;
  }

  /* ---------- 表 ---------- */

  function collectRows(n, rows) {
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (!isElem(kid)) continue;
      var t = tag(kid);
      if (t === 'TR') rows.push(kid);
      else if (t === 'TBODY' || t === 'THEAD' || t === 'TFOOT') collectRows(kid, rows);
    }
  }

  function tableLatex(n, ctx) {
    var rows = [];
    collectRows(n, rows);
    if (!rows.length) return '';
    ctx.hasTable = true;

    var rowCells = [];
    var cols = 0;
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      var kids = children(rows[i]);
      for (var j = 0; j < kids.length; j++) {
        if (isElem(kids[j]) && (tag(kids[j]) === 'TD' || tag(kids[j]) === 'TH')) cells.push(kids[j]);
      }
      if (cells.length > cols) cols = cells.length;
      rowCells.push(cells);
    }
    if (!cols) return '';

    var spec = '|' + new Array(cols + 1).join('l|');
    // フェーズ30: 2段組(twocolumn)では列数の多い幅広の表は 1段の桁に収まらないため、
    // table*(2段幅にまたがるフロート)で配置する。狭い表は従来どおり段内 center。
    var wideFloat = ctx.twocol && !ctx.accessible && cols >= 4;
    // accessible モードでは center 環境ではなく table フロート+\centering を使う
    // (center 環境は tagpdf の para フック不整合を招くため。TH タグ付けは
    //  プリアンブルの \AddToHook{env/tabular/begin}{...header-rows=1} が担う)
    var open = ctx.accessible
      ? '\\begin{table}\n\\centering\n\\begin{tabular}{' + spec + '}\n\\hline\n'
      : wideFloat
        ? '\\begin{table*}[t]\n\\centering\n\\begin{tabular}{' + spec + '}\n\\hline\n'
        : '\\begin{center}\n\\begin{tabular}{' + spec + '}\n\\hline\n';
    var out = open;
    for (var r = 0; r < rowCells.length; r++) {
      var parts = [];
      for (var cIdx = 0; cIdx < cols; cIdx++) {
        var cell = rowCells[r][cIdx];
        parts.push(cell ? cleanupPara(inlineChildren(cell, ctx)).replace(/\n+/g, ' ').trim() : '');
      }
      out += parts.join(' & ') + ' \\\\ \\hline\n';
    }
    out += ctx.accessible
      ? '\\end{tabular}\n\\end{table}\n\n'
      : wideFloat
        ? '\\end{tabular}\n\\end{table*}\n\n'
        : '\\end{tabular}\n\\end{center}\n\n';
    return out;
  }

  /* ---------- 図 ---------- */

  function findFirst(n, tagName) {
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isElem(kid)) {
        if (tag(kid) === tagName) return kid;
        var found = findFirst(kid, tagName);
        if (found) return found;
      }
    }
    return null;
  }

  function figureLatex(n, ctx) {
    var img = findFirst(n, 'IMG');
    var cap = findFirst(n, 'FIGCAPTION');
    if (!img && !cap) return '';
    var inner = '';
    if (img) inner += imageLatex(img, ctx) + '\n';
    if (cap) {
      var capText = cleanupPara(inlineChildren(cap, ctx));
      if (capText.trim()) inner += '\\par ' + capText + '\n';
    }
    if (ctx.accessible) return '{\\centering ' + inner + '\\par}\n\n';
    return '\\begin{center}\n' + inner + '\\end{center}\n\n';
  }

  /* ---------- 生成本体 ---------- */

  var MARGINS = {
    normal: 'top=30mm,bottom=30mm,left=25mm,right=25mm',
    narrow: 'margin=12.7mm',
    wide: 'top=25.4mm,bottom=25.4mm,left=50.8mm,right=50.8mm'
  };

  /* ---------- フェーズ30: 用紙サイズ / 段組み / 行間 ----------
   * すべて既定値(a4 / 1段 / 1.15 / 段落間隔なし / 行番号なし)では追加出力ゼロ
   * = 従来 tex と完全一致(回帰防止の要)。 */
  var PAPERS = { a4: 'a4paper', b5: 'b5paper', letter: 'letterpaper' };
  // 行間: 既定 '1.15' は「出力しない」= 従来どおり(LaTeX 既定行送り)。他値のみ baselinestretch。
  var LINESPREADS = { '1.0': '1', '1.5': '1.5', '2.0': '2' };

  function normColumns(v) {
    return (v === 'two' || v === 'three' || v === 'rule2') ? v : 'one';
  }

  /* ---------- 言語別組版設定(フェーズ11)----------
   * 通常出力(XeLaTeX)向けの言語ごとのクラス/プリアンブル指定。
   *   cjk:  真なら xeCJK/xeCJKfntef を使う CJK 組版(下線・取消線が CJK コマンド)
   *   klass: 'ja' は現行 bxjsarticle、'cjk' は article+xeCJK、'latin' は article+polyglossia
   *   cjkfont: xeCJK の \setCJKmainfont 行(\IfFontExistsTF で実在フォントにフォールバック)
   *   poly:  polyglossia の言語名(欧文言語のハイフネーション)
   *   bcp47: accessible(PDF/UA)用の言語タグ
   * フォントは実機で存在確認済み: Songti SC/TC, Apple SD Gothic Neo, Hiragino Sans GB。
   */
  var LANGS = {
    'ja': { cjk: true, klass: 'ja', bcp47: 'ja' },
    'zh-Hans': {
      cjk: true, klass: 'cjk', bcp47: 'zh-Hans',
      cjkfont: '\\IfFontExistsTF{Songti SC}{\\setCJKmainfont{Songti SC}}{\\setCJKmainfont{Hiragino Sans GB}}'
    },
    'zh-Hant': {
      cjk: true, klass: 'cjk', bcp47: 'zh-Hant',
      cjkfont: '\\IfFontExistsTF{Songti TC}{\\setCJKmainfont{Songti TC}}{\\IfFontExistsTF{Songti SC}{\\setCJKmainfont{Songti SC}}{\\setCJKmainfont{Hiragino Sans GB}}}'
    },
    'ko': {
      cjk: true, klass: 'cjk', bcp47: 'ko',
      cjkfont: '\\setCJKmainfont{Apple SD Gothic Neo}'
    },
    'en': { cjk: false, klass: 'latin', poly: 'english', bcp47: 'en' },
    'de': { cjk: false, klass: 'latin', poly: 'german', bcp47: 'de' },
    'fr': { cjk: false, klass: 'latin', poly: 'french', bcp47: 'fr' },
    'es': { cjk: false, klass: 'latin', poly: 'spanish', bcp47: 'es' }
  };

  // 言語コードを正規化(未知・未指定は ja=現行完全維持で後方互換)
  function normalizeLang(code) {
    var c = String(code == null ? '' : code);
    if (Object.prototype.hasOwnProperty.call(LANGS, c)) return c;
    // よくある別表記の吸収
    var low = c.toLowerCase();
    if (low === 'zh' || low === 'zh-cn' || low === 'zh-sg' || low === 'zh-hans') return 'zh-Hans';
    if (low === 'zh-tw' || low === 'zh-hk' || low === 'zh-mo' || low === 'zh-hant') return 'zh-Hant';
    var base = low.split(/[-_]/)[0];
    if (Object.prototype.hasOwnProperty.call(LANGS, base)) return base;
    return 'ja';
  }

  // フェーズ27: 生成マーカー。main.tex 冒頭に必ず入れる。app.js の上書き保護は
  //   このマーカーの有無で「エディタ生成 tex(=上書き可)」と「手書き tex(=保護)」を判別する。
  var GEN_MARKER = '% Generated by TailorTeX';

  function generate(docEl, options) {
    var opts = options || {};
    var geo = (MARGINS[opts.margin] || MARGINS.normal) + (opts.landscape ? ',landscape' : '');
    // フェーズ30: 用紙サイズ(既定 a4paper = 従来文字列と一致)
    var paperOpt = PAPERS[opts.paper] || 'a4paper';
    // opts.comments: {cid: コメント本文}(フェーズ2、省略可 = 後方互換)
    // opts.bibStyle: 文献目録スタイル(フェーズ3b、省略可 = 'plain')
    var bibStyle = (opts.bibStyle && /^[A-Za-z][\w-]*$/.test(opts.bibStyle)) ? opts.bibStyle : 'plain';
    // opts.language: 文書言語(フェーズ11、省略時 ja=現行完全維持で後方互換)。
    var language = normalizeLang(opts.language);
    // opts.accessible: {lang, title} が渡されたら PDF/UA-2 用のアクセシブル構成で
    // 出力する(省略時は従来どおり = 後方互換)。accessible は LuaLaTeX で処理される。
    var acc = opts.accessible || null;
    // accessible の言語: acc.lang を優先、無ければ文書言語(後方互換: 未指定=ja)。
    var accLang = acc ? normalizeLang(acc.lang != null ? acc.lang : opts.language) : language;
    // accessible(LuaLaTeX)は ja(luatexja)と欧文(article)のみタグ付け組版できる。
    // zh/ko の CJK は xeCJK が XeTeX 専用のため accessible では組版不可 →
    // accessible を無効化して当該言語の通常出力(XeLaTeX)にフォールバックする。
    var accSupported = !acc || accLang === 'ja' || !LANGS[accLang].cjk;
    var useAcc = !!acc && accSupported;
    if (acc && !accSupported) language = accLang; // 非対応なら通常出力を当該言語で
    var effLang = useAcc ? accLang : language;
    var effCfg = LANGS[effLang] || LANGS.ja;

    // フェーズ30: 段組み・行間・段落間隔・行番号。
    // 段組みの2段は documentclass の twocolumn(学会標準)、3段/境界線つきは multicol。
    // アクセシブルPDF(tagging)では multicol はタグ構造が未サポートのため 1段へフォールバック。
    var colMode = normColumns(opts.columns);
    var mcModes = (colMode === 'three' || colMode === 'rule2');
    if (useAcc && mcModes) { colMode = 'one'; mcModes = false; } // 1段フォールバック
    var twocol = (colMode === 'two');
    var mcN = colMode === 'three' ? 3 : (colMode === 'rule2' ? 2 : 0);
    var mcRule = (colMode === 'rule2');
    var classExtra = twocol ? ',twocolumn' : '';
    var lineSpread = LINESPREADS[String(opts.lineHeight)]; // 既定 1.15 は undefined = 出力なし
    var paraSpace = !!opts.paraSpace;
    var lineNumbers = !!opts.lineNumbers && !useAcc; // 行番号は通常出力のみ
    // \begin{document} 直前へ挿入する追加プリアンブル(既定では空 = 従来と一致)
    var extraPre = [];
    if (mcN) extraPre.push('\\usepackage{multicol}');
    if (mcRule) extraPre.push('\\setlength{\\columnseprule}{0.4pt}');
    if (lineSpread) extraPre.push('\\renewcommand{\\baselinestretch}{' + lineSpread + '}');
    if (paraSpace) {
      extraPre.push('\\setlength{\\parskip}{6pt plus 2pt minus 1pt}');
      extraPre.push('\\setlength{\\parindent}{0pt}');
    }
    if (lineNumbers) { extraPre.push('\\usepackage{lineno}'); extraPre.push('\\linenumbers'); }

    // フェーズ15: 出力モード。finalOutput=true(最終成果物)では作業用の注釈
    // (コメント→\todo、todonotes、ファイルリンク)を一切出さない。
    var finalOutput = !!opts.finalOutput;
    var ctx = {
      imgIndex: 0,
      // 最終成果物ではコメント(\todo)を出さないため comments を無視する
      comments: finalOutput ? null : (opts.comments || null),
      // フェーズ17: thread-ref の \todo テキスト源({tid: text})。最終成果物では無視。
      threads: finalOutput ? null : (opts.threads || null),
      todoDone: {}, todoCount: 0,
      bibStyle: bibStyle, hasBib: false,
      accessible: useAcc, accLang: accLang, cjk: effCfg.cjk, hasTable: false,
      // フェーズ30: 2段組(twocolumn)では幅広の表を table* で2段幅に配置する判断に使う
      twocol: twocol,
      // filelink を \footnote 化するか(既定 false = PDF に出さない)。
      // 最終成果物ではファイルリンクも完全に無視する。
      includeFileLinks: !finalOutput && !!opts.includeFileLinks,
      finalOutput: finalOutput
    };
    var body = docEl ? blocksOf(children(docEl), ctx) : '';

    // \WLimg = 幅が \linewidth を超えるときだけ縮小(共通マクロ)
    var WLIMG = [
      '\\newsavebox\\WLimgbox',
      '\\newcommand{\\WLimg}[1]{\\sbox\\WLimgbox{\\includegraphics{#1}}%',
      '\\ifdim\\wd\\WLimgbox>\\linewidth \\includegraphics[width=\\linewidth]{#1}\\else \\usebox\\WLimgbox\\fi}'
    ];
    // 最終成果物ではコメントを出さないので todonotes も読み込まない
    var TODO = (!finalOutput && ctx.todoCount > 0) ? '\\usepackage[textwidth=25mm]{todonotes}' : null;

    // フェーズ31: 元プリアンブル温存モード。opts.customPreamble(\documentclass〜
    //   \begin{document} 直前まで)があり usePreamble!==false なら、生成側のクラス/
    //   パッケージ出力を一切行わず、元プリアンブル + \begin{document} + 生成本文 +
    //   \end{document} を出す。生成本文が依存する最小コマンド(\WLimg・todonotes)は
    //   本文が実際に使う場合のみ注入する(元プリアンブルを汚さない)。
    if (opts.customPreamble && opts.usePreamble !== false) {
      var pre = String(opts.customPreamble).replace(/\s+$/, '');
      var injected = [];
      if (ctx.imgIndex > 0) {
        if (!/\\usepackage(\[[^\]]*\])?\{graphicx\}/.test(pre)) injected.push('\\usepackage{graphicx}');
        injected.push(WLIMG[0], WLIMG[1], WLIMG[2]);
      }
      if (TODO && !/\\usepackage(\[[^\]]*\])?\{todonotes\}/.test(pre)) injected.push(TODO);
      var cbody = body.replace(/\n{3,}/g, '\n\n');
      var out = GEN_MARKER + '\n' + pre + '\n';
      if (injected.length) out += injected.join('\n') + '\n';
      out += '\\begin{document}\n\n' + cbody + '\\end{document}\n';
      return out;
    }

    function assemble(head) {
      // フェーズ30: レイアウト用プリアンブル行を \begin{document} の直前へ挿入。
      // extraPre が空(既定)なら head は完全に不変 = 従来出力と一致。
      if (extraPre.length) {
        var bd = head.indexOf('\\begin{document}');
        if (bd < 0) bd = head.length;
        head = head.slice(0, bd).concat(extraPre, head.slice(bd));
      }
      if (opts.toc) { head.push('\\tableofcontents'); head.push(''); }
      head = head.filter(function (line) { return line != null; });
      // フェーズ30: 3段/境界線つきは multicols 環境で本文を包む(既定では包まない)。
      var bodyOut = body.replace(/\n{3,}/g, '\n\n');
      if (mcN) bodyOut = '\\begin{multicols}{' + mcN + '}\n' + bodyOut + '\\end{multicols}\n';
      // フェーズ27: 冒頭に生成マーカー(上書き保護の判定に使う)
      return GEN_MARKER + '\n' + head.join('\n') + '\n' + bodyOut + '\\end{document}\n';
    }

    if (useAcc) {
      var accCfg = LANGS[accLang];
      var isLatin = !accCfg.cjk;                        // en/de/fr/es
      var docclass = isLatin ? 'article' : 'ltjsarticle'; // 注: bxjsarticle はタグ付け非互換
      // en は従来どおり polyglossia 無し(後方互換)。de/fr/es はハイフネーション用に追加。
      var accPoly = isLatin && accLang !== 'en';
      var pdfTitle = pdfMetaSanitize(acc.title || '');
      return assemble([
        '\\DocumentMetadata{tagging=on, lang=' + accCfg.bcp47 + ', pdfstandard=ua-2, pdfversion=2.0,',
        '  testphase={phase-III, math, table, title, firstaid}}',
        '\\documentclass[' + paperOpt + ',12pt' + classExtra + ']{' + docclass + '}',
        accPoly ? '\\usepackage{fontspec}' : null,
        accPoly ? '\\usepackage{polyglossia}' : null,
        accPoly ? '\\setdefaultlanguage{' + accCfg.poly + '}' : null,
        '\\usepackage{xcolor}',
        '\\usepackage{ulem}',
        '\\normalem',                                   // \emph を斜体に戻す(下線化しない)
        '\\usepackage{graphicx}',
        '\\usepackage{amsmath}',
        TODO,
        '\\usepackage{hyperref}',
        '\\hypersetup{pdftitle={' + pdfTitle + '}, pdfdisplaydoctitle=true}',
        // 表がある場合のみ tabular の先頭行を TH(ヘッダー)としてタグ付け
        ctx.hasTable ? '\\AddToHook{env/tabular/begin}{\\tagpdfsetup{table/header-rows=1}}' : null,
        WLIMG[0], WLIMG[1], WLIMG[2],
        '\\begin{document}',
        ''
      ]);
    }

    var langCfg = LANGS[language] || LANGS.ja;

    if (langCfg.klass === 'ja') {
      // ja: 現行どおり bxjsarticle(変更しない)
      return assemble([
        '\\documentclass[xelatex,ja=standard,' + paperOpt + ',12pt' + classExtra + ']{bxjsarticle}',
        // bxjsarticle(ja=standard) は geometry を自動ロード済みのため \geometry で設定する
        '\\geometry{' + geo + '}',
        '\\usepackage{xcolor}',
        '\\usepackage{xeCJKfntef}', // \uline系はxeCJKと非互換のためCJK対応の下線・取り消し線を使う
        '\\usepackage{graphicx}',
        '\\usepackage{amsmath}',
        TODO,                                           // コメント1件以上のときだけ todonotes
        '\\usepackage{hyperref}',
        WLIMG[0], WLIMG[1], WLIMG[2],
        '\\begin{document}',
        ''
      ]);
    }

    if (langCfg.klass === 'cjk') {
      // zh-Hans / zh-Hant / ko: XeLaTeX + xeCJK(実在フォントにフォールバック)
      return assemble([
        '\\documentclass[' + paperOpt + ',12pt' + classExtra + ']{article}',
        '\\usepackage[' + paperOpt + ',' + geo + ']{geometry}',
        '\\usepackage{xcolor}',
        '\\usepackage{xeCJK}',
        langCfg.cjkfont,
        '\\usepackage{xeCJKfntef}', // CJK 対応の下線・取り消し線
        '\\usepackage{graphicx}',
        '\\usepackage{amsmath}',
        TODO,
        '\\usepackage{hyperref}',
        WLIMG[0], WLIMG[1], WLIMG[2],
        '\\begin{document}',
        ''
      ]);
    }

    // en / de / fr / es: XeLaTeX + fontspec + polyglossia(ハイフネーション)
    return assemble([
      '\\documentclass[' + paperOpt + ',12pt' + classExtra + ']{article}',
      '\\usepackage[' + paperOpt + ',' + geo + ']{geometry}',
      '\\usepackage{fontspec}',
      '\\usepackage{polyglossia}',
      '\\setdefaultlanguage{' + langCfg.poly + '}',
      '\\usepackage{xcolor}',
      '\\usepackage{ulem}',   // 欧文は xeCJKfntef 非使用のため ulem の下線・取り消し線
      '\\normalem',
      '\\usepackage{graphicx}',
      '\\usepackage{amsmath}',
      TODO,
      '\\usepackage{hyperref}',
      WLIMG[0], WLIMG[1], WLIMG[2],
      '\\begin{document}',
      ''
    ]);
  }

  /* ---------- アセット抽出(app.js がコンパイル時に使用) ----------
   * generate() と同じ深さ優先順で img を数えるため、連番が一致する。 */
  function collectAssets(docEl) {
    var assets = [];
    var idx = 0;
    (function walk(n) {
      if (isElem(n) && tag(n) === 'IMG') {
        var m = (attr(n, 'src') || '').match(DATA_IMG_RE);
        if (m) {
          var ext = extForMime(m[1]);
          if (ext) {
            idx++;
            assets.push({
              name: 'img' + idx + '.' + ext,
              base64: m[2].replace(/\s+/g, ''),
              mime: 'image/' + m[1].toLowerCase()
            });
          }
        }
      }
      var kids = children(n);
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(docEl);
    return assets;
  }

  var LatexGen = {
    generate: generate,
    collectAssets: collectAssets,
    escapeLatex: escapeLatex,
    GEN_MARKER: GEN_MARKER   // フェーズ27: 上書き保護の判定用に公開
  };

  global.LatexGen = LatexGen;
  if (typeof module !== 'undefined' && module.exports) module.exports = LatexGen;
})(typeof window !== 'undefined' ? window : globalThis);
