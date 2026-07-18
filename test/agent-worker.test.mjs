import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sessionKey, slashCommand, applyStreamEvent, promptFor } = require('../agent-worker.js');

test('agent sessions are isolated by recipient and project', () => {
  assert.equal(sessionKey({ recipient:'codex', project_id:'project1' }), 'codex:project1');
  assert.equal(sessionKey({ recipient:'claude_code', project_id:'project1' }), 'claude_code:project1');
  assert.equal(sessionKey({ recipient:'codex', project_id:'' }), 'codex:global');
});

test('/status and /help are handled without launching an agent', () => {
  const sessions = { 'codex:project1': { sessionId:'thread-1', model:'gpt-test' } };
  const status = slashCommand({ text:'/status', recipient:'codex', project_id:'project1' }, sessions);
  assert.match(status, /セッション: 継続中/);
  assert.match(status, /モデル: gpt-test/);
  const help = slashCommand({ text:'/help', recipient:'claude_code', project_id:'project1' }, sessions);
  assert.match(help, /\/clear/);
  assert.match(help, /\/model/);
});

test('Claude streaming events append deltas and retain session id', () => {
  const state = { streamed:'', finalText:'', sessionId:'' };
  const partials = [];
  applyStreamEvent({ session_id:'claude-session', type:'stream_event', event:{ type:'content_block_delta', delta:{ text:'Hello' } } }, true, state, (x) => partials.push(x));
  applyStreamEvent({ type:'stream_event', event:{ type:'content_block_delta', delta:{ text:' world' } } }, true, state, (x) => partials.push(x));
  applyStreamEvent({ type:'result', result:'Hello world' }, true, state);
  assert.equal(state.sessionId, 'claude-session');
  assert.equal(state.streamed, 'Hello world');
  assert.equal(state.finalText, 'Hello world');
  assert.deepEqual(partials, ['Hello', 'Hello world']);
});

test('Codex streaming events update a single message without duplication', () => {
  const state = { streamed:'', finalText:'', sessionId:'' };
  applyStreamEvent({ type:'thread.started', thread_id:'codex-thread' }, false, state);
  applyStreamEvent({ type:'item.updated', item:{ type:'agent_message', text:'First' } }, false, state);
  applyStreamEvent({ type:'item.completed', item:{ type:'agent_message', text:'First answer' } }, false, state);
  assert.equal(state.sessionId, 'codex-thread');
  assert.equal(state.streamed, 'First answer');
  assert.equal(state.finalText, 'First answer');
});

test('agent prompt preserves publication data and scopes core operations', () => {
  const prompt = promptFor({ text:'Please inspect this section', recipient:'codex', project_id:'project1' });
  assert.match(prompt, /既存の原稿とユーザー変更を失わない/);
  assert.match(prompt, /project1/);
});
