'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const POLL_MS = 2500;
const ROOT = __dirname;
const SESSION_FILE = path.join(ROOT, 'projects', '.ratex-agent-sessions.json');

function readSessions() {
  try { const value = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch (e) { return {}; }
}
function writeSessions(value) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive:true });
  const tmp = SESSION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, SESSION_FILE);
}
function sessionKey(item) { return (item.recipient === 'claude_code' ? 'claude_code' : 'codex') + ':' + (item.project_id || 'global'); }
function slashCommand(item, sessions) {
  const text = String(item.text || '').trim(); if (text.charAt(0) !== '/') return null;
  const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/); if (!match) return null;
  const command = match[1].toLowerCase(), arg = String(match[2] || '').trim(), key = sessionKey(item);
  const current = sessions[key] || {};
  if (command === 'clear' || command === 'new') { delete sessions[key]; writeSessions(sessions); return 'この' + (item.recipient === 'claude_code' ? 'Claude Code' : 'Codex') + 'セッションをリセットしました。次の依頼から新しい会話になります。'; }
  if (command === 'model') {
    if (!arg) return '現在のモデル: ' + (current.model || 'CLIの既定モデル');
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(arg)) return 'モデル名に使用できない文字があります。例: /model gpt-5.4';
    current.model = arg; sessions[key] = current; writeSessions(sessions);
    return 'モデルを `' + arg + '` に変更しました。次の依頼から使用します。';
  }
  if (command === 'status') return [
    '宛先: ' + (item.recipient === 'claude_code' ? 'Claude Code' : 'Codex'),
    'セッション: ' + (current.sessionId ? '継続中' : '新規'),
    'モデル: ' + (current.model || 'CLIの既定モデル'),
  ].join('\n');
  if (command === 'help') return ['/clear — 会話文脈をリセット', '/new — 新しい会話を開始', '/model <名前> — モデル変更', '/model — 現在のモデル', '/status — 接続・セッション状態', '/help — コマンド一覧'].join('\n');
  return '未対応のコマンドです。`/help` で利用可能なコマンドを確認できます。';
}

