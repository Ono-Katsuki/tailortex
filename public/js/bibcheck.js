/* ==========================================================
   bibcheck.js — 文献情報の DOI 照合 (Agent-Verify / フェーズ8a)
   window.BibCheck = { run }
   - 参考資料タブ / 資料文献の管理ダイアログの「文献の検証」(data-command="checkBib")
     を document レベルで捕捉し、各エントリを Crossref (サーバープロキシ経由) で照合。
   - #bib-check-dialog の開閉は ui.js。本ファイルは中身の描画のみ。
   script 順: app.js の後。App.bib / A11y の公開 API のみを使用。
   ========================================================== */
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }
  function announce(msg) {
    if (window.A11y && typeof window.A11y.announce === 'function') window.A11y.announce(msg);
  }

  var TITLE_MATCH = 0.85;   // これ未満で不一致扱い
  var DOI_CANDIDATE = 0.90; // これ以上で DOI 候補提案

  /* ---------- 文字列正規化・類似度 ---------- */

  function normalize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s　]+/g, ' ')
      .replace(/[^\p{L}\p{N} ]+/gu, '')
      .trim();
  }

  // Sørensen–Dice 係数 (文字バイグラム)
  function similarity(a, b) {
    var na = normalize(a).replace(/ /g, '');
    var nb = normalize(b).replace(/ /g, '');
    if (!na.length && !nb.length) return 1;
    if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
    var bg = {}, i, total = 0, match = 0;
    for (i = 0; i < na.length - 1; i++) {
      var g = na.substr(i, 2);
      bg[g] = (bg[g] || 0) + 1;
    }
    for (i = 0; i < nb.length - 1; i++) {
      var h = nb.substr(i, 2);
      if (bg[h] > 0) { bg[h]--; match++; }
    }
    total = (na.length - 1) + (nb.length - 1);
    return (2 * match) / total;
  }

  /* ---------- BibTeX の著者 → 姓の集合 ---------- */

  function bibAuthorFamilies(author) {
    if (!author) return [];
    return String(author).split(/\s+and\s+/i).map(function (a) {
      a = a.trim();
      if (!a) return '';
      if (a.indexOf(',') >= 0) return a.split(',')[0].trim();      // "Family, Given"
      var parts = a.split(/\s+/);
      return parts[parts.length - 1];                              // "Given Family"
    }).filter(Boolean);
  }

  /* ---------- Crossref message → 正規化メタ ---------- */

  function parseCrossref(msg) {
    if (!msg) return null;
    var year = '';
    var dp = (msg.issued && msg.issued['date-parts']) ||
      (msg['published-print'] && msg['published-print']['date-parts']) ||
      (msg['published-online'] && msg['published-online']['date-parts']) ||
      (msg['published'] && msg['published']['date-parts']);
    if (dp && dp[0] && dp[0][0]) year = String(dp[0][0]);
    return {
      title: (msg.title && msg.title[0]) || '',
      year: year,
      container: (msg['container-title'] && msg['container-title'][0]) || '',
      families: (msg.author || []).map(function (a) { return a.family || a.name || ''; }).filter(Boolean),
      doi: msg.DOI || '',
      type: msg.type || ''
    };
  }

  /* ---------- fetch ラッパ ---------- */

  function fetchJson(url) {
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
      return r.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
        return { status: r.status, ok: r.ok, body: body };
      });
    });
  }

  function fetchMeta(doi) {
    return fetchJson('/doi-meta?doi=' + encodeURIComponent(doi));
  }
  function fetchSearch(q) {
    return fetchJson('/doi-search?q=' + encodeURIComponent(q));
  }

  /* ---------- 1 エントリの照合 ---------- */

  // 結果: { status:'match'|'mismatch'|'candidate'|'unresolved'|'error'|'network',
  //         diffs:[{field,label,bib,official}], official, candidate, message }
  function verifyEntry(entry) {
    var f = entry.fields || {};
    var doi = (f.doi || f.DOI || '').trim();
    var title = f.title || '';
    var bibYear = (f.year || '').replace(/[^0-9]/g, '');
    var container = f.journal || f.booktitle || '';

    if (doi) {
      return fetchMeta(doi).then(function (r) {
        if (r.status === 404) {
          return { status: 'error', message: 'DOI が見つかりません (404)' };
        }
        if (r.status === 504) return { status: 'network', message: 'タイムアウト' };
        if (!r.ok || !r.body || !r.body.message) {
          return { status: r.status >= 500 || r.status === 502 ? 'network' : 'error',
            message: 'Crossref 応答エラー (' + r.status + ')' };
        }
        var off = parseCrossref(r.body.message);
        var sim = similarity(title, off.title);
        var diffs = [];
        if (sim < TITLE_MATCH) {
          diffs.push({ field: 'title', label: 'タイトル', bib: title, official: off.title });
        }
        if (off.year && bibYear && off.year !== bibYear) {
          diffs.push({ field: 'year', label: '発行年', bib: f.year, official: off.year });
        } else if (off.year && !bibYear) {
          diffs.push({ field: 'year', label: '発行年', bib: '(未設定)', official: off.year });
        }
        // 著者姓の重なりが皆無なら差分として提示 (タイトル一致時の情報)
        var bibFam = bibAuthorFamilies(f.author).map(normalize);
        var offFam = off.families.map(normalize);
        if (bibFam.length && offFam.length) {
          var overlap = bibFam.some(function (x) {
            return offFam.some(function (y) { return x === y || similarity(x, y) >= 0.9; });
          });
          if (!overlap) {
            diffs.push({ field: 'author', label: '著者',
              bib: bibAuthorFamilies(f.author).join(', '),
              official: off.families.join(', ') });
          }
        }
        if (container && off.container) {
          if (similarity(container, off.container) < 0.6) {
            diffs.push({ field: 'container', label: '掲載誌/会議', bib: container, official: off.container });
          }
        }
        var mismatch = (sim < TITLE_MATCH) ||
          diffs.some(function (d) { return d.field === 'year'; });
        return { status: mismatch ? 'mismatch' : 'match', diffs: diffs, official: off };
      }).catch(function () {
        return { status: 'network', message: 'ネットワーク不可' };
      });
    }

    // DOI 未設定 → タイトルで検索
    if (!title) {
      return Promise.resolve({ status: 'unresolved', message: 'DOI もタイトルも未設定' });
    }
    return fetchSearch(title).then(function (r) {
      if (r.status === 504) return { status: 'network', message: 'タイムアウト' };
      if (!r.ok || !r.body || !r.body.message || !r.body.message.items) {
        return { status: r.status >= 500 || r.status === 502 ? 'network' : 'unresolved',
          message: '検索結果なし (' + r.status + ')' };
      }
      var items = r.body.message.items;
      if (!items.length) return { status: 'unresolved', message: 'DOI 未設定・自動特定不可' };
      var best = null, bestSim = -1;
      items.forEach(function (it) {
        var t = (it.title && it.title[0]) || '';
        var s = similarity(title, t);
        if (s > bestSim) { bestSim = s; best = parseCrossref(it); }
      });
      if (best && bestSim >= DOI_CANDIDATE && best.doi) {
        return { status: 'candidate', candidate: best, sim: bestSim };
      }
      return { status: 'unresolved', message: 'DOI 未設定・自動特定不可 (最上位候補 類似度 ' + Math.round(bestSim * 100) + '%)' };
    }).catch(function () {
      return { status: 'network', message: 'ネットワーク不可' };
    });
  }

  /* ---------- 描画 ---------- */

  var STATUS_META = {
    match: { icon: '✓', cls: 'vc-ok', label: '一致' },
    mismatch: { icon: '⚠', cls: 'vc-warn', label: '不一致' },
    candidate: { icon: '🔍', cls: 'vc-info', label: 'DOI 候補' },
    unresolved: { icon: '—', cls: 'vc-muted', label: '未確認' },
    error: { icon: '✗', cls: 'vc-err', label: '取得失敗' },
    network: { icon: '✗', cls: 'vc-err', label: 'ネットワーク不可' },
    pending: { icon: '…', cls: 'vc-muted', label: '照合中' }
  };

  function entryHeadLine(entry) {
    var f = entry.fields || {};
    var au = bibAuthorFamilies(f.author);
    var auTxt = au.length ? (au[0] + (au.length > 1 ? ' 他' : '')) : '著者不明';
    return '[' + entry.key + '] ' + auTxt + (f.year ? ' (' + f.year + ')' : '');
  }

  function makeRow(entry) {
    var row = document.createElement('div');
    row.className = 'bc-row';
    row.innerHTML =
      '<div class="bc-row-head">' +
      '<span class="bc-badge vc-muted" aria-hidden="true">…</span>' +
      '<span class="bc-key"></span>' +
      '<span class="bc-state">照合中…</span>' +
      '</div>' +
      '<div class="bc-title"></div>' +
      '<div class="bc-body"></div>';
    row.querySelector('.bc-key').textContent = entryHeadLine(entry);
    row.querySelector('.bc-title').textContent = (entry.fields && entry.fields.title) || '(タイトルなし)';
    return row;
  }

  function persistDoc() {
    // App.bib.entries() はエントリ実体への参照を含む配列。フィールドを in-place で
    // 書き換えた後、#doc へ input を発火して autosave (saveNow) を促す。
    if (window.App && window.App.bib && typeof window.App.bib.renderMenus === 'function') {
      window.App.bib.renderMenus();
    }
    var d = byId('doc');
    if (d) { try { d.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} }
  }

  function renderResult(row, entry, res, rerun) {
    var meta = STATUS_META[res.status] || STATUS_META.error;
    var badge = row.querySelector('.bc-badge');
    var state = row.querySelector('.bc-state');
    var body = row.querySelector('.bc-body');
    badge.className = 'bc-badge ' + meta.cls;
    badge.textContent = meta.icon;
    state.className = 'bc-state ' + meta.cls;
    state.textContent = meta.label;
    body.innerHTML = '';

    if (res.status === 'mismatch' && res.diffs && res.diffs.length) {
      var dl = document.createElement('div');
      dl.className = 'bc-diffs';
      res.diffs.forEach(function (df) {
        var item = document.createElement('div');
        item.className = 'bc-diff';
        item.innerHTML =
          '<span class="bc-diff-label"></span>' +
          '<span class="bc-diff-bib"><b>bib:</b> <span></span></span>' +
          '<span class="bc-diff-off"><b>Crossref:</b> <span></span></span>';
        item.querySelector('.bc-diff-label').textContent = df.label;
        item.querySelector('.bc-diff-bib span').textContent = df.bib || '(なし)';
        item.querySelector('.bc-diff-off span').textContent = df.official || '(なし)';
        dl.appendChild(item);
      });
      body.appendChild(dl);
      var applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'bc-apply';
      applyBtn.textContent = '公式値を反映';
      applyBtn.addEventListener('click', function () {
        var f = entry.fields || (entry.fields = {});
        var off = res.official || {};
        res.diffs.forEach(function (df) {
          if (df.field === 'title' && off.title) f.title = off.title;
          else if (df.field === 'year' && off.year) f.year = off.year;
          else if (df.field === 'container' && off.container) {
            if (f.journal != null) f.journal = off.container;
            else if (f.booktitle != null) f.booktitle = off.container;
            else f.journal = off.container;
          }
          // 著者は表記揺れが大きいため自動上書きしない
        });
        if (off.doi && !f.doi) f.doi = off.doi;
        persistDoc();
        announce('[' + entry.key + '] に公式値を反映しました');
        if (rerun) rerun();
      });
      body.appendChild(applyBtn);
    } else if (res.status === 'candidate' && res.candidate) {
      var info = document.createElement('div');
      info.className = 'bc-cand';
      info.innerHTML = '<span>DOI 候補: <code></code> — <span class="bc-cand-t"></span> (' +
        Math.round((res.sim || 0) * 100) + '%)</span>';
      info.querySelector('code').textContent = res.candidate.doi;
      info.querySelector('.bc-cand-t').textContent = res.candidate.title || '';
      body.appendChild(info);
      var adopt = document.createElement('button');
      adopt.type = 'button';
      adopt.className = 'bc-apply';
      adopt.textContent = '採用';
      adopt.addEventListener('click', function () {
        var f = entry.fields || (entry.fields = {});
        f.doi = res.candidate.doi;
        persistDoc();
        announce('[' + entry.key + '] に DOI を採用しました');
        if (rerun) rerun();
      });
      body.appendChild(adopt);
    } else if (res.message) {
      var msg = document.createElement('div');
      msg.className = 'bc-msg';
      msg.textContent = res.message;
      body.appendChild(msg);
    }
  }

  /* ---------- 並列2の逐次実行 ---------- */

  function runQueue(entries, rows, onDone) {
    var counts = { match: 0, mismatch: 0, candidate: 0, unresolved: 0, error: 0, network: 0 };
    var idx = 0, active = 0, finished = 0;
    var total = entries.length;

    function rerunFactory(i) {
      return function () {
        verifyEntry(entries[i]).then(function (res) {
          renderResult(rows[i], entries[i], res, rerunFactory(i));
        });
      };
    }

    function pump() {
      while (active < 2 && idx < total) {
        (function (i) {
          active++;
          verifyEntry(entries[i]).then(function (res) {
            renderResult(rows[i], entries[i], res, rerunFactory(i));
            counts[res.status] = (counts[res.status] || 0) + 1;
          }).catch(function () {
            renderResult(rows[i], entries[i], { status: 'error', message: '内部エラー' });
            counts.error++;
          }).then(function () {
            active--; finished++;
            var sum = byId('bib-check-summary');
            if (sum) sum.textContent = '照合中… ' + finished + ' / ' + total;
            if (finished >= total) onDone(counts);
            else pump();
          });
        })(idx++);
      }
    }
    pump();
  }

  /* ---------- エントリポイント ---------- */

  function run() {
    var list = byId('bib-check-list');
    var summary = byId('bib-check-summary');
    if (!list) return;
    list.innerHTML = '';

    var entries = (window.App && window.App.bib && typeof window.App.bib.entries === 'function')
      ? window.App.bib.entries() : [];

    if (!entries.length) {
      if (summary) summary.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'bc-empty';
      empty.textContent = '検証する資料文献がありません。「資料文献の管理」から追加してください。';
      list.appendChild(empty);
      announce('検証する文献がありません');
      return;
    }

    var rows = entries.map(function (e) {
      var r = makeRow(e);
      list.appendChild(r);
      return r;
    });
    if (summary) summary.textContent = '照合中… 0 / ' + entries.length;

    runQueue(entries, rows, function (counts) {
      var y = counts.candidate + counts.unresolved + counts.error + counts.network;
      if (summary) {
        summary.textContent = entries.length + ' 件中: 一致 ' + counts.match +
          ' / 不一致 ' + counts.mismatch + ' / 未確認 ' + y;
      }
      announce('文献の検証が完了しました。一致 ' + counts.match +
        ' 件、不一致 ' + counts.mismatch + ' 件、未確認 ' + y + ' 件');
    });
  }

  /* ---------- checkBib を document レベルで捕捉 (Editor 非依存) ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-command="checkBib"]');
    if (btn) {
      // ダイアログの開閉は ui.js。描画開始まで少し待ってから実行。
      setTimeout(run, 0);
    }
  });

  window.BibCheck = { run: run, _similarity: similarity };
})();
