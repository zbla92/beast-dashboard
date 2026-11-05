'use strict';
FEAT.preview = (() => {
  const rawUrl = (where, inline) => `/api/download/${where.id}?path=${encodeURIComponent(where.rel)}${inline ? '&inline=1' : ''}`;
  const copyWithoutClipboardApi = text => {
    const ta = h('textarea', { class: 'fpv-copybuf', readonly: true }); ta.value = text; document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
    try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
  };
  const copyText = async text => {
    if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); return true; } catch {} }
    return copyWithoutClipboardApi(text);
  };

  async function copyBlock(btn) {
    const ok = await copyText(btn.parentElement.querySelector('pre').textContent);
    if (!ok) { toast('copy failed', 'err'); return; }
    btn.replaceChildren(ico('check', 14)); btn.classList.add('ok');
    setTimeout(() => { btn.replaceChildren(ico('copy', 14)); btn.classList.remove('ok'); }, 1400);
  }

  const truncatedNote = () => h('div', { class: 'dim' }, '… truncated (2 MB shown) — download for the whole file');
  const textView = (read, name, line) => {
    const lines = hlLines(read.text, langOf(name));
    return h('pre', { class: 'fcode hljs' }, lines.map((l, i) => h('div', { class: 'ln' + (i + 1 === line ? ' fpv-line' : '') }, h('span', { class: 'n' }, i + 1), h('span', { class: 't', html: l || ' ' }))),
      read.truncated ? truncatedNote() : null);
  };
  const sandboxedFrame = (url, title) => { const frame = h('iframe', { class: 'fmedia pdf', title }); frame.setAttribute('sandbox', ''); frame.src = url; return frame; };
  const shortPath = abs => abs.replace(S.host.home + '/', '~/');
  const isMarkdown = name => /\.(md|markdown)$/i.test(name);
  const isHtml = name => /\.html?$/i.test(name);

  async function fillBody(body, where, line, showCopy) {
    const url = rawUrl(where, true), media = mediaOf(where.name);
    if (media === 'img') { body.replaceChildren(h('div', { class: 'fmedia' }, h('img', { src: url, alt: where.name }))); return; }
    if (media === 'pdf') { body.replaceChildren(h('iframe', { class: 'fmedia pdf', src: url, title: where.name })); return; }
    if (media === 'video') { body.replaceChildren(h('div', { class: 'fmedia' }, h('video', { src: url, controls: true }))); return; }
    if (isHtml(where.name)) { body.replaceChildren(sandboxedFrame(url, where.name)); return; }
    body.replaceChildren(h('div', { class: 'dim fpv-note' }, 'loading…'));
    const read = await api(`read/${where.id}?path=${encodeURIComponent(where.rel)}`).catch(e => ({ error: e.message }));
    if (read.error) { body.replaceChildren(h('div', { class: 'dim fpv-note' }, read.error)); return; }
    if (read.binary) { body.replaceChildren(h('div', { class: 'dim fpv-note' }, 'no preview for this file type — use download')); return; }
    if (!read.truncated) showCopy(read.text);
    if (isMarkdown(where.name) && !line) { body.replaceChildren(h('div', { class: 'ttext fpv-md', html: mdLite(read.text) }), read.truncated ? truncatedNote() : ''); return; }
    body.replaceChildren(textView(read, where.name, line));
    body.querySelector('.fpv-line')?.scrollIntoView({ block: 'center' });
  }

  const current = { request: 0, close: null };

  async function open(abs, line) {
    const request = ++current.request;
    const where = await api('locate-file?p=' + encodeURIComponent(abs)).catch(e => { toast(e.message, 'err'); return null; });
    if (!where || request !== current.request) return;
    current.close?.();
    const m = $('#modal'); m.classList.remove('hidden');
    const stopListening = () => { document.removeEventListener('keydown', onKey, true); current.close = null; };
    const close = () => { stopListening(); m.replaceChildren(); m.classList.add('hidden'); };
    const onKey = e => {
      if (!box.isConnected || m.classList.contains('hidden')) { stopListening(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    current.close = close;
    const copyBtn = h('button', { class: 'btn sm ghost icon hidden', title: 'copy the whole file', 'aria-label': 'copy the whole file' }, ico('copy', 15));
    const showCopy = text => {
      copyBtn.classList.remove('hidden');
      copyBtn.onclick = async () => { const ok = await copyText(text); toast(ok ? 'copied' : 'copy failed', ok ? 'ok' : 'err'); };
    };
    const body = h('div', { class: 'fpv-body' });
    const box = h('div', { class: 'box dlx fpv' },
      h('div', { class: 'sh' },
        fileIcon(where.name),
        h('div', { class: 'fpv-title' }, h('b', { title: where.name }, where.name), h('span', { class: 'dim', title: abs }, shortPath(abs) + ' · ' + fmtB(where.size))),
        copyBtn,
        navigator.standalone ? null : h('a', { class: 'btn sm ghost icon', href: rawUrl(where, true), target: '_blank', rel: 'noopener', title: 'open in a new tab', 'aria-label': 'open in a new tab' }, gico('↗', 15)),
        h('a', { class: 'btn sm ghost icon', href: rawUrl(where, false), download: where.name, title: 'download', 'aria-label': 'download' }, ico('download', 15)),
        h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', 'aria-label': 'close', onclick: close }, ico('x', 15))),
      body,
      h('button', { class: 'fpv-close', title: 'close', 'aria-label': 'close', onclick: close }, ico('x', 22)));
    body.onclick = e => { if (e.target.matches('div.fmedia')) close(); };
    m.replaceChildren(box); m.onclick = e => { if (e.target === m) close(); };
    await fillBody(body, where, line, showCopy);
  }

  document.addEventListener('click', ev => {
    const hit = ev.target.closest?.('.mcopy, .mpath'); if (!hit) return;
    ev.preventDefault(); ev.stopPropagation();
    if (hit.classList.contains('mcopy')) { copyBlock(hit); return; }
    open(hit.dataset.path, +hit.dataset.line || 0);
  }, true);

  return { open };
})();
