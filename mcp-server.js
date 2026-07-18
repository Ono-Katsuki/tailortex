#!/usr/bin/env node
/*
 * mcp-server.js — TailorTeX MCP サーバー(stdio)
 *
 * Claude Code / Claude Desktop から MCP 経由でブラウザ上のエディタを操作する。
 * すべてのツールは HTTP(localhost:3000)の POST /agent/rpc への薄いラッパーで、
 * サーバー → SSE → ブラウザ(agent-bridge.js)が実際の #doc 操作を行う。
 * 文書の「正」の状態はブラウザで開いているエディタ側にある。
 */
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const EDITOR_URL = process.env.EDITOR_URL || 'http://localhost:3000';
const RATEX_AGENT = process.env.RATEX_AGENT === 'claude_code' ? 'claude_code' : 'codex';
const NO_EDITOR_MSG =
  'エディタに接続できません。ブラウザで ' + EDITOR_URL +
  ' を開いてください(サーバーが起動していない場合は `node server.js` も必要です)。';

// ---------------------------------------------------------------------------
// /agent/rpc への転送。返り値はブラウザが返した result。失敗時は Error を投げる。
// ---------------------------------------------------------------------------
async function rpc(method, params) {
  let res;
  try {
    res = await fetch(EDITOR_URL + '/agent/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: method, params: params || {} }),
    });
  } catch (e) {
    // サーバー自体に繋がらない(未起動)
    throw new Error(NO_EDITOR_MSG);
  }

  if (res.status === 503) {
    throw new Error(NO_EDITOR_MSG);
  }
  if (res.status === 504) {
    throw new Error('エディタからの応答がタイムアウトしました(15秒)。ブラウザのタブがアクティブか確認してください。');
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error('エディタ応答の解析に失敗しました(HTTP ' + res.status + ')。');
  }

  if (res.status !== 200) {
    throw new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
  }
  if (body && body.ok === false) {
    throw new Error(String(body.error || '不明なエラー'));
  }
  return body ? body.result : null;
}

// ---------------------------------------------------------------------------
// フェーズ16: プロジェクト HTTP API(http://localhost:3000/projects/...)を
// mcp-server が直接呼ぶ。ブラウザ(agent-bridge)未接続でもファイル作業ができる。
// ---------------------------------------------------------------------------
const NO_SERVER_MSG =
  'サーバーに接続できません。' + EDITOR_URL +
  ' で `node server.js` が起動しているか確認してください。';

async function projectFetch(method, apiPath, opts) {
  opts = opts || {};
  const init = { method: method, headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(EDITOR_URL + apiPath, init);
  } catch (e) {
    throw new Error(NO_SERVER_MSG);
  }
  return res;
}

// 非2xx を分かりやすい日本語エラーに変換する
function projectErrorMessage(status, code, message) {
  if (status === 404) return 'プロジェクトまたはファイルが見つかりません(not_found)。project_id と path を確認してください。';
  if (status === 403 || code === 'forbidden_path') {
    return 'パスが不正です。projects/<id>/ 配下の相対パスのみ指定できます(絶対パス・「..」・先頭ドットの隠しファイルは不可)。';
  }
  if (status === 501 || code === 'git_unavailable') return 'サーバー側で git が利用できないため、この操作は実行できません。';
  if (status === 413) return 'ファイルが大きすぎます(上限超過)。';
  if (status === 422 || code === 'compile_failed') return 'コンパイルに失敗しました。';
  return (message || code) ? String(message || code) + '(HTTP ' + status + ')' : ('HTTP ' + status);
}

// JSON を返すプロジェクト API を呼ぶ(非2xx は throw)
async function projectJson(method, apiPath, body) {
  const res = await projectFetch(method, apiPath, body === undefined ? {} : { body: body });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!res.ok) {
    throw new Error(projectErrorMessage(res.status, data && data.error, data && data.message));
  }
  return data;
}

// project_id 省略時は agent-bridge 経由で現在プロジェクトを解決する。
// ブラウザ未接続 or 未選択なら分かりやすいエラーを投げる。
async function resolveProjectId(args) {
  if (args && args.project_id) return String(args.project_id);
  let cur;
  try {
    cur = await rpc('get_current_project', {});
  } catch (e) {
    throw new Error('project_id が省略されており、かつエディタ(ブラウザ)に接続できません。' +
      'project_id を指定するか、ブラウザで ' + EDITOR_URL + ' を開いてプロジェクトを選択してください。');
  }
  if (!cur || !cur.id) {
    throw new Error('現在エディタで開いているプロジェクトがありません。' +
      'project_id を指定するか、エディタでプロジェクトを開いてください。');
  }
  return String(cur.id);
}

// content-type からテキスト系か判定
function isTextContentType(ct) {
  ct = String(ct || '').toLowerCase();
  return ct.indexOf('text/') === 0 || ct.indexOf('json') !== -1 ||
    ct.indexOf('xml') !== -1 || ct.indexOf('javascript') !== -1;
}

// ---------------------------------------------------------------------------
// フェーズ25: 配置規約の検証(MCP 層)。
//   許可 = notes/**・attachments/**・refs.bib。それ以外は拒否し、
//   「何がだめか + 正しい置き場所 + force:true で回避可」を短く伝える。
//   force が真なら検証をスキップ(ユーザーの明示指示がある場合用)。
//   問題なければ null、拒否理由があればエラーメッセージ文字列を返す。
// ---------------------------------------------------------------------------
function checkPlacementPolicy(rawPath, force) {
  if (force) return null;
  const rel = String(rawPath || '').replace(/\\/g, '/');
  const segs = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) return 'パスが空です。notes/ か attachments/ 配下の相対パスを指定してください。';
  const top = segs[0];
  if (top === 'notes' || top === 'attachments') return null;
  if (segs.length === 1 && top === 'refs.bib') return null;
  if (top === 'build') {
    return 'build/ はコンパイル出力の不可侵領域のため書き込めません(read/DL のみ可)。' +
      'メモは notes/、資料は attachments/ に置いてください。';
  }
  return '「' + rel + '」は配置規約に反します。Claude が新規に作るファイルは ' +
    'notes/(メモ・下書き・テキスト)か attachments/(資料バイナリ)配下に、' +
    '参考文献は refs.bib に置いてください。この場所に書く必要がある場合のみ force:true を指定してください。';
}

