const connectRequests = new Map();
const connectReloadTimes = new Map();

async function readConnectAccount(message, sender) {
  // Keep account loading in the reading window without activating a tab or window.
  const windowId = sender.tab?.windowId;
  const windowOptions = Number.isInteger(windowId) ? { windowId } : {};
  let tabs = await chrome.tabs.query({ url: 'https://connect.linux.do/*', ...windowOptions });
  let error = 'Connect 页面尚未就绪';
  let temporaryTabId = null;
  if (!tabs.length && message.ensurePage) {
    tabs = [await chrome.tabs.create({ url: 'https://connect.linux.do/', active: false, ...windowOptions })];
    temporaryTabId = tabs[0].id;
    connectReloadTimes.set(tabs[0].id, Date.now());
  }
  if (!tabs.length) return { ok: false, error: '尚未打开 Connect 页面' };
  for (const tab of tabs) {
    if (message.refreshPage && Date.now() - (connectReloadTimes.get(tab.id) || 0) >= 30000) {
      connectReloadTimes.set(tab.id, Date.now());
      await chrome.tabs.reload(tab.id);
    }
    const deadline = Date.now() + (message.ensurePage ? 20000 : 1000);
    do {
      try {
        const state = await chrome.tabs.get(tab.id);
        if (state.status === 'complete') {
          const result = await chrome.tabs.sendMessage(tab.id, {
            type: 'AUTOLINUXDO_READ_CONNECT_PAGE', username: message.username
          });
          if (result?.ok) {
            // Only close our temporary tab after success. Keep user-owned tabs,
            // and tabs the user has activated or navigated elsewhere.
            if (tab.id === temporaryTabId) {
              try {
                const current = await chrome.tabs.get(tab.id);
                if (!current.active && current.url?.startsWith('https://connect.linux.do/')) {
                  await chrome.tabs.remove(tab.id);
                  connectReloadTimes.delete(tab.id);
                }
              } catch {
                // Closing a tab must never discard successfully read account data.
              }
            }
            return result;
          }
          error = result?.error || error;
          // 登录或账号问题需要用户处理，不自动重试网络请求。
          if (/账号|账户|登录/.test(error) && !/加载|条件/.test(error)) break;
        }
      } catch {
        error = 'Connect 页面脚本未就绪，请确认已重新加载扩展';
        if (message.ensurePage && !connectReloadTimes.has(tab.id)) {
          connectReloadTimes.set(tab.id, Date.now());
          await chrome.tabs.reload(tab.id);
        }
      }
      if (!message.ensurePage) break;
      await new Promise(resolve => setTimeout(resolve, 400));
    } while (Date.now() < deadline);
  }
  return { ok: false, error: `${error}；Connect 已打开，需要时请完成登录或页面验证` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'AUTOLINUXDO_CONNECT_ACCOUNT') {
    if (!sender.url?.startsWith('https://linux.do/')) {
      sendResponse({ ok: false, error: '仅允许 Linux.do 页面读取账户信息' });
      return false;
    }
    const key = String(message.username || '').toLowerCase();
    if (!connectRequests.has(key)) {
      connectRequests.set(key, readConnectAccount(message, sender)
        .catch(error => ({ ok: false, error: error?.message || String(error) }))
        .finally(() => connectRequests.delete(key)));
    }
    connectRequests.get(key).then(sendResponse);
    return true;
  }
  if (message?.type !== 'AUTOLINUXDO_FETCH') return false;

  const allowed = ['https://linux.do/', 'https://idcflare.com/', 'https://connect.linux.do/'];
  if (!allowed.some(prefix => String(message.url).startsWith(prefix))) {
    sendResponse({ ok: false, error: 'URL 不在扩展许可范围内' });
    return false;
  }

  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(message.timeout) || 15000));
    try {
      const response = await fetch(message.url, {
        method: message.method || 'GET',
        headers: message.headers || {},
        body: message.body || undefined,
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal
      });
      sendResponse({
        ok: true,
        status: response.status,
        statusText: response.statusText,
        responseText: await response.text(),
        finalUrl: response.url
      });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    } finally {
      clearTimeout(timer);
    }
  })();
  return true;
});

// Open linux.do in a new tab when the extension action is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://linux.do/' });
});
