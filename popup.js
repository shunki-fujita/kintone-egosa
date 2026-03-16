const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  const store = await chrome.storage.local.get([
    'config',
    'monitoring',
    'lastSearchTime',
    'lastHitCount',
    'lastError',
  ]);

  // Restore config
  const c = store.config || {};
  $('subdomain').value = c.subdomain || '';
  $('keywords').value = c.keywords || '';
  $('interval').value = c.interval || 5;
  // Default: auto-start enabled at 10:00
  $('autoStartEnabled').checked = c.autoStartTime !== undefined ? c.autoStartTime !== null : true;
  $('autoStartTime').value = c.autoStartTime || '10:00';
  // Default: auto-stop enabled at 19:00
  $('autoStopEnabled').checked = c.autoStopTime !== undefined ? c.autoStopTime !== null : true;
  $('autoStopTime').value = c.autoStopTime || '19:00';

  // Restore groupTypes
  if (c.groupTypes) {
    const set = new Set(c.groupTypes);
    document.querySelectorAll('.group-types input').forEach((cb) => {
      cb.checked = set.has(cb.value);
    });
  }

  updateStatus(store);

  $('save').addEventListener('click', onSave);
  $('stop').addEventListener('click', onStop);
});

async function onSave() {
  const config = getConfig();

  if (!config.subdomain) return showMsg('サブドメインを入力してください', true);
  if (!config.keywords.trim()) return showMsg('キーワードを入力してください', true);
  if (!config.groupTypes.length) return showMsg('検索対象を1つ以上選択してください', true);
  if (config.autoStartTime && config.autoStopTime && config.autoStartTime >= config.autoStopTime) {
    return showMsg('自動開始は自動停止より前の時刻にしてください', true);
  }

  const prev = (await chrome.storage.local.get('config')).config || {};
  const needsReset =
    prev.subdomain !== config.subdomain ||
    prev.keywords !== config.keywords ||
    JSON.stringify(prev.groupTypes) !== JSON.stringify(config.groupTypes);

  const update = { config };
  if (needsReset) {
    update.seenIds = [];
    update.initialized = false;
  }
  await chrome.storage.local.set(update);

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'START',
      interval: config.interval,
    });

    if (res.ok) {
      showMsg('監視を開始しました');
      updateStatus({ monitoring: true, config, lastError: null });
    } else {
      showMsg('開始失敗: ' + (res.error || ''), true);
    }
  } catch (e) {
    showMsg('開始失敗: ' + e.message, true);
  }
}

async function onStop() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'STOP' });
    if (res.ok) {
      showMsg('監視を停止しました');
      updateStatus({ monitoring: false });
    }
  } catch (e) {
    showMsg('停止失敗: ' + e.message, true);
  }
}

function getConfig() {
  const groupTypes = [...document.querySelectorAll('.group-types input')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  return {
    subdomain: $('subdomain').value.trim(),
    keywords: $('keywords').value,
    interval: Number($('interval').value),
    groupTypes,
    autoStartTime: $('autoStartEnabled').checked ? $('autoStartTime').value : null,
    autoStopTime: $('autoStopEnabled').checked ? $('autoStopTime').value : null,
  };
}

function updateStatus(store) {
  const el = $('status');
  const on = store.monitoring;
  const t = store.lastSearchTime;
  const err = store.lastError;

  let html = on
    ? '<span class="on">監視中</span>'
    : '<span class="off">停止中</span>';

  if (t) {
    html += ` | 最終: ${new Date(t).toLocaleTimeString('ja-JP')}`;
  }
  if (on && store.config) {
    html += ` | ${store.config.interval}分間隔`;
  }
  if (store.config?.autoStartTime) {
    html += ` | ${store.config.autoStartTime}開始`;
  }
  if (store.config?.autoStopTime) {
    html += ` | ${store.config.autoStopTime}停止`;
  }
  if (store.lastHitCount != null) {
    html += ` | 前回 ${store.lastHitCount} 件`;
  }
  if (err) {
    html += `<br><span class="err">${escapeHtml(err)}</span>`;
  }

  el.innerHTML = html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showMsg(text, isError = false) {
  const el = $('message');
  el.textContent = text;
  el.className = isError ? 'message error' : 'message';
}
