/* poolmanager admin UI — plain JS, no build step. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let loginAt = 0;
  const api = async (path, opts = {}) => {
    const { _retried, ...fetchOpts } = opts;
    const res = await fetch(`/admin/api${path}`, {
      headers: { 'content-type': 'application/json', ...(fetchOpts.headers || {}) },
      credentials: 'same-origin',
      ...fetchOpts,
      body: fetchOpts.body !== undefined ? JSON.stringify(fetchOpts.body) : undefined,
    });
    if (res.status === 401) {
      // The session cookie set by /login can lag the next request by a few ms
      // in Chromium; retry once shortly after a login instead of bouncing.
      if (!_retried && Date.now() - loginAt < 3000) { await sleep(200); return api(path, { ...opts, _retried: true }); }
      showLogin(); throw new Error('login required');
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* plain text (logs) */ }
    if (!res.ok) throw new Error((data && data.error) || text || res.statusText);
    return data;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => (s ? new Date(s).toLocaleString() : '—');
  const fmtNum = (n) => Number(n || 0).toLocaleString();
  const STATE_TEXT = { running: '运行中', starting: '启动中', unhealthy: '异常', error: '失败', stopped: '已停止' };
  const state = (s) => `<span class="state ${esc(s)}">${esc(STATE_TEXT[s] || s)}</span>`;
  const onoff = (b) => (b ? '<span class="pill on">启用</span>' : '<span class="pill off">停用</span>');
  const empty = (cols, text) => `<tr><td colspan="${cols}" class="empty">${esc(text)}</td></tr>`;
  let toastTimer;
  const toast = (msg) => {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  };

  // ---- auth ----------------------------------------------------------------
  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
  function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/login', { method: 'POST', body: { token: $('#login-token').value } });
      loginAt = Date.now();
      $('#login-token').value = '';
      for (let i = 0; i < 10; i += 1) {
        const me = await api('/me').catch(() => ({}));
        if (me.authenticated) break;
        await sleep(100);
      }
      showApp(); route();
    } catch (err) { $('#login-error').textContent = err.message === 'login required' ? 'token 不正确' : err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // ---- dialog ----------------------------------------------------------------
  function openDialog(title, fields, onSubmit, okLabel = '保存') {
    const dlg = $('#dialog');
    $('#dialog-title').textContent = title;
    $('#dialog-ok').textContent = okLabel;
    $('#dialog-error').textContent = '';
    $('#dialog-fields').innerHTML = fields.map((f) => {
      const id = `f-${f.name}`;
      if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select id="${id}">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea id="${id}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      return `<label>${esc(f.label)}<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}></label>`;
    }).join('');
    const form = $('#dialog-form');
    const read = () => Object.fromEntries(fields.map((f) => {
      const el = $(`#f-${f.name}`);
      let v = f.type === 'checkbox' ? el.checked : el.value;
      if (f.type === 'number') v = v === '' ? null : Number(v);
      return [f.name, v];
    }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      $('#dialog-ok').disabled = true;
      try { await onSubmit(read()); dlg.close(); }
      catch (err) { $('#dialog-error').textContent = err.message; }
      finally { $('#dialog-ok').disabled = false; }
    };
    $('#dialog-cancel').onclick = () => dlg.close();
    dlg.showModal();
  }

  // ---- views ------------------------------------------------------------------
  const views = {
    async overview() {
      const o = await api('/overview');
      $('#meta').textContent = `副本 ${o.instance} · v${o.version}`;
      const inflight = o.accounts.reduce((s, a) => s + (a.inflight || 0), 0);
      const capacity = o.accounts.filter((a) => a.status === 'running').reduce((s, a) => s + a.max_concurrency, 0);
      $('#stats').innerHTML = [
        ['运行中账号', `${o.accounts_running} / ${o.accounts_total}`],
        ['在途请求', `${inflight} / ${capacity}`],
        ['Runner', o.runners],
      ].map(([l, v]) => `<div class="item"><span class="value">${esc(v)}</span><span class="label">${l}</span></div>`).join('');
      $('#lanes').innerHTML = o.accounts.map((a) => {
        const st = a.enabled ? a.status : 'stopped';
        const pct = Math.min(100, Math.round(100 * (a.inflight || 0) / Math.max(1, a.max_concurrency)));
        return `<div class="lane ${esc(st)}">
          <div><div class="name">${esc(a.name)}</div><span class="sub muted">${esc(a.runner_id)}:${a.port}${a.chatgpt_account_id ? '  账号 ' + esc(a.chatgpt_account_id.slice(0, 8)) : ''}</span></div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="count">${state(st)}<br><span class="muted">${a.inflight} / ${a.max_concurrency}</span></div>
          ${a.last_error ? `<div class="err">${esc(a.last_error)}</div>` : ''}
        </div>`;
      }).join('') || '<div class="empty">还没有账号。到"账号"页粘贴 auth.json 创建第一个。</div>';
    },

    async accounts() {
      const [accounts, runners] = await Promise.all([api('/accounts'), api('/runners')]);
      $('#accounts-table tbody').innerHTML = accounts.map((a) => `<tr data-id="${a.id}">
        <td>${esc(a.name)}</td><td>${state(a.status)}</td><td>${esc(a.runner_id)}</td><td class="mono">${a.port}</td>
        <td class="mono">${esc(a.proxy_url || '—')}</td><td class="num">${a.max_concurrency}</td><td class="num">${a.rpm_limit ?? '∞'}</td>
        <td>${onoff(a.enabled)}</td>
        <td class="actions">
          <button class="btn small" data-act="start">启动</button>
          <button class="btn small" data-act="restart">重启</button>
          <button class="btn small" data-act="stop">停止</button>
          <button class="btn small" data-act="logs">日志</button>
          <button class="btn small" data-act="edit">编辑</button>
          <button class="btn small danger" data-act="delete">删除</button>
        </td></tr>`).join('') || empty(9, '还没有账号。点右上角"新建账号",粘贴 codex login 生成的 auth.json。');

      const runnerOpts = runners.map((r) => ({ value: r.id, label: `${r.id} (${r.public_host})` }));
      const fields = (a = {}) => [
        { name: 'name', label: '名称', value: a.name, required: true },
        { name: 'runner_id', label: 'Runner', type: 'select', options: runnerOpts, value: a.runner_id || (runnerOpts[0] || {}).value },
        { name: 'port', label: '实例端口(同一 runner 内唯一)', type: 'number', value: a.port ?? nextPort(accounts), required: true },
        { name: 'proxy_url', label: '出口代理,可留空(http:// 、socks5:// 或 socks5h://)', value: a.proxy_url || '' },
        { name: 'max_concurrency', label: '最大并发', type: 'number', value: a.max_concurrency ?? 4 },
        { name: 'rpm_limit', label: '每分钟请求上限,留空不限', type: 'number', value: a.rpm_limit ?? '' },
        { name: 'auth_json', label: a.id ? 'auth.json,留空则保持不变' : 'auth.json 内容(codex login 生成)', type: 'textarea', placeholder: '{"auth_mode":"chatgpt","tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}' },
        { name: 'enabled', label: '启用,由后台自动拉起', type: 'checkbox', value: a.enabled ?? true },
      ];
      const toBody = (v) => {
        let auth = null;
        if (v.auth_json && v.auth_json.trim()) {
          try { auth = JSON.parse(v.auth_json); } catch { throw new Error('auth.json 不是合法 JSON'); }
        }
        return { ...v, proxy_url: v.proxy_url || null, auth_json: auth };
      };
      $('#account-new').onclick = () => {
        if (!runnerOpts.length) return toast('先在 Runner 页添加一个 runner');
        openDialog('新建账号', fields(), async (v) => {
          const body = toBody(v);
          if (!body.auth_json) throw new Error('需要 auth.json');
          await api('/accounts', { method: 'POST', body });
          toast('账号已创建'); route();
        }, '创建');
      };
      $('#accounts-table').onclick = async (e) => {
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        const id = btn.closest('tr').dataset.id; const act = btn.dataset.act;
        const a = accounts.find((x) => x.id === id);
        try {
          if (act === 'edit') {
            openDialog('编辑账号', fields(a), async (v) => { await api(`/accounts/${id}`, { method: 'PUT', body: toBody(v) }); toast('已保存'); route(); });
          } else if (act === 'delete') {
            if (!confirm(`删除账号 ${a.name}?会先停止它的实例。`)) return;
            await api(`/accounts/${id}`, { method: 'DELETE' }); toast('已删除'); route();
          } else if (act === 'logs') {
            const text = await api(`/accounts/${id}/logs?tail=300`);
            const pre = $('#account-logs'); pre.textContent = text || '(暂无日志)'; pre.classList.remove('hidden'); pre.scrollTop = pre.scrollHeight;
          } else {
            btn.disabled = true;
            await api(`/accounts/${id}/${act}`, { method: 'POST' });
            toast({ start: '已发出启动', restart: '已发出重启', stop: '已停止' }[act]); setTimeout(route, 800);
          }
        } catch (err) { toast(err.message); btn.disabled = false; }
      };
    },

    async keys() {
      const keys = await api('/keys');
      $('#keys-table tbody').innerHTML = keys.map((k) => `<tr data-id="${k.id}">
        <td>${esc(k.name)}</td><td class="mono">${esc(k.key_prefix)}…</td><td class="num">${k.max_concurrency ?? '∞'}</td>
        <td class="num">${k.rpm_limit ?? '∞'}</td><td>${onoff(k.enabled)}</td><td class="muted">${fmtTime(k.last_used_at)}</td>
        <td class="actions"><button class="btn small" data-act="edit">编辑</button><button class="btn small danger" data-act="delete">删除</button></td></tr>`).join('')
        || empty(7, '还没有 key。创建一个给下游调用方。');
      const fields = (k = {}) => [
        { name: 'name', label: '名称', value: k.name, required: true },
        { name: 'max_concurrency', label: '最大并发,留空不限', type: 'number', value: k.max_concurrency ?? '' },
        { name: 'rpm_limit', label: '每分钟请求上限,留空不限', type: 'number', value: k.rpm_limit ?? '' },
        { name: 'enabled', label: '启用', type: 'checkbox', value: k.enabled ?? true },
      ];
      $('#key-new').onclick = () => openDialog('新建 API key', fields(), async (v) => {
        const k = await api('/keys', { method: 'POST', body: v });
        const box = $('#key-reveal');
        box.innerHTML = `${esc(k.name)} 的密钥只显示这一次,请现在复制保存:<strong>${esc(k.key)}</strong>`;
        box.classList.remove('hidden');
        route();
      }, '创建');
      $('#keys-table').onclick = async (e) => {
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        const id = btn.closest('tr').dataset.id; const k = keys.find((x) => x.id === id);
        try {
          if (btn.dataset.act === 'edit') {
            openDialog('编辑 API key', fields(k), async (v) => { await api(`/keys/${id}`, { method: 'PUT', body: v }); toast('已保存'); route(); });
          } else if (confirm(`删除 key ${k.name}?使用它的调用方会立即失效。`)) {
            await api(`/keys/${id}`, { method: 'DELETE' }); toast('已删除'); route();
          }
        } catch (err) { toast(err.message); }
      };
    },

    async runners() {
      const runners = await api('/runners');
      $('#runners-table tbody').innerHTML = runners.map((r) => `<tr data-id="${r.id}">
        <td class="mono">${esc(r.id)}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.base_url)}</td><td class="mono">${esc(r.public_host)}</td>
        <td>${r.online ? '<span class="pill on">在线</span>' : '<span class="pill bad">离线</span>'}</td>
        <td class="num">${r.instances ?? '—'}</td><td class="muted">${esc(r.runner_version || '')}</td>
        <td class="actions"><button class="btn small" data-act="edit">编辑</button><button class="btn small danger" data-act="delete">删除</button></td></tr>`).join('')
        || empty(8, '还没有 runner。compose 部署时添加 http://runner:7000。');
      const fields = (r = {}) => [
        { name: 'id', label: 'ID(字母、数字、- 和 _)', value: r.id || 'runner', required: true },
        { name: 'name', label: '名称', value: r.name || '', required: true },
        { name: 'base_url', label: '控制地址,manager 访问 runner 的 URL', value: r.base_url || 'http://runner:7000', required: true },
        { name: 'public_host', label: '实例主机,manager 访问 codexs 实例用的主机名', value: r.public_host || 'runner', required: true },
        { name: 'token', label: 'Runner token(PM_RUNNER_TOKEN)', type: 'password', value: '', required: !r.id },
      ];
      $('#runner-new').onclick = () => openDialog('添加 runner', fields(), async (v) => { await api('/runners', { method: 'POST', body: v }); toast('已保存'); route(); });
      $('#runners-table').onclick = async (e) => {
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        const id = btn.closest('tr').dataset.id; const r = runners.find((x) => x.id === id);
        try {
          if (btn.dataset.act === 'edit') {
            openDialog('编辑 runner', fields(r), async (v) => {
              if (!v.token) throw new Error('编辑时需要重新输入 token');
              await api('/runners', { method: 'POST', body: v }); toast('已保存'); route();
            });
          } else if (confirm(`删除 runner ${r.id}?需要先删除它下面的账号。`)) {
            await api(`/runners/${id}`, { method: 'DELETE' }); toast('已删除'); route();
          }
        } catch (err) { toast(err.message); }
      };
    },

    async usage() {
      const hours = $('#usage-hours').value;
      const [s, recent] = await Promise.all([api(`/usage/summary?hours=${hours}`), api('/usage/recent?limit=100')]);
      const row = (b) => `<tr><td>${esc(b.name || '(已删除)')}</td><td class="num">${fmtNum(b.requests)}</td><td class="num">${fmtNum(b.errors)}</td>
        <td class="num">${fmtNum(b.input_tokens)}</td><td class="num">${fmtNum(b.output_tokens)}</td><td class="num">${fmtNum(b.cached_tokens)}</td>
        <td class="num">${Math.round(b.avg_latency_ms)} ms</td></tr>`;
      $('#usage-keys tbody').innerHTML = s.by_key.map(row).join('') || empty(7, '这段时间没有请求。');
      $('#usage-accounts tbody').innerHTML = s.by_account.map(row).join('') || empty(7, '这段时间没有请求。');
      $('#usage-recent tbody').innerHTML = recent.map((u) => `<tr><td class="muted">${fmtTime(u.ts)}</td><td class="mono">${esc(u.path)}</td>
        <td>${u.status >= 400 ? `<span class="pill bad">${u.status}</span>` : `<span class="pill on">${u.status}</span>`}</td><td class="num">${u.latency_ms} ms</td>
        <td class="num">${fmtNum(u.input_tokens)} / ${fmtNum(u.output_tokens)} / ${fmtNum(u.cached_tokens)}</td>
        <td class="muted wrap">${esc(u.error || '')}</td></tr>`).join('') || empty(6, '还没有请求记录。');
      $('#usage-hours').onchange = route;
    },
  };

  function nextPort(accounts) {
    const used = new Set(accounts.map((a) => a.port));
    let p = 8790; while (used.has(p)) p += 1; return p;
  }

  let refreshTimer;
  async function route() {
    const name = (location.hash || '#overview').slice(1);
    const view = views[name] ? name : 'overview';
    $$('.side nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view !== 'accounts') $('#account-logs').classList.add('hidden');
    try { await views[view](); } catch (err) { if (err.message !== 'login required') toast(err.message); }
    clearTimeout(refreshTimer);
    if (view === 'overview') refreshTimer = setTimeout(route, 5000);
  }
  window.addEventListener('hashchange', route);

  (async () => {
    try {
      const me = await api('/me');
      if (me.authenticated) { showApp(); route(); } else showLogin();
    } catch { showLogin(); }
  })();
})();
