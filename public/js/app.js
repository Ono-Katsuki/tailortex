/* app.js — 統合レイヤ (window.App)
 * 初期文書投入・自動保存・コンパイル・ズーム・パネル切替・ダウンロード。
 * DOM 契約: SPEC.md「app.js の必須機能」
 */
(function () {
  'use strict';

  /* ===== ストレージキー ===== */
  var DOCS_KEY = 'wordtex-docs';        // { [id]: {title, html, comments, options, bib, bibStyle, updatedAt, charCount} }
  var CURRENT_KEY = 'wordtex-current';  // 現在の文書 id
  var OLD_DOC_KEY = 'wordtex-doc';      // フェーズ1/2 の単一文書(移行元)
  var OLD_COMMENTS_KEY = 'wordtex-comments';
  var LAST_COMPILE_KEY = 'wordtex-lastcompile';
  var THEME_KEY = 'wordtex-theme';      // フェーズ3.5: {theme:'light|dark', page:'light|dark'}

  /* ===== フェーズ3.5: テーマ / バージョン閲覧の状態 ===== */
  var theme = 'light';        // 'light' | 'dark'
  var pageTheme = 'light';    // 'light' | 'dark' (ダーク時のみ有効)
  var pageExplicit = false;   // フェーズ27: ユーザーが「ページの色を切替」で明示選択したか
  var versionViewing = false; // バージョン閲覧モード中か
  var viewingVid = null;      // 閲覧中のバージョン id
  var liveHtmlBackup = null;  // 閲覧に入る前の生 html (最新版に戻る用)
  var versionTimer = null;    // 10分ごとの自動スナップショットタイマー

  // フェーズ30: レイアウト設定を余白/向きと同じ options に統合(既定値は従来と等価な出力)。
  var options = {
    margin: 'normal', landscape: false, toc: false,
    columns: 'one', paper: 'a4', lineHeight: '1.15', paraSpace: false, lineNumbers: false
  };
  var zoomValue = 100;
  var docLanguage = 'ja';   // フェーズ11: 現在文書の言語(既定 ja=現行維持)

  // フェーズ11: I18n 未ロードでも動くラッパ。カタログに無ければ fallback を返す。
  function t(key, fallback) {
    try { return (window.I18n && typeof window.I18n.t === 'function') ? window.I18n.t(key, fallback) : fallback; }
    catch (e) { return fallback; }
  }

  /* ===== 複数文書ストア ===== */
  var store = {};            // id -> entry
  var currentId = null;
  var storeAdapter = null;   // フェーズ7: 永続化アダプタ(既定=LocalStore、ログイン時=FirestoreStore)
  var accessDocId = null;    // フェーズ14: アクセス管理ダイアログ対象の docId
  var bibEntries = [];       // 現在文書の文献リスト
  var bibStyle = 'plain';    // 現在文書の文献スタイル
  var lastCompileTime = 0;   // 最終コンパイル時刻(ms)

  var saveTimer = null;
  var lastCloudSig = null;    // フェーズ10c: 直近クラウド保存内容の署名(無変化スキップ用)
  var compileTimer = null;
  var sourceTimer = null;
  var compiling = false;
  var compileQueued = false;
  var lastPdfUrl = null;

  /* ===== フェーズ15: プロジェクト(ディレクトリ)モデル ===== */
  var PROJECT_MIGRATED_KEY = 'wordtex-migrated';
  var projectMode = false;      // サーバーの projects API が使える時のみ true
  var newlyCreatedProjects = {}; // このタブで新規作成した直後だけ初期内容の送信を許可
  var hadStoredDocs = false;    // 初回起動時に localStorage wordtex-docs が存在したか(移行判定)
  var projPushTimer = null;     // main.html/main.tex/refs.bib の PUT デバウンス
  var metaTimer = null;         // プロジェクト名リネーム(meta)デバウンス
  /* ===== フェーズ27: tex ソース編集モード ===== */
  var texMode = false;          // 中央エディタが .tex ソースを編集中か
  var texModePath = null;       // 編集中の .tex パス
  var texEditorDirty = false;   // 未保存の変更あり
  var bibEditorDirty = false;   // 下段 refs.bib の未保存変更
  var texSaveTimer = null;      // tex ソースの自動保存デバウンス
  var projectNameCache = {};    // projectId -> name(ダッシュボード表示用)
  var projDirty = false;        // git: 未コミットの変更があるか

  function byId(id) { return document.getElementById(id); }
  function doc() { return byId('doc'); }

  function genId() {
    var s = 'd';
    for (var i = 0; i < 8; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'.charAt(Math.floor(Math.random() * 36));
    return s;
  }

  function nowIso() { return new Date().toISOString(); }

  // 切り離した div で HTML からタイトル / 文字数を推定
  function titleFromHtml(html) {
    try {
      var tmp = document.createElement('div');
      tmp.innerHTML = String(html || '');
      var el = tmp.querySelector('h1, p.title');
      var t = el ? (el.textContent || '').trim() : '';
      return t;
    } catch (e) { return ''; }
  }

  function charCountOfHtml(html) {
    try {
      var tmp = document.createElement('div');
      tmp.innerHTML = String(html || '');
      return (tmp.textContent || '').replace(/[\n​]/g, '').length;
    } catch (e) { return 0; }
  }

  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { } }

  /* ================= テンプレート ================= */

  function defaultDocHtml() { return '<p><br></p>'; }

  function nextDocNumber() {
    var max = 0;
    Object.keys(store).forEach(function (id) {
      var m = /^文書\s*(\d+)$/.exec((store[id] && store[id].title) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return max + 1;
  }

  function buildTemplate(name) {
    switch (name) {
      case 'report':
        return {
          title: 'レポート',
          html: [
            '<p class="title">レポートタイトル</p>',
            '<p class="subtitle">氏名・日付</p>',
            '<h1>はじめに</h1>',
            '<p>ここに背景・目的を記述します。この文書はレポート用テンプレートから作成されました。</p>',
            '<h1>結論</h1>',
            '<p>ここに結論を記述します。</p>'
          ].join('')
        };
      case 'mathnote':
        return {
          title: '数式ノート',
          html: [
            '<h1>数式ノート</h1>',
            '<p>重要な数式を書き留めるためのノートです。インライン数式は ',
            '<span class="math-inline" contenteditable="false" data-tex="a^2+b^2=c^2">a^2+b^2=c^2</span>',
            ' のように書けます。</p>',
            '<div class="math-display" contenteditable="false" data-tex="\\int_0^1 x^2 \\, dx = \\frac{1}{3}">\\int_0^1 x^2 \\, dx = \\frac{1}{3}</div>',
            '<div class="math-display" contenteditable="false" data-tex="\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}">\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}</div>'
          ].join('')
        };
      case 'minutes':
        return {
          title: '議事録',
          html: [
            '<h1>会議 議事録</h1>',
            '<table><tbody>',
            '<tr><td>日時</td><td>2026年　月　日</td></tr>',
            '<tr><td>場所</td><td><br></td></tr>',
            '<tr><td>出席者</td><td><br></td></tr>',
            '</tbody></table>',
            '<h2>決定事項</h2>',
            '<ul><li>決定事項1</li><li>決定事項2</li></ul>',
            '<h2>TODO</h2>',
            '<ol><li>タスク1(担当・期限)</li><li>タスク2(担当・期限)</li></ol>'
          ].join('')
        };
      case 'blank':
      default:
        return { title: '文書 ' + nextDocNumber(), html: defaultDocHtml() };
    }
  }

  /* ================= 複数文書ストア ================= */

  // フェーズ10c: クラウド保存の無変化スキップ用に、内容の署名(updatedAt/charCount 除く)を作る。
  //   updatedAt は捕捉のたびに変わるため署名から除外し、実質的な内容変化のみを検出する。
  function docContentSig(e) {
    if (!e) return '';
    return JSON.stringify({ h: e.html, t: e.title, c: e.comments, o: e.options, b: e.bib, s: e.bibStyle, l: e.language });
  }

  function saveStore() {
    // フェーズ7: アダプタ経由で保存。既定の LocalStore は下と 1 バイト同一の
    // localStorage 書き込みを行うため、ローカルモードでは挙動が変わらない。
    if (storeAdapter && storeAdapter.mode === 'cloud') {
      // フェーズ10c: 前回クラウド保存から内容が変わっていなければ書き込みを行わない。
      var sig = currentId ? (currentId + ':' + docContentSig(store[currentId])) : '';
      if (sig === lastCloudSig) { setSaveStatus('• 保存済み'); return; }
      lastCloudSig = sig;
    }
    if (storeAdapter && storeAdapter.saveAll) {
      try { storeAdapter.saveAll(store, currentId); return; } catch (e) { /* フォールバック */ }
    }
    safeSet(DOCS_KEY, JSON.stringify(store));
    if (currentId) safeSet(CURRENT_KEY, currentId);
  }

  function sortedIds() {
    return Object.keys(store).sort(function (a, b) {
      var ta = store[a] && store[a].updatedAt || '';
      var tb = store[b] && store[b].updatedAt || '';
      return ta < tb ? 1 : (ta > tb ? -1 : 0); // 新しい順
    });
  }

  /* フェーズ30: options から余白/向き/目次+段組み/用紙/行間/段落間隔/行番号を
   * 既定値つきで正規化(旧文書は未定義キーが既定へ落ちる=後方互換)。 */
  var COLUMN_VALUES = { one: 1, two: 1, three: 1, rule2: 1 };
  var PAPER_VALUES = { a4: 1, b5: 1, letter: 1 };
  var LINEHEIGHT_VALUES = { '1.0': 1, '1.15': 1, '1.5': 1, '2.0': 1 };
  function normOptions(o) {
    o = o || {};
    return {
      margin: MARGIN_PADDINGS[o.margin] ? o.margin : 'normal',
      landscape: !!o.landscape,
      toc: !!o.toc,
      columns: COLUMN_VALUES[o.columns] ? o.columns : 'one',
      paper: PAPER_VALUES[o.paper] ? o.paper : 'a4',
      lineHeight: LINEHEIGHT_VALUES[o.lineHeight] ? o.lineHeight : '1.15',
      paraSpace: !!o.paraSpace,
      lineNumbers: !!o.lineNumbers
    };
  }

  function makeEntry(tpl) {
    return {
      title: tpl.title, html: tpl.html, comments: {}, threads: [],
      options: normOptions(null),
      bib: [], bibStyle: 'plain', language: 'ja', finalOutput: false,
      updatedAt: nowIso(), charCount: charCountOfHtml(tpl.html)
    };
  }

  function migrateOld() {
    var raw = safeGet(OLD_DOC_KEY);
    if (!raw) return false;
    var html = null, opts = null;
    try {
      if (raw.charAt(0) === '{') {
        var d = JSON.parse(raw);
        if (d && typeof d.html === 'string') { html = d.html; opts = d.options; }
      } else if (raw.trim()) { html = raw; }
    } catch (e) { }
    if (html == null || !html.trim()) return false;
    var comments = {};
    try {
      var craw = safeGet(OLD_COMMENTS_KEY);
      if (craw) { var c = JSON.parse(craw); if (c && typeof c === 'object') comments = c; }
    } catch (e) { }
    var id = genId();
    store[id] = {
      title: titleFromHtml(html) || '文書 1',
      html: html, comments: comments,
      options: normOptions(opts),
      bib: [], bibStyle: 'plain', language: 'ja',
      updatedAt: nowIso(), charCount: charCountOfHtml(html)
    };
    currentId = id;
    saveStore();
    return true;
  }

  function loadStore() {
    store = {};
    var raw = safeGet(DOCS_KEY);
    hadStoredDocs = !!(raw && raw.trim());   // フェーズ15: 移行対象の既存文書があったか
    if (raw) {
      try { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') store = parsed; } catch (e) { }
    }
    if (!Object.keys(store).length) {
      if (!migrateOld()) {
        var id = genId();
        store[id] = makeEntry(buildTemplate('blank'));
        currentId = id;
      }
    }
    currentId = safeGet(CURRENT_KEY);
    if (!currentId || !store[currentId]) {
      var ids = sortedIds();
      if (ids.length) currentId = ids[0];
      else { currentId = genId(); store[currentId] = makeEntry(buildTemplate('blank')); }
    }
    var lc = parseInt(safeGet(LAST_COMPILE_KEY) || '0', 10);
    if (lc > 0) lastCompileTime = lc;
    saveStore();
  }

  /* ================= フェーズ7: クラウド切替 ================= */

  // 現在のアダプタから全文書を読み直して #doc を再構築する。
  // LocalStore は同期で {store,currentId} を返し、FirestoreStore は Promise を返す。
  function reloadFromAdapter(done) {
    var finish = function (data) {
      store = (data && data.store) || {};
      var cur = data && data.currentId;
      currentId = (cur && store[cur]) ? cur : null;
      if (!currentId) {
        var ids = sortedIds();
        currentId = ids.length ? ids[0] : null;
      }
      if (!currentId) {
        currentId = genId();
        store[currentId] = makeEntry(buildTemplate('blank'));
        saveStore();
      }
      openId(currentId, true);
      try { renderDashboard(); } catch (e) {}
      if (typeof done === 'function') done();
    };
    var res;
    try { res = storeAdapter.loadAll(); }
    catch (e) { console.warn('[cloud] loadAll', e); if (typeof done === 'function') done(); return; }
    if (res && typeof res.then === 'function') {
      res.then(finish).catch(function (e) { console.warn('[cloud] loadAll', e); if (typeof done === 'function') done(); });
    } else {
      finish(res);
    }
  }

  // Cloud コントローラの認証状態に合わせてアダプタを切り替える。
  // ローカルモード(cloud-config.js 無し)では onAuthChange は決して発火しないので無害。
  function wireCloud() {
    if (!window.Cloud || typeof window.Cloud.onAuthChange !== 'function') return;
    window.Cloud.onAuthChange(function (user) {
      if (user && typeof window.Cloud.getStore === 'function') {
        var cloud = window.Cloud.getStore();
        if (!cloud) return;
        if (storeAdapter && storeAdapter.mode === 'cloud') return; // 既にクラウド
        captureCurrent();
        var localSnapshot = {};
        for (var k in store) if (Object.prototype.hasOwnProperty.call(store, k)) localSnapshot[k] = store[k];
        var migKey = 'wordtex-cloud-mig-' + user.uid;
        var prompted = safeGet(migKey);
        var swap = function () {
          storeAdapter = cloud;
          lastCloudSig = null;   // フェーズ10c: 切替直後の初回保存は必ず書き込む
          reloadFromAdapter(function () { setSaveStatus('• クラウドに保存'); });
        };
        var hasLocal = Object.keys(localSnapshot).length > 0;
        if (hasLocal && !prompted && window.confirm('この端末のローカル文書(' + Object.keys(localSnapshot).length + ' 件)をクラウドに移行しますか?')) {
          safeSet(migKey, '1');
          (cloud.migrateFrom ? cloud.migrateFrom(localSnapshot) : Promise.resolve()).then(swap).catch(swap);
        } else {
          if (!prompted) safeSet(migKey, '1');
          swap();
        }
      } else {
        // ログアウト → ローカルへ復帰
        if (storeAdapter && storeAdapter.mode === 'cloud') {
          try { storeAdapter.dispose && storeAdapter.dispose(); } catch (e) {}
          storeAdapter = (window.Store && window.Store.createLocal) ? window.Store.createLocal() : null;
          reloadFromAdapter(function () { setSaveStatus('• 保存済み'); });
        }
      }
    });
  }

  // 現在の #doc の状態を store[currentId] へ書き戻す
  function captureCurrent() {
    var d = doc();
    if (!d || !currentId || !store[currentId]) return;
    if (versionViewing) return;   // 閲覧中の版で現在文書を上書きしない
    var e = store[currentId];
    e.html = d.innerHTML;
    e.title = docTitle();
    e.comments = (window.Editor && window.Editor.getCommentMap) ? window.Editor.getCommentMap() : (e.comments || {});
    if (window.Threads) e.threads = serializeThreads();   // フェーズ17: スレッドを退避
    e.options = normOptions(options);
    e.bib = bibEntries.slice();
    e.bibStyle = bibStyle;
    e.language = (window.Editor && window.Editor.getDocLanguage) ? window.Editor.getDocLanguage() : docLanguage;
    e.updatedAt = nowIso();
    e.charCount = (d.textContent || '').replace(/[\n​]/g, '').length;
  }

  // 指定文書を #doc に読み込む。skipCapture=true で直前文書の退避を省略(初期ロード用)。
  function openId(id, skipCapture) {
    if (!store[id]) return;
    if (versionViewing) resetVersionView();   // 別文書を開くときは閲覧状態を解除
    if (!skipCapture && currentId && currentId !== id && store[currentId]) captureCurrent();
    currentId = id;
    safeSet(CURRENT_KEY, id);
    // フェーズ7: クラウドモードでは現在文書 id を users/{uid} に反映(Local は localStorage 済み)。
    if (storeAdapter && storeAdapter.mode === 'cloud' && storeAdapter.setCurrentId) {
      try { storeAdapter.setCurrentId(id); } catch (e) {}
    }
    var entry = store[id];
    var d = doc();
    if (d) d.innerHTML = entry.html || defaultDocHtml();
    options = normOptions(entry.options);
    applyMargin(options.margin);
    applyPaper(options.paper);
    applyOrientation(options.landscape);
    applyColumns(options.columns);
    applyLineHeight(options.lineHeight);
    applyParaSpace(options.paraSpace);
    applyLineNumbers(options.lineNumbers);
    bibEntries = Array.isArray(entry.bib) ? entry.bib.slice() : [];
    bibStyle = entry.bibStyle || 'plain';
    syncBibStyleSelect();
    // フェーズ11: 文書言語を復元し #doc(lang/spellcheck)と選択 UI に反映
    docLanguage = entry.language || 'ja';
    if (window.Editor && window.Editor.setDocLanguage) docLanguage = window.Editor.setDocLanguage(docLanguage);
    syncDocLangSelect();
    if (window.Editor && window.Editor.setComments) window.Editor.setComments(entry.comments || {});
    loadThreadsForCurrent();   // フェーズ17: Editor.refresh より前に Threads を当文書へ差し替え
    renderBibliographies();
    setDocTitle(entry.title);
    updateTocButtons();
    if (window.Editor) {
      if (window.Editor.renumberFootnotes) window.Editor.renumberFootnotes();
      if (window.Editor.resetHistory) window.Editor.resetHistory();
      if (window.Editor.refresh) window.Editor.refresh();
    }
    renderCiteMenu();
    renderSourceList();
    // 文書を開いた時の自動スナップショット (直前版と同一ならスキップ)
    // フェーズ15: プロジェクトモードでは git コミットに一本化するため無効化
    if (window.Versions && !projectMode) { try { window.Versions.snapshot(id, 'auto'); } catch (e) {} }
    // フェーズ15: プロジェクトモードならツリー/現在プロジェクトを同期
    if (projectMode) {
      var pid = store[id] && store[id].projectId;
      if (pid) {
        window.Projects.open(pid);
        if (window.FileTree) window.FileTree.setProject(pid);
        updateProjectLocation();
      } else {
        createProjectAndAssign(id);
      }
    }
    syncOutputModeUI();   // フェーズ15: 出力モードトグルを文書に合わせて更新
    syncPreambleUI();     // フェーズ31: 温存プリアンブル トグルを文書に合わせて更新
    scheduleAssetMigration();  // フェーズ19: 旧 base64 画像を次回保存時に外部化(ワンタイム)
  }

  // 新規文書を作成して開く
  function createDoc(templateName) {
    captureCurrent();
    saveStore();
    var id = genId();
    store[id] = makeEntry(buildTemplate(templateName || 'blank'));
    saveStore();
    openId(id, false);
    saveNow();
    if (projectMode) createProjectAndAssign(id);   // フェーズ15: 新規プロジェクト作成
    return id;
  }

  function removeDoc(id) {
    if (!store[id]) return;
    if (window.Versions) { try { window.Versions.removeDoc(id); } catch (e) {} }
    // フェーズ15: 対応するサーバープロジェクトも削除
    if (projectMode && store[id].projectId && window.Projects) {
      try { window.Projects.remove(store[id].projectId).catch(function () {}); } catch (e) {}
    }
    var wasCurrent = (id === currentId);
    delete store[id];
    // フェーズ7: クラウドでは全体 blob を書かないので、削除を明示的に伝える(Local は no-op)。
    if (storeAdapter && storeAdapter.removeDoc) { try { storeAdapter.removeDoc(id); } catch (e) {} }
    if (wasCurrent) {
      var ids = sortedIds();
      if (ids.length) {
        openId(ids[0], true);
      } else {
        var nid = genId();
        store[nid] = makeEntry(buildTemplate('blank'));
        openId(nid, true);
      }
    }
    saveStore();
    renderDashboard();
  }

  function setDocTitle(title) {
    var el = byId('doc-title');
    if (!el) return;
    var t = String(title || '文書 1');
    el.textContent = t + ' - TailorTeX';
  }

  function updateTocButtons() {
    var btns = document.querySelectorAll('[data-command="toc"]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('is-active', !!options.toc);
  }

  /* ================= フェーズ11: 文書言語 ================= */

  // #doc-lang-select(並行エージェントが用意)。無ければ防御的に無視する。
  function docLangSelect() { return byId('doc-lang-select'); }

  function syncDocLangSelect() {
    var sel = docLangSelect();
    if (sel && sel.value !== docLanguage) sel.value = docLanguage;
  }

  // 文書言語を変更 → #doc へ反映(Editor)・選択 UI 同期・永続化・再コンパイル/再生成。
  function setDocLanguage(value) {
    var applied = value;
    if (window.Editor && window.Editor.setDocLanguage) applied = window.Editor.setDocLanguage(value);
    docLanguage = applied || 'ja';
    syncDocLangSelect();
    if (currentId && store[currentId]) store[currentId].language = docLanguage;
    afterDocChange();  // 保存 + プレビュー/ソースが開いていれば再生成
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce(t('a11y.docLanguageChanged', '文書の言語を変更しました'));
    }
  }

  /* ================= 自動保存 ================= */

  function saveStatusEl() {
    // タイトルバーの保存状態表示(#save-state)。旧 id/クラスにもフォールバック。
    return byId('save-status') || byId('save-state') ||
      document.querySelector('.save-status') || document.querySelector('.save-state') || null;
  }

  function setSaveStatus(text) {
    var el = saveStatusEl();
    if (el) el.textContent = text;
  }

  function saveNow() {
    var d = doc();
    if (!d) return;
    captureCurrent();
    saveStore();
    if (projectMode) scheduleProjectPush();   // フェーズ15: プロジェクトファイルへ反映
    setSaveStatus('• 保存済み');
  }

  function scheduleSave() {
    setSaveStatus('保存中…');
    if (saveTimer) clearTimeout(saveTimer);
    // フェーズ10c: クラウド(Firestore)使用時は書き込みコスト削減のためデバウンスを
    //   8 秒に延長。ローカルモードは従来どおり 1 秒(挙動不変)。
    var isCloud = storeAdapter && storeAdapter.mode === 'cloud';
    saveTimer = setTimeout(saveNow, isCloud ? 8000 : 1000);
  }

  // フェーズ10c: クラウドモードで 8 秒デバウンス中に離脱すると保存漏れになるため、
  //   blur / タブ非表示で保留中の保存を即時フラッシュ。ローカルモードは何もしない(挙動不変)。
  function flushSave() {
    if (!(storeAdapter && storeAdapter.mode === 'cloud')) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
  }

  /* ================= フェーズ15: プロジェクト層 ================= */

  // 画面右下の簡易トースト(uapdf.js と同系統)。A11y にもアナウンス。
  function notify(msg) {
    if (!msg) return;
    try {
      var toast = byId('app-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.setAttribute('role', 'status');
        toast.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;background:#323130;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:opacity .2s;pointer-events:none;max-width:80vw;';
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.style.opacity = '1';
      if (toast._timer) clearTimeout(toast._timer);
      toast._timer = setTimeout(function () { toast.style.opacity = '0'; }, 3000);
    } catch (e) {}
    if (window.A11y && window.A11y.announce) { try { window.A11y.announce(msg); } catch (e) {} }
  }

  function bibSerialize(arr) {
    try { return (window.Bib && window.Bib.serialize) ? window.Bib.serialize(arr || []) : ''; }
    catch (e) { return ''; }
  }

  function currentProjectId() {
    return (currentId && store[currentId] && store[currentId].projectId) || null;
  }

  function titleMenuLoc() {
    var m = byId('title-menu'); if (!m) return null;
    return m.querySelector('.tm-loc span');
  }
  function updateProjectLocation() {
    var loc = titleMenuLoc();
    if (!loc) return;
    var pid = currentProjectId();
    loc.textContent = (projectMode && pid) ? ('プロジェクト > ' + pid) : 'このMac > localStorage';
  }

  function findEntryByProject(pid) {
    var ids = Object.keys(store);
    for (var i = 0; i < ids.length; i++) if (store[ids[i]] && store[ids[i]].projectId === pid) return ids[i];
    return null;
  }

  // フェーズ19: #doc 内の base64 画像(data:image/...)を資産として外部化し、img.src を参照へ
  //   張り替える。新規画像は editor.js が挿入時に外部化するが、旧文書(main.html/localStorage/
  //   Firestore に base64 が埋まっている)を「次回保存時にワンタイム移行」するための処理。
  //   ライブ DOM を書き換えるので、以降の captureCurrent()/保存では main.html/Firestore に
  //   base64 が残らない。バックエンドが無ければ何もしない(非破壊)。
  //   解決値: 外部化できた画像数。
  function externalizeDocImages() {
    var d = doc();
    var A = window.Assets;
    if (!d || !A || !A.canExternalize || !A.canExternalize()) return Promise.resolve(0);
    var imgs = d.querySelectorAll ? d.querySelectorAll('img') : [];
    var tasks = [];
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        var src = img.getAttribute('src') || '';
        if (!/^data:image\//i.test(src)) return;   // 既に参照 or 画像でない
        tasks.push(A.put(src).then(function (res) {
          img.setAttribute('src', res.url);
          img.setAttribute('data-asset', res.ref);
          return 1;
        }).catch(function () { return 0; }));       // 失敗時は base64 のまま(非破壊)
      })(imgs[i]);
    }
    if (!tasks.length) return Promise.resolve(0);
    return Promise.all(tasks).then(function (rs) {
      var n = 0; for (var k = 0; k < rs.length; k++) n += rs[k];
      return n;
    });
  }

  // 文書を開いた後などに一度だけ移行を試みる(プロジェクト割当の完了を待つため遅延実行)。
  var _assetMigrateTimer = null;
  function scheduleAssetMigration() {
    if (!window.Assets) return;
    if (_assetMigrateTimer) clearTimeout(_assetMigrateTimer);
    _assetMigrateTimer = setTimeout(function () {
      externalizeDocImages().then(function (n) {
        if (n > 0) {
          captureCurrent();
          saveStore();
          if (projectMode) scheduleProjectPush();
        }
      }).catch(function () {});
    }, 1500);
  }

  /* ================= フェーズ27: 上書き保護 =================
     移行プロジェクトの手書き main.tex を自動保存で壊さない。
     生成マーカー(latex.js の GEN_MARKER)が無い既存 main.tex は「手書き」とみなし
     書き込みをスキップする。判定はプロジェクトごとに一度だけ(Promise をキャッシュ)。 */
  function genMarker() {
    return (window.LatexGen && window.LatexGen.GEN_MARKER) || '% Generated by TailorTeX';
  }
  var protectPromise = {};    // pid -> Promise<{texProtected, bibNonEmpty}>
  var protectAnnounced = {};  // pid -> true(保護通知は一度だけ)
  var converted = {};         // pid -> true(ビジュアル編集へ変換済み=保護解除して生成 tex を書く)

  function ensureProtectionFlags(pid) {
    var empty = { texProtected: false, texLength: 0, bibNonEmpty: false };
    if (!pid || !window.Projects || !window.Projects.readFile) return Promise.resolve(empty);
    if (protectPromise[pid]) return protectPromise[pid];
    var flags = { texProtected: false, texLength: 0, bibNonEmpty: false };
    var marker = genMarker();
    var p = Promise.all([
      window.Projects.readFile(pid, 'main.tex', false).then(function (txt) {
        flags.texLength = String(txt || '').length;
        // 既存かつ非空かつマーカー無し = 手書き → 保護
        if (txt && String(txt).trim() && String(txt).indexOf(marker) === -1) flags.texProtected = true;
      }).catch(function () {}),
      window.Projects.readFile(pid, 'refs.bib', false).then(function (txt) {
        if (txt && String(txt).trim()) flags.bibNonEmpty = true;
      }).catch(function () {})
    ]).then(function () { return flags; });
    protectPromise[pid] = p;
    return p;
  }

  function announceTexProtected(pid) {
    if (protectAnnounced[pid]) return;
    protectAnnounced[pid] = true;
    // notify はトーストと A11y アナウンスの両方を行う
    notify(t('protect.texHandwritten', 'main.tex は手書きのため上書きしません(texモードで編集)'));
    setSaveStatus(t('protect.texStatus', '• main.tex は手書きのため保護中'));
  }

  // main.html / main.tex / refs.bib を現在プロジェクトへ書き込む。
  function pushProjectFiles(pid, silent) {
    pid = pid || currentProjectId();
    if (!projectMode || !pid || !window.Projects) return Promise.resolve();
    // フェーズ19: 保存前に base64 画像を外部化 → main.html に base64 を残さない。
    return externalizeDocImages().then(function () {
      return doPushProjectFiles(pid);
    });
  }

  function doPushProjectFiles(pid) {
    captureCurrent();
    var e = store[currentId];
    if (!e) return Promise.resolve();
    var html = e.html || '';
    var bibText = bibSerialize(e.bib);
    // フェーズ17: スレッドを notes/threads.json に含める(自動保存に統合。本文とは別ファイル)
    var threadsJson = '{"order":[],"threads":[]}';
    try { threadsJson = JSON.stringify(serializeThreads() || { threads: [] }); } catch (x2) {}
    // フェーズ19: main.tex 生成は画像参照を data:URL へ解決してから(latex.js が \WLimg{imgN.ext}
    //   を出せるように)。main.html は参照のまま(base64 無し)を書き出す。
    // フェーズ27: 手書き main.tex / 手書き refs.bib は上書きしない(ensureProtectionFlags)。
    return ensureProtectionFlags(pid).then(function (flags) {
      return resolveDocImages().then(function (rd) {
        var tex = '';
        // ディスク上の main.tex は論文そのもの。画面上の作業モードに関係なく、
        // コメント/AI指差し/filelink 等のシステム情報を絶対に混入させない。
        // システム情報の正本は notes/threads.json と Agent inbox に分離して保存する。
        try { tex = generateLatex(rd, { finalOutput: true }) || ''; } catch (x) { tex = ''; }
        var texBlocked = false;
        var bundle = { html: html };
        var writes = [window.Projects.writeFile(pid, 'notes/threads.json', threadsJson).catch(function () {})];
        // main.tex: 手書きなら書かない(保護)。生成物 or 新規なら従来どおり更新。
        // ビジュアル編集へ変換済み(converted)なら保護を解除して生成 tex を書く。
        if (flags.texProtected && !converted[pid]) {
          announceTexProtected(pid);
        } else if (flags.texProtected && converted[pid] && flags.texLength >= 2000 &&
                   tex.length < Math.max(1000, Math.floor(flags.texLength * 0.25))) {
          // 手書き原稿からの初回変換で出力が75%以上縮む場合は、空DOM・読込競合を疑う。
          // main.html は復旧材料として保存しても、元 main.tex は絶対に上書きしない。
          texBlocked = true;
          notify(t('conv.lossBlocked', '安全のため main.tex の上書きを停止しました(変換後の内容が大幅に少ないため)'));
          setSaveStatus(t('conv.lossBlockedStatus', '• main.tex を保護しました'));
        } else {
          bundle.tex = tex;
        }
        // refs.bib: 既存非空 かつ エディタ側 bib が空 なら書かない(手書き文献の保護)。
        var editorBibEmpty = !(bibText && bibText.trim());
        if (!(flags.bibNonEmpty && editorBibEmpty)) {
          bundle.refs = bibText;
        }
        if (window.Projects.writeBundle) {
          writes.push(window.Projects.writeBundle(pid, bundle));
        } else {
          // 旧サーバー互換。エラーは握り潰さず呼び出し元へ返す。
          writes.push(window.Projects.writeFile(pid, 'main.html', bundle.html));
          if (typeof bundle.tex === 'string') writes.push(window.Projects.writeFile(pid, 'main.tex', bundle.tex));
          if (typeof bundle.refs === 'string') writes.push(window.Projects.writeFile(pid, 'refs.bib', bundle.refs));
        }
        return Promise.all(writes).then(function () { return { texBlocked: texBlocked }; });
      });
    });
  }

  function scheduleProjectPush() {
    if (!projectMode) return;
    if (projPushTimer) clearTimeout(projPushTimer);
    projPushTimer = setTimeout(function () {
      pushProjectFiles(null, true).then(function () { refreshProjectStatus(); }).catch(function () {});
    }, 1200);
  }

  /* ===== git バージョン管理(手動コミット) ===== */

  // 保存(PUT)後に git の dirty 状態を取得してステータス表示に反映。
  function refreshProjectStatus() {
    var pid = currentProjectId();
    if (!projectMode || !pid || !window.Projects || !window.Projects.status) return;
    window.Projects.status(pid).then(function (st) {
      projDirty = !!(st && st.dirty);
      setSaveStatus(projDirty ? t('git.saveDirty', '• 保存済み・未コミットの変更あり')
                              : t('git.saveClean', '• コミット済み'));
      var line = byId('git-status-line');
      if (line) line.textContent = projDirty ? t('git.dirty', '未コミットの変更があります')
                                            : t('git.clean', '変更はコミット済みです');
    }).catch(function () { /* status 未実装(404)は無視 */ });
  }

  function gitPanelActive() {
    return projectMode && versionPanelOpen();
  }

  function renderGitPanel() {
    var list = byId('version-list');
    if (!list) return;
    var titleEl = document.querySelector('#version-panel .vp-title');
    if (titleEl) titleEl.textContent = t('git.panelTitle', 'バージョン履歴(git)');
    list.innerHTML =
      '<div class="git-branch-box">' +
        '<label for="git-branch-select">' + escapeHtml(t('git.draftVersion', '原稿版')) + '</label>' +
        '<div class="git-branch-row"><select id="git-branch-select" aria-label="原稿版を切り替える"></select>' +
        '<button type="button" class="git-branch-switch">' + escapeHtml(t('git.switchVersion', '切替')) + '</button></div>' +
        '<div class="git-branch-row"><input id="git-branch-name" maxlength="120" placeholder="例: 初稿、査読対応、カメラレディ">' +
        '<button type="button" class="git-branch-create">' + escapeHtml(t('git.createVersion', '新しい原稿版')) + '</button></div>' +
      '</div>' +
      '<div class="submission-box">' +
        '<strong>提出記録</strong><p>PCS等からダウンロードした実際の提出ファイルを、この原稿版へ凍結保存します。</p>' +
        '<div class="git-branch-row"><input id="submission-label" maxlength="100" placeholder="例: CHI 2027 Camera Ready 提出">' +
        '<button type="button" class="submission-upload">ファイルを選択</button></div>' +
        '<div id="submission-list" class="submission-list"></div>' +
      '</div>' +
      '<div class="git-commit-box">' +
        '<textarea class="git-msg" rows="2" placeholder="' + escAttr(t('git.msgPlaceholder', '変更内容を記述(コミットメッセージ)')) + '"></textarea>' +
        '<div class="git-commit-row">' +
          '<span class="git-status" id="git-status-line"></span>' +
          '<button type="button" class="git-commit-btn">' + escapeHtml(t('git.commit', 'コミット')) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="git-commits" id="git-commits"><div class="vp-empty">' + escapeHtml(t('git.loading', '読み込み中…')) + '</div></div>';
    refreshProjectStatus();
    refreshGitBranches();
    refreshSubmissions();
    refreshGitCommits();
  }

  var pendingSubmissionLabel = '';
  function refreshSubmissions() {
    var host = byId('submission-list'); var pid = currentProjectId();
    if (!host || !pid || !window.Projects.submissions) return;
    window.Projects.submissions(pid).then(function (arr) {
      if (!arr.length) { host.innerHTML = '<div class="vp-empty">この原稿版には提出記録がありません</div>'; return; }
      host.innerHTML = arr.map(function (s) {
        return '<div class="submission-item"><div><b>' + escapeHtml(s.label || s.id) + '</b><small>' + escapeHtml((s.createdAt || '') + '・原稿版 ' + (s.branch || '')) + '</small>' +
          '<span>' + escapeHtml((s.files || []).map(function (f) { return f.name; }).join('、')) + '</span></div>' +
          '<button type="button" class="submission-copy-email" data-path="' + escAttr(s.path + '/email.txt') + '">メール文をコピー</button></div>';
      }).join('');
    }).catch(function () { host.innerHTML = '<div class="vp-empty">提出記録を取得できませんでした</div>'; });
  }

  function chooseSubmissionFiles() {
    var label = byId('submission-label'); pendingSubmissionLabel = label && String(label.value || '').trim();
    if (!pendingSubmissionLabel) { notify('提出記録の名前を入力してください'); if (label) label.focus(); return; }
    var input = byId('submission-files-input'); if (input) input.click();
  }

  function saveSubmissionFiles(fileList) {
    var pid = currentProjectId(); var files = Array.prototype.slice.call(fileList || []);
    if (!pid || !files.length || !pendingSubmissionLabel) return;
    setSaveStatus('提出ファイルを保存中…');
    pushProjectFiles(pid, true).then(function () { return window.Projects.createSubmission(pid, pendingSubmissionLabel); }).then(function (session) {
      var chain = Promise.resolve();
      files.forEach(function (file) { chain = chain.then(function () { return window.Projects.upload(pid, session.filesPath, file); }); });
      return chain.then(function () { return window.Projects.freezeSubmission(pid, session.id, { label:pendingSubmissionLabel }); });
    }).then(function () {
      notify('提出記録を凍結保存しました'); pendingSubmissionLabel = ''; var label = byId('submission-label'); if (label) label.value = '';
      refreshSubmissions(); refreshGitCommits(); refreshProjectStatus(); if (window.FileTree) window.FileTree.reload();
    }).catch(function () { notify('提出記録を保存できませんでした'); }).then(function () { var input = byId('submission-files-input'); if (input) input.value = ''; });
  }

  function copySubmissionEmail(path) {
    var pid = currentProjectId(); if (!pid || !path) return;
    window.Projects.readFile(pid, path, false).then(function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }).then(function () { notify('提出メール文をコピーしました'); }).catch(function () { notify('コピーできませんでした'); });
  }

  function refreshGitBranches() {
    var select = byId('git-branch-select'); var pid = currentProjectId();
    if (!select || !pid || !window.Projects || !window.Projects.branches) return;
    window.Projects.branches(pid).then(function (data) {
      var arr = data && data.branches || [];
      select.innerHTML = arr.map(function (b) { return '<option value="' + escAttr(b.name) + '"' + (b.current ? ' selected' : '') + '>' + escapeHtml(b.name + (b.current ? '（現在）' : '')) + '</option>'; }).join('');
    }).catch(function () { select.innerHTML = '<option>取得できません</option>'; });
  }

  function switchDraftVersion(name) {
    var pid = currentProjectId(); if (!pid || !name || !window.Projects.switchBranch) return Promise.resolve();
    return pushProjectFiles(pid, true).then(function () { return window.Projects.switchBranch(pid, name); }).then(function () {
      return openProject(pid, projectNameCache[pid]);
    }).then(function () {
      notify('原稿版「' + name + '」へ切り替えました'); refreshGitBranches(); refreshGitCommits(); refreshProjectStatus();
    });
  }

  function createDraftVersion() {
    var input = byId('git-branch-name'); var name = input && String(input.value || '').trim(); var pid = currentProjectId();
    if (!name || !pid || !window.Projects.createBranch) { if (input) input.focus(); return; }
    pushProjectFiles(pid, true).then(function () { return window.Projects.createBranch(pid, name); }).then(function () {
      return window.Projects.switchBranch(pid, name);
    }).then(function () { if (input) input.value = ''; return openProject(pid, projectNameCache[pid]); }).then(function () {
      notify('新しい原稿版「' + name + '」を作成しました'); refreshGitBranches(); refreshGitCommits(); refreshProjectStatus();
    }).catch(function () { notify('原稿版を作成できませんでした。同名の版がないか確認してください'); });
  }

  function refreshGitCommits() {
    var el = byId('git-commits');
    if (!el) return;
    var pid = currentProjectId();
    if (!pid || !window.Projects || !window.Projects.commits) { el.innerHTML = ''; return; }
    window.Projects.commits(pid).then(function (arr) {
      if (!arr.length) { el.innerHTML = '<div class="vp-empty">' + escapeHtml(t('git.noCommits', 'まだコミットがありません')) + '</div>'; return; }
      var html = '';
      for (var i = 0; i < arr.length; i++) {
        var c = arr[i];
        var when = c.relative || (c.date ? appRelTime(c.date) : '');
        html += '<button type="button" class="git-commit-item" data-hash="' + escAttr(c.hash || '') + '" title="' + escAttr(t('git.restoreTip', 'このコミットに戻す')) + '">' +
          '<span class="gc-msg">' + escapeHtml(c.message || '(no message)') + '</span>' +
          '<span class="gc-meta"><code class="gc-hash">' + escapeHtml(String(c.hash || '').slice(0, 7)) + '</code> ' +
          '<span class="gc-time">' + escapeHtml(when) + '</span></span>' +
          '</button>';
      }
      el.innerHTML = html;
    }).catch(function () {
      el.innerHTML = '<div class="vp-empty">' + escapeHtml(t('git.commitsError', 'コミット履歴を取得できませんでした(サーバー未対応)')) + '</div>';
    });
  }

  function doCommit() {
    var pid = currentProjectId();
    if (!pid || !window.Projects || !window.Projects.commit) return;
    var ta = document.querySelector('#version-panel .git-msg');
    var msg = ta ? String(ta.value || '').trim() : '';
    if (!msg) { notify(t('git.needMsg', 'コミットメッセージを入力してください')); if (ta) ta.focus(); return; }
    pushProjectFiles(pid, true).then(function () {
      return window.Projects.commit(pid, msg);
    }).then(function () {
      if (ta) ta.value = '';
      notify(t('git.committed', 'コミットしました'));
      refreshProjectStatus();
      refreshGitCommits();
    }).catch(function () { notify(t('git.commitFailed', 'コミットに失敗しました')); });
  }

  function doRestore(hash) {
    var pid = currentProjectId();
    if (!pid || !window.Projects || !window.Projects.restore || !hash) return;
    if (!window.confirm(t('git.confirmRestore', 'このコミットの状態に戻しますか?\n未コミットの変更は失われます。'))) return;
    window.Projects.restore(pid, hash).then(function () {
      notify(t('git.restored', '復元しました'));
      return window.Projects.readFile(pid, 'main.html', false);
    }).then(function (html) {
      var d = doc();
      if (d && html != null) {
        d.innerHTML = (html && html.trim()) ? html : defaultDocHtml();
        if (currentId && store[currentId]) store[currentId].html = html;
        if (window.Editor && window.Editor.refresh) window.Editor.refresh();
      }
      return window.Projects.readFile(pid, 'refs.bib', false).catch(function () { return null; });
    }).then(function (bibText) {
      if (bibText != null && window.Bib && window.Bib.parse) {
        try {
          bibEntries = window.Bib.parse(bibText) || [];
          if (currentId && store[currentId]) store[currentId].bib = bibEntries.slice();
          renderBibliographies(); renderCiteMenu(); renderSourceList();
        } catch (e) {}
      }
      saveStore();
      refreshProjectStatus();
      refreshGitCommits();
      if (window.FileTree) window.FileTree.reload();
    }).catch(function () { notify(t('git.restoreFailed', '復元に失敗しました')); });
  }

  function scheduleMetaRename() {
    if (!projectMode) return;
    var pid = currentProjectId();
    if (!pid || !window.Projects) return;
    if (metaTimer) clearTimeout(metaTimer);
    var name = docTitle();
    metaTimer = setTimeout(function () {
      window.Projects.meta(pid, name).then(function () {
        projectNameCache[pid] = name;
      }).catch(function () {});
    }, 800);
  }

  // 既存 localStorage 文書をサーバープロジェクトへ移行(初回のみ)。
  function ensureMigration() {
    if (!window.Projects) return Promise.resolve();
    if (safeGet(PROJECT_MIGRATED_KEY) || !hadStoredDocs) return Promise.resolve();
    captureCurrent();
    var ids = sortedIds();
    var chain = Promise.resolve();
    var count = 0;
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var e = store[id];
        if (!e || e.projectId) return;
        var payload = { name: e.title || '無題', html: e.html || '', bib: bibSerialize(e.bib), comments: e.comments || {} };
        return window.Projects['import'](payload).then(function (r) {
          if (r && r.id) { e.projectId = r.id; projectNameCache[r.id] = e.title; count++; }
        }).catch(function () {});
      });
    });
    return chain.then(function () {
      safeSet(PROJECT_MIGRATED_KEY, '1');
      saveStore();
      if (count > 0) notify(count + '件の文書をプロジェクトに移行しました');
    });
  }

  // 現在文書に対応するプロジェクトを保証(なければ作成)。projectId を返す。
  function ensureCurrentProject() {
    var e = store[currentId];
    if (!e) return Promise.resolve(null);
    if (e.projectId) return Promise.resolve(e.projectId);
    if (!window.Projects) return Promise.resolve(null);
    return window.Projects.create(e.title || '無題のプロジェクト').then(function (r) {
      if (r && r.id) {
        e.projectId = r.id; projectNameCache[r.id] = e.title; newlyCreatedProjects[r.id] = true; saveStore(); return r.id;
      }
      return null;
    }).catch(function () { return null; });
  }

  // プロジェクトモードの初期化。サーバー到達可なら移行→現在プロジェクト確立→ツリー描画。
  function initProjects() {
    if (!window.Projects) { updateProjectLocation(); return; }
    window.Projects.available().then(function (ok) {
      if (!ok) { projectMode = false; updateProjectLocation(); return; }
      projectMode = true;
      ensureMigration().then(function () {
        var lastPid = window.Projects.current && window.Projects.current();
        if (lastPid) return window.Projects.list().then(function (projects) {
          var hit = projects.filter(function (p) { return p.id === lastPid; })[0];
          if (hit) { projectNameCache[hit.id] = hit.name; return hit.id; }
          // 前回プロジェクトが削除済みなら、下の既存プロジェクト選択へフォールバック。
          return null;
        });
        return null;
      }).then(function (pid) {
        if (pid) return pid;
        // 初回端末では空文書を新設せず、更新日時が最も新しい既存プロジェクトを開く。
        return window.Projects.list().then(function (projects) {
          if (projects.length) {
            projects.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
            projectNameCache[projects[0].id] = projects[0].name;
            return projects[0].id;
          }
          return ensureCurrentProject();
        });
      }).then(function (pid) {
        if (!pid) { projectMode = true; updateProjectLocation(); return; }
        // 既存プロジェクトではサーバーを正とし、localStorage の古い/空HTMLを送信しない。
        // このタブで今作った新規プロジェクトだけ、現在の初期文書を最初に保存する。
        if (newlyCreatedProjects[pid]) {
          delete newlyCreatedProjects[pid];
          return pushProjectFiles(pid, true).then(function () { return openProject(pid, projectNameCache[pid]); });
        }
        return openProject(pid, projectNameCache[pid]);
      }).catch(function (e) {
        console.warn('[projects] init failed', e);
        projectMode = false;
        updateProjectLocation();
      });
    }).catch(function () { projectMode = false; updateProjectLocation(); });
  }

  // ダッシュボードから、または内部から、プロジェクトを開く。
  function openProject(pid, name) {
    if (!pid || !window.Projects) return Promise.reject(new Error('no_project'));
    var eid = findEntryByProject(pid);
    if (eid) {
      // localStorage はキャッシュにすぎない。既存対応があっても必ずサーバーから再取得する。
      return window.Projects.readFile(pid, 'main.html', false).then(function (html) {
        var entry = store[eid];
        entry.html = (html && html.trim()) ? html : defaultDocHtml();
        return window.Projects.readFile(pid, 'refs.bib', false).then(function (bibText) {
          if (bibText && window.Bib && window.Bib.parse) { try { entry.bib = window.Bib.parse(bibText) || []; } catch (e) {} }
        }).catch(function () {});
      }).then(function () {
        saveStore();
        openId(eid, false);
        window.Projects.open(pid);
        if (window.FileTree) window.FileTree.setProject(pid);
        updateProjectLocation();
        closeBackstage();
        return pid;
      });
    }
    // ローカルに未対応 → サーバーから main.html / refs.bib を取得して新規エントリ化
    return window.Projects.readFile(pid, 'main.html', false).then(function (html) {
      var id = genId();
      var entry = makeEntry({ title: name || projectNameCache[pid] || pid, html: (html && html.trim()) ? html : defaultDocHtml() });
      entry.projectId = pid;
      store[id] = entry;
      return window.Projects.readFile(pid, 'refs.bib', false).then(function (bibText) {
        if (bibText && window.Bib && window.Bib.parse) { try { entry.bib = window.Bib.parse(bibText) || []; } catch (e) {} }
      }).catch(function () {}).then(function () {
        saveStore();
        openId(id, false);
        window.Projects.open(pid);
        if (window.FileTree) window.FileTree.setProject(pid);
        updateProjectLocation();
        closeBackstage();
        return pid;
      });
    }).catch(function (err) { notify('プロジェクトを開けませんでした'); throw err; });
  }

  /* ================= フォルダをプロジェクトとして取り込む ================= */

  var MAX_PROJECT_FOLDER_BYTES = 200 * 1024 * 1024;

  function projectFolderFiles(fileList) {
    var all = [];
    var root = '';
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      var rel = String(file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, '');
      var parts = rel.split('/').filter(Boolean);
      if (!parts.length) continue;
      if (!root) root = parts[0];
      // webkitdirectory が付ける選択フォルダ名だけを外す。選択したフォルダ自身がルート。
      if (parts[0] === root && parts.length > 1) parts.shift();
      if (!parts.length || parts.indexOf('build') !== -1 || parts.some(function (p) { return p.charAt(0) === '.'; })) continue;
      // アプリが新規作成した project.json を、別プロジェクト由来の内部メタデータで上書きしない。
      if (parts.length === 1 && parts[0].toLowerCase() === 'project.json') continue;
      all.push({ path: parts.join('/'), file: file });
    }
    return { root: root || '無題のプロジェクト', files: all };
  }

  function chooseProjectRoot(info) {
    return new Promise(function (resolve) {
      var mains = info.files.filter(function (it) { return /(^|\/)main\.tex$/i.test(it.path); })
        .map(function (it) { return it.path; });
      var roots = [{ prefix: '', label: info.root + '/ (選択したフォルダ)', main: mains.indexOf('main.tex') >= 0 ? 'main.tex' : '' }];
      mains.forEach(function (p) {
        var slash = p.lastIndexOf('/');
        if (slash < 0) return;
        var prefix = p.slice(0, slash);
        if (!roots.some(function (r) { return r.prefix === prefix; })) {
          roots.push({ prefix: prefix, label: info.root + '/' + prefix + '/', main: 'main.tex' });
        }
      });
      var back = document.createElement('div');
      back.className = 'fmove-backdrop';
      var dialog = document.createElement('div');
      dialog.className = 'fmove-dialog project-import-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'pimport-title');
      var optionsHtml = roots.map(function (r) {
        return '<option value="' + escAttr(r.prefix) + '">' + escapeHtml(r.label) + '</option>';
      }).join('');
      dialog.innerHTML =
        '<h2 id="pimport-title" class="fmove-title">このフォルダをプロジェクトにします</h2>' +
        '<p class="fmove-subject">選択したフォルダ自身がプロジェクトルートです。外側の階層は取り込みません。</p>' +
        '<label class="fmove-label" for="pimport-root">プロジェクトルート</label>' +
        '<select id="pimport-root" class="fmove-select">' + optionsHtml + '</select>' +
        '<div class="project-root-preview" aria-live="polite"></div>' +
        '<label class="fmove-label" for="pimport-name">プロジェクト名</label>' +
        '<input id="pimport-name" class="fmove-new" type="text" value="' + escAttr(info.root) + '">' +
        (!mains.length ? '<p class="fmove-hint">main.tex は見つかりませんでした。ファイル一式を取り込み、ビジュアル本文を開きます。</p>' : '') +
        '<div class="fmove-actions"><button type="button" class="fmove-cancel">キャンセル</button>' +
        '<button type="button" class="fmove-ok">プロジェクトとして取り込む</button></div>';
      back.appendChild(dialog); document.body.appendChild(back);
      var trigger = document.activeElement;
      var nameInput = dialog.querySelector('#pimport-name');
      var rootSelect = dialog.querySelector('#pimport-root');
      var preview = dialog.querySelector('.project-root-preview');
      var nameWasEdited = false;
      var unwire = wireModalKeys(dialog, function () { close(null); });
      function selectedRoot() {
        var prefix = rootSelect ? rootSelect.value : '';
        return roots.filter(function (r) { return r.prefix === prefix; })[0] || roots[0];
      }
      function filesForRoot(root) {
        var lead = root.prefix ? root.prefix + '/' : '';
        return info.files.filter(function (it) { return !lead || it.path.indexOf(lead) === 0; })
          .map(function (it) { return { path: lead ? it.path.slice(lead.length) : it.path, file: it.file }; });
      }
      function refreshRootPreview() {
        var root = selectedRoot();
        var files = filesForRoot(root);
        var label = root.prefix ? root.prefix.split('/').pop() : info.root;
        preview.innerHTML = '<strong>' + escapeHtml(label) + '/</strong>' +
          files.slice(0, 6).map(function (it) { return '<span>├ ' + escapeHtml(it.path) + '</span>'; }).join('') +
          (files.length > 6 ? '<span>└ …ほか ' + (files.length - 6) + ' ファイル</span>' : '');
        if (!nameWasEdited) nameInput.value = label;
      }
      function close(result) {
        if (back.parentNode) back.parentNode.removeChild(back);
        unwire();
        if (trigger && trigger.focus) { try { trigger.focus(); } catch (e) {} }
        resolve(result || null);
      }
      back.addEventListener('mousedown', function (e) { if (e.target === back) close(null); });
      dialog.querySelector('.fmove-cancel').addEventListener('click', function () { close(null); });
      dialog.querySelector('.fmove-ok').addEventListener('click', function () {
        var name = (nameInput.value || '').trim();
        if (!name) { nameInput.focus(); return; }
        var root = selectedRoot();
        close({ name: name, main: root.main, files: filesForRoot(root) });
      });
      nameInput.addEventListener('input', function () { nameWasEdited = true; });
      if (rootSelect) rootSelect.addEventListener('change', refreshRootPreview);
      refreshRootPreview();
      nameInput.focus(); nameInput.select();
    });
  }

  function importProjectFolder(fileList) {
    if (!projectMode || !window.Projects || !window.JSZip) {
      notify('プロジェクトサーバーに接続してから取り込んでください'); return;
    }
    var info = projectFolderFiles(fileList || []);
    if (!info.files.length) { notify('取り込めるファイルがありません'); return; }
    var total = info.files.reduce(function (n, it) { return n + (it.file.size || 0); }, 0);
    if (total > MAX_PROJECT_FOLDER_BYTES) { notify('フォルダが大きすぎます(上限200MB)'); return; }
    chooseProjectRoot(info).then(function (choice) {
      if (!choice) return;
      notify('プロジェクトを準備しています…');
      var createdId = null;
      return window.Projects.create(choice.name).then(function (created) {
        if (!created || !created.id) throw new Error('create_failed');
        createdId = created.id;
        var zip = new window.JSZip();
        choice.files.forEach(function (it) { zip.file(it.path, it.file); });
        return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
      }).then(function (blob) {
        notify('フォルダを取り込んでいます…');
        return window.Projects.uploadFolder(createdId, '', blob);
      }).then(function () {
        projectNameCache[createdId] = choice.name;
        return openProject(createdId, choice.name);
      }).then(function () {
        renderProjectList();
        if (choice.main && window.FileTree) window.FileTree.openPath(choice.main);
        notify('「' + choice.name + '」をプロジェクトとして取り込みました');
      }).catch(function (err) {
        // この処理で新規作成した空/不完全プロジェクトだけを掃除する。
        if (createdId) window.Projects.remove(createdId).catch(function () {});
        notify('プロジェクトの取り込みに失敗しました' + (err && err.message ? ': ' + err.message : ''));
      });
    });
  }

  function openProjectFolder() {
    var input = byId('project-folder-input');
    if (input) input.click();
  }

  function createProjectAndAssign(id) {
    if (!projectMode || !window.Projects) return;
    var e = store[id];
    if (!e || e.projectId) return;
    window.Projects.create(e.title || '無題のプロジェクト').then(function (r) {
      if (!r || !r.id) return;
      e.projectId = r.id;
      projectNameCache[r.id] = e.title;
      saveStore();
      if (id === currentId) {
        window.Projects.open(r.id);
        if (window.FileTree) window.FileTree.setProject(r.id);
        updateProjectLocation();
        pushProjectFiles(r.id, true).then(function () { if (window.FileTree) window.FileTree.reload(); });
      }
    }).catch(function () {});
  }

  // ファイルツリーで main.html を選んだ時: ビューアを閉じてエディタへ戻す。
  function showMainDoc() {
    if (texMode) { exitTexSource(true); }   // フェーズ27: tex モードから Word 風へ復帰
    if (window.FileViewer && window.FileViewer.close) window.FileViewer.close();
    var d = doc();
    if (d && d.focus) { try { d.focus(); } catch (e) {} }
  }

  /* ================= フェーズ27: tex ソース編集モード ================= */

  // #editor-area 内に #tex-editor-wrap(モノスペース textarea)を用意(初回のみ生成)。
  function ensureTexEditorDom() {
    var wrap = byId('tex-editor-wrap');
    if (wrap) return wrap;
    var area = byId('editor-area');
    if (!area) return null;
    wrap = document.createElement('div');
    wrap.id = 'tex-editor-wrap';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="tex-bar">' +
        '<span class="tex-path" id="tex-editor-path"></span>' +
        '<span class="tex-dirty" id="tex-editor-dirty" aria-hidden="true"></span>' +
        '<span class="tex-spacer"></span>' +
        '<button type="button" class="tex-convert" id="tex-editor-convert" title="' +
          escAttr(t('conv.btnTip', 'この LaTeX を Word 風の見た目で編集(変換できない箇所は原文のまま温存)')) + '">' +
          escapeHtml(t('conv.btn', 'ビジュアル編集へ変換')) + '</button>' +
        '<button type="button" class="tex-back" id="tex-editor-back">' +
          escapeHtml(t('tex.backToDoc', 'ビジュアル本文に戻る')) + '</button>' +
      '</div>' +
      '<div class="source-editor-split">' +
        '<section class="source-editor-pane source-editor-tex" aria-label="LaTeX エディタ">' +
          '<div class="source-pane-label">TeX</div>' +
          '<textarea id="tex-editor" class="tex-textarea" spellcheck="false" wrap="off" autocapitalize="off" autocorrect="off"></textarea>' +
        '</section>' +
        '<section class="source-editor-pane source-editor-bib" aria-label="BibTeX エディタ">' +
          '<div class="source-pane-label"><span>refs.bib</span><span id="bib-editor-dirty" class="tex-dirty"></span></div>' +
          '<textarea id="bib-editor" class="tex-textarea" spellcheck="false" wrap="off" autocapitalize="off" autocorrect="off" aria-label="BibTeX ソース: refs.bib"></textarea>' +
        '</section>' +
      '</div>';
    area.appendChild(wrap);
    var ta = wrap.querySelector('#tex-editor');
    ta.addEventListener('input', function () {
      setTexDirty(true);
      scheduleTexSave();
    });
    ta.addEventListener('keydown', function (e) {
      // Cmd/Ctrl+S で即時保存
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveTexNow();
      }
    });
    var bibTa = wrap.querySelector('#bib-editor');
    bibTa.addEventListener('input', function () {
      bibEditorDirty = true;
      var bd = byId('bib-editor-dirty'); if (bd) bd.textContent = t('tex.unsaved', '未保存');
      setSaveStatus(t('tex.editing', '編集中…'));
      scheduleTexSave();
    });
    bibTa.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveTexNow(); }
    });
    var back = wrap.querySelector('#tex-editor-back');
    if (back) back.addEventListener('click', function () { showMainDoc(); });
    var conv = wrap.querySelector('#tex-editor-convert');
    if (conv) conv.addEventListener('click', function () { convertTexToWord(texModePath); });
    return wrap;
  }

  function setTexDirty(on) {
    texEditorDirty = !!on;
    var d = byId('tex-editor-dirty');
    if (d) d.textContent = texEditorDirty ? t('tex.unsaved', '未保存') : '';
    setSaveStatus(texEditorDirty ? t('tex.editing', '編集中…') : '• 保存済み');
  }

  // .tex を中央エディタで開く。projectMode 前提。呼び出し元(filetree)で判定済み。
  function openTexSource(path) {
    var pid = currentProjectId();
    if (!projectMode || !pid || !window.Projects || !window.Projects.readFile) {
      // 非プロジェクト時はビューアにフォールバック
      if (window.FileViewer && window.FileViewer.open) window.FileViewer.open(path);
      return;
    }
    // 既に別 .tex を編集中なら先に保存
    var pre = (texMode && (texEditorDirty || bibEditorDirty)) ? saveTexNow() : Promise.resolve();
    Promise.resolve(pre).then(function () {
      var wrap = ensureTexEditorDom();
      if (!wrap) return;
      texModePath = /\.bib$/i.test(path) ? 'main.tex' : path;
      var ta = byId('tex-editor');
      var bibTa = byId('bib-editor');
      var pathEl = byId('tex-editor-path');
      var conv = byId('tex-editor-convert');
      if (pathEl) pathEl.textContent = texModePath + ' + refs.bib';
      // ビジュアル変換はTeX専用。BibTeXでは通常の保存可能なソースエディタとして使う。
      if (conv) conv.hidden = !/\.tex$/i.test(texModePath);
      if (ta) {
        ta.value = t('tex.loading', '読み込み中…');
        ta.setAttribute('aria-label', t('tex.aria', 'LaTeX ソース: ') + texModePath);
        ta.readOnly = true;
      }
      if (bibTa) { bibTa.value = t('tex.loading', '読み込み中…'); bibTa.readOnly = true; }
      enterTexModeUI();
      var requestedTexPath = texModePath;
      Promise.all([
        window.Projects.readFile(pid, requestedTexPath, false),
        window.Projects.readFile(pid, 'refs.bib', false).catch(function () { return ''; })
      ]).then(function (values) {
        if (texModePath !== requestedTexPath) return;
        var text = values[0];
        if (ta) { ta.readOnly = false; ta.value = (text == null ? '' : String(text)); }
        if (bibTa) { bibTa.readOnly = false; bibTa.value = String(values[1] || ''); }
        bibEditorDirty = false;
        var bd = byId('bib-editor-dirty'); if (bd) bd.textContent = '';
        setTexDirty(false);
        var focusTarget = /\.bib$/i.test(path) ? bibTa : ta;
        if (focusTarget && focusTarget.focus) { try { focusTarget.focus(); focusTarget.setSelectionRange(0, 0); } catch (e) {} }
      }).catch(function () {
        if (ta) { ta.readOnly = false; ta.value = ''; }
        if (bibTa) { bibTa.readOnly = false; bibTa.value = ''; }
        notify(t('tex.loadError', 'ファイルを読み込めませんでした'));
      });
    });
  }

  function enterTexModeUI() {
    texMode = true;
    document.body.classList.add('tex-mode');
    var ps = byId('page-scroll'); if (ps) ps.hidden = true;
    var ruler = byId('ruler'); if (ruler) ruler.hidden = true;
    var wrap = byId('tex-editor-wrap'); if (wrap) wrap.hidden = false;
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce(t('tex.enter', 'tex ソース編集モードに切り替えました'));
    }
  }

  // Word 風モードへ復帰。save=true なら未保存を書き込んでから。
  function exitTexSource(save) {
    if (!texMode) return;
    if (texSaveTimer) { clearTimeout(texSaveTimer); texSaveTimer = null; }
    if (save && (texEditorDirty || bibEditorDirty)) { saveTexNow(); }
    texMode = false;
    texModePath = null;
    setTexDirty(false);
    bibEditorDirty = false;
    document.body.classList.remove('tex-mode');
    var wrap = byId('tex-editor-wrap'); if (wrap) wrap.hidden = true;
    var ps = byId('page-scroll'); if (ps) ps.hidden = false;
    var ruler = byId('ruler'); if (ruler) ruler.hidden = false;
    setSaveStatus('• 保存済み');
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce(t('tex.exit', 'ビジュアル本文に戻りました'));
    }
  }

  function scheduleTexSave() {
    if (texSaveTimer) clearTimeout(texSaveTimer);
    texSaveTimer = setTimeout(saveTexNow, 1200);
  }

  function saveTexNow() {
    if (texSaveTimer) { clearTimeout(texSaveTimer); texSaveTimer = null; }
    var ta = byId('tex-editor');
    var bibTa = byId('bib-editor');
    var pid = currentProjectId();
    if (!texMode || !texModePath || !ta || !pid || !window.Projects || !window.Projects.writeFile) {
      return Promise.resolve();
    }
    var writes = [];
    if (texEditorDirty) writes.push(window.Projects.writeFile(pid, texModePath, ta.value));
    if (bibEditorDirty && bibTa) writes.push(window.Projects.writeFile(pid, 'refs.bib', bibTa.value));
    if (!writes.length) return Promise.resolve();
    return Promise.all(writes).then(function () {
      setTexDirty(false);
      bibEditorDirty = false;
      var bd = byId('bib-editor-dirty'); if (bd) bd.textContent = '';
      if (projectMode) refreshProjectStatus();
    }).catch(function () {
      notify(t('tex.saveFailed', '保存に失敗しました'));
    });
  }

  // tex モードのコンパイル: projects/<id>/ を cwd に latexmk main.tex 直(サーバー /compile{projectId})。
  function compileTexProject() {
    var pid = currentProjectId();
    if (!pid) return;
    // プレビューペインを開く
    var pane = byId('preview-pane');
    if (pane && pane.hidden) { pane.hidden = false; updateWorkspaceClasses(); }
    if (compiling) { compileQueued = true; return; }
    compiling = true;
    if (window.A11y && window.A11y.announce) window.A11y.announce('PDFをコンパイルしています');
    // 保留中の編集を先に書き込んでからコンパイル
    Promise.resolve((texEditorDirty || bibEditorDirty) ? saveTexNow() : null).then(function () {
      return withAuthHeaders({ 'Content-Type': 'application/json' });
    }).then(function (headers) {
      return fetch('/compile', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ projectId: pid })
      });
    }).then(function (res) {
      if (res.status === 200) { recordCompile(); return res.blob().then(showPdf); }
      if (isAuthError(res)) { showCompileError('ログインが必要です'); return; }
      return res.text().then(function (text) {
        var log = text;
        try { var j = JSON.parse(text); log = j.log || j.error || text; } catch (e) {}
        showCompileError(log);
      });
    }).catch(function (err) {
      showCompileError('サーバーに接続できません: ' + err.message);
    }).finally(function () {
      compiling = false;
      if (compileQueued) { compileQueued = false; compile(); }
    });
  }

  /* ================= フェーズ15: 出力モード(作業用 / 最終成果物) ================= */

  // 最終成果物モードか(コメント・\todo・ファイルリンクを出力しないクリーン出力)。
  function isFinalOutput() {
    return !!(currentId && store[currentId] && store[currentId].finalOutput);
  }

  function syncOutputModeUI() {
    var final = isFinalOutput();
    var btn = byId('output-mode-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', final ? 'true' : 'false');
      btn.classList.toggle('is-final', final);
      var lbl = btn.querySelector('.om-label');
      if (lbl) lbl.textContent = final ? t('output.final', '最終成果物') : t('output.draft', '作業用');
    }
    var cbs = document.querySelectorAll('.final-output-check');
    for (var i = 0; i < cbs.length; i++) cbs[i].checked = final;
  }

  function setOutputMode(final) {
    final = !!final;
    if (currentId && store[currentId]) store[currentId].finalOutput = final;
    syncOutputModeUI();
    saveNow();
    if (previewVisible()) scheduleCompile();
    if (sourceVisible()) scheduleSourceUpdate();
    notify(final ? t('output.finalNotice', '最終成果物モード: コメント・注釈を除いて出力します')
                 : t('output.draftNotice', '作業用モード: コメント・注釈を表示します'));
  }

  function toggleOutputMode() { setOutputMode(!isFinalOutput()); }

  /* ================= フェーズ17: スレッド(永続化・描画・配線) =================
     描画は window.Threads.render が担当。ここでは器(#thread-panel/#thread-list)への
     描画呼び出し、notes/threads.json + localStorage 永続化、旧コメント移行、
     フッタ/…メニュー/アンカージャンプ/ファイルチップ/ツリー D&D の配線を行う。
     Threads 未ロード(Model 未完)時はすべて存在チェックで安全に no-op。 */

  var THREADS_KEY = 'wordtex-threads';   // localStorage フォールバック: { [docId]: [...] }
  var THREAD_DND_TYPE = 'application/x-wordtex-file';  // filelink.js と共通
  var threadFileTimer = null;            // notes/threads.json 書き込みデバウンス
  var threadsWired = false;              // パネル委譲配線を一度だけ

  function threadsApi() { return window.Threads || null; }
  function threadListEl() { return byId('thread-list'); }
  function threadPanelEl() { return byId('thread-panel'); }

  function baseNameOf(p) {
    p = String(p || '');
    var i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  }
  // 永続化データ(配列 or {order,threads})を配列へ正規化
  function threadDataArray(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.threads)) return data.threads;
    return [];
  }
  // 現在のスレッド件数(list() 優先、無ければ toJSON)
  function threadCount() {
    var T = threadsApi();
    if (!T) return 0;
    try { if (typeof T.list === 'function') { var l = T.list(); if (Array.isArray(l)) return l.length; } } catch (e) {}
    return threadDataArray(serializeThreads()).length;
  }

  // Threads の現在配列を取得(複数のシリアライズ名に耐性)
  function serializeThreads() {
    var T = threadsApi();
    if (!T) return [];
    try {
      if (typeof T.serialize === 'function') { var s = T.serialize(); if (s) return s; }
      if (typeof T.toJSON === 'function') { var j = T.toJSON(); if (j) return j; }
      if (typeof T.list === 'function') { var l = T.list(); if (Array.isArray(l)) return l; }
    } catch (e) {}
    return [];
  }

  // 任意の保存形(配列 / {threads} / {order,threads} / 旧二重ネスト)をスレッド配列へ正規化
  function normalizeThreadData(data) {
    var d = data, guard = 0;
    while (d && !Array.isArray(d) && d.threads && !Array.isArray(d.threads) && guard++ < 4) d = d.threads;
    return threadDataArray(d);
  }
  // スレッド配列を Threads へ流し込む(複数のローダ名に耐性)
  function hydrateThreads(data) {
    var T = threadsApi();
    if (!T) return false;
    var arr = normalizeThreadData(data);
    var names = ['load', 'setAll', 'hydrate', 'import', 'replaceAll', 'restore', 'setList', 'fromJSON'];
    for (var i = 0; i < names.length; i++) {
      if (typeof T[names[i]] === 'function') { try { T[names[i]](arr); return true; } catch (e) {} }
    }
    return false;
  }

  function updateThreadChrome() {
    var n = threadCount();
    var badge = byId('thread-count');
    if (badge) badge.textContent = n > 0 ? String(n) : '';
    var empty = byId('thread-empty');
    if (empty) empty.hidden = n > 0 || !threadsApi();
    // 旧コメントパネルと同様、スレッドが 1 件以上なら器を表示(0 件で隠す)。
    // Threads 未ロード時は触らない(既存挙動を壊さない)。
    var panel = threadPanelEl();
    if (panel && threadsApi()) panel.hidden = n === 0;
    document.body.classList.toggle('has-threads', n > 0);
  }

  function renderThreadPanel() {
    var T = threadsApi();
    // editor.js の renderThreads と同じ #thread-panel を渡す(bindContainer の
    // 二重束縛によるカード操作の重複発火を防ぐ)。
    var el = threadPanelEl() || threadListEl();
    if (T && el && typeof T.render === 'function') {
      try { T.render(el); } catch (e) {}
    }
    updateThreadChrome();
  }

  // localStorage フォールバック保存(docId ごと)+ doc エントリ反映
  function persistThreadsLocal() {
    if (!currentId) return;
    var arr = serializeThreads();
    if (store[currentId]) store[currentId].threads = arr;
    var map = {};
    try { map = JSON.parse(safeGet(THREADS_KEY) || '{}') || {}; } catch (e) { map = {}; }
    if (!map || typeof map !== 'object') map = {};
    map[currentId] = arr;
    safeSet(THREADS_KEY, JSON.stringify(map));
  }

  // notes/threads.json 書き込み(プロジェクトモード, デバウンス)
  function scheduleThreadFilePush() {
    if (!projectMode) return;
    var pid = currentProjectId();
    if (!pid || !window.Projects || !window.Projects.writeFile) return;
    if (threadFileTimer) clearTimeout(threadFileTimer);
    threadFileTimer = setTimeout(function () {
      var payload = '{"order":[],"threads":[]}';
      try { payload = JSON.stringify(serializeThreads() || { threads: [] }); } catch (e) {}
      window.Projects.writeFile(pid, 'notes/threads.json', payload).catch(function () {});
    }, 1000);
  }

  // Threads 変更時(onChange)
  function onThreadsChange() {
    persistThreadsLocal();
    scheduleThreadFilePush();
    renderThreadPanel();
    scheduleSave();
  }

  // 現在文書のスレッドを Threads へ読み込む(openId から、Editor.refresh より前に呼ぶ)。
  //   保存済み(doc エントリ / localStorage)があれば hydrate、無ければ空にリセット。
  //   旧 comment-ref → thread-ref の移行は editor.js(migrateCommentRefsToThreads)が担うため
  //   ここでは移行しない(二重移行防止)。プロジェクトの notes/threads.json は非同期で上書き。
  function loadThreadsForCurrent() {
    var T = threadsApi();
    if (!T) return;
    var saved = null;
    if (currentId && store[currentId] && threadDataArray(store[currentId].threads).length) {
      saved = store[currentId].threads;
    }
    if (!saved) {
      try {
        var map = JSON.parse(safeGet(THREADS_KEY) || '{}') || {};
        if (currentId && map[currentId] && threadDataArray(map[currentId]).length) saved = map[currentId];
      } catch (e) {}
    }
    // 保存済みを流し込む。無ければ空にして前文書のスレッドを破棄(legacy 移行は editor.js)。
    hydrateThreads(saved || []);
    renderThreadPanel();

    // プロジェクトモード: ローカルに保存が無い時のみ、サーバーの notes/threads.json を取得
    // (別セッション/別端末での復元用)。ローカルにある場合は自動保存で同期済みのため読まない。
    if (projectMode && !saved) {
      var pid = currentProjectId();
      if (pid && window.Projects && window.Projects.readFile) {
        var reqId = currentId;
        window.Projects.readFile(pid, 'notes/threads.json', false).then(function (txt) {
          if (reqId !== currentId) return;   // 読み込み中に文書が切り替わったら破棄
          if (!txt || !txt.trim()) return;
          var parsed = null;
          try { parsed = JSON.parse(txt); } catch (e) { return; }
          if (!normalizeThreadData(parsed).length) return;   // 空ファイルで既存を消さない
          hydrateThreads(parsed);
          if (store[currentId]) store[currentId].threads = serializeThreads();
          renderThreadPanel();
        }).catch(function () {});
      }
    }
  }

  /* ---- カード操作の配線 ----
     カード内クリック(解決/削除/ジャンプ/コメント追加/ファイル添付/チップ/タイトル編集)は
     threads.js の render→bindContainer が自前で委譲配線するため、ここでは重複配線しない。
     app.js が担うのは (1) 「メモを新規作成して添付」で実ファイルを作る onCreateNote フック、
     (2) ファイルツリー → スレッドカードへの D&D 添付(threads.js 側に無い機能)。 */

  // 「メモを新規作成して添付」: notes/ に .md を作成し、Threads へ path を返す。
  // threads.js の addNoteTo(tid, cb) から呼ばれる(cb(path,label) が addFile する)。
  function threadNoteCreator(tid, cb) {
    var name = window.prompt(t('threads.notePrompt', '新規メモの名前(.md)'), 'idea.md');
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!/\.md$/i.test(name)) name += '.md';
    var path = 'notes/' + name;
    var label = name;
    var content = '# ' + name.replace(/\.md$/i, '') + '\n\n';
    function done() { if (typeof cb === 'function') cb(path, label); }
    if (projectMode && currentProjectId() && window.Projects && window.Projects.writeFile) {
      window.Projects.writeFile(currentProjectId(), path, content).then(function () {
        done();
        if (window.FileTree && window.FileTree.reload) window.FileTree.reload();
      }).catch(function () { done(); });
    } else {
      done();   // localStorage モードでは実ファイル無しでも file item を作る
    }
  }

  function clearThreadDropTargets() {
    var els = document.querySelectorAll('#thread-panel .thread-card.drop-target');
    for (var i = 0; i < els.length; i++) els[i].classList.remove('drop-target');
  }
  function dndHasFile(dt) {
    if (!dt || !dt.types) return false;
    try { for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === THREAD_DND_TYPE) return true; } catch (e) {}
    return false;
  }

  // #thread-panel の委譲配線(ツリー D&D のみ)。一度だけ。
  function wireThreadPanel() {
    if (threadsWired) return;
    var panel = threadPanelEl();
    if (!panel) return;
    threadsWired = true;

    // ツリーのファイル → スレッドカードへ D&D 添付
    panel.addEventListener('dragover', function (e) {
      if (!dndHasFile(e.dataTransfer)) return;
      var card = e.target.closest ? e.target.closest('.thread-card') : null;
      if (!card) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {}
      clearThreadDropTargets();
      card.classList.add('drop-target');
    });
    panel.addEventListener('dragleave', function (e) {
      var card = e.target.closest ? e.target.closest('.thread-card') : null;
      if (card && !card.contains(e.relatedTarget)) card.classList.remove('drop-target');
    });
    panel.addEventListener('drop', function (e) {
      var card = e.target.closest ? e.target.closest('.thread-card') : null;
      clearThreadDropTargets();
      if (!card) return;
      var path = '';
      try { path = e.dataTransfer.getData(THREAD_DND_TYPE); } catch (x) { path = ''; }
      if (!path) return;
      e.preventDefault();
      var T = threadsApi();
      var tid = card.getAttribute('data-tid') || '';
      if (T && typeof T.addFile === 'function' && tid) {
        try { T.addFile(tid, path, '', baseNameOf(path)); } catch (x) {}
        renderThreadPanel();
      }
    });
  }

  // Threads の onChange 購読 + onCreateNote フック登録を一度だけ。
  function subscribeThreads() {
    var T = threadsApi();
    if (!T) return;
    if (typeof T.onChange === 'function') { try { T.onChange(onThreadsChange); } catch (e) {} }
    else if (typeof T.subscribe === 'function') { try { T.subscribe(onThreadsChange); } catch (e) {} }
    if (typeof T.onCreateNote === 'function') { try { T.onCreateNote(threadNoteCreator); } catch (e) {} }
  }

  /* ================= コンパイル / プレビュー ================= */

  function previewVisible() {
    var pane = byId('preview-pane');
    return !!pane && !pane.hidden;
  }

  function sourceVisible() {
    var pane = byId('source-pane');
    return !!pane && !pane.hidden;
  }

  function generateLatex(docEl, overrides) {
    // フェーズ19: コンパイル時は資産参照を data:URL へ解決したクローンを渡せる(latex.js は data:URL 前提)
    var d = docEl || doc();
    if (!d || !window.LatexGen) return '';
    overrides = overrides || {};
    var final = overrides.finalOutput === undefined ? isFinalOutput() : !!overrides.finalOutput;
    // フェーズ31: 温存プリアンブル。.tex-preamble ノード(main.html 内に自己完結で保存)
    //   から取り出し、data-use=1(既定)なら元プリアンブルを使って出力する。
    var customPreamble = null, usePreamble = true;
    var preNode = d.querySelector ? d.querySelector('.tex-preamble') : null;
    if (preNode) {
      customPreamble = preNode.getAttribute('data-tex-raw') || '';
      usePreamble = preNode.getAttribute('data-use') !== '0';
    }
    return window.LatexGen.generate(d, {
      customPreamble: customPreamble,
      usePreamble: usePreamble,
      margin: options.margin,
      landscape: options.landscape,
      toc: options.toc,
      // フェーズ30: レイアウト強化(既定値では従来出力と一致)
      columns: options.columns,
      paper: options.paper,
      lineHeight: options.lineHeight,
      paraSpace: options.paraSpace,
      lineNumbers: options.lineNumbers,
      language: (window.Editor && window.Editor.getDocLanguage) ? window.Editor.getDocLanguage() : docLanguage,
      // フェーズ15: 最終成果物モードではコメントを注釈として出力しない
      comments: final ? null : ((window.Editor && window.Editor.getComments) ? window.Editor.getComments() : null),
      bibStyle: bibStyle,
      finalOutput: final,
      includeFileLinks: false
    });
  }

  /* ===== コンパイル用アセット(画像 + refs.bib) ===== */

  function utf8ToBase64(str) {
    try {
      return btoa(unescape(encodeURIComponent(String(str))));
    } catch (e) {
      try { return btoa(String(str)); } catch (e2) { return ''; }
    }
  }

  function docHasBibliographyBlock() {
    var d = doc();
    return !!(d && d.querySelector('.bibliography'));
  }
  function docHasBib() {
    var d = doc();
    return !!(d && d.querySelector('.cite, .bibliography'));
  }

  // 文献目録ブロックがあれば refs.bib を必ず添付(文献 0 件でも空ファイルを渡し、
  // bibtex が「ファイルが無い」エラーで停止しないようにする)。
  function bibAsset() {
    if (!window.Bib) return null;
    if (!docHasBibliographyBlock() && !bibEntries.length) return null;
    if (!docHasBib()) return null;
    var text = window.Bib.serialize(bibEntries || []);
    return { name: 'refs.bib', base64: utf8ToBase64(text) };
  }

  function collectCompileAssets(docEl) {
    var d = docEl || doc();
    var assets = [];
    if (d && window.LatexGen && window.LatexGen.collectAssets) {
      assets = window.LatexGen.collectAssets(d).map(function (a) {
        return { name: a.name, base64: a.base64 };
      });
    }
    var ba = bibAsset();
    if (ba) assets.push(ba);
    return assets;
  }

  // フェーズ19: コンパイル前に画像参照(assets/ パス・Storage URL)を data:URL へ解決した
  //   #doc のクローンを作る。latex.js(collectAssets / imageLatex)は data:URL を前提とするため、
  //   参照のままだと画像が PDF に出ない。ライブ DOM は変更しない(base64 を戻さない)。
  function resolveDocImages() {
    var d = doc();
    if (!d) return Promise.resolve(null);
    var A = window.Assets;
    if (!A || !A.isRef || !A.resolveImgToDataUrl) return Promise.resolve(d);
    var live = d.querySelectorAll ? d.querySelectorAll('img') : [];
    var needs = false;
    for (var i = 0; i < live.length; i++) { if (A.isRef(live[i])) { needs = true; break; } }
    if (!needs) return Promise.resolve(d);   // 全て base64(旧文書)なら解決不要
    var clone = d.cloneNode(true);
    var imgs = clone.querySelectorAll('img');
    var tasks = [];
    for (var j = 0; j < imgs.length; j++) {
      (function (img) {
        if (!A.isRef(img)) return;   // data: 等はそのまま
        tasks.push(A.resolveImgToDataUrl(img).then(function (dataUrl) {
          if (dataUrl) img.setAttribute('src', dataUrl);
        }).catch(function () { /* 解決失敗時は latex.js が [画像] にフォールバック */ }));
      })(imgs[j]);
    }
    return Promise.all(tasks).then(function () { return clone; });
  }

  // コンパイル/ダウンロード/共有 が使う共通ペイロード(latex + assets)を非同期に用意。
  function prepareCompilePayload() {
    return resolveDocImages().then(function (rd) {
      return { latex: generateLatex(rd), assets: collectCompileAssets(rd) };
    });
  }

  function recordCompile() {
    lastCompileTime = Date.now();
    safeSet(LAST_COMPILE_KEY, String(lastCompileTime));
    var el = byId('stat-compile');
    if (el) el.textContent = compileTimeLabel();
  }

  function showCompileError(log) {
    var errEl = byId('compile-error');
    var frame = byId('pdf-frame');
    if (errEl) {
      errEl.textContent = log || 'コンパイルに失敗しました。';
      errEl.hidden = false;
    }
    if (frame) frame.hidden = true;
    if (window.A11y && window.A11y.alert) {
      var first = String(log || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
      window.A11y.alert('コンパイルに失敗しました。' + first.slice(0, 120));
    }
  }

  function showPdf(blob) {
    var frame = byId('pdf-frame');
    var errEl = byId('compile-error');
    if (errEl) errEl.hidden = true;
    if (!frame) return;
    frame.hidden = false;
    var url = URL.createObjectURL(blob);
    if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
    lastPdfUrl = url;
    frame.src = url;
    if (window.A11y && window.A11y.announce) window.A11y.announce('PDFを更新しました');
  }

  // フェーズ10b: クラウドモードでサインイン中なら IDトークンを Authorization に付与。
  //   ローカルモード(Cloud 無効/未サインイン)では getIdToken() が null を返すため
  //   ヘッダは一切追加されず、従来動作を維持する(ローカル server.js も Authorization を無視)。
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

  // 401 応答時の共通表示(クラウドの認可切れ)
  function isAuthError(res) { return res && res.status === 401; }

  function compile() {
    // フェーズ27: tex モード中はプロジェクトコンパイル(latexmk main.tex 直)へ委譲
    if (texMode) { compileTexProject(); return; }
    if (compiling) { compileQueued = true; return; }
    var d = doc();
    if (!d || !window.LatexGen) return;
    compiling = true;
    if (window.A11y && window.A11y.announce) window.A11y.announce('PDFをコンパイルしています');
    prepareCompilePayload().then(function (payload) {
      return withAuthHeaders({ 'Content-Type': 'application/json' }).then(function (headers) {
        return fetch('/compile', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ latex: payload.latex, assets: payload.assets })
        });
      });
    }).then(function (res) {
      if (res.status === 200) {
        recordCompile();
        return res.blob().then(showPdf);
      }
      if (isAuthError(res)) { showCompileError('ログインが必要です'); return; }
      return res.text().then(function (text) {
        var log = text;
        try {
          var json = JSON.parse(text);
          log = json.log || json.error || text;
        } catch (e) { }
        showCompileError(log);
      });
    }).catch(function (err) {
      showCompileError('サーバーに接続できません: ' + err.message);
    }).finally(function () {
      compiling = false;
      if (compileQueued) {
        compileQueued = false;
        compile();
      }
    });
  }

  function scheduleCompile() {
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = setTimeout(compile, 1500);
  }

  /* ================= ソース表示 ================= */

  function updateSourceView() {
    var pre = byId('latex-source');
    if (!pre) return;
    var code = pre.querySelector('code');
    if (!code) {
      code = document.createElement('code');
      pre.appendChild(code);
    }
    code.textContent = generateLatex();
  }

  function scheduleSourceUpdate() {
    if (sourceTimer) clearTimeout(sourceTimer);
    sourceTimer = setTimeout(updateSourceView, 500);
  }

  function updateWorkspaceClasses() {
    document.body.classList.toggle('show-source', sourceVisible());
    document.body.classList.toggle('show-preview', previewVisible());
  }

  function toggleSource() {
    var pane = byId('source-pane');
    if (!pane) return;
    pane.hidden = !pane.hidden;
    if (!pane.hidden) updateSourceView();
    updateWorkspaceClasses();
  }

  function togglePreview() {
    var pane = byId('preview-pane');
    if (!pane) return;
    pane.hidden = !pane.hidden;
    if (!pane.hidden) compile();
    updateWorkspaceClasses();
  }

  /* ================= ズーム ================= */

  function applyZoom(v) {
    zoomValue = Math.max(50, Math.min(200, Math.round(Number(v) || 100)));
    var pc = byId('page-container');
    if (pc) {
      pc.style.transform = 'scale(' + (zoomValue / 100) + ')';
      pc.style.transformOrigin = 'top center';
    }
    var slider = byId('zoom-slider');
    if (slider) {
      if (String(slider.value) !== String(zoomValue)) slider.value = zoomValue;
      slider.setAttribute('aria-valuetext', zoomValue + '%');  // フェーズ4
    }
    var label = byId('zoom-level');
    if (label) label.textContent = zoomValue + '%';
  }

  /* ================= レイアウト(余白・向き・用紙・段組み・行間・行番号) ================= */

  var MARGIN_PADDINGS = {
    normal: { tb: '30mm', lr: '25mm' },
    narrow: { tb: '12.7mm', lr: '12.7mm' },
    wide: { tb: '25.4mm', lr: '50.8mm' }
  };

  // フェーズ30: 用紙寸法(mm, 縦向き基準)。編集シート/ルーラーの寸法計算に使う。
  var PAPER_MM = {
    a4: { w: 210, h: 297 },
    b5: { w: 182, h: 257 },   // JIS B5
    letter: { w: 216, h: 279 }
  };
  // 編集表示の行間(既定 1.15 は #doc の既定 line-height 1.7 を維持=無変化)
  var LINEHEIGHT_CSS = { '1.0': '1.4', '1.15': '', '1.5': '2.1', '2.0': '2.7' };

  function applyMargin(value) {
    if (!MARGIN_PADDINGS[value]) value = 'normal';
    options.margin = value;
    var d = doc();
    if (d) {
      var p = MARGIN_PADDINGS[value];
      d.style.padding = p.tb + ' ' + p.lr;
    }
    reflectLayoutUI();
  }

  // フェーズ30: 用紙サイズ・向きから CSS 変数(--page-w/--page-h)と body 属性を更新。
  // #page-container/#page-sheets/.sheet/#doc/ルーラーはこの変数に追随する(CSS 側)。
  function applyPageMetrics() {
    var dim = PAPER_MM[options.paper] || PAPER_MM.a4;
    var wMm = options.landscape ? dim.h : dim.w;
    var hMm = options.landscape ? dim.w : dim.h;
    var root = document.documentElement;
    root.style.setProperty('--page-w', wMm + 'mm');
    root.style.setProperty('--page-h', hMm + 'mm');
    document.body.dataset.paper = options.paper;
    document.body.classList.toggle('landscape', options.landscape);
  }

  function applyPaper(value) {
    if (!PAPER_MM[value]) value = 'a4';
    options.paper = value;
    applyPageMetrics();
    if (window.Editor && window.Editor.refresh) window.Editor.refresh();
    reflectLayoutUI();
  }

  function applyOrientation(landscape) {
    options.landscape = !!landscape;
    applyPageMetrics();
    if (window.Editor && window.Editor.refresh) window.Editor.refresh();
    reflectLayoutUI();
  }

  // フェーズ30: 段組み(編集表示は CSS multicol)。既定 one では属性を外し無変化。
  function applyColumns(value) {
    if (value !== 'two' && value !== 'three' && value !== 'rule2') value = 'one';
    options.columns = value;
    var d = doc();
    if (d) {
      if (value === 'one') d.removeAttribute('data-columns');
      else d.setAttribute('data-columns', value);
    }
    reflectLayoutUI();
  }

  // フェーズ30: 行間(編集表示は #doc の line-height を上書き。既定 1.15 は解除=1.7)
  function applyLineHeight(value) {
    if (!LINEHEIGHT_CSS.hasOwnProperty(value)) value = '1.15';
    options.lineHeight = value;
    var d = doc();
    if (d) d.style.lineHeight = LINEHEIGHT_CSS[value] || '';
    reflectLayoutUI();
  }

  // フェーズ30: 段落後スペース(編集表示は #doc[data-paraspace])
  function applyParaSpace(on) {
    options.paraSpace = !!on;
    var d = doc();
    if (d) {
      if (options.paraSpace) d.setAttribute('data-paraspace', 'on');
      else d.removeAttribute('data-paraspace');
    }
    reflectLayoutUI();
  }

  // フェーズ30: 行番号。編集画面では再現せずボタン状態のみ(PDF で付与される)。
  function applyLineNumbers(on) {
    options.lineNumbers = !!on;
    reflectLayoutUI();
  }

  // ドロップダウン/トグルの選択状態(is-active)をオプションへ同期
  function reflectLayoutUI() {
    setMenuActive('columns', options.columns);
    setMenuActive('paper', options.paper);
    setMenuActive('lineHeight', options.lineHeight);
    setToggleActive('paraSpace', options.paraSpace);
    setToggleActive('lineNumbers', options.lineNumbers);
    setToggleActive('orientPortrait', !options.landscape);
    setToggleActive('orientLandscape', options.landscape);
  }
  function setMenuActive(cmd, value) {
    var btns = document.querySelectorAll('[data-command="' + cmd + '"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i].getAttribute('data-value') === String(value));
    }
  }
  function setToggleActive(cmd, on) {
    var btns = document.querySelectorAll('[data-command="' + cmd + '"]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('is-active', !!on);
  }
  function announceLayout(msg) {
    if (window.A11y && window.A11y.announce) { try { window.A11y.announce(msg); } catch (e) {} }
  }
  function columnsLabel(v) {
    return t('columns.' + v, v === 'two' ? '2段' : v === 'three' ? '3段' : v === 'rule2' ? '境界線つき2段' : '1段');
  }
  function paperLabel(v) {
    return v === 'b5' ? 'B5' : v === 'letter' ? (t('paper.letter', 'レター')) : 'A4';
  }

  function toggleToc() {
    options.toc = !options.toc;
    var btns = document.querySelectorAll('[data-command="toc"]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('is-active', options.toc);
    afterDocChange();
  }

  /* ================= 新規 / 開く / ダウンロード ================= */

  function newDocument() {
    createDoc('blank');
    closeBackstage();
    afterDocChange();
  }

  function newFromTemplate(templateName) {
    createDoc(templateName || 'blank');
    closeBackstage();
    afterDocChange();
  }

  function closeBackstage() {
    var bs = byId('backstage');
    if (bs) bs.hidden = true;   // ui.js の closeBackstage と同じ挙動
  }

  function openTex() {
    var input = byId('tex-input');
    if (input) input.click();
  }

  function setupTexInput() {
    var input = byId('tex-input');
    if (!input) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var content = String(reader.result || '');
        if (/\.bib$/i.test(file.name)) importBibText(content, file.name); // 開くカードで .bib を選んだ場合
        else importTex(content);
      };
      reader.readAsText(file);
    });
  }

  /* ---- 簡易 .tex → DOM パーサ(主要コマンドのみ) ---- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // フェーズ31: 属性へ生 LaTeX を安全に格納(HTML 実体参照化)。改行も実体参照化して
  //   単一属性に収める(ブラウザの getAttribute が復号して原文へ戻す)。
  function texRawAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '');
  }
  function texRawSpan(raw) {
    return '<span class="tex-raw" contenteditable="false" data-tex-raw="' + texRawAttr(raw) + '"></span>';
  }
  function texRawBlock(raw) {
    return '<div class="tex-raw" contenteditable="false" data-tex-raw="' + texRawAttr(raw) + '"></div>';
  }

  // 位置 pos の '{' から対応する '}' までを読む(ネスト対応)。無ければ null。
  function readBraceGroup(s, pos) {
    if (s.charAt(pos) !== '{') return null;
    var depth = 0;
    for (var j = pos; j < s.length; j++) {
      var ch = s.charAt(j);
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return { inner: s.slice(pos + 1, j), end: j + 1 }; }
    }
    return null;
  }
  function readOptGroup(s, pos) {
    if (s.charAt(pos) !== '[') return null;
    var j = s.indexOf(']', pos);
    if (j < 0) return null;
    return { inner: s.slice(pos + 1, j), end: j + 1 };
  }

  // \cmd に続く [..] / {..} 引数群をまとめて読み、原文スライスを返す(温存用)。
  function readCommandRaw(s, pos) {
    // pos は '\' の位置
    var m = /^\\([a-zA-Z]+\*?|.)/.exec(s.slice(pos));
    if (!m) return null;
    var end = pos + m[0].length;
    var name = m[1];
    // 制御綴り(英字コマンド)のみ後続引数を吸収する。制御記号(\, など)は綴りのみ。
    if (/^[a-zA-Z]/.test(name)) {
      // 直後の空白は引数区切りではないので命令名に含めない(温存は綴りまで)
      while (true) {
        var c = s.charAt(end);
        if (c === '[') { var o = readOptGroup(s, end); if (!o) break; end = o.end; }
        else if (c === '{') { var g = readBraceGroup(s, end); if (!g) break; end = g.end; }
        else break;
      }
    }
    return { name: name, raw: s.slice(pos, end), end: end };
  }

  var INLINE_WRAP = {
    'textbf': 'strong', 'textit': 'em', 'emph': 'em', 'textsl': 'em',
    'underline': 'u', 'uline': 'u', 'CJKunderline': 'u',
    'sout': 's', 'CJKsout': 's',
    'texttt': 'span:ff-mono', 'textsf': 'span:ff-sans', 'textrm': 'span:ff-serif'
  };

  // フェーズ31: インライン LaTeX を HTML 化。既知の書式/数式/引用/脚注は変換し、
  //   未知コマンドは tex-raw インライン span として原文温存する(ラウンドトリップ安全)。
  function texInlineToHtml(s) {
    s = String(s == null ? '' : s);
    var out = '';
    var buf = '';
    function flush() { if (buf) { out += escapeHtml(buf); buf = ''; } }
    var i = 0, n = s.length;
    while (i < n) {
      var ch = s.charAt(i);
      // インライン数式 $...$
      if (ch === '$') {
        var end = s.indexOf('$', i + 1);
        if (end > i) {
          var tex = s.slice(i + 1, end);
          if (tex.trim()) {
            flush();
            out += '<span class="math-inline" contenteditable="false" data-tex="' +
              texRawAttr(tex) + '">' + escapeHtml(tex) + '</span>';
          }
          i = end + 1; continue;
        }
        buf += ch; i++; continue;
      }
      if (ch !== '\\') { buf += ch; i++; continue; }
      // バックスラッシュ始まり
      var rest = s.slice(i);
      // \( ... \) インライン数式
      var dm = /^\\\(([\s\S]*?)\\\)/.exec(rest);
      if (dm) {
        if (dm[1].trim()) {
          flush();
          out += '<span class="math-inline" contenteditable="false" data-tex="' +
            texRawAttr(dm[1]) + '">' + escapeHtml(dm[1]) + '</span>';
        }
        i += dm[0].length; continue;
      }
      // 強制改行 \\
      if (/^\\\\/.test(rest)) { flush(); out += '<br>'; i += 2; continue; }
      // エスケープ文字 \# \$ \% \& \_ \{ \} → そのままの文字
      var esc = /^\\([#$%&_{}])/.exec(rest);
      if (esc) { buf += esc[1]; i += 2; continue; }
      var mt;
      if ((mt = /^\\textbackslash\{\}/.exec(rest))) { buf += '\\'; i += mt[0].length; continue; }
      if ((mt = /^\\textasciitilde\{\}/.exec(rest))) { buf += '~'; i += mt[0].length; continue; }
      if ((mt = /^\\textasciicircum\{\}/.exec(rest))) { buf += '^'; i += mt[0].length; continue; }
      // コマンド + 引数群を読む
      var cmd = readCommandRaw(s, i);
      if (!cmd) { buf += ch; i++; continue; }
      var name = cmd.name;
      // 既知の書式コマンド(引数を1つ取り、内側を再帰変換)
      if (INLINE_WRAP.hasOwnProperty(name)) {
        var g0 = readBraceGroup(s, i + 1 + name.length);
        if (g0) {
          flush();
          var w = INLINE_WRAP[name];
          var inner = texInlineToHtml(g0.inner);
          if (w.indexOf('span:') === 0) out += '<span class="' + w.slice(5) + '">' + inner + '</span>';
          else out += '<' + w + '>' + inner + '</' + w + '>';
          i = g0.end; continue;
        }
      }
      // \cite / \citep / \citet{keys}(オプション引数は無視、キーのみ)
      if (name === 'cite' || name === 'citep' || name === 'citet' || name === 'citeyear' || name === 'citeauthor') {
        var p = i + 1 + name.length;
        while (s.charAt(p) === '[') { var oo = readOptGroup(s, p); if (!oo) break; p = oo.end; }
        var gc = readBraceGroup(s, p);
        if (gc) {
          var keys = gc.inner.split(',').map(function (x) { return x.trim(); })
            .filter(function (x) { return !!x; }).join(',');
          if (keys) {
            flush();
            out += '<span class="cite" contenteditable="false" data-key="' + texRawAttr(keys) + '">[' + escapeHtml(keys) + ']</span>';
          }
          i = gc.end; continue;
        }
      }
      // \footnote{...}: 中身が単純(バックスラッシュを含まない)なら脚注 span、
      //   複雑なら原文温存(\footnote{...} まるごと tex-raw)。
      if (name === 'footnote') {
        var gf = readBraceGroup(s, i + 1 + name.length);
        if (gf && gf.inner.indexOf('\\') === -1 && gf.inner.indexOf('$') === -1) {
          flush();
          out += '<span class="footnote" contenteditable="false" data-note="' + texRawAttr(gf.inner) + '">*</span>';
          i = gf.end; continue;
        }
        // fallthrough → tex-raw
      }
      // それ以外の未知コマンド → インライン温存(原文そのまま)
      flush();
      out += texRawSpan(cmd.raw);
      i = cmd.end;
    }
    flush();
    return out;
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // フェーズ31: \begin{env} 行(start)から対応する \end{env} までを、同名ネストを
  //   カウントしながら丸ごと取り込む。取り違え(内側の同名環境を終端と誤認)を防ぐ。
  function captureEnv(lines, start, env) {
    var reB = new RegExp('\\\\begin\\{' + escapeRe(env) + '\\}', 'g');
    var reE = new RegExp('\\\\end\\{' + escapeRe(env) + '\\}', 'g');
    var depth = 0;
    var collected = [];
    for (var k = start; k < lines.length; k++) {
      collected.push(lines[k]);
      depth += (lines[k].match(reB) || []).length - (lines[k].match(reE) || []).length;
      if (depth <= 0) return { raw: collected.join('\n'), next: k + 1 };
    }
    return { raw: collected.join('\n'), next: lines.length };
  }

  // 行全体が LaTeX コマンド(+引数)だけで、地の文を含まないか。含まないなら温存ブロック。
  function isCommandOnlyLine(str) {
    var s = str, i = 0, sawCmd = false;
    while (i < s.length) {
      if (/\s/.test(s.charAt(i))) { i++; continue; }
      if (s.charAt(i) !== '\\') return false;
      var cmd = readCommandRaw(s, i);
      if (!cmd || cmd.end <= i) return false;
      sawCmd = true;
      i = cmd.end;
    }
    return sawCmd;
  }

  // これらの数式環境のみ math-display へ変換(整列 & を含む align/gather 等は温存)。
  var MATH_CONVERT_ENVS = { 'equation': 1, 'displaymath': 1, 'math': 1 };

  // .tex ソース → { html, preamble, stats }。DOM には触れない(ドライラン兼用)。
  function parseTex(src) {
    src = String(src == null ? '' : src);
    var preamble = null;
    var body = src;
    var bd = src.indexOf('\\begin{document}');
    if (bd >= 0) {
      preamble = src.slice(0, bd).replace(/\s+$/, '');
      // 生成マーカー行が先頭にあれば除去(温存プリアンブルへ残さない=ラウンドトリップ多重化防止)。
      var marker = (window.LatexGen && window.LatexGen.GEN_MARKER) || '% Generated by TailorTeX';
      if (preamble.indexOf(marker) === 0) preamble = preamble.slice(marker.length).replace(/^\s*\n/, '');
      var ed = src.indexOf('\\end{document}', bd);
      body = src.slice(bd + '\\begin{document}'.length, ed >= 0 ? ed : undefined);
    }
    // 本文のみコメント除去(\% は残す)。プリアンブルは温存のため触らない。
    body = body.replace(/(^|[^\\])%.*$/gm, '$1');

    var html = [];
    var lines = body.split('\n');
    var listStack = [];  // 'ul' | 'ol'
    var quote = false;
    var para = [];
    var localToc = false;
    var localBibStyle = null;

    function flushPara() {
      var text = para.join(' ').replace(/\s+/g, ' ').trim();
      para = [];
      if (!text) return;
      var content = texInlineToHtml(text);
      if (listStack.length) html.push('<li>' + content + '</li>');
      else if (quote) html.push('<blockquote>' + content + '</blockquote>');
      else html.push('<p>' + content + '</p>');
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();
      var hm;

      // 見出し
      if ((hm = /^\\section\*?\{(.*)\}\s*$/.exec(trimmed))) { flushPara(); html.push('<h1>' + texInlineToHtml(hm[1]) + '</h1>'); i++; continue; }
      if ((hm = /^\\subsection\*?\{(.*)\}\s*$/.exec(trimmed))) { flushPara(); html.push('<h2>' + texInlineToHtml(hm[1]) + '</h2>'); i++; continue; }
      if ((hm = /^\\subsubsection\*?\{(.*)\}\s*$/.exec(trimmed))) { flushPara(); html.push('<h3>' + texInlineToHtml(hm[1]) + '</h3>'); i++; continue; }

      // \[ ... \] 表示数式(行頭始まり)
      if (/^\\\[/.test(trimmed)) {
        flushPara();
        var acc = [trimmed.replace(/^\\\[/, '')];
        var closed = /\\\]/.test(acc[0]);
        var j = i;
        while (!closed && j + 1 < lines.length) { j++; acc.push(lines[j]); if (/\\\]/.test(lines[j])) closed = true; }
        var dtex = acc.join('\n').replace(/\\\][\s\S]*$/, '').trim();
        if (dtex) html.push('<div class="math-display" contenteditable="false" data-tex="' + texRawAttr(dtex) + '">' + escapeHtml(dtex) + '</div>');
        i = j + 1; continue;
      }

      // 環境開始
      var eb = /^\\begin\{([^{}]+)\}/.exec(trimmed);
      if (eb) {
        var env = eb[1];
        if (env === 'itemize') { flushPara(); listStack.push('ul'); html.push('<ul>'); i++; continue; }
        if (env === 'enumerate') { flushPara(); listStack.push('ol'); html.push('<ol>'); i++; continue; }
        if (env === 'quote' || env === 'quotation') { flushPara(); quote = true; i++; continue; }
        if (env === 'verbatim' || env === 'lstlisting' || env === 'Verbatim') {
          flushPara();
          var cap = captureEnv(lines, i, env);
          // verbatim は中身のみ <pre> へ(温存でなくコード表示)。ただし lstlisting は
          //   オプション付き構文があるため素直に温存する方が安全。
          if (env === 'verbatim') {
            var vin = cap.raw.replace(/^[^\n]*\n?/, '').replace(/\n?\\end\{verbatim\}\s*$/, '');
            html.push('<pre class="code">' + escapeHtml(vin) + '</pre>');
          } else {
            html.push(texRawBlock(cap.raw));
          }
          i = cap.next; continue;
        }
        if (MATH_CONVERT_ENVS[env]) {
          flushPara();
          var mc = captureEnv(lines, i, env);
          var mtex = mc.raw.replace(/^[^\n]*\n?/, '').replace(/\n?\\end\{[^{}]*\}\s*$/, '').trim();
          if (mtex) html.push('<div class="math-display" contenteditable="false" data-tex="' + texRawAttr(mtex) + '">' + escapeHtml(mtex) + '</div>');
          i = mc.next; continue;
        }
        // 未知環境(figure/table/abstract/tikzpicture/algorithm/acmart系 等)→ 温存ブロック
        flushPara();
        var raw = captureEnv(lines, i, env);
        html.push(texRawBlock(raw.raw));
        i = raw.next; continue;
      }

      // 環境終了
      if (/^\\end\{(itemize)\}/.test(trimmed)) { flushPara(); if (listStack.length) html.push('</' + listStack.pop() + '>'); i++; continue; }
      if (/^\\end\{(enumerate)\}/.test(trimmed)) { flushPara(); if (listStack.length) html.push('</' + listStack.pop() + '>'); i++; continue; }
      if (/^\\end\{(quote|quotation)\}/.test(trimmed)) { flushPara(); quote = false; i++; continue; }

      // 単純コマンド
      if (/^\\newpage\b/.test(trimmed) || /^\\clearpage\b/.test(trimmed) || /^\\pagebreak\b/.test(trimmed)) { flushPara(); html.push('<div class="page-break" contenteditable="false"></div>'); i++; continue; }
      if (/^\\noindent\\rule/.test(trimmed) || /^\\hrule/.test(trimmed)) { flushPara(); html.push('<hr>'); i++; continue; }
      if (/^\\tableofcontents\b/.test(trimmed)) { flushPara(); localToc = true; i++; continue; }
      if ((hm = /^\\bibliographystyle\{([^{}]*)\}/.exec(trimmed))) { localBibStyle = (hm[1] || '').trim() || 'plain'; i++; continue; }
      if (/^\\bibliography\{/.test(trimmed)) { flushPara(); html.push('<div class="bibliography" contenteditable="false">' + escapeHtml(t('bib.refHeading', '参考文献')) + '</div>'); i++; continue; }
      if ((hm = /^\\item\s*(.*)$/.exec(trimmed))) {
        flushPara();
        if (!listStack.length) { listStack.push('ul'); html.push('<ul>'); }
        if (hm[1]) para.push(hm[1]);
        i++; continue;
      }

      if (trimmed === '') { flushPara(); i++; continue; }

      // 行全体がコマンドのみ(地の文なし)→ 温存ブロック(\maketitle 等)
      if (trimmed.charAt(0) === '\\' && isCommandOnlyLine(trimmed)) {
        flushPara();
        html.push(texRawBlock(trimmed));
        i++; continue;
      }

      // それ以外は段落として蓄積(インライン変換で未知コマンドは tex-raw span 温存)
      para.push(trimmed);
      i++;
    }
    flushPara();
    while (listStack.length) html.push('</' + listStack.pop() + '>');

    var htmlStr = html.join('');
    var rawEnv = htmlStr;
    function cnt(re) { var m2 = rawEnv.match(re); return m2 ? m2.length : 0; }
    var stats = {
      headings: cnt(/<h[123]>/g),
      math: cnt(/class="math-(?:inline|display)"/g),
      cites: cnt(/class="cite"/g),
      footnotes: cnt(/class="footnote"/g),
      lists: cnt(/<[uo]l>/g),
      rawBlocks: cnt(/<div class="tex-raw"/g),
      rawInline: cnt(/<span class="tex-raw"/g),
      toc: localToc,
      bibStyle: localBibStyle
    };
    stats.converted = stats.headings + stats.math + stats.cites + stats.footnotes + stats.lists;
    stats.preserved = stats.rawBlocks + stats.rawInline;
    return { html: htmlStr, preamble: preamble, stats: stats };
  }

  // 変換結果を #doc へ適用する共通処理。usePreamble=false で元プリアンブルを保存しても
  //   出力時はエディタ標準を使う(既定は true = 温存プリアンブル使用)。
  function applyParsedTex(parsed, usePreamble) {
    var d = doc();
    if (!d) return;
    var parts = [];
    var pre = parsed.preamble;
    if (pre && /\\documentclass/.test(pre)) {
      parts.push('<div class="tex-preamble" hidden contenteditable="false" data-use="' +
        (usePreamble === false ? '0' : '1') + '" data-tex-raw="' + texRawAttr(pre) + '"></div>');
    }
    parts.push(parsed.html || '');
    d.innerHTML = parts.join('') || defaultDocHtml();
    if (parsed.stats && parsed.stats.toc) options.toc = true;
    if (parsed.stats && parsed.stats.bibStyle) { bibStyle = parsed.stats.bibStyle; syncBibStyleSelect(); }
    renderBibliographies();
    if (window.Editor) {
      if (window.Editor.renumberFootnotes) window.Editor.renumberFootnotes();
      if (window.Editor.renderMath) window.Editor.renderMath(d);
      if (window.Editor.decorateAnchors) window.Editor.decorateAnchors(d);
      if (window.Editor.renderTexRaw) window.Editor.renderTexRaw(d);
      if (window.Editor.resetHistory) window.Editor.resetHistory();
      if (window.Editor.refresh) window.Editor.refresh();
    }
  }

  // 「開く」カード等からの .tex 取り込み(非プロジェクトでも動く)。
  function importTex(src) {
    var parsed = parseTex(src);
    applyParsedTex(parsed, true);
    closeBackstage();
    saveNow();
    afterDocChange();
  }

  /* ================= フェーズ31: 既存 tex を Word 風編集へ変換 ================= */

  // ソース編集中の .tex を Word 風へ変換する。ドライラン → 確認 → 変換前自動コミット
  //   →(保護解除)main.html/main.tex 書き込み → Word 風へ切替。
  function convertTexToWord(path) {
    var pid = currentProjectId();
    if (!projectMode || !pid) { notify(t('conv.projectOnly', 'この操作はプロジェクトでのみ使えます')); return; }
    path = path || texModePath;
    if (!path) return;
    var ta = byId('tex-editor');
    // 未保存分を先に書き込んでから、現在の tex を読み直して変換する。
    Promise.resolve((texMode && texEditorDirty) ? saveTexNow() : null).then(function () {
      var src = (ta && typeof ta.value === 'string') ? ta.value : '';
      if (!src.trim() && window.Projects && window.Projects.readFile) {
        return window.Projects.readFile(pid, path, false).then(function (x) { return String(x || ''); });
      }
      return src;
    }).then(function (src) {
      if (!src || !src.trim()) { notify(t('conv.empty', '変換対象が空です')); return; }
      var parsed = parseTex(src);
      var bdPos = src.indexOf('\\begin{document}');
      var edPos = src.lastIndexOf('\\end{document}');
      var sourceBody = bdPos >= 0 ? src.slice(bdPos + 16, edPos > bdPos ? edPos : undefined) : src;
      var sourceMeaningful = sourceBody.replace(/%.*$/gm, '').replace(/\s+/g, '').length;
      var parsedMeaningful = String(parsed.html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
      if (sourceMeaningful < 20 || (sourceMeaningful >= 500 &&
          String(parsed.html || '').length < Math.max(100, Math.floor(sourceBody.length * 0.05)))) {
        notify(t('conv.lossDetected', '変換結果が空または極端に少ないため中止しました。元の main.tex は変更していません。'));
        return;
      }
      var st = parsed.stats;
      var hasPre = !!(parsed.preamble && /\\documentclass/.test(parsed.preamble));
      // 確認ダイアログ(変換要素数・温存ブロック数)
      var msg = fmt(t('conv.confirm',
        '「{path}」を Word 風編集へ変換します。\n\n' +
        '変換される要素: 見出し {h} / 数式 {m} / 引用 {c} / 脚注 {f} / リスト {l}\n' +
        '原文のまま温存: ブロック {rb} / インライン {ri}\n' +
        '\nmain.tex は以後エディタ生成に置き換わります(現状は変換前に自動コミットされ、ソースモードへはいつでも戻れます)。\n\n変換しますか?'),
        { path: path, h: st.headings, m: st.math, c: st.cites, f: st.footnotes, l: st.lists, rb: st.rawBlocks, ri: st.rawInline });
      if (hasPre) msg += '\n\n' + t('conv.confirmPre', '(元のプリアンブルを温存し、コンパイル時に使用します)');
      if (!window.confirm(msg)) return;

      // 1) Gitとは別に原文バックアップを保存してから自動コミット。
      //    コミット対象が既に壊れていた場合でも、変換ボタンが実際に読んだ原文を復元できる。
      var backupName = String(path).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
      var backupPath = 'notes/recovery/' + backupName.replace(/\.tex$/i, '') + '-before-word-conversion.tex';
      var backupP = (window.Projects && window.Projects.writeFile)
        ? window.Projects.writeFile(pid, backupPath, src)
        : Promise.resolve(null);
      var commitP = backupP.then(function () {
        return (window.Projects && window.Projects.commit)
          ? window.Projects.commit(pid, t('conv.commitMsg', 'ビジュアル編集へ変換(復元用)'))
          : null;
      });
      commitP.then(function () {
        // 2) 変換結果を現在文書へ適用 + 保護解除フラグ
        converted[pid] = true;
        protectPromise[pid] = null;   // 次回 ensureProtectionFlags は生成 tex(マーカーあり)を読む
        applyParsedTex(parsed, true);
        captureCurrent();
        saveStore();
        // 3) main.html + 生成 main.tex を書き込む(保護解除済みなので main.tex も更新される)
        return pushProjectFiles(pid, true);
      }).then(function (saveResult) {
        if (saveResult && saveResult.texBlocked) throw new Error('loss_guard');
        // 保護解除は初回変換の1回だけ。以後は生成マーカーを再判定する。
        converted[pid] = false;
        protectPromise[pid] = null;
        if (window.FileTree) window.FileTree.reload();
        refreshProjectStatus();
        // 4) Word 風モードへ切替
        showMainDoc();
        notify(t('conv.done', 'Word 風編集へ変換しました(元 main.tex はコミット済み)'));
        if (window.A11y && window.A11y.announce) window.A11y.announce(t('conv.doneA11y', 'Word 風編集へ変換しました'));
      }).catch(function () {
        notify(t('conv.failed', '変換に失敗しました'));
      });
    }).catch(function () {
      notify(t('conv.failed', '変換に失敗しました'));
    });
  }

  // 温存プリアンブルの使用可否トグル(バックステージのチェックボックス)。
  function setUsePreamble(use) {
    var d = doc();
    var node = d && d.querySelector ? d.querySelector('.tex-preamble') : null;
    if (!node) return;
    node.setAttribute('data-use', use ? '1' : '0');
    captureCurrent();
    saveNow();
    if (previewVisible()) scheduleCompile();
    if (sourceVisible()) scheduleSourceUpdate();
    notify(use ? t('conv.preOn', '元の LaTeX プリアンブルを使用します')
               : t('conv.preOff', 'エディタ標準のプリアンブルで出力します'));
  }

  function syncPreambleUI() {
    var d = doc();
    var node = d && d.querySelector ? d.querySelector('.tex-preamble') : null;
    var wrap = byId('use-preamble-option');
    var cb = byId('use-preamble-check');
    if (wrap) wrap.hidden = !node;
    if (cb && node) cb.checked = node.getAttribute('data-use') !== '0';
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function downloadTex() {
    var latex = generateLatex();
    downloadBlob(new Blob([latex], { type: 'text/x-tex;charset=utf-8' }), 'document.tex');
  }

  function downloadPdf() {
    var d = doc();
    if (!d || !window.LatexGen) return;
    prepareCompilePayload().then(function (payload) {
      return withAuthHeaders({ 'Content-Type': 'application/json' }).then(function (headers) {
        return fetch('/compile', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ latex: payload.latex, assets: payload.assets })
        });
      });
    }).then(function (res) {
      if (res.status === 200) {
        recordCompile();
        return res.blob().then(function (blob) { downloadBlob(blob, 'document.pdf'); });
      }
      if (isAuthError(res)) { window.alert('ログインが必要です'); return; }
      return res.text().then(function (text) {
        var log = text;
        try { var json = JSON.parse(text); log = json.log || json.error || text; } catch (e) { }
        showCompileError(log);
        window.alert('PDF の生成に失敗しました。コンパイルログを確認してください。');
      });
    }).catch(function (err) {
      window.alert('サーバーに接続できません: ' + err.message);
    });
  }

  /* ================= フェーズ2: Word (.docx) 入出力 ================= */

  function docTitle() {
    var el = byId('doc-title');
    var t = el ? (el.textContent || '').trim() : '';
    // アプリ名付きの表示から文書名部分だけを取る(旧名称も読み込み互換のため認識)。
    t = t.replace(/\s*-\s*(?:Word風LaTeX|RaTeX|TailorTeX)\s*$/, '').trim();
    return t || '文書 1';
  }

  function safeFileName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'document';
  }

  function downloadDocx() {
    var d = doc();
    if (!d) return;
    if (!window.Docx || !window.JSZip) {
      window.alert('Word 出力モジュールが読み込まれていません。');
      return;
    }
    // フェーズ15: 最終成果物モードではコメントを含めない。exportDocx は内部で
    // Editor.getComments() を参照するため、出力中だけ空コメントに差し替える近似。
    var final = isFinalOutput();
    var restore = null;
    if (final && window.Editor && typeof window.Editor.getComments === 'function') {
      var origGetComments = window.Editor.getComments;
      window.Editor.getComments = function () { return {}; };
      restore = function () { window.Editor.getComments = origGetComments; };
    }
    window.Docx.exportDocx(d, docTitle(), {
      finalOutput: final, comments: final ? {} : undefined,
      // フェーズ30: 用紙/向き/段組み/行間/段落間隔を .docx セクション設定へ反映
      layout: {
        paper: options.paper, landscape: options.landscape, margin: options.margin,
        columns: options.columns, lineHeight: options.lineHeight, paraSpace: options.paraSpace
      }
    }).then(function (blob) {
      if (restore) restore();
      downloadBlob(blob, safeFileName(docTitle()) + '.docx');
    }).catch(function (err) {
      if (restore) restore();
      window.alert('Word ファイルの作成に失敗しました: ' + err.message);
    });
  }

  var docxInputReady = false;

  function setupDocxInput() {
    var input = byId('docx-input');
    if (!input || docxInputReady) return;
    docxInputReady = true;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      if (!window.Docx || typeof mammoth === 'undefined') {
        window.alert('Word 読み込みモジュールが読み込まれていません。');
        return;
      }
      window.Docx.importDocx(file).then(function (html) {
        if (!html || !html.trim()) {
          window.alert('この Word 文書から取り込める内容が見つかりませんでした。');
          return;
        }
        if (!window.confirm('現在の文書を「' + file.name + '」の内容で置き換えますか?')) return;
        var d = doc();
        if (!d) return;
        d.innerHTML = html;
        if (window.Editor) {
          if (window.Editor.clearComments) window.Editor.clearComments();
          if (window.Editor.renumberFootnotes) window.Editor.renumberFootnotes();
          if (window.Editor.resetHistory) window.Editor.resetHistory();
          if (window.Editor.refresh) window.Editor.refresh();
        }
        closeBackstage();
        saveNow();
        afterDocChange();
      }).catch(function (err) {
        window.alert('Word 文書の読み込みに失敗しました: ' + err.message);
      });
    });
  }

  function openDocx() {
    setupDocxInput(); // UI が後から挿入された場合に備えて遅延バインド
    var input = byId('docx-input');
    if (input) input.click();
  }

  /* ================= フェーズ2: 共有 ================= */

  function setShareStatus(text) {
    var el = byId('share-status');
    if (el) el.textContent = text;
  }

  function normalizeSharePermission(permission) {
    return (permission === 'view' || permission === 'comment') ? permission : 'edit';
  }

  function sharePermissionLabel(permission) {
    if (permission === 'view') return '閲覧のみ';
    if (permission === 'comment') return 'コメント可';
    return '編集可能';
  }

  function shareLink() {
    var d = doc();
    if (!d) return;
    var permSel = byId('share-permission');
    var permission = normalizeSharePermission(permSel && permSel.value);
    setShareStatus('リンクを作成しています…');
    fetch('/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: d.innerHTML,
        latex: generateLatex(),
        title: docTitle(),
        permission: permission
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var url = data && data.url ? String(data.url) : '';
      if (!url) throw new Error('URL が取得できませんでした');
      var perm = data && data.permission ? String(data.permission) : permission;
      var label = sharePermissionLabel(perm);
      var input = byId('share-link-input');
      if (input) input.value = url;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(url).then(function () {
          setShareStatus('コピーしました(' + label + ')');
        }).catch(function () {
          setShareStatus('リンクを作成しました(' + label + '・手動でコピーしてください)');
        });
      }
      setShareStatus('リンクを作成しました(' + label + '・手動でコピーしてください)');
    }).catch(function (err) {
      setShareStatus('リンクの作成に失敗しました: ' + err.message);
    });
  }

  function sharePdf() {
    var d = doc();
    if (!d || !window.LatexGen) return;
    setShareStatus('PDF を作成しています…');
    prepareCompilePayload().then(function (payload) {
      return withAuthHeaders({ 'Content-Type': 'application/json' }).then(function (headers) {
        return fetch('/compile', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ latex: payload.latex, assets: payload.assets })
        });
      });
    }).then(function (res) {
      if (isAuthError(res)) throw new Error('ログインが必要です');
      if (res.status !== 200) throw new Error('コンパイルに失敗しました');
      recordCompile();
      return res.blob();
    }).then(function (blob) {
      var name = safeFileName(docTitle()) + '.pdf';
      downloadBlob(blob, name);
      setShareStatus('PDF をダウンロードしました。メールに添付してください。');
      var subject = encodeURIComponent(docTitle());
      var body = encodeURIComponent('文書「' + docTitle() + '」の PDF を共有します。\nダウンロードした ' + name + ' を添付してください。');
      window.location.href = 'mailto:?subject=' + subject + '&body=' + body;
    }).catch(function (err) {
      setShareStatus('送信の準備に失敗しました: ' + err.message);
    });
  }

  /* ================= フェーズ3b: 文献(BibTeX) ================= */

  var selectedSourceKey = null;
  var editingSourceKey = null;

  function escAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  function syncBibStyleSelect() {
    var sel = byId('bib-style');
    if (sel && String(sel.value) !== String(bibStyle)) sel.value = bibStyle;
  }

  function setBibStyle(value) {
    var v = String(value == null ? 'plain' : value);
    if (!/^[A-Za-z][\w-]*$/.test(v)) v = 'plain';
    bibStyle = v;
    syncBibStyleSelect();
    afterDocChange();
  }

  // #doc 内の全 .bibliography ブロックに登録文献の簡易リストを描画
  function renderBibliographies() {
    var d = doc();
    if (!d) return;
    var blocks = d.querySelectorAll('.bibliography');
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      b.setAttribute('contenteditable', 'false');
      var html = '<div class="bib-title">参考文献</div>';
      if (bibEntries.length && window.Bib) {
        html += '<ol class="bib-list">';
        for (var j = 0; j < bibEntries.length; j++) {
          html += '<li>' + escapeHtml(window.Bib.formatLabel(bibEntries[j])) + '</li>';
        }
        html += '</ol>';
      } else {
        html += '<div class="bib-empty">(登録された文献はありません)</div>';
      }
      b.innerHTML = html;
    }
  }

  // 「引用文献の挿入」ドロップダウン #cite-menu の描画
  function renderCiteMenu() {
    var menu = byId('cite-menu');
    if (!menu) return;
    var html = '';
    for (var i = 0; i < bibEntries.length; i++) {
      var e = bibEntries[i];
      var f = e.fields || {};
      var sub = f.author || f.title || '';
      html += '<button type="button" class="cite-menu-item" data-command="insertCite" data-value="' +
        escAttr(e.key) + '"><b>' + escapeHtml(e.key) + '</b> ' +
        escapeHtml(String(sub).slice(0, 40)) + '</button>';
    }
    if (bibEntries.length) html += '<div class="cite-menu-sep"></div>';
    html += '<button type="button" class="cite-menu-item cite-menu-add" data-command="addSource">新しい資料文献の追加...</button>';
    menu.innerHTML = html;
  }

  // 資料文献の管理ダイアログ内 #source-list の描画
  function renderSourceList() {
    var list = byId('source-list');
    if (!list) return;
    var html = '';
    if (!bibEntries.length) {
      html = '<div class="source-empty">資料文献がまだありません。「.bib をインポート」または「新規作成」で追加してください。</div>';
    } else {
      for (var i = 0; i < bibEntries.length; i++) {
        var e = bibEntries[i];
        var f = e.fields || {};
        var sel = (e.key === selectedSourceKey) ? ' selected' : '';
        html += '<div class="source-row' + sel + '" data-key="' + escAttr(e.key) + '">' +
          '<span class="src-key">' + escapeHtml(e.key) + '</span>' +
          '<span class="src-author">' + escapeHtml(f.author || '') + '</span>' +
          '<span class="src-year">' + escapeHtml(f.year || '') + '</span>' +
          '<span class="src-title">' + escapeHtml(f.title || '') + '</span>' +
          '</div>';
      }
    }
    list.innerHTML = html;
  }

  function onBibChanged() {
    renderSourceList();
    renderCiteMenu();
    renderBibliographies();
    afterDocChange();
  }

  /* ---- 資料文献の作成 / 編集ダイアログ ---- */

  function srcFieldEl(name) {
    var dlg = byId('source-edit-dialog');
    if (dlg) {
      return dlg.querySelector('#src-' + name) ||
        dlg.querySelector('[data-field="' + name + '"]') ||
        dlg.querySelector('[name="' + name + '"]') || byId('src-' + name);
    }
    return byId('src-' + name);
  }
  function getField(name) { var el = srcFieldEl(name); return el ? String(el.value == null ? '' : el.value).trim() : ''; }
  function setField(name, v) { var el = srcFieldEl(name); if (el) el.value = (v == null ? '' : v); }

  function openSourceEditDialog() {
    var dlg = byId('source-edit-dialog');
    var ov = byId('dialog-overlay');
    if (ov) ov.hidden = false;
    if (dlg) dlg.hidden = false;
    var f = srcFieldEl('key');
    if (f && f.focus) { try { f.focus(); } catch (e) { } }
  }
  function closeSourceEditDialog() {
    var dlg = byId('source-edit-dialog');
    if (dlg) dlg.hidden = true;
    var mgr = byId('source-manager-dialog');
    var ov = byId('dialog-overlay');
    if (ov && (!mgr || mgr.hidden)) ov.hidden = true;
  }

  var SRC_FIELDS = ['author', 'title', 'year', 'journal', 'publisher', 'url'];

  function clearSourceForm() {
    setField('key', ''); setField('type', 'article');
    for (var i = 0; i < SRC_FIELDS.length; i++) setField(SRC_FIELDS[i], '');
  }

  function addSource() {
    editingSourceKey = null;
    clearSourceForm();
    openSourceEditDialog();
  }

  function editSource() {
    if (!selectedSourceKey) { addSource(); return; }
    var e = findEntry(selectedSourceKey);
    if (!e) { addSource(); return; }
    editingSourceKey = e.key;
    setField('key', e.key);
    setField('type', e.type || 'article');
    var f = e.fields || {};
    for (var i = 0; i < SRC_FIELDS.length; i++) setField(SRC_FIELDS[i], f[SRC_FIELDS[i]] || '');
    openSourceEditDialog();
  }

  function findEntry(key) {
    for (var i = 0; i < bibEntries.length; i++) if (bibEntries[i].key === key) return bibEntries[i];
    return null;
  }
  function indexOfEntry(key) {
    for (var i = 0; i < bibEntries.length; i++) if (bibEntries[i].key === key) return i;
    return -1;
  }

  function autoKey() {
    var author = (getField('author').split(/[\s,]+/)[0] || 'ref').replace(/[^A-Za-z0-9]/g, '');
    var base = ((author || 'ref') + (getField('year') || '')).replace(/[^A-Za-z0-9]/g, '') || 'ref';
    var key = base, n = 1;
    while (findEntry(key)) key = base + '_' + (++n);
    return key;
  }

  function saveSource() {
    var key = getField('key') || autoKey();
    var type = getField('type') || 'article';
    var fields = {};
    for (var i = 0; i < SRC_FIELDS.length; i++) {
      var v = getField(SRC_FIELDS[i]);
      if (v) fields[SRC_FIELDS[i]] = v;
    }
    var entry = { key: key, type: type, fields: fields };
    var target = editingSourceKey || key;
    var idx = indexOfEntry(target);
    if (idx >= 0) {
      // キー変更に伴う重複を避ける
      var dup = indexOfEntry(key);
      if (dup >= 0 && dup !== idx) bibEntries.splice(dup, 1);
      bibEntries[indexOfEntry(target)] = entry;
    } else {
      var d2 = indexOfEntry(key);
      if (d2 >= 0) bibEntries[d2] = entry; else bibEntries.push(entry);
    }
    editingSourceKey = null;
    selectedSourceKey = key;
    closeSourceEditDialog();
    onBibChanged();
  }

  function deleteSource() {
    if (!selectedSourceKey) return;
    if (!window.confirm('資料文献「' + selectedSourceKey + '」を削除しますか?')) return;
    var key = selectedSourceKey;
    bibEntries = bibEntries.filter(function (e) { return e.key !== key; });
    selectedSourceKey = null;
    onBibChanged();
  }

  function manageSources() {
    renderSourceList();
    renderCiteMenu();
  }

  /* ---- .bib インポート / エクスポート ---- */

  function importBib() {
    setupBibInput(); // UI が後から挿入された場合に備えて遅延バインド
    var input = byId('bib-input');
    if (input) input.click();
  }

  function importBibText(text, name) {
    if (!window.Bib) { window.alert('BibTeX モジュールが読み込まれていません。'); return; }
    var parsed = window.Bib.parse(text);
    if (!parsed.length) { window.alert('この .bib ファイルから文献を読み取れませんでした。'); return; }
    for (var i = 0; i < parsed.length; i++) {
      var idx = indexOfEntry(parsed[i].key);
      if (idx >= 0) bibEntries[idx] = parsed[i];
      else bibEntries.push(parsed[i]);
    }
    onBibChanged();
    setSaveStatus('• 保存済み');
  }

  function setupBibInput() {
    var input = byId('bib-input');
    if (!input || input._wtBibReady) return;
    input._wtBibReady = true;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { importBibText(String(reader.result || ''), file.name); };
      reader.readAsText(file);
    });
  }

  function exportBib() {
    if (!window.Bib) { window.alert('BibTeX モジュールが読み込まれていません。'); return; }
    var text = window.Bib.serialize(bibEntries);
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'refs.bib');
  }

  /* ---- 引用 / 文献目録の挿入 ---- */

  function insertCiteCmd(key) {
    if (window.Editor && window.Editor.insertCite) window.Editor.insertCite(key);
  }

  function insertBibliographyCmd() {
    if (window.Editor && window.Editor.insertBibliographyBlock) window.Editor.insertBibliographyBlock();
    renderBibliographies();
    afterDocChange();
  }

  /* ================= フェーズ3: ダッシュボード ================= */

  function appRelTime(iso) {
    var t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    if (s < 86400) return Math.floor(s / 3600) + ' 時間前';
    if (s < 604800) return Math.floor(s / 86400) + ' 日前';
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function compileTimeLabel() {
    if (!lastCompileTime) return '—';
    var s = Math.floor((Date.now() - lastCompileTime) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    var d = new Date(lastCompileTime);
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    if (s < 86400) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function greetingText() {
    var d = new Date();
    var wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    return 'こんにちは — ' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日(' + wd + ')';
  }

  function recentIconSvg() {
    return '<span class="recent-icon" aria-hidden="true">' +
      '<svg width="20" height="20" viewBox="0 0 20 20"><rect x="3" y="1" width="14" height="18" rx="1.5" fill="#2b579a"/>' +
      '<text x="10" y="14" font-size="9" fill="#fff" text-anchor="middle" font-family="Yu Mincho, serif">W</text></svg></span>';
  }
  function trashSvg() {
    return '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6L11.5 4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  }
  function accessIconSvg() {
    return '<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="6" cy="5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M1.8 13c.5-2.3 2.2-3.5 4.2-3.5S9.7 10.7 10.2 13" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="12" cy="5.6" r="1.7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M11.1 9.7c1.6.1 2.7 1.1 3.1 3.3" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  }

  function renderRecentList(ids) {
    var list = byId('recent-list');
    if (!list) return;
    if (!ids.length) { list.innerHTML = '<div class="recent-empty">最近使ったファイルはありません。</div>'; return; }
    var cloudOn = cloudSignedIn();
    var html = '';
    for (var i = 0; i < ids.length; i++) {
      var e = store[ids[i]];
      html += '<div class="recent-row" data-id="' + escAttr(ids[i]) + '" title="' + escAttr(e.title || '無題') + '">' +
        recentIconSvg() +
        '<span class="recent-title">' + escapeHtml(e.title || '無題') + '</span>' +
        '<span class="recent-time">' + escapeHtml(appRelTime(e.updatedAt)) + '</span>' +
        (cloudOn ? '<button type="button" class="recent-access" title="アクセス管理" aria-label="この文書のアクセスを管理">' + accessIconSvg() + '</button>' : '') +
        '<button type="button" class="recent-del" title="削除" aria-label="この文書を削除">' + trashSvg() + '</button>' +
        '</div>';
    }
    list.innerHTML = html;
  }

  function deleteShare(id) {
    fetch('/s/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () { fetchShares(); })
      .catch(function () { });
  }

  function updateSharePermission(id, permission) {
    var perm = normalizeSharePermission(permission);
    fetch('/s/' + encodeURIComponent(id) + '/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission: perm })
    }).then(function () { fetchShares(); })
      .catch(function () { fetchShares(); });
  }

  function fetchShares() {
    var shareList = byId('share-list');
    var statShares = byId('stat-shares');
    fetch('/shares').then(function (res) { return res.ok ? res.json() : []; }).then(function (data) {
      var arr = Array.isArray(data) ? data : [];
      if (statShares) statShares.textContent = String(arr.length);
      if (!shareList) return;
      if (!arr.length) { shareList.innerHTML = '<div class="share-empty">共有リンクはまだありません。</div>'; return; }
      var html = '';
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        var perm = normalizeSharePermission(s.permission);
        html += '<div class="share-row" data-id="' + escAttr(s.id) + '">' +
          '<span class="share-title">' + escapeHtml(s.title || '無題') + '</span>' +
          '<span class="share-badge share-badge-' + perm + '">' + sharePermissionLabel(perm) + '</span>' +
          '<select class="share-perm-toggle" title="共有リンクの権限を変更">' +
          '<option value="edit"' + (perm === 'edit' ? ' selected' : '') + '>編集可能</option>' +
          '<option value="comment"' + (perm === 'comment' ? ' selected' : '') + '>コメント可</option>' +
          '<option value="view"' + (perm === 'view' ? ' selected' : '') + '>閲覧のみ</option>' +
          '</select>' +
          '<input class="share-url" type="text" readonly value="' + escAttr(s.url || '') + '">' +
          '<button type="button" class="share-copy" data-url="' + escAttr(s.url || '') + '" title="リンクをコピー">コピー</button>' +
          '<button type="button" class="share-del" title="共有を削除" aria-label="共有を削除">&#10005;</button>' +
          '</div>';
      }
      shareList.innerHTML = html;
    }).catch(function () {
      if (statShares) statShares.textContent = '0';
      if (shareList) shareList.innerHTML = '<div class="share-empty">共有サーバーに接続できません。</div>';
    });
  }

  /* ================= フェーズ14: ユーザー単位のアクセス管理(クラウドのみ) ================= */

  function cloudSignedIn() {
    return !!(window.Cloud && typeof window.Cloud.isEnabled === 'function' && window.Cloud.isEnabled()
      && typeof window.Cloud.isSignedIn === 'function' && window.Cloud.isSignedIn());
  }
  // アクセス操作用に現在のクラウドストアを取得(ローカルモードでは null)
  function cloudStore() {
    if (!cloudSignedIn() || typeof window.Cloud.getStore !== 'function') return null;
    if (storeAdapter && storeAdapter.mode === 'cloud' && typeof storeAdapter.listAccess === 'function') return storeAdapter;
    return window.Cloud.getStore();
  }

  var ACCESS_ROLE_LABELS = { owner: '所有者', editor: '編集者', commenter: 'コメント者', viewer: '閲覧者' };
  function accessRoleLabel(r) { return ACCESS_ROLE_LABELS[r] || r || '閲覧者'; }
  function setAccessStatus(msg) { var el = byId('access-status'); if (el) el.textContent = msg || ''; }

  // 管理コンソール等から任意 doc のアクセス管理を開く
  function openAccessFor(id) {
    accessDocId = id || currentId;
    if (typeof window.openAccessDialog === 'function') window.openAccessDialog(accessDocId);
  }

  function currentAccessDocId() { return accessDocId || currentId; }

  // #access-dialog の中身を描画
  function renderAccess(docId) {
    if (docId) accessDocId = docId;
    var id = currentAccessDocId();
    var store0 = cloudStore();
    var list = byId('access-member-list');
    var nameEl = byId('access-docname');
    if (nameEl) nameEl.textContent = (id && store[id] && store[id].title) ? store[id].title : (id || '');
    setAccessStatus('');
    if (!store0 || !id) {
      if (list) list.innerHTML = '<div class="access-empty">クラウドにログインしてください。</div>';
      return;
    }
    if (list) list.innerHTML = '<div class="access-empty">読み込み中…</div>';
    store0.listAccess(id).then(function (info) {
      renderAccessList(info);
    }).catch(function (e) {
      if (list) list.innerHTML = '<div class="access-empty">アクセス情報を取得できませんでした。</div>';
    });
  }

  function renderAccessList(info) {
    var list = byId('access-member-list');
    if (!list) return;
    var members = (info && info.members) || [];
    var pending = (info && info.pending) || [];
    var html = '';
    members.forEach(function (m) {
      var isOwner = m.role === 'owner';
      var label = m.email || m.uid;
      html += '<div class="access-member" data-uid="' + escAttr(m.uid) + '">' +
        '<span class="access-avatar">' + escapeHtml((label.charAt(0) || '?').toUpperCase()) + '</span>' +
        '<span class="access-info"><span class="access-email">' + escapeHtml(label) + (m.self ? ' <em>(自分)</em>' : '') + '</span></span>';
      if (isOwner) {
        html += '<span class="access-role-fixed">' + accessRoleLabel('owner') + '</span>';
      } else {
        html += '<select class="access-role-change" aria-label="ロールを変更">' +
          '<option value="viewer"' + (m.role === 'viewer' ? ' selected' : '') + '>閲覧者</option>' +
          '<option value="commenter"' + (m.role === 'commenter' ? ' selected' : '') + '>コメント者</option>' +
          '<option value="editor"' + (m.role === 'editor' ? ' selected' : '') + '>編集者</option>' +
          '</select>' +
          '<button type="button" class="access-remove" title="削除" aria-label="このユーザーを削除">&#10005;</button>';
      }
      html += '</div>';
    });
    pending.forEach(function (p) {
      html += '<div class="access-member access-pending" data-email="' + escAttr(p.email) + '">' +
        '<span class="access-avatar">@</span>' +
        '<span class="access-info"><span class="access-email">' + escapeHtml(p.email) + '</span>' +
        '<span class="access-sub">招待中 · ' + escapeHtml(accessRoleLabel(p.role)) + '</span></span>' +
        '<button type="button" class="access-remove-invite" title="招待を取り消す" aria-label="招待を取り消す">&#10005;</button>' +
        '</div>';
    });
    if (!html) html = '<div class="access-empty">まだ誰とも共有していません。</div>';
    list.innerHTML = html;
  }

  function accessInvite() {
    var store0 = cloudStore();
    var id = currentAccessDocId();
    if (!store0 || !id) { setAccessStatus('クラウドにログインしてください。'); return; }
    var emailEl = byId('access-invite-email');
    var roleEl = byId('access-invite-role');
    var email = (emailEl && emailEl.value || '').trim();
    var role = (roleEl && roleEl.value) || 'viewer';
    if (!email || email.indexOf('@') < 0) { setAccessStatus('有効なメールアドレスを入力してください。'); return; }
    setAccessStatus('招待しています…');
    store0.invite(id, email, role).then(function () {
      if (emailEl) emailEl.value = '';
      setAccessStatus(email + ' を招待しました(' + accessRoleLabel(role) + ')');
      renderAccess(id);
    }).catch(function (e) {
      setAccessStatus('招待に失敗しました: ' + (e && e.message || e));
    });
  }

  function accessSetRole(uid, role) {
    var store0 = cloudStore();
    var id = currentAccessDocId();
    if (!store0 || !id || !uid) return;
    setAccessStatus('ロールを変更しています…');
    store0.setRole(id, uid, role).then(function () {
      setAccessStatus('ロールを変更しました(' + accessRoleLabel(role) + ')');
      renderAccess(id);
    }).catch(function (e) { setAccessStatus('変更に失敗しました: ' + (e && e.message || e)); });
  }

  function accessRevoke(uid) {
    var store0 = cloudStore();
    var id = currentAccessDocId();
    if (!store0 || !id || !uid) return;
    setAccessStatus('削除しています…');
    store0.revoke(id, uid).then(function () {
      setAccessStatus('削除しました。');
      renderAccess(id);
    }).catch(function (e) { setAccessStatus('削除に失敗しました: ' + (e && e.message || e)); });
  }

  function accessRevokeInvite(email) {
    var store0 = cloudStore();
    var id = currentAccessDocId();
    if (!store0 || !id || !email) return;
    store0.revokeInvite(id, email).then(function () { renderAccess(id); }).catch(function () { });
  }

  function renderDashboard() {
    captureCurrent();
    saveStore();
    var greet = byId('dash-greeting');
    if (greet) greet.textContent = greetingText();

    var ids = sortedIds();
    var statDocs = byId('stat-docs'); if (statDocs) statDocs.textContent = String(ids.length);
    var total = 0;
    for (var i = 0; i < ids.length; i++) total += (store[ids[i]].charCount || 0);
    var statChars = byId('stat-chars'); if (statChars) statChars.textContent = String(total);
    var statCompile = byId('stat-compile'); if (statCompile) statCompile.textContent = compileTimeLabel();
    var statShares = byId('stat-shares'); if (statShares) statShares.textContent = '…';

    if (projectMode) renderProjectList();
    else renderRecentList(ids);
    fetchShares();
  }

  // フェーズ26: フォルダ折りたたみ状態(localStorage に折りたたみ中のフォルダパスを保持)
  var FOLDER_COLLAPSE_KEY = 'wordtex-folder-collapse';
  function loadCollapsed() {
    try {
      var raw = safeGet(FOLDER_COLLAPSE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      var m = {};
      if (Array.isArray(arr)) { for (var i = 0; i < arr.length; i++) m[arr[i]] = true; }
      return m;
    } catch (e) { return {}; }
  }
  function saveCollapsed(map) {
    var arr = [];
    for (var k in map) { if (map[k] && Object.prototype.hasOwnProperty.call(map, k)) arr.push(k); }
    safeSet(FOLDER_COLLAPSE_KEY, JSON.stringify(arr));
  }
  var projectFolderCache = {};   // projectId -> folder(移動ダイアログ用)
  var knownFolders = [];         // 既存フォルダの一覧(移動ダイアログの選択肢)

  function folderIconSvg() {
    return '<span class="folder-icon" aria-hidden="true">' +
      '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.2l1.3 1.4h5.5a1 1 0 0 1 1 1v7.1a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="#dcb35c" stroke="#b5922f" stroke-width=".8"/></svg></span>';
  }
  function caretSvg() {
    return '<span class="folder-caret" aria-hidden="true">' +
      '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 2l4 3-4 3z" fill="currentColor"/></svg></span>';
  }
  function dotsSvg() {
    return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>';
  }

  function fmt(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] != null ? String(vars[k]) : ''; });
  }

  // フェーズ28: 深い階層でもインデントが破綻しないよう1段あたり一定・上限付き。
  var FOLDER_INDENT_STEP = 14;   // 1段あたりのインデント(px)
  var FOLDER_INDENT_CAP = 6;     // これ以上深くてもインデントは増やさない(320px リフロー保護)
  function folderIndentPx(depth) {
    return 10 + Math.min(depth, FOLDER_INDENT_CAP) * FOLDER_INDENT_STEP;
  }

  function projectRowHtml(p, depth) {
    projectNameCache[p.id] = p.name;
    projectFolderCache[p.id] = (typeof p.folder === 'string' ? p.folder : '');
    var meta = (p.fileCount != null ? (p.fileCount + ' ' + t('dash.files', 'ファイル')) : '');
    var pad = (depth && depth > 0) ? (' style="padding-left:' + folderIndentPx(depth) + 'px"') : '';
    return '<div class="recent-row" data-project="' + escAttr(p.id) + '" draggable="true"' + pad + ' title="' + escAttr(p.name || '無題') + '">' +
      recentIconSvg() +
      '<span class="recent-title">' + escapeHtml(p.name || '無題') + '</span>' +
      '<span class="recent-time">' + escapeHtml(p.updatedAt ? appRelTime(p.updatedAt) : meta) + '</span>' +
      '<button type="button" class="recent-menu" title="' + escAttr(t('dash.rowMenu', 'その他の操作')) + '" aria-label="' + escAttr(t('dash.rowMenu', 'その他の操作')) + '" aria-haspopup="true" aria-expanded="false">' + dotsSvg() + '</button>' +
      '<button type="button" class="recent-del" title="' + escAttr(t('action.delete', '削除')) + '" aria-label="' + escAttr(t('dash.deleteProject', 'このプロジェクトを削除')) + '">' + trashSvg() + '</button>' +
      '</div>';
  }

  // フェーズ15/26: ダッシュボードの「最近のプロジェクト」一覧(フォルダ階層)
  function renderProjectList() {
    var list = byId('recent-list');
    if (!list) return;
    if (!window.Projects) { renderRecentList(sortedIds()); return; }
    list.innerHTML = '<div class="recent-empty">' + escapeHtml(t('dash.loadingProjects', '読み込み中…')) + '</div>';
    window.Projects.list().then(function (arr) {
      var statDocs = byId('stat-docs'); if (statDocs) statDocs.textContent = String(arr.length);
      if (!arr.length) { list.innerHTML = '<div class="recent-empty">' + escapeHtml(t('dash.noProjects', 'プロジェクトはまだありません')) + '</div>'; return; }

      // フォルダごとにグルーピング。ルート直下(folder 空)は末尾へまとめる。
      var groups = {};       // folderPath -> [projects]
      var rootRows = [];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        var f = (typeof p.folder === 'string') ? p.folder : '';
        if (f) { (groups[f] || (groups[f] = [])).push(p); }
        else { rootRows.push(p); }
      }
      var folderPaths = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
      knownFolders = folderPaths.slice();

      var collapsed = loadCollapsed();
      var html = '';
      var grpIdx = 0;
      for (var fi = 0; fi < folderPaths.length; fi++) {
        var fp = folderPaths[fi];
        var depth = fp.split('/').length - 1;
        var isCollapsed = !!collapsed[fp];
        var gid = 'folder-grp-' + (grpIdx++);
        var leaf = fp.split('/').pop();
        html += '<div class="folder-head' + (isCollapsed ? ' is-collapsed' : '') + '" role="button" tabindex="0" draggable="true"' +
          ' data-folder="' + escAttr(fp) + '" aria-expanded="' + (isCollapsed ? 'false' : 'true') + '"' +
          ' aria-controls="' + gid + '" style="padding-left:' + folderIndentPx(depth) + 'px" title="' + escAttr(fp) + '">' +
          caretSvg() + folderIconSvg() +
          '<span class="folder-name">' + escapeHtml(leaf) + '</span>' +
          '<span class="folder-count">' + groups[fp].length + '</span>' +
          '<button type="button" class="folder-menu" title="' + escAttr(t('dash.folder.menu', 'フォルダの操作')) + '" aria-label="' + escAttr(fmt(t('dash.folder.menuFor', '「{f}」の操作'), { f: leaf })) + '" aria-haspopup="true" aria-expanded="false">' + dotsSvg() + '</button>' +
          '</div>';
        html += '<div class="folder-group" id="' + gid + '" role="group" aria-label="' + escAttr(fp) + '"' + (isCollapsed ? ' hidden' : '') + '>';
        for (var gi = 0; gi < groups[fp].length; gi++) html += projectRowHtml(groups[fp][gi], depth + 1);
        html += '</div>';
      }
      for (var ri = 0; ri < rootRows.length; ri++) html += projectRowHtml(rootRows[ri], 0);

      list.innerHTML = html;
    }).catch(function () {
      // サーバー一覧取得失敗 → ローカル一覧にフォールバック
      renderRecentList(sortedIds());
    });
  }

  // フェーズ26: フォルダ見出しの折りたたみ切替(クリック / キーボード共通)
  function toggleFolder(headEl) {
    if (!headEl) return;
    var fp = headEl.getAttribute('data-folder');
    var gid = headEl.getAttribute('aria-controls');
    var grp = gid && byId(gid);
    var willCollapse = headEl.getAttribute('aria-expanded') !== 'false';
    headEl.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
    if (willCollapse) headEl.classList.add('is-collapsed'); else headEl.classList.remove('is-collapsed');
    if (grp) { if (willCollapse) grp.setAttribute('hidden', ''); else grp.removeAttribute('hidden'); }
    var map = loadCollapsed();
    if (willCollapse) map[fp] = true; else delete map[fp];
    saveCollapsed(map);
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce(fmt(willCollapse
        ? t('dash.folderCollapsedA', '{f} を折りたたみました')
        : t('dash.folderExpandedA', '{f} を展開しました'), { f: fp }));
    }
  }

  // フェーズ26/28: 行・フォルダ見出しの「…」ポップアップメニュー(汎用)
  var _popupMenuEl = null;
  function closePopupMenu() {
    if (_popupMenuEl && _popupMenuEl.parentNode) _popupMenuEl.parentNode.removeChild(_popupMenuEl);
    _popupMenuEl = null;
    var opened = document.querySelector('.recent-menu[aria-expanded="true"], .folder-menu[aria-expanded="true"]');
    if (opened) opened.setAttribute('aria-expanded', 'false');
  }
  function showPopupMenu(btn, items) {
    closePopupMenu();
    btn.setAttribute('aria-expanded', 'true');
    var menu = document.createElement('div');
    menu.className = 'recent-menu-pop';
    menu.setAttribute('role', 'menu');
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'recent-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      b.addEventListener('click', function (e) { e.stopPropagation(); closePopupMenu(); it.onClick(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    var w = 220;
    var top = r.bottom + 4, left = r.right - w;
    if (left < 8) left = 8;
    var h = items.length * 38 + 8;
    if (top + h > window.innerHeight) top = Math.max(8, r.top - h);
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    _popupMenuEl = menu;
    var first = menu.querySelector('.recent-menu-item');
    if (first) first.focus();
    menu.addEventListener('keydown', function (e) {
      var its = Array.prototype.slice.call(menu.querySelectorAll('.recent-menu-item'));
      var idx = its.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); closePopupMenu(); try { btn.focus(); } catch (er) {} }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (its[idx + 1] || its[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (its[idx - 1] || its[its.length - 1]).focus(); }
    });
  }
  function openRowMenu(btn) {
    var row = btn.closest('.recent-row');
    var pid = row && row.getAttribute('data-project');
    if (!pid) return;
    showPopupMenu(btn, [
      { label: t('dash.moveToFolder', 'フォルダへ移動…'), onClick: function () { openMoveDialog(pid); } }
    ]);
  }
  function openFolderMenu(btn) {
    var head = btn.closest('.folder-head');
    var fp = head && head.getAttribute('data-folder');
    if (!fp) return;
    showPopupMenu(btn, [
      { label: t('dash.folder.rename', 'フォルダ名の変更…'), onClick: function () { openFolderRenameDialog(fp); } },
      { label: t('dash.folder.move', 'フォルダごと移動…'), onClick: function () { openFolderMoveDialog(fp); } },
      { label: t('dash.folder.addProject', 'このフォルダへプロジェクトを移動…'), onClick: function () { openProjectIntoFolderDialog(fp); } }
    ]);
  }

  /* ============ フェーズ28: フォルダのツリー選択 + 各種操作ダイアログ ============ */

  // モーダル共通のキー処理(Esc で閉じる + Tab フォーカストラップ)
  function wireModalKeys(dialog, close) {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') {
        var all = dialog.querySelectorAll('button, select, input, [tabindex]');
        var vis = [];
        for (var i = 0; i < all.length; i++) { if (all[i].offsetParent !== null && !all[i].disabled) vis.push(all[i]); }
        if (!vis.length) return;
        var first = vis[0], last = vis[vis.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return function () { document.removeEventListener('keydown', onKey, true); };
  }

  // knownFolders(パス配列)を入れ子ツリーへ(中間フォルダも補完)。
  function buildFolderTree(paths) {
    var root = { path: '', name: '', children: {}, order: [] };
    for (var i = 0; i < paths.length; i++) {
      var segs = paths[i].split('/'); var node = root; var acc = '';
      for (var j = 0; j < segs.length; j++) {
        acc = acc ? acc + '/' + segs[j] : segs[j];
        if (!node.children[segs[j]]) { node.children[segs[j]] = { path: acc, name: segs[j], children: {}, order: [] }; node.order.push(segs[j]); }
        node = node.children[segs[j]];
      }
    }
    return root;
  }

  function folderIconMini() {
    return '<span class="ftree-ic" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.2l1.3 1.4h5.5a1 1 0 0 1 1 1v7.1a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="#dcb35c" stroke="#b5922f" stroke-width=".8"/></svg></span>';
  }

  var _pickSeq = 0;
  // ツリー選択ウィジェット。返り値: { el, getValue, focus, focusNew }
  //   getValue: '' (ルート) / 既存パス / 新規入力(trim) / null(新規で空)。
  //   opts: { current, exclude }。exclude 配下(自身+子孫)は選択肢から除外(フォルダ移動用)。
  function buildFolderTreePicker(opts) {
    opts = opts || {};
    var seq = ++_pickSeq; var name = 'fpick' + seq;
    var exclude = opts.exclude || null;
    var current = opts.current || '';
    var el = document.createElement('div');
    el.className = 'ftree';
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', t('dash.move.existing', '既存のフォルダ'));
    var rows = [];        // フォルダ行(data-path 付き)
    var collapsed = {};

    function excluded(p) { return exclude && (p === exclude || p.indexOf(exclude + '/') === 0); }
    function safeId(s) { return s.replace(/[^a-zA-Z0-9぀-ヿ一-鿿]/g, '_'); }

    // ルート
    var rootId = name + '-root';
    var rootRow = document.createElement('div');
    rootRow.className = 'ftree-row ftree-root';
    rootRow.innerHTML = '<span class="ftree-caret-sp"></span>' +
      '<input type="radio" name="' + name + '" id="' + rootId + '" value=""' + (current === '' ? ' checked' : '') + '>' +
      '<label for="' + rootId + '">' + escapeHtml(t('dash.move.root', 'ルート(フォルダなし)')) + '</label>';
    el.appendChild(rootRow);

    var tree = buildFolderTree(knownFolders);
    (function renderNode(node, depth) {
      var keys = node.order.slice().sort(function (a, b) { return a.localeCompare(b, 'ja'); });
      for (var i = 0; i < keys.length; i++) {
        var child = node.children[keys[i]];
        if (excluded(child.path)) continue;
        var hasKids = child.order.length > 0;
        var rid = name + '-' + safeId(child.path);
        var row = document.createElement('div');
        row.className = 'ftree-row';
        row.setAttribute('data-path', child.path);
        row.style.paddingLeft = (6 + depth * 16) + 'px';
        row.innerHTML = (hasKids
          ? '<button type="button" class="ftree-caret" aria-expanded="true" aria-label="' + escAttr(t('dash.folder.toggle', '開閉')) + '"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 2l4 3-4 3z" fill="currentColor"/></svg></button>'
          : '<span class="ftree-caret-sp"></span>') +
          '<input type="radio" name="' + name + '" id="' + escAttr(rid) + '" value="' + escAttr(child.path) + '"' + (child.path === current ? ' checked' : '') + '>' +
          '<label for="' + escAttr(rid) + '">' + folderIconMini() + escapeHtml(child.name) + '</label>';
        el.appendChild(row); rows.push(row);
        if (hasKids) {
          (function (p, r) {
            r.querySelector('.ftree-caret').addEventListener('click', function (e) {
              e.preventDefault(); e.stopPropagation();
              collapsed[p] = !collapsed[p]; applyVis();
            });
          })(child.path, row);
        }
        renderNode(child, depth + 1);
      }
    })(tree, 0);

    // 新しいフォルダ
    var newId = name + '-new';
    var newRow = document.createElement('div');
    newRow.className = 'ftree-row ftree-new';
    newRow.innerHTML = '<span class="ftree-caret-sp"></span>' +
      '<input type="radio" name="' + name + '" id="' + newId + '" value="__new__">' +
      '<label for="' + newId + '">' + escapeHtml(t('dash.move.newOption', '新しいフォルダ…')) + '</label>';
    el.appendChild(newRow);
    var newWrap = document.createElement('div');
    newWrap.className = 'ftree-newwrap';
    newWrap.setAttribute('hidden', '');
    newWrap.innerHTML = '<input type="text" class="fmove-new" aria-label="' + escAttr(t('dash.move.newLabel', '新しいフォルダ名')) + '" placeholder="' + escAttr(t('dash.move.newPlaceholder', '例: 研究論文/2026')) + '">';
    el.appendChild(newWrap);
    var newInput = newWrap.querySelector('input');

    function applyVis() {
      for (var i = 0; i < rows.length; i++) {
        var p = rows[i].getAttribute('data-path');
        var vis = true, segs = p.split('/'), acc = '';
        for (var j = 0; j < segs.length - 1; j++) { acc = acc ? acc + '/' + segs[j] : segs[j]; if (collapsed[acc]) { vis = false; break; } }
        rows[i].style.display = vis ? '' : 'none';
        var c = rows[i].querySelector('.ftree-caret');
        if (c) c.setAttribute('aria-expanded', collapsed[p] ? 'false' : 'true');
      }
    }
    el.addEventListener('change', function (e) {
      if (e.target && e.target.name === name) {
        if (e.target.value === '__new__') { newWrap.removeAttribute('hidden'); newInput.focus(); }
        else newWrap.setAttribute('hidden', '');
      }
    });

    return {
      el: el,
      getValue: function () {
        var checked = el.querySelector('input[name="' + name + '"]:checked');
        if (!checked) return '';
        if (checked.value === '__new__') { var v = (newInput.value || '').trim(); return v ? v : null; }
        return checked.value;
      },
      focus: function () {
        var c = el.querySelector('input[name="' + name + '"]:checked') || el.querySelector('input[name="' + name + '"]');
        if (c) c.focus();
      },
      focusNew: function () { try { newInput.focus(); } catch (e) {} }
    };
  }

  // ツリー選択ダイアログ(プロジェクト移動・フォルダ移動で共用)
  function openFolderChooser(opts) {
    var trigger = document.activeElement;
    var back = document.createElement('div');
    back.className = 'fmove-backdrop';
    var dialog = document.createElement('div');
    dialog.className = 'fmove-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'fmove-title');
    dialog.innerHTML =
      '<h2 id="fmove-title" class="fmove-title">' + escapeHtml(opts.title) + '</h2>' +
      '<p class="fmove-subject">' + escapeHtml(opts.subject || '') + '</p>' +
      '<span class="fmove-label">' + escapeHtml(opts.chooseLabel || t('dash.move.existing', '既存のフォルダ')) + '</span>';
    var picker = buildFolderTreePicker({ current: opts.current || '', exclude: opts.exclude || null });
    dialog.appendChild(picker.el);
    var hint = document.createElement('p');
    hint.className = 'fmove-hint';
    hint.textContent = t('dash.move.hint', 'スラッシュで階層を作成できます(最大8階層・各64文字)。');
    dialog.appendChild(hint);
    var actions = document.createElement('div');
    actions.className = 'fmove-actions';
    actions.innerHTML =
      '<button type="button" class="fmove-cancel">' + escapeHtml(t('dash.move.cancel', 'キャンセル')) + '</button>' +
      '<button type="button" class="fmove-ok">' + escapeHtml(opts.okLabel || t('dash.move.ok', '移動')) + '</button>';
    dialog.appendChild(actions);
    back.appendChild(dialog);
    document.body.appendChild(back);

    var okBtn = actions.querySelector('.fmove-ok');
    var cancelBtn = actions.querySelector('.fmove-cancel');
    var unwire = wireModalKeys(dialog, close);
    function close() {
      if (back.parentNode) back.parentNode.removeChild(back);
      unwire();
      if (trigger && trigger.focus) { try { trigger.focus(); } catch (e) {} }
    }
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', function () {
      var v = picker.getValue();
      if (v === null) { notify(t('dash.move.emptyName', 'フォルダ名を入力してください')); picker.focusNew(); return; }
      okBtn.disabled = true;
      Promise.resolve(opts.onPick(v)).then(function () { close(); }, function (err) {
        okBtn.disabled = false;
        if (err && err.handled) return;
        if (err && err.message) notify((opts.failMsg || t('dash.moveFailed', '移動に失敗しました')) + ': ' + err.message);
      });
    });
    picker.focus();
  }

  // 折りたたみ状態のキー移行(フォルダ名変更・移動で prefix を付け替え)
  function migrateCollapsed(from, to) {
    var map = loadCollapsed(); var out = {};
    for (var k in map) {
      if (!map[k] || !Object.prototype.hasOwnProperty.call(map, k)) continue;
      if (k === from) { if (to) out[to] = true; }
      else if (k.indexOf(from + '/') === 0) { var nk = (to || '') + k.slice(from.length); nk = nk.replace(/^\//, ''); if (nk) out[nk] = true; }
      else out[k] = true;
    }
    saveCollapsed(out);
  }

  // 配下一括のフォルダ名変更・フォルダごと移動を実行(処理中の通知・部分失敗対応)
  function doRenameFolder(from, to) {
    return window.Projects.renameFolder(from, to).then(function (r) {
      if (!r || r.total === 0) {
        notify(t('dash.folder.emptyTarget', '対象のプロジェクトがありません'));
        return;
      }
      migrateCollapsed(from, to);
      notify(fmt(t('dash.folder.renamed', 'フォルダを「{f}」に更新しました({n}件)'),
        { f: to || t('dash.move.root', 'ルート(フォルダなし)'), n: r.moved }));
      if (window.A11y && window.A11y.announce) {
        window.A11y.announce(fmt(t('dash.folder.renamedA', '{n}件のプロジェクトを移動しました'), { n: r.moved }));
      }
      renderProjectList();
    }).catch(function (err) {
      var done = (err && err.moved != null) ? err.moved : 0;
      notify(fmt(t('dash.folder.partial', '途中で失敗しました({n}件移動済み。再実行で続きから収束します)'), { n: done }) +
        (err && err.message ? ': ' + err.message : ''));
      renderProjectList();
      throw err;
    });
  }

  // フェーズ26/28: プロジェクトの「フォルダへ移動」(ツリー選択)
  function openMoveDialog(pid) {
    if (!pid) return;
    var cur = projectFolderCache[pid] || '';
    var name = projectNameCache[pid] || t('doc.untitled', '無題');
    openFolderChooser({
      title: t('dash.move.title', 'フォルダへ移動'),
      subject: name,
      current: cur,
      okLabel: t('dash.move.ok', '移動'),
      onPick: function (target) {
        return window.Projects.setFolder(pid, target).then(function () {
          if (target) notify(fmt(t('dash.movedTo', '「{n}」を「{f}」へ移動しました'), { n: name, f: target }));
          else notify(fmt(t('dash.movedToRoot', '「{n}」をフォルダから外しました'), { n: name }));
          if (window.A11y && window.A11y.announce) {
            window.A11y.announce(target
              ? fmt(t('dash.movedTo', '「{n}」を「{f}」へ移動しました'), { n: name, f: target })
              : fmt(t('dash.movedToRoot', '「{n}」をフォルダから外しました'), { n: name }));
          }
          renderProjectList();
        });
      }
    });
  }

  // フェーズ28: フォルダごと移動(移動先の親フォルダをツリーから選ぶ)
  function openFolderMoveDialog(fp) {
    var leaf = fp.split('/').pop();
    var curParent = fp.indexOf('/') >= 0 ? fp.slice(0, fp.lastIndexOf('/')) : '';
    openFolderChooser({
      title: fmt(t('dash.folder.moveTitle', '「{f}」を移動'), { f: leaf }),
      subject: fp,
      current: curParent,
      exclude: fp,
      chooseLabel: t('dash.folder.moveDest', '移動先の親フォルダ'),
      okLabel: t('dash.move.ok', '移動'),
      onPick: function (parent) {
        var newPath = parent ? (parent + '/' + leaf) : leaf;
        if (newPath === fp) {
          var e = new Error(''); e.handled = true;
          notify(t('dash.folder.samePlace', '移動先が現在と同じです'));
          return Promise.reject(e);
        }
        if (knownFolders.indexOf(newPath) >= 0 &&
            !window.confirm(fmt(t('dash.folder.collide', '「{f}」は既に存在します。統合しますか?'), { f: newPath }))) {
          var e2 = new Error(''); e2.handled = true; return Promise.reject(e2);
        }
        return doRenameFolder(fp, newPath);
      }
    });
  }

  // フェーズ28: フォルダ名の変更(配下すべてに反映)
  function openFolderRenameDialog(fp) {
    var trigger = document.activeElement;
    var leaf = fp.split('/').pop();
    var parent = fp.indexOf('/') >= 0 ? fp.slice(0, fp.lastIndexOf('/')) : '';
    var back = document.createElement('div');
    back.className = 'fmove-backdrop';
    var dialog = document.createElement('div');
    dialog.className = 'fmove-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'fren-title');
    dialog.innerHTML =
      '<h2 id="fren-title" class="fmove-title">' + escapeHtml(t('dash.folder.renameTitle', 'フォルダ名の変更')) + '</h2>' +
      '<p class="fmove-subject">' + escapeHtml(fp) + '</p>' +
      '<label class="fmove-label" for="fren-input">' + escapeHtml(t('dash.folder.newName', '新しいフォルダ名')) + '</label>' +
      '<input id="fren-input" class="fmove-new" type="text" value="' + escAttr(leaf) + '">' +
      '<p class="fmove-hint">' + escapeHtml(t('dash.folder.renameHint', 'この名前は配下すべてのプロジェクトに反映されます(64文字以内・スラッシュ不可)。')) + '</p>' +
      '<div class="fmove-actions">' +
      '<button type="button" class="fmove-cancel">' + escapeHtml(t('dash.move.cancel', 'キャンセル')) + '</button>' +
      '<button type="button" class="fmove-ok">' + escapeHtml(t('dash.folder.renameOk', '変更')) + '</button>' +
      '</div>';
    back.appendChild(dialog);
    document.body.appendChild(back);
    var input = dialog.querySelector('#fren-input');
    var okBtn = dialog.querySelector('.fmove-ok');
    var cancelBtn = dialog.querySelector('.fmove-cancel');
    var unwire = wireModalKeys(dialog, close);
    function close() {
      if (back.parentNode) back.parentNode.removeChild(back);
      unwire();
      if (trigger && trigger.focus) { try { trigger.focus(); } catch (e) {} }
    }
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', function () {
      var v = (input.value || '').trim();
      if (!v) { notify(t('dash.move.emptyName', 'フォルダ名を入力してください')); input.focus(); return; }
      if (v.indexOf('/') >= 0) { notify(t('dash.folder.noSlash', 'フォルダ名にスラッシュは使えません')); input.focus(); return; }
      var newPath = parent ? (parent + '/' + v) : v;
      if (newPath === fp) { close(); return; }
      if (knownFolders.indexOf(newPath) >= 0 &&
          !window.confirm(fmt(t('dash.folder.collide', '「{f}」は既に存在します。統合しますか?'), { f: newPath }))) { return; }
      okBtn.disabled = true;
      doRenameFolder(fp, newPath).then(close, function () { okBtn.disabled = false; });
    });
    input.focus(); input.select();
  }

  // フェーズ28: 「このフォルダへプロジェクトを移動…」(サブフォルダの実質的な新規作成手段)
  function openProjectIntoFolderDialog(fp) {
    var trigger = document.activeElement;
    window.Projects.list().then(function (arr) {
      var sorted = arr.slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ja'); });
      var optsHtml = '';
      var firstEnabled = '';
      for (var i = 0; i < sorted.length; i++) {
        var p = sorted[i];
        var inHere = (typeof p.folder === 'string' ? p.folder : '') === fp;
        if (!inHere && !firstEnabled) firstEnabled = p.id;
        optsHtml += '<option value="' + escAttr(p.id) + '"' + (inHere ? ' disabled' : '') + '>' +
          escapeHtml(p.name || p.id) + (inHere ? ' (' + escapeHtml(t('dash.folder.alreadyHere', 'このフォルダ内')) + ')' : '') + '</option>';
      }
      var back = document.createElement('div');
      back.className = 'fmove-backdrop';
      var dialog = document.createElement('div');
      dialog.className = 'fmove-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'fpf-title');
      dialog.innerHTML =
        '<h2 id="fpf-title" class="fmove-title">' + escapeHtml(t('dash.folder.addProjectTitle', 'このフォルダへプロジェクトを移動')) + '</h2>' +
        '<p class="fmove-subject">' + escapeHtml(fp) + '</p>' +
        '<label class="fmove-label" for="fpf-proj">' + escapeHtml(t('dash.folder.chooseProject', 'プロジェクト')) + '</label>' +
        '<select id="fpf-proj" class="fmove-select">' + optsHtml + '</select>' +
        '<label class="fmove-label" for="fpf-target">' + escapeHtml(t('dash.folder.targetFolder', '移動先フォルダ')) + '</label>' +
        '<input id="fpf-target" class="fmove-new" type="text" value="' + escAttr(fp) + '">' +
        '<p class="fmove-hint">' + escapeHtml(fmt(t('dash.folder.subHint', '「{f}/子」のように入力するとサブフォルダを作成できます(最大8階層)。'), { f: fp })) + '</p>' +
        '<div class="fmove-actions">' +
        '<button type="button" class="fmove-cancel">' + escapeHtml(t('dash.move.cancel', 'キャンセル')) + '</button>' +
        '<button type="button" class="fmove-ok">' + escapeHtml(t('dash.move.ok', '移動')) + '</button>' +
        '</div>';
      back.appendChild(dialog);
      document.body.appendChild(back);
      var sel = dialog.querySelector('#fpf-proj');
      var target = dialog.querySelector('#fpf-target');
      var okBtn = dialog.querySelector('.fmove-ok');
      var cancelBtn = dialog.querySelector('.fmove-cancel');
      if (firstEnabled) sel.value = firstEnabled;
      var unwire = wireModalKeys(dialog, close);
      function close() {
        if (back.parentNode) back.parentNode.removeChild(back);
        unwire();
        if (trigger && trigger.focus) { try { trigger.focus(); } catch (e) {} }
      }
      back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
      cancelBtn.addEventListener('click', close);
      okBtn.addEventListener('click', function () {
        var pid = sel.value;
        var tgt = (target.value || '').trim();
        if (!pid) { notify(t('dash.folder.chooseProject', 'プロジェクト')); return; }
        var nm = projectNameCache[pid] || sel.options[sel.selectedIndex].text;
        okBtn.disabled = true;
        window.Projects.setFolder(pid, tgt).then(function () {
          close();
          if (tgt) notify(fmt(t('dash.movedTo', '「{n}」を「{f}」へ移動しました'), { n: nm, f: tgt }));
          else notify(fmt(t('dash.movedToRoot', '「{n}」をフォルダから外しました'), { n: nm }));
          if (window.A11y && window.A11y.announce) window.A11y.announce(fmt(t('dash.movedTo', '「{n}」を「{f}」へ移動しました'), { n: nm, f: tgt || t('dash.move.root', 'ルート(フォルダなし)') }));
          renderProjectList();
        }).catch(function (err) {
          okBtn.disabled = false;
          notify(t('dash.moveFailed', '移動に失敗しました') + (err && err.message ? ': ' + err.message : ''));
        });
      });
      sel.focus();
    }).catch(function () {
      notify(t('dash.moveFailed', '移動に失敗しました'));
    });
  }

  /* ダッシュボード / 資料一覧 / 共有一覧のクリック処理(文書中に要素が現れても効くよう委譲) */
  function wireInteractions() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // フェーズ26/28: メニューを開いている状態で外側をクリックしたら閉じる
      if (_popupMenuEl && !t.closest('.recent-menu-pop') && !t.closest('.recent-menu') && !t.closest('.folder-menu')) closePopupMenu();
      // フェーズ26: 行の「…」メニュー(フォルダへ移動)
      var rmenu = t.closest('.recent-menu');
      if (rmenu) {
        e.stopPropagation(); e.preventDefault();
        if (rmenu.getAttribute('aria-expanded') === 'true') closePopupMenu();
        else openRowMenu(rmenu);
        return;
      }
      // フェーズ28: フォルダ見出しの「…」メニュー(名前変更・移動・プロジェクト追加)
      var fmenu = t.closest('.folder-menu');
      if (fmenu) {
        e.stopPropagation(); e.preventDefault();
        if (fmenu.getAttribute('aria-expanded') === 'true') closePopupMenu();
        else openFolderMenu(fmenu);
        return;
      }
      // フェーズ26: フォルダ見出しの折りたたみ切替
      var fhead = t.closest('.folder-head');
      if (fhead) { toggleFolder(fhead); return; }
      var del = t.closest('.recent-del');
      if (del) {
        e.stopPropagation();
        var row0 = del.closest('.recent-row');
        // フェーズ15: プロジェクト行の削除
        var pid0 = row0 && row0.getAttribute('data-project');
        if (pid0) {
          if (window.confirm('「' + (projectNameCache[pid0] || 'このプロジェクト') + '」を削除しますか?')) {
            var eid0 = findEntryByProject(pid0);
            if (eid0) removeDoc(eid0);
            else if (window.Projects) window.Projects.remove(pid0).then(renderDashboard).catch(function () {});
            else renderDashboard();
          }
          return;
        }
        var id0 = row0 && row0.getAttribute('data-id');
        if (id0 && store[id0] && window.confirm('「' + (store[id0].title || 'この文書') + '」を削除しますか?')) removeDoc(id0);
        return;
      }
      var row = t.closest('.recent-row');
      if (row) {
        // フェーズ15: プロジェクト行を開く
        var pid = row.getAttribute('data-project');
        if (pid) { openProject(pid, projectNameCache[pid]); return; }
        var id = row.getAttribute('data-id');
        if (id && store[id]) { openId(id, false); closeBackstage(); }
        return;
      }
      var sc = t.closest('.share-copy');
      if (sc) {
        var url = sc.getAttribute('data-url');
        if (url && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).catch(function () { });
        return;
      }
      var sd = t.closest('.share-del');
      if (sd) {
        var srow = sd.closest('.share-row');
        var sid = srow && srow.getAttribute('data-id');
        if (sid) deleteShare(sid);
        return;
      }
      var ra = t.closest('.recent-access');   // フェーズ14: ダッシュボードからアクセス管理
      if (ra) {
        e.stopPropagation();
        var arow = ra.closest('.recent-row');
        var aid = arow && arow.getAttribute('data-id');
        if (aid) openAccessFor(aid);
        return;
      }
      var arm = t.closest('.access-remove');  // メンバー削除
      if (arm) {
        var amrow = arm.closest('.access-member');
        var auid = amrow && amrow.getAttribute('data-uid');
        if (auid && window.confirm('このユーザーのアクセスを削除しますか?')) accessRevoke(auid);
        return;
      }
      var ari = t.closest('.access-remove-invite');  // 招待取り消し
      if (ari) {
        var airow = ari.closest('.access-member');
        var aemail = airow && airow.getAttribute('data-email');
        if (aemail) accessRevokeInvite(aemail);
        return;
      }
      var srrow = t.closest('.source-row');
      if (srrow) { selectedSourceKey = srrow.getAttribute('data-key'); renderSourceList(); return; }
      var vitem = t.closest('.version-item');
      if (vitem) { enterVersionView(vitem.getAttribute('data-vid')); return; }
      /* フェーズ15: git コミット / 復元 */
      var gcb = t.closest('.git-commit-btn');
      if (gcb) { e.preventDefault(); doCommit(); return; }
      var gbc = t.closest('.git-branch-create');
      if (gbc) { e.preventDefault(); createDraftVersion(); return; }
      var gbs = t.closest('.git-branch-switch');
      if (gbs) { e.preventDefault(); var branchSelect = byId('git-branch-select'); switchDraftVersion(branchSelect && branchSelect.value).catch(function () { notify('原稿版を切り替えられませんでした'); }); return; }
      var sup = t.closest('.submission-upload');
      if (sup) { e.preventDefault(); chooseSubmissionFiles(); return; }
      var sce = t.closest('.submission-copy-email');
      if (sce) { e.preventDefault(); copySubmissionEmail(sce.getAttribute('data-path')); return; }
      var gci = t.closest('.git-commit-item');
      if (gci) { doRestore(gci.getAttribute('data-hash')); return; }
      /* フェーズ15: 出力モードトグル */
      var omt = t.closest('#output-mode-toggle');
      if (omt) { e.preventDefault(); toggleOutputMode(); return; }
    });

    // フェーズ26: フォルダ見出しのキーボード操作(Enter/Space で折りたたみ切替)
    document.addEventListener('keydown', function (e) {
      var el = e.target;
      if (!el || !el.classList || !el.classList.contains('folder-head')) return;
      // メニューボタンや内側要素の Enter/Space は各自で処理させる
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggleFolder(el);
      }
    });

    // フェーズ28: ドラッグ&ドロップ(プロジェクト→フォルダ / フォルダ→フォルダ)。
    //   キーボード代替は「…」メニュー(WCAG 2.5.7)。ドロップ先は folder-head。
    var _dragKind = null, _dragData = null;
    function clearDragUI() {
      var d = document.querySelectorAll('.recent-row.dragging, .folder-head.dragging, .folder-head.drop-target');
      for (var i = 0; i < d.length; i++) { d[i].classList.remove('dragging'); d[i].classList.remove('drop-target'); }
    }
    function canDropOn(destFp) {
      if (_dragKind === 'folder') {
        var src = _dragData;
        if (destFp === src) return false;                    // 自分自身
        if (destFp.indexOf(src + '/') === 0) return false;   // 自分の子孫
        var parent = src.indexOf('/') >= 0 ? src.slice(0, src.lastIndexOf('/')) : '';
        if (destFp === parent) return false;                 // 既に直下(変化なし)
        return true;
      }
      return _dragKind === 'project';                        // プロジェクトはどのフォルダにも可
    }
    document.addEventListener('dragstart', function (e) {
      var tgt = e.target;
      if (!tgt || !tgt.closest) return;
      var row = tgt.closest('.recent-row');
      var head = tgt.closest('.folder-head');
      if (row && row.getAttribute('data-project')) {
        _dragKind = 'project'; _dragData = row.getAttribute('data-project');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'project:' + _dragData); } catch (er) {}
        row.classList.add('dragging');
      } else if (head && head.getAttribute('data-folder')) {
        _dragKind = 'folder'; _dragData = head.getAttribute('data-folder');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'folder:' + _dragData); } catch (er) {}
        head.classList.add('dragging');
      }
    });
    document.addEventListener('dragend', function () { _dragKind = null; _dragData = null; clearDragUI(); });
    document.addEventListener('dragover', function (e) {
      if (!_dragKind) return;
      var head = e.target.closest && e.target.closest('.folder-head');
      if (!head) return;
      if (!canDropOn(head.getAttribute('data-folder'))) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (er) {}
      head.classList.add('drop-target');
    });
    document.addEventListener('dragleave', function (e) {
      var head = e.target.closest && e.target.closest('.folder-head');
      if (head && !head.contains(e.relatedTarget)) head.classList.remove('drop-target');
    });
    document.addEventListener('drop', function (e) {
      if (!_dragKind) return;
      var head = e.target.closest && e.target.closest('.folder-head');
      if (!head) return;
      var destFp = head.getAttribute('data-folder');
      if (!canDropOn(destFp)) return;
      e.preventDefault();
      head.classList.remove('drop-target');
      var kind = _dragKind, data = _dragData;
      _dragKind = null; _dragData = null; clearDragUI();
      if (kind === 'project') {
        var nm = projectNameCache[data] || t('doc.untitled', '無題');
        window.Projects.setFolder(data, destFp).then(function () {
          notify(fmt(t('dash.movedTo', '「{n}」を「{f}」へ移動しました'), { n: nm, f: destFp }));
          if (window.A11y && window.A11y.announce) window.A11y.announce(fmt(t('dash.movedTo', '「{n}」を「{f}」へ移動しました'), { n: nm, f: destFp }));
          renderProjectList();
        }).catch(function (err) {
          notify(t('dash.moveFailed', '移動に失敗しました') + (err && err.message ? ': ' + err.message : ''));
        });
      } else if (kind === 'folder') {
        var leaf = data.split('/').pop();
        var newPath = destFp + '/' + leaf;
        if (knownFolders.indexOf(newPath) >= 0 &&
            !window.confirm(fmt(t('dash.folder.collide', '「{f}」は既に存在します。統合しますか?'), { f: newPath }))) return;
        doRenameFolder(data, newPath).catch(function () {});
      }
    });

    // フェーズ11: 文書言語セレクト(#doc-lang-select)。並行エージェントが用意する
    // DOM を参照。存在しなくても防御的に無害(委譲リスナで拾う)。
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (el && el.id === 'doc-lang-select') setDocLanguage(el.value);
      if (el && el.classList && el.classList.contains('share-perm-toggle')) {
        var prow = el.closest('.share-row');
        var pid = prow && prow.getAttribute('data-id');
        if (pid) updateSharePermission(pid, el.value);
      }
      if (el && el.classList && el.classList.contains('access-role-change')) {
        var mrow = el.closest('.access-member');
        var muid = mrow && mrow.getAttribute('data-uid');
        if (muid) accessSetRole(muid, el.value);
      }
      // フェーズ15: 出力モード(最終成果物)チェックボックス
      if (el && el.classList && el.classList.contains('final-output-check')) {
        setOutputMode(!!el.checked);
      }
      // フェーズ31: 温存プリアンブルの使用可否
      if (el && el.id === 'use-preamble-check') {
        setUsePreamble(!!el.checked);
      }
    });
  }

  /* ================= 変更フック ================= */

  function afterDocChange() {
    scheduleSave();
    if (previewVisible()) scheduleCompile();
    if (sourceVisible()) scheduleSourceUpdate();
  }

  /* ================= フェーズ3.5: ダークモード ================= */

  function loadTheme() {
    var raw = safeGet(THEME_KEY);
    if (raw) {
      try {
        var t = JSON.parse(raw);
        if (t && typeof t === 'object') {
          theme = (t.theme === 'dark') ? 'dark' : 'light';
          // フェーズ27: page はユーザーが明示選択した時だけ尊重(pageExplicit)。
          pageExplicit = !!t.pageExplicit;
          if (pageExplicit && (t.page === 'dark' || t.page === 'light')) pageTheme = t.page;
        }
      } catch (e) {}
    } else {
      // 初回は OS 設定に追従
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          theme = 'dark';
        }
      } catch (e) {}
    }
    // フェーズ27: ダークテーマで明示選択が無ければ、既定でページ(紙)も暗くする。
    if (!pageExplicit && theme === 'dark') pageTheme = 'dark';
  }

  function saveTheme() {
    safeSet(THEME_KEY, JSON.stringify({ theme: theme, page: pageTheme, pageExplicit: pageExplicit }));
  }

  function applyTheme() {
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-page', (theme === 'dark') ? pageTheme : 'light');

    var dmBtns = document.querySelectorAll('[data-command="darkMode"]');
    for (var i = 0; i < dmBtns.length; i++) {
      dmBtns[i].setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      dmBtns[i].classList.toggle('is-active', theme === 'dark');
    }
    var dpBtns = document.querySelectorAll('[data-command="darkPage"]');
    for (var j = 0; j < dpBtns.length; j++) {
      var on = (theme === 'dark' && pageTheme === 'dark');
      dpBtns[j].setAttribute('aria-pressed', on ? 'true' : 'false');
      dpBtns[j].classList.toggle('is-active', on);
      dpBtns[j].disabled = (theme !== 'dark');   // ダーク時のみ活性
    }
  }

  function toggleDark() {
    theme = (theme === 'dark') ? 'light' : 'dark';
    // フェーズ27: ダークをオンにしたら、明示選択が無ければページ(紙)も既定で暗くする。
    //   オフ時に pageTheme を強制リセットしない(=白紙の明示選択を維持したまま復帰できる)。
    if (theme === 'dark' && !pageExplicit) pageTheme = 'dark';
    applyTheme();
    saveTheme();
    if (window.A11y && window.A11y.announce) {
      window.A11y.announce(theme === 'dark' ? 'ダークモードをオンにしました' : 'ダークモードをオフにしました');
    }
  }

  function toggleDarkPage() {
    if (theme !== 'dark') return;   // ダーク時のみ有効
    pageTheme = (pageTheme === 'dark') ? 'light' : 'dark';
    pageExplicit = true;            // フェーズ27: 以後この選択を尊重
    applyTheme();
    saveTheme();
  }

  /* ================= フェーズ3.5: バージョン履歴 ================= */

  function versionPanelOpen() {
    var p = byId('version-panel');
    return !!p && !p.hidden;
  }

  function dayBucket(iso) {
    var t = new Date(iso); t.setHours(0, 0, 0, 0);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((today.getTime() - t.getTime()) / 86400000);
    if (diff <= 0) return '今日';
    if (diff === 1) return '昨日';
    if (diff < 7) return '今週';
    return 'それ以前';
  }

  function timeLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderVersionList() {
    var list = byId('version-list');
    if (!list) return;
    var versions = (window.Versions && currentId) ? window.Versions.list(currentId) : [];
    if (!versions.length) {
      list.innerHTML = '<div class="vp-empty">まだバージョンがありません。編集・保存するとここに履歴が表示されます。</div>';
      return;
    }
    var html = '';
    var lastBucket = null;
    for (var i = 0; i < versions.length; i++) {
      var v = versions[i];
      var bucket = dayBucket(v.time);
      if (bucket !== lastBucket) {
        html += '<div class="vp-group">' + escapeHtml(bucket) + '</div>';
        lastBucket = bucket;
      }
      var kindLabel = (v.kind === 'manual') ? '手動保存' : '自動保存';
      var sel = (versionViewing && v.vid === viewingVid) ? ' selected' : '';
      html += '<button type="button" class="version-item' + sel + '" data-vid="' + escAttr(v.vid) + '">' +
        '<span class="vi-time">' + escapeHtml(timeLabel(v.time)) + '</span>' +
        '<span class="vi-badge vi-' + v.kind + '">' + kindLabel + '</span>' +
        '<span class="vi-chars">' + escapeHtml(String(v.charCount || 0)) + ' 文字</span>' +
        '</button>';
    }
    list.innerHTML = html;
  }

  function openVersionPanel() {
    // 現在の編集内容を文書ストアへ退避 (スナップショットは SPEC の4トリガーのみ)
    if (!versionViewing) { captureCurrent(); saveStore(); }
    var p = byId('version-panel');
    if (p) p.hidden = false;
    // フェーズ15: プロジェクトモードでは git コミットパネルを表示(localStorage 版履歴は無効)
    if (projectMode) { renderGitPanel(); return; }
    renderVersionList();
  }

  function closeVersionPanel() {
    var p = byId('version-panel');
    if (p) p.hidden = true;
    if (versionViewing) exitVersionView();
  }

  // バージョン閲覧モードに入る (読み取り専用 + 黄色バナー)
  function enterVersionView(vid) {
    if (!window.Versions || !currentId) return;
    var v = window.Versions.get(currentId, vid);
    if (!v) return;
    var d = doc();
    if (!d) return;
    if (!versionViewing) {
      // まだ生の状態を退避していなければ退避
      captureCurrent();
      saveStore();
      liveHtmlBackup = store[currentId] ? store[currentId].html : d.innerHTML;
    }
    versionViewing = true;
    viewingVid = vid;
    d.innerHTML = v.html || '<p><br></p>';
    d.setAttribute('contenteditable', 'false');
    if (window.Editor && window.Editor.refresh) window.Editor.refresh();

    var banner = byId('version-banner');
    if (banner) {
      var meta = byId('version-banner-meta');
      if (meta) {
        var kindLabel = (v.kind === 'manual') ? '手動保存' : '自動保存';
        meta.textContent = timeLabel(v.time) + '・' + kindLabel + '・' + (v.charCount || 0) + ' 文字';
      }
      banner.hidden = false;
    }
    renderVersionList();
  }

  // 閲覧 UI / 状態のクリーンアップ (html は触らない)
  function resetVersionView() {
    versionViewing = false;
    viewingVid = null;
    liveHtmlBackup = null;
    var d = doc();
    if (d) d.setAttribute('contenteditable', 'true');
    var banner = byId('version-banner');
    if (banner) banner.hidden = true;
  }

  // 「最新版に戻る」: 生の状態へ戻して編集モードへ
  function exitVersionView() {
    if (!versionViewing) { resetVersionView(); return; }
    var d = doc();
    if (d && liveHtmlBackup != null) {
      d.innerHTML = liveHtmlBackup;
    } else if (d && store[currentId]) {
      d.innerHTML = store[currentId].html || defaultDocHtml();
    }
    resetVersionView();
    if (window.Editor) {
      if (window.Editor.setComments && store[currentId]) window.Editor.setComments(store[currentId].comments || {});
      if (window.Editor.renumberFootnotes) window.Editor.renumberFootnotes();
      if (window.Editor.resetHistory) window.Editor.resetHistory();
      if (window.Editor.refresh) window.Editor.refresh();
    }
    renderBibliographies();
    if (versionPanelOpen()) renderVersionList();
  }

  // 「復元」: 現状を自動スナップショットしてから選択版を現行文書に反映
  function restoreCurrentView() {
    if (!versionViewing || !viewingVid || !window.Versions || !currentId) return;
    var v = window.Versions.get(currentId, viewingVid);
    if (!v) return;
    // 復元直前に現状 (生) を自動スナップショット
    if (liveHtmlBackup != null) {
      try {
        window.Versions.snapshot(currentId, 'auto', {
          html: liveHtmlBackup,
          comments: (store[currentId] && store[currentId].comments) || {},
          bib: (store[currentId] && store[currentId].bib) || [],
          charCount: charCountOfHtml(liveHtmlBackup)
        });
      } catch (e) {}
    }
    // 状態を解除して選択版を現行へ
    versionViewing = false; viewingVid = null; liveHtmlBackup = null;
    var d = doc();
    if (d) {
      d.setAttribute('contenteditable', 'true');
      d.innerHTML = v.html || defaultDocHtml();
    }
    var banner = byId('version-banner');
    if (banner) banner.hidden = true;
    bibEntries = Array.isArray(v.bib) ? v.bib.slice() : [];
    if (window.Editor) {
      if (window.Editor.setComments) window.Editor.setComments(v.comments || {});
      if (window.Editor.renumberFootnotes) window.Editor.renumberFootnotes();
      if (window.Editor.resetHistory) window.Editor.resetHistory();
      if (window.Editor.refresh) window.Editor.refresh();
    }
    renderBibliographies();
    renderCiteMenu();
    renderSourceList();
    saveNow();                       // 復元結果を現行文書へ保存
    if (versionPanelOpen()) renderVersionList();
    afterDocChange();
  }

  /* ================= コマンド ================= */

  // フェーズ27: tex ソース編集中に無効化する書式・本文編集系コマンド。
  var TEX_BLOCKED_CMDS = {
    margin: 1, orientLandscape: 1, orientPortrait: 1, toc: 1,
    columns: 1, paper: 1, lineHeight: 1, paraSpace: 1, lineNumbers: 1,
    addSource: 1, newSource: 1, saveSource: 1, editSource: 1, deleteSource: 1,
    manageSources: 1, importBib: 1, exportBib: 1, insertCite: 1, insertBibliography: 1,
    bibStyle: 1, docLanguage: 1, newFromTemplate: 1, openDocx: 1, openProjectFolder: 1, downloadDocx: 1, open: 1
  };

  function exec(cmd, value) {
    // フェーズ27: tex モード中は書式・本文編集系コマンドを no-op + アナウンス
    if (texMode && TEX_BLOCKED_CMDS[cmd]) {
      if (window.A11y && window.A11y.announce) {
        window.A11y.announce(t('tex.blocked', 'texソース編集中は使用できません'));
      }
      return;
    }
    switch (cmd) {
      case 'new': newDocument(); break;
      case 'open': openTex(); break;
      case 'openProjectFolder': openProjectFolder(); break;
      case 'downloadTex': downloadTex(); break;
      case 'downloadPdf': downloadPdf(); break;
      case 'compile': compile(); break;
      case 'save':
        if (saveTimer) clearTimeout(saveTimer);
        saveNow();
        if (window.A11y && window.A11y.announce) window.A11y.announce('保存しました');
        // フェーズ15: プロジェクトモードでは手動スナップショットは git コミットに置換
        if (!versionViewing && currentId && window.Versions && !projectMode) {
          try { window.Versions.snapshot(currentId, 'manual'); } catch (e) {}
        }
        if (!projectMode && versionViewing && versionPanelOpen()) renderVersionList();
        if (projectMode) refreshProjectStatus();
        if (previewVisible()) compile();
        break;
      /* フェーズ15: 出力モード / git */
      case 'toggleOutputMode': toggleOutputMode(); break;
      case 'setOutputMode': setOutputMode(value === 'final' || value === true || value === 'true'); break;
      case 'gitCommit': doCommit(); break;
      case 'zoom': applyZoom(value); break;
      case 'zoomIn': applyZoom(zoomValue + 10); break;
      case 'zoomOut': applyZoom(zoomValue - 10); break;
      case 'zoomReset': applyZoom(100); break;
      case 'toggleSource': toggleSource(); break;
      case 'togglePreview': togglePreview(); break;
      case 'margin':
        applyMargin(value);
        afterDocChange();
        break;
      case 'orientLandscape':
        applyOrientation(true);
        announceLayout(t('a11y.orientLandscape', '用紙を横向きにしました'));
        afterDocChange();
        break;
      case 'orientPortrait':
        applyOrientation(false);
        announceLayout(t('a11y.orientPortrait', '用紙を縦向きにしました'));
        afterDocChange();
        break;
      case 'toc': toggleToc(); break;
      /* フェーズ30: レイアウト強化 */
      case 'columns':
        applyColumns(value);
        announceLayout(fmt(t('a11y.columnsChanged', '段組みを{v}に変更しました'), { v: columnsLabel(options.columns) }));
        afterDocChange();
        break;
      case 'paper':
        applyPaper(value);
        announceLayout(fmt(t('a11y.paperChanged', '用紙サイズを{v}に変更しました'), { v: paperLabel(options.paper) }));
        afterDocChange();
        break;
      case 'lineHeight':
        applyLineHeight(value);
        announceLayout(fmt(t('a11y.lineHeightChanged', '行間を{v}に変更しました'), { v: options.lineHeight }));
        afterDocChange();
        break;
      case 'paraSpace':
        applyParaSpace(!options.paraSpace);
        announceLayout(options.paraSpace
          ? t('a11y.paraSpaceOn', '段落後のスペースを追加しました')
          : t('a11y.paraSpaceOff', '段落後のスペースを解除しました'));
        afterDocChange();
        break;
      case 'lineNumbers':
        applyLineNumbers(!options.lineNumbers);
        announceLayout(options.lineNumbers
          ? t('a11y.lineNumbersOn', '行番号をオンにしました(PDF に付与されます)')
          : t('a11y.lineNumbersOff', '行番号をオフにしました'));
        afterDocChange();
        break;
      /* フェーズ2 */
      case 'downloadDocx': downloadDocx(); break;
      case 'openDocx': openDocx(); break;
      case 'shareLink': shareLink(); break;
      case 'sharePdf': sharePdf(); break;
      /* フェーズ14: ユーザー単位アクセス */
      case 'accessInvite': accessInvite(); break;
      /* フェーズ3 */
      case 'newFromTemplate': newFromTemplate(value); break;
      /* フェーズ3b: 文献 */
      case 'addSource': case 'newSource': addSource(); break;
      case 'saveSource': saveSource(); break;
      case 'editSource': editSource(); break;
      case 'deleteSource': deleteSource(); break;
      case 'manageSources': manageSources(); break;
      case 'importBib': importBib(); break;
      case 'exportBib': exportBib(); break;
      case 'insertCite': insertCiteCmd(value); break;
      case 'insertBibliography': insertBibliographyCmd(); break;
      case 'bibStyle': setBibStyle(value); break;
      /* フェーズ3.5: バージョン履歴 */
      case 'versionHistory': openVersionPanel(); break;
      case 'restoreVersion': restoreCurrentView(); break;
      case 'exitVersionView': exitVersionView(); break;
      /* フェーズ3.5: ダークモード */
      case 'darkMode': toggleDark(); break;
      case 'darkPage': toggleDarkPage(); break;
      /* フェーズ11: 文書言語 */
      case 'docLanguage': setDocLanguage(value); break;
      default: break;
    }
  }

  /* ================= 初期化 ================= */

  function init() {
    loadTheme();
    applyTheme();
    // フェーズ7: 既定アダプタ = LocalStore(挙動不変)。store.js 未ロード時は null(saveStore が従来処理へフォールバック)。
    storeAdapter = (window.Store && window.Store.createLocal) ? window.Store.createLocal() : null;
    // フェーズ19: Assets(assets.js)へ現在の保存先コンテキストを供給。
    //   cloud=クラウド保存中(Firestore)、projectId=ローカルプロジェクト、docId=Firestore doc id。
    if (window.Assets && window.Assets.setContext) {
      window.Assets.setContext(function () {
        return {
          projectId: currentProjectId(),
          docId: currentId,
          cloud: !!(storeAdapter && storeAdapter.mode === 'cloud')
        };
      });
    }
    loadStore();
    setupTexInput();
    setupDocxInput();
    setupBibInput();
    var projectFolderInput = byId('project-folder-input');
    if (projectFolderInput) {
      projectFolderInput.addEventListener('change', function () {
        var files = projectFolderInput.files;
        if (files && files.length) importProjectFolder(files);
        projectFolderInput.value = '';
      });
    }
    var submissionFilesInput = byId('submission-files-input');
    if (submissionFilesInput) submissionFilesInput.addEventListener('change', function () { saveSubmissionFiles(submissionFilesInput.files); });
    wireInteractions();
    wireThreadPanel();         // フェーズ17: スレッド パネルの委譲配線
    subscribeThreads();        // フェーズ17: Threads.onChange で永続化トリガ
    openId(currentId, true);   // 現在文書を #doc に読み込み(直前退避なし)
    applyZoom(100);
    updateWorkspaceClasses();
    syncBibStyleSelect();

    var d = doc();
    if (d) {
      d.addEventListener('input', afterDocChange);
    }

    // フェーズ10c: クラウドモードで離脱時に保留中の保存を取りこぼさない即時フラッシュ。
    //   ローカルモードでは flushSave が no-op のため挙動は変わらない。
    window.addEventListener('blur', flushSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });

    var titleEl = byId('doc-title');
    if (titleEl) {
      titleEl.addEventListener('input', function () {
        if (currentId && store[currentId]) store[currentId].title = docTitle();
        scheduleSave();
        if (projectMode) scheduleMetaRename();   // フェーズ15: プロジェクト名を追従
      });
    }

    var slider = byId('zoom-slider');
    if (slider) {
      slider.addEventListener('input', function () { applyZoom(slider.value); });
    }

    var copyBtn = byId('copy-source');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var pre = byId('latex-source');
        var text = pre ? pre.textContent : generateLatex();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () { });
        }
      });
    }

    var refreshBtn = byId('refresh-preview');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () { compile(); });
    }

    var vpClose = byId('version-panel-close');
    if (vpClose) {
      vpClose.addEventListener('click', closeVersionPanel);
    }

    // アクティブ編集中 10 分ごとの自動スナップショット (同一 html はスキップ)
    if (versionTimer) clearInterval(versionTimer);
    versionTimer = setInterval(function () {
      if (versionViewing || !currentId || !window.Versions || projectMode) return;
      captureCurrent();
      try { window.Versions.snapshot(currentId, 'auto'); } catch (e) {}
      if (versionPanelOpen()) renderVersionList();
    }, 600000);

    setSaveStatus('• 保存済み');

    // フェーズ7: クラウド認証状態にアダプタを追従(ローカルモードでは無害)。
    wireCloud();

    // フェーズ15: プロジェクトモードの初期化(サーバー到達可なら有効化。不通ならローカル維持)。
    syncOutputModeUI();
    initProjects();
  }

  window.App = {
    exec: exec,
    compile: compile,
    getOptions: function () {
      // フェーズ15: 出力モードを含める(uapdf 等が参照可能)
      // フェーズ30: レイアウト設定も公開(uapdf 等が段組み等を参照可能)
      return {
        margin: options.margin, landscape: options.landscape, toc: options.toc,
        columns: options.columns, paper: options.paper, lineHeight: options.lineHeight,
        paraSpace: options.paraSpace, lineNumbers: options.lineNumbers,
        finalOutput: isFinalOutput()
      };
    },
    /* フェーズ15: 出力モード / プロジェクト連携 */
    isFinalOutput: isFinalOutput,
    setOutputMode: setOutputMode,
    toggleOutputMode: toggleOutputMode,
    notify: notify,
    showMainDoc: showMainDoc,
    openTexSource: openTexSource,   // フェーズ27: ツリーで .tex を中央エディタで開く
    getCurrentProjectId: currentProjectId,
    openProject: openProject,
    isProjectMode: function () { return projectMode; },
    refreshTree: function () { if (window.FileTree) window.FileTree.reload(); },
    /* フェーズ3: ダッシュボード描画(ui.js がバックステージ「ホーム」表示時に呼ぶ) */
    renderDashboard: renderDashboard,
    /* フェーズ14: アクセス管理(ui.js / 管理コンソールから呼ぶ。クラウドのみ実効) */
    renderAccess: renderAccess,
    openAccessFor: openAccessFor,
    /* フェーズ3: 複数文書ストア API */
    docs: {
      list: function () {
        return sortedIds().map(function (id) {
          var e = store[id];
          return { id: id, title: e.title, updatedAt: e.updatedAt, charCount: e.charCount };
        });
      },
      open: function (id) { openId(id, false); },
      create: function (templateName) { return createDoc(templateName); },
      remove: function (id) { removeDoc(id); },
      currentId: function () { return currentId; }
    },
    /* フェーズ3b: 文献 API(参照・描画補助) */
    bib: {
      entries: function () { return bibEntries.slice(); },
      getStyle: function () { return bibStyle; },
      setStyle: setBibStyle,
      renderMenus: function () { renderCiteMenu(); renderSourceList(); renderBibliographies(); }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
