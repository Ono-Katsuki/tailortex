/*
 * TailorTeX — cloud compilation service
 *
 * Cloud Run 上で動くコンパイルサービス。既存 server.js の /compile・
 * /compile-accessible 相当を Express 不使用(node 標準 http)で実装し、
 * Firebase Authentication の IDトークンを firebase-admin で検証する。
 *
 * ルート:
 *   POST /compile            latexmk -xelatex で PDF を返す(要認証)
 *   POST /compile-accessible LuaLaTeX + PDF/UA でタグ付きPDF(要認証)
 *   GET  /admin/users        listUsers(要 superadmin)
 *   POST /admin/users        setCustomUserClaims でロール変更(要 superadmin)
 *   POST /claim-invites      自分のメール宛 invite を回収し docs.access に uid 追加(要認証)
 *   GET  /healthz            ヘルスチェック(認証不要)
 *
 * 認証: すべての /compile 系・/admin 系は `Authorization: Bearer <IDトークン>`
 *       を要求。未認証は 401。/admin はさらにトークンの role==superadmin が必須。
 *
 * 開発モード:
 *   - CLOUD_COMPILE_DEV=1        トークン検証をスタブ(任意の Bearer を許可、
 *                               "superadmin" を含むトークンは superadmin 扱い)。
 *                               firebase-admin を初期化せずローカル検証できる。
 *   - FIREBASE_AUTH_EMULATOR_HOST 指定時は firebase-admin がエミュレータの
 *                               トークンを検証する(admin SDK が自動対応)。
 *
 * 環境変数:
 *   FIREBASE_PROJECT_ID  admin SDK / トークン検証に使うプロジェクトID
 *   PORT                 待受ポート(Cloud Run は 8080 を渡す。既定 8080)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOT = __dirname;
// Cloud Run のコンテナ FS は /tmp のみ書込可。作業ディレクトリは OS の tmp 配下。
const WORK_DIR = path.join(os.tmpdir(), 'wll-work');
const MAX_BODY = 10 * 1024 * 1024; // 10MB(SPEC: 1リクエスト10MB制限)
const COMPILE_TIMEOUT_MS = 30 * 1000; // SPEC: 30秒
const STEP_TIMEOUT_MS = 45 * 1000;
const LOG_TAIL = 8000;
const DEV = process.env.CLOUD_COMPILE_DEV === '1';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// ---------------------------------------------------------------------------
// firebase-admin(DEV モードでは遅延・省略)
// ---------------------------------------------------------------------------

let admin = null;
function getAdmin() {
  if (admin) return admin;
  // eslint-disable-next-line global-require
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: PROJECT_ID || undefined,
    });
  }
  return admin;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// asset 名のサニタイズ(server.js と同一ロジック)
function sanitizeAssetName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

// フェーズ10e(多層防御): openin_any=p が効かない TeX ビルドに備え、コンパイル前に
//   LaTeX ソースのファイル読み書き系コマンドが絶対パス(/・~)や親参照(..)を指す
//   場合を拒否する。正常文書は imgN.ext / refs 等の相対参照のみのため影響しない。
const FILE_ACCESS_CMDS = [
  'input', 'include', 'includeonly', 'subfile', 'subfileinclude', 'subimport', 'import',
  'InputIfFileExists', 'IfFileExists', 'lstinputlisting', 'verbatiminput', 'VerbatimInput',
  'includegraphics', 'graphicspath', 'usepackage', 'RequirePackage', 'LoadClass', 'documentclass',
  'bibliography', 'addbibresource', 'addglobalbib', 'href', 'externaldocument',
];
function isBadPathToken(p) {
  p = String(p).trim();
  if (!p) return false;
  if (p.charAt(0) === '/' || p.charAt(0) === '~') return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return true;
  return false;
}
function latexFileAccessViolation(latex) {
  const src = String(latex == null ? '' : latex);
  const cmdAlt = FILE_ACCESS_CMDS.join('|');
  const re = new RegExp('\\\\(?:' + cmdAlt + ')\\b\\s*(?:\\[[^\\]]*\\])?\\s*(\\{[^{}]*\\}|[^\\s{\\\\%]+)', 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let arg = m[1];
    if (arg.charAt(0) === '{') arg = arg.slice(1, -1);
    for (const part of arg.split(',')) if (isBadPathToken(part)) return true;
  }
  const prim = /\\(?:openin|openout|read|write)(?![a-zA-Z])[^\n{}%]*?=\s*("?)([^\s"}%]+)/g;
  while ((m = prim.exec(src)) !== null) { if (isBadPathToken(m[2])) return true; }
  if (/\\(?:input|include|openin)\b\s+(\/[^\s{}%]+|~[^\s{}%]*|\.\.[\\/][^\s{}%]*)/.test(src)) return true;
  return false;
}

function getBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : null;
}

// IDトークンを検証し、デコード済みトークン(claims)を返す。失敗は null。
async function verifyToken(req) {
  const token = getBearer(req);
  if (!token) return null;
  if (DEV) {
    // 開発モード: 検証をスタブ。トークン文字列に "superadmin" を含めば superadmin。
    const role = /superadmin/i.test(token) ? 'superadmin' : 'user';
    return { uid: 'dev-' + token.slice(0, 8), email: 'dev@example.com', role, _dev: true };
  }
  try {
    const decoded = await getAdmin().auth().verifyIdToken(token);
    return decoded;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// コンパイルジョブ直列化(server.js と同じキュー)
// ---------------------------------------------------------------------------

let compiling = false;
let pending = null;

function enqueueJob(job, res) {
  if (compiling) {
    if (pending) sendJson(pending.res, 409, { error: 'superseded' });
    pending = { job, res };
    return;
  }
  startJob(job, res);
}

function startJob(job, res) {
  compiling = true;
  job(res, function finish() {
    compiling = false;
    if (pending) {
      const next = pending;
      pending = null;
      startJob(next.job, next.res);
    }
  });
}

// ---------------------------------------------------------------------------
// 通常コンパイル(latexmk -xelatex)
// ---------------------------------------------------------------------------

function writeAssets(payload) {
  // 例外は呼び出し側で捕捉。bad_request は文字列 reason を throw。
  fs.mkdirSync(WORK_DIR, { recursive: true });
  let hasBib = false;
  if (payload.assets != null) {
    if (!Array.isArray(payload.assets)) throw new BadRequest('assets must be an array');
    for (const asset of payload.assets) {
      if (!asset || typeof asset !== 'object') throw new BadRequest('invalid asset entry');
      const name = sanitizeAssetName(asset.name);
      if (!name) throw new BadRequest('invalid asset name');
      if (typeof asset.base64 !== 'string') throw new BadRequest('invalid asset base64');
      fs.writeFileSync(path.join(WORK_DIR, name), Buffer.from(asset.base64, 'base64'));
      if (name === 'refs.bib') hasBib = true;
    }
  }
  for (const ext of ['pdf', 'aux', 'bbl', 'blg', 'log', 'out', 'toc', 'lof', 'lot', 'fls', 'fdb_latexmk', 'xdv', 'run.xml']) {
    try { fs.unlinkSync(path.join(WORK_DIR, 'doc.' + ext)); } catch (e) { /* ignore */ }
  }
  fs.writeFileSync(path.join(WORK_DIR, 'doc.tex'), payload.latex, 'utf8');
  return hasBib;
}

