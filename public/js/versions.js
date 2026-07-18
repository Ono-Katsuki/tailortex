/* versions.js — バージョン履歴ストア (window.Versions)
 * localStorage `wordtex-versions`: { [docId]: [{vid, time, kind, charCount, html, comments, bib}] }
 * 上限は文書ごと 20 版 (超過時は古い auto から間引き、manual を優先保持)。
 * QuotaExceeded 時は最古版から削除して再試行、諦める場合は console.warn のみ。
 * DOM 契約: SPEC.md「フェーズ3.5: バージョン履歴」
 */
(function () {
  'use strict';

  var KEY = 'wordtex-versions';
  var MAX = 20;

  function loadAll() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }

  function writeAll(all) {
    // 失敗時は QuotaExceededError を投げる (呼び出し側で処理)
    localStorage.setItem(KEY, JSON.stringify(all));
  }

  function genVid() {
    return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function nowIso() { return new Date().toISOString(); }

  // 現在の #doc からスナップショット素材を取得
  function liveSnap() {
    var d = document.getElementById('doc');
    var html = d ? d.innerHTML : '';
    var comments = {};
    if (window.Editor && typeof window.Editor.getCommentMap === 'function') {
      try { comments = window.Editor.getCommentMap() || {}; } catch (e) { comments = {}; }
    }
    var bib = [];
    if (window.App && window.App.bib && typeof window.App.bib.entries === 'function') {
      try { bib = window.App.bib.entries() || []; } catch (e) { bib = []; }
    }
    var charCount = d ? (d.textContent || '').replace(/[\n​]/g, '').length : 0;
    return { html: html, comments: comments, bib: bib, charCount: charCount };
  }

  // list を MAX 以下に間引く。古い auto を優先削除、無ければ最古を削除。
  function pruneList(list) {
    while (list.length > MAX) {
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].kind === 'auto') { idx = i; break; }
      }
      if (idx < 0) idx = 0;
      list.splice(idx, 1);
    }
    return list;
  }

  // 全文書を通して最古の版を 1 件削除。削除できたら true。
  function removeOldestAnywhere(all) {
    var bestDoc = null, bestIdx = -1, bestTime = Infinity;
    Object.keys(all).forEach(function (docId) {
      var list = all[docId];
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var t = new Date(list[i].time).getTime() || 0;
        if (t < bestTime) { bestTime = t; bestDoc = docId; bestIdx = i; }
      }
    });
    if (bestDoc == null || bestIdx < 0) return false;
    all[bestDoc].splice(bestIdx, 1);
    if (!all[bestDoc].length) delete all[bestDoc];
    return true;
  }

  // all を保存。QuotaExceeded 時は最古版から削除して再試行。
  // 保存に成功したら true。全部消しても無理なら console.warn して false。
  function persist(all) {
    try { writeAll(all); return true; }
    catch (e) {
      var guard = 0;
      while (guard++ < 100000) {
        if (!removeOldestAnywhere(all)) break;
        try { writeAll(all); return true; } catch (e2) { /* retry */ }
      }
      try { console.warn('Versions: localStorage の上限のためバージョンを保存できませんでした。'); } catch (_) {}
      return false;
    }
  }

  function snapshot(docId, kind, snap) {
    if (!docId) return null;
    snap = snap || liveSnap();
    var all = loadAll();
    var list = all[docId];
    if (!Array.isArray(list)) { list = []; all[docId] = list; }

    // 直前版と html が同一ならスキップ
    if (list.length && list[list.length - 1].html === snap.html) {
      return list[list.length - 1];
    }

    var v = {
      vid: genVid(),
      time: nowIso(),
      kind: (kind === 'manual') ? 'manual' : 'auto',
      charCount: snap.charCount || 0,
      html: snap.html || '',
      comments: snap.comments || {},
      bib: snap.bib || []
    };
    list.push(v);
    pruneList(list);
    persist(all);

    // 保存後、新版が (Quota 対策で) 消えていたら諦め扱い。
    var saved = loadAll()[docId] || [];
    var kept = false;
    for (var i = 0; i < saved.length; i++) { if (saved[i].vid === v.vid) { kept = true; break; } }
    if (!kept) {
      try { console.warn('Versions: 容量不足のため新しいバージョンを保存できませんでした。'); } catch (_) {}
      return null;
    }
    return v;
  }

  function list(docId) {
    var all = loadAll();
    var arr = all[docId];
    if (!Array.isArray(arr)) return [];
    // 新しい順で返す
    return arr.slice().sort(function (a, b) {
      return (new Date(b.time).getTime() || 0) - (new Date(a.time).getTime() || 0);
    });
  }

  function get(docId, vid) {
    var all = loadAll();
    var arr = all[docId];
    if (!Array.isArray(arr)) return null;
    for (var i = 0; i < arr.length; i++) if (arr[i].vid === vid) return arr[i];
    return null;
  }

  // restore は「選択版の中身」を返すだけ (DOM への反映は app.js が担当)。
  function restore(docId, vid) { return get(docId, vid); }

  function prune(docId) {
    var all = loadAll();
    if (Array.isArray(all[docId])) { pruneList(all[docId]); persist(all); }
  }

  function removeDoc(docId) {
    var all = loadAll();
    if (all[docId]) { delete all[docId]; persist(all); }
  }

  window.Versions = {
    snapshot: snapshot,
    list: list,
    get: get,
    restore: restore,
    prune: prune,
    removeDoc: removeDoc
  };
})();