function request(method, route, body, port) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ': ' + text));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('Invalid JSON: ' + text.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function promptFor(item) {
  const context = item.context && item.context.text ?
    '\n\n選択された資料・本文:\n' + item.context.text + (item.context.path ? '\n対象ファイル: ' + item.context.path : '') : '';
  return [
    'あなたはTailorTeX上で研究者と協働する研究パートナーです。',
    '対象リポジトリは ' + ROOT + '、対象プロジェクトIDは ' + (item.project_id || '未指定') + ' です。',
    '依頼を実際に処理してください。依頼された範囲ではファイル編集、保存、検証、版切替も実行できます。既存の原稿とユーザー変更を失わないでください。',
    'ブランチ切替・コミット・ブラウザ操作は、依頼に明記されている場合か作業上不可欠な場合だけ行い、最後の回答で明示してください。',
    '最後の回答はiPadのチャット欄へそのまま表示されます。日本語で、結果を先に簡潔に書いてください。',
    '\n依頼:\n' + item.text + context,
  ].join('\n');
}

function backupProject(item) {
  const id = String(item.project_id || '');
  if (!/^[A-Za-z0-9]{8}$/.test(id)) return '';
  const projectDir = path.join(ROOT, 'projects', id);
  if (!fs.existsSync(projectDir)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(projectDir, '.ratex-recovery', 'agent', stamp + '-' + item.id);
  let copied = 0;
  for (const name of ['main.tex', 'main.html', 'refs.bib', 'project.json']) {
    const source = path.join(projectDir, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(source, path.join(backupDir, name));
    copied++;
  }
  return copied ? backupDir : '';
}

function applyStreamEvent(event, isClaude, state, onPartial) {
  if (!event || typeof event !== 'object') return;
  if (isClaude) {
    if (event.session_id) state.sessionId = String(event.session_id);
    if (event.type === 'stream_event' && event.event && event.event.type === 'content_block_delta' && event.event.delta && event.event.delta.text) {
      state.streamed += event.event.delta.text; if (onPartial) onPartial(state.streamed);
    }
    if (event.type === 'result' && event.result) state.finalText = String(event.result);
    return;
  }
  if (event.type === 'thread.started' && event.thread_id) state.sessionId = String(event.thread_id);
  const entry = event.item || {};
  if ((event.type === 'item.completed' || event.type === 'item.updated') && entry.type === 'agent_message' && entry.text) {
    state.finalText = String(entry.text);
    if (!state.streamed || state.finalText.indexOf(state.streamed) !== 0) {
      state.streamed = state.finalText; if (onPartial) onPartial(state.streamed);
    } else if (state.finalText.length > state.streamed.length) {
      state.streamed += state.finalText.slice(state.streamed.length); if (onPartial) onPartial(state.streamed);
    }
  }
}

function runAgent(item, session, onPartial) {
  return new Promise((resolve, reject) => {
    const isClaude = item.recipient === 'claude_code';
    const outputFile = path.join(os.tmpdir(), 'ratex-agent-' + item.id + '.txt');
    const command = isClaude ? 'claude' : 'codex';
    let args = isClaude
      ? ['--print', '--verbose', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--include-partial-messages']
      : (session.sessionId
        ? ['exec', 'resume', session.sessionId, '--json', '--output-last-message', outputFile, '-']
        : ['exec', '--sandbox', 'workspace-write', '--cd', ROOT, '--json', '--output-last-message', outputFile, '-']);
    if (isClaude && session.sessionId) args.push('--resume', session.sessionId);
    if (session.model) {
      const stdinIndex = args.lastIndexOf('-');
      args.splice(stdinIndex < 0 ? args.length : stdinIndex, 0, '--model', session.model);
    }
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lineBuffer = '', streamed = '', finalText = '', sessionId = session.sessionId || '';
    function emit(text) { if (!text) return; streamed += text; if (onPartial) onPartial(streamed); }
    function consume(line) {
      let event; try { event = JSON.parse(line); } catch (e) { return; }
      const state = { streamed, finalText, sessionId };
      applyStreamEvent(event, isClaude, state, onPartial);
      streamed = state.streamed; finalText = state.finalText; sessionId = state.sessionId;
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk; lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop();
      lines.forEach(consume);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (lineBuffer.trim()) consume(lineBuffer.trim());
      let answer = finalText || streamed || stdout.trim();
      if (!isClaude) {
        try { answer = fs.readFileSync(outputFile, 'utf8').trim() || answer; } catch (e) { /* stdout fallback */ }
        try { fs.unlinkSync(outputFile); } catch (e) { /* already absent */ }
      }
      if (code !== 0 && !answer) return reject(new Error((stderr || command + ' exited with ' + code).trim().slice(-2000)));
      resolve({ reply:answer || '処理は完了しましたが、返信本文がありませんでした。', sessionId });
    });
    child.stdin.end(promptFor(item));
  });
}

function startAgentWorker(options) {
  const port = Number(options && options.port) || 3000;
  const active = new Set();
  const sessions = readSessions();
  let stopped = false;
  async function poll() {
    if (stopped) return;
    try {
      const items = await request('GET', '/agent/inbox?status=pending', null, port);
      const item = Array.isArray(items) && items.find((x) => !active.has(x.id));
      if (item) {
        active.add(item.id);
        console.log('[agent-worker] ' + item.recipient + ' started: ' + item.id);
        try {
          await request('PATCH', '/agent/inbox/' + encodeURIComponent(item.id), { partial:'' }, port);
          const commandReply = slashCommand(item, sessions);
          if (commandReply != null) {
            await request('PATCH', '/agent/inbox/' + encodeURIComponent(item.id), { reply:commandReply }, port);
            console.log('[agent-worker] command answered: ' + item.id);
            if (!stopped) setTimeout(poll, POLL_MS);
            return;
          }
          const backup = backupProject(item);
          if (backup) console.log('[agent-worker] backup: ' + backup);
          let lastPartial = '', partialTimer = null, partialChain = Promise.resolve();
          const key = sessionKey(item), session = sessions[key] || {};
          const result = await runAgent(item, session, function (text) {
            lastPartial = text;
            if (partialTimer) return;
            partialTimer = setTimeout(function () {
              partialTimer = null;
              partialChain = partialChain.then(function () {
                return request('PATCH', '/agent/inbox/' + encodeURIComponent(item.id), { partial:lastPartial }, port);
              }).catch(() => {});
            }, 120);
          });
          if (partialTimer) {
            clearTimeout(partialTimer); partialTimer = null;
            partialChain = partialChain.then(function () {
              return request('PATCH', '/agent/inbox/' + encodeURIComponent(item.id), { partial:lastPartial }, port);
            }).catch(() => {});
          }
          await partialChain;
          if (result.sessionId) { session.sessionId = result.sessionId; sessions[key] = session; writeSessions(sessions); }
          await request('PATCH', '/agent/inbox/' + encodeURIComponent(item.id), { reply:result.reply }, port);
          console.log('[agent-worker] answered: ' + item.id);
        } catch (e) {
          console.error('[agent-worker] failed: ' + item.id + ': ' + e.message);
          await request('PATCH', '/agent/inbox/' + encodeURIComponent(item.id), {
            reply: 'Mac上の' + (item.recipient === 'claude_code' ? 'Claude Code' : 'Codex') + 'を起動できませんでした。\n\n' + e.message,
          }, port).catch(() => {});
        } finally { active.delete(item.id); }
      }
    } catch (e) { /* server startup/shutdown while polling */ }
    if (!stopped) setTimeout(poll, POLL_MS);
  }
  setTimeout(poll, 500);
  return { stop() { stopped = true; } };
}

module.exports = { startAgentWorker, promptFor, backupProject, sessionKey, slashCommand, applyStreamEvent };