class BadRequest extends Error {}

function runCompile(payload, res, finish) {
  const done = (fn) => {
    try { fn(); } catch (e) {
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
    }
    finish();
  };

  try {
    writeAssets(payload);
  } catch (e) {
    if (e instanceof BadRequest) return done(() => sendJson(res, 400, { error: 'bad_request', message: e.message }));
    return done(() => sendJson(res, 500, { error: 'internal', message: String(e && e.message) }));
  }

  // フェーズ10e: openin_any/openout_any=p(paranoid)で TeX の任意ファイル
  //   読み書きを封じる(絶対パス・`..`・隠しファイル拒否)。入出力に WORK_DIR の
  //   絶対パスを渡しているため、TEXMFOUTPUT=WORK_DIR で作業ディレクトリ配下のみ
  //   例外的に許可する。-shell-escape は引き続き付けない(制限モード維持)。
  const env = Object.assign({}, process.env, {
    PATH: (process.env.PATH || '') + ':/Library/TeX/texbin:/usr/local/texlive/bin/x86_64-linux',
    openin_any: 'p',
    openout_any: 'p',
    TEXMFOUTPUT: WORK_DIR,
  });

  const child = spawn(
    'latexmk',
    ['-xelatex', '-interaction=nonstopmode', '-halt-on-error', '-output-directory=' + WORK_DIR, path.join(WORK_DIR, 'doc.tex')],
    { cwd: WORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let timedOut = false;
  let settled = false;

  child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
  child.stderr.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }, COMPILE_TIMEOUT_MS);

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(() => sendJson(res, 500, { error: 'internal', message: 'latexmk spawn failed: ' + err.message }));
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);

    if (timedOut) return done(() => sendJson(res, 500, { error: 'timeout' }));

    const pdfPath = path.join(WORK_DIR, 'doc.pdf');
    if (code === 0 && fs.existsSync(pdfPath)) {
      return done(() => {
        const pdf = fs.readFileSync(pdfPath);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdf.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(pdf);
      });
    }

    let log = stdout;
    try { log = fs.readFileSync(path.join(WORK_DIR, 'doc.log'), 'utf8'); } catch (e) { /* fall back */ }
    return done(() => sendJson(res, 422, { error: 'compile_failed', log: String(log).slice(-LOG_TAIL) }));
  });
}

