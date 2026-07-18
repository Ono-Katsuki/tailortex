/*
 * TailorTeX — local server
 * Node.js 標準ライブラリのみ。ポート3000で public/ を静的配信し、
 * POST /compile で latexmk (xelatex) により PDF を生成して返す。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const WORK_DIR = path.join(ROOT, 'work');
const MAX_BODY = 50 * 1024 * 1024; // 50MB
const COMPILE_TIMEOUT_MS = 30 * 1000;
const LOG_TAIL = 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// フェーズ21: Windows 対応のプラットフォーム抽象化
//   darwin では従来コードパスを一切変えない(win32 側を分岐で足すだけ)。
//   process.platform をあちこちで直読みせず、ここに定数と
//   「コマンド解決・PATH連結・スポーン・強制終了・予約名判定」のヘルパーを集約する。
// ---------------------------------------------------------------------------
const IS_WIN = process.platform === 'win32';

function dirExists(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// win32 の TeX Live 既定 bin(C:\texlive\<year>\bin\windows。複数年に対応)を走査。
function winTexlivePaths(env) {
  env = env || process.env;
  const out = [];
  const root = (env.SystemDrive || 'C:') + '\\texlive';
  let years = [];
  try {
    years = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) { /* TeX Live 未導入 */ }
  for (const y of years) out.push(path.join(root, y, 'bin', 'windows'));
  return out;
}

// TeX/関連ツールの追加 PATH をプラットフォーム別に解決する。
//   darwin: 現行どおり /Library/TeX/texbin(アクセシブルPDFは +/opt/homebrew/bin)を
//     存在チェックせずそのまま追加(従来挙動を維持)。
//   win32: TeX Live 既定 + MiKTeX 既定(%LOCALAPPDATA% / Program Files)のうち
//     実在するものだけ追加。無ければ PATH 任せ。
//   isWin/env は既定 IS_WIN/process.env(ユニットテストで win32 相当を注入可能)。
function texPathExtras(includeHomebrew, isWin, env) {
  if (isWin === undefined) isWin = IS_WIN;
  env = env || process.env;
  if (isWin) {
    const cands = winTexlivePaths(env);
    const la = env.LOCALAPPDATA;
    if (la) cands.push(path.join(la, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
    cands.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'MiKTeX', 'miktex', 'bin', 'x64'));
    return cands.filter(dirExists);
  }
  const extras = ['/Library/TeX/texbin'];
  if (includeHomebrew) extras.push('/opt/homebrew/bin');
  return extras;
}

// 既存 PATH に追加パスを path.delimiter で連結(':' 直書きの排除)。
function buildPath(extras, curPath, delim) {
  const cur = (curPath !== undefined ? curPath : (process.env.PATH || ''));
  const d = delim || path.delimiter;
  const add = (extras || []).filter(Boolean);
  if (add.length === 0) return cur;
  return cur + (cur ? d : '') + add.join(d);
}

// spawn 引数のプラットフォーム解決。全 spawn/spawnSync に windowsHide を付与し、
// win32 で .bat/.cmd を直接起動できない問題を回避するため cmd.exe /d /s /c 経由に
// 変換する(各引数を "" で明示クオート。対象引数はサーバー管理下のパスのみ)。
//   返り値: { cmd, args, opts, wrapped }
function quoteWinArg(a) { return '"' + String(a).replace(/"/g, '""') + '"'; }
function resolveSpawn(cmd, args, opts, isWin) {
  if (isWin === undefined) isWin = IS_WIN;
  const o = Object.assign({ windowsHide: true }, opts || {});
  if (isWin && /\.(bat|cmd)$/i.test(cmd)) {
    const line = ['/d', '/s', '/c'].concat([cmd].concat(args || []).map(quoteWinArg));
    return { cmd: process.env.ComSpec || 'cmd.exe', args: line, opts: Object.assign({}, o, { windowsVerbatimArguments: true }), wrapped: true };
  }
  return { cmd, args: args || [], opts: o, wrapped: false };
}

// タイムアウト時の子プロセス強制終了。win32 は latexmk→xelatex の子ツリーを
// SIGKILL では殺せないため taskkill /pid <pid> /T /F(ツリーごと)で終了する。
function killTree(child) {
  if (!child) return;
  if (IS_WIN) {
    try { if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* ignore */ }
  } else {
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }
}

// Windows 予約ファイル名の判定(全OSで適用 — フェーズ20のクロスデバイス同期で
// プロジェクトが OS 間を移動するため)。CON/PRN/AUX/NUL/COM1-9/LPT1-9(拡張子付き
// 含む・大小無視)と、末尾ドット・末尾スペースを拒否する。
const WIN_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
function isReservedName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (WIN_RESERVED_RE.test(name)) return true;
  const last = name.charAt(name.length - 1);
  if (last === '.' || last === ' ') return true;
  return false;
}

// python3 / verapdf のコマンド候補(先頭から順に試す)。env で単一候補に上書き可。
//   darwin: python3 / verapdf。win32: py→python / verapdf.bat→verapdf。
//   isWin/env は既定 IS_WIN/process.env(ユニットテストで win32 相当を注入可能)。
function pythonCandidates(isWin, env) {
  if (isWin === undefined) isWin = IS_WIN;
  env = env || process.env;
  if (env.PYTHON_BIN) return [env.PYTHON_BIN];
  return isWin ? ['py', 'python'] : ['python3'];
}
function verapdfCandidates(isWin, env) {
  if (isWin === undefined) isWin = IS_WIN;
  env = env || process.env;
  if (env.VERAPDF_BIN) return [env.VERAPDF_BIN];
  return isWin ? ['verapdf.bat', 'verapdf'] : ['verapdf'];
}
const PYTHON_CMDS = pythonCandidates();
const VERAPDF_CMDS = verapdfCandidates();

// win32 のフォルダ取り込み/DL は OS 標準の tar.exe(bsdtar)を使う。TAR_BIN で上書き可。
const TAR_BIN = process.env.TAR_BIN || 'tar';
let tarAvail = null;
function tarAvailable() {
  if (tarAvail !== null) return tarAvail;
  try {
    const r = spawnSync(TAR_BIN, ['--version'], { timeout: 5000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    tarAvail = !r.error && r.status === 0;
  } catch (e) { tarAvail = false; }
  return tarAvail;
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
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// フェーズ10a: MCP 中継(/events・/agent/rpc・/agent/result)は loopback 接続のみ許可。
//   共有・共同編集・/compile 等は現状どおり LAN 許可(意図された公開)。
//   判定は req.socket.remoteAddress。IPv4 (127.0.0.1)・IPv6 (::1)・
//   IPv4-mapped (::ffff:127.0.0.1) の各表記に対応。
function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.')
  );
}

// asset名のサニタイズ: 英数字・ドット・ハイフンのみ許可。
// パス区切り・先頭ドット(隠しファイル/..)は拒否。
function sanitizeAssetName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(name)) return null;
  if (name.includes('..')) return null;
  if (isReservedName(name)) return null;   // フェーズ21: Windows 予約名・末尾ドット拒否(全OS)
  return name;
}

// フェーズ26: プロジェクトの `folder` 属性(実ディレクトリではない論理パス)を検証。
//   空/未指定はルート('')。セグメントは '/' 区切り。各セグメントは
//   空(先頭末尾/連続スラッシュ)・`.`/`..`・隠し(先頭ドット)・Windows 予約名
//   (isReservedName)を拒否、64 文字以内。深さ最大 8(フェーズ28: 3→8)。
//   返り値: 正規化した folder 文字列(有効。ルートは '')/ null(無効)。
function sanitizeFolder(folder) {
  if (folder == null) return '';
  if (typeof folder !== 'string') return null;
  const trimmed = folder.trim();
  if (trimmed === '') return '';
  if (trimmed.length > 255) return null;
  const norm = trimmed.replace(/\\/g, '/');
  const segments = norm.split('/');
  if (segments.length === 0 || segments.length > 8) return null; // 深さ最大8(フェーズ28)
  for (const seg of segments) {
    if (seg === '') return null;                  // 空セグメント(先頭末尾/連続 /)
    if (seg === '.' || seg === '..') return null;
    if (seg.charAt(0) === '.') return null;       // 隠し
    if (seg.length > 64) return null;
    if (isReservedName(seg)) return null;         // フェーズ21: Windows 予約名・末尾ドット/スペース
  }
  return segments.join('/');
}

// ---------------------------------------------------------------------------
// フェーズ10e(多層防御): openin_any=p が効かない TeX ビルド(macOS の一部
//   TeX Live 等、\input の読み取り側でパラノイドが強制されない)に備え、
//   コンパイル前に LaTeX ソースを走査し、ファイル読み書き系コマンドが絶対パス
//   (/ や ~ 始まり)・親ディレクトリ参照(..)を指す場合は拒否する。アプリが
//   生成する正常文書は imgN.ext / refs などカレント配下の相対参照のみを使うため
//   影響しない(相対サブディレクトリは paranoid と同様に許可)。
// ---------------------------------------------------------------------------
const FILE_ACCESS_CMDS = [
  'input', 'include', 'includeonly', 'subfile', 'subfileinclude', 'subimport', 'import',
  'InputIfFileExists', 'IfFileExists', 'lstinputlisting', 'verbatiminput', 'VerbatimInput',
  'includegraphics', 'graphicspath', 'usepackage', 'RequirePackage', 'LoadClass', 'documentclass',
  'bibliography', 'addbibresource', 'addglobalbib', 'href', 'externaldocument',
];
function isBadPathToken(p) {
  p = String(p).trim();
  if (!p) return false;
  if (p.charAt(0) === '/' || p.charAt(0) === '~') return true;   // Unix 絶対パス / ホーム
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;                    // Windows 絶対パス
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return true;             // 親ディレクトリ参照
  return false;
}
function latexFileAccessViolation(latex) {
  const src = String(latex == null ? '' : latex);
  const cmdAlt = FILE_ACCESS_CMDS.join('|');
  // \cmd[opts]{arg}  または  \cmd[opts] 素トークン
  const re = new RegExp('\\\\(?:' + cmdAlt + ')\\b\\s*(?:\\[[^\\]]*\\])?\\s*(\\{[^{}]*\\}|[^\\s{\\\\%]+)', 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let arg = m[1];
    if (arg.charAt(0) === '{') arg = arg.slice(1, -1);
    for (const part of arg.split(',')) if (isBadPathToken(part)) return true;
  }
  // TeX プリミティブ(ストリーム番号付き): \openin0=/path, \openout, \read, \write
  const prim = /\\(?:openin|openout|read|write)(?![a-zA-Z])[^\n{}%]*?=\s*("?)([^\s"}%]+)/g;
  while ((m = prim.exec(src)) !== null) { if (isBadPathToken(m[2])) return true; }
  // 波括弧なしの \input /abs/path / C:\path / ../path 形式。
  // Windows パスは TeX 上でもバックスラッシュ/スラッシュの両方が現れ得る。
  if (/\\(?:input|include|openin)\b\s+(\/[^\s{}%]+|~[^\s{}%]*|[a-zA-Z]:[\\/][^\s{}%]*|\.\.[\\/][^\s{}%]*)/.test(src)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 静的配信
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    sendJson(res, 400, { error: 'bad_request' });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const normalized = path.normalize(path.join(PUBLIC_DIR, urlPath));
  // public/ 外へのパストラバーサルは 403
  if (normalized !== PUBLIC_DIR && !normalized.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(normalized, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    // HEAD は GET と同じヘッダーだけを返し、ファイル本体は送らない。
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(normalized);
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// コンパイル(直列化: 実行中は待機を最新1件のみ保持、古い待機は 409)
// ---------------------------------------------------------------------------

let compiling = false;
let pending = null; // { job, res }

// 汎用ジョブキュー(直列化)。job(res, finish) を呼ぶ。実行中は待機を最新1件のみ
// 保持し、古い待機は 409。/compile と /compile-accessible が同一キューを共用する。
function enqueueJob(job, res) {
  if (compiling) {
    if (pending) {
      // 古い待機はその場で破棄
      sendJson(pending.res, 409, { error: 'superseded' });
    }
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

// 通常の /compile(latexmk -xelatex)。
function enqueueCompile(payload, res) {
  // フェーズ10e: 共有PDF(/s/:id/pdf)経由も含め全コンパイル経路で多層防御。
  if (payload && latexFileAccessViolation(payload.latex)) {
    sendJson(res, 400, { error: 'forbidden_path', message: 'absolute path / parent-directory file access is not allowed' });
    return;
  }
  enqueueJob(function (jobRes, finish) { runCompile(payload, jobRes, finish); }, res);
}

function runCompile(payload, res, finish) {
  const done = (fn) => {
    try {
      fn();
    } catch (e) {
      if (!res.writableEnded) {
        sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
      }
    }
    finish();
  };

  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });

    // assets を work/ に書き出す
    if (payload.assets != null) {
      if (!Array.isArray(payload.assets)) {
        return done(() => sendJson(res, 400, { error: 'bad_request', message: 'assets must be an array' }));
      }
      for (const asset of payload.assets) {
        if (!asset || typeof asset !== 'object') {
          return done(() => sendJson(res, 400, { error: 'bad_request', message: 'invalid asset entry' }));
        }
        const name = sanitizeAssetName(asset.name);
        if (!name) {
          return done(() => sendJson(res, 400, { error: 'bad_request', message: 'invalid asset name' }));
        }
        if (typeof asset.base64 !== 'string') {
          return done(() => sendJson(res, 400, { error: 'bad_request', message: 'invalid asset base64' }));
        }
        fs.writeFileSync(path.join(WORK_DIR, name), Buffer.from(asset.base64, 'base64'));
      }
    }

    // 前回の成果物・補助ファイルを掃除(古い doc.aux が別パッケージ構成の
    // 次回コンパイルを壊す stale-aux 問題と、成功判定の誤りを防ぐ)
    for (const ext of ['pdf', 'aux', 'bbl', 'blg', 'log', 'out', 'toc', 'lof', 'lot', 'fls', 'fdb_latexmk', 'xdv', 'run.xml']) {
      try { fs.unlinkSync(path.join(WORK_DIR, 'doc.' + ext)); } catch (e) { /* ignore */ }
    }

    fs.writeFileSync(path.join(WORK_DIR, 'doc.tex'), payload.latex, 'utf8');
  } catch (e) {
    return done(() => sendJson(res, 500, { error: 'internal', message: String(e && e.message) }));
  }

  // GUI起動のNodeだとPATHに /Library/TeX/texbin が無いことがある
  // フェーズ10e: openin_any/openout_any=p(paranoid)で TeX の任意ファイル
  //   読み書きを封じる(絶対パス・`..`・隠しファイル拒否。work 配下の相対
  //   参照と kpathsea 検索のパッケージ類は従来どおり)。TEXMFOUTPUT で
  //   作業ディレクトリ配下の絶対パスのみ例外的に許可。-shell-escape は不使用。
  const env = Object.assign({}, process.env, {
    PATH: buildPath(texPathExtras(false)),   // フェーズ21: path.delimiter + プラットフォーム別追加PATH
    openin_any: 'p',
    openout_any: 'p',
    TEXMFOUTPUT: WORK_DIR,
  });

  const child = spawn(
    'latexmk',
    ['-xelatex', '-interaction=nonstopmode', '-halt-on-error', '-output-directory=work', 'work/doc.tex'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  let stdout = '';
  let timedOut = false;
  let settled = false;

  child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
  child.stderr.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);   // フェーズ21: win32 は taskkill /T /F で子ツリーごと終了
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

    if (timedOut) {
      return done(() => sendJson(res, 500, { error: 'timeout' }));
    }

    const pdfPath = path.join(WORK_DIR, 'doc.pdf');
    if (code === 0 && fs.existsSync(pdfPath)) {
      return done(() => {
        const pdf = fs.readFileSync(pdfPath);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdf.length,
        });
        res.end(pdf);
      });
    }

    // 失敗: work/doc.log(なければ stdout)の末尾8000文字
    let log = stdout;
    try {
      log = fs.readFileSync(path.join(WORK_DIR, 'doc.log'), 'utf8');
    } catch (e) { /* fall back to stdout */ }
    return done(() => sendJson(res, 422, { error: 'compile_failed', log: String(log).slice(-LOG_TAIL) }));
  });
}

