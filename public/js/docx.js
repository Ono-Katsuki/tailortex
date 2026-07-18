/* docx.js — Word (.docx) 入出力 (window.Docx)
 * export: JSZip(グローバル JSZip)で WordprocessingML を手組み。
 * import: mammoth.browser(グローバル mammoth)+ 許可DOMへの正規化。
 * XML 生成部・正規化部はブラウザ専用 API に依存しない純粋関数
 * (nodeType / nodeName / childNodes / getAttribute / nodeValue のみ)で、
 * Node からも buildPackage / normalizeDocxHtml として単体実行できる。
 */
(function (global) {
  'use strict';

  /* ================= 共通ヘルパ ================= */

  function isText(n) { return !!n && n.nodeType === 3; }
  function isElem(n) { return !!n && n.nodeType === 1; }
  function tag(n) { return (n && n.nodeName ? String(n.nodeName) : '').toUpperCase(); }

  function attr(n, name) {
    if (n && typeof n.getAttribute === 'function') {
      var v = n.getAttribute(name);
      return v == null ? null : String(v);
    }
    if (n && n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, name)) {
      return String(n.attrs[name]);
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

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      // XML 1.0 で不正な制御文字を除去(タブ・改行以外)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  /* ================= base64(画像寸法の取得用) ================= */

  var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64ToBytes(b64, maxBytes) {
    var clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
    var out = [];
    for (var i = 0; i + 3 < clean.length; i += 4) {
      var n = (B64CHARS.indexOf(clean.charAt(i)) << 18) |
        (B64CHARS.indexOf(clean.charAt(i + 1)) << 12) |
        (B64CHARS.indexOf(clean.charAt(i + 2)) << 6) |
        B64CHARS.indexOf(clean.charAt(i + 3));
      out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
      if (maxBytes && out.length >= maxBytes) break;
    }
    return out;
  }

  function pngSize(base64) {
    var b = b64ToBytes(base64, 33);
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
    var w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    var h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    return (w > 0 && h > 0) ? { w: w, h: h } : null;
  }

  function jpegSize(base64) {
    var b = b64ToBytes(base64, 262144); // 先頭 256KB まで走査
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
    var i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      var marker = b[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        var h = (b[i + 5] << 8) | b[i + 6];
        var w = (b[i + 7] << 8) | b[i + 8];
        return (w > 0 && h > 0) ? { w: w, h: h } : null;
      }
      var len = (b[i + 2] << 8) | b[i + 3];
      i += 2 + (len || 2);
    }
    return null;
  }

  /* ================= export: WordprocessingML ================= */

  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var DATA_IMG_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/;
  var EMU_PER_PX = 9525;
  var MAX_IMG_EMU = 5400000; // 15cm

  // インライン書式コンテキスト
  function fmtClone(f) {
    return {
      b: f.b, i: f.i, u: f.u, s: f.s, vert: f.vert,
      hl: f.hl, color: f.color, sz: f.sz, font: f.font
    };
  }
  var FMT_NONE = { b: false, i: false, u: false, s: false, vert: '', hl: false, color: '', sz: 0, font: '' };

  function rPrXml(f) {
    var p = '';
    if (f.font === 'mono') {
      p += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New" w:eastAsia="ＭＳ ゴシック"/>';
    } else if (f.font === 'sans') {
      p += '<w:rFonts w:ascii="Yu Gothic" w:hAnsi="Yu Gothic" w:eastAsia="游ゴシック"/>';
    } else if (f.font === 'serif') {
      p += '<w:rFonts w:ascii="Yu Mincho" w:hAnsi="Yu Mincho" w:eastAsia="游明朝"/>';
    }
    if (f.b) p += '<w:b/><w:bCs/>';
    if (f.i) p += '<w:i/><w:iCs/>';
    if (f.s) p += '<w:strike/>';
    if (f.u) p += '<w:u w:val="single"/>';
    if (f.color) p += '<w:color w:val="' + f.color + '"/>';
    if (f.sz) p += '<w:sz w:val="' + f.sz + '"/><w:szCs w:val="' + f.sz + '"/>';
    if (f.hl) p += '<w:highlight w:val="yellow"/>';
    if (f.vert) p += '<w:vertAlign w:val="' + f.vert + '"/>';
    return p ? '<w:rPr>' + p + '</w:rPr>' : '';
  }

  function textRun(text, f) {
    if (text === '') return '';
    return '<w:r>' + rPrXml(f) + '<w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r>';
  }

  function imageRun(n, ctx) {
    var src = attr(n, 'src') || '';
    var m = src.match(DATA_IMG_RE);
    if (!m) return '';
    var sub = m[1].toLowerCase();
    var ext = (sub === 'jpeg' || sub === 'jpg') ? 'jpg' : (sub === 'png' ? 'png' : null);
    if (!ext) return textRun('[画像]', FMT_NONE);
    var base64 = m[2].replace(/\s+/g, '');

    var wPx = Number(n.naturalWidth) || parseInt(attr(n, 'width'), 10) || 0;
    var hPx = Number(n.naturalHeight) || parseInt(attr(n, 'height'), 10) || 0;
    if (!wPx || !hPx) {
      var dim = ext === 'png' ? pngSize(base64) : jpegSize(base64);
      if (dim) { wPx = dim.w; hPx = dim.h; }
    }
    if (!wPx || !hPx) { wPx = 400; hPx = 300; }
    var cx = wPx * EMU_PER_PX;
    var cy = hPx * EMU_PER_PX;
    if (cx > MAX_IMG_EMU) {
      cy = Math.round(cy * (MAX_IMG_EMU / cx));
      cx = MAX_IMG_EMU;
    }
    cx = Math.max(1, Math.round(cx));
    cy = Math.max(1, Math.round(cy));

    ctx.imgIndex++;
    var name = 'image' + ctx.imgIndex + '.' + ext;
    var relId = 'rIdImg' + ctx.imgIndex;
    ctx.media.push({ name: name, base64: base64, ext: ext });
    var docPrId = 100 + ctx.imgIndex;

    return '<w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:docPr id="' + docPrId + '" name="Picture ' + ctx.imgIndex + '"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="' + docPrId + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  // インラインノード列 → w:r 列。コメント範囲マーカーも出力する。
  function runsOf(nodes, f, ctx) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (isText(n)) {
        out += textRun(String(n.nodeValue || '').replace(/\n/g, ' '), f);
        continue;
      }
      if (!isElem(n)) continue;
      var t = tag(n);
      var nf;
      switch (t) {
        case 'STRONG': case 'B': nf = fmtClone(f); nf.b = true; out += runsOf(children(n), nf, ctx); break;
        case 'EM': case 'I': nf = fmtClone(f); nf.i = true; out += runsOf(children(n), nf, ctx); break;
        case 'U': nf = fmtClone(f); nf.u = true; out += runsOf(children(n), nf, ctx); break;
        case 'S': case 'STRIKE': case 'DEL': nf = fmtClone(f); nf.s = true; out += runsOf(children(n), nf, ctx); break;
        case 'SUB': nf = fmtClone(f); nf.vert = 'subscript'; out += runsOf(children(n), nf, ctx); break;
        case 'SUP': nf = fmtClone(f); nf.vert = 'superscript'; out += runsOf(children(n), nf, ctx); break;
        case 'A': {
          nf = fmtClone(f); nf.u = true; nf.color = '0563C1';
          out += runsOf(children(n), nf, ctx);
          break;
        }
        case 'BR': out += '<w:r>' + rPrXml(f) + '<w:br/></w:r>'; break;
        case 'IMG': out += imageRun(n, ctx); break;
        case 'SPAN': {
          if (hasClass(n, 'cite')) {
            // フェーズ3b: 引用は [key] テキストとして出力
            var ck = attr(n, 'data-key');
            if (ck == null || ck === '') ck = textOf(n).replace(/^\[|\]$/g, '');
            ck = String(ck).split(',').map(function (x) { return x.trim(); })
              .filter(function (x) { return !!x; }).join(', ');
            out += textRun('[' + ck + ']', f);
            break;
          }
          if (hasClass(n, 'comment-ref')) {
            var cid = attr(n, 'data-cid');
            var cText = ctx.comments && cid && Object.prototype.hasOwnProperty.call(ctx.comments, cid)
              ? ctx.comments[cid] : null;
            if (cText != null && !(cid in ctx.commentIdByCid)) {
              var id = ctx.commentList.length;
              ctx.commentIdByCid[cid] = id;
              ctx.commentList.push({ id: id, text: String(cText) });
              out += '<w:commentRangeStart w:id="' + id + '"/>' +
                runsOf(children(n), f, ctx) +
                '<w:commentRangeEnd w:id="' + id + '"/>' +
                '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + id + '"/></w:r>';
            } else {
              out += runsOf(children(n), f, ctx);
            }
            break;
          }
          if (hasClass(n, 'math-inline')) {
            var tex = attr(n, 'data-tex');
            if (tex == null || tex === '') tex = textOf(n);
            nf = fmtClone(f); nf.i = true;
            out += textRun(String(tex), nf);
            break;
          }
          if (hasClass(n, 'footnote')) {
            out += textRun('（脚注: ' + (attr(n, 'data-note') || '') + '）', f);
            break;
          }
          nf = fmtClone(f);
          if (hasClass(n, 'hl')) nf.hl = true;
          if (hasClass(n, 'fc')) nf.color = 'FF0000';
          if (hasClass(n, 'ff-mono')) nf.font = 'mono';
          else if (hasClass(n, 'ff-sans')) nf.font = 'sans';
          else if (hasClass(n, 'ff-serif')) nf.font = 'serif';
          if (hasClass(n, 'fs')) {
            var pt = parseFloat(attr(n, 'data-pt'));
            if (pt > 0) nf.sz = Math.round(pt * 2);
          }
          out += runsOf(children(n), nf, ctx);
          break;
        }
        default:
          out += runsOf(children(n), f, ctx);
          break;
      }
    }
    return out;
  }

  function jcOf(n) {
    var st = attr(n, 'style') || '';
    var m = st.match(/text-align\s*:\s*(left|center|right|justify)/i);
    if (!m) return '';
    var v = m[1].toLowerCase();
    if (v === 'center') return 'center';
    if (v === 'right') return 'right';
    if (v === 'justify') return 'both';
    return '';
  }

  function pXml(pPr, runs) {
    return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + runs + '</w:p>';
  }

  function paragraphXml(n, ctx, pStyle, baseFmt) {
    var pPr = '';
    if (pStyle) pPr += '<w:pStyle w:val="' + pStyle + '"/>';
    var jc = jcOf(n);
    if (jc) pPr += '<w:jc w:val="' + jc + '"/>';
    return pXml(pPr, runsOf(children(n), baseFmt || FMT_NONE, ctx));
  }

  function codeParagraphs(n, ctx) {
    var f = fmtClone(FMT_NONE);
    f.font = 'mono';
    var lines = textOf(n).replace(/\n+$/, '').split('\n');
    var runs = '';
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) runs += '<w:r><w:br/></w:r>';
      runs += textRun(lines[i], f);
    }
    var pPr = '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>';
    return pXml(pPr, runs);
  }

  function listXml(n, ctx, level) {
    var numId = tag(n) === 'OL' ? 2 : 1;
    var out = '';
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (!isElem(kid)) continue;
      var t = tag(kid);
      if (t === 'LI') {
        var inlineKids = [];
        var nestedOut = '';
        var lk = children(kid);
        for (var j = 0; j < lk.length; j++) {
          if (isElem(lk[j]) && (tag(lk[j]) === 'UL' || tag(lk[j]) === 'OL')) {
            nestedOut += listXml(lk[j], ctx, Math.min(level + 1, 8));
          } else {
            inlineKids.push(lk[j]);
          }
        }
        var pPr = '<w:pStyle w:val="ListParagraph"/>' +
          '<w:numPr><w:ilvl w:val="' + level + '"/><w:numId w:val="' + numId + '"/></w:numPr>';
        out += pXml(pPr, runsOf(inlineKids, FMT_NONE, ctx)) + nestedOut;
      } else if (t === 'UL' || t === 'OL') {
        out += listXml(kid, ctx, Math.min(level + 1, 8));
      }
    }
    return out;
  }

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

  function tableXml(n, ctx) {
    var rows = [];
    collectRows(n, rows);
    if (!rows.length) return '';
    var border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
      '<w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
      '<w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
      '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
      '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
    var out = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
      '<w:tblBorders>' + border + '</w:tblBorders>' +
      '<w:tblLayout w:type="autofit"/></w:tblPr>';
    for (var r = 0; r < rows.length; r++) {
      out += '<w:tr>';
      var kids = children(rows[r]);
      var hasCell = false;
      for (var c = 0; c < kids.length; c++) {
        var cell = kids[c];
        if (!isElem(cell) || (tag(cell) !== 'TD' && tag(cell) !== 'TH')) continue;
        hasCell = true;
        var f = tag(cell) === 'TH' ? (function () { var x = fmtClone(FMT_NONE); x.b = true; return x; })() : FMT_NONE;
        out += '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>' +
          pXml('', runsOf(children(cell), f, ctx)) + '</w:tc>';
      }
      if (!hasCell) out += '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p/></w:tc>';
      out += '</w:tr>';
    }
    out += '</w:tbl>';
    return out;
  }

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

  function blockXml(n, ctx) {
    if (isText(n)) {
      var raw = String(n.nodeValue || '');
      return raw.trim() ? pXml('', textRun(raw.trim(), FMT_NONE)) : '';
    }
    if (!isElem(n)) return '';
    var t = tag(n);
    switch (t) {
      case 'H1': return paragraphXml(n, ctx, 'Heading1');
      case 'H2': return paragraphXml(n, ctx, 'Heading2');
      case 'H3': case 'H4': case 'H5': case 'H6': return paragraphXml(n, ctx, 'Heading3');
      case 'P': {
        if (hasClass(n, 'title')) return paragraphXml(n, ctx, 'Title');
        if (hasClass(n, 'subtitle')) return paragraphXml(n, ctx, 'Subtitle');
        return paragraphXml(n, ctx, '');
      }
      case 'BLOCKQUOTE': return paragraphXml(n, ctx, 'Quote');
      case 'PRE': return codeParagraphs(n, ctx);
      case 'UL': case 'OL': return listXml(n, ctx, 0);
      case 'TABLE': return tableXml(n, ctx) + '<w:p/>'; // 表の直後には空段落(Word互換)
      case 'FIGURE': {
        var img = findFirst(n, 'IMG');
        if (!img) return '';
        return pXml('<w:jc w:val="center"/>', imageRun(img, ctx));
      }
      case 'IMG': return pXml('<w:jc w:val="center"/>', imageRun(n, ctx));
      case 'HR': {
        return pXml('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>', '');
      }
      case 'DIV': {
        if (hasClass(n, 'bibliography')) {
          // フェーズ3b: 「参考文献」見出し + 各文献の整形段落
          var out = pXml('<w:pStyle w:val="Heading1"/>', textRun('参考文献', FMT_NONE));
          var lis = [];
          (function walk(x) {
            var k = children(x);
            for (var i = 0; i < k.length; i++) {
              if (!isElem(k[i])) continue;
              if (tag(k[i]) === 'LI') lis.push(k[i]);
              else walk(k[i]);
            }
          })(n);
          for (var bi = 0; bi < lis.length; bi++) {
            out += pXml('', runsOf(children(lis[bi]), FMT_NONE, ctx));
          }
          return out;
        }
        if (hasClass(n, 'page-break')) {
          return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
        }
        if (hasClass(n, 'math-display')) {
          var tex = attr(n, 'data-tex');
          if (tex == null || tex === '') tex = textOf(n);
          var f = fmtClone(FMT_NONE);
          f.i = true;
          return pXml('<w:jc w:val="center"/>', textRun(String(tex), f));
        }
        return blocksXml(children(n), ctx);
      }
      default: {
        // 未知要素: 子にブロックがあれば展開、なければ段落として出力
        var kids = children(n);
        for (var i = 0; i < kids.length; i++) {
          if (isElem(kids[i]) && /^(P|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|DIV|HR)$/.test(tag(kids[i]))) {
            return blocksXml(kids, ctx);
          }
        }
        var runs = runsOf(kids, FMT_NONE, ctx);
        return runs ? pXml('', runs) : '';
      }
    }
  }

  function blocksXml(nodes, ctx) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) out += blockXml(nodes[i], ctx);
    return out;
  }

  /* ---------- 各パート ---------- */

  var XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  function contentTypesXml(ctx) {
    var s = XML_DECL +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>';
    if (ctx.commentList.length) {
      s += '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>';
    }
    s += '</Types>';
    return s;
  }

  function rootRelsXml() {
    return XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';
  }

  function documentRelsXml(ctx) {
    var s = XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
    if (ctx.commentList.length) {
      s += '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>';
    }
    for (var i = 0; i < ctx.media.length; i++) {
      s += '<Relationship Id="rIdImg' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + ctx.media[i].name + '"/>';
    }
    s += '</Relationships>';
    return s;
  }

  function stylesXml(layout) {
    layout = layout || normLayout(null);
    // フェーズ30: 行間・段落後スペースは Normal スタイルの pPr に反映(文書全体)。
    // 既定(行間1.15・段落間隔なし)では spacing 属性を出さず従来と一致。
    var spAttrs = '';
    var line = DOCX_LINE[layout.lineHeight];         // 1.15(既定)は undefined
    if (line) spAttrs += ' w:line="' + line + '" w:lineRule="auto"';
    if (layout.paraSpace) spAttrs += ' w:after="120"';
    var normalPPr = spAttrs ? '<w:pPr><w:spacing' + spAttrs + '/></w:pPr>' : '';
    function heading(id, name, sz, outline) {
      return '<w:style w:type="paragraph" w:styleId="' + id + '">' +
        '<w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
        '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="' + outline + '"/></w:pPr>' +
        '<w:rPr><w:b/><w:bCs/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr></w:style>';
    }
    return XML_DECL +
      '<w:styles xmlns:w="' + W_NS + '">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Yu Mincho" w:hAnsi="Yu Mincho" w:eastAsia="游明朝"/>' +
      '<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ja-JP"/>' +
      '</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' + normalPPr + '</w:style>' +
      heading('Heading1', 'heading 1', 32, 0) +
      heading('Heading2', 'heading 2', 28, 1) +
      heading('Heading3', 'heading 3', 24, 2) +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>' +
      '<w:rPr><w:b/><w:bCs/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>' +
      '<w:rPr><w:i/><w:iCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="720" w:right="720"/><w:spacing w:before="120" w:after="120"/></w:pPr>' +
      '<w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
      '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/>' +
      '<w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/>' +
      '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
      '</w:styles>';
  }

  function numberingXml() {
    function levels(kind) {
      var s = '';
      for (var lvl = 0; lvl < 9; lvl++) {
        var indent = 720 * (lvl + 1);
        if (kind === 'bullet') {
          s += '<w:lvl w:ilvl="' + lvl + '"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
            '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
            '<w:pPr><w:ind w:left="' + indent + '" w:hanging="360"/></w:pPr>' +
            '<w:rPr><w:rFonts w:ascii="Yu Gothic" w:hAnsi="Yu Gothic" w:eastAsia="游ゴシック" w:hint="eastAsia"/></w:rPr></w:lvl>';
        } else {
          s += '<w:lvl w:ilvl="' + lvl + '"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
            '<w:lvlText w:val="%' + (lvl + 1) + '."/><w:lvlJc w:val="left"/>' +
            '<w:pPr><w:ind w:left="' + indent + '" w:hanging="360"/></w:pPr></w:lvl>';
        }
      }
      return s;
    }
    return XML_DECL +
      '<w:numbering xmlns:w="' + W_NS + '">' +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + levels('bullet') + '</w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + levels('decimal') + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
      '</w:numbering>';
  }

  function commentsXml(ctx) {
    var s = XML_DECL + '<w:comments xmlns:w="' + W_NS + '">';
    for (var i = 0; i < ctx.commentList.length; i++) {
      var c = ctx.commentList[i];
      s += '<w:comment w:id="' + c.id + '" w:author="あなた" w:initials="あ" w:date="' + ctx.date + '">' +
        '<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>' +
        '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' +
        textRun(c.text, FMT_NONE) +
        '</w:p></w:comment>';
    }
    s += '</w:comments>';
    return s;
  }

  /* ---------- フェーズ30: レイアウト(用紙・向き・余白・段組み・行間・段落間隔) ---------- */
  // 用紙寸法(縦向き, twips)。A4 は従来値と一致。
  var DOCX_PAPER = {
    a4: { w: 11906, h: 16838 },
    b5: { w: 10318, h: 14570 },   // JIS B5 182x257mm
    letter: { w: 12240, h: 15840 }
  };
  // 余白(twips)。normal は従来値と一致(上下30mm=1701, 左右25mm=1418)。
  var DOCX_MARGIN = {
    normal: { tb: 1701, lr: 1418 },
    narrow: { tb: 720, lr: 720 },
    wide: { tb: 1440, lr: 2880 }
  };
  // 行間 w:line(w:lineRule="auto", 240=1.0)。既定 1.15 は指定なし=従来のまま。
  var DOCX_LINE = { '1.0': 240, '1.5': 360, '2.0': 480 };

  function normLayout(l) {
    l = l || {};
    return {
      paper: DOCX_PAPER[l.paper] ? l.paper : 'a4',
      landscape: !!l.landscape,
      margin: DOCX_MARGIN[l.margin] ? l.margin : 'normal',
      columns: (l.columns === 'two' || l.columns === 'three' || l.columns === 'rule2') ? l.columns : 'one',
      lineHeight: l.lineHeight || '1.15',
      paraSpace: !!l.paraSpace
    };
  }

  function sectPrXml(layout) {
    var dim = DOCX_PAPER[layout.paper] || DOCX_PAPER.a4;
    var w = layout.landscape ? dim.h : dim.w;
    var h = layout.landscape ? dim.w : dim.h;
    var pgSz = '<w:pgSz w:w="' + w + '" w:h="' + h + '"' + (layout.landscape ? ' w:orient="landscape"' : '') + '/>';
    var m = DOCX_MARGIN[layout.margin] || DOCX_MARGIN.normal;
    var pgMar = '<w:pgMar w:top="' + m.tb + '" w:right="' + m.lr + '" w:bottom="' + m.tb +
      '" w:left="' + m.lr + '" w:header="851" w:footer="992" w:gutter="0"/>';
    var cols;
    if (layout.columns === 'two') cols = '<w:cols w:num="2" w:space="425"/>';
    else if (layout.columns === 'three') cols = '<w:cols w:num="3" w:space="425"/>';
    else if (layout.columns === 'rule2') cols = '<w:cols w:num="2" w:space="425" w:sep="1"/>';
    else cols = '<w:cols w:space="425"/>';
    return '<w:sectPr>' + pgSz + pgMar + cols + '</w:sectPr>';
  }

  function documentXml(bodyXml, layout) {
    layout = layout || normLayout(null);
    return XML_DECL +
      '<w:document xmlns:w="' + W_NS + '"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<w:body>' + bodyXml + sectPrXml(layout) + '</w:body></w:document>';
  }

  /* buildPackage(docEl, opts) → { parts: [{path, text} | {path, base64}] }
   * opts.comments: {cid: 本文} (省略可) */
  function buildPackage(docEl, opts) {
    opts = opts || {};
    var ctx = {
      imgIndex: 0,
      media: [],
      comments: opts.comments || null,
      commentIdByCid: {},
      commentList: [],
      date: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    };
    var body = docEl ? blocksXml(children(docEl), ctx) : '';
    if (!body) body = '<w:p/>';

    // フェーズ30: レイアウト設定を正規化(既定値では従来出力と一致)
    var layout = normLayout(opts.layout);

    var parts = [
      { path: '[Content_Types].xml', text: contentTypesXml(ctx) },
      { path: '_rels/.rels', text: rootRelsXml() },
      { path: 'word/_rels/document.xml.rels', text: documentRelsXml(ctx) },
      { path: 'word/document.xml', text: documentXml(body, layout) },
      { path: 'word/styles.xml', text: stylesXml(layout) },
      { path: 'word/numbering.xml', text: numberingXml() }
    ];
    if (ctx.commentList.length) {
      parts.push({ path: 'word/comments.xml', text: commentsXml(ctx) });
    }
    for (var i = 0; i < ctx.media.length; i++) {
      parts.push({ path: 'word/media/' + ctx.media[i].name, base64: ctx.media[i].base64 });
    }
    return { parts: parts };
  }

  /* ================= import: mammoth HTML → 許可 DOM ================= */

  /* フェーズ29-1: 学会様式スタイルの自動マッピング(データ駆動)
   * 様式追加は STYLE_RULES に 1 行(スタイル名を names へ)足すだけで済む。
   * target はエディタの許可構造(p.title / p.subtitle / h1〜h3 / blockquote 等)。
   * 文書タイトルは本エディタでは p.title(latex.js が中央寄せ大見出しへ)。
   * h1=\section, h2=\subsection, h3=\subsubsection なので、学会の
   * 章/節/項見出しはこの深さへ対応させる。 */
  var STYLE_RULES = [
    // 表題(文書タイトル)→ p.title
    { target: 'p.title:fresh', names: ['Title', '表題', 'タイトル', 'HI-和文表題'] },
    // 副題・英文表題 → p.subtitle
    { target: 'p.subtitle:fresh', names: [
      'Subtitle', '副題', '英文表題',
      'HI-英文表題（和文原稿）', 'HI-英文表題（英文原稿）', 'HI-英文表題'] },
    // 著者名・所属・会員種別 → 中央寄せ段落(normalize 側で text-align:center)
    { target: 'p.author:fresh', names: [
      '著者名', '著者', '所属',
      'HI-和文著者名', 'HI-英文著者名（和文原稿）', 'HI-英文著者名（英文原稿）',
      'HI-著者会員種別', 'HI-著者紹介氏名'] },
    // 見出し(章=\section, 節=\subsection, 項=\subsubsection)
    { target: 'h1:fresh', names: ['Heading 1', '見出し 1', '章見出し', 'HI-章見出し'] },
    { target: 'h2:fresh', names: ['Heading 2', '見出し 2', '節見出し', 'HI-節見出し'] },
    { target: 'h3:fresh', names: ['Heading 3', '見出し 3', '項見出し', 'HI-項見出し'] },
    // 図表キャプション → 中央寄せ段落
    { target: 'p.caption:fresh', names: ['caption', '図表番号', '図表キャプション', 'HI-図等見出し'] },
    // 引用
    { target: 'blockquote:fresh', names: ['Quote', 'Intense Quote', '引用文', '引用文 2'] }
  ];
  var CHAR_STYLE_MAP = ['u => u', 'strike => s'];

  function buildStyleMap(rules) {
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      for (var j = 0; j < rules[i].names.length; j++) {
        out.push("p[style-name='" + rules[i].names[j] + "'] => " + rules[i].target);
      }
    }
    return out.concat(CHAR_STYLE_MAP);
  }

  var STYLE_MAP = buildStyleMap(STYLE_RULES);

  /* ---------- ミニ HTML パーサ(mammoth の整形済み出力専用) ---------- */

  var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m0, body) {
      if (body.charAt(0) === '#') {
        var code = body.charAt(1).toLowerCase() === 'x'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isNaN(code)) {
          try { return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code); } catch (e) { return m0; }
        }
        return m0;
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m0;
    });
  }

  function parseAttrs(s) {
    var attrs = {};
    var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    var m;
    while ((m = re.exec(s))) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : '')));
    }
    return attrs;
  }

  var VOID_TAGS = { br: 1, img: 1, hr: 1, input: 1, meta: 1, link: 1 };

  function makeElem(name, attrs) {
    return {
      nodeType: 1,
      nodeName: name.toUpperCase(),
      attrs: attrs || {},
      childNodes: [],
      getAttribute: function (k) {
        k = String(k).toLowerCase();
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      }
    };
  }

  function parseHtmlFragment(html) {
    var root = makeElem('#root', {});
    var stack = [root];
    var re = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>|([^<]+)/g;
    var m;
    while ((m = re.exec(html))) {
      if (m[4] != null) {
        stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: decodeEntities(m[4]) });
      } else if (m[1]) {
        var closeName = m[1].toUpperCase();
        for (var i = stack.length - 1; i > 0; i--) {
          if (stack[i].nodeName === closeName) { stack.length = i; break; }
        }
      } else if (m[2]) {
        var rawAttrs = m[3] || '';
        var selfClose = /\/\s*$/.test(rawAttrs);
        if (selfClose) rawAttrs = rawAttrs.replace(/\/\s*$/, '');
        var node = makeElem(m[2], parseAttrs(rawAttrs));
        stack[stack.length - 1].childNodes.push(node);
        if (!VOID_TAGS[m[2].toLowerCase()] && !selfClose) stack.push(node);
      }
    }
    return root;
  }

  /* ---------- 正規化(許可 DOM への写像) ---------- */

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttrHtml(s) {
    return escHtml(s).replace(/"/g, '&quot;');
  }

  function styleOf(n) { return (attr(n, 'style') || '').toLowerCase(); }

  // インライン整形: 返り値は HTML 文字列。画像は pendingImgs に退避。
  function normInline(n, pendingImgs) {
    if (isText(n)) return escHtml(String(n.nodeValue || ''));
    if (!isElem(n)) return '';
    var t = tag(n);
    var inner = function () {
      var s = '';
      var kids = children(n);
      for (var i = 0; i < kids.length; i++) s += normInline(kids[i], pendingImgs);
      return s;
    };
    switch (t) {
      case 'STRONG': case 'B': return '<strong>' + inner() + '</strong>';
      case 'EM': case 'I': return '<em>' + inner() + '</em>';
      case 'U': case 'INS': return '<u>' + inner() + '</u>';
      case 'S': case 'STRIKE': case 'DEL': return '<s>' + inner() + '</s>';
      case 'SUB': return '<sub>' + inner() + '</sub>';
      case 'SUP': return '<sup>' + inner() + '</sup>';
      case 'BR': return '<br>';
      case 'A': {
        var href = attr(n, 'href');
        var c = inner();
        // 脚注等のアンカー(#で始まる内部リンク)は本文のみ残す
        if (!href || href.charAt(0) === '#') return c;
        return '<a href="' + escAttrHtml(href) + '">' + c + '</a>';
      }
      case 'IMG': {
        var src = attr(n, 'src') || '';
        if (src) pendingImgs.push(src);
        return '';
      }
      case 'SPAN': {
        var st = styleOf(n);
        var out = inner();
        if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) out = '<strong>' + out + '</strong>';
        if (/font-style\s*:\s*italic/.test(st)) out = '<em>' + out + '</em>';
        if (/text-decoration[^;]*underline/.test(st)) out = '<u>' + out + '</u>';
        if (/text-decoration[^;]*line-through/.test(st)) out = '<s>' + out + '</s>';
        if (/background(?:-color)?\s*:\s*(yellow|#ffff00|#ff0)/.test(st)) out = '<span class="hl">' + out + '</span>';
        if (/(^|[^-])color\s*:\s*(red|#ff0000|#f00)/.test(st)) out = '<span class="fc">' + out + '</span>';
        return out;
      }
      default: return inner();
    }
  }

  // フェーズ29-3: WMF/EMF はブラウザ描画不可。代替プレースホルダー段落にする。
  // (完全なラスタ変換はスコープ外。data URI のバイナリはここでは保持しない。)
  var WMF_RE = /^data:image\/(x-wmf|wmf|x-emf|emf|x-windowsmetafile)/i;

  function figureFor(src) {
    if (WMF_RE.test(src)) {
      return '<p>［図: WMF/EMF形式のためブラウザでは表示できません。元の Word ファイルで確認してください］</p>';
    }
    return '<figure><img src="' + escAttrHtml(src) + '" style="max-width:100%"></figure>';
  }

  function figuresHtml(pendingImgs) {
    var out = '';
    for (var i = 0; i < pendingImgs.length; i++) out += figureFor(pendingImgs[i]);
    pendingImgs.length = 0;
    return out;
  }

  function inlineOnlyHtml(n) {
    // 子孫の p を無視してインライン内容だけを直列化(td / blockquote 用)
    var parts = [];
    var kids = children(n);
    var imgs = [];
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isElem(kid) && /^(P|H1|H2|H3|H4|H5|H6|DIV|BLOCKQUOTE)$/.test(tag(kid))) {
        var seg = '';
        var gk = children(kid);
        for (var j = 0; j < gk.length; j++) seg += normInline(gk[j], imgs);
        if (seg) parts.push(seg);
      } else {
        var s = normInline(kid, imgs);
        if (s) parts.push(s);
      }
    }
    // 画像はセル内では失われるため代替テキスト扱いにしない(単純化)
    imgs.length = 0;
    return parts.join('<br>');
  }

  function normLi(n) {
    var out = '<li>';
    var nested = '';
    var imgs = [];
    var inline = '';
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isElem(kid) && (tag(kid) === 'UL' || tag(kid) === 'OL')) {
        nested += normList(kid);
      } else if (isElem(kid) && /^(P|DIV)$/.test(tag(kid))) {
        var gk = children(kid);
        for (var j = 0; j < gk.length; j++) inline += normInline(gk[j], imgs);
      } else {
        inline += normInline(kid, imgs);
      }
    }
    imgs.length = 0;
    out += (inline || '<br>') + nested + '</li>';
    return out;
  }

  function normList(n) {
    var t = tag(n) === 'OL' ? 'ol' : 'ul';
    var out = '<' + t + '>';
    var kids = children(n);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isElem(kid) && tag(kid) === 'LI') out += normLi(kid);
      else if (isElem(kid) && (tag(kid) === 'UL' || tag(kid) === 'OL')) out += normList(kid);
    }
    return out + '</' + t + '>';
  }

  function normTable(n) {
    var rows = [];
    collectRows(n, rows);
    if (!rows.length) return '';
    var out = '<table>';
    for (var r = 0; r < rows.length; r++) {
      out += '<tr>';
      var kids = children(rows[r]);
      for (var c = 0; c < kids.length; c++) {
        var cell = kids[c];
        if (!isElem(cell) || (tag(cell) !== 'TD' && tag(cell) !== 'TH')) continue;
        var inner = inlineOnlyHtml(cell);
        out += '<td>' + (inner || '<br>') + '</td>';
      }
      out += '</tr>';
    }
    return out + '</table>';
  }

  function normBlock(n, out) {
    if (isText(n)) {
      var raw = String(n.nodeValue || '');
      if (raw.trim()) out.push('<p>' + escHtml(raw.trim()) + '</p>');
      return;
    }
    if (!isElem(n)) return;
    var t = tag(n);
    var imgs = [];
    switch (t) {
      case 'P': case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        var tagOut = t === 'P' ? 'p' : (t === 'H1' ? 'h1' : (t === 'H2' ? 'h2' : 'h3'));
        var cls = '';
        if (t === 'P') {
          if (hasClass(n, 'title')) cls = ' class="title"';
          else if (hasClass(n, 'subtitle')) cls = ' class="subtitle"';
          // フェーズ29-1: 著者名・所属・キャプションは中央寄せ段落として保持
          else if (hasClass(n, 'author') || hasClass(n, 'caption')) cls = ' style="text-align:center"';
        }
        var inline = '';
        var kids = children(n);
        for (var i = 0; i < kids.length; i++) inline += normInline(kids[i], imgs);
        var hasText = inline.replace(/<br>/g, '').trim() !== '';
        if (hasText) {
          out.push('<' + tagOut + cls + '>' + inline + '</' + tagOut + '>');
        } else if (!imgs.length && tagOut === 'p') {
          out.push('<p><br></p>'); // 空段落は空行として保持
        }
        out.push(figuresHtml(imgs));
        return;
      }
      case 'BLOCKQUOTE': {
        var inner = inlineOnlyHtml(n);
        out.push('<blockquote>' + (inner || '<br>') + '</blockquote>');
        return;
      }
      case 'PRE': {
        out.push('<pre class="code">' + escHtml(textOf(n).replace(/\n+$/, '')) + '</pre>');
        return;
      }
      case 'UL': case 'OL': out.push(normList(n)); return;
      case 'TABLE': out.push(normTable(n)); return;
      case 'IMG': {
        var src = attr(n, 'src') || '';
        if (src) out.push(figureFor(src));
        return;
      }
      case 'FIGURE': {
        var img = findFirst(n, 'IMG');
        if (img) normBlock(img, out);
        return;
      }
      case 'HR': out.push('<hr>'); return;
      default: {
        // div / section / 不明タグ: 子を順にブロック処理
        var kids2 = children(n);
        var hasBlockKid = false;
        for (var k = 0; k < kids2.length; k++) {
          if (isElem(kids2[k]) && /^(P|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|DIV|SECTION|HR|IMG)$/.test(tag(kids2[k]))) {
            hasBlockKid = true;
            break;
          }
        }
        if (hasBlockKid) {
          for (var k2 = 0; k2 < kids2.length; k2++) normBlock(kids2[k2], out);
        } else {
          var inline2 = '';
          for (var k3 = 0; k3 < kids2.length; k3++) inline2 += normInline(kids2[k3], imgs);
          if (inline2.replace(/<br>/g, '').trim()) out.push('<p>' + inline2 + '</p>');
          out.push(figuresHtml(imgs));
        }
        return;
      }
    }
  }

  /* mammoth の出力 HTML → 本エディタの許可 DOM の HTML 文字列 */
  function normalizeDocxHtml(html) {
    var root = parseHtmlFragment(String(html || ''));
    var out = [];
    var kids = children(root);
    for (var i = 0; i < kids.length; i++) normBlock(kids[i], out);
    // 末尾に溜まった空段落は落とす
    return out.join('').replace(/(<p><br><\/p>)+$/, '');
  }

  /* ================= フェーズ29-2: OMML(Word 数式) → LaTeX ================= */

  /* --- 名前空間つきタグを保つ最小 XML パーサ(OMML 専用) --- */

  function parseXmlAttrs(s) {
    var attrs = {};
    var re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    while ((m = re.exec(s))) {
      attrs[m[1]] = decodeEntities(m[2] != null ? m[2] : (m[3] != null ? m[3] : ''));
    }
    return attrs;
  }

  function parseXml(xml) {
    var root = { name: '#root', attrs: {}, children: [] };
    var stack = [root];
    var re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>|([^<]+)/g;
    var m;
    while ((m = re.exec(xml))) {
      if (m[5] != null) {
        var txt = m[5];
        if (txt) stack[stack.length - 1].children.push({ text: decodeEntities(txt) });
      } else if (m[1]) {
        for (var i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === m[1]) { stack.length = i; break; }
        }
      } else if (m[2]) {
        var node = { name: m[2], attrs: parseXmlAttrs(m[3] || ''), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!m[4]) stack.push(node); // 自己終了でなければ push
      }
    }
    return root;
  }

  function localName(name) {
    var i = name.indexOf(':');
    return i >= 0 ? name.slice(i + 1) : name;
  }
  function isXmlElem(n) { return n && n.name != null; }
  function findChild(node, ln) {
    if (!node) return null;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (isXmlElem(c) && localName(c.name) === ln) return c;
    }
    return null;
  }
  function childrenByLn(node, ln) {
    var out = [];
    if (!node) return out;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (isXmlElem(c) && localName(c.name) === ln) out.push(c);
    }
    return out;
  }
  function findDescendant(node, ln) {
    if (!node) return null;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (!isXmlElem(c)) continue;
      if (localName(c.name) === ln) return c;
      var f = findDescendant(c, ln);
      if (f) return f;
    }
    return null;
  }
  function xmlText(node) {
    var s = '';
    if (!node) return s;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.text != null) s += c.text;
      else s += xmlText(c);
    }
    return s;
  }
  // m:val 属性(名前空間つき/なし両対応)
  function mVal(node) {
    if (!node) return null;
    if (node.attrs['m:val'] != null) return node.attrs['m:val'];
    if (node.attrs['w:val'] != null) return node.attrs['w:val'];
    if (node.attrs.val != null) return node.attrs.val;
    return null;
  }
  function propVal(parent, prLn, childLn) {
    var pr = findChild(parent, prLn);
    if (!pr) return null;
    return mVal(findChild(pr, childLn));
  }
  function propOn(parent, prLn, childLn) {
    var v = propVal(parent, prLn, childLn);
    return v === '1' || v === 'true' || v === 'on';
  }

  /* --- Unicode → TeX 記号マップ --- */

  var OMML_SYM = {
    // ギリシャ小文字
    'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ',
    'ε': '\\epsilon ', 'ϵ': '\\epsilon ', 'ζ': '\\zeta ', 'η': '\\eta ',
    'θ': '\\theta ', 'ϑ': '\\vartheta ', 'ι': '\\iota ', 'κ': '\\kappa ',
    'λ': '\\lambda ', 'μ': '\\mu ', 'ν': '\\nu ', 'ξ': '\\xi ',
    'ο': 'o', 'π': '\\pi ', 'ϖ': '\\varpi ', 'ρ': '\\rho ', 'ϱ': '\\varrho ',
    'σ': '\\sigma ', 'ς': '\\varsigma ', 'τ': '\\tau ', 'υ': '\\upsilon ',
    'φ': '\\phi ', 'ϕ': '\\varphi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
    // ギリシャ大文字
    'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ',
    'Ξ': '\\Xi ', 'Π': '\\Pi ', 'Σ': '\\Sigma ', 'Υ': '\\Upsilon ',
    'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ',
    // 演算子・関係
    '×': '\\times ', '÷': '\\div ', '±': '\\pm ', '∓': '\\mp ',
    '⋅': '\\cdot ', '·': '\\cdot ', '∗': '\\ast ', '∘': '\\circ ',
    '∞': '\\infty ', '∂': '\\partial ', '∇': '\\nabla ', '′': "'", '″': "''",
    '≤': '\\leq ', '≥': '\\geq ', '≠': '\\neq ', '≈': '\\approx ',
    '≅': '\\cong ', '≡': '\\equiv ', '∼': '\\sim ', '∝': '\\propto ',
    '≪': '\\ll ', '≫': '\\gg ', '≐': '\\doteq ',
    '→': '\\to ', '←': '\\leftarrow ', '↔': '\\leftrightarrow ',
    '⇒': '\\Rightarrow ', '⇐': '\\Leftarrow ', '⇔': '\\Leftrightarrow ',
    '↦': '\\mapsto ', '⟶': '\\longrightarrow ',
    '∈': '\\in ', '∉': '\\notin ', '∋': '\\ni ',
    '⊂': '\\subset ', '⊆': '\\subseteq ', '⊃': '\\supset ', '⊇': '\\supseteq ',
    '∪': '\\cup ', '∩': '\\cap ', '∅': '\\emptyset ', '∖': '\\setminus ',
    '∀': '\\forall ', '∃': '\\exists ', '∄': '\\nexists ', '¬': '\\neg ',
    '∧': '\\wedge ', '∨': '\\vee ', '⊕': '\\oplus ', '⊗': '\\otimes ',
    '∠': '\\angle ', '∥': '\\parallel ', '⊥': '\\perp ',
    '⌈': '\\lceil ', '⌉': '\\rceil ', '⌊': '\\lfloor ', '⌋': '\\rfloor ',
    '⟨': '\\langle ', '⟩': '\\rangle ', '‖': '\\| ',
    '√': '\\surd ', 'ℏ': '\\hbar ', 'ℓ': '\\ell ', '℘': '\\wp ',
    'ℜ': '\\Re ', 'ℑ': '\\Im ', 'ℵ': '\\aleph ', '∎': '\\blacksquare ',
    '∫': '\\int ', '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ',
    '∑': '\\sum ', '∏': '\\prod ', '∐': '\\coprod ',
    '…': '\\ldots ', '⋯': '\\cdots ', '⋮': '\\vdots ', '⋱': '\\ddots ',
    '−': '-', '⁄': '/', '∙': '\\cdot ', '°': '^{\\circ}', '％': '\\%',
    '¥': '\\yen ', '∠': '\\angle '
  };

  function texEscapeText(s) {
    return String(s).replace(/([\\{}$&#_%~^])/g, function (ch) {
      if (ch === '~') return '\\textasciitilde{}';
      if (ch === '^') return '\\textasciicircum{}';
      return '\\' + ch;
    });
  }

  // 数式テキスト → TeX。記号は変換、ASCII は素通し、CJK 等は \text{} で温存。
  function mapUnicode(s) {
    s = String(s == null ? '' : s);
    var out = '', buf = '';
    function flush() { if (buf) { out += '\\text{' + texEscapeText(buf) + '}'; buf = ''; } }
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var code = s.charCodeAt(i);
      if (OMML_SYM[ch] != null) { flush(); out += OMML_SYM[ch]; }
      else if (code < 0x80) { flush(); out += ch; }
      else if (code >= 0xD800 && code <= 0xDBFF) { buf += s.substr(i, 2); i++; } // サロゲート対
      else { buf += ch; } // 未対応の非 ASCII(CJK など)
    }
    flush();
    return out;
  }

  var NARY_OP = {
    '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod',
    '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '⨌': '\\iiiint',
    '∮': '\\oint', '∯': '\\oiint', '∰': '\\oiiint',
    '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
    '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⨀': '\\bigodot', '⨄': '\\biguplus'
  };
  var ACC_CMD = {
    '̂': '\\hat', '^': '\\hat', '̃': '\\tilde', '~': '\\tilde',
    '̄': '\\bar', '¯': '\\bar', '―': '\\bar', '̅': '\\bar',
    '⃗': '\\vec', '→': '\\vec', '̇': '\\dot', '̈': '\\ddot',
    '̌': '\\check', '̆': '\\breve', '́': '\\acute', '̀': '\\grave',
    '̑': '\\hat', '̊': '\\mathring'
  };
  var DELIM_MAP = {
    '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}',
    '|': '|', '‖': '\\|', '⌊': '\\lfloor', '⌋': '\\rfloor',
    '⌈': '\\lceil', '⌉': '\\rceil', '⟨': '\\langle', '⟩': '\\rangle',
    '〈': '\\langle', '〉': '\\rangle', '': '.'
  };
  var KNOWN_FUNC = /^(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|coth|arcsin|arccos|arctan|log|ln|lg|exp|lim|max|min|sup|inf|det|dim|gcd|deg|arg|ker|hom|Pr)$/;

  function delimTex(ch) {
    if (ch == null) return null;
    return DELIM_MAP.hasOwnProperty(ch) ? DELIM_MAP[ch] : ch;
  }

  // OMML ノード → TeX。未知ノードは元テキストを \text{} で温存(消さない)。
  function ommlNode(node) {
    if (!isXmlElem(node)) return node && node.text != null ? mapUnicode(node.text) : '';
    var ln = localName(node.name);
    switch (ln) {
      case 'oMath': case 'oMathPara': case 'e': case 'num': case 'den':
      case 'sup': case 'sub': case 'lim': case 'r':
        return ommlSeq(node);
      case 't':
        return mapUnicode(xmlText(node));
      case 'f': {
        var bar = propVal(node, 'fPr', 'type'); // 'bar'|'skw'|'lin'|'noBar'
        var num = ommlSeq(findChild(node, 'num'));
        var den = ommlSeq(findChild(node, 'den'));
        if (bar === 'lin') return '{' + num + '}/{' + den + '}';
        if (bar === 'noBar') return '{' + num + '\\atop ' + den + '}';
        return '\\frac{' + num + '}{' + den + '}';
      }
      case 'sSup':
        return '{' + ommlSeq(findChild(node, 'e')) + '}^{' + ommlSeq(findChild(node, 'sup')) + '}';
      case 'sSub':
        return '{' + ommlSeq(findChild(node, 'e')) + '}_{' + ommlSeq(findChild(node, 'sub')) + '}';
      case 'sSubSup':
        return '{' + ommlSeq(findChild(node, 'e')) + '}_{' + ommlSeq(findChild(node, 'sub')) +
          '}^{' + ommlSeq(findChild(node, 'sup')) + '}';
      case 'sPre':
        return '{}_{' + ommlSeq(findChild(node, 'sub')) + '}^{' + ommlSeq(findChild(node, 'sup')) +
          '}{' + ommlSeq(findChild(node, 'e')) + '}';
      case 'rad': {
        var e = ommlSeq(findChild(node, 'e'));
        var degHide = propOn(node, 'radPr', 'degHide');
        var degEl = findChild(node, 'deg');
        var deg = degEl ? ommlSeq(degEl) : '';
        return (!degHide && deg) ? '\\sqrt[' + deg + ']{' + e + '}' : '\\sqrt{' + e + '}';
      }
      case 'nary': {
        var chr = propVal(node, 'naryPr', 'chr');
        var op = NARY_OP[chr != null ? chr : '∫'] || (chr ? mapUnicode(chr) : '\\int');
        var s = op;
        var subHide = propOn(node, 'naryPr', 'subHide');
        var supHide = propOn(node, 'naryPr', 'supHide');
        var sub = findChild(node, 'sub'), sup = findChild(node, 'sup');
        if (sub && !subHide) { var st = ommlSeq(sub); if (st) s += '_{' + st + '}'; }
        if (sup && !supHide) { var pt = ommlSeq(sup); if (pt) s += '^{' + pt + '}'; }
        var body = ommlSeq(findChild(node, 'e'));
        return s + (body ? ' ' + body : '');
      }
      case 'd': {
        var beg = propVal(node, 'dPr', 'begChr');
        var end = propVal(node, 'dPr', 'endChr');
        var sep = propVal(node, 'dPr', 'sepChr');
        var es = childrenByLn(node, 'e').map(function (x) { return ommlSeq(x); });
        var join = sep != null ? (delimTex(sep) || sep) : '';
        var body2 = es.join(join);
        var bt = delimTex(beg == null ? '(' : beg);
        var et = delimTex(end == null ? ')' : end);
        return '\\left' + bt + ' ' + body2 + ' \\right' + et;
      }
      case 'func': {
        var fn = ommlSeq(findChild(node, 'fName'));
        var arg = ommlSeq(findChild(node, 'e'));
        if (KNOWN_FUNC.test(fn)) fn = '\\' + fn;
        return fn + (arg ? ' ' + arg : '');
      }
      case 'fName':
        return ommlSeq(node);
      case 'limLow':
        return '{' + ommlSeq(findChild(node, 'e')) + '}_{' + ommlSeq(findChild(node, 'lim')) + '}';
      case 'limUpp':
        return '{' + ommlSeq(findChild(node, 'e')) + '}^{' + ommlSeq(findChild(node, 'lim')) + '}';
      case 'm': {
        var rows = childrenByLn(node, 'mr').map(function (row) {
          return childrenByLn(row, 'e').map(function (x) { return ommlSeq(x); }).join(' & ');
        });
        return '\\begin{matrix} ' + rows.join(' \\\\ ') + ' \\end{matrix}';
      }
      case 'acc': {
        var chr2 = propVal(node, 'accPr', 'chr');
        if (chr2 == null) chr2 = '̂';
        var cmd = ACC_CMD[chr2] || '\\hat';
        return cmd + '{' + ommlSeq(findChild(node, 'e')) + '}';
      }
      case 'bar': {
        var pos = propVal(node, 'barPr', 'pos');
        var inner = ommlSeq(findChild(node, 'e'));
        return (pos === 'bot' ? '\\underline{' : '\\overline{') + inner + '}';
      }
      case 'groupChr': {
        var gchr = propVal(node, 'groupChrPr', 'chr');
        var gi = ommlSeq(findChild(node, 'e'));
        if (gchr === '⏞' || gchr === '︷') return '\\overbrace{' + gi + '}';
        if (gchr === '⏟' || gchr === '︸') return '\\underbrace{' + gi + '}';
        return gi;
      }
      case 'box': case 'borderBox':
        return ommlSeq(findChild(node, 'e'));
      case 'eqArr': {
        var lines = childrenByLn(node, 'e').map(function (x) { return ommlSeq(x); });
        return '\\begin{aligned} ' + lines.join(' \\\\ ') + ' \\end{aligned}';
      }
      default: {
        // 未知ノード: 元テキストを温存(\text{})。ただし空なら空文字。
        var raw = xmlText(node);
        return raw ? '\\text{' + texEscapeText(raw) + '}' : '';
      }
    }
  }

  // 子要素を順に変換して連結(*Pr / ctrlPr プロパティ要素と空白テキストは無視)
  function ommlSeq(node) {
    if (!node) return '';
    var s = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.text != null) { if (c.text.trim()) s += mapUnicode(c.text); continue; }
      var ln = localName(c.name);
      if (/Pr$/.test(ln)) continue; // fPr, rPr, naryPr, ctrlPr, ...
      s += ommlNode(c);
    }
    return s;
  }

  // OMML XML 断片(m:oMath / m:oMathPara を含む) → TeX 文字列
  function ommlXmlToTex(xmlFragment) {
    try {
      var root = parseXml(String(xmlFragment || ''));
      var math = findDescendant(root, 'oMath') || findDescendant(root, 'oMathPara');
      if (!math) return '';
      return ommlNode(math).replace(/\s+$/, '').replace(/^\s+/, '');
    } catch (e) {
      return '';
    }
  }

  var MTOK_A = '⟪', MTOK_B = '⟫'; // ⟪ ⟫ で囲んだ一意トークン

  // word/document.xml の数式を一意トークンへ置換 → {xml, tokens, count}
  function extractOmml(documentXml) {
    var xml = String(documentXml || '');
    var tokens = {};
    var counter = { n: 0 };
    // 段落数式(display)を先に処理(内部の m:oMath も一緒に消える)
    xml = xml.replace(/<m:oMathPara[ >][\s\S]*?<\/m:oMathPara>/g, function (block) {
      var name = 'WLMATH' + (counter.n++);
      tokens[name] = { tex: ommlXmlToTex(block), display: true };
      return '<w:r><w:t xml:space="preserve">' + MTOK_A + name + MTOK_B + '</w:t></w:r>';
    });
    // 残る文中数式(inline)
    xml = xml.replace(/<m:oMath[ >][\s\S]*?<\/m:oMath>/g, function (block) {
      var name = 'WLMATH' + (counter.n++);
      tokens[name] = { tex: ommlXmlToTex(block), display: false };
      return '<w:r><w:t xml:space="preserve">' + MTOK_A + name + MTOK_B + '</w:t></w:r>';
    });
    return { xml: xml, tokens: tokens, count: counter.n };
  }

  function mathElHtml(tex, display) {
    var t = String(tex == null ? '' : tex);
    var name = display ? 'div' : 'span';
    var cls = display ? 'math-display' : 'math-inline';
    return '<' + name + ' class="' + cls + '" contenteditable="false" data-tex="' +
      escAttrHtml(t) + '">' + escHtml(t) + '</' + name + '>';
  }

  // 正規化済み HTML 中のトークンを math span/div に戻す
  function applyMathTokens(html, tokens) {
    if (!tokens) return html;
    var re = new RegExp(MTOK_A + '(WLMATH\\d+)' + MTOK_B, 'g');
    // 単独段落の display 数式 → div.math-display
    html = String(html).replace(new RegExp('<p>\\s*' + MTOK_A + '(WLMATH\\d+)' + MTOK_B + '\\s*</p>', 'g'),
      function (m0, name) {
        var t = tokens[name];
        if (!t) return m0;
        return mathElHtml(t.tex, true);
      });
    // 残り(文中・セル内)→ span.math-inline
    html = html.replace(re, function (m0, name) {
      var t = tokens[name];
      if (!t) return m0;
      return mathElHtml(t.tex, false);
    });
    return html;
  }

  /* ================= 公開 API ================= */

  function readArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) {
      var reader = new FileReader();
      reader.onload = function () { res(reader.result); };
      reader.onerror = function () { rej(new Error('ファイルを読み込めませんでした')); };
      reader.readAsArrayBuffer(file);
    });
  }

  // OMML を含む docx を JSZip で開き、数式をトークン化した arrayBuffer を返す。
  // JSZip 不在・数式なし・失敗時は元の arrayBuffer をそのまま返す(安全側)。
  function preprocessMath(arrayBuffer) {
    var JSZipRef = global.JSZip;
    if (typeof JSZipRef === 'undefined') {
      return Promise.resolve({ arrayBuffer: arrayBuffer, tokens: {} });
    }
    return JSZipRef.loadAsync(arrayBuffer).then(function (zip) {
      var f = zip.file('word/document.xml');
      if (!f) return { arrayBuffer: arrayBuffer, tokens: {} };
      return f.async('string').then(function (xml) {
        var res = extractOmml(xml);
        if (!res.count) return { arrayBuffer: arrayBuffer, tokens: {} };
        zip.file('word/document.xml', res.xml);
        return zip.generateAsync({ type: 'arraybuffer' }).then(function (ab) {
          return { arrayBuffer: ab, tokens: res.tokens };
        });
      });
    }).catch(function () {
      return { arrayBuffer: arrayBuffer, tokens: {} };
    });
  }

  function exportDocx(docEl, title, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      try {
        if (typeof global.JSZip === 'undefined') {
          reject(new Error('JSZip が読み込まれていません'));
          return;
        }
        var comments = null;
        if (global.Editor && typeof global.Editor.getComments === 'function') {
          comments = global.Editor.getComments();
        }
        // フェーズ30: レイアウト設定(用紙/向き/余白/段組み/行間/段落間隔)を渡す
        var pkg = buildPackage(docEl, { title: title, comments: comments, layout: opts.layout || null });
        var zip = new global.JSZip();
        for (var i = 0; i < pkg.parts.length; i++) {
          var p = pkg.parts[i];
          if (p.base64 != null) zip.file(p.path, p.base64, { base64: true });
          else zip.file(p.path, p.text);
        }
        zip.generateAsync({
          type: 'blob',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          compression: 'DEFLATE'
        }).then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  function importDocx(file) {
    return new Promise(function (resolve, reject) {
      if (typeof global.mammoth === 'undefined') {
        reject(new Error('mammoth が読み込まれていません'));
        return;
      }
      var tokens = {};
      readArrayBuffer(file).then(function (arrayBuffer) {
        // フェーズ29-2: 数式(OMML)をトークン化してから mammoth に渡す
        return preprocessMath(arrayBuffer);
      }).then(function (pre) {
        tokens = pre.tokens;
        return global.mammoth.convertToHtml({ arrayBuffer: pre.arrayBuffer }, { styleMap: STYLE_MAP });
      }).then(function (result) {
        var html = normalizeDocxHtml(result.value || '');
        html = applyMathTokens(html, tokens);
        resolve(html);
      }).catch(reject);
    });
  }

  var Docx = {
    exportDocx: exportDocx,
    importDocx: importDocx,
    // 単体テスト・内部利用向け(純粋関数)
    buildPackage: buildPackage,
    normalizeDocxHtml: normalizeDocxHtml,
    styleMap: STYLE_MAP,
    // フェーズ29: OMML → TeX / 数式トークン化(単体テスト向け)
    ommlXmlToTex: ommlXmlToTex,
    extractOmml: extractOmml,
    applyMathTokens: applyMathTokens,
    styleRules: STYLE_RULES
  };

  global.Docx = Docx;
  if (typeof module !== 'undefined' && module.exports) module.exports = Docx;
})(typeof window !== 'undefined' ? window : globalThis);
