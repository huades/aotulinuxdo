(() => {
  'use strict';

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'AUTOLINUXDO_READ_CONNECT_PAGE') return false;
    const username = String(message.username || '').trim();
    const account = AutoLinuxDoAccount.identity(document);
    const matchesAccount = username && account?.username.toLowerCase() === username.toLowerCase();
    if (!matchesAccount) {
      sendResponse({ ok: false, error: 'Connect 页面未确认当前账号，请确认已登录同一个账户' });
      return false;
    }
    if (!document.querySelector('.tl3-ring, .tl3-bar-item, .tl3-quota-card, table')) {
      sendResponse({ ok: false, error: 'Connect 页面尚未显示账户条件，请等待页面加载完成' });
      return false;
    }
    // 仅通过扩展内部消息传递页面快照，不写入缓存、不发送至外部服务。
    const snapshot = document.body.cloneNode(true);
    snapshot.querySelectorAll('script, style, input, textarea, iframe').forEach(node => node.remove());
    sendResponse({ ok: true, status: 200, statusText: 'OK', account,
      responseText: snapshot.innerHTML, finalUrl: location.href });
    return false;
  });
})();