// ---------------------------------------------------------------------------
// アクセシブルPDF(フェーズ4b: POST /compile-accessible)
//   LuaLaTeX + DocumentMetadata(PDF/UA-2)でタグ付きPDFを生成し、PyMuPDF で
//   Table/Figure に Alt を注入、veraPDF で PDF/UA-2 適合を検証する。
//   各ステップ 45 秒タイムアウト。lualatex/bibtex/verapdf の PATH に
//   /Library/TeX/texbin と /opt/homebrew/bin を追加する。
// ---------------------------------------------------------------------------

const STEP_TIMEOUT_MS = 45 * 1000;
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// 1ステップ = 1子プロセス。タイムアウト付き。spawn 自体が ENOENT(コマンド不在)
// の場合は enoent:true を返し、呼び出し側でスキップ扱いにできる。
function runStep(cmd, args, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    let settled = false;
    let child;
    // フェーズ21: プラットフォーム解決(windowsHide 付与・win32 の .bat は cmd.exe 経由)
    const spec = resolveSpawn(cmd, args, opts);
    try {
      child = spawn(spec.cmd, spec.args, spec.opts);
    } catch (e) {
      return resolve({ ran: false, enoent: true, error: String(e && e.message), ms: Date.now() - t0, out: '' });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);   // フェーズ21: win32 は taskkill /T /F
    }, STEP_TIMEOUT_MS);
    if (child.stdout) child.stdout.on('data', (d) => { out += d; if (out.length > 300000) out = out.slice(-150000); });
    if (child.stderr) child.stderr.on('data', (d) => { out += d; if (out.length > 300000) out = out.slice(-150000); });
    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ran: false, enoent: !!(err && err.code === 'ENOENT'), error: err.message, ms: Date.now() - t0, out });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      // cmd.exe 経由(.bat)でコマンド自体が見つからない場合は ENOENT 相当として
      // スキップ扱いにする(直接 spawn の ENOENT と挙動を揃える)。
      let enoent = false;
      if (spec.wrapped && code !== 0 && /is not recognized|cannot find|no such file|見つかりません|指定されたパス/i.test(out)) {
        enoent = true;
      }
      resolve({ ran: !enoent, enoent, code, timedOut, ms: Date.now() - t0, out });
    });
  });
}

// コマンド候補を先頭から試し、ENOENT(不在)なら次を試す。実行できた
// (成功/失敗を問わず)時点でその結果を返す。全て不在なら最後の結果。
async function runStepCandidates(cmds, args, opts) {
  let last = { ran: false, enoent: true, ms: 0, out: '' };
  for (const c of cmds) {
    const r = await runStep(c, args, opts);
    if (!r.enoent) return r;
    last = r;
  }
  return last;
}

async function runAccessibleCompile(payload, res, finish) {
  const steps = [];
  const done = (status, obj) => {
    try {
      if (!res.writableEnded) sendJson(res, status, obj);
    } catch (e) {
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
    }
    finish();
  };

  // フェーズ10e: paranoid モード(上の /compile と同様の封じ込め)
  const env = Object.assign({}, process.env, {
    PATH: buildPath(texPathExtras(true)),   // フェーズ21: darwin は /Library/TeX/texbin + /opt/homebrew/bin 相当
    openin_any: 'p',
    openout_any: 'p',
    TEXMFOUTPUT: WORK_DIR,
  });

  let hasBib = false;
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });

    if (payload.assets != null) {
      if (!Array.isArray(payload.assets)) return done(400, { error: 'bad_request', message: 'assets must be an array' });
      for (const asset of payload.assets) {
        if (!asset || typeof asset !== 'object') return done(400, { error: 'bad_request', message: 'invalid asset entry' });
        const name = sanitizeAssetName(asset.name);
        if (!name) return done(400, { error: 'bad_request', message: 'invalid asset name' });
        if (typeof asset.base64 !== 'string') return done(400, { error: 'bad_request', message: 'invalid asset base64' });
        fs.writeFileSync(path.join(WORK_DIR, name), Buffer.from(asset.base64, 'base64'));
        if (name === 'refs.bib') hasBib = true;
      }
    }

    // stale-aux 掃除(既存 /compile と同様)
    for (const ext of ['pdf', 'aux', 'bbl', 'blg', 'log', 'out', 'toc', 'lof', 'lot', 'fls', 'fdb_latexmk', 'xdv', 'run.xml']) {
      try { fs.unlinkSync(path.join(WORK_DIR, 'doc.' + ext)); } catch (e) { /* ignore */ }
    }

    fs.writeFileSync(path.join(WORK_DIR, 'doc.tex'), payload.latex, 'utf8');

    // 表・図の Alt を JSON で inject_alt.py へ渡す(figureAlts は img[alt] 由来・任意)
    const tableAlts = Array.isArray(payload.tableAlts) ? payload.tableAlts.map(String) : [];
    const figureAlts = Array.isArray(payload.figureAlts) ? payload.figureAlts.map(String) : [];
    fs.writeFileSync(path.join(WORK_DIR, 'alts.json'), JSON.stringify({ tables: tableAlts, figures: figureAlts }), 'utf8');
  } catch (e) {
    return done(500, { error: 'internal', message: String(e && e.message) });
  }

  const pdfPath = path.join(WORK_DIR, 'doc.pdf');
  const luaArgs = ['-output-directory=work', '-interaction=nonstopmode', 'work/doc.tex'];
  const spawnOpts = { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] };

  try {
    // 1. lualatex(1回目)
    const r1 = await runStep('lualatex', luaArgs, spawnOpts);
    if (r1.enoent) {
      return done(500, { error: 'lualatex_missing', message: 'lualatex not found in PATH', steps });
    }
    steps.push({ name: 'lualatex', ok: fs.existsSync(pdfPath), ms: r1.ms });

    // 2. bibtex → lualatex ×2(refs.bib がある場合)
    if (hasBib) {
      const rb = await runStep('bibtex', ['doc'], { cwd: WORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
      steps.push({ name: 'bibtex', ok: rb.ran && rb.code === 0, skipped: !!rb.enoent, ms: rb.ms });
      const rl2 = await runStep('lualatex', luaArgs, spawnOpts);
      steps.push({ name: 'lualatex-2', ok: rl2.ran, ms: rl2.ms });
      const rl3 = await runStep('lualatex', luaArgs, spawnOpts);
      steps.push({ name: 'lualatex-3', ok: rl3.ran, ms: rl3.ms });
    }

    // tagpdf の firstaid は正常でも非ゼロ終了しうるため、終了コードではなく
    // PDF の存在で成否を判定する(veraPDF が最終的な適合ゲート)。
    if (!fs.existsSync(pdfPath)) {
      let log = r1.out;
      try { log = fs.readFileSync(path.join(WORK_DIR, 'doc.log'), 'utf8'); } catch (e) { /* fall back */ }
      return done(422, { error: 'compile_failed', log: String(log).slice(-LOG_TAIL), steps });
    }

    // 3. inject_alt.py(python3 / PyMuPDF が無ければスキップ)
    const injectScript = path.join(SCRIPTS_DIR, 'inject_alt.py');
    const ri = await runStepCandidates(PYTHON_CMDS, [injectScript, pdfPath, path.join(WORK_DIR, 'alts.json')],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (ri.enoent) {
      steps.push({ name: 'inject_alt', ok: true, skipped: true, ms: ri.ms, note: 'python not found' });
    } else {
      // exit 3 = PyMuPDF 未導入 → スキップ扱い
      const skipped = ri.ran && ri.code === 3;
      steps.push({ name: 'inject_alt', ok: ri.ran && ri.code === 0, skipped: skipped, ms: ri.ms });
    }

    // 4. verapdf -f ua2(無ければスキップ)
    const verapdf = { ran: false, pass: null, failedClauses: [] };
    const rv = await runStepCandidates(VERAPDF_CMDS, ['-f', 'ua2', '--format', 'mrr', pdfPath],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (rv.enoent) {
      steps.push({ name: 'verapdf', ok: true, skipped: true, ms: rv.ms, note: 'verapdf not found' });
    } else {
      verapdf.ran = true;
      const mrr = rv.out || '';
      if (/isCompliant=/.test(mrr)) {
        verapdf.pass = /isCompliant="true"/.test(mrr);
      } else {
        // mrr が解析不能なら終了コードで代替(0=PASS, 1=FAIL)
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

function enqueueAccessible(payload, res) {
  enqueueJob(function (jobRes, finish) { runAccessibleCompile(payload, jobRes, finish); }, res);
}

// ---------------------------------------------------------------------------
// 共有スナップショット(フェーズ2: POST /share, GET /s/:id, GET /s/:id/pdf)
// ---------------------------------------------------------------------------

const SHARES_FILE = path.join(WORK_DIR, 'shares.json');
const SHARES_MAX = 20;
const SHARE_ID_RE = /^[A-Za-z0-9]{8}$/;

// { id, title, html, latex, createdAt } の配列(古い順)
let shares = [];

function loadShares() {
  try {
    const data = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
    if (Array.isArray(data)) {
      shares = data.filter((s) => s && typeof s === 'object' && SHARE_ID_RE.test(String(s.id || '')));
    }
  } catch (e) { /* ファイルが無い/壊れている場合は空で開始 */ }
}

function saveShares() {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(SHARES_FILE, JSON.stringify(shares), 'utf8');
  } catch (e) {
    console.error('shares.json の保存に失敗:', e.message);
  }
}

function findShare(id) {
  if (typeof id !== 'string' || !SHARE_ID_RE.test(id)) return null;
  return shares.find((s) => s.id === id) || null;
}

// フェーズ13/13b: 共有権限。未設定/不正値は "edit"(現行互換)。
//   "view"(閲覧のみ) / "comment"(コメント可) / "edit"(編集可)
function normalizePermission(v) {
  return (v === 'view' || v === 'comment') ? v : 'edit';
}
function sharePermission(share) {
  return share ? normalizePermission(share.permission) : 'edit';
}

function generateShareId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let id = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) id += chars[bytes[i] % chars.length];
    if (!shares.some((s) => s.id === id)) return id;
  }
}

// LAN の非internal IPv4 を返す(無ければ localhost)
function getLanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (!info.internal && (info.family === 'IPv4' || info.family === 4)) {
        return info.address;
      }
    }
  }
  return 'localhost';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function handleShareCreate(payload, res) {
  if (!payload || typeof payload.html !== 'string' || typeof payload.latex !== 'string' || payload.latex.length === 0) {
    sendJson(res, 400, { error: 'bad_request', message: 'html (string) and latex (string) are required' });
    return;
  }
  const title = typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title : '無題の文書';
  // フェーズ13/13b: 権限("view"|"comment"|"edit"、不正値は "edit")
  const permission = normalizePermission(payload.permission);
  const id = generateShareId();
  shares.push({ id, title, html: payload.html, latex: payload.latex, permission, createdAt: Date.now() });
  while (shares.length > SHARES_MAX) shares.shift(); // 古い順に削除
  saveShares();
  const url = `http://${getLanIPv4()}:${PORT}/s/${id}`;
  sendJson(res, 200, { id, url, permission });
}

// ---------------------------------------------------------------------------
// フェーズ10f: 共有ページの XSS 対策(サーバー側サニタイズ)
//   share.html はブラウザ由来の HTML をそのまま保持しているため、renderSharePage
//   で生埋め込みする前に、SPEC「文書モデル」の許可DOM相当の allowlist 方式で
//   タグ・属性をフィルタする。<script>/<iframe>/<object> 等は中身ごと除去、
//   on*= 属性・javascript:/data:text/html の href/src も除去する。
// ---------------------------------------------------------------------------

// 許可タグ(SPEC 文書モデル + 閲覧ページ CSS が想定する要素)
const SHARE_ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'figure', 'figcaption',
  'div', 'hr', 'br', 'img', 'a',
  'strong', 'em', 'u', 's', 'sub', 'sup', 'b', 'i', 'span', 'code',
]);
// 中身ごと落とすタグ(実行系・埋め込み系)
const SHARE_DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'svg', 'math', 'form', 'frameset', 'frame',
]);
// 許可 class トークン(それ以外のトークンは除去)
const SHARE_ALLOWED_CLASSES = new Set([
  'title', 'subtitle', 'code', 'page-break', 'math-display', 'math-inline',
  'hl', 'fc', 'ff-serif', 'ff-sans', 'ff-mono', 'fs', 'footnote',
  'bibliography', 'comment-ref',
]);
// 許可属性(タグ共通)。href/src/style/class は下で値も検査する。
const SHARE_ALLOWED_ATTRS = new Set([
  'class', 'style', 'href', 'src', 'alt', 'title',
  'data-tex', 'data-pt', 'data-note', 'data-cid',
  'colspan', 'rowspan',
]);

