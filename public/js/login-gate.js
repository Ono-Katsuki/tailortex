/* login-gate.js — フェーズ24: クラウド配信時のログインゲート
 *
 * デプロイ版(Firebase Hosting 等、非ローカルのクラウドモード)では、Google
 * ログインが完了するまで #login-gate で編集 UI を覆う。ローカル開発
 * (localhost/プライベートIP/.local)・エミュレータ・ローカルモード
 * (FIREBASE_CONFIG=null)では一切何もしない(フェーズ20 の LAN iPad も対象外)。
 * データ保護は Firestore/Storage ルールと compile-service のトークン検証が担い、
 * 本ゲートは UX 層(バイパスされても書き込みは不可)。
 * デバッグ: URL に ?force-login-gate を付けるとローカルでも強制表示。
 */
(function () {
  'use strict';

  function isPrivateHost(h) {
    if (!h) return true;
    if (h === 'localhost' || h === '::1') return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    if (/\.local$/.test(h)) return true;
    return false;
  }

  function gateNeeded() {
    if (/(^|[?&])force-login-gate(&|=|$)/.test(location.search)) return true;
    var cfg = window.FIREBASE_CONFIG;
    if (!cfg || typeof cfg !== 'object') return false;   // ローカルモード
    if (cfg.useEmulator) return false;                    // エミュレータ検証
    return !isPrivateHost(location.hostname);
  }

  if (!gateNeeded()) return;

  var gate = document.getElementById('login-gate');
  var btn = document.getElementById('login-gate-btn');
  if (!gate || !btn) return;

  var prevFocus = null;

  function show() {
    if (!gate.hidden) return;
    prevFocus = document.activeElement;
    gate.hidden = false;
    document.body.classList.add('login-gated');
    if (window.A11y && A11y.announce) A11y.announce('ご利用にはログインが必要です');
    try { btn.focus(); } catch (e) { /* ignore */ }
  }

  function hide() {
    if (gate.hidden) return;
    gate.hidden = true;
    document.body.classList.remove('login-gated');
    if (window.A11y && A11y.announce) A11y.announce('ログインしました');
    var doc = document.getElementById('doc');
    try { (prevFocus && prevFocus.focus) ? prevFocus.focus() : (doc && doc.focus()); } catch (e) { /* ignore */ }
  }

  // 初期状態はゲート表示(Firebase のセッション復元は非同期のため、復元完了時に
  // onAuthChange で閉じる。ログイン済みユーザーには一瞬ゲートが見えるが許容)。
  show();

  btn.addEventListener('click', function () {
    if (window.Cloud && typeof Cloud.signIn === 'function') Cloud.signIn();
  });

  // Tab をゲート内に閉じ込める(フォーカス可能要素はボタン1つの最小トラップ)。
  gate.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') { e.preventDefault(); btn.focus(); }
  });

  // app.js 等の初期化が後からフォーカスを奪う(#doc への focus 等)ため、
  // ゲート表示中に外へ出たフォーカスはボタンへ引き戻す。
  document.addEventListener('focusin', function (e) {
    if (!gate.hidden && !gate.contains(e.target)) {
      try { btn.focus(); } catch (err) { /* ignore */ }
    }
  });
  document.addEventListener('DOMContentLoaded', function () {
    if (!gate.hidden) { try { btn.focus(); } catch (err) { /* ignore */ } }
  });

  function bindAuth() {
    if (window.Cloud && typeof Cloud.onAuthChange === 'function') {
      Cloud.onAuthChange(function (user) { if (user) hide(); else show(); });
      // すでにサインイン済みの状態で登録が遅れた場合の取りこぼし
      if (typeof Cloud.isSignedIn === 'function' && Cloud.isSignedIn()) hide();
      return true;
    }
    return false;
  }
  // store.js(window.Cloud)より前に実行された場合に備えてリトライ
  if (!bindAuth()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (bindAuth() || ++tries > 100) clearInterval(iv);
    }, 100);
  }
})();
