(() => {
    'use strict';

    function identity(root) {
        const menu = root.querySelector('.user-menu-info')?.textContent || '';
        const greeting = root.querySelector('h1')?.textContent || '';
        const menuMatch = menu.match(/@([^@\s·|]+).*?(?:信任级别|信任等级|trust\s*level|Lv|TL)\s*([0-4])/i);
        const oldMatch = greeting.match(/[（(]([^）)]+)[）)].*?([0-4])\s*级用户/);
        const match = menuMatch || oldMatch;
        return match ? { username: match[1].trim(), level: Number(match[2]) } : null;
    }

    function number(value) {
        const match = String(value ?? '').replace(/[,，\s]/g, '').match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : null;
    }

    function status(element) {
        if (!element) return null;
        if (['unmet', 'status-unmet', 'text-red-500'].some(name => element.classList.contains(name))) return false;
        if (['met', 'status-met', 'text-green-500'].some(name => element.classList.contains(name))) return true;
        return null;
    }

    function metric(element, textSelector, attributes, styles) {
        const label = element?.querySelector(textSelector);
        const fromText = number(label?.textContent);
        if (fromText !== null) return fromText;
        for (const attr of attributes) {
            const value = number(element?.getAttribute(attr));
            if (value !== null) return value;
        }
        for (const style of styles) {
            const value = number(element?.style.getPropertyValue(`--${style}`));
            if (value !== null) return value;
        }
        return null;
    }

    function parse(root, username, verifiedLevel) {
        const account = identity(root);
        if (account && account.username.toLowerCase() !== username.toLowerCase()) throw new Error('Connect 与论坛登录账号不一致');
        const level = account?.level ?? verifiedLevel;
        const candidates = Array.from(root.querySelectorAll('.card, .bg-white.p-6.rounded-lg'));
        const targetLevels = level === 2 ? [3] : level === 3 ? [3, 4] : [4, 3];
        let section, targetLevel;
        for (const target of targetLevels) {
            section = candidates.find(card => {
                const title = card.querySelector('h2, h3, .card-title')?.textContent || '';
                return Number(title.match(/(?:信任级别|信任等级|trust\s*level|Lv|TL)\s*([0-4])/i)?.[1]) === target &&
                    card.querySelector('.tl3-ring, .tl3-bar-item, .tl3-quota-card, .tl3-veto-item, table');
            });
            if (section) { targetLevel = target; break; }
        }
        if (!section) throw new Error('Connect 未找到当前等级的指标卡片');
        const requirements = new Map();
        function add(name, current, required, met) {
            if (!name) return;
            const reverse = /举报|禁言|封禁/.test(name);
            const known = current !== null && required !== null;
            requirements.set(name, { name, current: current === null ? null : String(current),
                required: required === null ? null : String(required),
                isMet: known ? (met ?? (reverse ? current <= required : current >= required)) : null });
        }
        section.querySelectorAll('.tl3-ring').forEach(item => {
            const circle = item.querySelector('.tl3-ring-circle');
            const current = number(item.querySelector('.tl3-ring-current')?.textContent) ??
                metric(circle, '.tl3-ring-current', ['aria-valuenow', 'data-current', 'data-value'], ['val', 'value', 'current']);
            const required = number(item.querySelector('.tl3-ring-target')?.textContent) ??
                metric(circle, '.tl3-ring-target', ['aria-valuemax', 'data-target', 'data-max'], ['max', 'target', 'required']);
            add(item.querySelector('.tl3-ring-label')?.textContent.trim(), current, required, status(circle));
        });
        for (const [selector, label, nums, fill] of [
            ['.tl3-bar-item', '.tl3-bar-label', '.tl3-bar-nums', '.tl3-bar-fill'],
            ['.tl3-quota-card', '.tl3-quota-label', '.tl3-quota-nums', '.tl3-quota-card']
        ]) section.querySelectorAll(selector).forEach(item => {
            const values = item.querySelector(nums);
            const parts = (values?.textContent || '').split('/');
            const carrier = item.matches(fill) ? item : item.querySelector(fill);
            const current = number(parts[0]) ?? metric(carrier, nums, ['aria-valuenow', 'data-current', 'data-value'], ['val', 'current']);
            const required = number(parts[1]) ?? metric(carrier, nums, ['aria-valuemax', 'data-target', 'data-max'], ['max', 'target']);
            add(item.querySelector(label)?.textContent.trim(), current, required, status(values) ?? status(carrier));
        });
        section.querySelectorAll('.tl3-veto-item').forEach(item => {
            const values = item.querySelectorAll('.tl3-veto-value');
            add(item.querySelector('.tl3-veto-label')?.textContent.trim(), number(values[values.length - 1]?.textContent), 0, status(item));
        });
        if (!requirements.size) section.querySelectorAll('table').forEach(table => {
            const headers = Array.from(table.querySelectorAll('thead th')).map(cell => cell.textContent);
            const currentIndex = headers.findIndex(text => /当前|现有|实际|current/i.test(text));
            const requiredIndex = headers.findIndex(text => /要求|需要|目标|required|target/i.test(text));
            // 两种旧表格列顺序不同；缺少表头时不猜测，以免把目标值当浏览数。
            if (currentIndex < 0 || requiredIndex < 0) return;
            table.querySelectorAll('tbody tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                add(cells[0]?.textContent.trim(), number(cells[currentIndex]?.textContent),
                    number(cells[requiredIndex]?.textContent), status(cells[currentIndex]));
            });
        });
        if (!requirements.size) throw new Error('Connect 指标为空或表头无法识别');
        const subtitle = section.querySelector('.card-subtitle')?.textContent || '';
        const periodDays = /(?:过去|近|最近)\s*100\s*(?:天|日)/.test(subtitle) ? 100 : null;
        return { level, targetLevel, periodDays, requirements: Array.from(requirements.values()) };
    }

    window.AutoLinuxDoAccount = { identity, number, parse };
})();
