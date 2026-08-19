(() => {
  const localDot = document.getElementById('local-dot');
  const localText = document.getElementById('local-text');
  const consultant = document.getElementById('consultant');
  const localUrl = document.getElementById('local-url');
  const statusBox = document.getElementById('status-box');
  const refreshBtn = document.getElementById('refresh');

  async function saveConfig() {
    await chrome.storage.local.set({
      consultantId: consultant.value,
      localUrl: localUrl.value.trim() || 'http://127.0.0.1:3100',
    });
  }

  async function loadConfig() {
    const store = await chrome.storage.local.get(['localUrl', 'consultantId']);
    localUrl.value = store.localUrl || 'http://127.0.0.1:3100';
    if (store.consultantId) consultant.value = store.consultantId;
  }

  function renderStatus(payload) {
    if (!payload.ok) {
      localDot.className = 'dot off';
      localText.textContent = `本地服务不可用：${payload.message}`;
      statusBox.className = 'status-box err';
      statusBox.innerHTML = `<b>状态</b>：连不上本地 BrainX —— 请先启动 <code>node src/server.js</code>（127.0.0.1:3100）`;
      return;
    }
    localDot.className = 'dot on';
    localText.textContent = `本地服务已连接（${payload.consultants?.length || 0} 位顾问）`;
    if (payload.consultants?.length) {
      consultant.innerHTML = payload.consultants
        .map((c) => `<option value="${c.consultant_id}">${c.consultant_id}${c.display_name ? ' · ' + c.display_name : ''}</option>`)
        .join('');
    }
  }

  async function refresh() {
    await saveConfig();
    refreshBtn.disabled = true;
    refreshBtn.textContent = '刷新中…';
    const ping = await chrome.runtime.sendMessage({ type: 'PING_LOCAL' });
    renderStatus(ping);
    if (ping.ok) {
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (status.ok) {
        const s = status.status;
        if (!s.connected) {
          statusBox.className = 'status-box err';
          statusBox.innerHTML = `<b>TTC 未连接</b>：打开 <code>app.ttcadvisory.com</code> 扫码登录后自动同步。<br>临期提示：${s.needs_reauth ? '需要重新登录' : '无'}`;
        } else {
          statusBox.className = 'status-box ok';
          statusBox.innerHTML = `<b>TTC 已连接</b>：${s.ttc_user_name || '顾问'} · 有效至 ${s.expires_at ? new Date(s.expires_at).toLocaleString('zh-CN') : '—'}${s.expiring_soon ? '<br>⚠️ 临期，建议重登 TTC' : ''}`;
        }
      } else {
        statusBox.className = 'status-box err';
        statusBox.innerHTML = `<b>状态查询失败</b>：${status.message}`;
      }
    } else {
      statusBox.className = 'status-box err';
      statusBox.innerHTML = `<b>本地服务不可用</b>：${ping.message}`;
    }
    refreshBtn.disabled = false;
    refreshBtn.textContent = '刷新状态';
  }

  consultant.addEventListener('change', saveConfig);
  localUrl.addEventListener('change', saveConfig);
  refreshBtn.addEventListener('click', refresh);
  loadConfig().then(refresh);
})();
