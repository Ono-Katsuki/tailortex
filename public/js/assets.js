/* assets.js — フェーズ19: バイナリ資産(画像・PDF)のコンテンツアドレス保存
 *
 * window.Assets = {
 *   put(fileOrDataURL) -> Promise<{ref, sha256, ext, url, mime}>
 *   url(ref)           -> Promise<string>                     参照 → 表示可能な URL
 *   resolveToBase64(ref)-> Promise<{base64, dataUrl, mime}>   参照 → 生バイナリ(base64)
 *   resolveImgToDataUrl(img) -> Promise<dataURL>              <img> → data: URL(コンパイル用)
 *   isRef(imgOrSrc)    -> bool                                資産参照かどうか
 *   canExternalize()   -> bool                                現在のコンテキストで外部化可能か
 *   setContext(fn)     -> void                                app.js が {projectId, docId, cloud} を供給
 * }
 *
 * 参照フォーマット契約(Agent-Assets-Back と共有):
 *   資産キー = SHA-256(内容)
 *   Storage パス docs/{docId}/assets/{sha256}.{ext}(クラウド)
 *   参照文字列 asset:{docId or projectId}/{sha256}.{ext}
 *
 * 2 バックエンド(Cloud.enabled で切替):
 *   ローカル: projects/<pid>/assets/{sha}.{ext} に PUT(Projects.writeFile の base64)。
 *            url() は /projects/:id/file?path=assets/...
 *   クラウド: Firebase Storage docs/{docId}/assets/{sha}.{ext} に upload。url() は getDownloadURL。
 *
 * 最重要原則: バックエンドが無い(cloud-config.js=null かつ projectMode 外)場合、
 *   put() は reject する。呼び出し側(editor.js)は従来どおり base64 を残す(非破壊)。
 */
