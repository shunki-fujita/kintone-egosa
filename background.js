// kintone エゴサ - Background Service Worker

const ALARM_NAME = 'kintone-egosa';
const SCHEDULER_ALARM = 'kintone-egosa-scheduler';
const MAX_SEEN = 10000;
const STORAGE_VERSION = 2;

// searching フラグは chrome.storage.session に保持し、
// Service Worker 再起動後も重複実行を防ぐ (session は browser 終了まで保持)
async function isSearching() {
  return (await chrome.storage.session.get('searching')).searching || false;
}
async function setSearching(v) {
  await chrome.storage.session.set({ searching: v });
}

// ============================================================
// Search via executeScript on an existing kintone tab
// ============================================================

async function searchKeyword(subdomain, keyword, groupTypes) {
  let tabs = await chrome.tabs.query({
    url: `https://${subdomain}.cybozu.com/*`,
  });

  // kintone タブがなければポータルを開く
  if (!tabs.length) {
    const tab = await chrome.tabs.create({
      url: `https://${subdomain}.cybozu.com/k/`,
      active: false,
    });
    await waitForTabComplete(tab.id);

    // ログインページにリダイレクトされた場合 (同ドメインでも /login を検出)
    const info = await chrome.tabs.get(tab.id);
    if (
      !info.url?.includes(`${subdomain}.cybozu.com`) ||
      info.url?.includes('/login')
    ) {
      throw new Error('SESSION_EXPIRED');
    }

    tabs = [tab];
  }

  // executeScript の結果を安全にデストラクチャリング
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    world: 'MAIN',
    func: async (kw) => {
      try {
        const token = window.cybozu?.data?.REQUEST_TOKEN;
        if (!token) return { error: 'NO_TOKEN' };

        const res = await fetch('/k/api/search/search.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword: kw,
            start: 0,
            tzOffset: new Date().getTimezoneOffset() * -1,
            __REQUEST_TOKEN__: token,
          }),
        });

        if (!res.ok) return { error: 'FETCH_FAILED:' + res.status };
        const data = await res.json();
        if (!data.success) return { error: 'API_FAILED' };
        return { docs: data.result?.docs || [] };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [keyword],
  });

  const result = injectionResults?.[0]?.result;

  if (!result || result.error) {
    throw new Error(result?.error || 'SEARCH_FAILED');
  }

  const typeToGroup = {
    THREAD_POST: 'SPACE',
    RECORD: 'RECORD',
    RECORD_COMMENT: 'RECORD_COMMENT',
    PEOPLE: 'PEOPLE',
    MESSAGE: 'MESSAGE',
    FILE: 'FILE',
  };
  const allowed = new Set(groupTypes);

  return result.docs
    .filter((doc) => allowed.has(typeToGroup[doc.type] || doc.type))
    .map((doc) => formatDoc(subdomain, doc));
}

// ============================================================
// Format a search result doc into a notification-friendly object
// ============================================================

function formatDoc(subdomain, doc) {
  const base = `https://${subdomain}.cybozu.com`;

  // URL
  let url = `${base}/k/search`;
  if ((doc.type === 'RECORD' || doc.type === 'RECORD_COMMENT') && doc.app && doc.record) {
    url = `${base}/k/${doc.app.id}/show#record=${doc.record.id}`;
  } else if (doc.type === 'THREAD_POST' && doc.space && doc.thread) {
    url = `${base}/k/#/space/${doc.space.id}/thread/${doc.thread.id}`;
    if (doc.postId) url += `/${doc.postId}`;
    if (doc.postCommentId) url += `/${doc.postCommentId}`;
  } else if (doc.type === 'PEOPLE' && doc.peopleUser) {
    url = `${base}/k/#/people/user/${doc.peopleUser.code || doc.peopleUser.id}`;
  } else if (doc.type === 'MESSAGE') {
    url = `${base}/k/#/message`;
  }

  // Creator name
  const creator = doc.creator?.name || '';

  // Location context
  let location = '';
  if (doc.space?.name && doc.thread?.name) {
    location = `${doc.space.name} > ${doc.thread.name}`;
  } else if (doc.space?.name) {
    location = doc.space.name;
  } else if (doc.app?.name) {
    location = doc.app.name;
  }

  // Content snippet from highlight (strip HTML tags)
  let snippet = '';
  if (doc.highlight) {
    snippet = doc.highlight
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&minus;/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 150);
  }

  // Title (record/thread name)
  const title = doc.record?.title || doc.thread?.name || '';

  // Type label
  const typeLabel = {
    THREAD_POST: 'スペース',
    RECORD: 'レコード',
    RECORD_COMMENT: 'コメント',
    PEOPLE: 'ピープル',
    MESSAGE: 'メッセージ',
    FILE: 'ファイル',
  }[doc.type] || '';

  return { id: doc.id, url, creator, location, snippet, title, typeLabel };
}

// ============================================================
// Main search loop
// ============================================================

