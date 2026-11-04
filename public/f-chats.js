'use strict';
window.CHATS = (() => {
  const KEY = 'chat:', LIST = 'chats', MAX_CHATS = 10, MAX_BYTES = 524288, SAVE_GAP_MS = 60000, BAR_MS = 15000;
  const st = { chain: Promise.resolve(), last: new Map(), bar: null, timer: 0 };

  const queue = fn => { const q = st.chain.then(fn).catch(() => undefined); st.chain = q; return q; };

  const readList = () => LOCAL.get(LIST).then(rec => rec && Array.isArray(rec.data) ? rec.data.filter(e => e && typeof e.name === 'string') : []);

  const jsonOf = d => { try { return JSON.stringify(d); } catch { return ''; } };

  const load = (name, capMs) => LOCAL.get(KEY + name, capMs).then(rec => rec && rec.data && Array.isArray(rec.data.turns) ? rec.data : null);

  const drop = name => {
    st.last.delete(name);
    return queue(async () => {
      await LOCAL.del(KEY + name);
      const list = await readList();
      if (list.some(e => e.name === name)) await LOCAL.put(LIST, list.filter(e => e.name !== name));
    });
  };

  const save = (name, t, ver) => {
    if (!t || t.empty || !Array.isArray(t.turns)) return Promise.resolve(false);
    const sig = t.sig + ':' + t.total, prev = st.last.get(name);
    if (prev && prev.sig === sig && Date.now() - prev.at < SAVE_GAP_MS) return Promise.resolve(false);
    const json = jsonOf(t);
    if (!json || new TextEncoder().encode(json).length > MAX_BYTES) return drop(name).then(() => false);
    st.last.set(name, { sig, at: Date.now() });
    const copy = structuredClone(t);
    return queue(async () => {
      if (!await LOCAL.put(KEY + name, copy, ver)) return false;
      const list = [{ name, at: Date.now() }, ...(await readList()).filter(e => e.name !== name)];
      for (const e of list.slice(MAX_CHATS)) { st.last.delete(e.name); await LOCAL.del(KEY + e.name); }
      return LOCAL.put(LIST, list.slice(0, MAX_CHATS));
    });
  };

  const prune = names => {
    const live = new Set(names);
    return queue(async () => {
      const list = await readList();
      const gone = list.filter(e => !live.has(e.name));
      for (const e of gone) { st.last.delete(e.name); await LOCAL.del(KEY + e.name); }
      if (gone.length) await LOCAL.put(LIST, list.filter(e => live.has(e.name)));
      const kept = new Set(list.filter(e => live.has(e.name)).map(e => KEY + e.name));
      for (const k of await LOCAL.keys()) if (typeof k === 'string' && k.startsWith(KEY) && !kept.has(k)) await LOCAL.del(k);
    });
  };

  const barOff = () => {
    clearTimeout(st.timer);
    if (st.bar) st.bar.classList.remove('on');
  };

  const barOn = (box, text, ms = BAR_MS) => {
    if (!box || !box.isConnected) return;
    if (!st.bar) { st.bar = document.createElement('div'); st.bar.className = 'cupd'; st.bar.setAttribute('role', 'status'); document.body.append(st.bar); }
    const r = box.getBoundingClientRect();
    Object.assign(st.bar.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px' });
    st.bar.textContent = text;
    st.bar.classList.add('on');
    clearTimeout(st.timer);
    st.timer = setTimeout(barOff, ms);
  };

  return { load, save, drop, prune, barOn, barOff, MAX_CHATS, MAX_BYTES };
})();