(function () {
  'use strict';

  /* ===== コンテキスト(app.js が供給する現在の保存先) ===== */
  var _provider = null;
  function setContext(fn) { _provider = (typeof fn === 'function') ? fn : null; }

  function cloudReady() {
    var C = window.Cloud;
    return !!(C && C.isEnabled && C.isEnabled() && C.isSignedIn && C.isSignedIn()
              && C.storage && C.storage());
  }

  function ctx() {
    var c = {};
    try { if (_provider) c = _provider() || {}; } catch (e) { c = {}; }
    var cloud = cloudReady() && !!c.docId;
    return {
      cloud: cloud,
      projectId: c.projectId || null,
      docId: c.docId || null
    };
  }

  function canExternalize() {
    var c = ctx();
    if (c.cloud) return true;
    if (c.projectId && window.Projects && window.Projects.writeFile && window.Projects.fileUrl) return true;
    return false;
  }

  /* ===== バイト列 / base64 / SHA-256 ===== */

  function bytesFromDataUrl(dataUrl) {
    var comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('bad-dataurl');
    var meta = dataUrl.slice(5, comma);               // "image/png;base64" 等("data:" の後)
    var payload = dataUrl.slice(comma + 1);
    var mime = (meta.split(';')[0] || 'application/octet-stream');
    var isB64 = /;base64/i.test(meta);
    var binStr = isB64 ? atob(payload.replace(/\s+/g, '')) : decodeURIComponent(payload);
    var bytes = new Uint8Array(binStr.length);
    for (var i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i) & 0xff;
    var base64 = isB64 ? payload.replace(/\s+/g, '') : btoa(binStr);
    return { bytes: bytes, mime: mime, base64: base64 };
  }

  function bytesToBase64(bytes) {
    var bin = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // 入力(File/Blob or dataURL 文字列) → {bytes, mime, base64}
  function toBinary(fileOrDataURL) {
    if (typeof fileOrDataURL === 'string') {
      try { return Promise.resolve(bytesFromDataUrl(fileOrDataURL)); }
      catch (e) { return Promise.reject(e); }
    }
    if (fileOrDataURL && typeof fileOrDataURL.arrayBuffer === 'function') {
      var mime = fileOrDataURL.type || 'application/octet-stream';
      return fileOrDataURL.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        return { bytes: bytes, mime: mime, base64: bytesToBase64(bytes) };
      });
    }
    return Promise.reject(new Error('unsupported-input'));
  }

  function sha256Hex(bytes) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || !subtle.digest) return Promise.reject(new Error('no-subtle-crypto'));
    return subtle.digest('SHA-256', bytes).then(function (buf) {
      var arr = new Uint8Array(buf), hex = '';
      for (var i = 0; i < arr.length; i++) {
        var h = arr[i].toString(16);
        hex += (h.length === 1 ? '0' : '') + h;
      }
      return hex;
    });
  }

  function extForMime(mime) {
    var m = String(mime || '').toLowerCase();
    if (m.indexOf('png') >= 0) return 'png';
    if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'jpg';
    if (m.indexOf('pdf') >= 0) return 'pdf';
    if (m.indexOf('gif') >= 0) return 'gif';
    if (m.indexOf('webp') >= 0) return 'webp';
    if (m.indexOf('svg') >= 0) return 'svg';
    return 'bin';
  }

  /* ===== 参照(ref)ユーティリティ ===== */

  // asset:{id}/{sha}.{ext} を分解
  function parseRef(ref) {
    var m = /^asset:([^/]+)\/(.+)$/.exec(String(ref || ''));
    if (!m) return null;
    return { id: m[1], name: m[2] };
  }

  // <img> or src 文字列が資産参照か(data: は資産化前の生 base64 とみなす)
  function isRef(imgOrSrc) {
    var src, dataAsset;
    if (imgOrSrc && imgOrSrc.getAttribute) {
      dataAsset = imgOrSrc.getAttribute('data-asset');
      src = imgOrSrc.getAttribute('src') || '';
    } else {
      src = String(imgOrSrc || '');
    }
    if (dataAsset) return true;
    if (/^data:/i.test(src)) return false;
    if (/^asset:/i.test(src)) return true;
    if (/[?&]path=assets(%2F|\/)/i.test(src)) return true;         // ローカル file API
    if (/firebasestorage\.googleapis\.com/i.test(src)) return true; // クラウド DL URL
    if (/\/o\/docs(%2F|\/)/i.test(src)) return true;
    return false;
  }

  /* ===== put(資産を保存し参照を返す。SHA-256 で重複排除) ===== */

  // 重複排除キャッシュ(sha はコンテンツアドレスなのでパスが一意 = ファイルは 1 つだけ)。
  //   同一セッション内で同じ画像を複数回 put しても書き込みは 1 回に抑える。
  var _seenLocal = {};   // pid   -> { "sha.ext": true }
  var _seenCloud = {};   // docId -> { "sha.ext": downloadURL }

  function putLocal(pid, sha, ext, bin) {
    var name = sha + '.' + ext;
    var path = 'assets/' + name;
    var ref = 'asset:' + pid + '/' + name;
    var url = window.Projects.fileUrl(pid, path);
    var result = { ref: ref, sha256: sha, ext: ext, url: url, mime: bin.mime };
    _seenLocal[pid] = _seenLocal[pid] || {};
    if (_seenLocal[pid][name]) return Promise.resolve(result);       // 重複排除(再書き込みしない)
    return window.Projects.writeFile(pid, path, { base64: bin.base64 }).then(function () {
      _seenLocal[pid][name] = true;
      return result;
    });
  }

  function putCloud(docId, sha, ext, bin) {
    var st = window.Cloud.storage();
    var name = sha + '.' + ext;
    var storagePath = 'docs/' + docId + '/assets/' + name;
    var ref = 'asset:' + docId + '/' + name;
    _seenCloud[docId] = _seenCloud[docId] || {};
    var cached = _seenCloud[docId][name];
    if (cached) {                                                     // 重複排除(再アップロードしない)
      return Promise.resolve({ ref: ref, sha256: sha, ext: ext, url: cached, mime: bin.mime });
    }
    var sref = st.ref(storagePath);
    // アップロードは同一パス(= 同一内容)への冪等な上書き。既存でも実体は 1 ファイルのまま。
    return sref.putString(bin.base64, 'base64', { contentType: bin.mime })
      .then(function () { return sref.getDownloadURL(); })
      .then(function (url) {
        _seenCloud[docId][name] = url;
        return { ref: ref, sha256: sha, ext: ext, url: url, mime: bin.mime };
      });
  }

  function put(fileOrDataURL) {
    var c = ctx();
    if (!c.cloud && !(c.projectId && window.Projects && window.Projects.writeFile)) {
      return Promise.reject(new Error('no-backend'));
    }
    var bin;
    return toBinary(fileOrDataURL).then(function (b) {
      bin = b;
      return sha256Hex(b.bytes);
    }).then(function (sha) {
      var ext = extForMime(bin.mime);
      return c.cloud ? putCloud(c.docId, sha, ext, bin) : putLocal(c.projectId, sha, ext, bin);
    });
  }

  /* ===== url / 解決 ===== */

  function url(ref) {
    // 既に URL 形式(asset: でない)ならそのまま返す(idempotent)
    if (typeof ref === 'string' && ref && !/^asset:/i.test(ref)) return Promise.resolve(ref);
    var p = parseRef(ref);
    if (!p) return Promise.reject(new Error('bad-ref'));
    if (cloudReady()) {
      try {
        return window.Cloud.storage().ref('docs/' + p.id + '/assets/' + p.name).getDownloadURL();
      } catch (e) { return Promise.reject(e); }
    }
    if (window.Projects && window.Projects.fileUrl) {
      return Promise.resolve(window.Projects.fileUrl(p.id, 'assets/' + p.name));
    }
    return Promise.reject(new Error('no-backend'));
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error || new Error('read-failed')); };
      fr.readAsDataURL(blob);
    });
  }

  function fetchAsDataUrl(u) {
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(blobToDataUrl);
  }

  function resolveToBase64(ref) {
    return url(ref).then(fetchAsDataUrl).then(function (dataUrl) {
      var comma = dataUrl.indexOf(',');
      var semi = dataUrl.indexOf(';');
      return {
        dataUrl: dataUrl,
        base64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
        mime: (semi > 5) ? dataUrl.slice(5, semi) : 'application/octet-stream'
      };
    });
  }

  // <img> をコンパイル用の data: URL へ解決。data-asset(正準参照)を優先、
  // 無ければ src(既に URL)を直接取得。data: URL ならそのまま返す(未移行の旧文書)。
  function resolveImgToDataUrl(img) {
    if (!img || !img.getAttribute) return Promise.reject(new Error('no-img'));
    var dataAsset = img.getAttribute('data-asset');
    var src = img.getAttribute('src') || '';
    if (/^data:/i.test(src)) return Promise.resolve(src);
    if (dataAsset && /^asset:/i.test(dataAsset)) return url(dataAsset).then(fetchAsDataUrl);
    if (/^asset:/i.test(src)) return url(src).then(fetchAsDataUrl);
    if (src) return fetchAsDataUrl(src);
    return Promise.reject(new Error('no-src'));
  }

  window.Assets = {
    setContext: setContext,
    canExternalize: canExternalize,
    put: put,
    url: url,
    resolveToBase64: resolveToBase64,
    resolveImgToDataUrl: resolveImgToDataUrl,
    isRef: isRef,
    _parseRef: parseRef
  };
})();
