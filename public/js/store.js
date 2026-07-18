/* store.js — 文書永続化アダプタ + クラウド(Firebase)コントローラ (フェーズ7)
 *
 * 最重要原則: cloud-config.js(window.FIREBASE_CONFIG)が無い環境では、
 *   ローカルモードの挙動を 1 バイトも変えない。
 *   - LocalStore は既存 app.js の localStorage 永続化(キー wordtex-docs /
 *     wordtex-current、データ形式そのまま)と完全に同一の読み書きを行う。
 *   - Firebase SDK は cloud-config.js が有効なときだけ動的ロードし、初期化する。
 *
 * 公開:
 *   window.Store  = { LocalStore, createLocal() }
 *   window.Cloud  = クラウド制御(config が無ければ enabled:false のスタブ)
 *
 * 契約(LocalStore / FirestoreStore 共通インターフェース):
 *   loadAll()            -> {store:{id:entry}, currentId} を返す
 *                           (Local は同期で返す。Firestore は Promise を返す)
 *   saveAll(store, cur)  -> 現在状態を保存(Local=全体 blob、Firestore=現在文書)
 *   putDoc(id, entry)    -> 1 文書を保存
 *   removeDoc(id)        -> 1 文書を削除
 *   setCurrentId(id)     -> 現在文書 id を保存
 *   subscribe(cb)        -> 変更購読(unsubscribe 関数を返す)。Local は no-op。
 *   dispose()            -> 後始末
 */
