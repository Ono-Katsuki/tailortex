/* projects.js — フェーズ15: プロジェクト(ディレクトリ)モデルのサーバー API ラッパ
 * window.Projects = { available, list, create, import, open, current, meta, patch, setFolder,
 *                     remove, tree, readFile, writeFile, deleteFile, upload, rename, download }
 * すべて fetch ベース。サーバー未実装(404)/不通時は reject するので、
 * 呼び出し側(app.js)が従来 localStorage モードにフォールバックできる。
 */
(function () {
  'use strict';

  /* フェーズ19: assets.js(window.Assets)は index.html の <script src="js/assets.js">
   * で projects.js より前に読み込まれる。万一未ロードでも Assets 無しで従来動作
   * (非破壊)するため、動的注入のフォールバックのみ残す。 */
  (function ensureAssetsModule() {
    if (window.Assets) return;
    try {
      var s = document.createElement('script');
      s.src = 'js/assets.js'; s.async = false;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* 失敗しても Assets 無しで従来動作(非破壊) */ }
  })();

  var CURRENT_KEY = 'wordtex-project';   // 現在のプロジェクト id(localStorage)

  /* ===== 認証ヘッダ(app.js と同等。Cloud ログイン時のみ Bearer 付与) ===== */
  function withAuth(base) {
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

  // 不正な projectId(undefined/空)でネットワークに出ないようにする防御。
  // 呼び出しタイミングによっては現在プロジェクト未確定のことがあるため。
  function requireId(id) {
    if (!id || typeof id !== 'string') {
      var e = new Error('no_project'); e.status = 0; return e;
    }
    return null;
  }

  function jsonOrThrow(res) {
    if (!res.ok) {
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      return res.text().then(function (txt) {
        try { var j = JSON.parse(txt); err.message = j.error || err.message; } catch (e) {}
        throw err;
      }, function () { throw err; });
    }
    return res.json();
  }

  function apiGet(path) {
    return withAuth({}).then(function (h) {
      return fetch(path, { headers: h });
    });
  }

  function apiJson(method, path, body) {
    return withAuth({ 'Content-Type': 'application/json' }).then(function (h) {
      return fetch(path, { method: method, headers: h, body: body != null ? JSON.stringify(body) : undefined });
    });
  }

  /* ===== 到達性プローブ ===== */
  var _availPromise = null;
  function available(forceRecheck) {
    if (_availPromise && !forceRecheck) return _availPromise;
    _availPromise = apiGet('/projects').then(function (res) {
      // 200(JSON) なら実装済み。404/501 は未実装 → false。
      return res.ok;
    }).catch(function () { return false; });
    return _availPromise;
  }

  /* ===== 一覧 / 作成 / メタ ===== */
  function list() {
    return apiGet('/projects').then(jsonOrThrow).then(function (arr) {
      return Array.isArray(arr) ? arr : [];
    });
  }

  function create(name) {
    return apiJson('POST', '/projects', { name: name || '無題のプロジェクト' }).then(jsonOrThrow);
  }

  function importDoc(payload) {
    // payload: {name, html, bib?, comments?}
    return apiJson('POST', '/projects/import', payload || {}).then(jsonOrThrow);
  }

  function meta(id, name) {
    return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/meta', { name: name }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return true;
    });
  }

  // フェーズ26: PATCH /projects/:id で name / folder を更新。
  //   changes: {name?, folder?}。folder は '' でルート。解決値はサーバーの更新後メタ。
  function patch(id, changes) {
    var bad = requireId(id); if (bad) return Promise.reject(bad);
    return apiJson('PATCH', '/projects/' + encodeURIComponent(id), changes || {}).then(jsonOrThrow);
  }
  // フォルダのみ更新するショートカット(空文字/未指定でルートへ)。
  function setFolder(id, folder) {
    return patch(id, { folder: folder == null ? '' : String(folder) });
  }

  // フェーズ28: フォルダ名変更・フォルダごと移動。
  //   from 配下(from 自身 + `from/` 始まり)の全プロジェクトの folder を to プレフィックスへ
  //   一括で書き換える(フォルダは属性であり実体が無いため、配下プロジェクトの PATCH で実現)。
  //   1 件ずつ PATCH し、途中失敗時は中断して err.moved に成功件数を載せて reject
  //   (ロールバックはしない。再実行で続きから収束する設計)。
  //   解決値: { moved, total }。対象 0 件は { moved:0, total:0 } で resolve。
  function renameFolder(from, to) {
    from = String(from == null ? '' : from);
    to = String(to == null ? '' : to);
    if (!from) return Promise.reject(new Error('empty_from'));
    return list().then(function (arr) {
      var targets = arr.filter(function (p) {
        var f = (typeof p.folder === 'string') ? p.folder : '';
        return f === from || f.indexOf(from + '/') === 0;
      });
      var total = targets.length;
      var moved = 0;
      function step(i) {
        if (i >= targets.length) return Promise.resolve({ moved: moved, total: total });
        var p = targets[i];
        var suffix = String(p.folder).slice(from.length);   // '' か '/子…'
        var nf = to ? (to + suffix) : (suffix ? suffix.slice(1) : '');
        return setFolder(p.id, nf).then(function () {
          moved++;
          return step(i + 1);
        }, function (err) {
          err = err || new Error('patch_failed');
          err.moved = moved; err.total = total;
          throw err;
        });
      }
      return step(0);
    });
  }

  function remove(id) {
    return apiJson('DELETE', '/projects/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return true;
    });
  }

  /* ===== 現在プロジェクト(クライアント側の選択状態) ===== */
  function current() {
    try { return localStorage.getItem(CURRENT_KEY) || null; } catch (e) { return null; }
  }
  function open(id) {
    try { if (id) localStorage.setItem(CURRENT_KEY, id); } catch (e) {}
    return id;
  }
  function clearCurrent() {
    try { localStorage.removeItem(CURRENT_KEY); } catch (e) {}
  }

  /* ===== ツリー ===== */
  function tree(id) {
    var bad = requireId(id); if (bad) return Promise.reject(bad);
    return apiGet('/projects/' + encodeURIComponent(id) + '/tree').then(jsonOrThrow).then(function (arr) {
      return Array.isArray(arr) ? arr : [];
    });
  }

  /* ===== ファイル読み書き ===== */
  function fileUrl(id, path) {
    return '/projects/' + encodeURIComponent(id) + '/file?path=' + encodeURIComponent(path);
  }

  // asBlob=true でバイナリ(PDF/画像)を Blob として取得。既定はテキスト。
  function readFile(id, path, asBlob) {
    return apiGet(fileUrl(id, path)).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return asBlob ? res.blob() : res.text();
    });
  }

  // content: 文字列(生テキスト) or {base64:"..."}
  function writeFile(id, path, content) {
    var isBase64 = content && typeof content === 'object' && content.base64 != null;
    return withAuth(isBase64 ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'text/plain; charset=utf-8' }).then(function (h) {
      return fetch(fileUrl(id, path), {
        method: 'PUT',
        headers: h,
        body: isBase64 ? JSON.stringify({ base64: content.base64 }) : String(content == null ? '' : content)
      });
    }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return true;
    });
  }

  // main.html / main.tex / refs.bib をサーバー側の復旧付きトランザクションで保存する。
  function writeBundle(id, bundle) {
    var bad = requireId(id); if (bad) return Promise.reject(bad);
    return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/document-bundle', bundle || {}).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    });
  }

  function deleteFile(id, path) {
    return withAuth({}).then(function (h) {
      return fetch(fileUrl(id, path), { method: 'DELETE', headers: h });
    }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return true;
    });
  }

  /* ===== File(添付)を base64 でアップロード ===== */
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var r = String(reader.result || '');
        var comma = r.indexOf(',');
        resolve(comma >= 0 ? r.slice(comma + 1) : r);
      };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsDataURL(file);
    });
  }

  // dir は保存先フォルダ(例 "attachments")。ファイル名は file.name。
  function upload(id, dir, file) {
    var base = (dir || 'attachments').replace(/\/+$/, '');
    var name = (file && file.name) ? file.name : 'file';
    var path = base ? (base + '/' + name) : name;
    return fileToBase64(file).then(function (b64) {
      return writeFile(id, path, { base64: b64 });
    }).then(function () { return path; });
  }

  /* ===== フォルダごとの取り込み(zip を展開) =====
   * zipBlob: JSZip 等で生成した zip の Blob/ArrayBuffer/Uint8Array。
   * dir: 展開先ディレクトリ(省略時はプロジェクト直下)。
   * 生バイナリ(application/zip)で 1 回 POST する。
   * onProgress(loaded,total) はアップロード進捗(可能なら)。
   * 解決値はサーバーの {ok, path, fileCount}。
   */
  function uploadFolder(id, dir, zipBlob, onProgress) {
    var bad = requireId(id); if (bad) return Promise.reject(bad);
    var base = (dir || '').replace(/^\/+|\/+$/g, '');
    var qs = base ? ('?path=' + encodeURIComponent(base)) : '';
    var url = '/projects/' + encodeURIComponent(id) + '/upload-folder' + qs;
    return withAuth({ 'Content-Type': 'application/zip' }).then(function (h) {
      // 進捗が必要なら XHR、不要なら fetch。ここでは進捗表示のため XHR を使う。
      return new Promise(function (resolve, reject) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', url, true);
          for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) xhr.setRequestHeader(k, h[k]); }
          if (xhr.upload && typeof onProgress === 'function') {
            xhr.upload.onprogress = function (ev) {
              if (ev.lengthComputable) { try { onProgress(ev.loaded, ev.total); } catch (e) {} }
            };
          }
          xhr.onload = function () {
            var status = xhr.status;
            var txt = xhr.responseText || '';
            if (status >= 200 && status < 300) {
              try { resolve(JSON.parse(txt)); } catch (e) { resolve({ ok: true }); }
            } else {
              var err = new Error('HTTP ' + status); err.status = status;
              try { var j = JSON.parse(txt); if (j && j.error) err.message = j.message || j.error; } catch (e2) {}
              reject(err);
            }
          };
          xhr.onerror = function () { var e = new Error('network'); e.status = 0; reject(e); };
          xhr.send(zipBlob);
        } catch (e) { reject(e); }
      });
    });
  }

  /* ===== フォルダ作成(任意階層) ===== */
  function mkdir(id, path) {
    return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/mkdir', { path: path }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return true;
    });
  }

  /* ===== git バージョン管理(手動コミット) ===== */
  function status(id) {
    return apiGet('/projects/' + encodeURIComponent(id) + '/status').then(jsonOrThrow);
  }
  function commit(id, message) {
    return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/commit', { message: message }).then(jsonOrThrow);
  }
  function commits(id) {
    return apiGet('/projects/' + encodeURIComponent(id) + '/commits').then(jsonOrThrow).then(function (arr) {
      return Array.isArray(arr) ? arr : [];
    });
  }
  function restore(id, hash) {
    return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/restore', { hash: hash }).then(jsonOrThrow);
  }
  function branches(id) { return apiGet('/projects/' + encodeURIComponent(id) + '/branches').then(jsonOrThrow); }
  function createBranch(id, name) { return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/branches', { name: name }).then(jsonOrThrow); }
  function switchBranch(id, name) { return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/branches/switch', { name: name }).then(jsonOrThrow); }
  function submissions(id) { return apiGet('/projects/' + encodeURIComponent(id) + '/submissions').then(jsonOrThrow); }
  function createSubmission(id, label) { return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/submissions', { label: label }).then(jsonOrThrow); }
  function freezeSubmission(id, submissionId, payload) { return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/submissions/' + encodeURIComponent(submissionId) + '/freeze', payload || {}).then(jsonOrThrow); }

  /* ===== リネーム ===== */
  function rename(id, from, to) {
    return apiJson('POST', '/projects/' + encodeURIComponent(id) + '/rename', { from: from, to: to }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return true;
    });
  }

  /* ===== ダウンロード(zip)=====
   * サーバーが zip を返せば Blob を resolve。501(未対応)なら {clientFallback:true} を resolve。
   */
  function download(id) {
    return apiGet('/projects/' + encodeURIComponent(id) + '/download').then(function (res) {
      if (res.status === 501) return { clientFallback: true };
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.blob();
    });
  }

  window.Projects = {
    available: available,
    list: list,
    create: create,
    'import': importDoc,
    open: open,
    current: current,
    clearCurrent: clearCurrent,
    meta: meta,
    patch: patch,
    setFolder: setFolder,
    renameFolder: renameFolder,
    remove: remove,
    tree: tree,
    mkdir: mkdir,
    status: status,
    commit: commit,
    commits: commits,
    restore: restore,
    branches: branches,
    createBranch: createBranch,
    switchBranch: switchBranch,
    submissions: submissions,
    createSubmission: createSubmission,
    freezeSubmission: freezeSubmission,
    readFile: readFile,
    writeFile: writeFile,
    writeBundle: writeBundle,
    deleteFile: deleteFile,
    upload: upload,
    uploadFolder: uploadFolder,
    rename: rename,
    download: download,
    fileUrl: fileUrl,
    fileToBase64: fileToBase64
  };
})();
