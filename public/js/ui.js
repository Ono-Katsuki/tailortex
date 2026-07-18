/* ==========================================================
   ui.js — 見た目の挙動のみ (Agent-UI)
   タブ切替 / バックステージ / ドロップダウン / 表グリッドピッカー /
   data-command → window.Editor.exec ディスパッチ / ルーラー数字生成
   編集ロジック・LaTeX・fetch は一切書かない。
   ========================================================== */
(function () {
  'use strict';

  function exec(cmd, value) {
    if (window.Editor && typeof window.Editor.exec === 'function') {
      window.Editor.exec(cmd, value);
    }
  }

  /* ---------- リボンタブ切替 ---------- */
  var tabs = document.querySelectorAll('.ribbon-tab');
  // ロービングタブインデックス対象 (ファイルタブ・共有ボタンを除く role=tab のみ)
  var roleTabs = Array.prototype.filter.call(tabs, function (t) {
    return t.getAttribute('role') === 'tab';
  });

  function activateTab(tab, focusIt) {
    if (!tab || tab.classList.contains('file-tab')) return;
    tabs.forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    var name = tab.dataset.tab;
    document.querySelectorAll('.ribbon-panel').forEach(function (p) {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    // ARIA + ロービングタブインデックス同期
    roleTabs.forEach(function (t) {
      var sel = (t === tab);
      t.setAttribute('aria-selected', sel ? 'true' : 'false');
      t.tabIndex = sel ? 0 : -1;
    });
    if (focusIt && tab.focus) tab.focus();
    if (window.__resetRibbonRoving) window.__resetRibbonRoving();
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      if (tab.classList.contains('file-tab')) {
        openBackstage();
        return;
      }
      activateTab(tab, false);
    });
  });

  /* タブ行のキーボード操作 (←→ でタブ切替 / Home / End) */
  var tabsBar = document.getElementById('ribbon-tabs');
  if (tabsBar) {
    tabsBar.addEventListener('keydown', function (e) {
      var cur = e.target;
      if (!cur || cur.getAttribute('role') !== 'tab') return;
      var idx = roleTabs.indexOf(cur);
      if (idx < 0) return;
      var next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = roleTabs[(idx + 1) % roleTabs.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = roleTabs[(idx - 1 + roleTabs.length) % roleTabs.length];
      else if (e.key === 'Home') next = roleTabs[0];
      else if (e.key === 'End') next = roleTabs[roleTabs.length - 1];
      if (next) { e.preventDefault(); activateTab(next, true); }
    });
  }

  /* ---------- タイトルメニュー (∨) ---------- */
  var titleMenuBtn = document.getElementById('title-menu-btn');
  var titleMenu = document.getElementById('title-menu');

  function closeTitleMenu() {
    if (!titleMenu) return;
    titleMenu.hidden = true;
    if (titleMenuBtn) titleMenuBtn.setAttribute('aria-expanded', 'false');
  }
  function openTitleMenu() {
    if (!titleMenu) return;
    // 表示中の文書名をメニュー見出しに反映
    var nameEl = document.getElementById('title-menu-name');
    var docTitle = document.getElementById('doc-title');
    if (nameEl && docTitle) {
      nameEl.textContent = (docTitle.textContent || '').replace(/\s*-\s*(?:Word風LaTeX|RaTeX|TailorTeX)\s*$/, '').trim() || '文書 1';
    }
    titleMenu.hidden = false;
    if (titleMenuBtn) titleMenuBtn.setAttribute('aria-expanded', 'true');
  }
  if (titleMenuBtn) {
    titleMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (titleMenu && titleMenu.hidden) openTitleMenu(); else closeTitleMenu();
    });
  }
  document.addEventListener('click', function (e) {
    if (titleMenu && !titleMenu.hidden &&
        !e.target.closest('#title-menu') && !e.target.closest('#title-menu-btn')) {
      closeTitleMenu();
    }
  });

  /* ---------- バックステージ ---------- */
  var backstage = document.getElementById('backstage');

  /* ホームビュー表示のたびにダッシュボードを再描画 (中身は Logic-3 が担当) */
  function renderDashboardIfHome() {
    var home = document.getElementById('bs-home');
    if (home && home.classList.contains('active') &&
        window.App && typeof window.App.renderDashboard === 'function') {
      window.App.renderDashboard();
      labelDashboardControls();
    }
  }

  /* フェーズ4: Logic-3 が描画する動的コントロールに aria-label を補う
     (共有 URL 入力欄はラベルが無いため。共有リストはサーバー取得後に
      非同期で描画されるので MutationObserver でも監視する) */
  function labelDashboardControls() {
    document.querySelectorAll('#share-list .share-url').forEach(function (inp) {
      if (inp.getAttribute('aria-label')) return;
      var row = inp.closest('.share-row');
      var title = row && row.querySelector('.share-title');
      inp.setAttribute('aria-label', '共有リンク' + (title ? ' ' + title.textContent.trim() : ''));
      inp.setAttribute('readonly', 'readonly');
    });
  }
  var shareListEl = document.getElementById('share-list');
  if (shareListEl && window.MutationObserver) {
    new MutationObserver(labelDashboardControls).observe(shareListEl, { childList: true, subtree: true });
  }

  /* フェーズ7: 管理ナビは superadmin クレームがある時だけ表示。
     Cloud が無い / 未ログインなら常に非表示(ローカルモードでは何も起きない)。 */
  function isSuperAdmin() {
    return !!(window.Cloud && typeof window.Cloud.isSuperAdmin === 'function' && window.Cloud.isSuperAdmin());
  }
  function syncAdminNav() {
    var nav = document.querySelector('#backstage .bs-nav-item[data-bs-view="admin"]');
    if (nav) nav.hidden = !isSuperAdmin();
    if (!isSuperAdmin()) {
      // 管理ビューを開いたまま権限を失ったらホームへ退避
      var admin = document.getElementById('bs-admin');
      if (admin && admin.classList.contains('active')) showBackstageView('home');
    }
  }
  if (window.Cloud && typeof window.Cloud.onAuthChange === 'function') {
    window.Cloud.onAuthChange(function () { syncAdminNav(); });
  }

  function showBackstageView(name) {
    if (name === 'admin' && !isSuperAdmin()) name = 'home';
    document.querySelectorAll('#backstage .bs-view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'bs-' + name);
    });
    document.querySelectorAll('#backstage .bs-nav-item[data-bs-view]').forEach(function (n) {
      n.classList.toggle('active', n.dataset.bsView === name);
    });
    renderDashboardIfHome();
    if (name === 'admin' && window.Cloud && typeof window.Cloud.renderAdmin === 'function') {
      window.Cloud.renderAdmin();
    }
  }

  function openBackstage()  {
    backstage.hidden = false;
    syncAdminNav();
    renderDashboardIfHome();
    setTrap(backstage);
  }
  function closeBackstage() {
    if (backstage.hidden) return;
    backstage.hidden = true;
    releaseTrap(backstage);
  }
  document.getElementById('backstage-close').addEventListener('click', closeBackstage);

  /* サイドバー ナビ (ホーム/新規/開く/エクスポート) はビュー切替 */
  document.querySelectorAll('#backstage .bs-nav-item[data-bs-view]').forEach(function (n) {
    n.addEventListener('click', function () {
      showBackstageView(n.dataset.bsView);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeBackstage();
      closeAllDropdowns();
      closeDialogs();
      closeTitleMenu();
      closePasteCheckPanel();
    }
  });

  /* ---------- ダイアログ開閉 (フェーズ2: 共有・文字カウント) ----------
     開閉のみ。リンク発行は app.js (shareLink)、統計値は editor.js が埋める。 */
  var dialogOverlay = document.getElementById('dialog-overlay');
  var shareDialog = document.getElementById('share-dialog');
  var wordCountDialog = document.getElementById('word-count-dialog');
  var sourceManagerDialog = document.getElementById('source-manager-dialog');
  var sourceEditDialog = document.getElementById('source-edit-dialog');

  var uapdfDialog = document.getElementById('uapdf-dialog');
  var bibCheckDialog = document.getElementById('bib-check-dialog');
  var accessDialog = document.getElementById('access-dialog');
  var pasteCheckPanel = document.getElementById('paste-check-dialog');

  // フェーズ14: クラウド(ログイン済み)のときだけアクセス管理を扱う
  function cloudReady() {
    return !!(window.Cloud && typeof window.Cloud.isEnabled === 'function' && window.Cloud.isEnabled()
      && typeof window.Cloud.isSignedIn === 'function' && window.Cloud.isSignedIn());
  }

  function closeDialogs() {
    var wasOpen = currentDialog;
    if (dialogOverlay) dialogOverlay.hidden = true;
    if (shareDialog) shareDialog.hidden = true;
    if (wordCountDialog) wordCountDialog.hidden = true;
    if (sourceManagerDialog) sourceManagerDialog.hidden = true;
    if (sourceEditDialog) sourceEditDialog.hidden = true;
    if (uapdfDialog) uapdfDialog.hidden = true;
    if (bibCheckDialog) bibCheckDialog.hidden = true;
    if (accessDialog) accessDialog.hidden = true;
    currentDialog = null;
    if (wasOpen) releaseTrap(wasOpen);
  }

  /* フェーズ8: コピペ検査パネル (右パネル・非モーダル。#a11y-panel と同型) */
  function closePasteCheckPanel() {
    if (pasteCheckPanel) pasteCheckPanel.hidden = true;
  }
  if (pasteCheckPanel) {
    var pcClose = document.getElementById('paste-check-close');
    if (pcClose) pcClose.addEventListener('click', closePasteCheckPanel);
  }
  var currentDialog = null;
  function openDialog(dlg) {
    if (!dlg) return;
    closeDialogs();
    if (dialogOverlay) dialogOverlay.hidden = false;
    dlg.hidden = false;
    currentDialog = dlg;
    setTrap(dlg);
  }
  function openShareDialog() {
    var docTitle = document.getElementById('doc-title');
    var name = document.getElementById('share-docname');
    if (docTitle && name) name.textContent = docTitle.textContent;
    // アクセス管理の導線はクラウド(ログイン済み)のときだけ表示する
    var entry = shareDialog && shareDialog.querySelector('.access-manage-entry');
    if (entry) entry.hidden = !cloudReady();
    openDialog(shareDialog);
  }
  // フェーズ14: アクセス管理ダイアログを開く(app.js が中身を描画)
  function openAccessDialog(docId) {
    if (!cloudReady() || !accessDialog) return;
    openDialog(accessDialog);
    if (window.App && typeof window.App.renderAccess === 'function') window.App.renderAccess(docId);
  }
  window.openAccessDialog = openAccessDialog;
  if (dialogOverlay) dialogOverlay.addEventListener('click', closeDialogs);
  document.querySelectorAll('[data-dialog-close]').forEach(function (btn) {
    btn.addEventListener('click', closeDialogs);
  });

  /* ---------- ドロップダウン開閉 ---------- */
  var dropdowns = document.querySelectorAll('.rb-dropdown');
  function closeAllDropdowns(except) {
    dropdowns.forEach(function (d) {
      if (d !== except) d.classList.remove('open');
    });
  }
  dropdowns.forEach(function (dd) {
    var toggle = dd.querySelector('.rb-drop-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = !dd.classList.contains('open');
      closeAllDropdowns();
      dd.classList.toggle('open', willOpen);
    });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.rb-dropdown')) closeAllDropdowns();
  });

  /* ---------- 表グリッドピッカー (8列 x 6行) ---------- */
  var GRID_COLS = 8, GRID_ROWS = 6;
  var picker = document.getElementById('table-grid-picker');
  var gridLabel = document.getElementById('table-grid-label');
  var cells = [];
  var kbR = 1, kbC = 1;   // キーボード選択中の位置
  if (picker) {
    picker.setAttribute('role', 'grid');
    picker.setAttribute('aria-label', '表のサイズを選択');
    picker.tabIndex = 0;
    for (var r = 1; r <= GRID_ROWS; r++) {
      var row = document.createElement('div');
      row.className = 'tg-row';
      row.setAttribute('role', 'row');
      row.style.display = 'contents';
      for (var c = 1; c <= GRID_COLS; c++) {
        var cell = document.createElement('div');
        cell.className = 'tg-cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', r + ' 行 ' + c + ' 列');
        row.appendChild(cell);
        cells.push(cell);
      }
      picker.appendChild(row);
    }
    var highlight = function (rows, cols) {
      cells.forEach(function (cell) {
        var hot = (+cell.dataset.r <= rows) && (+cell.dataset.c <= cols);
        cell.classList.toggle('hot', hot);
        cell.setAttribute('aria-selected', hot ? 'true' : 'false');
      });
      gridLabel.textContent = (rows > 0 && cols > 0)
        ? rows + ' 行 x ' + cols + ' 列'
        : '表の挿入';
    };
    picker.addEventListener('mouseover', function (e) {
      var cell = e.target.closest('.tg-cell');
      if (cell) highlight(+cell.dataset.r, +cell.dataset.c);
    });
    picker.addEventListener('mouseleave', function () { highlight(0, 0); });
    picker.addEventListener('click', function (e) {
      var cell = e.target.closest('.tg-cell');
      if (!cell) return;
      exec('insertTable', cell.dataset.r + 'x' + cell.dataset.c);
      closeAllDropdowns();
      highlight(0, 0);
    });
    picker.addEventListener('keydown', function (e) {
      var handled = true;
      if (e.key === 'ArrowRight') kbC = Math.min(GRID_COLS, kbC + 1);
      else if (e.key === 'ArrowLeft') kbC = Math.max(1, kbC - 1);
      else if (e.key === 'ArrowDown') kbR = Math.min(GRID_ROWS, kbR + 1);
      else if (e.key === 'ArrowUp') kbR = Math.max(1, kbR - 1);
      else if (e.key === 'Enter' || e.key === ' ') {
        exec('insertTable', kbR + 'x' + kbC);
        closeAllDropdowns();
        highlight(0, 0);
        handled = true;
      } else handled = false;
      if (handled) { e.preventDefault(); highlight(kbR, kbC); }
    });
    picker.addEventListener('focus', function () { highlight(kbR, kbC); });
    // ピッカーの初期化 (ドロップダウンを開くたびに呼ぶ)
    picker._resetKb = function () { kbR = 1; kbC = 1; };
  }

  /* ---------- data-command ディスパッチ ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-command]');
    if (!btn) return;
    var cmd = btn.dataset.command;
    if (cmd === 'shareOpen') {           // ui.js が処理 (SPEC: ダイアログを開くのみ)
      openShareDialog();
      return;
    }
    if (cmd === 'accessOpen') {          // フェーズ14: アクセス管理(クラウドのみ)
      openAccessDialog(btn.dataset.value || null);
      return;
    }
    if (cmd === 'accessInvite') {        // フェーズ14: 招待は app.js が処理(editor 経由不要)
      if (window.App && typeof window.App.exec === 'function') window.App.exec('accessInvite');
      return;
    }
    exec(cmd, btn.dataset.value);
    if (cmd === 'wordCount') openDialog(wordCountDialog); // 値は editor.js が埋める
    /* フェーズ3b: 資料文献ダイアログの開閉のみ (中身は Logic-3) */
    if (cmd === 'manageSources') openDialog(sourceManagerDialog);
    if (cmd === 'addSource' || cmd === 'editSource') openDialog(sourceEditDialog);
    if (cmd === 'saveSource') closeDialogs();
    /* フェーズ8: 検証機能ダイアログ (中身は bibcheck.js / pastecheck.js) */
    if (cmd === 'checkBib') openDialog(bibCheckDialog);
    if (cmd === 'checkPaste' && pasteCheckPanel) pasteCheckPanel.hidden = false;
    if (btn.closest('.rb-menu')) closeAllDropdowns();
    if (btn.closest('#backstage')) closeBackstage();
    if (btn.closest('#title-menu')) closeTitleMenu();
  });

  /* リボンボタンの mousedown で選択範囲を失わない (Word挙動) */
  document.addEventListener('mousedown', function (e) {
    var btn = e.target.closest(
      '#ribbon button, #titlebar .tb-btn, #statusbar .sb-zoom-btn, .rb-menu button, #table-grid-picker'
    );
    if (btn) e.preventDefault();
  });

  /* ---------- select / スライダー ---------- */
  var fontFamily = document.getElementById('font-family');
  var fontSize = document.getElementById('font-size');
  if (fontFamily) {
    fontFamily.addEventListener('change', function () {
      exec('fontName', fontFamily.value);
    });
  }
  if (fontSize) {
    fontSize.addEventListener('change', function () {
      exec('fontSize', fontSize.value);
    });
  }

  var bibStyle = document.getElementById('bib-style');
  if (bibStyle) {
    bibStyle.addEventListener('change', function () {
      exec('bibStyle', bibStyle.value);
    });
  }

  /* ---------- UI言語セレクタ (フェーズ11: Agent-i18n-UI) ----------
     #ui-lang-select change → I18n.setLang → I18n.apply(document)。
     起動時は保存言語 (I18n が localStorage/navigator から決定した現在値) を
     セレクタへ反映し、全 data-i18n* を適用する。
     #doc-lang-select は Agent-i18n-Doc (app.js) が配線するのでここでは触らない。 */
  (function initUiLang() {
    var sel = document.getElementById('ui-lang-select');
    if (window.I18n) {
      // 現在言語をセレクタに反映してから初回適用
      if (sel) {
        try { sel.value = window.I18n.current(); } catch (e) {}
      }
      if (sel) {
        sel.addEventListener('change', function () {
          window.I18n.setLang(sel.value);
          window.I18n.apply(document);
          // 翻訳でグループ名が変わるので toolbar aria-label / ロービングを再同期
          try { injectAria(); resetRibbonRoving(); } catch (e) {}
        });
      }
      // 起動時適用 (ja は原文へ復元されるだけなので見た目不変)
      try {
        window.I18n.apply(document);
        document.documentElement.setAttribute('lang', window.I18n.current());
      } catch (e) {}
    }
  })();

  var zoomSlider = document.getElementById('zoom-slider');
  if (zoomSlider) {
    zoomSlider.addEventListener('input', function () {
      zoomSlider.setAttribute('aria-valuetext', zoomSlider.value + '%');
      exec('zoom', zoomSlider.value);
    });
  }

  /* ---------- ルーラーの cm 数字 (飾り) ----------
     Word実機と同じく、テキスト領域(左余白 25mm)を 0 として
     右へ 1,2,3... / 左余白内は逆順に 1,2 を打つ */
  var numbers = document.querySelector('.ruler-numbers');
  if (numbers) {
    var MARGIN_MM = 25, PAGE_MM = 210;
    function addNum(mm, text) {
      var span = document.createElement('span');
      span.style.left = mm + 'mm';
      span.textContent = text;
      numbers.appendChild(span);
    }
    // テキスト領域内 (160mm = 16cm): 1〜15
    for (var cm = 1; cm <= 15; cm++) addNum(MARGIN_MM + cm * 10, cm);
    // 左右の余白内: 逆順 1,2
    for (var m = 1; m <= 2; m++) {
      addNum(MARGIN_MM - m * 10, m);
      addNum(PAGE_MM - MARGIN_MM + m * 10, m);
    }
  }

  /* ==========================================================
     フェーズ4: アクセシビリティ (ARIA 付与 / ロービング / F6 / トラップ)
     ========================================================== */

  var FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function visibleFocusable(container) {
    if (!container) return [];
    return Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE_SEL), function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  }

  /* ---------- ARIA 付与 (装飾SVG非表示 / アイコンのみボタンに aria-label) ---------- */
  function injectAria() {
    document.querySelectorAll('svg').forEach(function (s) {
      if (!s.hasAttribute('aria-hidden')) s.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll(
      '#ribbon button[title], #titlebar button[title], #statusbar button[title], .rb-menu button[title]'
    ).forEach(function (btn) {
      if (btn.hasAttribute('aria-label')) return;
      var txt = (btn.textContent || '').replace(/\s+/g, '');
      if (!txt) btn.setAttribute('aria-label', btn.getAttribute('title'));
    });
    // リボン各グループ = role=toolbar (aria-label はグループ名)
    document.querySelectorAll('.ribbon-group').forEach(function (g) {
      var label = g.querySelector('.group-label');
      g.setAttribute('role', 'toolbar');
      if (label) g.setAttribute('aria-label', label.textContent.trim());
    });
  }

  /* ---------- リボン ロービングタブインデックス ---------- */
  function panelButtons(panel) {
    if (!panel) return [];
    return Array.prototype.filter.call(panel.querySelectorAll('button'), function (b) {
      return !b.disabled && (b.offsetWidth > 0 || b.offsetHeight > 0) && !b.closest('.rb-menu');
    });
  }
  function resetRibbonRoving() {
    var panel = document.querySelector('.ribbon-panel.active');
    if (!panel) return;
    var btns = panelButtons(panel);
    btns.forEach(function (b, i) { b.tabIndex = (i === 0 ? 0 : -1); });
  }
  window.__resetRibbonRoving = resetRibbonRoving;  // activateTab から呼ぶ

  var ribbonEl = document.getElementById('ribbon');
  if (ribbonEl) {
    ribbonEl.addEventListener('keydown', function (e) {
      if (e.target.closest('.rb-menu')) return;      // メニュー内は別処理
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      var keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (keys.indexOf(e.key) < 0) return;
      var panel = document.querySelector('.ribbon-panel.active');
      var btns = panelButtons(panel);
      var cur = e.target.closest('button');
      var idx = btns.indexOf(cur);
      if (idx < 0) return;
      var ni = idx;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = Math.min(btns.length - 1, idx + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = Math.max(0, idx - 1);
      else if (e.key === 'Home') ni = 0;
      else if (e.key === 'End') ni = btns.length - 1;
      if (ni !== idx) {
        e.preventDefault();
        btns[idx].tabIndex = -1;
        btns[ni].tabIndex = 0;
        btns[ni].focus();
      }
    });
  }

  /* ---------- ドロップダウン内 矢印キー操作 ---------- */
  var openDropToggle = null;   // Esc で戻すため
  document.querySelectorAll('.rb-dropdown').forEach(function (dd) {
    var toggle = dd.querySelector('.rb-drop-toggle');
    var menu = dd.querySelector('.rb-menu');
    if (!toggle || !menu) return;
    toggle.addEventListener('click', function () {
      if (dd.classList.contains('open')) {
        openDropToggle = toggle;
        setTimeout(function () {
          var picker = menu.querySelector('#table-grid-picker');
          if (picker) { if (picker._resetKb) picker._resetKb(); picker.focus(); return; }
          var items = visibleFocusable(menu);
          if (items.length) items[0].focus();
        }, 0);
      } else {
        openDropToggle = null;
      }
    });
    menu.addEventListener('keydown', function (e) {
      if (menu.querySelector('#table-grid-picker')) return;  // グリッドは自前
      var items = visibleFocusable(menu);
      if (!items.length) return;
      var idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1 + items.length) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    });
  });
  // ドロップダウンを Esc で閉じたらトグルへフォーカスを戻す
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openDropToggle) {
      var t = openDropToggle;
      openDropToggle = null;
      setTimeout(function () { if (t && t.focus) t.focus(); }, 0);
    }
  });

  /* ---------- フォーカストラップ (ダイアログ / バックステージ) ---------- */
  var trapStack = [];
  window.setTrap = function (container) {
    if (!container) return;
    trapStack.push({ container: container, returnTo: document.activeElement });
    setTimeout(function () {
      var f = visibleFocusable(container);
      if (f.length) { try { f[0].focus(); } catch (e) {} }
      else { container.tabIndex = -1; try { container.focus(); } catch (e) {} }
    }, 0);
  };
  window.releaseTrap = function (container) {
    for (var i = trapStack.length - 1; i >= 0; i--) {
      if (trapStack[i].container === container) {
        var rt = trapStack[i].returnTo;
        trapStack.splice(i, 1);
        if (rt && rt.focus && document.contains(rt)) {
          setTimeout(function () { try { rt.focus(); } catch (e) {} }, 0);
        }
        break;
      }
    }
  };
  function topTrap() { return trapStack.length ? trapStack[trapStack.length - 1].container : null; }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var c = topTrap();
    if (!c || c.hidden) return;
    var f = visibleFocusable(c);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !c.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !c.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }, true);

  /* ---------- F6 / Shift+F6: 領域サイクル ---------- */
  function regionTargets() {
    var regs = [];
    var tabsBarEl = document.getElementById('ribbon-tabs');
    var ribbon = document.getElementById('ribbon');
    regs.push({
      containers: [tabsBarEl, ribbon],
      focus: function () {
        var t = document.querySelector('.ribbon-tab[role="tab"][aria-selected="true"]') ||
                document.querySelector('.ribbon-tab[role="tab"]');
        if (t) t.focus();
      }
    });
    var d = document.getElementById('doc');
    if (d) regs.push({ containers: [d], focus: function () { d.focus(); } });
    [['thread-panel', '.thread-card .tc-title, .thread-card, .tp-header'],
     ['version-panel', '.version-item, .vp-close'],
     ['a11y-panel', '.ap-item, .ap-close'],
     ['preview-pane', '#refresh-preview'],
     ['source-pane', '#copy-source']].forEach(function (pair) {
      var p = document.getElementById(pair[0]);
      if (p && !p.hidden) {
        regs.push({ containers: [p], focus: function () {
          var el = p.querySelector(pair[1]);
          if (el && el.focus) el.focus();
          else { p.tabIndex = -1; p.focus(); }
        } });
      }
    });
    var sb = document.getElementById('statusbar');
    if (sb) regs.push({ containers: [sb], focus: function () {
      var z = document.getElementById('zoom-slider'); if (z) z.focus();
    } });
    return regs;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'F6') return;
    if (topTrap()) return;
    e.preventDefault();
    var regs = regionTargets();
    if (!regs.length) return;
    var active = document.activeElement;
    var cur = -1;
    for (var i = 0; i < regs.length; i++) {
      if (regs[i].containers.some(function (c) { return c && c.contains(active); })) { cur = i; break; }
    }
    var next;
    if (e.shiftKey) next = (cur <= 0 ? regs.length - 1 : cur - 1);
    else next = (cur === -1 ? 0 : (cur + 1) % regs.length);
    regs[next].focus();
    if (window.A11y && window.A11y.announce) {
      var names = ['リボン', '文書'];
      window.A11y.announce('領域を移動しました');
    }
  });

  injectAria();
  resetRibbonRoving();
})();
