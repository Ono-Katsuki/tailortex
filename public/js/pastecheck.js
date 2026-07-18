/* ==========================================================
   pastecheck.js — コピペ検査 (Agent-Verify / フェーズ8b)
   window.PasteAudit = { record, check }
   - record(text): 貼り付け監査ログ。200文字以上のみ、文書ごと localStorage
     'wordtex-pastelog'(上限100件)に {time, chars, hash16, head80} を記録。
     editor.js の paste 処理から window.PasteAudit && window.PasteAudit.record(text) で呼ぶ。
   - check(): 校閲タブ「コピペ検査」(data-command="checkPaste") で実行。
     貼り付け履歴 + 文書内重複(完全一致 / 80文字共通部分文字列)を #paste-check-dialog に表示。
   パネルの開閉は ui.js。本ファイルは中身の描画のみ。
   ========================================================== */
(function () {
  'use strict';

  var LOG_KEY = 'wordtex-pastelog';
  var MIN_CHARS = 200;
  var MAX_LOG = 100;
  var DUP_MIN = 80;     // 共通部分文字列のしきい値(文字)
  var EXACT_MIN = 40;   // 完全一致とみなす最小段落長(自明な短文を除外)

  function byId(id) { return document.getElementById(id); }
  function announce(msg) {
    if (window.A11y && typeof window.A11y.announce === 'function') window.A11y.announce(msg);
  }

  function currentDocId() {
    try {
      if (window.App && window.App.docs && typeof window.App.docs.currentId === 'function') {
        return window.App.docs.currentId() || '_';
      }
    } catch (e) {}
    return '_';
  }

  /* ---------- localStorage ---------- */

  function loadAll() {
    try {
      var raw = localStorage.getItem(LOG_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }
  function saveAll(obj) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(obj)); }
    catch (e) { /* QuotaExceeded 等は握りつぶす(編集は止めない) */ }
  }
  function logFor(docId) {
    var all = loadAll();
    return Array.isArray(all[docId]) ? all[docId] : [];
  }

  /* ---------- sha256 先頭16 ---------- */

  function sha256Head16(text) {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      try {
        var data = new TextEncoder().encode(text);
        return window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
          var arr = Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return ('0' + b.toString(16)).slice(-2);
          });
          return arr.join('').slice(0, 16);
        }).catch(function () { return fallbackHash(text); });
      } catch (e) { /* fallthrough */ }
    }
    return Promise.resolve(fallbackHash(text));
  }
  // SubtleCrypto 不可時の簡易ハッシュ(FNV-1a を2本連結して16桁)
  function fallbackHash(text) {
    function fnv(seed) {
      var h = seed >>> 0;
      for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return ('00000000' + h.toString(16)).slice(-8);
    }
    return fnv(0x811c9dc5) + fnv(0x01000193);
  }

  /* ---------- 記録 (editor.js から1行呼び出し) ---------- */

  function record(text) {
    if (typeof text !== 'string') return;
    var chars = text.length;
    if (chars < MIN_CHARS) return;
    var head80 = text.slice(0, 80);
    var docId = currentDocId();
    // ハッシュは非同期。確定後にまとめて保存。
    Promise.resolve(sha256Head16(text)).then(function (hash16) {
      var all = loadAll();
      var arr = Array.isArray(all[docId]) ? all[docId] : [];
      arr.push({ time: new Date().toISOString(), chars: chars, hash16: hash16, head80: head80 });
      if (arr.length > MAX_LOG) arr = arr.slice(arr.length - MAX_LOG);
      all[docId] = arr;
      saveAll(all);
    });
  }

  /* ---------- 相対時刻 ---------- */

  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var diff = Math.floor((Date.now() - t) / 1000);
    if (diff < 60) return diff + ' 秒前';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 時間前';
    var d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ---------- ブロック収集・正規化 ---------- */

  function normText(s) {
    return String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  }
  function collectBlocks() {
    var d = byId('doc');
    if (!d) return [];
    var out = [];
    Array.prototype.forEach.call(d.children, function (el) {
      if (el.nodeType !== 1) return;
      if (el.classList && el.classList.contains('bibliography')) return; // 自動生成物は除外
      var raw = el.textContent || '';
      var t = normText(raw);
      if (t.length >= 12) out.push({ el: el, norm: t, raw: raw });
    });
    return out;
  }

  /* ---------- ジャンプ (a11y-jump-highlight を再利用) ---------- */

  var lastHi = null;
  function clearHi() { if (lastHi) { lastHi.classList.remove('a11y-jump-highlight'); lastHi = null; } }
  function jumpTo(el) {
    if (!el) return;
    clearHi();
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    el.classList.add('a11y-jump-highlight');
    lastHi = el;
    setTimeout(clearHi, 2400);
  }
  function findBlockContaining(needle) {
    var d = byId('doc');
    if (!d || !needle) return null;
    var blocks = collectBlocks();
    for (var i = 0; i < blocks.length; i++) {
      if ((blocks[i].raw || '').indexOf(needle) >= 0) return blocks[i].el;
    }
    return null;
  }

  /* ---------- 重複検出 ---------- */

  function detectDuplicates(blocks) {
    var pairs = [];
    var seenPair = {};
    function addPair(i, j, kind, sample) {
      var key = Math.min(i, j) + '-' + Math.max(i, j);
      if (seenPair[key]) return;
      seenPair[key] = true;
      pairs.push({ a: blocks[i].el, b: blocks[j].el, kind: kind, sample: sample });
    }

    // (a) 完全一致段落
    var exact = {};
    blocks.forEach(function (b, i) {
      if (b.norm.length < EXACT_MIN) return;
      if (!exact[b.norm]) exact[b.norm] = [];
      exact[b.norm].push(i);
    });
    Object.keys(exact).forEach(function (k) {
      var idxs = exact[k];
      for (var a = 0; a < idxs.length; a++) {
        for (var c = a + 1; c < idxs.length; c++) {
          addPair(idxs[a], idxs[c], 'exact', k.slice(0, 60));
        }
      }
    });

    // (b) 80文字以上の共通部分文字列
    // 各ブロックの 80 文字シングルを Map に登録し、先に登録済みの別ブロックと衝突したらペア確定。
    var TOTAL_CAP = 200000; // 過大文書の保護
    var totalLen = blocks.reduce(function (s, b) { return s + b.norm.length; }, 0);
    if (totalLen <= TOTAL_CAP) {
      var shingle = {};
      for (var bi = 0; bi < blocks.length; bi++) {
        var t = blocks[bi].norm;
        if (t.length < DUP_MIN) continue;
        var localSeen = {};
        for (var k = 0; k + DUP_MIN <= t.length; k++) {
          var sub = t.substr(k, DUP_MIN);
          var owner = shingle[sub];
          if (owner !== undefined && owner !== bi) {
            addPair(owner, bi, 'substr', sub.slice(0, 60));
            break; // このブロックは1ペア見つければ十分
          }
          if (!localSeen[sub]) { shingle[sub] = bi; localSeen[sub] = 1; }
        }
      }
    }
    return pairs;
  }

  /* ---------- 描画 ---------- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function check() {
    var list = byId('paste-check-results');
    var panel = byId('paste-check-dialog');
    if (!list) return;
    if (panel) panel.hidden = false;
    clearHi();
    list.innerHTML = '';

    var docId = currentDocId();
    var log = logFor(docId).slice().sort(function (a, b) {
      return Date.parse(b.time) - Date.parse(a.time);
    });
    var blocks = collectBlocks();
    var dups = detectDuplicates(blocks);

    // ---- 貼り付け履歴 ----
    var h1 = el('div', 'pc-section-title', '大きな貼り付け履歴 (' + log.length + ' 件)');
    list.appendChild(h1);
    if (!log.length) {
      list.appendChild(el('div', 'pc-note', '200 文字以上の貼り付けは記録されていません。'));
    } else {
      log.forEach(function (rec) {
        var present = !!findBlockContaining(rec.head80);
        var item = el('button', 'ap-item pc-item ' + (present ? 'vc-info' : 'vc-muted'));
        item.type = 'button';
        var head = el('span', 'ap-item-title',
          rec.chars + ' 文字 · ' + relTime(rec.time) + (present ? ' · 本文にあり' : ' · 本文になし'));
        var det = el('span', 'ap-item-detail', (rec.head80 || '').replace(/\s+/g, ' ').slice(0, 70) + '…');
        item.appendChild(head);
        item.appendChild(det);
        if (present) {
          item.title = 'クリックで本文へジャンプ';
          item.addEventListener('click', function () { jumpTo(findBlockContaining(rec.head80)); });
        } else {
          item.disabled = false;
          item.style.cursor = 'default';
        }
        list.appendChild(item);
      });
    }

    // ---- 重複ブロック ----
    var h2 = el('div', 'pc-section-title', '文書内の重複 (' + dups.length + ' 組)');
    list.appendChild(h2);
    if (!dups.length) {
      list.appendChild(el('div', 'pc-note', '重複するブロックは見つかりませんでした。'));
    } else {
      dups.forEach(function (p, i) {
        var item = el('button', 'ap-item pc-item vc-warn');
        item.type = 'button';
        item.title = 'クリックで該当箇所へジャンプ';
        var kind = p.kind === 'exact' ? '完全一致の段落' : '80 文字以上の共通部分';
        item.appendChild(el('span', 'ap-item-title', (i + 1) + '. ' + kind));
        item.appendChild(el('span', 'ap-item-detail', '「' + (p.sample || '').slice(0, 50) + '…」'));
        var flip = false;
        item.addEventListener('click', function () { jumpTo(flip ? p.a : p.b); flip = !flip; });
        list.appendChild(item);
      });
    }

    // ---- サマリ ----
    var big = log.length, m = dups.length;
    var sum = el('div', 'pc-summary');
    if (!big && !m) {
      list.insertBefore(el('div', 'ap-empty', '問題は見つかりませんでした'), list.firstChild);
      announce('コピペ検査完了。問題は見つかりませんでした');
    } else {
      sum.textContent = '大きな貼り付け ' + big + ' 件 / 重複ブロック ' + m + ' 組';
      list.insertBefore(sum, list.firstChild);
      announce('コピペ検査完了。大きな貼り付け ' + big + ' 件、重複ブロック ' + m + ' 組');
    }

    var first = list.querySelector('.pc-item') || list.querySelector('.ap-empty');
    if (first && first.focus) { try { first.focus(); } catch (e) {} }
  }

  /* ---------- checkPaste を document レベルで捕捉 ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-command="checkPaste"]');
    if (btn) setTimeout(check, 0);
  });

  window.PasteAudit = { record: record, check: check };
})();