async function runSearch() {
  if (await isSearching()) return;
  await setSearching(true);

  try {
    const store = await chrome.storage.local.get([
      'config',
      'seenIds',
      'initialized',
      'storageVersion',
    ]);

    const config = store.config;
    if (!config?.subdomain) return;

    const keywords = parseKeywords(config.keywords);
    if (!keywords.length) return;

    const groupTypes = config.groupTypes || [];
    if (!groupTypes.length) return;

    let seenSet, initialized;
    if (store.storageVersion !== STORAGE_VERSION) {
      seenSet = new Set();
      initialized = false;
    } else {
      seenSet = new Set(store.seenIds || []);
      initialized = store.initialized || false;
    }

    const newHits = [];
    let lastKeywordError = null;

    for (const keyword of keywords) {
      try {
        const results = await searchKeyword(
          config.subdomain,
          keyword,
          groupTypes
        );

        for (const r of results) {
          if (!seenSet.has(r.id)) {
            seenSet.add(r.id);
            if (initialized) {
              newHits.push({ ...r, keyword });
            }
          }
        }
      } catch (e) {
        lastKeywordError = e.message;
        break;
      }

      await sleep(1000);
    }

    // seenIds は途中エラーでも保存する (重複通知を防ぐ)
    let seenArr = [...seenSet];
    if (seenArr.length > MAX_SEEN) {
      seenArr = seenArr.slice(-MAX_SEEN);
    }

    await chrome.storage.local.set({
      seenIds: seenArr,
      initialized: true,
      storageVersion: STORAGE_VERSION,
      lastSearchTime: Date.now(),
      lastHitCount: newHits.length,
      lastError: lastKeywordError || null,
    });

    // --- Notifications ---
    const notifUrls =
      (await chrome.storage.local.get('notifUrls')).notifUrls || {};

    for (const hit of newHits.slice(0, 5)) {
      const nid = `egosa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      notifUrls[nid] = hit.url;

      const notifTitle = hit.creator
        ? `${hit.creator} が "${hit.keyword}" に言及`
        : `"${hit.keyword}" の新規ヒット`;

      const lines = [];
      if (hit.location) lines.push(hit.location);
      if (hit.snippet) lines.push(hit.snippet);
      if (!lines.length && hit.title) lines.push(hit.title);

      chrome.notifications.create(nid, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: notifTitle,
        message: lines.join('\n'),
        contextMessage: hit.typeLabel || '',
      });
    }

    if (newHits.length > 5) {
      const nid = `egosa_overflow_${Date.now()}`;
      const kw = encodeURIComponent(keywords[0]);
      notifUrls[nid] = `https://${config.subdomain}.cybozu.com/k/search?keyword=${kw}`;
      chrome.notifications.create(nid, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: `kintone エゴサ`,
        message: `他 ${newHits.length - 5} 件の新規ヒット`,
      });
    }

    const keys = Object.keys(notifUrls);
    if (keys.length > 100) {
      for (const k of keys.slice(0, keys.length - 100)) delete notifUrls[k];
    }
    await chrome.storage.local.set({ notifUrls });
  } catch (e) {
    console.error('エゴサ検索エラー:', e);
    await chrome.storage.local.set({
      lastError: e.message,
      lastSearchTime: Date.now(),
    });
  } finally {
    await setSearching(false);
  }
}

// ============================================================
// Notification click → open URL
// ============================================================

chrome.notifications.onClicked.addListener(async (nid) => {
  chrome.notifications.clear(nid);
  const { notifUrls } = await chrome.storage.local.get('notifUrls');
  const url = notifUrls?.[nid];
  if (url) {
    chrome.tabs.create({ url });
    delete notifUrls[nid];
    await chrome.storage.local.set({ notifUrls });
  }
});

// ============================================================
// Alarm
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // Auto-stop check
    const { config } = await chrome.storage.local.get('config');
    if (config?.autoStopTime) {
      const [h, m] = config.autoStopTime.split(':').map(Number);
      const now = new Date();
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        await stopMonitoring();
        return;
      }
    }
    await runSearch();
  }

  if (alarm.name === SCHEDULER_ALARM) {
    await checkAutoStart();
  }
});

// ============================================================
// Auto-start scheduler
// ============================================================

async function checkAutoStart() {
  const { config, monitoring } = await chrome.storage.local.get([
    'config',
    'monitoring',
  ]);
  if (!config?.autoStartTime || !config.subdomain) return;
  if (monitoring) return; // already running

  const [h, m] = config.autoStartTime.split(':').map(Number);
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = h * 60 + m;

  // Auto-start if within the start minute (check fires every minute)
  if (nowMinutes === startMinutes) {
    try {
      await startMonitoring(config.interval || 5);
      await runSearch();
    } catch (e) {
      console.error('自動開始エラー:', e);
    }
  }
}

async function ensureScheduler() {
  const existing = await chrome.alarms.get(SCHEDULER_ALARM);
  if (!existing) {
    await chrome.alarms.create(SCHEDULER_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  }
}

async function startMonitoring(intervalMinutes) {
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: intervalMinutes,
  });
  await chrome.storage.local.set({ monitoring: true });
}

async function stopMonitoring() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.local.set({ monitoring: false });
}

// ============================================================
// Messages from popup
// ============================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    startMonitoring(msg.interval || 5)
      .then(async () => {
        // Update scheduler based on config
        const { config } = await chrome.storage.local.get('config');
        if (config?.autoStartTime) {
          await ensureScheduler();
        } else {
          await chrome.alarms.clear(SCHEDULER_ALARM);
        }
        await runSearch();
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP') {
    stopMonitoring().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ============================================================
// Restore alarm on service worker restart
// ============================================================

(async () => {
  const { monitoring, config } = await chrome.storage.local.get([
    'monitoring',
    'config',
  ]);
  if (monitoring && config) {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) {
      await startMonitoring(config.interval || 5);
    }
  }
  // Always run the scheduler for auto-start
  if (config?.autoStartTime) {
    await ensureScheduler();
  }
})();

// ============================================================
// Utilities
// ============================================================

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    // まず現在の状態をチェック (リスナー登録前にロード済みの競合を防ぐ)
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('TAB_TIMEOUT'));
      }, 30000);

      function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function parseKeywords(raw) {
  return (raw || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
