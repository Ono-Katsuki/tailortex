/* uapdf.js — アクセシブルPDF (PDF/UA-2) エクスポート (フェーズ4b, Agent-UA-PDF)
 *
 * 自己完結モジュール。Editor.exec には依存せず、document レベルのクリック委譲で
 *   [data-command="exportAccessiblePdf"]  … エクスポートを開始(ダイアログを開く/prompt)
 *   [data-command="runAccessiblePdf"]     … ダイアログから実行(任意・A11y実装が使う場合)
 * を捕捉する。#uapdf-dialog(並行エージェントが作成予定)があればそこから
 * lang / title / 表の代替テキストを集め、無ければ window.prompt でフォールバックする。
 * /compile-accessible を叩き、結果バッジ表示 + PDF 自動ダウンロード、
 * window.A11y?.announce で通知する。
 */
(function () {
  'use strict';

  var BUSY = false;

  /* ---------- ユーティリティ ---------- */

  function announce(msg) {
    try { if (window.A11y && typeof window.A11y.announce === 'function') window.A11y.announce(msg); }
    catch (e) { /* ignore */ }
  }

  function utf8ToBase64(str) {
    try { return btoa(unescape(encodeURIComponent(String(str)))); }
    catch (e) { try { return btoa(String(str)); } catch (e2) { return ''; } }
  }

  // フェーズ10b: クラウドモードでサインイン中なら IDトークンを Authorization に付与。
  //   ローカルモード(Cloud 無効/未サインイン)では null が返るためヘッダは付かず挙動不変。
  function withAuthHeaders(base) {
    var h = {};
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) h[k] = base[k]; }
    var C = window.Cloud;
    if (C && C.isSignedIn && C.isSignedIn() && typeof C.getIdToken === 'function') {
      return C.getIdToken().then(function (t) {
        if (t) h['Authorization'] = 'Bearer ' + t;
        return h;
      }).catch(function () { return h; });
    }
    return Promise.resolve(h);
  }

  function docEl() { return document.getElementById('doc'); }

  function docTitle() {
    var t = document.getElementById('doc-title');
    var s = t ? String(t.textContent || '').trim() : '';
    // 「• 保存済み」等の付随表示を除去
    s = s.replace(/\s*[•·].*$/, '').trim();
    return s || '無題の文書';
  }

  var DATA_IMG_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,/;

  // generate()/collectAssets() と同じ深さ優先・文書順で、Figure になる画像の alt を集める
  function collectFigureAlts(root) {
    var alts = [];
    (function walk(n) {
      if (!n) return;
      if (n.nodeType === 1 && String(n.nodeName).toUpperCase() === 'IMG') {
        var src = n.getAttribute('src') || '';
        if (DATA_IMG_RE.test(src)) alts.push(String(n.getAttribute('alt') || ''));
      }
      var kids = n.childNodes || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(root);
    return alts;
  }

  function listTables(root) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll('table'));
  }

  /* ---------- LaTeX + assets 構築 ---------- */

  function buildPayload(lang, title, tableAlts) {
    var d = docEl();
    if (!d) throw new Error('#doc が見つかりません');
    if (!window.LatexGen || typeof window.LatexGen.generate !== 'function') {
      throw new Error('LatexGen が読み込まれていません');
    }

    var opts = (window.App && window.App.getOptions) ? window.App.getOptions() : {};
    var bibStyle = (window.App && window.App.bib && window.App.bib.getStyle) ? window.App.bib.getStyle() : 'plain';

    var latex = window.LatexGen.generate(d, {
      accessible: { lang: lang, title: title },
      toc: opts && opts.toc,
      // フェーズ30: 段組みを転送(2段×タグ付きは veraPDF UA-2 適合を実証済み。
      // 3段は latex.js 側がアクセシブル時に1段へフォールバックする。
      // 用紙・行間はタグ付きとの組合せ未検証のため転送しない=従来どおり既定)。
      columns: opts && opts.columns,
      bibStyle: bibStyle
    });

    // 画像アセット
    var assets = [];
    if (window.LatexGen.collectAssets) {
      assets = window.LatexGen.collectAssets(d).map(function (a) {
        return { name: a.name, base64: a.base64 };
      });
    }

    // 文献目録ブロックがあれば refs.bib を添付(文献0件でも空ファイルを渡す)
    if (d.querySelector && d.querySelector('.bibliography') &&
        window.Bib && typeof window.Bib.serialize === 'function' &&
        window.App && window.App.bib && window.App.bib.entries) {
      var text = window.Bib.serialize(window.App.bib.entries() || []);
      assets.push({ name: 'refs.bib', base64: utf8ToBase64(text) });
    }

    return {
      latex: latex,
      assets: assets,
      tableAlts: tableAlts || [],
      figureAlts: collectFigureAlts(d),
      lang: lang
    };
  }

  /* ---------- 入力収集(ダイアログ or prompt) ---------- */

  function readLangFromDialog(dialog) {
    var sel = dialog.querySelector('#uapdf-lang, [name="uapdf-lang"]:checked, [data-uapdf-lang]:checked, [data-uapdf-lang]');
    if (sel) {
      var v = sel.value || sel.getAttribute('data-uapdf-lang') || '';
      if (/en/i.test(v)) return 'en';
      if (/ja|jp|日本/i.test(v)) return 'ja';
    }
    // ラジオ群
    var checked = dialog.querySelector('input[type="radio"]:checked');
    if (checked && /en/i.test(checked.value)) return 'en';
    return 'ja';
  }

  function readTitleFromDialog(dialog) {
    var el = dialog.querySelector('#uapdf-title, [data-uapdf-title]');
    var v = el ? String(el.value || '').trim() : '';
    return v || docTitle();
  }

  function readTableAltsFromDialog(dialog, tableCount) {
    var areas = dialog.querySelectorAll(
      '#uapdf-table-alts textarea, [data-uapdf-table-alt], textarea[data-table-index]'
    );
    var alts = [];
    for (var i = 0; i < areas.length; i++) alts.push(String(areas[i].value || ''));
    // ダイアログに欄が無ければ空配列(サーバー側で不足分はスキップ)
    while (alts.length < tableCount) alts.push('');
    return alts.slice(0, Math.max(tableCount, alts.length));
  }

  function gatherFromDialog(dialog) {
    var tables = listTables(docEl());
    return {
      lang: readLangFromDialog(dialog),
      title: readTitleFromDialog(dialog),
      tableAlts: readTableAltsFromDialog(dialog, tables.length)
    };
  }

  function gatherFromPrompt() {
    var langIn = window.prompt('出力言語を選択してください(ja = 日本語 / en = English)', 'ja');
    if (langIn === null) return null; // キャンセル
    var lang = /en/i.test(langIn) ? 'en' : 'ja';
    var title = window.prompt('PDF のタイトル', docTitle());
    if (title === null) return null;
    title = String(title).trim() || docTitle();

    var tables = listTables(docEl());
    var tableAlts = [];
    for (var i = 0; i < tables.length; i++) {
      var a = window.prompt('表 ' + (i + 1) + ' の代替テキスト(スキップ可)', '');
      tableAlts.push(a === null ? '' : String(a));
    }
    return { lang: lang, title: title, tableAlts: tableAlts };
  }

  /* ---------- ダイアログ開閉 ---------- */

  function showDialog(dialog) {
    try {
      dialog.hidden = false;
      dialog.removeAttribute('hidden');
      dialog.setAttribute('aria-hidden', 'false');
      dialog.classList.add('open', 'is-open', 'show', 'visible');
      // 表ごとの代替テキスト欄があれば個数を合わせて自動生成(存在すれば)
      populateTableFields(dialog);
      var titleEl = dialog.querySelector('#uapdf-title, [data-uapdf-title]');
      if (titleEl && !String(titleEl.value || '').trim()) titleEl.value = docTitle();
      var focusEl = dialog.querySelector('input, select, textarea, button');
      if (focusEl && focusEl.focus) focusEl.focus();
    } catch (e) { /* ignore */ }
  }

  // #uapdf-table-alts に「テンプレ textarea」があれば表の数だけ複製する(任意機能)
  function populateTableFields(dialog) {
    var host = dialog.querySelector('#uapdf-table-alts');
    if (!host) return;
    var tables = listTables(docEl());
    // 既に十分な数の textarea があれば何もしない
    var existing = host.querySelectorAll('textarea');
    if (existing.length >= tables.length) return;
    for (var i = existing.length; i < tables.length; i++) {
      var wrap = document.createElement('label');
      wrap.style.display = 'block';
      wrap.style.margin = '6px 0';
      wrap.textContent = '表 ' + (i + 1) + ' の代替テキスト';
      var ta = document.createElement('textarea');
      ta.setAttribute('data-uapdf-table-alt', String(i));
      ta.rows = 2;
      ta.style.width = '100%';
      wrap.appendChild(ta);
      host.appendChild(wrap);
    }
  }

  /* ---------- 結果表示 ---------- */

  function resultHost(dialog) {
    if (dialog) {
      var r = dialog.querySelector('#uapdf-result');
      if (r) return r;
    }
    // 自己完結トースト
    var toast = document.getElementById('uapdf-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'uapdf-toast';
      toast.setAttribute('role', 'status');
      toast.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:99999',
        'max-width:360px', 'padding:12px 16px', 'border-radius:6px',
        'font:13px/1.5 "Yu Gothic UI","Hiragino Sans","Segoe UI",Meiryo,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'color:#fff', 'background:#185abd'
      ].join(';');
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showBadge(dialog, state, text) {
    var host = resultHost(dialog);
    var bg = state === 'pass' ? '#1a7f37' : (state === 'fail' ? '#b42318' : '#185abd');
    if (host.id === 'uapdf-toast') {
      host.style.background = bg;
      host.textContent = text;
      host.hidden = false;
      window.clearTimeout(host._t);
      host._t = window.setTimeout(function () { host.hidden = true; }, 12000);
    } else {
      host.innerHTML = '';
      var badge = document.createElement('span');
      badge.className = 'uapdf-badge uapdf-badge-' + state;
      badge.style.cssText = 'display:inline-block;padding:4px 10px;border-radius:4px;color:#fff;background:' + bg;
      badge.textContent = text;
      host.appendChild(badge);
    }
  }

  function downloadPdf(base64, title) {
    try {
      var bin = atob(base64);
      var len = bin.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var safe = String(title || 'accessible').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'accessible';
      a.href = url;
      a.download = safe + '-UA.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) { /* ignore */ }
  }

  /* ---------- 実行 ---------- */

  function runExport(input, dialog) {
    if (BUSY) return;
    if (!input) return; // キャンセル
    var payload;
    try {
      payload = buildPayload(input.lang, input.title, input.tableAlts);
    } catch (e) {
      showBadge(dialog, 'fail', 'エラー: ' + (e && e.message));
      return;
    }

    BUSY = true;
    showBadge(dialog, 'busy', 'アクセシブルPDF を生成中…(LuaLaTeX)');
    announce('アクセシブルPDFの生成を開始しました');

    withAuthHeaders({ 'Content-Type': 'application/json' }).then(function (headers) {
      return fetch('/compile-accessible', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });
    }).then(function (resp) {
      return resp.json().then(function (data) { return { status: resp.status, data: data }; });
    }).then(function (r) {
      BUSY = false;
      var data = r.data || {};
      if (r.status !== 200 || !data.pdf) {
        var msg = (r.status === 401) ? 'ログインが必要です' :
          (data && data.error === 'compile_failed') ? 'コンパイルに失敗しました' :
          (data && data.message) ? String(data.message) : ('HTTP ' + r.status);
        showBadge(dialog, 'fail', 'アクセシブルPDF 生成失敗: ' + msg);
        announce('アクセシブルPDFの生成に失敗しました');
        return;
      }

      downloadPdf(data.pdf, input.title);

      var vp = data.verapdf || {};
      if (vp.ran && vp.pass === true) {
        showBadge(dialog, 'pass', '✓ PDF/UA-2 適合 (veraPDF PASS)');
        announce('PDF/UA-2 に適合しました。PDFをダウンロードしました');
      } else if (vp.ran && vp.pass === false) {
        var fc = (vp.failedClauses || []).slice(0, 8).join(', ');
        showBadge(dialog, 'fail', 'veraPDF 非適合。失敗項目: ' + (fc || '(詳細不明)'));
        announce('veraPDFの検証に失敗しました。PDFはダウンロードしました');
      } else {
        showBadge(dialog, 'busy', 'PDF を生成しました(veraPDF 未実行のため未検証)');
        announce('PDFをダウンロードしました。veraPDFは未実行です');
      }
    }).catch(function (err) {
      BUSY = false;
      showBadge(dialog, 'fail', '通信エラー: ' + (err && err.message));
      announce('アクセシブルPDFの生成に失敗しました');
    });
  }

  /* ---------- クリック委譲 ---------- */

  function isCloseButton(btn) {
    var t = String(btn.textContent || '').trim();
    var lbl = String(btn.getAttribute('aria-label') || '');
    return /閉じる|キャンセル|cancel|close|×|✕/i.test(t + ' ' + lbl) ||
      /close|cancel|dismiss/i.test(btn.getAttribute('data-command') || '');
  }

  function looksLikeRunButton(btn, dialog) {
    if (isCloseButton(btn)) return false;
    var t = String(btn.textContent || '').trim();
    return /実行|生成|作成|エクスポート|ダウンロード|export|generate|run|create/i.test(t);
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    var cmdEl = target && target.closest ? target.closest('[data-command]') : null;
    var cmd = cmdEl ? cmdEl.getAttribute('data-command') : null;
    var dialog = document.getElementById('uapdf-dialog');

    // 明示的な実行コマンド
    if (cmd === 'runAccessiblePdf') {
      e.preventDefault();
      runExport(dialog ? gatherFromDialog(dialog) : gatherFromPrompt(), dialog);
      return;
    }

    // エクスポート開始(カード/小ボタン)
    if (cmd === 'exportAccessiblePdf') {
      e.preventDefault();
      if (dialog) {
        // ダイアログが既に開いていて、このボタンがダイアログ内なら実行扱い
        if (dialog.contains(cmdEl)) {
          runExport(gatherFromDialog(dialog), dialog);
        } else {
          showDialog(dialog);
        }
      } else {
        runExport(gatherFromPrompt(), null);
      }
      return;
    }

    // ダイアログ内の主要アクションボタン(data-command 未指定でも実行できるよう補完)
    if (dialog && dialog.contains(target)) {
      var btn = target.closest ? target.closest('button') : null;
      if (btn && !btn.hasAttribute('data-command') && looksLikeRunButton(btn, dialog)) {
        e.preventDefault();
        runExport(gatherFromDialog(dialog), dialog);
      }
    }
  }, false);
})();