// ---------------------------------------------------------------------------
// アクセシブルPDF(LuaLaTeX + PDF/UA、server.js の移植)
// ---------------------------------------------------------------------------

function runStep(cmd, args, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, opts);
    } catch (e) {
      return resolve({ ran: false, enoent: true, error: String(e && e.message), ms: Date.now() - t0, out: '' });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }, STEP_TIMEOUT_MS);
    if (child.stdout) child.stdout.on('data', (d) => { out += d; if (out.length > 300000) out = out.slice(-150000); });
    if (child.stderr) child.stderr.on('data', (d) => { out += d; if (out.length > 300000) out = out.slice(-150000); });
    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ran: false, enoent: !!(err && err.code === 'ENOENT'), error: err.message, ms: Date.now() - t0, out });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ran: true, code, timedOut, ms: Date.now() - t0, out });
    });
  });
}

async function runAccessibleCompile(payload, res, finish) {
  const steps = [];
  const done = (status, obj) => {
    try { if (!res.writableEnded) sendJson(res, status, obj); } catch (e) {
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
    }
    finish();
  };

  // フェーズ10e: paranoid モード(上の /compile と同様の封じ込め)
  const env = Object.assign({}, process.env, {
    PATH: (process.env.PATH || '') + ':/Library/TeX/texbin:/usr/local/texlive/bin/x86_64-linux:/opt/homebrew/bin:/usr/local/bin',
    openin_any: 'p',
    openout_any: 'p',
    TEXMFOUTPUT: WORK_DIR,
  });

  let hasBib = false;
  try {
    hasBib = writeAssets(payload);
    const tableAlts = Array.isArray(payload.tableAlts) ? payload.tableAlts.map(String) : [];
    const figureAlts = Array.isArray(payload.figureAlts) ? payload.figureAlts.map(String) : [];
    fs.writeFileSync(path.join(WORK_DIR, 'alts.json'), JSON.stringify({ tables: tableAlts, figures: figureAlts }), 'utf8');
  } catch (e) {
    if (e instanceof BadRequest) return done(400, { error: 'bad_request', message: e.message });
    return done(500, { error: 'internal', message: String(e && e.message) });
  }

  const pdfPath = path.join(WORK_DIR, 'doc.pdf');
  const luaArgs = ['-output-directory=' + WORK_DIR, '-interaction=nonstopmode', path.join(WORK_DIR, 'doc.tex')];
  const spawnOpts = { cwd: WORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] };

  try {
    const r1 = await runStep('lualatex', luaArgs, spawnOpts);
    if (r1.enoent) return done(500, { error: 'lualatex_missing', message: 'lualatex not found in PATH', steps });
    steps.push({ name: 'lualatex', ok: fs.existsSync(pdfPath), ms: r1.ms });

    if (hasBib) {
      const rb = await runStep('bibtex', ['doc'], { cwd: WORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
      steps.push({ name: 'bibtex', ok: rb.ran && rb.code === 0, skipped: !!rb.enoent, ms: rb.ms });
      const rl2 = await runStep('lualatex', luaArgs, spawnOpts);
      steps.push({ name: 'lualatex-2', ok: rl2.ran, ms: rl2.ms });
      const rl3 = await runStep('lualatex', luaArgs, spawnOpts);
      steps.push({ name: 'lualatex-3', ok: rl3.ran, ms: rl3.ms });
    }

    if (!fs.existsSync(pdfPath)) {
      let log = r1.out;
      try { log = fs.readFileSync(path.join(WORK_DIR, 'doc.log'), 'utf8'); } catch (e) { /* fall back */ }
      return done(422, { error: 'compile_failed', log: String(log).slice(-LOG_TAIL), steps });
    }

    const injectScript = path.join(SCRIPTS_DIR, 'inject_alt.py');
    const ri = await runStep('python3', [injectScript, pdfPath, path.join(WORK_DIR, 'alts.json')],
      { cwd: WORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (ri.enoent) {
      steps.push({ name: 'inject_alt', ok: true, skipped: true, ms: ri.ms, note: 'python3 not found' });
    } else {
      const skipped = ri.ran && ri.code === 3;
      steps.push({ name: 'inject_alt', ok: ri.ran && ri.code === 0, skipped: skipped, ms: ri.ms });
    }

    const verapdf = { ran: false, pass: null, failedClauses: [] };
    const rv = await runStep('verapdf', ['-f', 'ua2', '--format', 'mrr', pdfPath],
      { cwd: WORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (rv.enoent) {
      steps.push({ name: 'verapdf', ok: true, skipped: true, ms: rv.ms, note: 'verapdf not found' });
    } else {
      verapdf.ran = true;
      const mrr = rv.out || '';
      if (/isCompliant=/.test(mrr)) {
        verapdf.pass = /isCompliant="true"/.test(mrr);
      } else {
        verapdf.pass = rv.ran ? rv.code === 0 : null;
      }
      const seen = {};
      const re = /<rule[^>]*status="failed"[^>]*>/g;
      let m;
      while ((m = re.exec(mrr)) !== null) {
        const cl = /clause="([^"]*)"/.exec(m[0]);
        const tn = /testNumber="([^"]*)"/.exec(m[0]);
        const key = (cl ? cl[1] : '?') + '-' + (tn ? tn[1] : '?');
        if (!seen[key]) { seen[key] = true; verapdf.failedClauses.push(key); }
      }
      steps.push({ name: 'verapdf', ok: rv.ran, ms: rv.ms });
    }

    const pdf = fs.readFileSync(pdfPath);
    return done(200, { pdf: pdf.toString('base64'), verapdf: verapdf, steps: steps });
  } catch (e) {
    return done(500, { error: 'internal', message: String(e && e.message), steps });
  }
}

// ---------------------------------------------------------------------------
// 管理 API(/admin/users)— superadmin トークン必須
// ---------------------------------------------------------------------------

// 管理操作を adminLogs コレクションに記録(admin SDK 経由)。失敗は握りつぶす。
async function writeAdminLog(actor, action, detail) {
  if (DEV) return; // DEV モードでは Firestore に触れない
  try {
    const a = getAdmin();
    await a.firestore().collection('adminLogs').add({
      actorUid: actor.uid || null,
      actorEmail: actor.email || null,
      action: String(action),
      detail: detail || {},
      at: a.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('adminLog write failed:', e && e.message);
  }
}

async function handleAdminUsersList(req, res, actor) {
  if (DEV) {
    return sendJson(res, 200, {
      users: [{ uid: actor.uid, email: actor.email, role: actor.role || 'superadmin', disabled: false }],
      dev: true,
    });
  }
  try {
    const a = getAdmin();
    const result = await a.auth().listUsers(1000);
    const users = result.users.map((u) => ({
      uid: u.uid,
      email: u.email || null,
      displayName: u.displayName || null,
      disabled: u.disabled,
      lastSignInTime: (u.metadata && u.metadata.lastSignInTime) || null,
      creationTime: (u.metadata && u.metadata.creationTime) || null,
      role: (u.customClaims && u.customClaims.role) || 'user',
    }));
    await writeAdminLog(actor, 'listUsers', { count: users.length });
    return sendJson(res, 200, { users });
  } catch (e) {
    return sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
  }
}

async function handleAdminUsersSetRole(req, res, actor, payload) {
  const uid = payload && typeof payload.uid === 'string' ? payload.uid : null;
  const role = payload && typeof payload.role === 'string' ? payload.role : null;
  if (!uid || (role !== 'superadmin' && role !== 'user')) {
    return sendJson(res, 400, { error: 'bad_request', message: 'uid and role(superadmin|user) required' });
  }
  if (DEV) {
    return sendJson(res, 200, { ok: true, uid, role, dev: true });
  }
  try {
    const a = getAdmin();
    // role==user は claim を消す(role キー削除)。superadmin はセット。
    const claims = role === 'superadmin' ? { role: 'superadmin' } : {};
    await a.auth().setCustomUserClaims(uid, claims);
    await writeAdminLog(actor, 'setRole', { targetUid: uid, role });
    return sendJson(res, 200, { ok: true, uid, role });
  } catch (e) {
    return sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
  }
}

// ---------------------------------------------------------------------------
// 招待回収(/claim-invites)— 認証済みユーザー本人のメール宛 invite を回収し、
//   該当 docs の access に自分の uid を追加、invite を削除、adminLogs に記録する。
//   admin SDK 経由なので Firestore ルールを迂回して安全に付与できる。
//
//   invites コレクション(フラット): { docId, email, role, invitedBy, ts }
//   role は 'owner'|'editor'|'commenter'|'viewer'(既定 viewer)。
// ---------------------------------------------------------------------------

const VALID_ROLES = ['owner', 'editor', 'commenter', 'viewer'];

async function handleClaimInvites(req, res, actor) {
  const email = actor && actor.email ? String(actor.email) : null;
  const uid = actor && actor.uid ? String(actor.uid) : null;
  if (!email || !uid) {
    return sendJson(res, 400, { error: 'bad_request', message: 'token must carry uid and email' });
  }
  if (DEV) {
    // DEV は Firestore に触れない。呼び出し導線の疎通確認用に空の結果を返す。
    return sendJson(res, 200, { ok: true, claimed: [], dev: true });
  }
  try {
    const a = getAdmin();
    const db = a.firestore();
    const snap = await db.collection('invites').where('email', '==', email).get();
    const claimed = [];
    for (const inv of snap.docs) {
      const data = inv.data() || {};
      const docId = data.docId ? String(data.docId) : null;
      let role = data.role ? String(data.role) : 'viewer';
      if (VALID_ROLES.indexOf(role) === -1) role = 'viewer';
      if (!docId) {
        // docId 欠損の不正 invite は削除して次へ
        try { await inv.ref.delete(); } catch (e) { /* ignore */ }
        continue;
      }
      const docRef = db.collection('docs').doc(docId);
      const result = await db.runTransaction(async (tx) => {
        const docSnap = await tx.get(docRef);
        if (!docSnap.exists) {
          // 対象文書が無ければ invite を削除するだけ
          tx.delete(inv.ref);
          return null;
        }
        const d = docSnap.data() || {};
        const access = Object.assign({}, d.access || {});
        // owner を降格させない(招待が owner 未満なら既存 owner を維持)
        if (access[uid] !== 'owner') {
          access[uid] = role;
        }
        const memberUids = Array.isArray(d.memberUids) ? d.memberUids.slice() : [];
        if (memberUids.indexOf(uid) === -1) memberUids.push(uid);
        tx.update(docRef, { access: access, memberUids: memberUids });
        tx.delete(inv.ref);
        return { docId: docId, role: access[uid] };
      });
      if (result) claimed.push(result);
    }
    await writeAdminLog(actor, 'claimInvites', { email: email, uid: uid, count: claimed.length });
    return sendJson(res, 200, { ok: true, claimed: claimed });
  } catch (e) {
    return sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
  }
}

// ---------------------------------------------------------------------------
// リクエストボディ読み取り
// ---------------------------------------------------------------------------

function readJsonBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      aborted = true;
      sendJson(res, 413, { error: 'payload_too_large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      sendJson(res, 400, { error: 'bad_request', message: 'invalid JSON' });
      return;
    }
    cb(payload);
  });
  req.on('error', () => { aborted = true; });
}

// ---------------------------------------------------------------------------
// サーバ
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // CORS プリフライト
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '3600',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && urlPath === '/healthz') {
    return sendJson(res, 200, { ok: true, dev: DEV, projectId: PROJECT_ID || null });
  }

  // ---- 認証必須ルート ----
  if (urlPath === '/compile' || urlPath === '/compile-accessible' ||
      urlPath === '/admin/users' || urlPath === '/claim-invites') {
    verifyToken(req).then((claims) => {
      if (!claims) return sendJson(res, 401, { error: 'unauthorized', message: 'valid Bearer ID token required' });

      // 招待回収: 認証済みなら誰でも(自分宛 invite のみ回収する)
      if (urlPath === '/claim-invites') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        return handleClaimInvites(req, res, claims);
      }

      // /admin は superadmin 必須
      if (urlPath === '/admin/users') {
        if (claims.role !== 'superadmin') {
          return sendJson(res, 403, { error: 'forbidden', message: 'superadmin role required' });
        }
        if (req.method === 'GET') return handleAdminUsersList(req, res, claims);
        if (req.method === 'POST') {
          return readJsonBody(req, res, (payload) => handleAdminUsersSetRole(req, res, claims, payload));
        }
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }

      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

      if (urlPath === '/compile') {
        return readJsonBody(req, res, (payload) => {
          if (!payload || typeof payload.latex !== 'string' || payload.latex.length === 0) {
            return sendJson(res, 400, { error: 'bad_request', message: 'latex (string) is required' });
          }
          if (latexFileAccessViolation(payload.latex)) {
            return sendJson(res, 400, { error: 'forbidden_path', message: 'absolute path / parent-directory file access is not allowed' });
          }
          enqueueJob((jobRes, finish) => runCompile(payload, jobRes, finish), res);
        });
      }

      if (urlPath === '/compile-accessible') {
        return readJsonBody(req, res, (payload) => {
          if (!payload || typeof payload.latex !== 'string' || payload.latex.length === 0) {
            return sendJson(res, 400, { error: 'bad_request', message: 'latex (string) is required' });
          }
          if (latexFileAccessViolation(payload.latex)) {
            return sendJson(res, 400, { error: 'forbidden_path', message: 'absolute path / parent-directory file access is not allowed' });
          }
          enqueueJob((jobRes, finish) => runAccessibleCompile(payload, jobRes, finish), res);
        });
      }
    }).catch((e) => {
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`word-latex-compile listening on :${PORT} (dev=${DEV}, projectId=${PROJECT_ID || 'unset'})`);
});

module.exports = { server };
