/* bib.js — BibTeX パーサ / シリアライザ (window.Bib)
 * フェーズ3b。ブラウザ専用 API に依存しない純粋関数として実装し、
 * Node からも単体テストできる(module.exports フォールバック付き)。
 *
 *   window.Bib = { parse(bibText) -> entries[], serialize(entries) -> bibText,
 *                  formatLabel(entry) -> string }
 *   entries: { key, type, fields: { author, title, year, journal, ... } }
 *
 * 仕様:
 *   @type{key, field = {値} | "値" | 数値, ... } 形式。
 *   ネスト波括弧・@comment・@string・複数エントリに対応。
 *   壊れたエントリはスキップして続行(例外を投げない)。
 */
(function (global) {
  'use strict';

  var WS_RE = /\s/;

  // 値内部の余分な空白・改行を 1 スペースに畳む(ネスト波括弧は保持)。
  // これにより parse -> serialize -> parse が安定して同値になる。
  function cleanValue(v) {
    return String(v).replace(/[\s\r\n]+/g, ' ').trim();
  }

  // s[i] が波括弧グループ '{' の開始位置と仮定して、対応する '}' の
  // 直後の位置と内部文字列を返す。
  function readBraced(s, i) {
    var n = s.length;
    var depth = 0;
    var start = i + 1;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return { value: s.slice(start, i), next: i + 1 };
      }
      i++;
    }
    // 閉じ括弧が無い壊れた入力: 残り全部を値とする
    return { value: s.slice(start), next: n };
  }

  function readQuoted(s, i) {
    var n = s.length;
    var depth = 0;
    var start = i + 1;
    i++;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth > 0) depth--; }
      else if (ch === '"' && depth === 0) return { value: s.slice(start, i), next: i + 1 };
      i++;
    }
    return { value: s.slice(start), next: n };
  }

  // 生値(bareword / 数値)。次の , または } まで。
  function readBare(s, i) {
    var n = s.length;
    var start = i;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === ',' || ch === '}') break;
      i++;
    }
    return { value: s.slice(start, i).trim(), next: i };
  }

  function readValue(s, i) {
    var n = s.length;
    while (i < n && WS_RE.test(s.charAt(i))) i++;
    if (i >= n) return { value: '', next: n };
    var ch = s.charAt(i);
    var r;
    if (ch === '{') { r = readBraced(s, i); }
    else if (ch === '"') { r = readQuoted(s, i); }
    else { r = readBare(s, i); }
    // "abc" # {def} のような連結は簡略化して最初の断片のみ採用
    return { value: cleanValue(r.value), next: r.next };
  }

  // トップレベル(波括弧の外)の次のカンマ直後まで読み飛ばす(壊れフィールド用)
  function skipToComma(s, i) {
    var n = s.length;
    var depth = 0;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth > 0) depth--; else return i; }
      else if (ch === ',' && depth === 0) return i + 1;
      i++;
    }
    return n;
  }

  function parseFields(s) {
    var fields = {};
    var i = 0;
    var n = s.length;
    while (i < n) {
      while (i < n && (WS_RE.test(s.charAt(i)) || s.charAt(i) === ',')) i++;
      if (i >= n) break;
      // フィールド名
      var ns = i;
      while (i < n) {
        var ch = s.charAt(i);
        if (ch === '=' || ch === ',' || WS_RE.test(ch)) break;
        i++;
      }
      var name = s.slice(ns, i).trim().toLowerCase();
      while (i < n && WS_RE.test(s.charAt(i))) i++;
      if (s.charAt(i) !== '=') {
        // 名前だけで = が無い壊れフィールド → 次のカンマまでスキップ
        i = skipToComma(s, i);
        continue;
      }
      i++; // '='
      var r = readValue(s, i);
      if (name) fields[name] = r.value;
      i = r.next;
    }
    return fields;
  }

  function parse(text) {
    var entries = [];
    var s = String(text == null ? '' : text);
    var n = s.length;
    var i = 0;
    while (i < n) {
      var at = s.indexOf('@', i);
      if (at === -1) break;
      i = at + 1;
      // エントリ種別
      var ts = i;
      while (i < n && /[A-Za-z]/.test(s.charAt(i))) i++;
      var type = s.slice(ts, i).toLowerCase();
      if (!type) { continue; }
      while (i < n && WS_RE.test(s.charAt(i))) i++;
      var open = s.charAt(i);
      if (open !== '{' && open !== '(') { continue; }
      var close = open === '{' ? '}' : ')';
      i++; // 開き括弧を消費

      // エントリ本文を対応する閉じ括弧まで取り出す(波括弧の入れ子を追跡)
      var bodyStart = i;
      var depth = 0;
      while (i < n) {
        var ch = s.charAt(i);
        if (ch === '{') depth++;
        else if (ch === '}') {
          if (depth > 0) depth--;
          else if (close === '}') break;
        } else if (ch === close && depth === 0) break;
        i++;
      }
      var body = s.slice(bodyStart, i);
      if (i < n) i++; // 閉じ括弧を消費

      if (type === 'comment' || type === 'preamble' || type === 'string') {
        continue; // これらは文献エントリではない
      }

      // 本文: key, フィールド...
      var comma = body.indexOf(',');
      var key, rest;
      if (comma === -1) { key = body.trim(); rest = ''; }
      else { key = body.slice(0, comma).trim(); rest = body.slice(comma + 1); }
      // key が無い / 空白や = を含む(= key の後に , が無い等の壊れエントリ)→ スキップ
      if (!key || /[\s=]/.test(key)) continue;

      entries.push({ key: key, type: type, fields: parseFields(rest) });
    }
    return entries;
  }

  // フィールドの標準的な出力順(存在するものだけ)
  var FIELD_ORDER = [
    'author', 'title', 'journal', 'booktitle', 'publisher', 'editor',
    'volume', 'number', 'pages', 'year', 'month', 'address',
    'organization', 'school', 'institution', 'note', 'url', 'doi'
  ];

  function orderedFieldKeys(fields) {
    var keys = Object.keys(fields || {});
    var seen = {};
    var out = [];
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      var k = FIELD_ORDER[i];
      if (Object.prototype.hasOwnProperty.call(fields, k)) { out.push(k); seen[k] = true; }
    }
    for (var j = 0; j < keys.length; j++) {
      if (!seen[keys[j]]) out.push(keys[j]);
    }
    return out;
  }

  function serialize(entries) {
    var list = entries || [];
    var chunks = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var type = e.type || 'misc';
      var key = e.key || ('ref' + (i + 1));
      var fields = e.fields || {};
      var fk = orderedFieldKeys(fields);
      var lines = ['@' + type + '{' + key + ','];
      var parts = [];
      for (var j = 0; j < fk.length; j++) {
        var name = fk[j];
        var val = fields[name];
        if (val == null || String(val) === '') continue;
        parts.push('  ' + name + ' = {' + String(val) + '}');
      }
      chunks.push(lines[0] + '\n' + parts.join(',\n') + (parts.length ? '\n' : '') + '}');
    }
    return chunks.join('\n\n') + (chunks.length ? '\n' : '');
  }

  // 表示用ラベル(文献目録・資料一覧)。author (year). title. journal/publisher.
  function formatLabel(entry) {
    var e = entry || {};
    var f = e.fields || {};
    var parts = [];
    if (f.author) parts.push(String(f.author).replace(/\s+and\s+/gi, ', '));
    if (f.year) parts.push('(' + f.year + ')');
    if (f.title) parts.push(stripBraces(f.title) + '.');
    var tail = f.journal || f.booktitle || f.publisher || f.url || '';
    if (tail) parts.push(stripBraces(tail) + '.');
    var s = parts.join(' ').replace(/\s+/g, ' ').trim();
    return s || e.key || '';
  }

  // 表示時のみ、値保護用の波括弧を取り除く(データ側は保持したまま)
  function stripBraces(s) {
    return String(s).replace(/[{}]/g, '');
  }

  var Bib = {
    parse: parse,
    serialize: serialize,
    formatLabel: formatLabel
  };

  if (global) global.Bib = Bib;
  if (typeof module !== 'undefined' && module.exports) module.exports = Bib;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