(function () {
  'use strict';

  var DOCS_KEY = 'wordtex-docs';       // 既存キー(変更禁止)
  var CURRENT_KEY = 'wordtex-current'; // 既存キー(変更禁止)

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  /* ===================================================================
     LocalStore — 既存 localStorage 永続化と完全同一(非破壊の要)
     =================================================================== */
  function LocalStore() { this.mode = 'local'; }

  LocalStore.prototype.loadAll = function () {
    var store = {};
    var raw = safeGet(DOCS_KEY);
    if (raw) {
      try { var p = JSON.parse(raw); if (p && typeof p === 'object') store = p; } catch (e) { }
    }
    return { store: store, currentId: safeGet(CURRENT_KEY) };
  };
  LocalStore.prototype.saveAll = function (store, currentId) {
    safeSet(DOCS_KEY, JSON.stringify(store));
    if (currentId) safeSet(CURRENT_KEY, currentId);
  };
  // putDoc / removeDoc は saveAll の全体 blob 書き込みで賄われるため no-op。
  LocalStore.prototype.putDoc = function () { return Promise.resolve(); };
  LocalStore.prototype.removeDoc = function () { return Promise.resolve(); };
  LocalStore.prototype.setCurrentId = function (id) { if (id) safeSet(CURRENT_KEY, id); };
  LocalStore.prototype.subscribe = function () { return function () { }; };
  LocalStore.prototype.dispose = function () { };

  /* ===================================================================
     FirestoreStore — Firebase(compat)版。config 有効時のみ生成される。
     =================================================================== */
  var ACCESS_ROLES = ['owner', 'editor', 'commenter', 'viewer'];
  function normalizeRole(r) { return ACCESS_ROLES.indexOf(r) >= 0 ? r : 'viewer'; }

  function FirestoreStore(opts) {
    this.mode = 'cloud';
    this.uid = opts.uid;
    this.db = opts.db;                 // firebase.firestore()
    this.col = this.db.collection('docs');
    this._unsub = null;
    this._seen = {};                   // 既知の docId(作成/更新の判別に使用・フェーズ14)
  }

  // firebase.firestore.FieldValue へのアクセス(クラウド時のみ利用される)
  FirestoreStore.prototype._fv = function () {
    var fb = window.firebase;
    return fb && fb.firestore && fb.firestore.FieldValue;
  };

  // app entry -> Firestore ドキュメント(本文フィールドのみ。
  // ownerUid / access / memberUids は作成時のみ _creationMeta で付与し、
  // 更新(editor 保存など)では触らない — access 変更を owner 限定にするルールと両立させる)
  // フェーズ19: 前提 — e.html は画像を base64 で埋め込まない(assets.js が Storage 参照へ
  //   置換済み)。app.js の移行(externalizeDocImages)が保存前に data:image を外部化するため、
  //   ここでの html は常に小さく Firestore の 1MB/doc 上限に当たらない。
  FirestoreStore.prototype._toDoc = function (id, e) {
    return {
      title: e.title || '',
      html: e.html || '',
      comments: e.comments || {},
      options: e.options || { margin: 'normal', landscape: false, toc: false },
      bib: e.bib || [],
      bibStyle: e.bibStyle || 'plain',
      updatedAt: e.updatedAt || new Date().toISOString(),
      charCount: e.charCount || 0,
      collaborators: e.collaborators || [],
      deleted: false
    };
  };

  // 作成時に一度だけ付与するメタ(所有者・アクセスマップ・メンバー一覧)
  FirestoreStore.prototype._creationMeta = function () {
    var meta = { ownerUid: this.uid, memberUids: [this.uid], createdAt: new Date().toISOString() };
    meta.access = {}; meta.access[this.uid] = 'owner';
    return meta;
  };

  // 1 文書の書き込み。未知の id は新規作成としてメタを付与する。
  FirestoreStore.prototype._writeDoc = function (id, entry) {
    var data = this._toDoc(id, entry);
    if (!this._seen[id]) {
      var meta = this._creationMeta();
      for (var k in meta) data[k] = meta[k];
      this._seen[id] = true;
    }
    return this.col.doc(id).set(data, { merge: true });
  };
  // Firestore ドキュメント -> app entry
  FirestoreStore.prototype._toEntry = function (d) {
    return {
      title: d.title || '', html: d.html || '', comments: d.comments || {},
      options: d.options || { margin: 'normal', landscape: false, toc: false },
      bib: Array.isArray(d.bib) ? d.bib : [], bibStyle: d.bibStyle || 'plain',
      updatedAt: d.updatedAt || new Date().toISOString(), charCount: d.charCount || 0,
      collaborators: Array.isArray(d.collaborators) ? d.collaborators : []
    };
  };

  FirestoreStore.prototype.loadAll = function () {
    var self = this;
    var store = {};
    var emptySnap = function () { return { forEach: function () { } }; };
    // フェーズ14: memberUids array-contains で共有文書も取得。
    // 旧データ(memberUids 未設定の owner 文書)も拾えるよう ownerUid クエリも併用。
    var qOwner = self.col.where('ownerUid', '==', self.uid).get().catch(emptySnap);
    var qMember = self.col.where('memberUids', 'array-contains', self.uid).get().catch(emptySnap);
    return Promise.all([qOwner, qMember, self.db.collection('users').doc(self.uid).get().catch(function () { return null; })])
      .then(function (res) {
        [res[0], res[1]].forEach(function (snap) {
          snap.forEach(function (docSnap) {
            var d = docSnap.data() || {};
            self._seen[docSnap.id] = true;
            if (d.deleted) return;
            store[docSnap.id] = self._toEntry(d);
            // 旧 owner 文書に access / memberUids を後付け(非破壊のためベストエフォート)
            if (d.ownerUid === self.uid &&
                (!Array.isArray(d.memberUids) || !d.access || !d.access[self.uid])) {
              self._backfillAccess(docSnap.id, d);
            }
          });
        });
        var currentId = null;
        if (res[2] && res[2].exists) { var u = res[2].data() || {}; currentId = u.currentDoc || null; }
        return { store: store, currentId: currentId };
      });
  };

  // 旧文書に access / memberUids を補完(所有者としての自分だけ)。ベストエフォート。
  FirestoreStore.prototype._backfillAccess = function (id, d) {
    var fv = this._fv();
    var upd = {};
    if (!d.access || !d.access[this.uid]) { upd['access.' + this.uid] = 'owner'; }
    if (fv) { upd.memberUids = fv.arrayUnion(this.uid); }
    if (!Object.keys(upd).length) return;
    this.col.doc(id).update(upd).catch(function () { });
  };

  FirestoreStore.prototype.saveAll = function (store, currentId) {
    var self = this;
    var tasks = [];
    if (currentId && store[currentId]) {
      tasks.push(self._writeDoc(currentId, store[currentId]));
    }
    if (currentId) {
      tasks.push(self.db.collection('users').doc(self.uid).set({ currentDoc: currentId }, { merge: true }));
    }
    return Promise.all(tasks).catch(function (e) { console.warn('[cloud] saveAll', e); });
  };

  FirestoreStore.prototype.putDoc = function (id, entry) {
    return this._writeDoc(id, entry)
      .catch(function (e) { console.warn('[cloud] putDoc', e); });
  };
  FirestoreStore.prototype.removeDoc = function (id) {
    // ソフト削除(admin から復元・監査できるように)
    return this.col.doc(id).set({ deleted: true, updatedAt: new Date().toISOString() }, { merge: true })
      .catch(function (e) { console.warn('[cloud] removeDoc', e); });
  };
  FirestoreStore.prototype.setCurrentId = function (id) {
    if (!id) return Promise.resolve();
    return this.db.collection('users').doc(this.uid).set({ currentDoc: id }, { merge: true })
      .catch(function () { });
  };

  // 既存ローカル文書をクラウドへ移行(未登録 id のみ)。
  FirestoreStore.prototype.migrateFrom = function (localStore) {
    var self = this;
    var ids = Object.keys(localStore || {});
    if (!ids.length) return Promise.resolve(0);
    var tasks = ids.map(function (id) {
      return self.col.doc(id).get().then(function (snap) {
        if (snap && snap.exists) { self._seen[id] = true; return null; }  // 既にある
        return self._writeDoc(id, localStore[id]);                        // 新規: 作成メタ付与
      }).catch(function () { });
    });
    return Promise.all(tasks).then(function () { return ids.length; });
  };

  FirestoreStore.prototype.subscribe = function (cb) {
    var self = this;
    try {
      // フェーズ14: 自分がメンバーの文書(owner 含む)を購読
      this._unsub = this.col.where('memberUids', 'array-contains', this.uid)
        .onSnapshot(function (snap) {
          var store = {};
          snap.forEach(function (docSnap) {
            var d = docSnap.data() || {};
            self._seen[docSnap.id] = true;
            if (d.deleted) return;
            store[docSnap.id] = self._toEntry(d);
          });
          try { cb(store); } catch (e) { }
        }, function (e) { console.warn('[cloud] subscribe', e); });
    } catch (e) { this._unsub = null; }
    return this._unsub || function () { };
  };
  FirestoreStore.prototype.dispose = function () {
    if (this._unsub) { try { this._unsub(); } catch (e) { } this._unsub = null; }
  };

  /* ================= フェーズ14: ユーザー単位の権限 ================= */

  // 招待の格納先: フラット collection invites/{docId_emailKey}
  // (firestore.rules と Cloud Run /claim-invites がこの構造・フィールドを前提)
  FirestoreStore.prototype._emailKey = function (email) {
    return String(email || '').trim().toLowerCase();
  };
  FirestoreStore.prototype._invitesCol = function () {
    return this.db.collection('invites');
  };
  FirestoreStore.prototype._inviteId = function (docId, email) {
    // Firestore doc id に使えない文字(/ 等)を避けてキー化
    return docId + '_' + this._emailKey(email).replace(/[^a-z0-9._-]/g, '_');
  };

  // access マップ + 招待中(pending)を解決して返す。
  // 各 uid のメールは users/{uid}.email を引く。
  FirestoreStore.prototype.listAccess = function (docId) {
    var self = this;
    return self.col.doc(docId).get().then(function (snap) {
      var d = snap && snap.exists ? (snap.data() || {}) : {};
      var access = d.access || {};
      var uids = Object.keys(access);
      var memberP = uids.map(function (uid) {
        return self.db.collection('users').doc(uid).get()
          .then(function (us) {
            var u = us && us.exists ? (us.data() || {}) : {};
            var email = u.email || (u.profile && u.profile.email) || '';
            return { uid: uid, role: access[uid], email: email, self: uid === self.uid };
          })
          .catch(function () { return { uid: uid, role: access[uid], email: '', self: uid === self.uid }; });
      });
      var pendingP = self._invitesCol().where('docId', '==', docId).get()
        .then(function (isnap) {
          var pending = [];
          isnap.forEach(function (s) { var i = s.data() || {}; pending.push({ email: i.email || s.id, role: i.role || 'viewer' }); });
          return pending;
        })
        .catch(function () { return []; });
      return Promise.all([Promise.all(memberP), pendingP]).then(function (r) {
        return { ownerUid: d.ownerUid || '', members: r[0], pending: r[1] };
      });
    });
  };

  // メールで招待。invitee がログインすると _claimInvites で access に回収される。
  FirestoreStore.prototype.invite = function (docId, email, role) {
    var key = this._emailKey(email);
    if (!key || key.indexOf('@') < 0) return Promise.reject(new Error('invalid_email'));
    var rec = {
      email: key,
      role: normalizeRole(role),
      docId: docId,
      invitedBy: this.uid,
      ts: new Date().toISOString()
    };
    return this._invitesCol().doc(this._inviteId(docId, key)).set(rec);
  };

  // 既存メンバーのロール変更(owner 権限が必要 — ルールで強制)
  FirestoreStore.prototype.setRole = function (docId, uid, role) {
    var upd = {};
    upd['access.' + uid] = normalizeRole(role);
    return this.col.doc(docId).update(upd);
  };

  // メンバーの削除(access と memberUids から除去)
  FirestoreStore.prototype.revoke = function (docId, uid) {
    var fv = this._fv();
    var upd = {};
    if (fv) {
      upd['access.' + uid] = fv.delete();
      upd.memberUids = fv.arrayRemove(uid);
    }
    if (!Object.keys(upd).length) return Promise.resolve();
    return this.col.doc(docId).update(upd);
  };

  // 招待中(まだ回収されていない)エントリの取り消し
  FirestoreStore.prototype.revokeInvite = function (docId, email) {
    return this._invitesCol().doc(this._inviteId(docId, email)).delete();
  };

  /* ===================================================================
     Cloud コントローラ — 認証・切替・管理コンソール
     config が無ければ enabled:false のスタブとして振る舞う。
     =================================================================== */
  var Cloud = {
    enabled: false,
    ready: false,
    user: null,
    _superadmin: false,
    _claimed: false,
    _authCbs: [],
    _fb: null,        // firebase namespace
    _auth: null,
    _db: null,
    _storage: null,   // フェーズ19: firebase.storage()(compat)。バイナリ資産用。
    _cfg: null,

    isEnabled: function () { return this.enabled; },
    isSignedIn: function () { return !!this.user; },
    isSuperAdmin: function () { return !!this._superadmin; },
    currentUser: function () { return this.user; },
    // フェーズ19: Assets(assets.js)がクラウド資産の保存先として参照する。
    storage: function () { return this._storage; },

    onAuthChange: function (cb) { if (typeof cb === 'function') this._authCbs.push(cb); },
    _emit: function () {
      var self = this;
      this._authCbs.forEach(function (cb) { try { cb(self.user); } catch (e) { } });
      this._renderAuthBtn();
      this._syncAdminNav();
    },

    signIn: function () {
      if (!this._auth || !this._fb) return;
      var provider = new this._fb.auth.GoogleAuthProvider();
      var auth = this._auth;
      // popup を既定にしつつ、モバイル Safari 等で popup が使えない場合は
      // 全画面 redirect にフォールバック(authDomain が配信ドメインと同一なら
      // redirect も第一者ストレージで完結する)。
      auth.signInWithPopup(provider).catch(function (e) {
        var code = e && e.code;
        console.warn('[cloud] signIn', code);
        if (code === 'auth/popup-blocked' ||
            code === 'auth/operation-not-supported-in-this-environment' ||
            code === 'auth/cancelled-popup-request' ||
            code === 'auth/internal-error') {
          auth.signInWithRedirect(provider).catch(function (e2) {
            console.warn('[cloud] signInRedirect', e2 && e2.code);
          });
        }
      });
    },
    signOut: function () {
      if (!this._auth) return;
      this._auth.signOut().catch(function () { });
    },

    /* ---- 認証ボタン(#auth-btn)描画。最小限。 ---- */
    _renderAuthBtn: function () {
      var btn = document.getElementById('auth-btn');
      if (!btn) return;
      btn.hidden = false;
      var u = this.user;
      if (u) {
        var label = u.displayName || u.email || 'アカウント';
        var initial = (label.charAt(0) || '?').toUpperCase();
        var avatar = u.photoURL
          ? '<img class="auth-avatar" src="' + u.photoURL + '" alt="" referrerpolicy="no-referrer">'
          : '<span class="auth-avatar auth-avatar-initial">' + initial + '</span>';
        btn.innerHTML = avatar + '<span class="auth-name">' + escapeHtml(label) + '</span>';
        btn.setAttribute('aria-label', label + ' — クリックでログアウト');
        btn.title = label + '(クリックでログアウト)';
      } else {
        btn.innerHTML = '<svg class="auth-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">'
          + '<circle cx="8" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/>'
          + '<path d="M2.5 14c.7-3 3-4.5 5.5-4.5S12.8 11 13.5 14" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
          + '<span class="auth-name">ログイン</span>';
        btn.setAttribute('aria-label', 'Google でログイン');
        btn.title = 'Google でログイン';
      }
    },

    _syncAdminNav: function () {
      // ui.js 側のフックがあれば任せる。無くてもここで最低限トグル。
      var nav = document.querySelector('#backstage .bs-nav-item[data-bs-view="admin"]');
      if (nav) nav.hidden = !this.isSuperAdmin();
    },

    /* ---- 管理コンソール描画(superadmin 用) ---- */
    renderAdmin: function () {
      if (!this._db || !this.isSuperAdmin()) return;
      var self = this;
      var db = this._db;
      Promise.all([
        db.collection('users').get().catch(function () { return null; }),
        db.collection('docs').get().catch(function () { return null; })
      ]).then(function (r) {
        var usersSnap = r[0], docsSnap = r[1];
        var users = [], docs = [], docCountByUid = {};
        if (usersSnap) usersSnap.forEach(function (s) { users.push({ id: s.id, d: s.data() || {} }); });
        if (docsSnap) docsSnap.forEach(function (s) {
          var d = s.data() || {}; docs.push({ id: s.id, d: d });
          if (d.ownerUid) docCountByUid[d.ownerUid] = (docCountByUid[d.ownerUid] || 0) + 1;
        });
        setText('adm-users', users.length);
        setText('adm-docs', docs.filter(function (x) { return !x.d.deleted; }).length);
        self._loadTodayCompiles();
        self._renderUserTable(users, docCountByUid);
        self._renderDocTable(docs);
      });
    },

    _loadTodayCompiles: function () {
      var el = document.getElementById('adm-compiles');
      if (!el) return;
      // adminLogs / compiles を集計(無ければ '-')
      if (!this._db) { el.textContent = '-'; return; }
      var start = new Date(); start.setHours(0, 0, 0, 0);
      this._db.collection('adminLogs')
        .where('action', '==', 'compile')
        .where('ts', '>=', start.toISOString())
        .get()
        .then(function (s) { el.textContent = s.size; })
        .catch(function () { el.textContent = '-'; });
    },

    _renderUserTable: function (users, docCountByUid) {
      var tb = document.getElementById('admin-user-list');
      if (!tb) return;
      var self = this;
      if (!users.length) { tb.innerHTML = '<tr><td colspan="4">ユーザーがいません</td></tr>'; return; }
      tb.innerHTML = users.map(function (u) {
        var d = u.d;
        var email = d.email || d.profile && d.profile.email || u.id;
        var last = d.lastLogin || (d.profile && d.profile.lastLogin) || '';
        var role = d.role || 'user';
        var n = docCountByUid[u.id] || 0;
        return '<tr data-uid="' + u.id + '">'
          + '<td>' + escapeHtml(email) + '</td>'
          + '<td>' + escapeHtml(relTime(last)) + '</td>'
          + '<td>' + n + '</td>'
          + '<td><select class="admin-role-select" data-uid="' + u.id + '">'
          + '<option value="user"' + (role === 'user' ? ' selected' : '') + '>user</option>'
          + '<option value="superadmin"' + (role === 'superadmin' ? ' selected' : '') + '>superadmin</option>'
          + '</select></td></tr>';
      }).join('');
      tb.querySelectorAll('.admin-role-select').forEach(function (sel) {
        sel.addEventListener('change', function () { self._setRole(sel.dataset.uid, sel.value); });
      });
    },

    _renderDocTable: function (docs) {
      var tb = document.getElementById('admin-doc-list');
      if (!tb) return;
      var self = this;
      this._allDocs = docs;
      var q = (document.getElementById('admin-doc-search') || {}).value || '';
      var filtered = docs.filter(function (x) {
        if (!q) return true;
        return (x.d.title || '').toLowerCase().indexOf(q.toLowerCase()) >= 0
          || x.id.indexOf(q) >= 0;
      });
      if (!filtered.length) { tb.innerHTML = '<tr><td colspan="4">文書がありません</td></tr>'; return; }
      tb.innerHTML = filtered.map(function (x) {
        var d = x.d;
        return '<tr data-id="' + x.id + '"' + (d.deleted ? ' class="is-deleted"' : '') + '>'
          + '<td>' + escapeHtml(d.title || '(無題)') + (d.deleted ? ' <em>(削除済)</em>' : '') + '</td>'
          + '<td>' + escapeHtml((d.ownerUid || '').slice(0, 10)) + '</td>'
          + '<td>' + escapeHtml(relTime(d.updatedAt)) + '</td>'
          + '<td><button class="admin-doc-view" data-id="' + x.id + '">閲覧</button>'
          + ' <button class="admin-doc-access" data-id="' + x.id + '">アクセス</button>'
          + ' <button class="admin-doc-del" data-id="' + x.id + '">削除</button></td></tr>';
      }).join('');
      tb.querySelectorAll('.admin-doc-view').forEach(function (b) {
        b.addEventListener('click', function () { self._viewDoc(b.dataset.id); });
      });
      tb.querySelectorAll('.admin-doc-access').forEach(function (b) {
        b.addEventListener('click', function () {
          if (window.App && typeof window.App.openAccessFor === 'function') window.App.openAccessFor(b.dataset.id);
        });
      });
      tb.querySelectorAll('.admin-doc-del').forEach(function (b) {
        b.addEventListener('click', function () {
          if (window.confirm('この文書を削除しますか?')) self._deleteDoc(b.dataset.id);
        });
      });
    },

    _viewDoc: function (id) {
      var self = this;
      this._db.collection('docs').doc(id).get().then(function (s) {
        if (!s.exists) return;
        var d = s.data() || {};
        window.alert('文書: ' + (d.title || '(無題)') + '\nowner: ' + (d.ownerUid || '') + '\n\n'
          + (d.html || '').replace(/<[^>]+>/g, '').slice(0, 400));
      });
    },
    _deleteDoc: function (id) {
      var self = this;
      this._db.collection('docs').doc(id).set({ deleted: true }, { merge: true }).then(function () {
        self._log('deleteDoc', { docId: id });
        self.renderAdmin();
      }).catch(function (e) { window.alert('削除に失敗しました: ' + e); });
    },

    _setRole: function (uid, role) {
      var self = this;
      var base = this._cfg && (this._cfg.adminApiBase || this._cfg.compileUrl);
      var apply = function (token) {
        if (!base) {
          // Cloud Run 未設定: Firestore の role フィールドのみ更新(claim は別途 set-admin.js)
          self._db.collection('users').doc(uid).set({ role: role }, { merge: true })
            .then(function () { self._log('setRole', { uid: uid, role: role, viaApi: false }); });
          return;
        }
        fetch(base.replace(/\/$/, '') + '/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ uid: uid, role: role })
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          self._log('setRole', { uid: uid, role: role, viaApi: true });
        }).catch(function (e) { window.alert('ロール変更に失敗しました: ' + e); });
      };
      if (this._auth && this._auth.currentUser) this._auth.currentUser.getIdToken().then(apply);
      else apply(null);
    },

    _log: function (action, extra) {
      if (!this._db) return;
      var rec = { action: action, ts: new Date().toISOString(), by: this.user && this.user.uid };
      if (extra) for (var k in extra) rec[k] = extra[k];
      this._db.collection('adminLogs').add(rec).catch(function () { });
    },

    /* 現在の Firebase IDトークン(コンパイルサービス呼び出し用) */
    getIdToken: function () {
      if (this._auth && this._auth.currentUser) return this._auth.currentUser.getIdToken();
      return Promise.resolve(null);
    },
    getStore: function () {
      if (!this._db || !this.user) return null;
      return new FirestoreStore({ uid: this.user.uid, db: this._db });
    },

    /* ---- フェーズ14: 自分宛の招待を回収 ----
       方式は firestore.rules 側の実装に合わせる。不明時の両対応の防御:
       まず Cloud Run の /claim-invites を試し、404 等なら
       クライアントで invitees を読んで access に追記する(緩いルール/エミュレータ向け)。*/
    _claimInvites: function () {
      var self = this;
      if (!this._db || !this.user) return Promise.resolve();
      var email = (this.user.email || '').toLowerCase();
      if (!email) return Promise.resolve();
      var base = this._cfg && (this._cfg.claimUrl || this._cfg.compileUrl || this._cfg.adminApiBase);

      var viaApi = function () {
        if (!base) return Promise.reject(new Error('no-base'));
        return self.getIdToken().then(function (token) {
          if (!token) throw new Error('no-token');
          return fetch(base.replace(/\/$/, '') + '/claim-invites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: '{}'
          }).then(function (r) {
            if (r.status === 404) throw new Error('no-endpoint');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return true;
          });
        });
      };

      var viaClient = function () {
        var fv = self._fb && self._fb.firestore && self._fb.firestore.FieldValue;
        return self._db.collection('invites').where('email', '==', email).get()
          .then(function (snap) {
            var tasks = [];
            snap.forEach(function (s) {
              var inv = s.data() || {};
              var docId = inv.docId;
              if (!docId) return;
              var upd = {};
              upd['access.' + self.user.uid] = inv.role || 'viewer';
              if (fv) upd.memberUids = fv.arrayUnion(self.user.uid);
              tasks.push(
                self._db.collection('docs').doc(docId).update(upd)
                  .then(function () { return s.ref.delete().catch(function () { }); })
                  .catch(function () { })
              );
            });
            return Promise.all(tasks);
          });
      };

      return viaApi().catch(function () { return viaClient(); }).catch(function () { });
    },

    /* ---- 初期化(config 有効時のみ)---- */
    _init: function (cfg) {
      var self = this;
      this._cfg = cfg;
      loadFirebaseScripts(cfg).then(function () {
        var fb = window.firebase;
        if (!fb || !fb.initializeApp) { console.warn('[cloud] firebase SDK load failed'); return; }
        self._fb = fb;
        try { fb.initializeApp(cfg); } catch (e) { /* 既に初期化済 */ }
        self._auth = fb.auth();
        self._db = fb.firestore();
        // フェーズ19: Storage(compat)。SDK ロード済みなら初期化(資産アップロード用)。
        try { if (fb.storage) self._storage = fb.storage(); } catch (e) { self._storage = null; }
        if (cfg.useEmulator) {
          try { self._auth.useEmulator('http://127.0.0.1:9099'); } catch (e) { }
          try { self._db.useEmulator('127.0.0.1', 8080); } catch (e) { }
          try { if (self._storage) self._storage.useEmulator('127.0.0.1', 9199); } catch (e) { }
        }
        self.enabled = true;
        self.ready = true;
        self._renderAuthBtn();
        var btn = document.getElementById('auth-btn');
        if (btn) btn.addEventListener('click', function () {
          if (self.user) { if (window.confirm('ログアウトしますか?')) self.signOut(); }
          else self.signIn();
        });
        var search = document.getElementById('admin-doc-search');
        if (search) search.addEventListener('input', function () {
          if (self._allDocs) self._renderDocTable(self._allDocs);
        });
        // onIdTokenChanged: サインイン/アウトに加えトークン更新でも発火するため、
        // set-admin.js での権限付与が再ログインなしで(トークン更新時に)反映される
        self._auth.onIdTokenChanged(function (user) {
          self.user = user || null;
          self._superadmin = false;
          if (user) {
            // profile / lastLogin を Firestore に反映
            self._db.collection('users').doc(user.uid).set({
              profile: { email: user.email || '', displayName: user.displayName || '' },
              email: user.email || '',
              lastLogin: new Date().toISOString()
            }, { merge: true }).catch(function () { });
            // フェーズ14: ログイン時に自分宛の招待を回収(ベストエフォート・1回のみ)
            if (!self._claimed) { self._claimed = true; try { self._claimInvites(); } catch (e) { } }
            user.getIdTokenResult().then(function (res) {
              self._superadmin = !!(res && res.claims && res.claims.role === 'superadmin');
              self._emit();
            }).catch(function () { self._emit(); });
          } else {
            self._claimed = false;
            self._emit();
          }
        });
      });
    }
  };

  /* ---- ユーティリティ ---- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = String(v); }
  function relTime(iso) {
    if (!iso) return '-';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return String(iso);
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return '今';
    if (s < 3600) return Math.floor(s / 60) + '分前';
    if (s < 86400) return Math.floor(s / 3600) + '時間前';
    if (s < 2592000) return Math.floor(s / 86400) + '日前';
    return new Date(iso).toLocaleDateString('ja-JP');
  }

  // firebase compat スクリプトを必要時にだけ動的ロード(ローカルモードでは読まない)
  var _fbLoaded = null;
  function loadFirebaseScripts(cfg) {
    if (_fbLoaded) return _fbLoaded;
    var base = (cfg && cfg.vendorBase) || 'vendor/firebase/';
    // フェーズ19: storage-compat を追加(バイナリ資産を Firebase Storage へ)。
    var files = ['firebase-app-compat.js', 'firebase-auth-compat.js',
                 'firebase-firestore-compat.js', 'firebase-storage-compat.js'];
    _fbLoaded = files.reduce(function (p, f) {
      return p.then(function () { return loadScript(base + f); });
    }, Promise.resolve());
    return _fbLoaded;
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('load fail ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ===== 公開 ===== */
  window.Store = {
    LocalStore: LocalStore,
    FirestoreStore: FirestoreStore,
    createLocal: function () { return new LocalStore(); }
  };
  window.Cloud = Cloud;

  // cloud-config.js があり FIREBASE_CONFIG が有効なときだけクラウドを初期化
  var cfg = window.FIREBASE_CONFIG;
  if (cfg && typeof cfg === 'object' && (cfg.apiKey || cfg.projectId || cfg.useEmulator)) {
    try { Cloud._init(cfg); } catch (e) { console.warn('[cloud] init failed', e); }
  }
})();
