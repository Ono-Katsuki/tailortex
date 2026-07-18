(function () {
  'use strict';
  var dialog = document.getElementById('codex-inbox');
  var openBtn = document.getElementById('toggle-codex-inbox');
  var closeBtn = document.getElementById('codex-inbox-close');
  var form = document.getElementById('codex-inbox-form');
  var input = document.getElementById('codex-inbox-text');
  var recipient = document.getElementById('codex-inbox-recipient');
  var messages = document.getElementById('codex-inbox-messages');
  var state = document.getElementById('codex-inbox-state');
  var badge = document.getElementById('codex-inbox-badge');
  var contextBox = document.getElementById('codex-inbox-context');
  var contextLabel = document.getElementById('codex-context-label');
  var contextText = document.getElementById('codex-context-text');
  var contextRemove = document.getElementById('codex-context-remove');
  var timer = null;
  var lastJson = '';
  var selectedContext = null;
  var selectedRange = null;
  var selectionAction = document.createElement('button');
  selectionAction.type = 'button'; selectionAction.className = 'selection-ai-action';
  selectionAction.textContent = 'AIに聞く'; selectionAction.hidden = true;
  selectionAction.setAttribute('aria-label', '選択範囲についてAIに聞く');
  document.body.appendChild(selectionAction);
  try { recipient.value = localStorage.getItem('ratex.ai.recipient') || 'codex'; } catch (e) { /* private mode */ }
  recipient.addEventListener('change', function () { try { localStorage.setItem('ratex.ai.recipient', recipient.value); } catch (e) { /* ignore */ } });

  function projectId() {
    try { return window.Projects && window.Projects.current ? window.Projects.current() || '' : ''; } catch (e) { return ''; }
  }
  function timeLabel(value) {
    try { return new Date(value).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch (e) { return ''; }
  }
  function addBubble(text, cls, meta) {
    var el = document.createElement('div'); el.className = 'codex-message ' + cls;
    el.appendChild(document.createTextNode(text));
    var small = document.createElement('small'); small.textContent = meta; el.appendChild(small); messages.appendChild(el);
  }
  function addPointer(pointer, threadId) {
    var button = document.createElement('button'); button.type = 'button'; button.className = 'codex-pointer';
    button.textContent = pointer.label || (pointer.kind === 'document' ? pointer.text.slice(0, 80) : pointer.path + (pointer.page ? ' p.' + pointer.page : ''));
    button.addEventListener('click', function () {
      close();
      if (pointer.kind === 'document') {
        var refs = document.querySelectorAll('#doc .thread-ref[data-tid="' + String(threadId).replace(/"/g, '') + '"]');
        var target = Array.prototype.find.call(refs, function (x) { return !pointer.text || (x.textContent || '').indexOf(pointer.text.slice(0, 20)) !== -1; }) || refs[0];
        if (target) { target.scrollIntoView({ behavior:'smooth', block:'center' }); target.classList.add('thread-jump-highlight'); setTimeout(function () { target.classList.remove('thread-jump-highlight'); }, 1800); }
      } else if (window.FileViewer) window.FileViewer.open(pointer.path, pointer.page ? { loc:'p.' + pointer.page } : {});
    });
    messages.appendChild(button);
  }
  function rememberSelection() {
    var active = document.activeElement;
    if (active && active.tagName === 'TEXTAREA' && active.closest('#file-viewer') && active.selectionStart !== active.selectionEnd) {
      selectedContext = { kind:'note', path:(document.querySelector('#file-viewer .fv-title') || {}).textContent || '', text:active.value.slice(active.selectionStart, active.selectionEnd) };
      showSelectionAction(active.getBoundingClientRect());
      return;
    }
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    var doc = el && el.closest && el.closest('#doc');
    var viewer = el && el.closest && el.closest('#file-viewer');
    if (!doc && !viewer) return;
    var value = sel.toString().trim(); if (!value) return;
    selectedRange = sel.getRangeAt(0).cloneRange();
    selectedContext = { kind:viewer ? 'note' : 'document', path:viewer ? ((viewer.querySelector('.fv-title') || {}).textContent || '') : 'main.tex', text:value.slice(0, 30000) };
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    showSelectionAction(rect);
  }
  function showSelectionAction(rect) {
    if (!rect || !selectedContext || !dialog.hidden) return;
    selectionAction.hidden = false;
    var left = Math.max(8, Math.min(window.innerWidth - 110, rect.left + rect.width / 2 - 45));
    var top = rect.top - 48;
    if (top < 8) top = Math.min(window.innerHeight - 52, rect.bottom + 8);
    selectionAction.style.left = left + 'px'; selectionAction.style.top = top + 'px';
  }
  function hideSelectionAction() { selectionAction.hidden = true; }
  function showContext() {
    contextBox.hidden = !selectedContext;
    if (!selectedContext) return;
    contextLabel.textContent = selectedContext.kind === 'note' ? 'メモ: ' + selectedContext.path : '本文の選択範囲';
    contextText.textContent = selectedContext.text;
  }
  function render(items) {
    var json = JSON.stringify(items);
    if (json === lastJson) {
      items.forEach(function (item) { if (item.status === 'answered') syncThreadReply(item, item.recipient === 'claude_code' ? 'Claude Code' : 'Codex'); });
      return;
    }
    lastJson = json;
    messages.textContent = '';
    if (!items.length) { addBubble('まだ依頼はありません。ここからMac上のAIへ送れます。', 'reply', '受信箱'); }
    items.forEach(function (item) {
      var agent = item.recipient === 'claude_code' ? 'Claude Code' : 'Codex';
      if (item.context && item.context.text) {
        addBubble(item.context.text, 'reply', (item.context.kind === 'note' ? '添付メモ: ' + item.context.path : '添付した本文の選択範囲'));
      }
      var waiting = item.status === 'pending' || item.status === 'processing';
      addBubble(item.text, 'user', item.status === 'pending' ? '送信済み・' + agent + 'の起動待ち' : agent + '宛・' + timeLabel(item.createdAt));
      if (item.reply) addBubble(item.reply, 'reply' + (item.status === 'processing' ? ' streaming' : ''), item.status === 'processing' ? agent + 'が入力中…' : 'Mac上の' + agent + '・' + timeLabel(item.answeredAt));
      else if (item.status === 'processing') addBubble('考えています…', 'reply streaming', agent + 'が入力中…');
      (item.pointers || []).forEach(function (pointer) { addPointer(pointer, item.thread_id); });
      if (!waiting) syncThreadReply(item, agent);
    });
    var pending = items.some(function (x) { return x.status === 'pending' || x.status === 'processing'; });
    badge.hidden = !pending; messages.scrollTop = messages.scrollHeight;
  }
  function createConversationThread(question) {
    if (!selectedContext || !window.Threads) return null;
    if (selectedContext.kind === 'document' && selectedRange && window.Editor && window.Editor.createThreadFromRange) {
      return window.Editor.createThreadFromRange(selectedRange, question, 'あなた', selectedContext.text);
    }
    if (selectedContext.kind === 'note') {
      var thread = window.Threads.create(selectedContext.text.slice(0, 60) || selectedContext.path);
      var comment = window.Threads.addComment(thread.tid, question, 'あなた');
      window.Threads.addFile(thread.tid, selectedContext.path, selectedContext.text.slice(0, 500), selectedContext.path);
      window.Threads.render();
      return { tid:thread.tid, itemId:comment && comment.id };
    }
    return null;
  }
  function syncThreadReply(item, agent) {
    if (!item.reply || !item.thread_id || !window.Threads) return;
    var thread = window.Threads.get(item.thread_id); if (!thread) return;
    var comment = (thread.items || []).filter(function (x) { return x.type === 'comment'; })[0];
    if (!comment) return;
    var exists = (comment.replies || []).some(function (x) { return x.text === item.reply && x.author === agent; });
    if (!exists) { window.Threads.reply(comment.id, item.reply, agent); window.Threads.render(); }
    (item.pointers || []).forEach(function (pointer) {
      if (pointer.kind === 'file') {
        var hasFile = (thread.items || []).some(function (x) { return x.type === 'file' && x.path === pointer.path && String(x.loc || '') === (pointer.page ? 'p.' + pointer.page : ''); });
        if (!hasFile) window.Threads.addFile(thread.tid, pointer.path, pointer.page ? 'p.' + pointer.page : '', pointer.label || pointer.path);
      } else if (pointer.text && window.AgentBridge && window.AgentBridge.pointTo) {
        var anchored = Array.prototype.some.call(document.querySelectorAll('#doc .thread-ref[data-tid="' + thread.tid + '"]'), function (x) { return (x.textContent || '').indexOf(pointer.text.slice(0, 20)) !== -1; });
        if (!anchored) window.AgentBridge.pointTo(thread.tid, pointer.text);
      }
    });
    window.Threads.render();
  }
  async function refresh() {
    var query = projectId() ? '?project_id=' + encodeURIComponent(projectId()) : '';
    try { var res = await fetch('/agent/inbox' + query, { cache:'no-store' }); if (res.ok) render(await res.json()); }
    catch (e) { if (!dialog.hidden) state.textContent = 'Macとの接続を確認中…'; }
  }
  function open() { rememberSelection(); hideSelectionAction(); showContext(); dialog.hidden = false; openBtn.setAttribute('aria-expanded', 'true'); refresh(); timer = setInterval(refresh, 300); if (selectedContext) input.placeholder = 'この箇所について質問・修正依頼を書く'; setTimeout(function () { input.focus(); }, 0); }
  function close() { dialog.hidden = true; openBtn.setAttribute('aria-expanded', 'false'); if (timer) clearInterval(timer); timer = null; openBtn.focus(); }
  openBtn.addEventListener('click', open); closeBtn.addEventListener('click', close);
  selectionAction.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  selectionAction.addEventListener('click', open);
  document.addEventListener('selectionchange', rememberSelection);
  contextRemove.addEventListener('click', function () { selectedContext = null; showContext(); });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dialog.hidden) close(); });
  window.addEventListener('scroll', hideSelectionAction, true);
  window.addEventListener('resize', hideSelectionAction);
  form.addEventListener('submit', async function (e) {
    e.preventDefault(); var text = input.value.trim(); if (!text) { input.focus(); return; }
    state.textContent = '送信中…'; form.querySelector('button[type=submit]').disabled = true;
    var conversation = createConversationThread(text);
    try {
      var res = await fetch('/agent/inbox', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text:text, project_id:projectId(), recipient:recipient.value, context:selectedContext, thread_id:conversation && conversation.tid }) });
      if (!res.ok) throw new Error('HTTP ' + res.status); input.value = ''; selectedContext = null; showContext(); state.textContent = 'Macへ送りました'; lastJson = ''; await refresh();
    } catch (err) {
      if (conversation && window.Threads) { if (window.Editor && window.Editor.removeThreadAnchors) window.Editor.removeThreadAnchors(conversation.tid); window.Threads.remove(conversation.tid); }
      state.textContent = '送信できません。Macとの接続を確認してください。';
    }
    form.querySelector('button[type=submit]').disabled = false;
  });
  refresh(); setInterval(function () { if (dialog.hidden) refresh(); }, 15000);
}());
