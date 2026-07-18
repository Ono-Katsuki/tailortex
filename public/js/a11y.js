/* ==========================================================
   a11y.js — アクセシビリティ (Agent-A11y / フェーズ4)
   window.A11y = { announce, alert, check, formatReadout, keytips }
   - スクリーンリーダー通知 (#a11y-status / #a11y-alert)
   - 書式読み上げ (Ctrl/Cmd+Alt+F)
   - KeyTips (Alt 単押し → タブ → グループ内キー)
   - アクセシビリティ チェック (#a11y-panel)
   script 順: docx.js の後・editor.js の前。editor/app には announce 呼び出しのみ追記。
   ========================================================== */
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  /* ================= aria-live 通知 ================= */

  var statusTimer = null;
  function announce(msg) {
    var el = byId('a11y-status');
    if (!el || !msg) return;
    // 同一文言でも再読み上げされるよう一旦クリアしてから設定
    el.textContent = '';
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { el.textContent = String(msg); }, 40);
  }

  var alertTimer = null;
  function alertMsg(msg) {
    var el = byId('a11y-alert');
    if (!el) return;
    el.textContent = '';
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { el.textContent = String(msg || ''); }, 40);
  }

  /* ================= 書式読み上げ ================= */

  var STYLE_LABEL = {
    normal: '標準', h1: '見出し 1', h2: '見出し 2', h3: '見出し 3',
    title: '表題', subtitle: '副題', quote: '引用文', code: 'コード'
  };
  var FF_LABEL = { serif: '游明朝', sans: '游ゴシック', mono: '等幅' };
  var ALIGN_LABEL = { left: '左揃え', center: '中央揃え', right: '右揃え', justify: '両端揃え' };

  function formatReadout() {
    if (!window.Editor || typeof window.Editor.getState !== 'function') return;
    var st = window.Editor.getState();
    var parts = [];
    parts.push('スタイル ' + (STYLE_LABEL[st.styleKey] || '標準'));
    var deco = [];
    if (st.bold) deco.push('太字');
    if (st.italic) deco.push('斜体');
    if (st.underline) deco.push('下線');
    if (st.strikethrough) deco.push('取り消し線');
    if (st.subscript) deco.push('下付き');
    if (st.superscript) deco.push('上付き');
    if (st.highlight) deco.push('蛍光ペン');
    if (st.foreColor) deco.push('フォント色');
    parts.push(deco.length ? deco.join('、') : '書式なし');
    parts.push(FF_LABEL[st.fontFamily] || st.fontFamily);
    parts.push((st.fontSize || '10.5') + ' ポイント');
    if (st.list === 'ul') parts.push('箇条書き');
    else if (st.list === 'ol') parts.push('段落番号');
    parts.push(ALIGN_LABEL[st.align] || ALIGN_LABEL.left);
    announce('書式: ' + parts.join('、'));
  }

  /* ================= アクセシビリティ チェック ================= */

  var GENERIC_LINK_TEXT = ['こちら', 'ここ', 'リンク', '詳細', 'click here', 'here', 'link', 'more'];
  var lastHighlight = null;

  function clearHighlight() {
    if (lastHighlight) {
      lastHighlight.classList.remove('a11y-jump-highlight');
      lastHighlight = null;
    }
  }
  function jumpTo(el) {
    if (!el) return;
    clearHighlight();
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    el.classList.add('a11y-jump-highlight');
    lastHighlight = el;
    setTimeout(clearHighlight, 2400);
  }

  /* ---- コントラスト計算(DOM 非依存の純関数。WCAG 2.x 相対輝度) ---- */

  // 色文字列 → {r,g,b}(0-255)。#rgb / #rrggbb / rgb() / rgba() を受理。
  // 透明(alpha=0)や解釈不能な場合は null を返す。
  function parseColor(str) {
    if (!str) return null;
    str = String(str).trim().toLowerCase();
    if (str === 'transparent') return null;
    var m;
    if ((m = str.match(/^#([0-9a-f]{3})$/))) {
      return { r: parseInt(m[1][0] + m[1][0], 16),
               g: parseInt(m[1][1] + m[1][1], 16),
               b: parseInt(m[1][2] + m[1][2], 16) };
    }
    if ((m = str.match(/^#([0-9a-f]{6})$/))) {
      return { r: parseInt(m[1].slice(0, 2), 16),
               g: parseInt(m[1].slice(2, 4), 16),
               b: parseInt(m[1].slice(4, 6), 16) };
    }
    if ((m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/))) {
      var a = (m[4] === undefined) ? 1 : parseFloat(m[4]);
      if (a === 0) return null;   // 完全透明
      return { r: +m[1], g: +m[2], b: +m[3] };
    }
    return null;
  }

  function srgbToLinear(c) {
    c = c / 255;
    return (c <= 0.03928) ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function relLuminance(rgb) {
    return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
  }
  // コントラスト比 (1〜21)。順序に依存しない。
  function contrastRatio(rgb1, rgb2) {
    var l1 = relLuminance(rgb1), l2 = relLuminance(rgb2);
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // 要素の実効背景色を祖先方向に探す(白ページ既定)。DOM 依存。
  function effectiveBg(el, root) {
    var node = el;
    while (node && node.nodeType === 1) {
      var bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg) return bg;
      if (node === root) break;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255 };   // ページ既定は白
  }

  function collectIssues() {
    var d = byId('doc');
    var issues = [];
    if (!d) return issues;

    // 0) 文書言語未設定
    //   文書言語は Editor が #doc の lang 属性に反映する(フェーズ11。既定 ja)。
    //   lang が無い/空ならスクリーンリーダーが読み上げ言語を判別できないため問題とする。
    var docLangAttr = (d.getAttribute('lang') || '').trim();
    if (!docLangAttr) {
      issues.push({ el: d, sev: 'warn', title: '文書の言語が設定されていません',
        detail: '文書の言語を指定してください。スクリーンリーダーの読み上げ言語の判定に必要です。' });
    }

    // 1) 代替テキストの無い画像
    //   alt 属性そのものが無い画像だけを問題とする。
    //   alt="" は「装飾画像として明示済み」なので問題扱いしない。
    var imgs = d.querySelectorAll('img');
    imgs.forEach(function (img) {
      if (!img.hasAttribute('alt')) {
        issues.push({ el: img.closest('figure') || img, sev: 'error',
          title: '代替テキストの無い画像',
          detail: '画像に代替テキストを追加してください。装飾目的なら alt="" を指定してください。' });
      }
    });

    // 2) 見出しレベルの飛び / 3) 空の見出し
    var heads = d.querySelectorAll('h1, h2, h3');
    var prevLevel = 0;
    heads.forEach(function (h) {
      var level = +h.nodeName.charAt(1);
      if (!(h.textContent || '').trim()) {
        issues.push({ el: h, sev: 'error', title: '空の見出し',
          detail: (h.nodeName) + ' に見出しテキストがありません。' });
      }
      if (prevLevel && level > prevLevel + 1) {
        issues.push({ el: h, sev: 'warn', title: '見出しレベルの飛び',
          detail: '見出し ' + prevLevel + ' の次に見出し ' + level + ' が使われています。' });
      }
      prevLevel = level;
    });

    // 4) ヘッダー行の無い表 / 4b) 結合セル / 4c) キャプション無し
    var tables = d.querySelectorAll('table');
    tables.forEach(function (t) {
      var firstRow = t.querySelector('tr');
      var hasHeader = t.querySelector('th') ||
        (firstRow && firstRow.querySelector('th'));
      if (!hasHeader) {
        issues.push({ el: t, sev: 'warn', title: 'ヘッダー行の無い表',
          detail: '表にヘッダー行がありません。1 行目を見出しにしてください。' });
      }
      // 結合セル(rowspan/colspan が 2 以上)はスクリーンリーダーで構造が伝わりにくい
      var merged = false;
      t.querySelectorAll('td, th').forEach(function (cell) {
        var rs = +(cell.getAttribute('rowspan') || 1);
        var cs = +(cell.getAttribute('colspan') || 1);
        if (rs > 1 || cs > 1) merged = true;
      });
      if (merged) {
        issues.push({ el: t, sev: 'warn', title: '結合セルのある表',
          detail: '結合されたセルがあります。読み上げ順が乱れるため、単純な表への分割を検討してください。' });
      }
      // キャプション(<caption>)が無い表は目的が伝わりにくい
      if (!t.querySelector('caption')) {
        issues.push({ el: t, sev: 'warn', title: 'キャプションの無い表',
          detail: '表にキャプションがありません。表の目的を示す説明を追加してください。' });
      }
    });

    // 5) リンクテキストが汎用的
    var links = d.querySelectorAll('a');
    links.forEach(function (a) {
      var txt = (a.textContent || '').trim().toLowerCase();
      if (txt && GENERIC_LINK_TEXT.indexOf(txt) !== -1) {
        issues.push({ el: a, sev: 'warn', title: 'わかりにくいリンク テキスト',
          detail: '「' + a.textContent.trim() + '」ではリンク先が伝わりません。' });
      }
    });

    // 6) コントラスト不足
    //   色を直指定している要素(インライン style の color/background、または
    //   蛍光ペン .hl / フォント色 .fc)について、実効背景との比を算出。
    //   4.5:1 未満(大テキスト=24px 以上 または 18.66px 以上の太字は 3:1 未満)を検出。
    var colored = d.querySelectorAll('[style*="color"], [style*="background"], .hl, .fc');
    var seenContrast = [];
    colored.forEach(function (el) {
      // 直接テキストを持つ要素だけ対象(空コンテナは除外)
      var hasText = false;
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && n.nodeValue.trim()) { hasText = true; break; }
      }
      if (!hasText) return;
      var cs = getComputedStyle(el);
      var fg = parseColor(cs.color);
      if (!fg) return;
      var bg = effectiveBg(el, d);
      var ratio = contrastRatio(fg, bg);
      var size = parseFloat(cs.fontSize) || 16;
      var bold = (+cs.fontWeight >= 700) || cs.fontWeight === 'bold';
      var large = (size >= 24) || (size >= 18.66 && bold);
      var threshold = large ? 3 : 4.5;
      if (ratio < threshold - 0.01) {   // 端数誤差の許容
        if (seenContrast.indexOf(el) !== -1) return;
        seenContrast.push(el);
        issues.push({ el: el, sev: 'warn', title: 'コントラスト不足',
          detail: '文字色と背景のコントラスト比が ' + ratio.toFixed(2) + ':1 で、基準の ' +
            threshold.toFixed(1) + ':1 を下回っています。' });
      }
    });

    return issues;
  }

  function check() {
    var panel = byId('a11y-panel');
    var list = byId('a11y-results');
    if (!panel || !list) return;
    var issues = collectIssues();
    list.innerHTML = '';

    if (!issues.length) {
      var ok = document.createElement('div');
      ok.className = 'ap-empty';
      ok.textContent = '検査結果: 問題は見つかりませんでした';
      list.appendChild(ok);
      announce('アクセシビリティ チェック完了。問題は見つかりませんでした');
    } else {
      var head = document.createElement('div');
      head.className = 'ap-summary';
      head.textContent = issues.length + ' 件の項目が見つかりました';
      list.appendChild(head);
      issues.forEach(function (iss) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'ap-item ap-' + iss.sev;
        item.innerHTML =
          '<span class="ap-item-title"></span><span class="ap-item-detail"></span>';
        item.querySelector('.ap-item-title').textContent = iss.title;
        item.querySelector('.ap-item-detail').textContent = iss.detail;
        item.addEventListener('click', function () { jumpTo(iss.el); });
        list.appendChild(item);
      });
      announce('アクセシビリティ チェック完了。' + issues.length + ' 件の項目が見つかりました');
    }
    ensureAxeSection();   // UI検査(axe)導線を用意
    panel.hidden = false;
    // フォーカスを結果先頭へ
    var first = list.querySelector('.ap-item') || list.querySelector('.ap-empty');
    if (first && first.focus) { try { first.focus(); } catch (e) {} }
  }

  /* ================= UI検査(axe、開発者向け) =================
     文書ではなくアプリUI全体を axe-core で検査する別枠の導線。
     axe は動的ロード(初期ロードに影響させない)。 */

  var axeLoading = null;
  function loadAxe() {
    if (window.axe) return Promise.resolve(window.axe);
    if (axeLoading) return axeLoading;
    axeLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'vendor/axe/axe.min.js';
      s.onload = function () { window.axe ? resolve(window.axe) : reject(new Error('axe unavailable')); };
      s.onerror = function () { reject(new Error('axe load failed')); };
      document.head.appendChild(s);
    });
    return axeLoading;
  }

  // #a11y-panel 内に axe 導線セクションを1度だけ挿入する。
  function ensureAxeSection() {
    var panel = byId('a11y-panel');
    if (!panel || byId('a11y-axe')) return;
    var sec = document.createElement('div');
    sec.id = 'a11y-axe';
    sec.className = 'ap-axe';
    sec.style.borderTop = '1px solid #d9d9d9';
    sec.style.marginTop = '10px';
    sec.style.paddingTop = '10px';
    sec.innerHTML =
      '<div class="ap-axe-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
        '<span class="ap-axe-title" data-i18n="a11y.axe.title" style="font-weight:600;">UI検査(axe、開発者向け)</span>' +
        '<button type="button" id="a11y-axe-run" class="ap-axe-run" data-i18n="a11y.axe.run">実行</button>' +
      '</div>' +
      '<p class="ap-axe-note" data-i18n="a11y.axe.note" style="margin:6px 0 0;font-size:.85em;opacity:.75;">' +
        '文書ではなくアプリ画面全体のアクセシビリティを検査します(文書検査とは別枠)。</p>' +
      '<div class="ap-list" id="a11y-axe-results" style="margin-top:8px;"></div>';
    panel.appendChild(sec);
    var runBtn = sec.querySelector('#a11y-axe-run');
    if (runBtn) runBtn.addEventListener('click', runAxe);
    // i18n を適用(ja は原文のまま)
    if (window.I18n && typeof window.I18n.apply === 'function') {
      try { window.I18n.apply(sec); } catch (e) {}
    }
  }

  function runAxe() {
    var out = byId('a11y-axe-results');
    var btn = byId('a11y-axe-run');
    if (!out) return;
    out.innerHTML = '';
    var busy = document.createElement('div');
    busy.className = 'ap-empty';
    busy.textContent = 'UI検査を実行中…';
    out.appendChild(busy);
    if (btn) btn.disabled = true;
    announce('UI検査(axe)を実行しています');

    loadAxe().then(function (axe) {
      return axe.run(document);
    }).then(function (results) {
      if (btn) btn.disabled = false;
      out.innerHTML = '';
      // critical / serious の違反のみ対象
      var vio = (results.violations || []).filter(function (v) {
        return v.impact === 'critical' || v.impact === 'serious';
      });
      if (!vio.length) {
        var ok = document.createElement('div');
        ok.className = 'ap-empty';
        ok.textContent = 'UI検査結果: critical / serious の違反はありません';
        out.appendChild(ok);
        announce('UI検査完了。重大な違反はありませんでした');
        return;
      }
      var nodeTotal = vio.reduce(function (a, v) { return a + (v.nodes ? v.nodes.length : 0); }, 0);
      var head = document.createElement('div');
      head.className = 'ap-summary';
      head.textContent = vio.length + ' 種類 / ' + nodeTotal + ' 箇所の違反(critical・serious)';
      out.appendChild(head);
      vio.forEach(function (v) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'ap-item ap-' + (v.impact === 'critical' ? 'error' : 'warn');
        item.innerHTML = '<span class="ap-item-title"></span><span class="ap-item-detail"></span>';
        item.querySelector('.ap-item-title').textContent =
          '[' + v.impact + '] ' + v.help + '(' + (v.nodes ? v.nodes.length : 0) + '件)';
        item.querySelector('.ap-item-detail').textContent = v.description || v.id;
        item.addEventListener('click', function () {
          var target = null;
          try {
            var sel = v.nodes && v.nodes[0] && v.nodes[0].target && v.nodes[0].target[0];
            if (sel) target = document.querySelector(sel);
          } catch (e) {}
          if (target) jumpTo(target);
        });
        out.appendChild(item);
      });
      announce('UI検査完了。' + vio.length + ' 種類の違反が見つかりました');
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      out.innerHTML = '';
      var e = document.createElement('div');
      e.className = 'ap-empty';
      e.textContent = 'UI検査を実行できませんでした(' + (err && err.message ? err.message : 'エラー') + ')';
      out.appendChild(e);
      announce('UI検査を実行できませんでした');
    });
  }

  function closePanel() {
    var panel = byId('a11y-panel');
    if (panel) panel.hidden = true;
    clearHighlight();
  }

  /* ================= KeyTips ================= */

  var TAB_TIPS = {
    F: { tab: 'file' }, H: { tab: 'home' }, N: { tab: 'insert' },
    P: { tab: 'layout' }, S: { tab: 'references' }, R: { tab: 'review' }, W: { tab: 'view' }
  };
  // グループ内: key → data-command 値 (該当ボタンを click)
  var GROUP_TIPS = {
    home: { B: 'bold', I: 'italic', U: 'underline', X: 'strikethrough',
      L: 'alignLeft', E: 'alignCenter', A: 'alignRight', J: 'alignJustify',
      1: { command: 'style', value: 'h1' }, 2: { command: 'style', value: 'h2' },
      3: { command: 'style', value: 'h3' }, C: 'copy', V: 'paste', F: 'find' },
    insert: { P: 'pageBreak', I: 'insertImage', K: 'insertLink',
      E: 'insertMath', D: 'insertDisplayMath', F: 'insertFootnote' },
    layout: { L: 'orientLandscape', T: 'orientPortrait' },
    references: { T: 'toc', F: 'insertFootnote', B: 'insertBibliography', M: 'manageSources' },
    review: { W: 'wordCount', C: 'insertComment', A: 'a11yCheck',
      N: 'nextComment', P: 'prevComment' },
    view: { Z: 'zoomReset', I: 'zoomIn', O: 'zoomOut',
      S: 'toggleSource', V: 'togglePreview', D: 'darkMode' }
  };

  var ktActive = false;
  var ktLevel = 0;         // 0 = タブ, 1 = グループ内
  var ktTab = null;

  function ktLayer() {
    var layer = byId('keytip-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'keytip-layer';
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }
    return layer;
  }
  function clearBadges() {
    var layer = byId('keytip-layer');
    if (layer) layer.innerHTML = '';
  }
  function addBadge(el, key) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    var b = document.createElement('span');
    b.className = 'keytip-badge';
    b.textContent = key;
    b.style.left = (r.left + r.width / 2) + 'px';
    b.style.top = (r.bottom - 6) + 'px';
    ktLayer().appendChild(b);
  }

  function showTabTips() {
    ktLevel = 0; ktTab = null;
    clearBadges();
    Object.keys(TAB_TIPS).forEach(function (key) {
      var t = TAB_TIPS[key];
      var el = document.querySelector('.ribbon-tab[data-tab="' + t.tab + '"]');
      addBadge(el, key);
    });
    announce('キーヒント。タブのキーを押してください');
  }

  function showGroupTips(tabName) {
    // 該当タブへ切替
    var tabBtn = document.querySelector('.ribbon-tab[data-tab="' + tabName + '"]');
    if (tabName === 'file') {
      if (tabBtn) tabBtn.click();   // バックステージを開く
      hideKeyTips();
      return;
    }
    if (tabBtn) tabBtn.click();
    ktLevel = 1; ktTab = tabName;
    clearBadges();
    var map = GROUP_TIPS[tabName] || {};
    Object.keys(map).forEach(function (key) {
      var el = findCommandButton(map[key]);
      addBadge(el, key);
    });
  }

  function findCommandButton(spec) {
    var panel = document.querySelector('.ribbon-panel.active');
    if (!panel) return null;
    if (typeof spec === 'string') {
      return panel.querySelector('[data-command="' + spec + '"]');
    }
    return panel.querySelector('[data-command="' + spec.command + '"][data-value="' + spec.value + '"]');
  }

  function showKeyTips() {
    if (ktActive) return;
    ktActive = true;
    document.body.classList.add('keytips-on');
    showTabTips();
  }
  function hideKeyTips() {
    if (!ktActive) return;
    ktActive = false;
    ktLevel = 0; ktTab = null;
    document.body.classList.remove('keytips-on');
    clearBadges();
  }
  function keytipsToggle() { if (ktActive) hideKeyTips(); else showKeyTips(); }

  function handleKeyTipKey(e) {
    if (!ktActive) return false;
    if (e.key === 'Escape') { hideKeyTips(); return true; }
    var k = (e.key || '').toUpperCase();
    if (!/^[A-Z0-9]$/.test(k)) return false;
    if (ktLevel === 0) {
      if (TAB_TIPS[k]) { e.preventDefault(); showGroupTips(TAB_TIPS[k].tab); return true; }
      return false;
    }
    // level 1
    var map = GROUP_TIPS[ktTab] || {};
    if (map[k]) {
      e.preventDefault();
      var el = findCommandButton(map[k]);
      hideKeyTips();
      if (el) el.click();
      return true;
    }
    return false;
  }

  /* ---- Alt 単押し検出 ---- */
  var altDown = false, sawOtherKey = false;
  document.addEventListener('keydown', function (e) {
    // KeyTips 表示中のキー処理を最優先
    if (ktActive && e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta') {
      if (handleKeyTipKey(e)) return;
    }
    if (e.key === 'Alt') {
      if (!altDown) { altDown = true; sawOtherKey = false; }
    } else if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Meta') {
      sawOtherKey = true;
    }
  }, true);

  document.addEventListener('keyup', function (e) {
    if (e.key === 'Alt') {
      var lone = altDown && !sawOtherKey;
      altDown = false;
      if (lone) {
        e.preventDefault();
        keytipsToggle();
      }
    }
  }, true);

  // KeyTips 表示中にどこかクリックされたら解除
  document.addEventListener('mousedown', function () { if (ktActive) hideKeyTips(); }, true);

  /* ---- 書式読み上げ ショートカット (Ctrl/Cmd+Alt+F) ---- */
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF')) {
      e.preventDefault();
      e.stopPropagation();
      formatReadout();
    }
  }, true);

  /* ---- #a11y-panel 閉じるボタン ---- */
  document.addEventListener('DOMContentLoaded', function () {
    var closeBtn = byId('a11y-panel-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
  });

  /* ---- a11yCheck コマンドを document レベルで捕捉 (Editor 非依存) ---- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-command="a11yCheck"]');
    if (btn) { check(); }
  });

  /* ================= 公開 ================= */
  window.A11y = {
    announce: announce,
    alert: alertMsg,
    check: check,
    formatReadout: formatReadout,
    keytips: { show: showKeyTips, hide: hideKeyTips, toggle: keytipsToggle },
    // DOM 非依存の純関数(単体テスト用に公開)
    _contrast: { parseColor: parseColor, ratio: contrastRatio, luminance: relLuminance }
  };
})();