// BibTeX テキストからエントリのキーを抽出する(@article{key, ... の key)。
function extractBibKeys(bibtex) {
  const keys = [];
  const re = /@\s*[A-Za-z]+\s*\{\s*([^,\s{}]+)\s*,/g;
  let m;
  while ((m = re.exec(String(bibtex || '')))) { if (m[1]) keys.push(m[1]); }
  return keys;
}

function safeProjectLinkPath(raw) {
  const p = String(raw || '').replace(/\\/g, '/').trim();
  if (!p || /^(?:[A-Za-z]:|\/|\\)|(?:^|\/)\.\.(?:\/|$)/.test(p) || /[\r\n]/.test(p)) {
    throw new Error('ファイルリンクはプロジェクト内の安全な相対パスを指定してください: ' + p);
  }
  return p;
}

async function markdownLinkLine(id, link) {
  const label = String(link.label || '').replace(/[\[\]\r\n]/g, '').trim();
  const target = String(link.target || '').trim();
  if (!label || !target) throw new Error('リンクの label と target は空にできません。');
  if (link.kind === 'url') {
    if (!/^https?:\/\/[^\s]+$/i.test(target)) throw new Error('外部リンクは http:// または https:// URLを指定してください: ' + target);
    return '- [' + label + '](' + target.replace(/[()]/g, encodeURIComponent) + ')';
  }
  if (link.kind !== 'file') throw new Error('kind は url または file を指定してください。');
  const p = safeProjectLinkPath(target);
  const tree = await projectJson('GET', '/projects/' + encodeURIComponent(id) + '/tree');
  const exists = (Array.isArray(tree) ? tree : []).some(function (entry) {
    return entry && entry.type === 'file' && entry.path === p;
  });
  if (!exists) throw new Error('リンク先ファイルが見つかりません: ' + p + '。list_project_files で確認してください。');
  const page = link.page == null ? null : Number(link.page);
  if (page != null && (!Number.isInteger(page) || page < 1)) throw new Error('page は1以上の整数を指定してください。');
  return '- [' + label + '](project:' + encodeURI(p).replace(/[()]/g, encodeURIComponent) + (page ? '#page=' + page : '') + ')';
}

async function notifyProjectFilesChanged(id) {
  try {
    await Promise.race([
      rpc('refresh_project_files', { id: id }),
      new Promise(function (resolve) { setTimeout(resolve, 400); }),
    ]);
  } catch (e) { /* ブラウザ未接続でもファイル操作自体は成功扱い */ }
}

// ---------------------------------------------------------------------------
// ツール定義(名前 / 日本語説明(入力例つき)/ 入力スキーマ)
// ---------------------------------------------------------------------------
const STYLE_ENUM = ['normal', 'h1', 'h2', 'h3', 'title', 'subtitle', 'quote', 'code'];

const TOOLS = [
  {
    name: 'get_document',
    description:
      '現在ブラウザで開いている文書の内容を取得する。返り値は文書名(title)、本文HTML(html)、プレーンテキスト(text)、文字数(charCount)。' +
      '編集や校正の前に、まずこのツールで現在の文書内容を確認すること。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_latex',
    description:
      '現在の文書から生成された LaTeX ソース(.tex 全文)を取得する。プリアンブル・本文を含む完全な .tex が返る。' +
      'LaTeX の確認・レビューや、数式・表の LaTeX 表現を見たいときに使う。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_document',
    description:
      '文書全体を指定した HTML で置き換える(既存の本文はすべて破棄される)。HTML はエディタの許可 DOM に自動正規化される。' +
      '使える主なタグ: <h1>〜<h3>(見出し)、<p>(段落)、<p class="title">(表題)、<p class="subtitle">(副題)、' +
      '<blockquote>(引用)、<pre class="code">(コード)、<ul>/<ol>/<li>(箇条書き)、<table>/<tr>/<td>(表)、<hr>、' +
      'インライン: <strong> <em> <u> <s> <sub> <sup>、<a href>。' +
      '入力例: {"html": "<h1>はじめに</h1><p>本文です。<strong>重要</strong>。</p>"}',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '文書全体の新しい HTML。' },
      },
      required: ['html'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_content',
    description:
      '文書の一部に HTML を挿入する(既存内容は保持)。position で挿入位置を指定する: ' +
      '"end"(末尾・既定)、"start"(先頭)、"after_heading"(heading で指定した見出しテキストの直後)。' +
      'HTML は set_document と同じ許可 DOM に正規化される。' +
      '入力例(末尾に段落追加): {"html": "<p>追記します。</p>", "position": "end"} / ' +
      '入力例(「方法」という見出しの後に挿入): {"html": "<p>手順1…</p>", "position": "after_heading", "heading": "方法"}',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '挿入する HTML。' },
        position: {
          type: 'string',
          enum: ['end', 'start', 'after_heading'],
          description: '挿入位置。既定は "end"。',
        },
        heading: {
          type: 'string',
          description: 'position が "after_heading" のとき、対象の見出しテキスト(完全一致でなくても部分一致で探す)。',
        },
      },
      required: ['html'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_text',
    description:
      '文書本文中のテキストを検索して置換する。find に一致する文字列を replace に置き換える。' +
      'all を true にすると全件、false または省略で最初の1件のみ置換する。返り値は置換件数。' +
      '入力例(全置換): {"find": "コンピュータ", "replace": "コンピューター", "all": true}',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: '検索する文字列。' },
        replace: { type: 'string', description: '置換後の文字列。' },
        all: { type: 'boolean', description: 'true で全件置換、false/省略で最初の1件のみ。' },
      },
      required: ['find', 'replace'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_style',
    description:
      '指定したテキストを含むブロック(段落など)に段落スタイルを適用する。' +
      'style は ' + STYLE_ENUM.join(' / ') + ' のいずれか(h1〜h3=見出し、title=表題、subtitle=副題、quote=引用文、code=コード、normal=標準段落)。' +
      '入力例(「まとめ」を含む段落を見出し1に): {"target_text": "まとめ", "style": "h1"}',
    inputSchema: {
      type: 'object',
      properties: {
        target_text: { type: 'string', description: 'スタイルを適用したいブロックに含まれるテキスト。' },
        style: { type: 'string', enum: STYLE_ENUM, description: '適用する段落スタイル。' },
      },
      required: ['target_text', 'style'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_comment',
    description:
      '本文中で最初に anchor_text が現れる範囲に、校閲コメントを付ける(Word のコメント機能。右側にコメントカードが出る)。' +
      '入力例: {"anchor_text": "重要な仮定", "comment": "この仮定の根拠を明記してください。"}',
    inputSchema: {
      type: 'object',
      properties: {
        anchor_text: { type: 'string', description: 'コメントを付ける対象の本文テキスト(最初の一致箇所)。' },
        comment: { type: 'string', description: 'コメント本文。' },
      },
      required: ['anchor_text', 'comment'],
      additionalProperties: false,
    },
  },
  {
    name: 'compile_pdf',
    description:
      '現在の文書を latexmk(xelatex)で PDF にコンパイルする。成功すればブラウザの PDF プレビューに表示される。' +
      '返り値は成否(ok)と、失敗時はログ末尾(log)。最大60秒待つ。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_documents',
    description:
      'ブラウザ内の単体文書ストア(wordtex-docs)に保存された文書を一覧する(id・タイトル・更新日時・文字数)。' +
      'open_document で開く id を調べるのに使う。入力は不要。' +
      '\n【documents と projects は別物】documents = ブラウザ内の単体文書ストア(1ファイルの下書き向け)。' +
      'projects(list_projects)= サーバー上のディレクトリ(main.tex・refs.bib・assets/ 等を含む本格的な文書一式)。' +
      '通常の執筆作業は projects 側が既定。単発のメモ・下書きだけ documents を使う。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_document',
    description:
      '指定した id の文書を開いて編集対象にする。id は list_documents で取得できる。' +
      '入力例: {"id": "d1a2b3c4"}',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '開く文書の id(list_documents の id)。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_document',
    description:
      '新しい文書を作成して開く。template で雛形を選べる: "blank"(白紙・既定)/ "report"(レポート)/ "mathnote"(数式ノート)/ "minutes"(議事録)。' +
      '入力例: {"template": "report"}',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: ['blank', 'report', 'mathnote', 'minutes'],
          description: '雛形。既定は "blank"。',
        },
      },
      additionalProperties: false,
    },
  },

  // ===== フェーズ9: 自由度強化ツール(ローカル .tex 直接編集に近い操作性)=====
  {
    name: 'edit_html',
    description:
      '【ローカル .tex 編集との対応: Edit ツール相当(厳密文字列置換)】' +
      '現在の文書本文(#doc)の innerHTML に対して、old_string に完全一致する箇所を new_string に置き換える。' +
      'HTML はそのまま(正規化せず)書き込むので、装飾タグや属性まで含めた自由な編集ができる。' +
      '注意: old_string が見つからない場合は「近い箇所の周辺ヒント」をエラーで返す。' +
      '複数箇所に一致し replace_all を指定していない場合は一致件数を添えてエラー(一意にするか replace_all:true を指定)。' +
      '実際の HTML は get_block / get_blocks で確認できる。適用後は編集履歴(undo)・自動保存・共同編集同期に反映される。' +
      '入力例(一意置換): {"old_string": "<strong>重要</strong>", "new_string": "<strong>最重要</strong>"} / ' +
      '入力例(全置換): {"old_string": "TODO", "new_string": "済", "replace_all": true}',
    inputSchema: {
      type: 'object',
      properties: {
        old_string: { type: 'string', description: '置換対象の innerHTML 断片(完全一致)。' },
        new_string: { type: 'string', description: '置換後の HTML。空文字で削除。' },
        replace_all: { type: 'boolean', description: 'true で全一致箇所を置換。既定は false(一意でなければエラー)。' },
      },
      required: ['old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_blocks',
    description:
      '【ローカル .tex 編集との対応: 構造把握(段落=行のマップ)】' +
      '文書を #doc 直下のブロック単位で一覧する。各要素は index(0始まり)・tag(p/h1/table 等)・style(見出し/引用等)・' +
      'bid(共同編集ブロックID・無ければnull)・text(先頭120字)・htmlLength を持つ。' +
      'set_block / get_block / insert_block / delete_block で使う index を調べるのに使う。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_block',
    description:
      '【ローカル .tex 編集との対応: 1行(1段落)の内容確認】' +
      'index で指定したブロックの完全な HTML(html=innerHTML、outerHTML、text)を取得する。' +
      'edit_html の old_string を組み立てる前や set_block の前に、正確な現在値を確認するのに使う。' +
      '入力例: {"index": 2}',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', description: 'ブロックの index(get_blocks で確認)。' } },
      required: ['index'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_block',
    description:
      '【ローカル .tex 編集との対応: ブロック(段落)まるごと書き換え】' +
      'index のブロックを、指定した HTML(許可DOMへ自動正規化)で置き換える。' +
      '見出し化やタグ変更を含むブロック全体の差し替えに使う(複数ブロックの HTML を渡せば1→複数に展開される)。' +
      '空 HTML を渡すとそのブロックを削除する。適用後は undo/自動保存/共同編集同期に反映。' +
      '入力例: {"index": 1, "html": "<h2>新しい見出し</h2>"}',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '置き換えるブロックの index。' },
        html: { type: 'string', description: '新しいブロックの HTML(許可DOMへ正規化される)。' },
      },
      required: ['index', 'html'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_block',
    description:
      '【ローカル .tex 編集との対応: 行の前後への挿入】' +
      'index のブロックの前(before)または後(after・既定)に、新しいブロック(許可DOMへ正規化)を挿入する。' +
      'index が範囲外のときは末尾に追加する。入力例: {"index": 0, "html": "<p>先頭に追記</p>", "position": "before"}',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '基準となるブロックの index。' },
        html: { type: 'string', description: '挿入するブロックの HTML。' },
        position: { type: 'string', enum: ['before', 'after'], description: '挿入位置。既定は "after"。' },
      },
      required: ['index', 'html'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_block',
    description:
      '【ローカル .tex 編集との対応: 1行(1段落)の削除】' +
      'index で指定したブロックを削除する(文書が空になる場合は空段落が補われる)。' +
      '入力例: {"index": 3}',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', description: '削除するブロックの index。' } },
      required: ['index'],
      additionalProperties: false,
    },
  },
  {
    name: 'format_text',
    description:
      '【ローカル .tex 編集との対応: 範囲選択して書式適用(GUI操作の自動化)】' +
      'target_text に一致する範囲を選択し、command(と必要なら value)を適用する。' +
      'target_text は装飾タグまたぎ対応: 「太<strong>字</strong>」のように <strong>/<em> 等で分断された文字列でも、' +
      '表示上のテキスト「太字」を指定すれば範囲選択できる(math/cite/コメント範囲内は除外)。' +
      'command は書式系: bold / italic / underline / strikethrough / subscript / superscript / highlight / foreColor / ' +
      'fontName(value) / fontSize(value) / growFont / shrinkFont / clearFormat / ' +
      'style(value: normal|h1|h2|h3|title|subtitle|quote|code)。' +
      '入力例(太字化): {"target_text": "太字", "command": "bold"} / ' +
      '入力例(見出し化): {"target_text": "まとめ", "command": "style", "value": "h2"}',
    inputSchema: {
      type: 'object',
      properties: {
        target_text: { type: 'string', description: '選択対象の表示テキスト(装飾タグまたぎ可)。' },
        command: { type: 'string', description: '適用するコマンド(bold / style 等)。' },
        value: { type: 'string', description: 'コマンドの値(fontSize や style の値など)。不要なら省略。' },
      },
      required: ['target_text', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'exec_command',
    description:
      '【ローカル .tex 編集との対応: エディタUIコマンドの直接実行(万能パススルー)】' +
      '現在の選択/キャレット位置に対して Editor.exec(command, value) をそのまま実行する。' +
      '選択が必要なコマンドは事前に format_text 等で範囲を作ること(挿入系はキャレット位置、無ければ文末に挿入)。' +
      '\n主なコマンド一覧:' +
      '\n・書式: bold, italic, underline, strikethrough, subscript, superscript, highlight, foreColor, fontName(value), fontSize(value), growFont, shrinkFont, clearFormat' +
      '\n・段落: alignLeft, alignCenter, alignRight, alignJustify, bulletList, numberList, indent, outdent, hr' +
      '\n・スタイル: style(value: normal|h1|h2|h3|title|subtitle|quote|code)' +
      '\n・挿入: insertTable(value "RxC" 例 "2x3"), insertImage, insertLink, insertMath, insertDisplayMath, insertFootnote, pageBreak, toc' +
      '\n・編集: undo, redo, cut, copy, paste, find, selectAll' +
      '\n・校閲: insertComment, deleteComment, prevComment, nextComment, wordCount' +
      '\n・レイアウト: margin(value normal|narrow|wide), orientLandscape, orientPortrait' +
      '\n・アプリ: compile, togglePreview, toggleSource, downloadTex, downloadPdf, zoom(value), zoomIn, zoomOut, zoomReset, save' +
      '\n注意: ダイアログ/ポップオーバーを開くコマンド(insertMath・insertDisplayMath・insertTable・insertImage・insertLink・insertFootnote 等)は ' +
      'ブラウザ側で入力待ちになり MCP では完結しない。数式は insert_math / set_math、引用は insert_citation を使うこと。' +
      '\n入力例(2行3列の表を挿入): {"command": "insertTable", "value": "2x3"}',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '実行するコマンド名(上記一覧のいずれか)。' },
        value: { type: 'string', description: 'コマンドの値(insertTable の "2x3" など)。不要なら省略。' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description:
      '直前の編集操作を1つ取り消す(エディタの元に戻す)。MCP からの編集も含めて履歴に乗っている。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'redo',
    description:
      'undo で取り消した操作をやり直す(エディタのやり直し)。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_outline',
    description:
      '【ローカル .tex 編集との対応: \\section 等の見出しツリー把握(長文ナビ用)】' +
      '文書中の見出し(title / h1 / h2 / h3 / subtitle)を index・level(title/subtitle=0, h1=1, h2=2, h3=3)付きで返す。' +
      '長い文書で編集対象ブロックの見当をつけるのに使う。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ===== フェーズ12: MCP文書検索(grep相当・非破壊の位置特定)=====
  {
    name: 'search_document',
    description:
      '【文書内検索(非破壊・位置特定)】現在ブラウザで開いている文書本文を検索し、一致箇所の位置を返す(文書は変更しない)。' +
      '典型ワークフロー: この search_document で対象箇所の block_index を特定 → get_block でそのブロックの正確な HTML を確認 → ' +
      'edit_html / set_block で編集する(replace_text は単純な文字列一括置換用、こちらは非破壊の検索・位置特定用で役割が異なる)。' +
      '返り値の block_index は get_blocks / get_block の index と一致するので、ヒットしたブロックをそのまま get_block で取り直せる。' +
      '各一致は {block_index, block_tag, line_text(該当ブロックの該当行), match_text, char_offset(行内オフセット), context(前後約40字)}。' +
      'オプション: regex=true で正規表現(無効な正規表現は分かりやすいエラーで返す)、ignore_case=true で大文字小文字を無視、' +
      'whole_word=true で単語境界(\\b)一致、include_math=true で数式(data-tex)も検索対象に含める。max_results は既定50・上限200。' +
      '入力例(部分一致): {"query": "重要"} / ' +
      '入力例(正規表現で数字列): {"query": "\\\\d+", "regex": true} / ' +
      '入力例(大小無視・単語一致): {"query": "latex", "ignore_case": true, "whole_word": true}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索文字列。regex=true のときは正規表現。' },
        regex: { type: 'boolean', description: 'true で query を正規表現として扱う(既定 false=部分一致)。' },
        ignore_case: { type: 'boolean', description: 'true で大文字小文字を無視する。' },
        whole_word: { type: 'boolean', description: 'true で単語境界(\\b)に囲まれた一致のみにする。' },
        max_results: { type: 'integer', description: '返す最大一致件数。既定50・上限200。' },
        include_math: { type: 'boolean', description: 'true で数式(data-tex)も検索対象に含める。既定 false(本文テキストのみ)。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_all_documents',
    description:
      '【全文書横断検索(非破壊)】ローカルに保存された全文書(wordtex-docs ストア)を横断して query を検索する(文書は変更しない)。' +
      '返り値は該当文書ごとに {doc_id, title, match_count, samples(最大3件の {line_text, context})}。' +
      '典型ワークフロー: search_all_documents で該当文書を見つける → open_document で doc_id の文書を開く → ' +
      'search_document で文書内の位置(block_index)を特定 → get_block/edit_html/set_block で編集する。' +
      'オプション: regex=true で正規表現、ignore_case=true で大小無視、max_results は既定50・上限200(返す文書数の上限)。' +
      '入力例: {"query": "四半期報告"} / 入力例(正規表現): {"query": "第\\\\d+章", "regex": true}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索文字列。regex=true のときは正規表現。' },
        regex: { type: 'boolean', description: 'true で query を正規表現として扱う(既定 false=部分一致)。' },
        ignore_case: { type: 'boolean', description: 'true で大文字小文字を無視する。' },
        max_results: { type: 'integer', description: '返す最大文書数。既定50・上限200。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },

  // ===== フェーズ16: MCP プロジェクト操作(ファイル/ツリー/git を直接扱う)=====
  // 使い分け: 文書「本文」(#doc / main.html / main.tex)の編集は本文ツール
  //   (edit_html / set_block / set_document 等)を使う。ここのファイル系ツールで
  //   main.html / main.tex を直接書くと、ブラウザの自動保存で上書きされることがある。
  //   refs.bib・メモ・添付など「補助ファイル」の作成/編集にファイル系ツールを使う。
  {
    name: 'list_projects',
    description:
      '【フェーズ16: プロジェクト一覧】サーバー上の全プロジェクト(ディレクトリ)を一覧する(ブラウザ未接続でも動作)。' +
      '返り値は各プロジェクトの id・name・folder(一覧上のフォルダ。空=ルート)・updatedAt・fileCount。open_project で開く id や、' +
      'ファイル系ツールに渡す project_id を調べるのに使う。入力は不要。' +
      'フォルダ整理は set_project_folder で行う。' +
      '\n【projects と documents は別物】projects = サーバー上のディレクトリ(main.tex・refs.bib・assets/・notes/ 等を含む文書一式。' +
      'git 履歴・コンパイル・添付ファイルを扱える本格的な作業単位)。documents(list_documents)= ブラウザ内の単体文書ストア(1ファイルの下書き)。' +
      '本格的な執筆・研究作業はこの projects 側を使うのが既定。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_current_project',
    description:
      '【フェーズ16】いまエディタ(ブラウザ)で開いているプロジェクトの {id, name} を返す(ブリッジ経由)。' +
      'ファイル系ツールで project_id を省略したときはこのプロジェクトが対象になる。' +
      'ブラウザ未接続または未選択のときは「開いているプロジェクトはありません」と返す。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_project',
    description:
      '【フェーズ16】指定した id のプロジェクトをブラウザのエディタで開く(ブリッジ経由。ブラウザ未接続時はエラー)。' +
      'id は list_projects で取得する。以後 project_id 省略時の既定プロジェクトになる。' +
      '入力例: {"id": "i3WuvYLE"}',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '開くプロジェクトの id(list_projects の id)。' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_project_files',
    description:
      '【フェーズ16】プロジェクトのファイルツリーを一覧する(build/ と隠しファイルは除外)。' +
      '大量プロジェクト向けに query・path_prefix・extension・type で絞り込み、limit/offset でページングできる。' +
      'format="json" なら機械可読JSONを返す。各要素は {path,type,size,ext}。' +
      'project_id 省略時は現在エディタで開いているプロジェクト。作業フロー: list_project_files → read_project_file → write_project_file → commit_project。' +
      '入力例: {} / {"project_id": "i3WuvYLE"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        query: { type: 'string', description: 'パスの部分一致検索(大文字小文字を区別しない)。' },
        path_prefix: { type: 'string', description: 'このフォルダ以下に限定する。' },
        extension: { type: 'string', description: '拡張子で限定(pdf、mdなど。先頭ドットは任意)。' },
        type: { type: 'string', enum: ['file', 'dir'], description: 'ファイルまたはフォルダに限定する。' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '返す件数。既定50、最大200。' },
        offset: { type: 'integer', minimum: 0, description: '先頭からスキップする件数。' },
        format: { type: 'string', enum: ['text', 'json'], description: '出力形式。既定text。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_project_file',
    description:
      '【フェーズ16】プロジェクト内のテキストファイル内容を読む(例: refs.bib、notes/メモ、main.tex の確認)。' +
      'path は projects/<id>/ 配下の相対パス。画像/PDF などバイナリは内容を省略し「バイナリのため省略」注記とサイズだけ返す。' +
      '本文の確認は get_document / get_block 等の本文ツールが正確(main.html は編集途中だと未保存の場合がある)。' +
      'project_id 省略時は現在のプロジェクト。入力例: {"path": "refs.bib"} / {"project_id": "i3WuvYLE", "path": "main.tex"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        path: { type: 'string', description: 'projects/<id>/ 配下の相対パス。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_project_file',
    description:
      '【フェーズ16】プロジェクト内ファイルにテキストを書き込む(親フォルダは自動作成、既存は上書き)。' +
      '用途は refs.bib・メモ(notes/…)・添付テキストなど「補助ファイル」。' +
      '配置規約(強制): 書き込めるのは notes/**(メモ・下書き)・attachments/**(資料バイナリ)・refs.bib のみ。' +
      'それ以外(プロジェクト直下や新トップレベルフォルダ、build/ 配下)は拒否される。どうしても必要な場合のみ force:true で回避可。' +
      '注意: 本文は main.html / main.tex を直接書かず、本文ツール(edit_html / set_block / set_document 等)を使うこと' +
      '(ブラウザの自動保存で上書きされ得るため)。参考文献の追記は add_reference が便利(重複キー検出つき)。' +
      'project_id 省略時は現在のプロジェクト。入力例: {"path": "notes/claude-memo.md", "content": "# レビューメモ\\n- …"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        path: { type: 'string', description: 'projects/<id>/ 配下の相対パス(notes/** ・ attachments/** ・ refs.bib のみ)。' },
        content: { type: 'string', description: '書き込むテキスト内容。' },
        force: { type: 'boolean', description: 'true で配置規約の検証を回避する(通常は不要)。' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_linked_note',
    description:
      'プロジェクトの notes/ 配下に、外部URLやプロジェクト内ファイルへのリンクを含むMarkdownメモを作成する。' +
      'links の kind="file" はプロジェクト内の相対パス、kind="url" は http/https URL。' +
      '作成したメモはファイルツリーからプレビューでき、リンクをクリックして資料を開ける。既存ファイルは上書きしない。' +
      '入力例: {"path":"notes/先行研究.md","title":"先行研究","body":"確認事項",' +
      '"links":[{"label":"論文PDF","target":"attachments/paper.pdf","kind":"file"},' +
      '{"label":"公開ページ","target":"https://example.org/paper","kind":"url"}]}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        path: { type: 'string', description: 'notes/ 配下の .md パス。' },
        title: { type: 'string', description: 'メモの見出し。' },
        body: { type: 'string', description: 'メモ本文(Markdown)。省略可。' },
        links: {
          type: 'array',
          description: 'メモ末尾に追加するリンク。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'リンクの表示名。' },
              target: { type: 'string', description: 'URLまたはプロジェクト内相対パス。' },
              kind: { type: 'string', enum: ['url', 'file'], description: 'リンクの種類。' },
              page: { type: 'integer', minimum: 1, description: 'PDFを開くページ。fileリンクで省略可。' },
            },
            required: ['label', 'target', 'kind'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_linked_note',
    description:
      '既存のMarkdownメモを安全に更新する。action="append" は本文を末尾へ追記、"add_link" はリンクを追加、' +
      '"remove_link" は target が一致するリンク行だけを削除する。ファイル全体を上書きせず研究メモを育てるためのツール。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        path: { type: 'string', description: 'notes/ 配下の既存 .md メモ。' },
        action: { type: 'string', enum: ['append', 'add_link', 'remove_link'] },
        text: { type: 'string', description: 'append で追記するMarkdown。' },
        label: { type: 'string', description: 'add_link の表示名。' },
        target: { type: 'string', description: 'add_link/remove_link のURLまたはプロジェクト内パス。' },
        kind: { type: 'string', enum: ['url', 'file'], description: 'add_link のリンク種類。' },
        page: { type: 'integer', minimum: 1, description: 'fileリンクを開くPDFページ。' },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_project_file',
    description:
      '【フェーズ16】プロジェクト内のファイルまたはフォルダを削除する(フォルダは再帰削除)。' +
      'project_id 省略時は現在のプロジェクト。入力例: {"path": "notes/古いメモ.md"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        path: { type: 'string', description: '削除する相対パス(ファイル/フォルダ)。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_project_folder',
    description:
      '【フェーズ16】プロジェクト内に空フォルダを作成する(mkdir -p 相当。中に .gitkeep を置く)。' +
      '配置規約(強制): 作れるのは notes/ か attachments/ の下(新しいトップレベルフォルダや build/ は拒否)。' +
      'どうしても必要な場合のみ force:true で回避可。project_id 省略時は現在のプロジェクト。入力例: {"path": "notes/レビュー"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        path: { type: 'string', description: '作成するフォルダの相対パス(notes/ か attachments/ の下)。' },
        force: { type: 'boolean', description: 'true で配置規約の検証を回避する(通常は不要)。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_project_folder',
    description:
      '【フェーズ26: プロジェクト一覧のフォルダ整理】プロジェクトを一覧上のフォルダ(論理パス)へ移動する。' +
      'folder はプロジェクトの属性であり実ディレクトリではない(ファイル配置規約 checkPlacementPolicy の対象外。中身のファイルは移動しない)。' +
      'folder 例: "研究論文"・"研究論文/2026"。空文字("")でルート(フォルダなし)へ戻す。空フォルダは所属プロジェクトが無くなれば自動的に消える。' +
      'セグメント制約: 空・「.」「..」・先頭ドット・Windows 予約名は不可、各セグメント64文字以内、深さ最大8(フェーズ28で 3→8 に拡張)。' +
      'project_id(または id)省略時は現在エディタで開いているプロジェクト。現在の folder は list_projects で確認できる。' +
      'フォルダ名の一括変更・フォルダごとの移動は rename_folder を使う。' +
      '入力例: {"folder": "研究論文"} / {"id": "IriCd3uW", "folder": "研究論文/2026"} / {"folder": ""}',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '対象プロジェクトの id(省略時は現在のプロジェクト。project_id と同義)。' },
        project_id: { type: 'string', description: 'id の別名(どちらか一方を指定)。' },
        folder: { type: 'string', description: '移動先フォルダ(論理パス)。空文字("")でルートへ戻す。' },
      },
      required: ['folder'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_folder',
    description:
      '【フェーズ28: フォルダ階層の強化】一覧上のフォルダ(論理パス)の名前変更・フォルダごとの移動を行う。' +
      'from 配下(from 自身 + `from/` で始まる)すべてのプロジェクトの folder を to プレフィックスへ一括で書き換える。' +
      'フォルダは属性であり実体が無いため、配下プロジェクトの folder を 1 件ずつ更新して実現する。' +
      '名前変更の例: {"from": "研究論文", "to": "論文アーカイブ"}(配下すべてが「論文アーカイブ/…」へ)。' +
      'フォルダごと移動の例: {"from": "研究論文/2026", "to": "アーカイブ/2026"}。to に空文字("")でルート直下へ。' +
      '対象が 0 件のときはエラー。途中で失敗した場合は中断し、それまでの移動件数を報告する(再実行で続きから収束する)。' +
      'セグメント制約は set_project_folder と同じ(深さ最大8・各64文字・予約名不可)。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '変更元のフォルダ(論理パス)。この配下すべてが対象。' },
        to: { type: 'string', description: '変更先のフォルダ(論理パス)。空文字("")でルート直下へ。' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_submissions',
    description: '現在の原稿版に凍結保存された実提出ファイル(PCS等から取得)と提出日時・SHA-256を一覧する。証拠確認に使う。',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'list_draft_versions',
    description: 'プロジェクトの原稿版(初稿・査読対応・カメラレディ等のgitブランチ)を一覧し、現在の版を示す。',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'create_draft_version',
    description: '現在の原稿から新しい原稿版を作る。未保存変更は自動コミットする。作成後の切替はswitch_draft_versionを使う。',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, name: { type: 'string', description: '例: 初稿、査読対応、カメラレディ' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'switch_draft_version',
    description: '指定した原稿版へ切り替える。現在の未保存変更は切替前に自動コミットされる。切替後はブラウザも再読み込みする。',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'commit_project',
    description:
      '【フェーズ16: git コミット】プロジェクトの現在の状態を git にコミットする(バージョン保存)。' +
      '返り値は commit の短縮ハッシュ、変更が無ければ「変更なし」。作業フロー: write_project_file 等で編集 → commit_project でスナップショット。' +
      'project_id 省略時は現在のプロジェクト。入力例: {"message": "レビューメモを追加"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        message: { type: 'string', description: 'コミットメッセージ。省略時は既定文言。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_history',
    description:
      '【フェーズ16】プロジェクトの git コミット履歴を新しい順に一覧する。' +
      '各要素は {hash, shortHash, message, ts, author}。restore_project に渡す hash を調べるのに使う。' +
      'project_id 省略時は現在のプロジェクト。入力は project_id のみ(省略可)。',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'project_status',
    description:
      '【フェーズ16】プロジェクトの未コミット変更(git status)を確認する。返り値は dirty(未コミット変更の有無)と変更ファイル一覧。' +
      'project_id 省略時は現在のプロジェクト。入力は project_id のみ(省略可)。',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'restore_project',
    description:
      '【フェーズ16】プロジェクトを指定コミット(hash)の状態に復元する(復元前に未コミット変更は自動コミットされる)。' +
      'hash は project_history で取得する。project_id 省略時は現在のプロジェクト。' +
      '入力例: {"hash": "a1b2c3d"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        hash: { type: 'string', description: '復元先コミットの hash(project_history の hash / shortHash)。' },
      },
      required: ['hash'],
      additionalProperties: false,
    },
  },
  {
    name: 'compile_project',
    description:
      '【フェーズ16】プロジェクト単位で main.tex を latexmk(xelatex)でコンパイルする(サーバー側。ブラウザ未接続でも動作)。' +
      '返り値は成否(ok)と、失敗時はログ末尾(log)。ブラウザで同じプロジェクトを開いている場合はプレビュー更新も試みる。' +
      'project_id 省略時は現在のプロジェクト。入力例: {} / {"project_id": "i3WuvYLE"}',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' } },
      additionalProperties: false,
    },
  },

  // ===== フェーズ18: MCP スレッド操作(コメント・メモ・論文を1スレッドにまとめる)=====
  // スレッドは本文アンカー(thread-ref)と in-memory モデル(window.Threads)を伴うため、
  // すべてブラウザブリッジ(agent-bridge.js → window.Threads)経由で操作する。
  // ブラウザ未接続時は「エディタを開いてください」と分かりやすいエラーになる。
  //
  // 研究ワークフロー例:
  //   1. list_project_files で関連するダウンロード論文(attachments/*.pdf)やメモ(notes/*.md)を探す。
  //   2. create_thread で本文の該当箇所(anchor_text)にスレッドを立てる。
  //   3. attach_file_to_thread でその PDF / メモを1つのスレッドにまとめて添付する。
  //   4. add_thread_comment で「この論文の要点は…」と要約コメント(著者は Claude)を書く。
  //   5. reply_thread で議論を続け、片付いたら resolve_thread。
  // 既存の文書系ツール(add_comment は本文範囲への単発コメント)と異なり、スレッドは
  // コメント/返信/ファイル添付/本文アンカーを1つの単位に束ねられる。
  {
    name: 'list_threads',
    description:
      '【フェーズ18: スレッド一覧】現在ブラウザで開いている文書のスレッドを一覧する(ブリッジ経由)。' +
      '各要素は {tid, title, commentCount(コメント数), fileCount(添付ファイル数), resolved(解決済みか), anchorCount(本文アンカー数)}。' +
      'get_thread で開く tid や、add_thread_comment / attach_file_to_thread に渡す tid を調べるのに使う。入力は不要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_thread',
    description:
      '【フェーズ18】指定 tid のスレッド詳細を取得する。返り値はタイトル・resolved・本文アンカー(anchors)・' +
      'items(各項目に index が付く。type="comment" は {author, text, replies}、type="file" は {path, label, loc})。' +
      'reply_thread に渡す item_index はここの items の index を使う。入力例: {"tid": "t1"}',
    inputSchema: {
      type: 'object',
      properties: { tid: { type: 'string', description: 'スレッドの tid(list_threads で確認)。' } },
      required: ['tid'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_thread',
    description:
      '【フェーズ18】新しいスレッドを作成する。anchor_text を指定すると本文の最初の一致箇所に thread-ref(下線マーカー)を張り、' +
      'そのスレッドを本文に紐づける(指定が無ければアンカー無しのスレッドを作る)。作成後、add_thread_comment で要約コメントを、' +
      'attach_file_to_thread で関連 PDF/メモを束ねるのが典型ワークフロー。' +
      '入力例(本文に紐づけ): {"title": "先行研究の整理", "anchor_text": "従来手法"} / 入力例(アンカー無し): {"title": "TODO メモ"}',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'スレッドのタイトル。' },
        anchor_text: { type: 'string', description: '本文でこのスレッドを紐づけたいテキスト(最初の一致箇所にマーカーを張る)。省略可。' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_thread_comment',
    description:
      '【フェーズ18】スレッドにコメントを追加する(著者は「Claude」)。論文/メモを attach_file_to_thread で束ねた上で、' +
      'その要約や考察をコメントとして残すのに使う。入力例: {"tid": "t1", "text": "この論文は提案手法の理論的裏付けになる。式(3)が鍵。"}',
    inputSchema: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: 'コメントを追加するスレッドの tid。' },
        text: { type: 'string', description: 'コメント本文。' },
      },
      required: ['tid', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply_thread',
    description:
      '【フェーズ18】スレッド内の特定コメントに返信する(著者は「Claude」)。item_index は get_thread の items の index。' +
      '返信できるのは type="comment" の項目のみ(ファイル項目には返信不可)。' +
      '入力例: {"tid": "t1", "item_index": 0, "text": "補足: 反例は第4節にあります。"}',
    inputSchema: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: 'スレッドの tid。' },
        item_index: { type: 'integer', description: '返信先コメントの index(get_thread の items の index)。' },
        text: { type: 'string', description: '返信本文。' },
      },
      required: ['tid', 'item_index', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'attach_file_to_thread',
    description:
      '【フェーズ18】プロジェクト内ファイル(ダウンロードした論文 attachments/*.pdf、メモ notes/*.md、任意ファイル)を' +
      'スレッドに添付する。path は projects/<id>/ 配下の相対パスで、list_project_files で確認できる(存在チェックあり)。' +
      'loc は開いたときの位置(PDF のページ番号など)、label は表示名(省略時はファイル名)。' +
      'ワークフロー: list_project_files で関連ファイルを探す → 複数回 attach_file_to_thread で1スレッドに束ねる → add_thread_comment で要約。' +
      '入力例(PDF): {"tid": "t1", "path": "attachments/sample.pdf", "loc": "3", "label": "先行研究A"} / ' +
      '入力例(メモ): {"tid": "t1", "path": "notes/idea.md"}',
    inputSchema: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: '添付先スレッドの tid。' },
        path: { type: 'string', description: 'projects/<id>/ 配下の相対パス(list_project_files で確認)。' },
        loc: { type: 'string', description: '開いたときの位置(PDF のページ番号など)。省略可。' },
        label: { type: 'string', description: '表示名。省略時はファイル名。' },
      },
      required: ['tid', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_thread',
    description:
      '【フェーズ18】スレッドを「解決済み」にする(議論やレビューが片付いたとき)。' +
      '入力例: {"tid": "t1"}',
    inputSchema: {
      type: 'object',
      properties: { tid: { type: 'string', description: '解決にするスレッドの tid。' } },
      required: ['tid'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_thread',
    description:
      '【フェーズ18】スレッドを削除する(本文アンカー thread-ref も本文から取り除かれる)。' +
      '入力例: {"tid": "t1"}',
    inputSchema: {
      type: 'object',
      properties: { tid: { type: 'string', description: '削除するスレッドの tid。' } },
      required: ['tid'],
      additionalProperties: false,
    },
  },

  // ===== フェーズ25: 数式 / 引用・参考文献 / ライフサイクル =====
  {
    name: 'insert_math',
    description:
      '【フェーズ25: 数式挿入】数式を本文に挿入し、MathML 描画まで完了する(ダイアログを開かないので MCP だけで完結する。' +
      'exec_command の insertMath は使わないこと)。tex は LaTeX の数式本体(区切りの $ や \\[ \\] は不要)。' +
      'display=false(既定)はインライン数式($…$)、display=true は別行の数式(equation 環境)。' +
      'position は insert_content と同じ("end" 既定 / "start" / "after_heading"+heading)。' +
      '入力例(インライン): {"tex": "E=mc^2"} / 入力例(別行): {"tex": "\\\\int_0^1 x^2\\\\,dx = \\\\tfrac13", "display": true} / ' +
      '入力例(見出しの後): {"tex": "a^2+b^2=c^2", "position": "after_heading", "heading": "定理"}',
    inputSchema: {
      type: 'object',
      properties: {
        tex: { type: 'string', description: 'LaTeX 数式本体($ や \\[ \\] は付けない)。' },
        display: { type: 'boolean', description: 'true で別行の数式(equation)、false/省略でインライン。' },
        position: { type: 'string', enum: ['end', 'start', 'after_heading'], description: '挿入位置。既定 "end"。' },
        heading: { type: 'string', description: 'position が "after_heading" のときの対象見出しテキスト(部分一致)。' },
      },
      required: ['tex'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_math',
    description:
      '【フェーズ25: 数式書き換え】既存の数式の中身(data-tex)を書き換えて再描画する。' +
      '対象は index(文書内の数式の並び順・0始まり)か find(現在の LaTeX の部分一致)で指定する。' +
      '文書中の数式は get_blocks / search_document(include_math:true)で確認できる。' +
      '入力例(並び順で指定): {"index": 0, "tex": "E = mc^2 + \\\\Delta"} / ' +
      '入力例(現在式で検索): {"find": "mc^2", "tex": "e = mc^2"}',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '文書内の数式の並び順(0始まり)。find と併用不可。' },
        find: { type: 'string', description: '現在の data-tex に部分一致する文字列で対象数式を探す。' },
        tex: { type: 'string', description: '新しい LaTeX 数式本体。' },
      },
      required: ['tex'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_reference',
    description:
      '【フェーズ25: 参考文献追記】BibTeX エントリを現在プロジェクトの refs.bib に追記する(親フォルダ既定、末尾に追加)。' +
      'キーが既存エントリと重複する場合は上書きせずエラーで既存キーを提示する(force:true で上書き追記)。' +
      'insert_citation の \\cite{key} と対で使う。project_id 省略時は現在のプロジェクト。' +
      '注意: この操作はプロジェクトモード(サーバー上の refs.bib)専用。単体文書モード(documents)には対応しない。' +
      '入力例: {"bibtex": "@article{einstein1905, title={On …}, author={Einstein, A.}, year={1905}}"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        bibtex: { type: 'string', description: '追記する BibTeX エントリ(@type{key, …} 形式)。' },
        force: { type: 'boolean', description: 'true でキー重複時も上書き追記する(通常は不要)。' },
      },
      required: ['bibtex'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_citation',
    description:
      '【フェーズ25: 引用挿入】本文に引用(cite span)を挿入する。LaTeX 出力は \\cite{key}。' +
      'key はカンマ区切りで複数指定可(\\cite{a,b})。key が現在プロジェクトの refs.bib に無い場合も挿入はするが警告を返す。' +
      'position は insert_content と同じ("end" 既定 / "start" / "after_heading"+heading)。参考文献側は add_reference で追記する。' +
      '入力例: {"key": "einstein1905"} / 入力例(複数): {"key": "einstein1905,newton1687", "position": "end"}',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '引用キー(refs.bib のキー)。カンマ区切りで複数可。' },
        position: { type: 'string', enum: ['end', 'start', 'after_heading'], description: '挿入位置。既定 "end"。' },
        heading: { type: 'string', description: 'position が "after_heading" のときの対象見出しテキスト(部分一致)。' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_project',
    description:
      '【フェーズ25: プロジェクト作成】サーバー上に新しいプロジェクト(ディレクトリ)を作成する(ブラウザ未接続でも動作)。' +
      '返り値は新しい project_id。作成後は open_project でエディタに開く/以後 project_id を指定してファイル作業ができる。' +
      '入力例: {"name": "四半期レポート"}',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'プロジェクト名(省略時は既定名)。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'rename_project_file',
    description:
      '【フェーズ25: ファイル改名/移動】プロジェクト内のファイル/フォルダを改名・移動する(git 追跡も追従)。' +
      '配置規約(強制): 移動先は notes/** ・ attachments/** ・ refs.bib のみ(それ以外・build/ は拒否。force:true で回避可)。' +
      'build/ 配下は移動元・移動先ともサーバーが拒否する。project_id 省略時は現在のプロジェクト。' +
      '入力例: {"from": "notes/old.md", "to": "notes/renamed.md"}',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトの id。省略時は現在のプロジェクト。' },
        from: { type: 'string', description: '現在の相対パス。' },
        to: { type: 'string', description: '新しい相対パス(notes/** ・ attachments/** ・ refs.bib)。' },
        force: { type: 'boolean', description: 'true で配置規約の検証を回避する(通常は不要)。' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_remote_requests',
    description:
      'iPadなどLAN上のブラウザからMac上のCodex/Claude Codeへ送られた依頼を取得する。本文・メモの選択範囲がcontextとして添付される。既定では未返信かつ現在のエージェント宛てのみ。' +
      '依頼を処理したら reply_remote_request で同じ request_id に返信すると、iPadへ自動表示される。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '対象プロジェクトで絞り込む。省略時は全プロジェクト。' },
        include_answered: { type: 'boolean', description: 'true で返信済みも含める。' },
        recipient: { type: 'string', enum: ['codex', 'claude_code'], description: '宛先。省略時はMCP設定上の現在のエージェント。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reply_remote_request',
    description:
      'iPad等から届いた依頼へ返信する。返信は受信箱に保存され、送信元ブラウザへ自動表示される。' +
      'request_id は list_remote_requests で取得する。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: '返信対象の依頼ID。' },
        reply: { type: 'string', description: 'ユーザーへ返す回答・完了報告。' },
        pointers: {
          type: 'array', maxItems: 12,
          description: '「ここ」と示す本文箇所や、ユーザーへ見せるメモ・論文。',
          items: { type: 'object', properties: {
            kind: { type: 'string', enum: ['document', 'file'], description: '本文箇所はdocument、メモ・論文はfile。' },
            label: { type: 'string', description: '画面に表示する短い説明。' },
            text: { type: 'string', description: 'documentの場合、本文中に存在する指示対象の文章。' },
            path: { type: 'string', description: 'fileの場合、プロジェクト内のメモ/PDF相対パス。' },
            page: { type: 'integer', minimum: 1, description: 'PDFの場合のページ番号。' },
          }, required: ['kind'], additionalProperties: false },
        },
      },
      required: ['request_id', 'reply'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_document',
    description:
      '【フェーズ25: 文書削除】ブラウザ内の単体文書ストア(documents)から文書を削除する(create_document の対)。' +
      '誤削除防止のため id と title(list_documents の表示名)の両方を要求し、一致しなければ削除しない。' +
      'これは projects(サーバー上のディレクトリ)ではなく documents ストア専用。プロジェクトの削除は別機能。' +
      '入力例: {"id": "d1a2b3c4", "title": "下書きメモ"}',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '削除する文書の id(list_documents の id)。' },
        title: { type: 'string', description: '確認用の文書タイトル(list_documents の表示名と一致必須)。' },
      },
      required: ['id', 'title'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// ツール実行結果を簡潔な日本語テキストにまとめる
// ---------------------------------------------------------------------------
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…(以下略)' : s;
}

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'list_remote_requests': {
      let apiPath = '/agent/inbox';
      const query = [];
      if (!args.include_answered) query.push('status=pending');
      query.push('recipient=' + encodeURIComponent(String(args.recipient || RATEX_AGENT)));
      if (args.project_id) query.push('project_id=' + encodeURIComponent(String(args.project_id)));
      if (query.length) apiPath += '?' + query.join('&');
      const items = await projectJson('GET', apiPath);
      if (!Array.isArray(items) || !items.length) return 'iPad等からの未処理の依頼はありません。';
      return JSON.stringify(items, null, 2);
    }
    case 'reply_remote_request': {
      const id = String(args.request_id || '');
      const reply = String(args.reply || '').trim();
      if (!id || !reply) throw new Error('request_id と reply を指定してください。');
      const item = await projectJson('PATCH', '/agent/inbox/' + encodeURIComponent(id), { reply: reply, pointers: args.pointers || [] });
      return '依頼 ' + id + ' に返信しました。iPad側へ自動表示されます。\n\n' + item.reply;
    }
    case 'get_document': {
      const r = await rpc('get_document', {});
      return '文書名: ' + (r.title || '(無題)') + '\n文字数: ' + (r.charCount || 0) +
        '\n\n--- 本文テキスト ---\n' + truncate(r.text || '', 8000);
    }
    case 'get_latex': {
      const r = await rpc('get_latex', {});
      return truncate(r.latex || '', 20000);
    }
    case 'set_document': {
      await rpc('set_document', { html: String(args.html || '') });
      return '文書全体を置き換えました。';
    }
    case 'insert_content': {
      const r = await rpc('insert_content', {
        html: String(args.html || ''),
        position: args.position || 'end',
        heading: args.heading || '',
      });
      return 'コンテンツを挿入しました(位置: ' + (r && r.position ? r.position : (args.position || 'end')) + ')。';
    }
    case 'replace_text': {
      const r = await rpc('replace_text', {
        find: String(args.find == null ? '' : args.find),
        replace: String(args.replace == null ? '' : args.replace),
        all: !!args.all,
      });
      const count = r && typeof r.count === 'number' ? r.count : 0;
      return count > 0 ? (count + ' 件を置換しました。') : '一致するテキストが見つかりませんでした(0 件)。';
    }
    case 'apply_style': {
      const r = await rpc('apply_style', {
        target_text: String(args.target_text || ''),
        style: String(args.style || ''),
      });
      if (r && r.applied === false) {
        return '対象テキスト「' + truncate(args.target_text, 40) + '」を含むブロックが見つかりませんでした。';
      }
      return 'スタイル「' + (args.style) + '」を適用しました。';
    }
    case 'add_comment': {
      const r = await rpc('add_comment', {
        anchor_text: String(args.anchor_text || ''),
        comment: String(args.comment || ''),
      });
      if (r && r.added === false) {
        return 'アンカーテキスト「' + truncate(args.anchor_text, 40) + '」が本文に見つかりませんでした。';
      }
      return 'コメントを追加しました。';
    }
    case 'compile_pdf': {
      const r = await rpc('compile_pdf', {});
      if (r && r.ok) return 'コンパイルに成功しました。PDF をプレビューに表示しました。';
      return 'コンパイルに失敗しました。\n\n--- ログ ---\n' + truncate((r && r.log) || '(ログなし)', 4000);
    }
    case 'list_documents': {
      const r = await rpc('list_documents', {});
      const docs = (r && r.documents) || [];
      if (!docs.length) return '文書がありません。';
      const lines = docs.map(function (d) {
        return '- id=' + d.id + '  「' + (d.title || '(無題)') + '」  ' +
          (d.charCount || 0) + '文字  更新: ' + (d.updatedAt || '');
      });
      return docs.length + ' 件の文書:\n' + lines.join('\n');
    }
    case 'open_document': {
      const r = await rpc('open_document', { id: String(args.id || '') });
      if (r && r.opened === false) {
        return 'id=' + args.id + ' の文書は見つかりませんでした。';
      }
      return 'id=' + args.id + ' の文書を開きました' + (r && r.title ? '(「' + r.title + '」)' : '') + '。';
    }
    case 'create_document': {
      const r = await rpc('create_document', { template: args.template || 'blank' });
      return '新しい文書を作成して開きました(雛形: ' + (args.template || 'blank') +
        (r && r.id ? '、id=' + r.id : '') + ')。';
    }

    // ===== フェーズ9 =====
    case 'edit_html': {
      const r = await rpc('edit_html', {
        old_string: String(args.old_string == null ? '' : args.old_string),
        new_string: String(args.new_string == null ? '' : args.new_string),
        replace_all: !!args.replace_all,
      });
      const n = r && typeof r.replaced === 'number' ? r.replaced : 1;
      return n + ' 箇所を置換しました。';
    }
    case 'get_blocks': {
      const r = await rpc('get_blocks', {});
      const blocks = (r && r.blocks) || [];
      if (!blocks.length) return 'ブロックがありません。';
      const lines = blocks.map(function (b) {
        return '[' + b.index + '] <' + b.tag + '>' +
          (b.style ? ' (' + b.style + ')' : '') +
          (b.bid ? ' bid=' + b.bid : '') +
          '  ' + JSON.stringify(truncate(b.text, 120)) +
          '  (html ' + b.htmlLength + '字)';
      });
      return blocks.length + ' 個のブロック:\n' + lines.join('\n');
    }
    case 'get_block': {
      const r = await rpc('get_block', { index: Number(args.index) });
      if (!r || r.found === false) return 'index=' + args.index + ' のブロックは見つかりませんでした。';
      return '[' + r.index + '] <' + r.tag + '>' + (r.style ? ' (' + r.style + ')' : '') +
        (r.bid ? ' bid=' + r.bid : '') +
        '\n--- innerHTML ---\n' + truncate(r.html, 8000) +
        '\n--- text ---\n' + truncate(r.text, 2000);
    }
    case 'set_block': {
      const r = await rpc('set_block', { index: Number(args.index), html: String(args.html || '') });
      if (!r || r.found === false) return 'index=' + args.index + ' のブロックは見つかりませんでした。';
      return 'index=' + args.index + ' のブロックを置き換えました' +
        (r && typeof r.blocks === 'number' ? '(結果 ' + r.blocks + ' ブロック)' : '') + '。';
    }
    case 'insert_block': {
      const r = await rpc('insert_block', {
        index: Number(args.index),
        html: String(args.html || ''),
        position: args.position === 'before' ? 'before' : 'after',
      });
      const cnt = r && typeof r.inserted === 'number' ? r.inserted : 0;
      if (!cnt) return '挿入する内容がありませんでした。';
      return cnt + ' ブロックを挿入しました(位置: ' + ((r && r.position) || 'after') + ')。';
    }
    case 'delete_block': {
      const r = await rpc('delete_block', { index: Number(args.index) });
      if (!r || r.found === false) return 'index=' + args.index + ' のブロックは見つかりませんでした。';
      return 'index=' + args.index + ' のブロックを削除しました。';
    }
    case 'format_text': {
      const r = await rpc('format_text', {
        target_text: String(args.target_text || ''),
        command: String(args.command || ''),
        value: args.value == null ? null : String(args.value),
      });
      if (!r || r.applied === false) {
        return '対象テキスト「' + truncate(args.target_text, 40) + '」が本文に見つかりませんでした。';
      }
      return 'コマンド「' + args.command + '」を「' + truncate(args.target_text, 40) + '」に適用しました。';
    }
    case 'exec_command': {
      await rpc('exec_command', {
        command: String(args.command || ''),
        value: args.value == null ? null : String(args.value),
      });
      return 'コマンド「' + args.command + '」を実行しました' +
        (args.value != null ? '(値: ' + args.value + ')' : '') + '。';
    }
    case 'undo': {
      await rpc('undo', {});
      return '直前の操作を取り消しました。';
    }
    case 'redo': {
      await rpc('redo', {});
      return '操作をやり直しました。';
    }
    case 'get_outline': {
      const r = await rpc('get_outline', {});
      const items = (r && r.outline) || [];
      if (!items.length) return '見出しがありません。';
      const lines = items.map(function (o) {
        const indent = '  '.repeat(o.level);
        return indent + '[' + o.index + '] (' + o.style + ') ' + truncate(o.text, 120);
      });
      return items.length + ' 個の見出し:\n' + lines.join('\n');
    }

    // ===== フェーズ12: MCP文書検索 =====
    case 'search_document': {
      const r = await rpc('search_document', {
        query: String(args.query == null ? '' : args.query),
        regex: !!args.regex,
        ignore_case: !!args.ignore_case,
        whole_word: !!args.whole_word,
        include_math: !!args.include_math,
        max_results: args.max_results == null ? null : Number(args.max_results),
      });
      const matches = (r && r.matches) || [];
      const total = r && typeof r.total === 'number' ? r.total : matches.length;
      if (!matches.length) return '一致するものが見つかりませんでした(0 件)。';
      const header = total > matches.length
        ? ('全 ' + total + ' 件中、先頭 ' + matches.length + ' 件を表示:')
        : (matches.length + ' 件ヒット:');
      const lines = matches.map(function (m) {
        return 'block[' + m.block_index + '] <' + m.block_tag + '>  offset=' + m.char_offset +
          '  一致: ' + JSON.stringify(truncate(m.match_text, 80)) +
          '\n    行: ' + JSON.stringify(truncate(m.line_text, 120)) +
          '\n    文脈: …' + truncate(m.context, 120) + '…';
      });
      return header + '\n' + lines.join('\n') +
        '\n\n(ヒットしたブロックは get_block <block_index> で確認し、edit_html / set_block で編集できます。)';
    }
    case 'search_all_documents': {
      const r = await rpc('search_all_documents', {
        query: String(args.query == null ? '' : args.query),
        regex: !!args.regex,
        ignore_case: !!args.ignore_case,
        max_results: args.max_results == null ? null : Number(args.max_results),
      });
      const docs = (r && r.documents) || [];
      if (!docs.length) return '該当する文書が見つかりませんでした(0 件)。';
      const lines = docs.map(function (d) {
        var head = '- doc_id=' + d.doc_id + '  「' + (d.title || '(無題)') + '」  ' + d.match_count + ' 件';
        var samples = (d.samples || []).map(function (s) {
          return '    …' + truncate(s.context, 100) + '…';
        });
        return samples.length ? head + '\n' + samples.join('\n') : head;
      });
      return docs.length + ' 件の文書が該当:\n' + lines.join('\n') +
        '\n\n(open_document <doc_id> で対象文書を開いてから search_document で位置を特定できます。)';
    }

    // ===== フェーズ16: MCP プロジェクト操作 =====
    case 'list_projects': {
      const list = await projectJson('GET', '/projects');
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) return 'プロジェクトがありません。';
      const lines = arr.map(function (p) {
        return '- id=' + p.id + '  「' + (p.name || p.id) + '」  ' +
          (p.folder ? '📁' + p.folder + '  ' : '') +
          (p.fileCount != null ? p.fileCount + 'ファイル' : '') +
          (p.updatedAt ? '  更新: ' + p.updatedAt : '');
      });
      return arr.length + ' 件のプロジェクト:\n' + lines.join('\n');
    }
    case 'get_current_project': {
      let cur;
      try {
        cur = await rpc('get_current_project', {});
      } catch (e) {
        return 'エディタ(ブラウザ)に接続していないため、現在のプロジェクトは取得できません(未接続)。';
      }
      if (!cur || !cur.id) return '現在エディタで開いているプロジェクトはありません。';
      // 可能ならサーバーの一覧から正式名を補完
      let name = cur.name || '';
      try {
        const list = await projectJson('GET', '/projects');
        const hit = (Array.isArray(list) ? list : []).filter(function (p) { return p.id === cur.id; })[0];
        if (hit && hit.name) name = hit.name;
      } catch (e) { /* ignore */ }
      return '現在のプロジェクト: id=' + cur.id + (name ? '  「' + name + '」' : '');
    }
    case 'open_project': {
      const id = String(args.id || '');
      if (!id) throw new Error('id を指定してください。');
      // 存在確認(分かりやすいエラーのため先にサーバーへ問い合わせ)
      const meta = await projectJson('GET', '/projects/' + encodeURIComponent(id));
      // ブラウザで開く(未接続時は rpc が分かりやすいエラーを投げる)
      await rpc('open_project', { id: id });
      return 'プロジェクト id=' + id + (meta && meta.name ? '(「' + meta.name + '」)' : '') + ' をエディタで開きました。';
    }
    case 'list_project_files': {
      const id = await resolveProjectId(args);
      const tree = await projectJson('GET', '/projects/' + encodeURIComponent(id) + '/tree');
      let arr = Array.isArray(tree) ? tree : [];
      if (!arr.length) return 'プロジェクト(id=' + id + ')にファイルはありません。';
      const query = String(args.query || '').toLowerCase();
      const prefix = String(args.path_prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const ext = String(args.extension || '').replace(/^\./, '').toLowerCase();
      if (query) arr = arr.filter(function (e) { return String(e.path || '').toLowerCase().indexOf(query) !== -1; });
      if (prefix) arr = arr.filter(function (e) { return e.path === prefix || e.path.indexOf(prefix + '/') === 0; });
      if (ext) arr = arr.filter(function (e) { return e.type === 'file' && String(e.ext || e.path.split('.').pop()).toLowerCase() === ext; });
      if (args.type) arr = arr.filter(function (e) { return e.type === args.type; });
      const total = arr.length;
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      arr = arr.slice(offset, offset + limit);
      const result = { project_id: id, total: total, offset: offset, limit: limit,
        next_offset: offset + arr.length < total ? offset + arr.length : null, items: arr };
      if (args.format === 'json') return JSON.stringify(result, null, 2);
      if (!total) return '条件に一致するファイルはありません。';
      const lines = arr.map(function (e) {
        return (e.type === 'dir' ? '[dir]  ' : '       ') + e.path +
          (e.type === 'file' ? '  (' + e.size + ' bytes)' : '');
      });
      return 'プロジェクト id=' + id + ' のファイル ' + (offset + 1) + '–' + (offset + arr.length) +
        ' / ' + total + '件' + (result.next_offset != null ? '(続き: offset=' + result.next_offset + ')' : '') + ':\n' + lines.join('\n');
    }
    case 'read_project_file': {
      const id = await resolveProjectId(args);
      const p = String(args.path || '');
      if (!p) throw new Error('path を指定してください。');
      const res = await projectFetch('GET', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent(p));
      if (!res.ok) {
        let data = null;
        const t = await res.text();
        if (t) { try { data = JSON.parse(t); } catch (e) { /* ignore */ } }
        throw new Error(projectErrorMessage(res.status, data && data.error, data && data.message));
      }
      const ct = res.headers.get('content-type') || '';
      if (isTextContentType(ct)) {
        const text = await res.text();
        return 'ファイル: ' + p + '(' + text.length + '字)\n\n' + truncate(text, 20000);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return 'ファイル: ' + p + ' はバイナリのため内容は省略します(' + buf.length + ' bytes、type=' +
        (ct || '不明') + ')。';
    }
    case 'write_project_file': {
      const id = await resolveProjectId(args);
      const p = String(args.path || '');
      if (!p) throw new Error('path を指定してください。');
      const policyErr = checkPlacementPolicy(p, !!args.force);
      if (policyErr) throw new Error(policyErr);
      const content = String(args.content == null ? '' : args.content);
      const r = await projectJson('PUT', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent(p), { content: content });
      await notifyProjectFilesChanged(id);
      return 'ファイルを書き込みました: ' + p + '(' + (r && r.size != null ? r.size + ' bytes' : content.length + '字') + ')。';
    }
    case 'create_linked_note': {
      const id = await resolveProjectId(args);
      const p = String(args.path || '').replace(/\\/g, '/');
      if (!/^notes\/.+\.md$/i.test(p)) throw new Error('path は notes/ 配下の .md ファイルを指定してください。');
      const policyErr = checkPlacementPolicy(p, false);
      if (policyErr) throw new Error(policyErr);
      const title = String(args.title || '').trim();
      if (!title) throw new Error('title を指定してください。');
      const existing = await projectFetch('GET', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent(p));
      if (existing.ok) throw new Error('既に存在するメモです: ' + p + '。更新には write_project_file を使ってください。');
      if (existing.status !== 404) throw new Error(projectErrorMessage(existing.status));
      const links = Array.isArray(args.links) ? args.links : [];
      const linkLines = await Promise.all(links.map(function (link) { return markdownLinkLine(id, link); }));
      let content = '# ' + title.replace(/[\r\n]+/g, ' ') + '\n\n';
      if (args.body != null && String(args.body).trim()) content += String(args.body).trim() + '\n\n';
      if (linkLines.length) content += '## リンク\n\n' + linkLines.join('\n') + '\n';
      await projectJson('PUT', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent(p), { content: content });
      await notifyProjectFilesChanged(id);
      return 'リンク付きメモを作成しました: ' + p + '(リンク ' + linkLines.length + '件)。';
    }
    case 'update_linked_note': {
      const id = await resolveProjectId(args);
      const p = String(args.path || '').replace(/\\/g, '/');
      if (!/^notes\/.+\.md$/i.test(p)) throw new Error('path は notes/ 配下の既存 .md メモを指定してください。');
      const res = await projectFetch('GET', '/projects/' + encodeURIComponent(id) + '/file?path=' + encodeURIComponent(p));
      if (!res.ok) throw new Error(projectErrorMessage(res.status));
      let content = await res.text();
      if (args.action === 'append') {
        const addition = String(args.text || '').trim();
        if (!addition) throw new Error('append では text を指定してください。');
        content = content.replace(/\s*$/, '') + '\n\n' + addition + '\n';
      } else if (args.action === 'add_link') {
        const line = await markdownLinkLine(id, args);
        if (content.indexOf(line) !== -1) return '同じリンクが既に存在するため変更しませんでした: ' + p;
        content = content.replace(/\s*$/, '') + (/^## リンク\s*$/m.test(content) ? '\n' : '\n\n## リンク\n\n') + line + '\n';
      } else if (args.action === 'remove_link') {
        const target = String(args.target || '').trim();
        if (!target) throw new Error('remove_link では target を指定してください。');
        const encoded = encodeURI(target).replace(/[()]/g, encodeURIComponent);
        const before = content;
        content = content.split(/\r?\n/).filter(function (line) {
          const m = /^\s*-\s+\[[^\]]+\]\(([^)]+)\)\s*$/.exec(line);
          if (!m) return true;
          const found = m[1].replace(/^project:/, '').replace(/#page=\d+$/, '');
          return found !== target && found !== encoded;
        }).join('\n');
        if (content === before) return '対象リンクは見つかりませんでした: ' + target;
      } else throw new Error('action は append / add_link / remove_link を指定してください。');
      await projectJson('PUT', '/projects/' + encodeURIComponent(id) + '/file?path=' + encodeURIComponent(p), { content: content });
      await notifyProjectFilesChanged(id);
      return 'メモを更新しました: ' + p + '(action=' + args.action + ')。';
    }
    case 'delete_project_file': {
      const id = await resolveProjectId(args);
      const p = String(args.path || '');
      if (!p) throw new Error('path を指定してください。');
      await projectJson('DELETE', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent(p));
      await notifyProjectFilesChanged(id);
      return '削除しました: ' + p;
    }
    case 'create_project_folder': {
      const id = await resolveProjectId(args);
      const p = String(args.path || '');
      if (!p) throw new Error('path を指定してください。');
      const policyErr = checkPlacementPolicy(p, !!args.force);
      if (policyErr) throw new Error(policyErr);
      const r = await projectJson('POST', '/projects/' + encodeURIComponent(id) + '/mkdir', { path: p });
      await notifyProjectFilesChanged(id);
      return 'フォルダを作成しました: ' + ((r && r.path) || p);
    }
    case 'set_project_folder': {
      const id = args.id ? String(args.id) : await resolveProjectId(args);
      if (typeof args.folder !== 'string') throw new Error('folder を文字列で指定してください(空文字 "" でルートへ)。');
      const folder = String(args.folder);
      const r = await projectJson('PATCH', '/projects/' + encodeURIComponent(id), { folder: folder });
      const f = (r && typeof r.folder === 'string') ? r.folder : folder;
      return f
        ? 'プロジェクト id=' + id + ' をフォルダ「' + f + '」へ移動しました。'
        : 'プロジェクト id=' + id + ' をルート(フォルダなし)へ移動しました。';
    }
    case 'rename_folder': {
      const from = String(args.from == null ? '' : args.from).trim();
      if (!from) throw new Error('from(変更元フォルダ)を指定してください。');
      if (typeof args.to !== 'string') throw new Error('to を文字列で指定してください(空文字 "" でルート直下へ)。');
      const to = String(args.to);
      const listed = await projectJson('GET', '/projects');
      const arr = Array.isArray(listed) ? listed : [];
      const targets = arr.filter(function (p) {
        const f = (typeof p.folder === 'string') ? p.folder : '';
        return f === from || f.indexOf(from + '/') === 0;
      });
      if (!targets.length) throw new Error('フォルダ「' + from + '」に該当するプロジェクトがありません(対象0件)。');
      let moved = 0;
      for (const p of targets) {
        const suffix = String(p.folder).slice(from.length);   // '' か '/子…'
        const nf = to ? (to + suffix) : (suffix ? suffix.slice(1) : '');
        try {
          await projectJson('PATCH', '/projects/' + encodeURIComponent(p.id), { folder: nf });
          moved++;
        } catch (e) {
          throw new Error('途中で失敗しました(' + moved + '/' + targets.length +
            ' 件移動済み)。再実行で続きから収束します。エラー: ' + (e && e.message ? e.message : e));
        }
      }
      return 'フォルダ「' + from + '」を「' + (to || '(ルート)') + '」へ変更しました(' + moved + ' 件のプロジェクトを更新)。';
    }
    case 'commit_project': {
      const id = await resolveProjectId(args);
      const message = args.message != null ? String(args.message) : '';
      const r = await projectJson('POST', '/projects/' + encodeURIComponent(id) + '/commit',
        message ? { message: message } : {});
      if (r && r.nochange) return 'コミットする変更はありませんでした(変更なし)。';
      return 'コミットしました: ' + (r && (r.shortHash || r.hash) ? (r.shortHash || r.hash) : '') +
        (r && r.message ? '  「' + r.message + '」' : '');
    }
    case 'list_draft_versions': {
      const id = await resolveProjectId(args);
      const data = await projectJson('GET', '/projects/' + encodeURIComponent(id) + '/branches');
      const arr = data && data.branches || [];
      return arr.length ? arr.map(function (b) { return (b.current ? '→ ' : '  ') + b.name + (b.message ? ' — ' + b.message : ''); }).join('\n') : '原稿版がありません。';
    }
    case 'list_submissions': {
      const id = await resolveProjectId(args);
      const arr = await projectJson('GET', '/projects/' + encodeURIComponent(id) + '/submissions');
      if (!Array.isArray(arr) || !arr.length) return '現在の原稿版に提出記録はありません。';
      return JSON.stringify(arr, null, 2);
    }
    case 'create_draft_version': {
      const id = await resolveProjectId(args); const name = String(args.name || '').trim();
      if (!name) throw new Error('name を指定してください。');
      await projectJson('POST', '/projects/' + encodeURIComponent(id) + '/branches', { name: name });
      return '原稿版「' + name + '」を作成しました。現在の版は切り替えていません。';
    }
    case 'switch_draft_version': {
      const id = await resolveProjectId(args); const name = String(args.name || '').trim();
      if (!name) throw new Error('name を指定してください。');
      const data = await projectJson('POST', '/projects/' + encodeURIComponent(id) + '/branches/switch', { name: name });
      try { await rpc('open_project', { id: id }); } catch (e) { /* ブラウザ未接続でも切替自体は成功 */ }
      return '原稿版「' + name + '」へ切り替えました。' + (data && data.autoCommit ? '切替前の変更は ' + data.autoCommit + ' に保存済みです。' : '');
    }
    case 'project_history': {
      const id = await resolveProjectId(args);
      const log = await projectJson('GET', '/projects/' + encodeURIComponent(id) + '/commits');
      const arr = Array.isArray(log) ? log : [];
      if (!arr.length) return 'コミット履歴がありません。';
      const lines = arr.map(function (c) {
        return '- ' + (c.shortHash || c.hash) + '  ' + (c.message || '') +
          (c.ts ? '  (' + c.ts + ')' : '');
      });
      return arr.length + ' 件のコミット:\n' + lines.join('\n');
    }
    case 'project_status': {
      const id = await resolveProjectId(args);
      const st = await projectJson('GET', '/projects/' + encodeURIComponent(id) + '/status');
      if (!st || !st.dirty) return '変更はすべてコミット済みです(clean)。';
      const files = (st.files || []).map(function (f) { return '  ' + f.status + '  ' + f.path; });
      return '未コミットの変更があります(' + files.length + '件):\n' + files.join('\n');
    }
    case 'restore_project': {
      const id = await resolveProjectId(args);
      const hash = String(args.hash || '');
      if (!hash) throw new Error('hash を指定してください(project_history で取得)。');
      const r = await projectJson('POST', '/projects/' + encodeURIComponent(id) + '/restore', { hash: hash });
      return 'コミット ' + hash + ' の状態に復元しました。' +
        (r && r.autoCommit ? '(復元前の変更は ' + r.autoCommit + ' として自動コミット)' : '');
    }
    case 'compile_project': {
      const id = await resolveProjectId(args);
      const res = await projectFetch('POST', '/compile', { body: { projectId: id } });
      const ct = res.headers.get('content-type') || '';
      let ok = false;
      let log = '';
      if (res.status === 200 && ct.indexOf('application/pdf') !== -1) {
        ok = true;
        // 生成 PDF を破棄(サイズだけ確認)
        try { await res.arrayBuffer(); } catch (e) { /* ignore */ }
      } else {
        const text = await res.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { /* ignore */ } }
        if (res.status === 200) { ok = true; }
        else { log = (data && data.log) || (data && data.message) || text || ('HTTP ' + res.status); }
      }
      if (ok) {
        // ブラウザで同じプロジェクトを開いていればプレビュー更新を試みる(best-effort)
        let previewNote = '';
        try {
          const cur = await rpc('get_current_project', {});
          if (cur && cur.id === id) {
            await rpc('compile_pdf', {});
            previewNote = ' ブラウザのプレビューも更新しました。';
          }
        } catch (e) { /* 未接続などは無視 */ }
        return 'プロジェクト id=' + id + ' のコンパイルに成功しました。' + previewNote;
      }
      return 'プロジェクト id=' + id + ' のコンパイルに失敗しました。\n\n--- ログ ---\n' + truncate(log, 4000);
    }

    // ===== フェーズ18: MCP スレッド操作 =====
    case 'list_threads': {
      const r = await rpc('list_threads', {});
      const arr = (r && r.threads) || [];
      if (!arr.length) return 'スレッドはありません。create_thread で作成できます。';
      const lines = arr.map(function (t) {
        return '- tid=' + t.tid + '  「' + (t.title || '(無題)') + '」' +
          (t.resolved ? ' [解決済み]' : '') +
          '  コメント' + (t.commentCount || 0) + '・添付' + (t.fileCount || 0) +
          '・アンカー' + (t.anchorCount || 0);
      });
      return arr.length + ' 件のスレッド:\n' + lines.join('\n');
    }
    case 'get_thread': {
      const r = await rpc('get_thread', { tid: String(args.tid || '') });
      if (!r || r.found === false) return 'tid=' + args.tid + ' のスレッドは見つかりませんでした。';
      const parts = [];
      parts.push('スレッド tid=' + r.tid + '  「' + (r.title || '(無題)') + '」' + (r.resolved ? ' [解決済み]' : ''));
      if (r.anchors && r.anchors.length) {
        parts.push('本文アンカー: ' + r.anchors.map(function (a) { return JSON.stringify(truncate(a, 60)); }).join(', '));
      } else {
        parts.push('本文アンカー: なし');
      }
      const items = r.items || [];
      if (!items.length) {
        parts.push('(項目なし)');
      } else {
        parts.push('--- 項目(' + items.length + '件) ---');
        items.forEach(function (it) {
          if (it.type === 'file') {
            parts.push('[' + it.index + '] 📎 ファイル: ' + it.path +
              (it.label ? '(' + it.label + ')' : '') + (it.loc ? ' @' + it.loc : ''));
          } else {
            parts.push('[' + it.index + '] 💬 ' + (it.author || '?') + ': ' + truncate(it.text || '(空)', 400));
            (it.replies || []).forEach(function (rep) {
              parts.push('      ↳ ' + (rep.author || '?') + ': ' + truncate(rep.text || '', 300));
            });
          }
        });
      }
      return parts.join('\n');
    }
    case 'create_thread': {
      const r = await rpc('create_thread', {
        title: String(args.title == null ? '' : args.title),
        anchor_text: args.anchor_text == null ? '' : String(args.anchor_text),
      });
      let msg = 'スレッドを作成しました(tid=' + (r && r.tid) + '、タイトル「' + (r && r.title) + '」)。';
      if (r && r.anchorRequested) {
        msg += r.anchored > 0
          ? ' 本文の該当箇所にアンカーを張りました(' + r.anchored + '箇所)。'
          : ' ただし anchor_text は本文に見つからず、アンカーは張れませんでした(スレッド自体は作成済み)。';
      }
      return msg;
    }
    case 'add_thread_comment': {
      const r = await rpc('add_thread_comment', {
        tid: String(args.tid || ''),
        text: String(args.text == null ? '' : args.text),
      });
      if (!r || r.found === false) return 'tid=' + args.tid + ' のスレッドは見つかりませんでした。';
      return 'コメントを追加しました(著者: Claude、tid=' + args.tid + ')。';
    }
    case 'reply_thread': {
      const r = await rpc('reply_thread', {
        tid: String(args.tid || ''),
        item_index: Number(args.item_index),
        text: String(args.text == null ? '' : args.text),
      });
      if (!r || r.found === false) return 'tid=' + args.tid + ' のスレッドは見つかりませんでした。';
      if (r.itemFound === false) {
        return 'item_index=' + args.item_index + ' の項目が見つかりませんでした(このスレッドの項目数: ' +
          (r.itemCount || 0) + ')。get_thread で index を確認してください。';
      }
      return '返信を追加しました(著者: Claude、tid=' + args.tid + '、item_index=' + args.item_index + ')。';
    }
    case 'attach_file_to_thread': {
      const p = String(args.path || '');
      if (!p) throw new Error('path を指定してください。');
      // path がプロジェクト内に存在するか best-effort で確認(現在プロジェクト基準)
      try {
        const pid = await resolveProjectId({});
        const tree = await projectJson('GET', '/projects/' + encodeURIComponent(pid) + '/tree');
        const exists = (Array.isArray(tree) ? tree : []).some(function (e) {
          return e.type === 'file' && e.path === p;
        });
        if (!exists) {
          throw new Error('ファイルが見つかりません: ' + p +
            '。list_project_files で正しい相対パスを確認してください(attachments/ や notes/ 配下)。');
        }
      } catch (e) {
        // ファイル不在エラーはそのまま伝える。ツリー取得自体に失敗した場合のみ検証をスキップ。
        if (/ファイルが見つかりません/.test(e && e.message)) throw e;
      }
      const r = await rpc('attach_file_to_thread', {
        tid: String(args.tid || ''),
        path: p,
        loc: args.loc == null ? '' : String(args.loc),
        label: args.label == null ? '' : String(args.label),
      });
      if (!r || r.found === false) return 'tid=' + args.tid + ' のスレッドは見つかりませんでした。';
      return 'ファイルをスレッドに添付しました(tid=' + args.tid + '、path=' + p + ')。';
    }
    case 'resolve_thread': {
      const r = await rpc('resolve_thread', { tid: String(args.tid || '') });
      if (!r || r.found === false) return 'tid=' + args.tid + ' のスレッドは見つかりませんでした。';
      return 'スレッドを解決済みにしました(tid=' + args.tid + ')。';
    }
    case 'delete_thread': {
      const r = await rpc('delete_thread', { tid: String(args.tid || '') });
      if (!r || r.found === false) return 'tid=' + args.tid + ' のスレッドは見つかりませんでした。';
      return 'スレッドを削除しました(本文アンカーも除去、tid=' + args.tid + ')。';
    }

    // ===== フェーズ25: 数式 / 引用・参考文献 / ライフサイクル =====
    case 'insert_math': {
      const tex = String(args.tex == null ? '' : args.tex);
      if (!tex.trim()) throw new Error('tex(LaTeX 数式)を指定してください。例: {"tex": "E=mc^2"}');
      const r = await rpc('insert_math', {
        tex: tex,
        display: !!args.display,
        position: args.position || 'end',
        heading: args.heading || '',
      });
      return (r && r.display ? '別行の数式' : 'インライン数式') + 'を挿入しました(位置: ' +
        ((r && r.position) || args.position || 'end') + '、tex: ' + truncate(tex, 120) + ')。';
    }
    case 'set_math': {
      const tex = String(args.tex == null ? '' : args.tex);
      if (!tex.trim()) throw new Error('tex(新しい LaTeX 数式)を指定してください。');
      const r = await rpc('set_math', {
        index: args.index == null ? null : Number(args.index),
        find: args.find == null ? '' : String(args.find),
        tex: tex,
      });
      if (!r || r.found === false) {
        return '対象の数式が見つかりませんでした(文書内の数式数: ' + ((r && r.count) || 0) +
          ')。get_blocks や search_document(include_math:true)で数式を確認してください。';
      }
      return '数式(index=' + r.index + '、' + (r.display ? '別行' : 'インライン') +
        ')を書き換えました(tex: ' + truncate(tex, 120) + ')。';
    }
    case 'insert_citation': {
      const key = String(args.key == null ? '' : args.key);
      if (!key.trim()) throw new Error('key(引用キー)を指定してください。例: {"key": "einstein1905"}');
      const r = await rpc('insert_citation', {
        key: key,
        position: args.position || 'end',
        heading: args.heading || '',
      });
      const norm = (r && r.key) || key;
      // refs.bib と照合して未定義キーを警告(プロジェクトモードのみ・best-effort)。
      let warn = '';
      try {
        const id = await resolveProjectId(args);
        const res = await projectFetch('GET', '/projects/' + encodeURIComponent(id) +
          '/file?path=' + encodeURIComponent('refs.bib'));
        if (res.ok) {
          const bib = await res.text();
          const known = extractBibKeys(bib);
          const missing = norm.split(',').map(function (k) { return k.trim(); })
            .filter(function (k) { return k && known.indexOf(k) === -1; });
          if (missing.length) {
            warn = ' ただし refs.bib に未登録のキーがあります: ' + missing.join(', ') +
              '(add_reference で追記してください)。';
          }
        } else {
          try { await res.arrayBuffer(); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* 未接続・単体文書モード等は照合スキップ */ }
      return '引用 \\cite{' + norm + '} を挿入しました(位置: ' + ((r && r.position) || 'end') + ')。' + warn;
    }
    case 'add_reference': {
      const id = await resolveProjectId(args);
      const bibtex = String(args.bibtex == null ? '' : args.bibtex).trim();
      if (!bibtex) throw new Error('bibtex(BibTeX エントリ)を指定してください。');
      const newKeys = extractBibKeys(bibtex);
      if (!newKeys.length) {
        throw new Error('BibTeX エントリのキーを認識できませんでした。@type{key, …} 形式か確認してください(例: @article{einstein1905, …})。');
      }
      // 既存 refs.bib を読む(無ければ新規作成)
      let existing = '';
      const res = await projectFetch('GET', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent('refs.bib'));
      if (res.ok) {
        existing = await res.text();
      } else if (res.status === 404) {
        try { await res.arrayBuffer(); } catch (e) { /* ignore */ }
      } else {
        const t = await res.text();
        let data = null;
        if (t) { try { data = JSON.parse(t); } catch (e) { /* ignore */ } }
        throw new Error(projectErrorMessage(res.status, data && data.error, data && data.message));
      }
      const existingKeys = extractBibKeys(existing);
      const dup = newKeys.filter(function (k) { return existingKeys.indexOf(k) !== -1; });
      if (dup.length && !args.force) {
        throw new Error('キーが重複しています: ' + dup.join(', ') +
          '。既存の refs.bib を上書きしません。別のキーにするか、上書き追記する場合は force:true を指定してください。');
      }
      const merged = existing.replace(/\s*$/, '') +
        (existing.trim() ? '\n\n' : '') + bibtex + '\n';
      const w = await projectJson('PUT', '/projects/' + encodeURIComponent(id) +
        '/file?path=' + encodeURIComponent('refs.bib'), { content: merged });
      return 'refs.bib に ' + newKeys.length + ' 件のエントリ(キー: ' + newKeys.join(', ') + ')を追記しました' +
        (w && w.size != null ? '(refs.bib 合計 ' + w.size + ' bytes)' : '') +
        (dup.length ? '。※ force により重複キー ' + dup.join(', ') + ' も追記(参照時は後勝ち/BibTeX 実装依存)' : '') + '。';
    }
    case 'create_project': {
      const r = await projectJson('POST', '/projects', args.name ? { name: String(args.name) } : {});
      const newId = r && r.id;
      if (!newId) throw new Error('プロジェクトの作成に失敗しました(id が返りませんでした)。');
      return '新しいプロジェクトを作成しました: id=' + newId +
        (args.name ? '(「' + args.name + '」)' : '') +
        '。open_project で開くか、project_id=' + newId + ' を指定してファイル作業ができます。';
    }
    case 'rename_project_file': {
      const id = await resolveProjectId(args);
      const from = String(args.from || '');
      const to = String(args.to || '');
      if (!from || !to) throw new Error('from と to の両方を指定してください。');
      const policyErr = checkPlacementPolicy(to, !!args.force);
      if (policyErr) throw new Error(policyErr);
      await projectJson('POST', '/projects/' + encodeURIComponent(id) + '/rename', { from: from, to: to });
      return 'ファイルを改名/移動しました: ' + from + ' → ' + to;
    }
    case 'delete_document': {
      const did = String(args.id || '');
      const title = String(args.title == null ? '' : args.title);
      if (!did) throw new Error('id を指定してください(list_documents の id)。');
      const r = await rpc('delete_document', { id: did, title: title });
      if (r && r.found === false) {
        return 'id=' + did + ' の文書は見つかりませんでした(list_documents で id を確認してください)。';
      }
      if (r && r.titleMismatch) {
        return '確認用タイトルが一致しません。実際のタイトルは「' + (r.actualTitle || '') +
          '」です。title を正しく指定すると削除できます(誤削除防止)。';
      }
      return 'id=' + did + ' の文書を削除しました(「' + (r && r.title || title) + '」)。';
    }

    default:
      throw new Error('未知のツール: ' + name);
  }
}

// ---------------------------------------------------------------------------
// MCP サーバー起動
// ---------------------------------------------------------------------------
// フェーズ23: 接続時 instructions。クライアント(Claude)がディレクトリを散らかさない
//   よう、プロジェクトのレイアウト規約を最初に提示する(各ツール説明にも要点を再掲)。
const SERVER_INSTRUCTIONS = [
  'TailorTeXのビジュアル執筆環境を操作するツール群。本文編集はブラウザ連動(エディタをブラウザで開いた状態が前提)。',
  '',
  '# ディレクトリ管理方針(projects/<id>/ の規約。ファイルを置く前に必ず従う)',
  '- 標準レイアウト:',
  '  - main.html / main.tex … 本文(直接 write しない。本文ツール edit_html/set_block 等を使う)',
  '  - refs.bib … 参考文献',
  '  - assets/ … 本文が参照する画像等(エディタが管理。手動追加は本文ツール経由)',
  '  - attachments/ … 資料バイナリ(ダウンロードした論文PDFなど)',
  '  - notes/ … メモ・下書き・レビュー・作業ファイル(Claude の自由領域)',
  '  - build/ … コンパイル出力(読み書き禁止・一覧からも除外される)',
  '- Claude が新規に作るファイルは必ず notes/(テキスト)か attachments/(バイナリ資料)配下に置く。',
  '  プロジェクト直下に新規ファイルを置かない(直下に置いてよいのは既定の main.* / refs.bib のみ)。',
  '- 新しいトップレベルフォルダを作らない。分類したいときは notes/ / attachments/ の下にサブフォルダを切る',
  '  (例: notes/レビュー/、attachments/先行研究/)。',
  '- 配置に迷ったら、先に list_project_files で現状ツリーを確認してから決める。',
  '- ファイル名は内容が分かる短い名前。Windows 予約名(CON/PRN/AUX/NUL/COM1-9/LPT1-9)と末尾ドット/スペースは不可(サーバーが拒否する)。',
  '- 一時ファイルは使い終わったら delete_project_file で片付け、意味のある作業単位ごとに commit_project でコミットする。',
].join('\n');

const server = new Server(
  { name: 'word-latex', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async function () {
  return {
    tools: TOOLS.map(function (t) {
      return { name: t.name, description: t.description, inputSchema: t.inputSchema };
    }),
  };
});

server.setRequestHandler(CallToolRequestSchema, async function (req) {
  const name = req.params.name;
  const args = req.params.arguments || {};
  try {
    const text = await callTool(name, args);
    return { content: [{ type: 'text', text: text }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'エラー: ' + (e && e.message ? e.message : String(e)) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio なので stderr にだけログ(stdout は JSON-RPC 専用)
  process.stderr.write('[word-latex mcp] 起動しました。EDITOR_URL=' + EDITOR_URL + '\n');
}

main().catch(function (e) {
  process.stderr.write('[word-latex mcp] 起動失敗: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