function sanitizeAttrValue(name, value, tag) {
  const v = String(value == null ? '' : value);
  if (name === 'class') {
    const kept = v.split(/\s+/).filter((t) => SHARE_ALLOWED_CLASSES.has(t));
    return kept.length ? kept.join(' ') : null;
  }
  if (name === 'style') {
    // text-align のみ許可(段落揃え。SPEC 文書モデル)
    const m = v.match(/^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i);
    return m ? ('text-align: ' + m[1].toLowerCase()) : null;
  }
  if (name === 'href' || name === 'src') {
    // 制御文字・空白を除いてスキームを判定(javascript:/vbscript:/data:text/html 対策)
    const probe = v.replace(/[\s -]+/g, '').toLowerCase();
    if (probe.startsWith('javascript:') || probe.startsWith('vbscript:')) return null;
    if (probe.startsWith('data:')) {
      // data: は img の画像 MIME のみ許可(data:text/html 等は拒否)
      if (name === 'src' && tag === 'img' && /^data:image\//.test(probe)) return v;
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/.test(probe) && !/^(https?|mailto):/.test(probe)) return null;
    return v;
  }
  return v;
}

function sanitizeShareHtml(html) {
  const src = String(html == null ? '' : html);
  const out = [];
  // タグ・コメント単位のトークナイザ(引用符内の > を正しくスキップ)
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let skipTag = null;   // 中身ごと除去中のタグ名
  let skipDepth = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = src.slice(last, m.index);
    if (!skipTag && text) out.push(text.replace(/</g, '&lt;'));
    last = re.lastIndex;

    const token = m[0];
    if (token.startsWith('<!--')) continue;   // コメントは常に除去
    const tag = (m[1] || '').toLowerCase();
    const isClose = token.charAt(1) === '/';

    if (skipTag) {
      // 除去中: 同名タグの入れ子だけ数え、対応する閉じタグで解除
      if (tag === skipTag) {
        if (isClose) { skipDepth--; if (skipDepth <= 0) skipTag = null; }
        else if (!/\/\s*>$/.test(token)) skipDepth++;
      }
      continue;
    }
    if (SHARE_DROP_WITH_CONTENT.has(tag)) {
      if (!isClose && !/\/\s*>$/.test(token)) { skipTag = tag; skipDepth = 1; }
      continue;
    }
    if (!SHARE_ALLOWED_TAGS.has(tag)) continue;   // 不許可タグはタグのみ除去(中身は残す)

    if (isClose) { out.push('</' + tag + '>'); continue; }

    // 属性を allowlist でフィルタして再構築
    const attrs = [];
    const attrRe = /([a-zA-Z_][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
    let am;
    while ((am = attrRe.exec(m[2] || '')) !== null) {
      const name = am[1].toLowerCase();
      if (name.startsWith('on')) continue;                 // イベントハンドラは常に除去
      if (!SHARE_ALLOWED_ATTRS.has(name)) continue;
      const raw = am[3] != null ? am[3] : (am[4] != null ? am[4] : (am[2] || ''));
      const val = sanitizeAttrValue(name, raw, tag);
      if (val == null) continue;
      attrs.push(' ' + name + '="' + val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"');
    }
    const selfClose = /\/\s*>$/.test(token) || tag === 'br' || tag === 'hr' || tag === 'img';
    out.push('<' + tag + attrs.join('') + (selfClose && (tag === 'br' || tag === 'hr' || tag === 'img') ? '>' : '>'));
  }
  const tail = src.slice(last);
  if (!skipTag && tail) out.push(tail.replace(/</g, '&lt;'));
  return out.join('');
}

// 閲覧専用ページ(グレー背景中央に白いA4風ページ)
function renderSharePage(share) {
  const title = escapeHtml(share.title);
  const perm = sharePermission(share);
  const canJoin = perm === 'edit' || perm === 'comment';
  const joinLabel = perm === 'comment' ? 'コメントを追加' : '編集に参加';
  const joinTitle = perm === 'comment' ? 'この文書にコメントを追加します' : 'この文書の共同編集に参加します';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - TailorTeX(共有)</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='4' fill='%23185abd'/%3E%3Ctext x='16' y='23' font-size='19' font-family='Segoe UI,sans-serif' font-weight='bold' fill='%23fff' text-anchor='middle'%3EW%3C/text%3E%3C/svg%3E">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #808080;
    font-family: "Yu Gothic UI", "Hiragino Sans", "Segoe UI", Meiryo, sans-serif;
    color: #262626;
  }
  #topbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 16px;
    height: 48px; padding: 0 16px;
    background: #185abd; color: #fff;
  }
  #topbar .doc-title {
    font-size: 14px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #topbar .badge {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: rgba(255,255,255,.2); flex: none;
  }
  #topbar .pdf-link {
    flex: none;
    color: #185abd; background: #fff; text-decoration: none;
    font-size: 13px; font-weight: 600;
    padding: 6px 14px; border-radius: 4px;
  }
  #topbar .pdf-link:hover { background: #e6eff9; }
  #topbar .edit-link {
    flex: none;
    color: #fff; background: rgba(255,255,255,.18); text-decoration: none;
    font-size: 13px; font-weight: 600;
    padding: 6px 14px; border-radius: 4px;
    display: inline-flex; align-items: center; gap: 6px;
  }
  #topbar .edit-link:hover { background: rgba(255,255,255,.30); }
  #page-scroll { padding: 32px 16px 64px; }
  #page {
    width: 210mm; max-width: 100%; min-height: 297mm;
    margin: 0 auto; padding: 30mm 25mm;
    background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.35);
    font-family: "Hiragino Mincho ProN", "Yu Mincho", serif;
    font-size: 10.5pt; line-height: 1.7;
  }
  #page p { margin: 0 0 .5em; }
  #page h1 { font-size: 16pt; margin: .8em 0 .4em; }
  #page h2 { font-size: 14pt; margin: .7em 0 .35em; }
  #page h3 { font-size: 12pt; margin: .6em 0 .3em; }
  #page p.title { font-size: 22pt; text-align: center; margin: .5em 0; }
  #page p.subtitle { font-size: 13pt; text-align: center; color: #595959; margin: 0 0 1em; }
  #page blockquote { margin: .5em 2em; color: #444; border-left: 3px solid #ccc; padding-left: 1em; }
  #page pre.code { font-family: Menlo, Consolas, monospace; background: #f2f2f2; padding: .6em .8em; overflow-x: auto; font-size: 9.5pt; }
  #page ul, #page ol { margin: .3em 0 .5em 2em; }
  #page table { border-collapse: collapse; margin: .5em 0; }
  #page td, #page th { border: 1px solid #262626; padding: .2em .6em; }
  #page img { max-width: 100%; height: auto; }
  #page hr { border: none; border-top: 1px solid #262626; margin: .8em 0; }
  #page .hl { background: #ffff00; }
  #page .fc { color: #ff0000; }
  #page .ff-serif { font-family: "Hiragino Mincho ProN", "Yu Mincho", serif; }
  #page .ff-sans { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; }
  #page .ff-mono { font-family: Menlo, Consolas, monospace; }
  #page .page-break { border-top: 1px dashed #999; margin: 1em 0; }
  #page .comment-ref { background: #fbe4d5; }
</style>
</head>
<body>
<div id="topbar">
  <span class="doc-title">${title}</span>
  <span class="badge">閲覧専用</span>
  ${canJoin ? `<a class="edit-link" href="/edit/${share.id}" title="${joinTitle}" style="margin-left:auto">
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2l3 3-7 7-3.5 .5.5-3.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
    ${joinLabel}
  </a>` : ''}
  <a class="pdf-link" href="/s/${share.id}/pdf" target="_blank" rel="noopener" style="${canJoin ? '' : 'margin-left:auto'}">PDFを表示</a>
</div>
<div id="page-scroll">
  <div id="page">
${sanitizeShareHtml(share.html)}
  </div>
