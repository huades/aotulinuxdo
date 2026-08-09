(() => {
  'use strict';

  window.GM_getValue = (key, fallback = null) => {
    try {
      const raw = localStorage.getItem(`autolinuxdo_gm_${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };

  window.GM_setValue = (key, value) => {
    localStorage.setItem(`autolinuxdo_gm_${key}`, JSON.stringify(value));
  };

  window.GM_addStyle = css => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return style;
  };

  window.GM_xmlhttpRequest = details => {
    let aborted = false;
    const timeout = Math.max(1000, Number(details.timeout) || 15000);
    chrome.runtime.sendMessage({
      type: 'AUTOLINUXDO_FETCH',
      url: details.url,
      method: details.method || 'GET',
      headers: details.headers || {},
      body: details.data,
      timeout
    }).then(result => {
      if (aborted) return;
      if (!result?.ok) {
        details.onerror?.(new Error(result?.error || '扩展后台请求失败'));
        return;
      }
      details.onload?.({
        status: result.status,
        statusText: result.statusText,
        responseText: result.responseText,
        response: result.responseText,
        finalUrl: result.finalUrl
      });
    }).catch(error => {
      if (!aborted) details.onerror?.(error);
    });
    return { abort() { aborted = true; } };
  };

  window.HumanInput = {
    async click(element) {
      if (!element || element.disabled) return false;
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      await new Promise(resolve => setTimeout(resolve, 120 + Math.random() * 180));
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + Math.max(1, rect.width * (0.35 + Math.random() * 0.3));
      const clientY = rect.top + Math.max(1, rect.height * (0.35 + Math.random() * 0.3));
      const common = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1 };
      element.dispatchEvent(new PointerEvent('pointerover', common));
      element.dispatchEvent(new MouseEvent('mouseover', common));
      element.dispatchEvent(new PointerEvent('pointerdown', common));
      element.dispatchEvent(new MouseEvent('mousedown', common));
      await new Promise(resolve => setTimeout(resolve, 45 + Math.random() * 90));
      element.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
      element.click();
      return true;
    }
  };
})();
