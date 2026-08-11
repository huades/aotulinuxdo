chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