</div>
</body>
</html>`;
}

function handleShareRoutes(req, res, urlPath) {
  // /s/:id または /s/:id/pdf
  const m = urlPath.match(/^\/s\/([^/]+)(\/pdf)?$/);
  if (!m) return false;

  const id = m[1];
  const wantsPdf = !!m[2];
  const share = findShare(id); // 英数8桁以外は null → 404

  if (!share) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return true;
  }

  if (wantsPdf) {
    // 通常の /compile と同じ直列化キューを共用
    enqueueCompile({ latex: share.latex }, res);
    return true;
  }

  const body = renderSharePage(share);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // フェーズ10f: 閲覧ページは JS 不要のため script を全面禁止(インラインCSSと
    // data: 画像・favicon のみ許可)。サニタイズと併せた多層防御。
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
  });
  res.end(body);
  return true;
}

loadShares();

// ---------------------------------------------------------------------------
// Agent ブリッジ(フェーズ5: MCP 中継。サーバーは文書状態を持たない純粋な中継)
//   mcp-server.js ⇄ POST /agent/rpc ⇄ SSE(GET /events)⇄ ブラウザ(agent-bridge.js)
//   ⇄ POST /agent/result。ブラウザ未接続なら 503 no_editor。応答待ちは 15 秒で 504。
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 15 * 1000;

let sseClient = null;            // 現在接続中のブラウザ(最新1本のみ)
const rpcPending = new Map();    // id → { res, timer }
let rpcSeq = 0;

// GET /events: ブラウザ(agent-bridge.js)が接続する SSE。新規接続で旧を閉じる。
function handleEvents(req, res) {
  if (sseClient && !sseClient.writableEnded) {
    try { sseClient.write('event: superseded\ndata: {}\n\n'); } catch (e) { /* ignore */ }
    try { sseClient.end(); } catch (e) { /* ignore */ }
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n');
  res.write('event: ready\ndata: {}\n\n');
  sseClient = res;

  const onClose = () => { if (sseClient === res) sseClient = null; };
  req.on('close', onClose);
  req.on('error', onClose);
  res.on('error', onClose);
}

// コネクション維持のため 25 秒ごとにコメント行を送る。
const ssePingTimer = setInterval(() => {
  if (sseClient && !sseClient.writableEnded) {
    try { sseClient.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }
}, 25000);
if (ssePingTimer.unref) ssePingTimer.unref();

// POST /agent/rpc: mcp-server.js からの {method, params}。id を採番して SSE で
// ブラウザへ送り、POST /agent/result を待って応答する。
function handleAgentRpc(payload, res) {
  if (!payload || typeof payload.method !== 'string') {
    sendJson(res, 400, { error: 'bad_request', message: 'method (string) is required' });
    return;
  }
  if (!sseClient || sseClient.writableEnded) {
    sendJson(res, 503, { error: 'no_editor' });
    return;
  }
  const id = ++rpcSeq;
  const timer = setTimeout(() => {
    if (rpcPending.has(id)) {
      rpcPending.delete(id);
      sendJson(res, 504, { error: 'timeout' });
    }
  }, RPC_TIMEOUT_MS);
  rpcPending.set(id, { res, timer });

  const msg = JSON.stringify({ id: id, method: payload.method, params: payload.params || {} });
  try {
    sseClient.write('event: rpc\ndata: ' + msg + '\n\n');
  } catch (e) {
    clearTimeout(timer);
    rpcPending.delete(id);
    sendJson(res, 503, { error: 'no_editor' });
  }
}

// POST /agent/result: ブラウザからの {id, ok, result|error}。待機中の rpc へ返す。
function handleAgentResult(payload, res) {
  const rawId = payload && payload.id;
  if (rawId == null) {
    sendJson(res, 400, { error: 'bad_request', message: 'id is required' });
    return;
  }
  const id = typeof rawId === 'string' ? parseInt(rawId, 10) : rawId;
  const entry = rpcPending.get(id);
  if (!entry) {
    sendJson(res, 200, { received: false }); // 既にタイムアウト済み等
    return;
  }
  rpcPending.delete(id);
  clearTimeout(entry.timer);
  if (payload.ok) {
    sendJson(entry.res, 200, { ok: true, result: payload.result != null ? payload.result : null });
  } else {
    sendJson(entry.res, 200, { ok: false, error: payload.error != null ? payload.error : 'error' });
  }
  sendJson(res, 200, { received: true });
}

// ---------------------------------------------------------------------------
// ライブ共同編集(フェーズ6: Word co-authoring 方式・段落ロック)
//   share エントリを live: {order, blocks, comments, rev, blockRev, locks, users}
//   で拡張。SSE チャネル GET /edit-events/:id で購読、更新は POST /edit/:id/op。
//   ホスト/ゲスト共に同じ index.html ベースの UI(GET /edit/:id)。
//   フェーズ5 の /events(MCP・単一接続)とは完全に別チャネル。
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 15 * 1000;   // 無更新ロックの失効
const USER_TTL_MS = 20 * 1000;   // SSE 切断漏れ時のプレゼンス失効(バックストップ)

// shareId -> Set<res>(その共有を購読中の SSE クライアント)
const editClients = new Map();

// 現在の #doc HTML を order+blocks から復元(閲覧ページ /s/:id 用に share.html も更新)
function liveComposeHtml(live) {
  if (!live || !Array.isArray(live.order)) return '';
  return live.order.map((bid) => live.blocks[bid] || '').join('\n');
}

// live セッションを(無ければ)初期化。html は現状維持用途では使わず order/blocks を正とする。
function ensureLive(share, init) {
  if (!share.live) {
    share.live = {
      order: [], blocks: {}, comments: {},
      rev: 0, blockRev: {}, locks: {}, users: {},
    };
  }
  if (init) {
    const live = share.live;
    live.order = Array.isArray(init.order) ? init.order.slice() : [];
    live.blocks = (init.blocks && typeof init.blocks === 'object') ? Object.assign({}, init.blocks) : {};
    live.comments = (init.comments && typeof init.comments === 'object') ? init.comments : {};
    live.rev = (live.rev || 0) + 1;
    live.blockRev = {};
    for (const bid of live.order) live.blockRev[bid] = live.rev;
    // ロック/プレゼンスは接続ライフサイクルで管理するため保持
    share.html = liveComposeHtml(live);
    saveShares();
  }
  return share.live;
}

function editBroadcast(id, event, data, exceptRes) {
  const set = editClients.get(id);
  if (!set) return;
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of set) {
    if (res === exceptRes) continue;
    if (res.writableEnded) continue;
    try { res.write(frame); } catch (e) { /* ignore */ }
  }
}

function editSnapshotFor(live) {
  return {
    order: live.order,
    blocks: live.blocks,
    comments: live.comments,
    rev: live.rev,
    locks: live.locks,
    users: live.users,
  };
}

// SSE 購読(GET /edit-events/:id?pid=&name=&color=)。接続で users に登録、
// 切断で users とその保有ロックを解放してブロードキャスト。
function handleEditEvents(req, res, id, query) {
  const share = findShare(id);
  if (!share) { sendJson(res, 404, { error: 'not_found' }); return; }
  const live = ensureLive(share);

  const pid = String(query.pid || '').slice(0, 64) || ('anon-' + Math.random().toString(36).slice(2, 8));
  let name = '';
  let color = '';
  try { name = decodeURIComponent(query.name || ''); } catch (e) { name = String(query.name || ''); }
  try { color = decodeURIComponent(query.color || ''); } catch (e) { color = String(query.color || ''); }
  name = (name || 'ゲスト').slice(0, 40);
  color = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n');

  let set = editClients.get(id);
  if (!set) { set = new Set(); editClients.set(id, set); }
  set.add(res);
  res._collabPid = pid;

  live.users[pid] = { name, color, ts: Date.now() };

  // 新規クライアントへ現在の全体像、既存へプレゼンス更新
  res.write('event: snapshot\ndata: ' + JSON.stringify(Object.assign({ self: pid }, editSnapshotFor(live))) + '\n\n');
  editBroadcast(id, 'presence', { users: live.users }, res);

  const cleanup = () => {
    const s = editClients.get(id);
    if (s) { s.delete(res); if (s.size === 0) editClients.delete(id); }
    const lv = share.live;
    if (lv) {
      // 同一 pid の他接続が無ければ users から除去 + 保有ロック解放
      let stillHere = false;
      const s2 = editClients.get(id);
      if (s2) { for (const r of s2) { if (r._collabPid === pid) { stillHere = true; break; } } }
      let changed = false;
      if (!stillHere && lv.users[pid]) { delete lv.users[pid]; changed = true; }
      for (const bid of Object.keys(lv.locks)) {
        if (lv.locks[bid] && lv.locks[bid].pid === pid && !stillHere) { delete lv.locks[bid]; changed = true; }
      }
      if (changed) {
        editBroadcast(id, 'presence', { users: lv.users });
        editBroadcast(id, 'locks', { locks: lv.locks });
      }
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

// ホストがライブセッションを開始/再初期化(POST /edit/:id/start {order, blocks, comments})
function handleEditStart(id, payload, res) {
  const share = findShare(id);
  if (!share) { sendJson(res, 404, { error: 'not_found' }); return; }
  const live = ensureLive(share, payload || {});
  editBroadcast(id, 'snapshot', Object.assign({ self: null }, editSnapshotFor(live)));
  sendJson(res, 200, { ok: true, rev: live.rev });
}

// 各種オペレーション(POST /edit/:id/op {type, pid, ...})
function handleEditOp(id, payload, res) {
  const share = findShare(id);
  if (!share) { sendJson(res, 404, { error: 'not_found' }); return; }
  const live = ensureLive(share);
  const p = payload || {};
  const pid = String(p.pid || '').slice(0, 64);
  const type = String(p.type || '');
  if (live.users[pid]) live.users[pid].ts = Date.now();

  // フェーズ13b: コメント権限では本文改変 op(block/structure)を拒否。
  //   comments/lock/unlock/presence は許可(コメント追加・在席表示のため)。
  if (sharePermission(share) === 'comment' && (type === 'block' || type === 'structure')) {
    sendJson(res, 403, { error: 'comment_only' });
    return;
  }

  switch (type) {
    case 'block': {
      const bid = String(p.bid || '');
      if (!bid || typeof p.html !== 'string') { sendJson(res, 400, { error: 'bad_request' }); return; }
      live.blocks[bid] = p.html;
      if (live.order.indexOf(bid) === -1) live.order.push(bid);
      live.rev += 1;
      live.blockRev[bid] = live.rev;
      share.html = liveComposeHtml(live);
      saveShares();
      editBroadcast(id, 'block', { bid, html: p.html, rev: live.rev, by: pid });
      break;
    }
    case 'structure': {
      if (!Array.isArray(p.order) || !p.blocks || typeof p.blocks !== 'object') {
        sendJson(res, 400, { error: 'bad_request' }); return;
      }
      live.order = p.order.map(String);
      live.blocks = Object.assign({}, p.blocks);
      // stale blockRev の掃除
      const nb = {};
      live.rev += 1;
      for (const bid of live.order) nb[bid] = live.blockRev[bid] || live.rev;
      live.blockRev = nb;
      share.html = liveComposeHtml(live);
      saveShares();
      editBroadcast(id, 'structure', { order: live.order, blocks: live.blocks, rev: live.rev, by: pid });
      break;
    }
    case 'comments': {
      live.comments = (p.comments && typeof p.comments === 'object') ? p.comments : {};
      editBroadcast(id, 'comments', { comments: live.comments, by: pid });
      break;
    }
    case 'lock': {
      const bid = String(p.bid || '');
      if (!bid) { sendJson(res, 400, { error: 'bad_request' }); return; }
      const u = live.users[pid] || {};
      // 同一ユーザーの以前のロックは解放(1人1ブロック)
      for (const b of Object.keys(live.locks)) {
        if (live.locks[b] && live.locks[b].pid === pid && b !== bid) delete live.locks[b];
      }
      live.locks[bid] = { pid, name: u.name || '', color: u.color || '#888', ts: Date.now() };
      editBroadcast(id, 'locks', { locks: live.locks });
      break;
    }
    case 'unlock': {
      const bid = String(p.bid || '');
      if (bid && live.locks[bid] && live.locks[bid].pid === pid) {
        delete live.locks[bid];
        editBroadcast(id, 'locks', { locks: live.locks });
      }
      break;
    }
    case 'presence': {
      editBroadcast(id, 'presence', { users: live.users });
      break;
    }
    default:
      sendJson(res, 400, { error: 'unknown_op' }); return;
  }
  sendJson(res, 200, { ok: true, rev: live.rev });
}

// GET /edit/:id — index.html をゲスト用に加工して配信(base + 設定注入、MCP無効化)
function handleEditPage(id, res) {
  const share = findShare(id);
  if (!share) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  ensureLive(share);
  let html;
  try {
    html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  } catch (e) {
    sendJson(res, 500, { error: 'internal' });
    return;
  }
  const inject = '<base href="/">\n'
    + '<script>window.__COLLAB__=' + JSON.stringify({ mode: 'guest', shareId: id, permission: sharePermission(share) }) + ';</script>';
  html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + inject);
  // ゲストでは MCP ブリッジ(/events 単一接続)を読み込まない
  html = html.replace(/\s*<script src="js\/agent-bridge\.js"><\/script>/i, '');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

// 失効ロック/切断漏れプレゼンスの定期掃除(5秒毎)
const editSweepTimer = setInterval(() => {
  const now = Date.now();
  // keepalive ping(全 edit SSE クライアント)
  for (const set of editClients.values()) {
    for (const res of set) { if (!res.writableEnded) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } } }
  }
  for (const share of shares) {
    const live = share.live;
    if (!live) continue;
    let lockChanged = false;
    let userChanged = false;
    for (const bid of Object.keys(live.locks)) {
      if (now - (live.locks[bid].ts || 0) > LOCK_TTL_MS) { delete live.locks[bid]; lockChanged = true; }
    }
    const connected = new Set();
    const set = editClients.get(share.id);
    if (set) { for (const r of set) connected.add(r._collabPid); }
    for (const pid of Object.keys(live.users)) {
      if (!connected.has(pid) && now - (live.users[pid].ts || 0) > USER_TTL_MS) {
        delete live.users[pid];
        for (const b of Object.keys(live.locks)) {
          if (live.locks[b] && live.locks[b].pid === pid) { delete live.locks[b]; lockChanged = true; }
        }
        userChanged = true;
      }
    }
    if (lockChanged) editBroadcast(share.id, 'locks', { locks: live.locks });
    if (userChanged) editBroadcast(share.id, 'presence', { users: live.users });
  }
}, 5000);
if (editSweepTimer.unref) editSweepTimer.unref();

// ---------------------------------------------------------------------------
// フェーズ20: クロスデバイス・ライブセッション(projectId 基準)
//   同一プロジェクトを開いた全クライアント(Macブラウザ・iPad・MCP=Claude)が
//   GET /projects/:id/live-events を購読し、POST /projects/:id/live-op で編集
//   (block/structure/comments/lock/unlock/presence/agent)を送る。フェーズ6の
//   op モデル(段落ロック+LWW)を projectId 基準に一般化して流用する。
//
//   コスト設計(SPEC「コスト設計」節を厳守):
//   - 同一LANのライブ同期は「サーバーSSE(メモリ中継)のみ」= クラウド費用ゼロ。
//     このチャネルは Firestore / Storage / onSnapshot を一切使わない純粋な SSE 中継。
//   - presence/カーソル/ロックは永続化しない(SSE のみ。エフェメラルな在席情報を
//     課金対象の書き込みにしない)。
//   - 本文の永続化は「per-op で書かず」debounce(8秒)+無変化ハッシュスキップで
//     ローカル projects/<id>/main.html にまとめて 1 書き込み(フェーズ10c 準拠)。
//     クラウド(遠隔)同期はオプトインで、既存の cloud store アダプタ(cloud-config が
//     null の間は無効=ローカルのみ)が同じ debounce 集約経路で担う。ライブ中に
//     per-keystroke で Firestore へ書かない。
// ---------------------------------------------------------------------------

const projectLive = new Map();                 // projectId -> live 状態
const projectLiveClients = new Map();          // projectId -> Set<res>
const PROJECT_LIVE_PERSIST_MS = 8000;          // 本文永続化の debounce(フェーズ10c 準拠)
const projectLivePersistTimers = new Map();    // projectId -> timer
const projectLivePersistHash = new Map();      // projectId -> 最終書込ハッシュ(無変化スキップ)

function ensureProjectLive(id) {
  let live = projectLive.get(id);
  if (!live) {
    // order/blocks はランタイムのみ(最初に参加したブラウザが seed する)。
    // ディスクの main.html を解析して seed しないのは、ブラウザの data-bid 採番と
    // 一致させるため。get_document はブラウザ DOM(=ライブ最新)を返すので齟齬はない。
    live = { order: [], blocks: {}, comments: {}, rev: 0, blockRev: {}, locks: {}, users: {} };
    projectLive.set(id, live);
  }
  return live;
}

function projectLiveBroadcast(id, event, data, exceptRes) {
  const set = projectLiveClients.get(id);
  if (!set) return;
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of set) {
    if (res === exceptRes) continue;
    if (res.writableEnded) continue;
    try { res.write(frame); } catch (e) { /* ignore */ }
  }
}

// 本文(order/blocks)を debounce + 無変化ハッシュスキップでローカル main.html へ永続化。
//   presence/lock/comments では呼ばない(本文変化時のみ)。クラウドは使わない。
function scheduleProjectLivePersist(id) {
  if (projectLivePersistTimers.has(id)) return;   // 既にスケジュール済み(集約)
  const t = setTimeout(() => {
    projectLivePersistTimers.delete(id);
    const live = projectLive.get(id);
    if (!live) return;
    let html;
    try { html = liveComposeHtml(live); } catch (e) { return; }
    const hash = crypto.createHash('sha1').update(html).digest('hex');
    if (projectLivePersistHash.get(id) === hash) return;   // 無変化 → 書かない
    try {
      if (!projectExists(id)) return;
      fs.writeFileSync(path.join(projectDir(id), 'main.html'), html, 'utf8');
      projectLivePersistHash.set(id, hash);
    } catch (e) { /* ローカル書込失敗は致命的でない(ブラウザ側 autosave が別途担う) */ }
  }, PROJECT_LIVE_PERSIST_MS);
  if (t.unref) t.unref();
  projectLivePersistTimers.set(id, t);
}

// SSE 購読(GET /projects/:id/live-events?pid=&name=&color=)
function handleProjectLiveEvents(req, res, id, query) {
  if (!projectExists(id)) { sendJson(res, 404, { error: 'not_found' }); return; }
  const live = ensureProjectLive(id);

  const pid = String(query.pid || '').slice(0, 64) || ('anon-' + Math.random().toString(36).slice(2, 8));
  let name = '';
  let color = '';
  try { name = decodeURIComponent(query.name || ''); } catch (e) { name = String(query.name || ''); }
  try { color = decodeURIComponent(query.color || ''); } catch (e) { color = String(query.color || ''); }
  name = (name || 'デバイス').slice(0, 40);
  color = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n');

  let set = projectLiveClients.get(id);
  if (!set) { set = new Set(); projectLiveClients.set(id, set); }
  set.add(res);
  res._livePid = pid;

  live.users[pid] = { name, color, ts: Date.now() };

  res.write('event: snapshot\ndata: ' + JSON.stringify(Object.assign({ self: pid }, editSnapshotFor(live))) + '\n\n');
  projectLiveBroadcast(id, 'presence', { users: live.users }, res);

  const cleanup = () => {
    const s = projectLiveClients.get(id);
    if (s) { s.delete(res); if (s.size === 0) projectLiveClients.delete(id); }
    const lv = projectLive.get(id);
    if (lv) {
      let stillHere = false;
      const s2 = projectLiveClients.get(id);
      if (s2) { for (const r of s2) { if (r._livePid === pid) { stillHere = true; break; } } }
      let changed = false;
      if (!stillHere && lv.users[pid]) { delete lv.users[pid]; changed = true; }
      for (const bid of Object.keys(lv.locks)) {
        if (lv.locks[bid] && lv.locks[bid].pid === pid && !stillHere) { delete lv.locks[bid]; changed = true; }
      }
      if (changed) {
        projectLiveBroadcast(id, 'presence', { users: lv.users });
        projectLiveBroadcast(id, 'locks', { locks: lv.locks });
      }
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

// POST /projects/:id/live-op {type, pid, ...}
function handleProjectLiveOp(id, payload, res) {
  if (!projectExists(id)) { sendJson(res, 404, { error: 'not_found' }); return; }
  const live = ensureProjectLive(id);
  const p = payload || {};
  const pid = String(p.pid || '').slice(0, 64);
  const type = String(p.type || '');
  if (live.users[pid]) live.users[pid].ts = Date.now();

  switch (type) {
    case 'block': {
      const bid = String(p.bid || '');
      if (!bid || typeof p.html !== 'string') { sendJson(res, 400, { error: 'bad_request' }); return; }
      live.blocks[bid] = p.html;
      if (live.order.indexOf(bid) === -1) live.order.push(bid);
      live.rev += 1;
      live.blockRev[bid] = live.rev;
      projectLiveBroadcast(id, 'block', { bid, html: p.html, rev: live.rev, by: pid });
      scheduleProjectLivePersist(id);
      break;
    }
    case 'structure': {
      if (!Array.isArray(p.order) || !p.blocks || typeof p.blocks !== 'object') {
        sendJson(res, 400, { error: 'bad_request' }); return;
      }
      live.order = p.order.map(String);
      live.blocks = Object.assign({}, p.blocks);
      const nb = {};
      live.rev += 1;
      for (const bid of live.order) nb[bid] = live.blockRev[bid] || live.rev;
      live.blockRev = nb;
      projectLiveBroadcast(id, 'structure', { order: live.order, blocks: live.blocks, rev: live.rev, by: pid });
      scheduleProjectLivePersist(id);
      break;
    }
    case 'comments': {
      live.comments = (p.comments && typeof p.comments === 'object') ? p.comments : {};
      projectLiveBroadcast(id, 'comments', { comments: live.comments, by: pid });
      // コメントは本文永続化に含めない(ブラウザ側 autosave が notes/threads 等を担う)。
      break;
    }
    case 'lock': {
      const bid = String(p.bid || '');
      if (!bid) { sendJson(res, 400, { error: 'bad_request' }); return; }
      const u = live.users[pid] || {};
      for (const b of Object.keys(live.locks)) {
        if (live.locks[b] && live.locks[b].pid === pid && b !== bid) delete live.locks[b];
      }
      live.locks[bid] = { pid, name: u.name || '', color: u.color || '#888', ts: Date.now() };
      projectLiveBroadcast(id, 'locks', { locks: live.locks });
      break;
    }
    case 'unlock': {
      const bid = String(p.bid || '');
      if (bid && live.locks[bid] && live.locks[bid].pid === pid) {
        delete live.locks[bid];
        projectLiveBroadcast(id, 'locks', { locks: live.locks });
      }
      break;
    }
    case 'presence': {
      projectLiveBroadcast(id, 'presence', { users: live.users });
      break;
    }
    // MCP(Claude)の在席登録。SSE 接続を持たない擬似参加者を users['claude'] として
    //   upsert し、TTL(未更新20秒)で自動失効。永続化はしない。
    case 'agent': {
      const apid = 'claude';
      const acolor = /^#[0-9a-fA-F]{3,8}$/.test(String(p.color || '')) ? p.color : '#c05a2b';
      live.users[apid] = { name: 'Claude', color: acolor, ts: Date.now(), agent: true };
      projectLiveBroadcast(id, 'presence', { users: live.users });
      break;
    }
    default:
      sendJson(res, 400, { error: 'unknown_op' }); return;
  }
  sendJson(res, 200, { ok: true, rev: live.rev });
}

// 失効ロック/切断漏れプレゼンス(Claude 擬似在席を含む)の定期掃除 + keepalive(5秒毎)
const projectLiveSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const set of projectLiveClients.values()) {
    for (const res of set) { if (!res.writableEnded) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } } }
  }
  for (const [id, live] of projectLive) {
    let lockChanged = false;
    let userChanged = false;
    for (const bid of Object.keys(live.locks)) {
      if (now - (live.locks[bid].ts || 0) > LOCK_TTL_MS) { delete live.locks[bid]; lockChanged = true; }
    }
    const connected = new Set();
    const set = projectLiveClients.get(id);
    if (set) { for (const r of set) connected.add(r._livePid); }
    for (const pid of Object.keys(live.users)) {
      // SSE 接続を持たない参加者(切断漏れ or Claude 擬似在席)を TTL で失効
      if (!connected.has(pid) && now - (live.users[pid].ts || 0) > USER_TTL_MS) {
        delete live.users[pid];
        for (const b of Object.keys(live.locks)) {
          if (live.locks[b] && live.locks[b].pid === pid) { delete live.locks[b]; lockChanged = true; }
        }
        userChanged = true;
      }
    }
    if (lockChanged) projectLiveBroadcast(id, 'locks', { locks: live.locks });
    if (userChanged) projectLiveBroadcast(id, 'presence', { users: live.users });
  }
}, 5000);
if (projectLiveSweepTimer.unref) projectLiveSweepTimer.unref();

// ---------------------------------------------------------------------------
// HTTPサーバー
// ---------------------------------------------------------------------------

// JSONボディを読み込んで cb(payload) を呼ぶ(サイズ超過/JSON不正は自前で応答)
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
// フェーズ8: Crossref プロキシ (DOI 文献照合)
//   GET /doi-meta?doi=<encoded>   → api.crossref.org/works/{doi}
//   GET /doi-search?q=<encoded>   → api.crossref.org/works?query.bibliographic=...&rows=3
//   https 標準モジュール / 10秒タイムアウト / メモリキャッシュ(上限200) /
//   上流のエラー/429 はステータスをそのまま中継。
// ---------------------------------------------------------------------------

const CROSSREF_HOST = 'api.crossref.org';
const CROSSREF_UA = 'TailorTeX/1.0';
const CROSSREF_TIMEOUT_MS = 10 * 1000;
const CROSSREF_CACHE_MAX = 200;
const crossrefCache = new Map(); // key → { status, body } (200 応答のみ)

function crossrefCacheGet(key) {
  if (!crossrefCache.has(key)) return null;
  const val = crossrefCache.get(key);
  // LRU 風: 参照時に末尾へ移す
  crossrefCache.delete(key);
  crossrefCache.set(key, val);
  return val;
}
function crossrefCacheSet(key, val) {
  crossrefCache.set(key, val);
  while (crossrefCache.size > CROSSREF_CACHE_MAX) {
    const oldest = crossrefCache.keys().next().value;
    crossrefCache.delete(oldest);
  }
}

// Crossref へ GET し、上流ステータス/本文をそのまま res に中継する。
function crossrefProxy(reqPath, cacheKey, res) {
  const cached = crossrefCacheGet(cacheKey);
  if (cached) {
    if (res.writableEnded) return;
    res.writeHead(cached.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cache': 'HIT',
    });
    res.end(cached.body);
    return;
  }

  const options = {
    host: CROSSREF_HOST,
    path: reqPath,
    method: 'GET',
    headers: { 'User-Agent': CROSSREF_UA, 'Accept': 'application/json' },
  };

  const upstream = https.request(options, (up) => {
    const chunks = [];
    up.on('data', (c) => chunks.push(c));
    up.on('end', () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks);
      const status = up.statusCode || 502;
      // 200 のみキャッシュ(429/5xx 等の一過性応答は保存しない)
      if (status === 200) {
        crossrefCacheSet(cacheKey, { status, body });
      }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Cache': 'MISS',
      });
      res.end(body);
    });
  });

  upstream.on('timeout', () => {
    upstream.destroy(new Error('timeout'));
  });
  upstream.on('error', (err) => {
    if (res.writableEnded) return;
    const isTimeout = err && err.message === 'timeout';
    sendJson(res, isTimeout ? 504 : 502, {
      error: isTimeout ? 'upstream_timeout' : 'upstream_unreachable',
      message: String(err && err.message || err),
    });
  });
  upstream.setTimeout(CROSSREF_TIMEOUT_MS);
  upstream.end();
}

function handleDoiMeta(req, res) {
  const query = require('url').parse(req.url, true).query;
  const doi = (query.doi || '').trim();
  if (!doi) {
    sendJson(res, 400, { error: 'bad_request', message: 'doi is required' });
    return;
  }
  const reqPath = '/works/' + encodeURIComponent(doi);
  crossrefProxy(reqPath, 'meta:' + doi.toLowerCase(), res);
}

function handleDoiSearch(req, res) {
  const query = require('url').parse(req.url, true).query;
  const q = (query.q || '').trim();
  if (!q) {
    sendJson(res, 400, { error: 'bad_request', message: 'q is required' });
    return;
  }
  const reqPath = '/works?query.bibliographic=' + encodeURIComponent(q) + '&rows=3';
  crossrefProxy(reqPath, 'search:' + q.toLowerCase(), res);
}

// ---------------------------------------------------------------------------
// フェーズ15: プロジェクト(ディレクトリ)モデル
//   projects/<id>/ を実ディレクトリで管理。CRUD・tree・file read/write/delete・
//   rename・meta・download(zip)。projectId は 8桁英数(SHARE_ID_RE 流用)。
//   パスは projects/<id>/ 配下に厳格制限(path.normalize + 接頭辞チェック、
//   `..`・絶対パス・隠しファイル拒否)。フェーズ10e の latexFileAccessViolation
//   ガードはコンパイル経路で維持。
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(ROOT, 'projects');
const AGENT_INBOX_FILE = path.join(PROJECTS_DIR, '.ratex-agent-inbox.json');
const AGENT_INBOX_LIMIT = 200;

function readAgentInbox() {
  try {
    const value = JSON.parse(fs.readFileSync(AGENT_INBOX_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (e) { return []; }
}

function writeAgentInbox(items) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const tmp = AGENT_INBOX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items.slice(-AGENT_INBOX_LIMIT), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, AGENT_INBOX_FILE);
}

function publicAgentRequest(item) {
  return {
    id: item.id, text: item.text, project_id: item.project_id || '', status: item.status,
    recipient: item.recipient || 'codex',
    context: item.context || null,
    thread_id: item.thread_id || '',
    pointers: Array.isArray(item.pointers) ? item.pointers : [],
    reply: item.reply || '', createdAt: item.createdAt, answeredAt: item.answeredAt || null,
  };
}
const PROJECT_ID_RE = /^[A-Za-z0-9]{8}$/;

// プロジェクト内ファイルの Content-Type(拡張子ベース)
const PROJECT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function generateProjectId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let id = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) id += chars[bytes[i] % chars.length];
    if (!fs.existsSync(path.join(PROJECTS_DIR, id))) return id;
  }
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, id);
}

function projectExists(id) {
  try {
    return PROJECT_ID_RE.test(id) && fs.statSync(projectDir(id)).isDirectory();
  } catch (e) {
    return false;
  }
}

// projects/<id>/ 配下の相対パスを安全に解決する。
//   隠しファイル(先頭ドット)・`..`・絶対パスを拒否し、正規化後に接頭辞チェック。
//   成功時は絶対パス(string)、失敗時は null。
function resolveProjectPath(id, rawPath) {
  if (!PROJECT_ID_RE.test(id)) return null;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  let rel = rawPath;
  try { rel = decodeURIComponent(rel); } catch (e) { return null; }
  rel = rel.replace(/\\/g, '/');
  if (rel.charAt(0) === '/' || /^[a-zA-Z]:/.test(rel)) return null; // 絶対パス拒否
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '..') return null;              // 親ディレクトリ参照拒否
    if (seg.charAt(0) === '.') return null;     // 隠しファイル拒否
    if (seg.length > 255) return null;
    if (isReservedName(seg)) return null;       // フェーズ21: Windows 予約名・末尾ドット/スペース拒否(全OS)
  }
  const base = projectDir(id);
  const abs = path.normalize(path.join(base, segments.join('/')));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// フェーズ25: build/ 配下への書き込み(PUT file / mkdir / rename / upload-folder の
//   展開先)を全クライアントで拒否する。build/ はコンパイル出力の不可侵領域で、
//   読み取り・ダウンロードは従来どおり許可する(ここは書き込み系ハンドラでのみ使う)。
//   rawPath の先頭セグメントが build かを、resolveProjectPath と同じ正規化で判定する。
function isBuildWritePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return false;
  let rel = rawPath;
  try { rel = decodeURIComponent(rel); } catch (e) { /* 復号失敗はそのまま判定 */ }
  rel = rel.replace(/\\/g, '/');
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.');
  return segments.length > 0 && segments[0] === 'build';
}

function rejectBuildWrite(res) {
  sendJson(res, 403, {
    error: 'forbidden_path',
    message: 'build/ 配下はコンパイル出力の不可侵領域のため書き込みできません。',
  });
}

function frozenSubmissionRoot(id, rawPath) {
  const rel = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = rel.split('/');
  if (parts[0] !== 'submissions' || !parts[1]) return null;
  const root = resolveProjectPath(id, 'submissions/' + parts[1]);
  return root && fs.existsSync(path.join(root, 'manifest.json')) ? root : null;
}

function rejectFrozenSubmission(res) {
  sendJson(res, 423, { error: 'submission_frozen', message: '提出記録は凍結済みです。新しい提出記録として保存してください。' });
}

// 再帰的にツリーを収集(build/ は除外)。相対パスは '/' 区切り。
function walkProjectTree(baseDir, relPrefix, out) {
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (e) { return; }
  entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1, bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const ent of entries) {
    if (ent.name.charAt(0) === '.') continue;             // 隠しファイルは非表示
    if (relPrefix === '' && ent.name === 'build') continue; // build/ は除外
    const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
    const full = path.join(baseDir, ent.name);
    if (ent.isDirectory()) {
      out.push({ path: rel, type: 'dir', size: 0, ext: '' });
      walkProjectTree(full, rel, out);
    } else if (ent.isFile()) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) { /* ignore */ }
      out.push({ path: rel, type: 'file', size, ext: path.extname(ent.name).toLowerCase().replace(/^\./, '') });
    }
  }
}

function projectFileCount(id) {
  const out = [];
  walkProjectTree(projectDir(id), '', out);
  return out.filter((e) => e.type === 'file').length;
}

function readProjectMeta(id) {
  try {
    const raw = fs.readFileSync(path.join(projectDir(id), 'project.json'), 'utf8');
    const meta = JSON.parse(raw);
    if (meta && typeof meta === 'object') return meta;
  } catch (e) { /* ignore */ }
  return {};
}

function writeProjectMeta(id, meta) {
  fs.writeFileSync(path.join(projectDir(id), 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
}

// 生バイト列としてボディを読む(PUT /file 用: 生テキスト or JSON {base64})
function readRawBody(req, res, cb) {
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
  req.on('end', () => { if (!aborted) cb(Buffer.concat(chunks)); });
  req.on('error', () => { aborted = true; });
}

// --- 各ハンドラ ---

function handleProjectsList(res) {
  let ids = [];
  try {
    ids = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PROJECT_ID_RE.test(e.name))
      .map((e) => e.name);
  } catch (e) { /* PROJECTS_DIR 未作成 → 空 */ }
  const list = ids.map((id) => {
    const meta = readProjectMeta(id);
    return {
      id,
      name: typeof meta.name === 'string' ? meta.name : id,
      folder: typeof meta.folder === 'string' ? meta.folder : '',
      createdAt: meta.createdAt || null,
      updatedAt: meta.updatedAt || null,
      fileCount: projectFileCount(id),
    };
  });
  list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  sendJson(res, 200, list);
}

function createProject(name, seed) {
  const id = generateProjectId();
  const dir = projectDir(id);
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const now = new Date().toISOString();
  const meta = {
    name: (typeof name === 'string' && name.trim()) ? name.trim() : '無題のプロジェクト',
    mainDoc: 'main',
    createdAt: now,
    updatedAt: now,
  };
  writeProjectMeta(id, meta);
  fs.writeFileSync(path.join(dir, 'main.html'), (seed && typeof seed.html === 'string') ? seed.html : '', 'utf8');
  fs.writeFileSync(path.join(dir, 'refs.bib'), (seed && typeof seed.bib === 'string') ? seed.bib : '', 'utf8');
  if (seed && typeof seed.comments === 'string' && seed.comments) {
    fs.writeFileSync(path.join(dir, 'notes', 'comments.md'), seed.comments, 'utf8');
  }
  // フェーズ15: プロジェクトを実 git 管理(git init + 初期コミット)。
  //   git 不在時はスキップ(プロジェクト機能自体は動く)。
  ensureProjectRepo(dir);
  return id;
}

// --- フェーズ15: プロジェクト単位の git バージョン管理 ---
//   各プロジェクトディレクトリ内で完結し、リポジトリ本体の git とは無関係
//   (projects/ は本体 .gitignore 済み)。自動保存(PUT file)はコミットしない。
// フェーズ21: 既定は darwin '/usr/bin/git'、win32 は PATH の 'git'(.exe)。GIT_BIN で上書き可。
const GIT_BIN = process.env.GIT_BIN || (IS_WIN ? 'git' : '/usr/bin/git');
const GIT_TIMEOUT_MS = 15 * 1000;
const GIT_AUTHOR_NAME = 'TailorTeX';
const GIT_AUTHOR_EMAIL = 'noreply@localhost';
const GIT_HASH_RE = /^[0-9a-fA-F]{4,40}$/;

let gitAvailable = null;
function hasGit() {
  if (gitAvailable !== null) return gitAvailable;
  // フェーズ21: fs.statSync でなく `git --version` の成功で判定(PATH解決を活かす)。
  //   /usr/bin/git があれば darwin でも従来どおり成功する。
  try {
    const r = spawnSync(GIT_BIN, ['--version'], { timeout: 5000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    gitAvailable = !r.error && r.status === 0;
  } catch (e) { gitAvailable = false; }
  return gitAvailable;
}

// git を spawnSync で実行(cwd=プロジェクトdir、タイムアウト付き、グローバル設定非依存)。
function runGit(dir, args) {
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: GIT_AUTHOR_EMAIL,
    // フェーズ21: os.devNull(win32 は \\.\nul)+ NOSYSTEM。Git for Windows で
    //   /dev/null が解釈できないケースの保険。
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  const r = spawnSync(GIT_BIN, args, {
    cwd: dir, env, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) {
    return { ok: false, enoent: r.error.code === 'ENOENT', code: null, stdout: r.stdout || '', stderr: String(r.error.message) };
  }
  return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// リポジトリを保証(未初期化なら git init + .gitignore(build/除外) + 初期コミット)。
function ensureProjectRepo(dir) {
  if (!hasGit()) return false;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    runGit(dir, ['init', '-q']);
  }
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'build/\n', 'utf8');
  runGit(dir, ['add', '-A']);
  // 既にコミット済みでなければ初期コミット
  const head = runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) {
    runGit(dir, ['commit', '-q', '-m', '初期コミット']);
  }
  return true;
}

function touchProject(id) {
  const meta = readProjectMeta(id);
  meta.updatedAt = new Date().toISOString();
  try { writeProjectMeta(id, meta); } catch (e) { /* ignore */ }
}

function handleProjectTree(id, res) {
  const out = [];
  walkProjectTree(projectDir(id), '', out);
  sendJson(res, 200, out);
}

function handleProjectFileGet(id, rawPath, res) {
  const abs = resolveProjectPath(id, rawPath);
  if (!abs) { sendJson(res, 403, { error: 'forbidden_path' }); return; }
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) { sendJson(res, 404, { error: 'not_found' }); return; }
    const ext = path.extname(abs).toLowerCase();
    const type = PROJECT_MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { if (!res.writableEnded) res.end(); });
    stream.pipe(res);
  });
}

const RECOVERY_KEEP = 10;
let recoverySequence = 0;

function atomicWriteFileSync(abs, data) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(abs) + '.ratex-tmp-' + process.pid + '-' + (++recoverySequence));
  try {
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, abs);
    } catch (e) {
      // Windows は既存ファイルへの rename が失敗する場合がある。直前バックアップがあるため置換する。
      if (e && (e.code === 'EEXIST' || e.code === 'EPERM')) {
        try { fs.unlinkSync(abs); } catch (x) { if (!x || x.code !== 'ENOENT') throw x; }
        fs.renameSync(tmp, abs);
      } else throw e;
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

function backupBeforeOverwrite(projectRoot, rel, previous, next) {
  if (!previous || Buffer.compare(previous, next) === 0) return null;
  if (rel !== 'main.tex' && rel !== 'main.html') return null;
  const dir = path.join(projectRoot, '.ratex-recovery', rel);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + (++recoverySequence);
  const target = path.join(dir, stamp + '.bak');
  atomicWriteFileSync(target, previous);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.bak')).sort();
  while (files.length > RECOVERY_KEEP) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* ignore */ }
  }
  return target;
}

function catastrophicTexShrink(previous, next) {
  if (!previous || previous.length < 2000) return false;
  if (!next) return true;
  return next.length < Math.max(1000, Math.floor(previous.length * 0.25));
}

function safeProjectWriteSync(projectRoot, rel, data, options) {
  const abs = path.join(projectRoot, rel);
  let previous = null;
  try { previous = fs.readFileSync(abs); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  if (rel === 'main.tex' && !(options && options.allowDestructive) && catastrophicTexShrink(previous, data)) {
    const error = new Error('main.tex overwrite blocked: new content is less than 25% of the current file');
    error.code = 'CONTENT_LOSS_BLOCKED';
    throw error;
  }
  backupBeforeOverwrite(projectRoot, rel, previous, data);
  atomicWriteFileSync(abs, data);
}

function writeDocumentBundleSync(projectRoot, files, options) {
  const allowed = ['main.html', 'main.tex', 'refs.bib'];
  const entries = allowed.filter((rel) => Object.prototype.hasOwnProperty.call(files, rel)).map((rel) => ({
    rel,
    data: Buffer.from(String(files[rel] == null ? '' : files[rel]), 'utf8'),
    abs: path.join(projectRoot, rel),
  }));
  const originals = {};
  entries.forEach((e) => {
    try { originals[e.rel] = fs.readFileSync(e.abs); } catch (x) { if (!x || x.code !== 'ENOENT') throw x; originals[e.rel] = null; }
    if (e.rel === 'main.tex' && !(options && options.allowDestructive) && catastrophicTexShrink(originals[e.rel], e.data)) {
      const error = new Error('main.tex overwrite blocked: new content is less than 25% of the current file');
      error.code = 'CONTENT_LOSS_BLOCKED';
      throw error;
    }
    backupBeforeOverwrite(projectRoot, e.rel, originals[e.rel], e.data);
  });
  try {
    entries.forEach((e) => atomicWriteFileSync(e.abs, e.data));
  } catch (error) {
    entries.forEach((e) => {
      try {
        if (originals[e.rel] === null) { if (fs.existsSync(e.abs)) fs.unlinkSync(e.abs); }
        else atomicWriteFileSync(e.abs, originals[e.rel]);
      } catch (rollbackError) { /* recovery copies remain available */ }
    });
    throw error;
  }
  return entries.map((e) => e.rel);
}

function handleProjectFilePut(id, rawPath, req, res) {
  if (isBuildWritePath(rawPath)) { rejectBuildWrite(res); return; }
  if (frozenSubmissionRoot(id, rawPath)) { rejectFrozenSubmission(res); return; }
  const abs = resolveProjectPath(id, rawPath);
  if (!abs) { sendJson(res, 403, { error: 'forbidden_path' }); return; }
  readRawBody(req, res, (buf) => {
    let data = buf;
    const ct = String(req.headers['content-type'] || '');
    if (ct.indexOf('application/json') !== -1) {
      let parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) {
        sendJson(res, 400, { error: 'bad_request', message: 'invalid JSON' }); return;
      }
      if (parsed && typeof parsed.base64 === 'string') {
        data = Buffer.from(parsed.base64, 'base64');
      } else if (parsed && typeof parsed.content === 'string') {
        data = Buffer.from(parsed.content, 'utf8');
      } else if (parsed && typeof parsed.text === 'string') {
        data = Buffer.from(parsed.text, 'utf8');
      } else {
        sendJson(res, 400, { error: 'bad_request', message: 'base64 or content required' }); return;
      }
    }
    try {
      safeProjectWriteSync(projectDir(id), String(rawPath || '').replace(/\\/g, '/'), data);
      touchProject(id);
    } catch (e) {
      if (e && e.code === 'CONTENT_LOSS_BLOCKED') {
        sendJson(res, 409, { error: 'content_loss_blocked', message: 'main.tex の大幅縮小を検出したため上書きを拒否しました。' }); return;
      }
      sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
    }
    sendJson(res, 200, { ok: true, path: rawPath, size: data.length });
  });
}

function handleProjectDocumentBundle(id, payload, res) {
  if (!payload || typeof payload.html !== 'string') {
    sendJson(res, 400, { error: 'bad_request', message: 'html is required' }); return;
  }
  const files = { 'main.html': payload.html };
  if (typeof payload.tex === 'string') files['main.tex'] = payload.tex;
  if (typeof payload.refs === 'string') files['refs.bib'] = payload.refs;
  try {
    const written = writeDocumentBundleSync(projectDir(id), files);
    touchProject(id);
    sendJson(res, 200, { ok: true, written });
  } catch (e) {
    if (e && e.code === 'CONTENT_LOSS_BLOCKED') {
      sendJson(res, 409, { error: 'content_loss_blocked', message: 'main.tex の大幅縮小を検出したため一括保存を拒否しました。' });
    } else sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
  }
}

function handleProjectFileDelete(id, rawPath, res) {
  if (frozenSubmissionRoot(id, rawPath)) { rejectFrozenSubmission(res); return; }
  const abs = resolveProjectPath(id, rawPath);
  if (!abs) { sendJson(res, 403, { error: 'forbidden_path' }); return; }
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
    touchProject(id);
  } catch (e) {
    if (e && e.code === 'ENOENT') { sendJson(res, 404, { error: 'not_found' }); return; }
    sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
  }
  sendJson(res, 200, { ok: true });
}

function handleProjectRename(id, payload, res) {
  const from = payload && payload.from;
  const to = payload && payload.to;
  // build/ は不可侵。build/ からの移動も build/ への移動も拒否する。
  if (isBuildWritePath(from) || isBuildWritePath(to)) { rejectBuildWrite(res); return; }
  if (frozenSubmissionRoot(id, from) || frozenSubmissionRoot(id, to)) { rejectFrozenSubmission(res); return; }
  const absFrom = resolveProjectPath(id, from);
  const absTo = resolveProjectPath(id, to);
  if (!absFrom || !absTo) { sendJson(res, 403, { error: 'forbidden_path' }); return; }
  try {
    if (!fs.existsSync(absFrom)) { sendJson(res, 404, { error: 'not_found' }); return; }
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
    touchProject(id);
  } catch (e) {
    sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
  }
  sendJson(res, 200, { ok: true, from, to });
}

function handleProjectMeta(id, payload, res) {
  const meta = readProjectMeta(id);
  if (payload && typeof payload.name === 'string' && payload.name.trim()) {
    meta.name = payload.name.trim();
  }
  meta.updatedAt = new Date().toISOString();
  try { writeProjectMeta(id, meta); } catch (e) {
    sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
  }
  sendJson(res, 200, { id, name: meta.name, updatedAt: meta.updatedAt });
}

// フェーズ26: PATCH /projects/:id で name / folder を更新(検証付き、updatedAt bump)。
//   folder はプロジェクト属性(実ディレクトリではない)。空文字/欠如でルートへ。
function handleProjectPatch(id, payload, res) {
  const meta = readProjectMeta(id);
  let changed = false;
  if (payload && typeof payload.name === 'string' && payload.name.trim()) {
    meta.name = payload.name.trim();
    changed = true;
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'folder')) {
    const f = sanitizeFolder(payload.folder);
    if (f === null) {
      sendJson(res, 400, {
        error: 'invalid_folder',
        message: 'フォルダ名が不正です(空セグメント・.・..・隠し・予約名・深さ8超・64文字超は不可)。',
      });
      return;
    }
    if (f === '') delete meta.folder; else meta.folder = f;
    changed = true;
  }
  if (!changed) {
    sendJson(res, 400, { error: 'bad_request', message: 'name または folder を指定してください。' });
    return;
  }
  meta.updatedAt = new Date().toISOString();
  try { writeProjectMeta(id, meta); } catch (e) {
    sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
  }
  sendJson(res, 200, {
    id,
    name: meta.name,
    folder: typeof meta.folder === 'string' ? meta.folder : '',
    updatedAt: meta.updatedAt,
  });
}

function handleProjectDelete(id, res) {
  try {
    fs.rmSync(projectDir(id), { recursive: true, force: true });
  } catch (e) {
    sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
  }
  sendJson(res, 200, { ok: true });
}

// フェーズ15: 空フォルダ作成(中に .gitkeep)。パス検証は resolveProjectPath 流用。
function handleProjectMkdir(id, rawPath, res) {
  if (isBuildWritePath(rawPath)) { rejectBuildWrite(res); return; }
  const abs = resolveProjectPath(id, rawPath);
  if (!abs) { sendJson(res, 403, { error: 'forbidden_path' }); return; }
  try {
    fs.mkdirSync(abs, { recursive: true });
    const keep = path.join(abs, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '', 'utf8');
    touchProject(id);
  } catch (e) {
    sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
  }
  sendJson(res, 200, { ok: true, path: rawPath });
}

// ---------------------------------------------------------------------------
// フェーズ15c: フォルダごとの取り込み(zip をクライアントで生成 → 展開)
//   POST /projects/:id/upload-folder?path=<targetDir>
//   body: zip の生バイナリ(application/zip 等)または JSON {base64}
//   /usr/bin/unzip で targetDir へ展開。zip slip 対策として展開前に
//   `unzip -Z1`(名前)と `unzip -Z`(属性)で 絶対パス・`..`・シンボリック
//   リンクを検出して拒否し、展開後にも実パスがプロジェクト配下か再検証する。
//   build/・隠しファイルは除外。zip 上限 200MB。unzip 不在時 501。
// ---------------------------------------------------------------------------
const UNZIP_BIN = process.env.UNZIP_BIN || '/usr/bin/unzip';
const DITTO_BIN = process.env.DITTO_BIN || '/usr/bin/ditto';
// 非ASCII(日本語等)のエントリ名を正しく展開するため UTF-8 ロケールで実行。
// (macOS の Info-ZIP unzip 6.00 は非Unicodeビルドで、UTF-8 名の展開に失敗する
//  ことがあるため、可能なら macOS ネイティブの ditto を優先して使う)
const UNZIP_ENV = Object.assign({}, process.env, {
  LANG: /UTF-8/i.test(process.env.LANG || '') ? process.env.LANG : 'en_US.UTF-8',
  LC_ALL: /UTF-8/i.test(process.env.LC_ALL || '') ? process.env.LC_ALL : 'en_US.UTF-8',
});
const MAX_FOLDER_ZIP = 200 * 1024 * 1024;   // 展開対象 zip の上限(200MB)
const MAX_FOLDER_BODY = 290 * 1024 * 1024;  // 転送ボディ上限(base64 の膨張分を考慮)

function binAvailable(bin) {
  try { return fs.statSync(bin).isFile(); } catch (e) { return false; }
}
function unzipAvailable() { return binAvailable(UNZIP_BIN); }
function dittoAvailable() { return binAvailable(DITTO_BIN); }

// staging から targetDir へ、build/・隠しファイル・シンボリックリンクを除外して
// コピーする(階層保持)。各コピー先が projects/<id>/ 配下か realpath で検証。
// 返り値: { copied, escaped }
function copyExtractedFiltered(srcDir, destDir, rpBase) {
  let copied = 0;
  let escaped = null;
  (function walk(sdir, ddir) {
    let ents;
    try { ents = fs.readdirSync(sdir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (escaped) return;
      if (e.name.charAt(0) === '.') continue;                 // 隠しファイル除外
      if (e.name === 'build' && e.isDirectory()) continue;    // build/ 除外
      const s = path.join(sdir, e.name);
      const d = path.join(ddir, e.name);
      let st;
      try { st = fs.lstatSync(s); } catch (err) { continue; }
      if (st.isSymbolicLink()) continue;                      // シンボリックリンク除外
      if (st.isDirectory()) {
        try { fs.mkdirSync(d, { recursive: true }); } catch (err) {}
        let rp; try { rp = fs.realpathSync(d); } catch (er) { rp = d; }
        if (rp !== rpBase && !rp.startsWith(rpBase + path.sep)) { escaped = d; return; }
        walk(s, d);
      } else if (st.isFile()) {
        try { fs.mkdirSync(path.dirname(d), { recursive: true }); } catch (err) {}
        let rp; try { rp = fs.realpathSync(path.dirname(d)); } catch (er) { rp = path.dirname(d); }
        if (rp !== rpBase && !rp.startsWith(rpBase + path.sep)) { escaped = d; return; }
        try { fs.copyFileSync(s, d); copied++; } catch (err) {}
      }
    }
  })(srcDir, destDir);
  return { copied, escaped };
}

// zip エントリ名が危険か(絶対パス・ドライブレター・`..` 親参照を検出)。
function isUnsafeZipEntry(name) {
  if (typeof name !== 'string' || name === '') return false;
  const n = name.replace(/\\/g, '/');
  if (n.charAt(0) === '/') return true;            // 絶対パス
  if (/^[a-zA-Z]:/.test(n)) return true;           // Windows ドライブレター
  const segs = n.split('/');
  for (const s of segs) { if (s === '..') return true; } // 親ディレクトリ参照
  return false;
}

// upload-folder 用の生ボディ読み取り(200MB 相当の大きめ上限)。
function readFolderBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  const ct = String(req.headers['content-type'] || '');
  const isJson = ct.indexOf('application/json') !== -1;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_FOLDER_BODY) {
      aborted = true;
      sendJson(res, 413, { error: 'payload_too_large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => { if (!aborted) cb(Buffer.concat(chunks), isJson); });
  req.on('error', () => { aborted = true; });
}

function handleProjectUploadFolder(id, rawPath, req, res) {
  // 展開バックエンド: darwin は macOS ネイティブの ditto を優先し、無ければ unzip。
  //   win32 は OS 標準の tar.exe(bsdtar)を使う。いずれも無ければ 501(劣化)。
  const useTar = IS_WIN ? tarAvailable() : false;
  const useDitto = IS_WIN ? false : dittoAvailable();
  const useUnzip = IS_WIN ? false : unzipAvailable();
  if (!useTar && !useDitto && !useUnzip) {
    sendJson(res, 501, { error: 'extractor_unavailable', message: 'server tar/unzip/ditto not available' });
    return;
  }
  // 展開先(targetDir)。未指定はプロジェクト直下。それ以外は resolveProjectPath で検証。
  let targetAbs;
  if (!rawPath || rawPath === '.' || rawPath === '/') {
    targetAbs = projectDir(id);
  } else if (isBuildWritePath(rawPath)) {
    rejectBuildWrite(res); return;   // build/ 配下への展開は不可
  } else {
    targetAbs = resolveProjectPath(id, rawPath);
    if (!targetAbs) { sendJson(res, 403, { error: 'forbidden_path' }); return; }
  }

  readFolderBody(req, res, (buf, isJson) => {
    let zipBuf = buf;
    if (isJson) {
      let parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); }
      catch (e) { sendJson(res, 400, { error: 'bad_request', message: 'invalid JSON' }); return; }
      if (parsed && typeof parsed.base64 === 'string') {
        zipBuf = Buffer.from(parsed.base64, 'base64');
      } else {
        sendJson(res, 400, { error: 'bad_request', message: 'base64 required' }); return;
      }
    }
    if (!zipBuf || zipBuf.length === 0) {
      sendJson(res, 400, { error: 'bad_request', message: 'empty body' }); return;
    }
    if (zipBuf.length > MAX_FOLDER_ZIP) {
      sendJson(res, 413, { error: 'payload_too_large', message: 'zip exceeds 200MB' }); return;
    }

    // 一時ディレクトリに zip を書き出す。
    let tmpDir, tmpZip;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlx-folder-'));
      tmpZip = path.join(tmpDir, 'upload.zip');
      fs.writeFileSync(tmpZip, zipBuf);
    } catch (e) {
      sendJson(res, 500, { error: 'internal', message: String(e && e.message) }); return;
    }
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} };

    // (1) zip slip 対策: unzip があれば展開前にエントリ名を検査して危険な zip を
    //   明示的に拒否する(絶対 / .. / ドライブレター / シンボリックリンク)。
    //   unzip が無い場合は ditto の正規化 + 後段の realpath 検証 + シンボリック
    //   リンク除外で安全性を担保する。
    if (useUnzip) {
      const namesR = spawnSync(UNZIP_BIN, ['-Z1', tmpZip], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, env: UNZIP_ENV, windowsHide: true });
      if (namesR.status !== 0) {
        cleanup();
        sendJson(res, 400, { error: 'bad_zip', message: 'cannot read zip' }); return;
      }
      const names = String(namesR.stdout || '').split('\n');
      for (const nm of names) {
        const t = nm.replace(/[\r\n]+$/, '');
        if (t === '') continue;
        if (isUnsafeZipEntry(t)) {
          cleanup();
          sendJson(res, 400, { error: 'zip_slip', message: 'unsafe entry: ' + t }); return;
        }
      }
      // シンボリックリンク検出(zipinfo 長形式の先頭 'l')。
      const longR = spawnSync(UNZIP_BIN, ['-Z', tmpZip], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, env: UNZIP_ENV, windowsHide: true });
      if (longR.status === 0) {
        const lines = String(longR.stdout || '').split('\n');
        for (const ln of lines) {
          const mZ = ln.match(/^\s*([lbcdps-][rwxsStT-]{9})\s/);
          if (mZ && mZ[1].charAt(0) === 'l') {
            cleanup();
            sendJson(res, 400, { error: 'zip_slip', message: 'symlink entry rejected' }); return;
          }
        }
      }
    } else if (useTar) {
      // win32: tar -tvf でエントリ一覧(モード+名前)を取得し、unzip -Z 相当の防御を行う。
      //   モード先頭 'l'(シンボリックリンク)を拒否、名前は絶対パス・ドライブレター・
      //   `..` を拒否する。bsdtar の -tv 出力は先頭がモード列(例: -rw-r--r--)。
      const listR = spawnSync(TAR_BIN, ['-tvf', tmpZip], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      if (listR.error || listR.status !== 0) {
        cleanup();
        sendJson(res, 400, { error: 'bad_zip', message: 'cannot read zip' }); return;
      }
      const lines = String(listR.stdout || '').split('\n');
      for (const ln of lines) {
        if (ln.trim() === '') continue;
        const m = ln.match(/^\s*([lbcdps-][rwxsStT-]{9})\s+(.*)$/);
        if (m && m[1].charAt(0) === 'l') {
          cleanup();
          sendJson(res, 400, { error: 'zip_slip', message: 'symlink entry rejected' }); return;
        }
      }
      // 名前だけを別途取得(スペース混じり名でも確実に切り出せる)。
      const namesR = spawnSync(TAR_BIN, ['-tf', tmpZip], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      if (namesR.error || namesR.status !== 0) {
        cleanup();
        sendJson(res, 400, { error: 'bad_zip', message: 'cannot read zip' }); return;
      }
      const names = String(namesR.stdout || '').split('\n');
      for (const nm of names) {
        const t = nm.replace(/[\r\n]+$/, '');
        if (t === '') continue;
        if (isUnsafeZipEntry(t)) {
          cleanup();
          sendJson(res, 400, { error: 'zip_slip', message: 'unsafe entry: ' + t }); return;
        }
      }
    }

    // (2) 一旦 staging(プロジェクト外の一時領域)へ展開。ditto を優先。
    //   ditto は macOS ネイティブで UTF-8 名を正しく扱い、`../` を正規化して
    //   展開先の外へ出さない。unzip フォールバック時は UTF-8 ロケールで実行。
    const stage = path.join(tmpDir, 'stage');
    try { fs.mkdirSync(stage, { recursive: true }); } catch (e) {}
    let ex;
    if (useTar) {
      // win32: bsdtar で展開(UTF-8名は bsdtar が処理。展開後の realpath 再検証・
      //   build/・隠しファイル除外の既存フィルタはそのまま通す)。
      ex = spawnSync(TAR_BIN, ['-xf', tmpZip, '-C', stage], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      if (ex.error || ex.status !== 0) {
        cleanup();
        sendJson(res, 500, { error: 'extract_failed', message: String((ex.stderr || ex.stdout || (ex.error && ex.error.message) || ('exit ' + ex.status))) });
        return;
      }
    } else if (useDitto) {
      ex = spawnSync(DITTO_BIN, ['-x', '-k', tmpZip, stage], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: UNZIP_ENV, windowsHide: true });
      if (ex.status !== 0) {
        cleanup();
        sendJson(res, 500, { error: 'extract_failed', message: String(ex.stderr || ex.stdout || ('exit ' + ex.status)) });
        return;
      }
    } else {
      ex = spawnSync(UNZIP_BIN, ['-o', '-qq', tmpZip, '-d', stage], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: UNZIP_ENV, windowsHide: true });
      if (ex.status !== 0 && ex.status !== 1) { // 1 = 警告 → 許容
        cleanup();
        sendJson(res, 500, { error: 'extract_failed', message: String(ex.stderr || ex.stdout || ('exit ' + ex.status)) });
        return;
      }
    }

    // (3) staging → targetDir へ build/・隠し・シンボリックリンクを除いてコピー
    //   (各コピー先が projects/<id>/ 配下か realpath で検証)。
    let rpBase;
    try { rpBase = fs.realpathSync(projectDir(id)); } catch (e) { rpBase = projectDir(id); }
    try { fs.mkdirSync(targetAbs, { recursive: true }); } catch (e) {}
    const cp = copyExtractedFiltered(stage, targetAbs, rpBase);
    cleanup();
    if (cp.escaped) {
      sendJson(res, 403, { error: 'zip_slip', message: 'extracted path escapes project' }); return;
    }

    touchProject(id);
    const out = [];
    walkProjectTree(projectDir(id), '', out);
    sendJson(res, 200, { ok: true, path: (rawPath || ''), added: cp.copied, fileCount: out.filter((n) => n.type === 'file').length });
  });
}

// フェーズ15: 手動コミット(git add -A && git commit)。変更なしは {nochange:true}。
function handleProjectCommit(id, payload, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const dir = projectDir(id);
  ensureProjectRepo(dir);
  const message = (payload && typeof payload.message === 'string' && payload.message.trim())
    ? payload.message.trim() : 'コミット';
  runGit(dir, ['add', '-A']);
  // ステージ済みの差分が無ければ変更なし(exit 0 = 差分なし)
  const staged = runGit(dir, ['diff', '--cached', '--quiet']);
  if (staged.ok) { sendJson(res, 200, { nochange: true }); return; }
  const c = runGit(dir, ['commit', '-q', '-m', message]);
  if (!c.ok) { sendJson(res, 500, { error: 'commit_failed', message: c.stderr || c.stdout }); return; }
  const log = runGit(dir, ['log', '-1', '--pretty=format:%H%x1f%h%x1f%cI']);
  const parts = (log.stdout || '').split('\x1f');
  // 注: commit では project.json の updatedAt を bump しない(bump すると
  //   直後にツリーが dirty になり nochange 判定を壊すため)。updatedAt は
  //   自動保存(PUT/mkdir/rename/delete)で更新される。
  sendJson(res, 200, { hash: parts[0] || '', shortHash: parts[1] || '', message, ts: parts[2] || '' });
}

// フェーズ15: コミット履歴。
function handleProjectCommits(id, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const dir = projectDir(id);
  const log = runGit(dir, ['log', '--pretty=format:%H%x1f%h%x1f%s%x1f%cI%x1f%an']);
  if (!log.ok) { sendJson(res, 200, []); return; } // まだコミットなし
  const out = String(log.stdout).split('\n').filter((l) => l.trim() !== '').map((line) => {
    const p = line.split('\x1f');
    return { hash: p[0] || '', shortHash: p[1] || '', message: p[2] || '', ts: p[3] || '', author: p[4] || '' };
  });
  sendJson(res, 200, out);
}

// フェーズ15: 変更状態(git status --porcelain)。
function handleProjectStatus(id, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const dir = projectDir(id);
  const st = runGit(dir, ['status', '--porcelain']);
  if (!st.ok) { sendJson(res, 501, { error: 'git_unavailable', message: st.stderr }); return; }
  const files = String(st.stdout).split('\n').filter((l) => l.trim() !== '').map((l) => ({
    status: l.slice(0, 2).trim(), path: l.slice(3),
  }));
  sendJson(res, 200, { dirty: files.length > 0, files });
}

function safeBranchName(dir, raw) {
  const name = String(raw || '').trim();
  if (!name || name.length > 120 || name.charAt(0) === '-') return null;
  const checked = runGit(dir, ['check-ref-format', '--branch', name]);
  return checked.ok ? name : null;
}

function autoCommitWorkingTree(dir, message) {
  runGit(dir, ['add', '-A']);
  const staged = runGit(dir, ['diff', '--cached', '--quiet']);
  if (staged.ok) return null;
  const c = runGit(dir, ['commit', '-q', '-m', message || '原稿版切替前の自動保存']);
  if (!c.ok) return null;
  return (runGit(dir, ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
}

function handleProjectBranches(id, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const dir = projectDir(id); ensureProjectRepo(dir);
  const current = (runGit(dir, ['branch', '--show-current']).stdout || '').trim();
  const refs = runGit(dir, ['for-each-ref', '--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(subject)', 'refs/heads/']);
  if (!refs.ok) { sendJson(res, 500, { error: 'git_failed', message: refs.stderr }); return; }
  const branches = String(refs.stdout || '').split('\n').filter(Boolean).map((line) => {
    const p = line.split('\x1f'); return { name: p[0] || '', updatedAt: p[1] || '', message: p[2] || '', current: p[0] === current };
  });
  sendJson(res, 200, { current, branches });
}

function handleProjectBranchCreate(id, payload, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const dir = projectDir(id); ensureProjectRepo(dir);
  const name = safeBranchName(dir, payload && payload.name);
  if (!name) { sendJson(res, 400, { error: 'invalid_branch', message: '原稿版の名前が不正です。' }); return; }
  autoCommitWorkingTree(dir, '原稿版「' + name + '」作成前の自動保存');
  const made = runGit(dir, ['branch', name]);
  if (!made.ok) { sendJson(res, 409, { error: 'branch_exists', message: made.stderr || '同名の原稿版があります。' }); return; }
  sendJson(res, 201, { ok: true, name, current: false });
}

function handleProjectBranchSwitch(id, payload, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const dir = projectDir(id); ensureProjectRepo(dir);
  const name = safeBranchName(dir, payload && payload.name);
  if (!name) { sendJson(res, 400, { error: 'invalid_branch' }); return; }
  const exists = runGit(dir, ['show-ref', '--verify', '--quiet', 'refs/heads/' + name]);
  if (!exists.ok) { sendJson(res, 404, { error: 'not_found', message: '原稿版が見つかりません。' }); return; }
  const autoCommit = autoCommitWorkingTree(dir, '原稿版切替前の自動保存');
  const switched = runGit(dir, ['switch', name]);
  if (!switched.ok) { sendJson(res, 500, { error: 'switch_failed', message: switched.stderr || switched.stdout }); return; }
  sendJson(res, 200, { ok: true, current: name, autoCommit });
}

function submissionSafeLabel(raw) {
  return String(raw || '提出').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, '-').slice(0, 60) || '提出';
}

function currentProjectBranch(dir) { return (runGit(dir, ['branch', '--show-current']).stdout || '').trim(); }

function handleSubmissionCreate(id, payload, res) {
  const label = String(payload && payload.label || '').trim() || '提出記録';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const submissionId = stamp + '-' + crypto.randomBytes(4).toString('hex');
  const rel = 'submissions/' + submissionId;
  const abs = resolveProjectPath(id, rel);
  try { fs.mkdirSync(path.join(abs, 'files'), { recursive: true }); }
  catch (e) { sendJson(res, 500, { error: 'internal', message: String(e.message) }); return; }
  sendJson(res, 201, { id: submissionId, path: rel, filesPath: rel + '/files', label });
}

function handleSubmissionFreeze(id, submissionId, payload, res) {
  const root = resolveProjectPath(id, 'submissions/' + submissionId);
  if (!root || !fs.existsSync(root) || fs.existsSync(path.join(root, 'manifest.json'))) {
    sendJson(res, 409, { error: 'not_found_or_frozen' }); return;
  }
  const filesDir = path.join(root, 'files');
  let names = [];
  try { names = fs.readdirSync(filesDir).filter((n) => fs.statSync(path.join(filesDir, n)).isFile()).sort(); } catch (e) {}
  if (!names.length) { sendJson(res, 400, { error: 'no_files', message: '提出ファイルを1件以上アップロードしてください。' }); return; }
  const dir = projectDir(id); const createdAt = new Date().toISOString();
  const branch = currentProjectBranch(dir);
  const commit = (runGit(dir, ['rev-parse', 'HEAD']).stdout || '').trim();
  const label = String(payload && payload.label || submissionId).trim();
  const files = names.map((name) => { const data = fs.readFileSync(path.join(filesDir, name)); return { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }; });
  const subject = String(payload && payload.subject || ('[提出記録] ' + label)).trim();
  const body = String(payload && payload.body || (label + 'の提出ファイルを共有します。\n\n提出日時: ' + createdAt + '\n原稿版: ' + (branch || '(不明)') + '\nファイル:\n' + files.map((f) => '- ' + f.name).join('\n'))).trim();
  const manifest = { schema: 1, frozen: true, label, createdAt, branch, commit, files };
  atomicWriteFileSync(path.join(root, 'email.txt'), '件名: ' + subject + '\n\n' + body + '\n');
  atomicWriteFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  try { fs.chmodSync(path.join(root, 'manifest.json'), 0o444); fs.chmodSync(path.join(root, 'email.txt'), 0o444); files.forEach((f) => fs.chmodSync(path.join(filesDir, f.name), 0o444)); } catch (e) {}
  autoCommitWorkingTree(dir, '提出記録を凍結: ' + label);
  sendJson(res, 200, { ok: true, id: submissionId, path: 'submissions/' + submissionId, manifest, email: { subject, body } });
}

function handleSubmissionList(id, res) {
  const base = resolveProjectPath(id, 'submissions'); let out = [];
  try {
    out = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
      try { const m = JSON.parse(fs.readFileSync(path.join(base, e.name, 'manifest.json'), 'utf8')); return { id: e.name, path: 'submissions/' + e.name, label: m.label, createdAt: m.createdAt, branch: m.branch, files: m.files || [] }; } catch (x) { return null; }
    }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch (e) {}
  sendJson(res, 200, out);
}

// フェーズ15: 復元。復元前に未コミット変更を自動コミットしてから該当コミットへ復元。
function handleProjectRestore(id, payload, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  const hash = payload && payload.hash;
  if (typeof hash !== 'string' || !GIT_HASH_RE.test(hash)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid hash' }); return;
  }
  const dir = projectDir(id);
  const verify = runGit(dir, ['cat-file', '-e', hash + '^{commit}']);
  if (!verify.ok) { sendJson(res, 404, { error: 'not_found', message: 'commit not found' }); return; }
  // 安全のため復元前に未コミット変更を自動コミット
  runGit(dir, ['add', '-A']);
  const staged = runGit(dir, ['diff', '--cached', '--quiet']);
  let autoCommit = null;
  if (!staged.ok) {
    const c = runGit(dir, ['commit', '-q', '-m', '復元前の自動保存']);
    if (c.ok) autoCommit = (runGit(dir, ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
  }
  // 作業ツリーを該当コミットの内容へ復元
  const r = runGit(dir, ['checkout', hash, '--', '.']);
  if (!r.ok) { sendJson(res, 500, { error: 'restore_failed', message: r.stderr || r.stdout }); return; }
  sendJson(res, 200, { ok: true, restored: hash, autoCommit });
}

// フェーズ15(任意): コミットと作業ツリーの差分。
function handleProjectDiff(id, hash, res) {
  if (!hasGit()) { sendJson(res, 501, { error: 'git_unavailable' }); return; }
  if (typeof hash !== 'string' || !GIT_HASH_RE.test(hash)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid hash' }); return;
  }
  const dir = projectDir(id);
  const verify = runGit(dir, ['cat-file', '-e', hash + '^{commit}']);
  if (!verify.ok) { sendJson(res, 404, { error: 'not_found' }); return; }
  const d = runGit(dir, ['diff', hash]);
  sendJson(res, 200, { hash, diff: d.stdout || '' });
}

function handleProjectDownload(id, res) {
  const meta = readProjectMeta(id);
  const fname = (String(meta.name || id).replace(/[^A-Za-z0-9._-]+/g, '_') || id) + '.zip';
  // フェーズ21: win32 は tar.exe(bsdtar)で zip を stdout ストリーム生成。
  //   darwin は現行どおり /usr/bin/zip を直書き。
  let child;
  if (IS_WIN) {
    if (!tarAvailable()) { sendJson(res, 501, { error: 'zip_unavailable', message: 'server tar not available; use client-side fallback' }); return; }
    child = spawn(TAR_BIN, ['--format', 'zip', '-cf', '-', '--exclude', 'build', '--exclude', 'build/*', '.'], {
      cwd: projectDir(id), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } else {
    let hasZip = false;
    try { hasZip = fs.statSync('/usr/bin/zip').isFile(); } catch (e) { hasZip = false; }
    if (!hasZip) { sendJson(res, 501, { error: 'zip_unavailable', message: 'server zip not available; use client-side fallback' }); return; }
    child = spawn('/usr/bin/zip', ['-r', '-q', '-X', '-', '.', '-x', 'build/*'], {
      cwd: projectDir(id), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  }
  let headSent = false;
  child.on('error', (err) => {
    if (!res.writableEnded) sendJson(res, 500, { error: 'internal', message: 'zip spawn failed: ' + err.message });
  });
  child.stdout.on('data', (d) => {
    if (!headSent) {
      headSent = true;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
      });
    }
    res.write(d);
  });
  child.on('close', (code) => {
    if (!headSent && !res.writableEnded) {
      // 内容ゼロ(空プロジェクト)でも zip はヘッダを出す。到達時のみフォールバック。
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
      });
    }
    if (!res.writableEnded) res.end();
  });
}

// プロジェクト対応コンパイル: projects/<id>/ を cwd に latexmk 実行、成果物は build/。
function enqueueProjectCompile(id, res) {
  const mainTex = path.join(projectDir(id), 'main.tex');
  let src;
  try { src = fs.readFileSync(mainTex, 'utf8'); } catch (e) {
    sendJson(res, 400, { error: 'bad_request', message: 'main.tex not found in project' }); return;
  }
  // フェーズ10e: main.tex を走査して絶対パス/親参照のファイルアクセスを拒否
  if (latexFileAccessViolation(src)) {
    sendJson(res, 400, { error: 'forbidden_path', message: 'absolute path / parent-directory file access is not allowed' });
    return;
  }
  enqueueJob(function (jobRes, finish) { runProjectCompile(id, jobRes, finish); }, res);
}

function runProjectCompile(id, res, finish) {
  const dir = projectDir(id);
  const buildDir = path.join(dir, 'build');
  const done = (fn) => {
    try { fn(); } catch (e) {
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal', message: String(e && e.message) });
    }
    finish();
  };
  try {
    fs.mkdirSync(buildDir, { recursive: true });
    // stale-aux 掃除(前回成果物・補助ファイル)
    for (const ext of ['pdf', 'aux', 'bbl', 'blg', 'log', 'out', 'toc', 'lof', 'lot', 'fls', 'fdb_latexmk', 'xdv', 'run.xml']) {
      try { fs.unlinkSync(path.join(buildDir, 'main.' + ext)); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    return done(() => sendJson(res, 500, { error: 'internal', message: String(e && e.message) }));
  }

  // フェーズ10e: paranoid(絶対パス・`..`・隠しファイル拒否。cwd 配下の相対参照
  //   = main.tex / refs.bib / assets/ と kpathsea 検索のパッケージ類は従来どおり)。
  const env = Object.assign({}, process.env, {
    PATH: buildPath(texPathExtras(false)),   // フェーズ21: path.delimiter + プラットフォーム別追加PATH
    openin_any: 'p',
    openout_any: 'p',
    TEXMFOUTPUT: buildDir,
  });

  const child = spawn(
    'latexmk',
    ['-xelatex', '-interaction=nonstopmode', '-halt-on-error', '-output-directory=build', 'main.tex'],
    { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  let stdout = '';
  let timedOut = false;
  let settled = false;
  child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
  child.stderr.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);   // フェーズ21: win32 は taskkill /T /F で子ツリーごと終了
  }, COMPILE_TIMEOUT_MS);

  child.on('error', (err) => {
    if (settled) return; settled = true; clearTimeout(timer);
    done(() => sendJson(res, 500, { error: 'internal', message: 'latexmk spawn failed: ' + err.message }));
  });

  child.on('close', (code) => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (timedOut) return done(() => sendJson(res, 500, { error: 'timeout' }));
    const pdfPath = path.join(buildDir, 'main.pdf');
    if (code === 0 && fs.existsSync(pdfPath)) {
      touchProject(id);
      return done(() => {
        const pdf = fs.readFileSync(pdfPath);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
        res.end(pdf);
      });
    }
    let log = stdout;
    try { log = fs.readFileSync(path.join(buildDir, 'main.log'), 'utf8'); } catch (e) { /* fall back */ }
    return done(() => sendJson(res, 422, { error: 'compile_failed', log: String(log).slice(-LOG_TAIL) }));
  });
}

// プロジェクト系ルートを処理。処理した場合 true。
function handleProjectRoutes(req, res, urlPath) {
  const method = req.method;
  const query = require('url').parse(req.url, true).query;

  if (urlPath === '/projects') {
    if (method === 'GET') { handleProjectsList(res); return true; }
    if (method === 'POST') {
      readJsonBody(req, res, (payload) => {
        const id = createProject(payload && payload.name, null);
        sendJson(res, 200, { id });
      });
      return true;
    }
    return false;
  }

  if (urlPath === '/projects/import') {
    if (method === 'POST') {
      readJsonBody(req, res, (payload) => {
        const p = payload || {};
        const id = createProject(p.name, { html: p.html, bib: p.bib, comments: p.comments });
        sendJson(res, 200, { id });
      });
      return true;
    }
    return false;
  }

  const m = urlPath.match(/^\/projects\/([A-Za-z0-9]{8})(\/[A-Za-z0-9_.\/-]+)?$/);
  if (!m) return false;
  const id = m[1];
  const sub = m[2] || '';

  if (!projectExists(id)) { sendJson(res, 404, { error: 'not_found' }); return true; }

  if (sub === '' || sub === '/') {
    if (method === 'DELETE') { handleProjectDelete(id, res); return true; }
    if (method === 'GET') { sendJson(res, 200, Object.assign({ id }, readProjectMeta(id))); return true; }
    if (method === 'PATCH') {
      readJsonBody(req, res, (payload) => { handleProjectPatch(id, payload, res); });
      return true;
    }
    return false;
  }
  // フェーズ20: プロジェクト単位のライブセッション(SSE 中継 / op)
  if (sub === '/live-events' && method === 'GET') { handleProjectLiveEvents(req, res, id, query); return true; }
  if (sub === '/live-op' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectLiveOp(id, payload, res); });
    return true;
  }
  if (sub === '/tree' && method === 'GET') { handleProjectTree(id, res); return true; }
  if (sub === '/document-bundle' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectDocumentBundle(id, payload, res); });
    return true;
  }
  if (sub === '/file') {
    if (method === 'GET') { handleProjectFileGet(id, query.path, res); return true; }
    if (method === 'PUT') { handleProjectFilePut(id, query.path, req, res); return true; }
    if (method === 'DELETE') { handleProjectFileDelete(id, query.path, res); return true; }
    return false;
  }
  if (sub === '/rename' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectRename(id, payload, res); });
    return true;
  }
  if (sub === '/meta' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectMeta(id, payload, res); });
    return true;
  }
  if (sub === '/download' && method === 'GET') { handleProjectDownload(id, res); return true; }
  // フェーズ15c: フォルダごとの取り込み(zip を展開)
  if (sub === '/upload-folder' && method === 'POST') {
    handleProjectUploadFolder(id, query.path, req, res);
    return true;
  }
  // フェーズ15: 柔軟なディレクトリ + git バージョン管理
  if (sub === '/mkdir' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectMkdir(id, payload && payload.path, res); });
    return true;
  }
  if (sub === '/commit' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectCommit(id, payload, res); });
    return true;
  }
  if (sub === '/commits' && method === 'GET') { handleProjectCommits(id, res); return true; }
  if (sub === '/status' && method === 'GET') { handleProjectStatus(id, res); return true; }
  if (sub === '/branches' && method === 'GET') { handleProjectBranches(id, res); return true; }
  if (sub === '/branches' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectBranchCreate(id, payload, res); }); return true;
  }
  if (sub === '/branches/switch' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectBranchSwitch(id, payload, res); }); return true;
  }
  if (sub === '/submissions' && method === 'GET') { handleSubmissionList(id, res); return true; }
  if (sub === '/submissions' && method === 'POST') { readJsonBody(req, res, (payload) => { handleSubmissionCreate(id, payload, res); }); return true; }
  {
    const sm = sub.match(/^\/submissions\/([^/]+)\/freeze$/);
    if (sm && method === 'POST') { readJsonBody(req, res, (payload) => { handleSubmissionFreeze(id, sm[1], payload, res); }); return true; }
  }
  if (sub === '/restore' && method === 'POST') {
    readJsonBody(req, res, (payload) => { handleProjectRestore(id, payload, res); });
    return true;
  }
  if (sub === '/diff' && method === 'GET') { handleProjectDiff(id, query.hash, res); return true; }
  return false;
}

const server = http.createServer((req, res) => {
  // ローカルアプリでも LAN 共有や悪意ある埋め込みを想定し、全応答に最低限の
  // ブラウザ防御を付ける。個別ルートの CSP はこれらに追加される。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const urlPath = req.url.split('?')[0];

  // フェーズ15: プロジェクト系ルート(CRUD/tree/file/rename/meta/download)
  if (handleProjectRoutes(req, res, urlPath)) return;

  // フェーズ8: DOI 照合プロキシ
  if (req.method === 'GET' && urlPath === '/doi-meta') {
    handleDoiMeta(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/doi-search') {
    handleDoiSearch(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/compile') {
    readJsonBody(req, res, (payload) => {
      // フェーズ15: projectId 指定時は projects/<id>/ を cwd にコンパイル
      if (payload && typeof payload.projectId === 'string') {
        if (!projectExists(payload.projectId)) {
          sendJson(res, 404, { error: 'not_found', message: 'project not found' });
          return;
        }
        enqueueProjectCompile(payload.projectId, res);
        return;
      }
      // 後方互換: 従来の {latex, assets}
      if (!payload || typeof payload.latex !== 'string' || payload.latex.length === 0) {
        sendJson(res, 400, { error: 'bad_request', message: 'latex (string) or projectId is required' });
        return;
      }
      if (latexFileAccessViolation(payload.latex)) {
        sendJson(res, 400, { error: 'forbidden_path', message: 'absolute path / parent-directory file access is not allowed' });
        return;
      }
      enqueueCompile(payload, res);
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/compile-accessible') {
    readJsonBody(req, res, (payload) => {
      if (!payload || typeof payload.latex !== 'string' || payload.latex.length === 0) {
        sendJson(res, 400, { error: 'bad_request', message: 'latex (string) is required' });
        return;
      }
      if (latexFileAccessViolation(payload.latex)) {
        sendJson(res, 400, { error: 'forbidden_path', message: 'absolute path / parent-directory file access is not allowed' });
        return;
      }
      enqueueAccessible(payload, res);
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/share') {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
    readJsonBody(req, res, (payload) => {
      handleShareCreate(payload, res);
    });
    return;
  }

  // iPad/LAN → Mac上のCodex 依頼受信箱。依頼の投稿・閲覧はLANから可能だが、
  // 返信はMac上で動くMCP(localhost)だけに限定する。
  if (req.method === 'GET' && urlPath === '/agent/inbox') {
    const query = require('url').parse(req.url, true).query;
    let items = readAgentInbox();
    if (query.project_id) items = items.filter((x) => x.project_id === String(query.project_id));
    if (query.recipient) items = items.filter((x) => (x.recipient || 'codex') === String(query.recipient));
    if (query.status === 'pending' || query.status === 'processing' || query.status === 'answered') {
      items = items.filter((x) => x.status === query.status);
    }
    sendJson(res, 200, items.slice(-100).map(publicAgentRequest));
    return;
  }
  if (req.method === 'POST' && urlPath === '/agent/inbox') {
    readJsonBody(req, res, (payload) => {
      const text = String(payload && payload.text || '').trim();
      if (!text || text.length > 20000) {
        sendJson(res, 400, { error: 'bad_request', message: 'text is required (max 20000 chars)' });
        return;
      }
      const item = { id: crypto.randomBytes(10).toString('hex'), text: text,
        project_id: String(payload && payload.project_id || '').slice(0, 100), status: 'pending',
        recipient: payload && payload.recipient === 'claude_code' ? 'claude_code' : 'codex',
        context: null,
        thread_id: String(payload && payload.thread_id || '').slice(0, 100),
        reply: '', createdAt: new Date().toISOString(), answeredAt: null };
      if (payload && payload.context && typeof payload.context === 'object') {
        const contextText = String(payload.context.text || '').trim().slice(0, 30000);
        if (contextText) item.context = {
          kind: payload.context.kind === 'note' ? 'note' : 'document',
          path: String(payload.context.path || '').slice(0, 500),
          text: contextText,
        };
      }
      const items = readAgentInbox(); items.push(item); writeAgentInbox(items);
      sendJson(res, 201, publicAgentRequest(item));
    });
    return;
  }
  {
    const inboxMatch = urlPath.match(/^\/agent\/inbox\/([a-f0-9]{20})$/);
    if (req.method === 'PATCH' && inboxMatch) {
      if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
      readJsonBody(req, res, (payload) => {
        const partial = payload && Object.prototype.hasOwnProperty.call(payload, 'partial');
        if (partial) {
          const text = String(payload.partial || '').slice(0, 50000);
          const items = readAgentInbox();
          const item = items.find((x) => x.id === inboxMatch[1]);
          if (!item) { sendJson(res, 404, { error: 'not_found' }); return; }
          item.reply = text; item.status = 'processing'; item.answeredAt = null;
          writeAgentInbox(items); sendJson(res, 200, publicAgentRequest(item)); return;
        }
        const reply = String(payload && payload.reply || '').trim();
        if (!reply || reply.length > 50000) {
          sendJson(res, 400, { error: 'bad_request', message: 'reply is required (max 50000 chars)' }); return;
        }
        const items = readAgentInbox();
        const item = items.find((x) => x.id === inboxMatch[1]);
        if (!item) { sendJson(res, 404, { error: 'not_found' }); return; }
        item.reply = reply; item.status = 'answered'; item.answeredAt = new Date().toISOString();
        item.pointers = [];
        if (payload && Array.isArray(payload.pointers)) {
          item.pointers = payload.pointers.slice(0, 12).map((p) => ({
            kind: p && p.kind === 'document' ? 'document' : 'file',
            label: String(p && p.label || '').slice(0, 300),
            path: String(p && p.path || '').slice(0, 500),
            text: String(p && p.text || '').slice(0, 5000),
            page: Math.max(0, Math.floor(Number(p && p.page) || 0)),
          })).filter((p) => p.kind === 'document' ? !!p.text : !!p.path);
        }
        writeAgentInbox(items); sendJson(res, 200, publicAgentRequest(item));
      });
      return;
    }
  }

  // フェーズ5: Agent ブリッジ(フェーズ10a: loopback 限定)
  if (req.method === 'GET' && urlPath === '/events') {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
    handleEvents(req, res);
    return;
  }

  // フェーズ6: ライブ共同編集
  //   フェーズ13: view 共有では編集系を 403 view_only
  //   フェーズ13b: comment 共有は配信/購読/start/op を許可し、op 種別で本文改変を制限
  {
    let m;
    const editMatch = urlPath.match(/^\/edit(?:-events)?\/([A-Za-z0-9]{8})(?:\/(?:start|op))?$/);
    if (editMatch) {
      const editShare = findShare(editMatch[1]);
      // 共有が存在し view 権限なら、閲覧のみとして編集系エンドポイントを拒否
      if (editShare && sharePermission(editShare) === 'view') {
        sendJson(res, 403, { error: 'view_only' });
        return;
      }
    }
    if (req.method === 'GET' && (m = urlPath.match(/^\/edit-events\/([A-Za-z0-9]{8})$/))) {
      const query = require('url').parse(req.url, true).query;
      handleEditEvents(req, res, m[1], query);
      return;
    }
    if (req.method === 'POST' && (m = urlPath.match(/^\/edit\/([A-Za-z0-9]{8})\/start$/))) {
      readJsonBody(req, res, (payload) => { handleEditStart(m[1], payload, res); });
      return;
    }
    if (req.method === 'POST' && (m = urlPath.match(/^\/edit\/([A-Za-z0-9]{8})\/op$/))) {
      readJsonBody(req, res, (payload) => { handleEditOp(m[1], payload, res); });
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (m = urlPath.match(/^\/edit\/([A-Za-z0-9]{8})$/))) {
      handleEditPage(m[1], res);
      return;
    }
  }
  if (req.method === 'POST' && urlPath === '/agent/rpc') {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
    readJsonBody(req, res, (payload) => { handleAgentRpc(payload, res); });
    return;
  }
  if (req.method === 'POST' && urlPath === '/agent/result') {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
    readJsonBody(req, res, (payload) => { handleAgentResult(payload, res); });
    return;
  }

  if (req.method === 'GET' && urlPath === '/shares') {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
    // ダッシュボード用: html/latex は含めない一覧
    const lanIp = getLanIPv4();
    sendJson(res, 200, shares.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      permission: sharePermission(s),
      url: `http://${lanIp}:${PORT}/s/${s.id}`,
    })));
    return;
  }

  // フェーズ13: 権限の後変更 POST /s/:id/permission {permission}
  if (req.method === 'POST') {
    const pm = urlPath.match(/^\/s\/([A-Za-z0-9]{8})\/permission$/);
    if (pm) {
      if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
      const share = findShare(pm[1]);
      if (!share) { sendJson(res, 404, { error: 'not_found' }); return; }
      readJsonBody(req, res, (payload) => {
        const permission = normalizePermission(payload && payload.permission);
        share.permission = permission;
        saveShares();
        sendJson(res, 200, { id: share.id, permission });
      });
      return;
    }
  }

  if (req.method === 'DELETE') {
    const m = urlPath.match(/^\/s\/([^/]+)$/);
    if (m) {
      if (!isLoopback(req)) { sendJson(res, 403, { error: 'local_only' }); return; }
      const idx = shares.findIndex((s) => s.id === m[1]);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        shares.splice(idx, 1);
        saveShares();
        res.writeHead(204);
        res.end();
      }
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (handleShareRoutes(req, res, urlPath)) return;
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});

// フェーズ21: 直接実行時のみ起動。require されたとき(ユニットテスト)は起動せず、
//   プラットフォーム分岐のヘルパーを export して win32 相当の入力を検証できるようにする。
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`TailorTeX: http://localhost:${PORT}`);
    if (process.env.RATEX_AGENT_WORKER !== '0') {
      require('./agent-worker').startAgentWorker({ port: PORT });
      console.log('TailorTeX AIブリッジ: Codex / Claude Code の受信待機中');
    }
  });
}

module.exports = {
  server,
  IS_WIN,
  texPathExtras, buildPath, winTexlivePaths,
  resolveSpawn, quoteWinArg, killTree,
  isReservedName, sanitizeAssetName, sanitizeFolder, resolveProjectPath,
  atomicWriteFileSync, backupBeforeOverwrite, catastrophicTexShrink, safeProjectWriteSync, writeDocumentBundleSync,
  isLoopback, latexFileAccessViolation,
  pythonCandidates, verapdfCandidates,
};
