// linux.do 小助手（本地 Chrome 扩展）v2.5.0
// 浏览帖子数严格取账户页面近 100 日统计，仅在开始、结束或点击数字时同步。

// 获取当前站点域名
const CURRENT_DOMAIN = window.location.hostname;
const BASE_URL = `https://${CURRENT_DOMAIN}`;
const READ_SPEED_VALUES = Object.freeze([
    ...Array.from({ length: 10 }, (_, index) => Number(((index + 1) / 10).toFixed(1))),
    ...Array.from({ length: 38 }, (_, index) => Number((1.5 + index * 0.5).toFixed(1)))
]);
// 配置项
const CONFIG = {
    scroll: {
        normalPixelsPerSecond: 600,
        fullTopicPixelsPerSecond: 240,
        frameDelay: 16,
        maxFrameStep: 80,
        minFrameDelay: 4,
        backtrackMinDistance: 50,
        backtrackMaxDistance: 200,
        backtrackSettleDelay: 350,
        bottomSettleChecks: 2,
        bottomSettleDelay: 350,
        tailLoadMaxRounds: 12
    },
    time: {
        topicLoadingTimeout: 25000
    },
    article: {
        commentLimit: 5000,
        topicListLimit: 100,
        retryLimit: 3,
        // 风控严格模式：默认禁用主动“试点赞”探测，避免触发额外风控
        activeCooldownProbeEnabled: false
    },
    levelRequirements: {
        0: { // 0级升1级
            topics_entered: 5,
            posts_read_count: 30,
            time_read: 600 // 10分钟 = 600秒
        },
        1: { // 1级升2级
            days_visited: 15,
            likes_given: 1,
            likes_received: 1,
            post_count: 3,
            topics_entered: 20,
            posts_read_count: 100,
            time_read: 3600 // 60分钟 = 3600秒
        }
    },
    // 允许自动点赞的板块配置
    // 自动点赞默认允许普通板块，仅排除特殊用途板块
    likeAllowedCategories: {
        // 排除的板块及子版块
        excluded: [
            '网盘资源',   // 排除 资源荟萃 > 网盘资源
            '跳蚤市场',   // 特殊用途版块
            '深海幽域',   // 特殊用途版块
            '积分乐园',   // 特殊用途版块
            '扬帆起航'    // 特殊用途版块
        ]
    }
};

// 工具函数
const Utils = {
    random: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    isPageLoaded: () => {
        const loadingElements = document.querySelectorAll('.loading, .infinite-scroll');
        return loadingElements.length === 0;
    },
    isNearBottom: () => {
        const {scrollHeight, clientHeight, scrollTop} = document.documentElement;
        return (scrollTop + clientHeight) >= (scrollHeight - 200);
    },
    isAtBottom: (tolerance = 5) => {
        const {scrollHeight, clientHeight, scrollTop} = document.documentElement;
        return (scrollTop + clientHeight) >= (scrollHeight - tolerance);
    },
    debounce: (func, wait) => {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    },
    fetchWithTimeout: async (url, options = {}, timeoutMs = 15000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const externalSignal = options.signal;
        const abortFromExternal = () => controller.abort();

        if (externalSignal) {
            if (externalSignal.aborted) controller.abort();
            else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
        }

        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener?.('abort', abortFromExternal);
        }
    }
};

const LIKE_COOLDOWN_MS = 5 * 60 * 1000;

const isLikeMutationRequest = (url, method = 'GET') => {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') return false;

    const value = String(url || '');
    return /\/(?:discourse-reactions\/posts\/|custom-reactions\/).+\/toggle\.json(?:[?#]|$)/.test(value);
};

// 存储管理
const Storage = {
    get: (key, defaultValue = null) => {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : defaultValue;
        } catch {
            return defaultValue;
        }
    },
    set: (key, value) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error('Storage error:', error);
            return false;
        }
    },
    remove: (key) => {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.error('Storage error:', error);
            return false;
        }
    }
};

// 统一请求管理（节流 + 单飞 + 退避）
const RequestManager = {
    _lastRequestAt: new Map(),
    _inFlight: new Map(),

    async run(key, requestFn, options = {}) {
        const {
            minInterval = 1200,
            retries = 1,
            backoffBase = 1200,
            jitter = 250,
            cooldownKey = null,
            cooldownMs = 30 * 60 * 1000
        } = options;

        // 单飞：同 key 并发请求共享一个 promise
        if (this._inFlight.has(key)) {
            return this._inFlight.get(key);
        }

        const runner = (async () => {
            // 冷却检查
            if (cooldownKey) {
                const cooldownUntil = Storage.get(cooldownKey, 0);
                if (cooldownUntil > Date.now()) {
                    return null;
                }
            }

            // 最小间隔 + 抖动
            const lastAt = this._lastRequestAt.get(key) || 0;
            const elapsed = Date.now() - lastAt;
            const waitMs = minInterval - elapsed + Utils.random(0, jitter);
            if (waitMs > 0) {
                await Utils.sleep(waitMs);
            }

            let attempt = 0;
            while (attempt <= retries) {
                try {
                    this._lastRequestAt.set(key, Date.now());
                    const result = await requestFn();
                    return result;
                } catch (error) {
                    const msg = String(error?.message || '');
                    const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
                    if (is429 && cooldownKey) {
                        Storage.set(cooldownKey, Date.now() + cooldownMs);
                    }

                    if (attempt >= retries) {
                        throw error;
                    }

                    const backoff = backoffBase * Math.pow(2, attempt) + Utils.random(100, 600);
                    await Utils.sleep(backoff);
                    attempt++;
                }
            }

            return null;
        })();

        this._inFlight.set(key, runner);
        try {
            return await runner;
        } finally {
            this._inFlight.delete(key);
        }
    }
};

// ========== 点赞计数器类（参考 1.js 优化）==========
class LikeCounter {
    constructor() {
        this.CONFIG = {
            // 使用域名区分存储键，避免 linux.do 和 idcflare.com 数据互相干扰
            STORAGE_KEY: `linuxdo_likes_counter_${CURRENT_DOMAIN}`,
            SYNC_INTERVAL: 30 * 60 * 1000, // 30分钟同步一次
            MAX_STORED_ITEMS: 500,
            // 不同信任等级的每日点赞限额
            LIMITS: { 0: 50, 1: 50, 2: 75, 3: 100, 4: 150 }
        };

        this.state = this.createDefaultState();

        this.currentUser = null;
        this.uiUpdateCallbacks = [];
        this.syncTimer = null;

        this.loadState();
        this.installInterceptors();
        this.startPeriodicSync();
    }

    // ========== 持久化 ==========
    createDefaultState(userTrustLevel = null) {
        return {
            timestamps: [],
            cooldownUntil: 0,
            lastSync: 0,
            matched: true,
            userTrustLevel
        };
    }

    loadState() {
        try {
            const stored = GM_getValue(this.CONFIG.STORAGE_KEY, '{}');
            const parsed = JSON.parse(stored);
            this.state = { ...this.state, ...parsed };
            if (this.state.cooldownUntil > Date.now() + LIKE_COOLDOWN_MS) {
                this.state.cooldownUntil = Date.now() + LIKE_COOLDOWN_MS;
            }
            if (this.state.timestamps.length > this.CONFIG.MAX_STORED_ITEMS) {
                this.state.timestamps = this.state.timestamps.slice(0, this.CONFIG.MAX_STORED_ITEMS);
            }
        } catch (e) {
            console.error('[LikeCounter] 加载状态失败:', e);
            this.state = { ...this.createDefaultState(), matched: false };
        }
        this.cleanOldEntries();
    }

    saveState() {
        try {
            GM_setValue(this.CONFIG.STORAGE_KEY, JSON.stringify(this.state));
        } catch (e) {
            console.error('[LikeCounter] 保存状态失败:', e);
        }
    }

    // 清理24小时前的过期记录
    cleanOldEntries() {
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000;

        // 过滤掉过期的时间戳
        this.state.timestamps = this.state.timestamps.filter(ts => ts > cutoff);
        this.state.timestamps.sort((a, b) => b - a); // 降序排列

        // 检查冷却是否已过期
        if (this.state.cooldownUntil > 0 && this.state.cooldownUntil < now) {
            // 冷却结束后，清理可能的占位符时间戳
            const expectedBase = this.state.cooldownUntil - (24 * 60 * 60 * 1000);
            const beforeCount = this.state.timestamps.length;
            this.state.timestamps = this.state.timestamps.filter(ts =>
                ts < expectedBase || ts >= expectedBase + 5000
            );
            if (this.state.timestamps.length < beforeCount) {
                this.checkAndUpdateMismatch();
            }
            this.state.cooldownUntil = 0;
        }
    }

    checkAndUpdateMismatch() {
        const limit = this.getDailyLimit();
        const count = this.state.timestamps.length;
        // 匹配条件：
        // 1. 达到或超过限额
        // 2. 从未同步过（认为是新用户，默认匹配）
        // 3. 已同步过且计数为0（说明确实没有点赞记录）
        this.state.matched = (count >= limit) ||
                             (this.state.lastSync === 0) ||
                             (this.state.lastSync > 0 && count === 0);
    }

    // ========== 核心逻辑 ==========

    // 获取当前用户的每日点赞限额
    getDailyLimit() {
        // 优先使用 currentUser 的 trust_level
        if (this.currentUser && this.CONFIG.LIMITS[this.currentUser.trust_level] !== undefined) {
            return this.CONFIG.LIMITS[this.currentUser.trust_level];
        }
        // 其次使用缓存的 trust_level
        if (this.state.userTrustLevel !== null && this.CONFIG.LIMITS[this.state.userTrustLevel] !== undefined) {
            return this.CONFIG.LIMITS[this.state.userTrustLevel];
        }
        // 尝试从账号等级缓存中读取
        try {
            const username = this.currentUser?.username;
            if (username) {
                const cacheKey = `trustLevelCache_${CURRENT_DOMAIN}_${username}`;
                const cachedData = Storage.get(cacheKey, null);
                if (cachedData?.currentLevel !== undefined) {
                    const level = parseInt(cachedData.currentLevel);
                    if (this.CONFIG.LIMITS[level] !== undefined) {
                        return this.CONFIG.LIMITS[level];
                    }
                }
            }
        } catch (e) { }
        return 50; // 默认值
    }

    // 获取剩余可点赞数
    getRemainingLikes() {
        this.cleanOldEntries();
        const limit = this.getDailyLimit();
        const used = this.state.timestamps.length;
        return Math.max(0, limit - used);
    }

    // 获取已使用的点赞数
    getUsedLikes() {
        this.cleanOldEntries();
        return this.state.timestamps.length;
    }

    // 是否处于冷却期
    isInCooldown() {
        return this.state.cooldownUntil > Date.now();
    }

    // 获取冷却剩余时间（毫秒）
    getCooldownRemaining() {
        if (!this.isInCooldown()) return 0;
        return Math.max(0, this.state.cooldownUntil - Date.now());
    }

    // 格式化冷却时间显示
    formatCooldown() {
        const diff = this.getCooldownRemaining();
        if (diff <= 0) return null;

        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);

        if (h > 0) {
            return `${h}小时${String(m).padStart(2, '0')}分${String(s).padStart(2, '0')}秒`;
        }
        return `${String(m).padStart(2, '0')}分${String(s).padStart(2, '0')}秒`;
    }

    // 处理点赞 API 响应
    processToggleResponse(url, data) {
        this.loadState();
        const now = Date.now();

        // 处理 429 限流错误
        if (data?.error_type === 'rate_limit') {
            const serverWaitSeconds = Number(data.extras?.wait_seconds || 0);
            const waitSeconds = Math.floor(LIKE_COOLDOWN_MS / 1000);
            if (serverWaitSeconds > 0) {
                this.state.cooldownUntil = now + LIKE_COOLDOWN_MS;
                console.log(`[LikeCounter] 触发限流，本地冷却固定为 ${waitSeconds} 秒`);
                window.dispatchEvent(new CustomEvent('lda:like-rate-limit', {
                    detail: {
                        waitSeconds,
                        timeLeft: '5分钟'
                    }
                }));
            }

            const limit = this.getDailyLimit();
            const currentCount = this.state.timestamps.length;
            this.state.matched = (currentCount >= limit);

            // 如果本地计数不足，补充占位符时间戳
            if (currentCount < limit && serverWaitSeconds > 0) {
                const needed = limit - currentCount;
                const placeholderBaseTime = (now + LIKE_COOLDOWN_MS) - (24 * 60 * 60 * 1000);
                const safeNeeded = Math.min(needed, 200);
                for (let i = 0; i < safeNeeded; i++) {
                    this.state.timestamps.push(placeholderBaseTime + i);
                }
                this.state.timestamps.sort((a, b) => b - a);
            }
        }
        // 处理成功的点赞/取消点赞
        else if (data.id || data.resource_post_id) {
            const isLike = !!data.current_user_reaction;
            if (isLike) {
                // 点赞：添加时间戳
                this.state.timestamps.push(now);
                console.log(`[LikeCounter] 记录点赞，当前已用 ${this.state.timestamps.length}/${this.getDailyLimit()}`);
            } else {
                // 取消点赞：移除最新的时间戳
                if (this.state.timestamps.length > 0) {
                    this.state.timestamps.shift();
                    console.log(`[LikeCounter] 取消点赞，当前已用 ${this.state.timestamps.length}/${this.getDailyLimit()}`);
                }
                // 取消点赞后，如果之前在冷却，可能可以解除
                if (this.state.cooldownUntil > now) {
                    this.state.cooldownUntil = 0;
                }
            }
        }

        this.saveState();
        this.notifyUIUpdate();
    }

    // ========== 请求拦截器 ==========
    installInterceptors() {
        const self = this;

        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
            const method = args[1]?.method || args[0]?.method || 'GET';
            const response = await originalFetch.apply(this, args);

            // 只处理实际修改点赞状态的请求，避免把查询接口误判为取消点赞
            if (isLikeMutationRequest(url, method)) {
                try {
                    const clonedResponse = response.clone();
                    const data = await clonedResponse.json();
                    self.processToggleResponse(url, data);
                } catch (e) {
                    // 忽略解析错误
                }
            }
            return response;
        };

        // 拦截 XMLHttpRequest
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._likeCounterUrl = url;
            this._likeCounterMethod = method;
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function() {
            const url = this._likeCounterUrl;
            const method = this._likeCounterMethod;
            if (isLikeMutationRequest(url, method)) {
                this.addEventListener('load', function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        self.processToggleResponse(url, data);
                    } catch (e) {
                        // 忽略解析错误
                    }
                });
            }
            return originalSend.apply(this, arguments);
        };

        console.log('[LikeCounter] 拦截器已安装');
    }

    // ========== 远程同步 ==========
    async syncRemote(force = false) {
        // 检查是否距离上次同步不到 30 分钟（防止多窗口重复同步）
        // 先重新从存储加载状态，确保获取到其他窗口可能更新的 lastSync
        if (!force) {
            this.loadState();
            const lastSyncTime = this.state.lastSync || 0;
            const timeSinceLastSync = Date.now() - lastSyncTime;
            const minSyncInterval = 30 * 60 * 1000; // 30 分钟
            if (timeSinceLastSync < minSyncInterval) {
                const remainMinutes = Math.ceil((minSyncInterval - timeSinceLastSync) / 60000);
                console.log(`[LikeCounter] 距离上次同步仅 ${Math.floor(timeSinceLastSync / 60000)} 分钟，跳过本次同步（剩余 ${remainMinutes} 分钟）`);
                // 虽然跳过同步，但仍需更新 UI 显示当前状态
                this.notifyUIUpdate();
                return;
            }
        }

        if (!this.currentUser) {
            // 尝试获取当前用户（优先使用 DOM 方法，减少 API 调用避免 429）
            let username = null;

            // 方法1：从 Discourse 全局对象获取
            try {
                const currentUser = window.Discourse?.User?.current?.() ||
                    window.Discourse?.currentUser ||
                    window.User?.current?.();
                if (currentUser?.username) {
                    this.currentUser = currentUser;
                    username = currentUser.username;
                }
            } catch (e) { }

            // 方法2：从页面 preload 数据获取
            if (!username) {
                try {
                    const preloadData = document.getElementById('data-preloaded');
                    if (preloadData) {
                        const data = JSON.parse(preloadData.dataset.preloaded);
                        if (data?.currentUser) {
                            const cu = JSON.parse(data.currentUser);
                            if (cu?.username) {
                                this.currentUser = cu;
                                username = cu.username;
                            }
                        }
                    }
                } catch (e) { }
            }

            // 方法3：从用户菜单头像 alt 获取
            if (!username) {
                const userMenuBtn = document.querySelector('.header-dropdown-toggle.current-user');
                if (userMenuBtn) {
                    const img = userMenuBtn.querySelector('img[alt]');
                    if (img && img.alt) {
                        username = img.alt.trim().replace(/^@/, '');
                        this.currentUser = { username };
                    }
                }
            }

            // 方法4：从用户头像 title 获取
            if (!username) {
                const userAvatar = document.querySelector('.current-user img[title]');
                if (userAvatar && userAvatar.title) {
                    username = userAvatar.title.trim().replace(/^@/, '');
                    this.currentUser = { username };
                }
            }

            // 方法5：从当前用户链接 href 获取
            if (!username) {
                const currentUserLink = document.querySelector('a.current-user, .header-dropdown-toggle.current-user a');
                if (currentUserLink) {
                    const href = currentUserLink.getAttribute('href');
                    if (href && href.includes('/u/')) {
                        username = href.split('/u/')[1].split('/')[0];
                        if (username) {
                            username = username.trim().replace(/^@/, '');
                            this.currentUser = { username };
                        }
                    }
                }
            }

            // 方法6：从 localStorage 获取
            if (!username) {
                try {
                    const stored = localStorage.getItem('discourse_current_user');
                    if (stored) {
                        const parsed = JSON.parse(stored);
                        if (parsed?.username) {
                            this.currentUser = parsed;
                            username = parsed.username;
                        }
                    }
                } catch (e) { }
            }

            // 方法7（最后手段）：从 API 获取
            if (!username) {
                // 先检查是否在 429 冷却期
                const session429Until = Storage.get('session429Until', 0);
                if (session429Until > Date.now()) {
                    const remainMinutes = Math.ceil((session429Until - Date.now()) / 60000);
                    console.log(`[LikeCounter] session/current 429 冷却期中，剩余 ${remainMinutes} 分钟，跳过同步`);
                    return;
                }

                try {
                    const response = await fetch(`${BASE_URL}/session/current.json`);
                    // 检测 429 错误
                    if (response.status === 429) {
                        console.warn('[LikeCounter] session/current 遇到 429，设置 30 分钟冷却');
                        Storage.set('session429Until', Date.now() + 30 * 60 * 1000);
                        return;
                    }
                    if (response.ok) {
                        const data = await response.json();
                        if (data.current_user) {
                            this.currentUser = data.current_user;
                        }
                    }
                } catch (e) {
                    console.error('[LikeCounter] 获取用户信息失败:', e);
                }
            }

            if (!this.currentUser) return;
        }

        this.setCurrentUser(this.currentUser);
        const savedCooldown = this.state.cooldownUntil;
        this.cleanOldEntries();
        const username = this.currentUser.username;

        console.log(`[LikeCounter] 开始同步用户 ${username} 的点赞数据...`);

        try {
            const limit = this.getDailyLimit();

            // 先尝试获取服务器的冷却时间
            console.log(`[LikeCounter] 尝试获取服务器冷却时间...`);
            const serverCooldownTime = await this.fetchCooldownTime();

            // 关键修复：如果服务器返回了冷却时间（即已触发 429），说明已经达到限额
            // 此时不需要重新获取点赞数据，直接设置为已达限额状态
            if (serverCooldownTime > 0) {
                console.log(`[LikeCounter] 服务器确认已达限额，冷却时间: ${new Date(serverCooldownTime).toLocaleString()}`);

                // 直接设置为已达限额
                // 生成 limit 个占位时间戳（用冷却结束时间 - 24小时作为基准）
                const baseTime = serverCooldownTime - 24 * 60 * 60 * 1000;
                this.state.timestamps = [];
                for (let i = 0; i < limit; i++) {
                    // 分散在窗口内，避免全部相同
                    this.state.timestamps.push(baseTime + i * 60 * 1000);
                }
                this.state.cooldownUntil = serverCooldownTime;
                this.state.lastSync = Date.now();
                this.state.matched = true;

                // 同步到 BrowseController
                Storage.set('likeResumeTime', serverCooldownTime);

                // 缓存用户信任等级
                if (this.currentUser?.trust_level !== undefined) {
                    this.state.userTrustLevel = this.currentUser.trust_level;
                }

                this.saveState();
                this.notifyUIUpdate();
                console.log(`[LikeCounter] 同步完成（服务器确认限额），已用 ${limit}/${limit}`);
                return;
            }

            // serverCooldownTime === -1 表示无法测试（页面无帖子等原因）
            // serverCooldownTime === 0 表示服务器确认无限流
            const couldNotTest = serverCooldownTime === -1;

            // 正常获取点赞数据
            // 使用当前时间 - 24小时 作为窗口起点
            const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
            if (couldNotTest) {
                console.log(`[LikeCounter] 无法测试服务器状态，使用 API 数据。窗口起点: ${new Date(cutoffTime).toLocaleString()}`);
            } else {
                console.log(`[LikeCounter] 服务器确认未达限额，使用默认窗口起点: ${new Date(cutoffTime).toLocaleString()}`);
            }

            // 使用 user_actions API 获取点赞数据（filter=1 表示点赞）
            // 注意：linux.do 的点赞限制是按"帖子数"计算的，不是按"反应次数"
            const reactions = await this.fetchUserActions(username, cutoffTime);

            // 按 post_id 去重（同一个帖子只计一次，即使点了多个表情）
            const postMap = new Map();
            for (const item of reactions) {
                // 每个 post_id 只保留最新的时间戳
                if (!postMap.has(item.post_id) || postMap.get(item.post_id) < item.timestamp) {
                    postMap.set(item.post_id, item.timestamp);
                }
            }
            const dedupedTimestamps = Array.from(postMap.values());

            console.log(`[LikeCounter] 用户信任等级: ${this.currentUser?.trust_level}, 限额: ${limit}`);
            console.log(`[LikeCounter] 从 API 获取到 ${reactions.length} 条反应记录，去重后 ${dedupedTimestamps.length} 个不同帖子`);

            // 检查是否有之前保存的冷却状态
            let effectiveCooldown = 0;
            if (savedCooldown > Date.now()) {
                effectiveCooldown = savedCooldown;
            }
            const bcLikeResumeTime = Storage.get('likeResumeTime', null);
            if (bcLikeResumeTime && bcLikeResumeTime > Date.now() && bcLikeResumeTime > effectiveCooldown) {
                effectiveCooldown = bcLikeResumeTime;
            }

            // 只有当服务器明确确认无限流时（serverCooldownTime === 0），才清除旧的冷却状态
            // 如果无法测试（couldNotTest === true），保留已有的冷却状态
            if (!couldNotTest && effectiveCooldown > 0) {
                console.log(`[LikeCounter] 服务器确认无限流，清除旧的冷却状态`);
                this.state.cooldownUntil = 0;
                Storage.set('likeResumeTime', null);
            } else if (couldNotTest && effectiveCooldown > 0) {
                // 无法测试时，如果 API 数据接近限额，保留冷却状态
                if (dedupedTimestamps.length >= limit - 1) {
                    console.log(`[LikeCounter] 无法测试服务器状态，API 数据接近限额(${dedupedTimestamps.length}/${limit})，保留冷却状态`);
                    this.state.cooldownUntil = effectiveCooldown;
                }
            }

            // 使用 API 返回的真实时间戳
            this.state.timestamps = dedupedTimestamps;
            this.state.lastSync = Date.now();
            this.state.matched = true;

            this.cleanOldEntries();

            // 缓存用户信任等级，以便页面刷新后使用
            if (this.currentUser?.trust_level !== undefined) {
                this.state.userTrustLevel = this.currentUser.trust_level;
            }

            this.saveState();
            this.notifyUIUpdate();
            console.log(`[LikeCounter] 同步完成，已用 ${this.state.timestamps.length}/${limit}`);

        } catch (e) {
            console.error('[LikeCounter] 同步失败:', e);
        }
    }

    // 获取准确的冷却时间（通过尝试点赞触发 429 响应）
    // 返回值约定：
    //   > 0: 服务器返回的冷却结束时间戳（已达限额）
    //   0: 服务器确认没有限流（测试成功）
    //   -1: 无法测试（页面无帖子等原因），应保留已有状态
    async fetchCooldownTime() {
        try {
            // 风控严格模式下，默认禁用主动探测（通过试点赞触发429）
            if (!CONFIG.article.activeCooldownProbeEnabled) {
                return -1;
            }

            // 找一个帖子来尝试点赞，从页面上找一个已存在的帖子 ID
            // 优先从页面上的帖子获取
            const postElement = document.querySelector('[data-post-id]');
            let testPostId = postElement?.dataset?.postId;

            // 如果页面上没有帖子，使用一个固定的测试帖子（首页欢迎帖之类的）
            if (!testPostId) {
                // 尝试从最近的时间戳数据中获取 post_id
                // 或者使用一个已知存在的帖子
                console.log(`[LikeCounter] 页面上没有帖子，跳过冷却时间获取`);
                return -1; // 返回 -1 表示无法测试，应保留已有状态
            }

            console.log(`[LikeCounter] 尝试对帖子 ${testPostId} 点赞以获取冷却时间...`);

            // 获取 CSRF token
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            if (!csrfToken) {
                console.log(`[LikeCounter] 无法获取 CSRF token，跳过冷却时间获取`);
                return -1; // 无法测试
            }

            const response = await fetch(`${BASE_URL}/discourse-reactions/posts/${testPostId}/custom-reactions/heart/toggle.json`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                }
            });

            const data = await response.json();

            // 检查是否返回 429 限流错误
            if (data.errors && data.error_type === 'rate_limit') {
                const waitSeconds = data.extras?.wait_seconds || 0;
                if (waitSeconds > 0) {
                    const cooldownTime = Date.now() + LIKE_COOLDOWN_MS;
                    console.log('[LikeCounter] 服务器返回限流，本地冷却固定为 5 分钟');
                    return cooldownTime;
                }
            } else if (data.id || data.resource_post_id) {
                // 点赞成功了！说明其实没有到达限额，需要再点一次取消
                console.log(`[LikeCounter] 意外：点赞成功，立即取消并返回0`);
                // 取消点赞
                await fetch(`${BASE_URL}/discourse-reactions/posts/${testPostId}/custom-reactions/heart/toggle.json`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    }
                });
                return 0; // 确认无限流
            }

            return -1; // 未知状态，保留已有
        } catch (e) {
            console.error('[LikeCounter] 获取冷却时间失败:', e);
            return -1; // 出错时也返回 -1，保留已有状态
        }
    }

    // 获取用户点赞历史（user_actions API）
    // cutoffTime: 滚动窗口的起点时间戳，早于此时间的点赞不计入限额
    async fetchUserActions(username, cutoffTime) {
        const allItems = [];
        const cutoff = cutoffTime || (Date.now() - 24 * 60 * 60 * 1000);
        let offset = 0;
        let pages = 0;

        console.log(`[LikeCounter] 开始获取 ${username} 的点赞历史，窗口起点: ${new Date(cutoff).toLocaleString()}`);

        while (pages < 5) {
            try {
                const url = `${BASE_URL}/user_actions.json?limit=50&username=${username}&filter=1&offset=${offset}`;
                // console.log(`[LikeCounter] 请求 URL: ${url}`);
                const response = await RequestManager.run(
                    `user-actions-${CURRENT_DOMAIN}-${username}`,
                    async () => {
                        const r = await fetch(url, { credentials: 'include' });
                        if (r.status === 429) throw new Error('429 user_actions');
                        return r;
                    },
                    {
                        minInterval: 1500,
                        retries: 1,
                        backoffBase: 1200,
                        cooldownKey: `userActions429Until_${CURRENT_DOMAIN}_${username}`,
                        cooldownMs: 20 * 60 * 1000
                    }
                );
                if (!response) break;
                // console.log(`[LikeCounter] 响应状态: ${response.status}`);

                const res = await response.json();
                const items = res.user_actions || [];
                // console.log(`[LikeCounter] 第${pages + 1}页获取到 ${items.length} 条记录`);

                if (!items.length) {
                    console.log(`[LikeCounter] 没有更多数据，结束获取`);
                    break;
                }

                let hasOld = false;
                let addedCount = 0;
                for (const item of items) {
                    const t = new Date(item.created_at).getTime();
                    const hoursAgo = ((Date.now() - t) / (1000 * 60 * 60)).toFixed(1);
                    // console.log(`[LikeCounter] 记录: post_id=${item.post_id}, created_at=${item.created_at}, ${hoursAgo}小时前, ${t > cutoff ? '有效' : '过期'}`);
                    if (t > cutoff) {
                        allItems.push({ post_id: item.post_id, timestamp: t });
                        addedCount++;
                    } else {
                        hasOld = true;
                    }
                }
                // console.log(`[LikeCounter] 本页添加 ${addedCount} 条窗口内的记录，累计 ${allItems.length} 条`);

                if (hasOld || items.length < 50) {
                    console.log(`[LikeCounter] ${hasOld ? '遇到窗口外的旧数据' : '数据不足50条'}，结束获取`);
                    break;
                }
                offset += 50;
                pages++;
                // 翻页间增加随机抖动，降低短时间连续请求风险
                await Utils.sleep(Utils.random(350, 900));
            } catch (e) {
                console.error(`[LikeCounter] 获取点赞历史出错:`, e);
                break;
            }
        }

        console.log(`[LikeCounter] 点赞历史获取完成，共 ${allItems.length} 条`);
        return allItems;
    }

    // 启动定期同步
    startPeriodicSync() {
        // 页面加载3秒后首次同步
        setTimeout(() => this.syncRemote(), 3000);

        // 定期同步
        this.syncTimer = setInterval(() => {
            this.syncRemote();
        }, this.CONFIG.SYNC_INTERVAL);
    }

    // 设置当前用户
    setCurrentUser(user) {
        const username = user?.username ? String(user.username) : '';
        if (!username) return;

        const nextStorageKey = `linuxdo_likes_counter_${CURRENT_DOMAIN}_${username}`;
        const storageChanged = this.CONFIG.STORAGE_KEY !== nextStorageKey;
        this.currentUser = user;

        if (storageChanged) {
            this.CONFIG.STORAGE_KEY = nextStorageKey;
            this.state = this.createDefaultState(user.trust_level ?? null);
            this.loadState();
        } else if (user.trust_level !== undefined) {
            this.state.userTrustLevel = user.trust_level;
        }

        this.notifyUIUpdate();
    }

    // ========== UI 更新回调 ==========
    onUIUpdate(callback) {
        this.uiUpdateCallbacks.push(callback);
    }

    notifyUIUpdate() {
        for (const callback of this.uiUpdateCallbacks) {
            try {
                callback(this.getStatus());
            } catch (e) {
                console.error('[LikeCounter] UI更新回调错误:', e);
            }
        }
    }

    // 获取当前状态
    getStatus() {
        this.cleanOldEntries();
        return {
            remaining: this.getRemainingLikes(),
            used: this.getUsedLikes(),
            limit: this.getDailyLimit(),
            isInCooldown: this.isInCooldown(),
            cooldownRemaining: this.getCooldownRemaining(),
            cooldownFormatted: this.formatCooldown(),
            cooldownUntil: this.state.cooldownUntil,
            matched: this.state.matched,
            lastSync: this.state.lastSync
        };
    }

    // 清除冷却（手动）
    clearCooldown() {
        this.state.cooldownUntil = 0;
        // 同时清理可能的占位符时间戳
        const now = Date.now();
        const recentCutoff = now - 60000; // 1分钟内
        this.state.timestamps = this.state.timestamps.filter(ts => ts > recentCutoff || ts < now - 24 * 60 * 60 * 1000 + 60000);
        this.saveState();
        this.notifyUIUpdate();
        console.log('[LikeCounter] 冷却已清除');
    }

    // 手动触发同步（强制同步，忽略 30 分钟间隔限制）
    manualSync() {
        return this.syncRemote(true);
    }
}

// 全局点赞计数器实例（在 BrowseController 初始化前创建）
let globalLikeCounter = null;

// 用户信息助手类
class UserInfoHelper {
    constructor() {
        this.userInfoCache = new Map();
        this.pendingRequests = new Map();
        this.TRUST_LEVEL_LABELS = {
            0: 'Lv0',
            1: 'Lv1',
            2: 'Lv2',
            3: 'Lv3',
            4: 'Lv4'
        };
        this.DAY_IN_MS = 24 * 60 * 60 * 1000;
        this.revealInProgress = false;
        this.isEnabled = true; // 用户信息展示是否启用
        this.observer = null;

        this.init();
    }

    enable() {
        this.isEnabled = true;
        this.init();
    }

    disable() {
        this.isEnabled = false;
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    init() {
        if (!this.isEnabled) return;

        // 如果已有观察器，先断开
        if (this.observer) {
            this.observer.disconnect();
        }

        // 使用防抖，避免频繁触发
        const debouncedEnhance = this.debounce(() => {
            if (!this.isEnabled || document.hidden) return;

            // 空闲时再执行，降低主线程压力
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => this.isEnabled && this.enhanceUserInfo(), { timeout: 1200 });
            } else {
                setTimeout(() => this.isEnabled && this.enhanceUserInfo(), 120);
            }
        }, 600);

        // 监听页面变化，自动为新加载的用户添加信息（仅在相关节点变化时触发）
        this.observer = new MutationObserver((mutations) => {
            if (!this.isEnabled || document.hidden) return;

            const hasRelevantMutation = mutations.some(mutation =>
                Array.from(mutation.addedNodes || []).some(node => {
                    if (node.nodeType !== 1) return false;
                    if (node.closest && node.closest('.linuxdo-helper-panel')) return false;
                    return node.matches?.('.topic-post, article, .post-stream') ||
                        node.querySelector?.('.topic-post article, .names a[data-user-card]');
                })
            );

            if (hasRelevantMutation) {
                debouncedEnhance();
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 初始增强
        this.enhanceUserInfo();
    }

    debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    isTopicPage() {
        return window.location.pathname.includes('/t/topic/');
    }

    async enhanceUserInfo() {
        if (!this.isTopicPage()) return;

        const articles = document.querySelectorAll('.topic-post article');
        for (const article of articles) {
            const anchor = article.querySelector('.names a[data-user-card]');
            if (!anchor) continue;

            const slug = anchor.getAttribute('data-user-card');
            if (!slug) continue;

            const normalizedSlug = slug.trim().toLowerCase();

            // 检查是否已经添加过信息
            if (article.querySelector(`.user-reg-info[data-user="${normalizedSlug}"]`)) {
                continue;
            }

            // 检查是否是第一楼（楼主）
            const postWrapper = article.closest('.topic-post');
            const postNumber = postWrapper?.getAttribute('data-post-number');
            const isFirstPost = postNumber === '1';

            // 第一楼直接显示，其他楼添加按钮
            if (isFirstPost) {
                await this.loadAndDisplayUserInfo(anchor, slug, normalizedSlug);
            } else {
                this.addInfoButton(anchor, slug, normalizedSlug);
            }
        }
    }

    addInfoButton(anchor, rawSlug, normalizedSlug) {
        const namesContainer = anchor.closest('.names');
        if (!namesContainer) return;

        // 检查是否已有按钮或信息
        if (namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`)) {
            return;
        }

        // 如果已经有信息节点，不添加按钮
        if (namesContainer.querySelector(`.user-reg-info[data-user="${normalizedSlug}"]`)) {
            return;
        }

        const button = document.createElement('button');
        button.className = 'user-info-btn';
        button.setAttribute('data-user', normalizedSlug);
        button.setAttribute('data-raw-slug', rawSlug);
        button.textContent = '📊';
        button.title = '点击查看用户注册信息';
        button.style.cssText = `
            margin-left: 6px;
            font-size: 14px;
            cursor: pointer;
            background: none;
            border: none;
            padding: 2px 4px;
            opacity: 0.6;
            transition: opacity 0.2s;
            vertical-align: middle;
        `;

        button.addEventListener('mouseenter', () => {
            button.style.opacity = '1';
        });

        button.addEventListener('mouseleave', () => {
            button.style.opacity = '0.6';
        });

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (button.disabled) return;

            button.disabled = true;
            button.textContent = '⏳';

            try {
                await this.loadAndDisplayUserInfo(anchor, rawSlug, normalizedSlug);
                // 成功后按钮会被 loadAndDisplayUserInfo 中移除
            } catch (error) {
                console.error('加载用户信息失败:', error);
                button.textContent = '📊';
                button.disabled = false;
            }
        });

        anchor.insertAdjacentElement('afterend', button);

        // 添加"查看话题"按钮
        this.addTopicsButton(anchor, rawSlug, normalizedSlug);
    }

    addTopicsButton(anchor, rawSlug, normalizedSlug) {
        const namesContainer = anchor.closest('.names');
        if (!namesContainer) return;

        // 检查是否已有话题按钮
        if (namesContainer.querySelector(`.user-topics-btn[data-user="${normalizedSlug}"]`)) {
            return;
        }

        const topicsBtn = document.createElement('a');
        topicsBtn.className = 'user-topics-btn';
        topicsBtn.setAttribute('data-user', normalizedSlug);
        topicsBtn.href = `${BASE_URL}/u/${rawSlug}/activity/topics`;
        topicsBtn.target = '_blank';
        topicsBtn.textContent = '查看话题';
        topicsBtn.title = '查看该用户的话题';
        topicsBtn.style.cssText = `
            margin-left: 6px;
            font-size: 12px;
            cursor: pointer;
            text-decoration: none;
            padding: 2px 6px;
            opacity: 0.7;
            transition: all 0.2s;
            vertical-align: middle;
            display: inline-block;
            color: #667eea;
            background: rgba(102, 126, 234, 0.1);
            border-radius: 4px;
        `;

        topicsBtn.addEventListener('mouseenter', () => {
            topicsBtn.style.opacity = '1';
            topicsBtn.style.background = 'rgba(102, 126, 234, 0.2)';
        });

        topicsBtn.addEventListener('mouseleave', () => {
            topicsBtn.style.opacity = '0.7';
            topicsBtn.style.background = 'rgba(102, 126, 234, 0.1)';
        });

        // 插入到信息按钮后面
        const infoBtn = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
        if (infoBtn) {
            infoBtn.insertAdjacentElement('afterend', topicsBtn);
        } else {
            anchor.insertAdjacentElement('afterend', topicsBtn);
        }
    }

    async loadAndDisplayUserInfo(anchor, slug, normalizedSlug) {
        const namesContainer = anchor.closest('.names');
        if (!namesContainer) return;

        // 再次检查是否已经存在，避免重复
        const existingInfo = namesContainer.querySelector(`.user-reg-info[data-user="${normalizedSlug}"]`);
        if (existingInfo) {
            console.log(`用户 ${normalizedSlug} 信息已存在，跳过`);
            // 确保按钮被移除
            const button = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
            if (button) button.remove();
            return;
        }

        const info = await this.fetchUserInfo(slug, normalizedSlug);
        if (!info) {
            // 获取失败，恢复按钮
            const button = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
            if (button) {
                button.textContent = '📊';
                button.disabled = false;
            }
            return;
        }

        const infoNode = this.buildInfoNode(info, normalizedSlug);
        if (!infoNode) {
            // 构建失败，恢复按钮
            const button = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
            if (button) {
                button.textContent = '📊';
                button.disabled = false;
            }
            return;
        }

        // 最后一次检查，确保在异步等待期间没有被其他调用添加
        const finalCheck = namesContainer.querySelector(`.user-reg-info[data-user="${normalizedSlug}"]`);
        if (finalCheck) {
            console.log(`用户 ${normalizedSlug} 信息在等待期间已被添加，跳过`);
            // 移除按钮
            const button = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
            if (button) button.remove();
            return;
        }

        // 先移除信息按钮
        const button = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
        if (button) button.remove();

        // 添加信息节点
        anchor.insertAdjacentElement('afterend', infoNode);

        // 确保话题按钮存在（如果还没有添加）
        if (!namesContainer.querySelector(`.user-topics-btn[data-user="${normalizedSlug}"]`)) {
            this.addTopicsButton(anchor, slug, normalizedSlug);
        }
    }

    async fetchUserInfo(slug, normalizedSlug) {
        // 检查缓存
        if (this.userInfoCache.has(normalizedSlug)) {
            return this.userInfoCache.get(normalizedSlug);
        }

        // 检查是否正在请求
        if (this.pendingRequests.has(normalizedSlug)) {
            return this.pendingRequests.get(normalizedSlug);
        }

        // 创建请求
        const requestPromise = this.doFetchUserInfo(slug, normalizedSlug);
        this.pendingRequests.set(normalizedSlug, requestPromise);

        try {
            const info = await requestPromise;
            if (info) {
                this.userInfoCache.set(normalizedSlug, info);
            }
            return info;
        } finally {
            this.pendingRequests.delete(normalizedSlug);
        }
    }

    async doFetchUserInfo(slug, normalizedSlug) {
        try {
            // 使用两个API并行请求,与原脚本保持一致
            const PROFILE_API_BUILDERS = [
                (s) => `${BASE_URL}/u/${encodeURIComponent(s)}.json`,
                (s) => `${BASE_URL}/users/${encodeURIComponent(s)}.json`,
            ];

            const SUMMARY_API_BUILDERS = [
                (s) => `${BASE_URL}/u/${encodeURIComponent(s)}/summary.json`,
                (s) => `${BASE_URL}/users/${encodeURIComponent(s)}/summary.json`,
            ];

            const [profileData, summaryData] = await Promise.all([
                this.fetchFirstAvailable(PROFILE_API_BUILDERS, slug),
                this.fetchFirstAvailable(SUMMARY_API_BUILDERS, slug),
            ]);

            if (!profileData && !summaryData) {
                return null;
            }

            const user = profileData && (profileData.user || profileData);
            const summary = summaryData && (summaryData.user_summary || summaryData.summary || summaryData);

            const createdAt = this.pickCreatedAt(user) || (summary && this.pickCreatedAt(summary));
            if (!createdAt) {
                return null;
            }

            const topicCount = this.pickFirstNumber(
                user && (user.topic_count ?? user.topicCount),
                summary && (summary.topic_count ?? summary.topics_count),
            );

            const totalPostCount = this.pickFirstNumber(
                user && (user.post_count ?? user.postCount),
                summary && (summary.post_count ?? summary.posts_count),
            );

            let repliesCount = this.pickFirstNumber(
                summary && (summary.replies_count ?? summary.reply_count),
            );
            if (repliesCount === null && totalPostCount !== null && topicCount !== null) {
                repliesCount = Math.max(0, totalPostCount - topicCount);
            }

            const trustLevelRaw = this.pickFirstValue(
                user && (user.trust_level ?? user.trustLevel),
                summary && (summary.trust_level ?? summary.trustLevel),
            );
            const trustLevel = this.normalizeTrustLevel(trustLevelRaw);

            const days = this.calcDays(createdAt);

            return {
                slug: normalizedSlug,
                createdAt,
                days,
                topicCount: typeof topicCount === 'number' && Number.isFinite(topicCount) ? topicCount : undefined,
                repliesCount: typeof repliesCount === 'number' && Number.isFinite(repliesCount) ? repliesCount : undefined,
                trustLevel
            };
        } catch (error) {
            console.error('获取用户信息失败:', slug, error);
            return null;
        }
    }

    async fetchFirstAvailable(builders, slug) {
        for (const builder of builders) {
            const url = builder(slug);
            const data = await this.safeFetchJson(url);
            if (data) {
                return data;
            }
        }
        return null;
    }

    async safeFetchJson(url) {
        try {
            const response = await RequestManager.run(
                `safe-fetch-${CURRENT_DOMAIN}-${url}`,
                async () => {
                    const r = await fetch(url, { credentials: 'include' });
                    if (r.status === 429) throw new Error(`429 ${url}`);
                    return r;
                },
                {
                    minInterval: 1200,
                    retries: 1,
                    backoffBase: 1000,
                    cooldownKey: `safeFetch429Until_${CURRENT_DOMAIN}`,
                    cooldownMs: 20 * 60 * 1000
                }
            );

            if (!response || !response.ok) {
                return null;
            }
            return await response.json();
        } catch (error) {
            return null;
        }
    }

    pickFirstNumber(...values) {
        for (const value of values) {
            const numberValue = Number(value);
            if (!Number.isNaN(numberValue)) {
                return numberValue;
            }
        }
        return null;
    }

    pickFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return null;
    }

    normalizeTrustLevel(raw) {
        if (raw === undefined || raw === null) {
            return undefined;
        }

        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return raw;
        }

        if (typeof raw === 'string') {
            const TRUST_LEVEL_ALIAS = {
                newuser: 0,
                basic: 1,
                member: 2,
                regular: 3,
                leader: 4,
            };
            const alias = TRUST_LEVEL_ALIAS[raw.toLowerCase()];
            if (alias !== undefined) {
                return alias;
            }
            const numeric = Number(raw);
            if (!Number.isNaN(numeric)) {
                return numeric;
            }
        }

        return undefined;
    }

    pickCreatedAt(source) {
        if (!source) {
            return null;
        }
        return (
            source.created_at ||
            source.createdAt ||
            source.registration_date ||
            source.registrationDate ||
            source.joined ||
            source.joinedAt ||
            null
        );
    }

    calcDays(createdAt) {
        const createdTime = new Date(createdAt).getTime();
        if (Number.isNaN(createdTime)) {
            return 0;
        }
        const diff = Date.now() - createdTime;
        return Math.max(0, Math.floor(diff / this.DAY_IN_MS));
    }

    buildInfoNode(info, normalizedSlug) {
        const segments = [`注册 ${this.formatNumber(info.days)} 天`];

        if (typeof info.topicCount === 'number' && Number.isFinite(info.topicCount)) {
            segments.push(`发帖 ${this.formatNumber(info.topicCount)}`);
        }

        if (typeof info.repliesCount === 'number' && Number.isFinite(info.repliesCount)) {
            segments.push(`回帖 ${this.formatNumber(info.repliesCount)}`);
        }

        if (typeof info.trustLevel === 'number' && Number.isFinite(info.trustLevel)) {
            const FULL_TRUST_LEVEL_LABELS = {
                0: 'Lv0 新手',
                1: 'Lv1 入门',
                2: 'Lv2 成员',
                3: 'Lv3 常驻',
                4: 'Lv4 领袖',
            };
            const label = FULL_TRUST_LEVEL_LABELS[info.trustLevel] || `信任级别 Lv${info.trustLevel}`;
            segments.push(label);
        }

        if (!segments.length) {
            return null;
        }

        const span = document.createElement('span');
        span.className = 'user-reg-info';
        span.setAttribute('data-user', normalizedSlug);
        span.textContent = ` · ${segments.join(' · ')}`;
        span.style.cssText = `
            margin-left: 6px;
            font-size: 12px;
            color: #1a4c7c;
        `;

        return span;
    }

    formatNumber(value) {
        return Number(value).toLocaleString('zh-CN');
    }

    // 批量展示所有已加载的回复用户信息
    async revealAllVisibleReplies() {
        if (!this.isTopicPage()) return;
        if (this.revealInProgress) return;

        this.revealInProgress = true;

        try {
            const articles = document.querySelectorAll('.topic-post article');

            for (let index = 0; index < articles.length; index++) {
                const article = articles[index];

                // 跳过第一楼（楼主）
                const postWrapper = article.closest('.topic-post');
                const postNumber = postWrapper?.getAttribute('data-post-number');
                if (postNumber === '1') continue;

                const anchor = article.querySelector('.names a[data-user-card]');
                if (!anchor) continue;

                const slug = anchor.getAttribute('data-user-card');
                if (!slug) continue;

                const normalizedSlug = slug.trim().toLowerCase();
                const namesContainer = anchor.closest('.names');
                if (!namesContainer) continue;

                // 检查是否已经展示过
                const hasInfo = namesContainer.querySelector(`.user-reg-info[data-user="${normalizedSlug}"]`);
                if (hasInfo) {
                    // 移除可能残留的按钮
                    const button = namesContainer.querySelector(`.user-info-btn[data-user="${normalizedSlug}"]`);
                    if (button) button.remove();
                    continue;
                }

                // 加载并显示用户信息
                await this.loadAndDisplayUserInfo(anchor, slug, normalizedSlug);
            }
        } catch (error) {
            console.error('批量展示用户信息失败:', error);
        } finally {
            this.revealInProgress = false;
        }
    }
}

class BrowseController {
    constructor() {
        this.isScrolling = false;
        this.scrollInterval = null;
        this.pauseTimeout = null;
        this.scrollFractionRemainder = 0;
        this.backtrackTopicId = null;
        this.topicBacktrackPlan = [];
        this.trustLevelMonitorInterval = null; // 等级监控定时器
        this.navigationTimeout = null; // 导航超时定时器
        this.navigationGuardInterval = null; // 导航守护定时器

        // 国际化文本配置
        this.i18n = {
            zh: {
                panelTitle: '📚 Linux.do 助手',
                minimizedText: '助手',
                expandPanel: '点击展开控制面板',
                switchToCollapse: '切换到折叠布局',
                switchToTab: '切换到标签页布局',
                minimize: '最小化',
                tabAccount: '账号',
                tabRead: '阅读',
                tabSettings: '设置',
                sectionAutoRead: '📖 自动阅读',
                sectionArticleTools: '📖 文章页功能',
                sectionAccountInfo: '📊 账号信息',
                sectionPluginSettings: '🔧 插件设置',
                startReading: '开始阅读',
                stopReading: '停止阅读',
                randomFloor: '随机楼层',
                randomFloorTip: '随机跳转到某个楼层（抽奖用）',
                batchShowInfo: '批量展示信息',
                batchShowInfoTip: '批量展示当前页面所有已加载回复的用户信息',
                clearCooldown: '清除冷却',
                clearCooldownTip: '清除点赞冷却时间，立即恢复点赞功能',
                clearPageHistory: '清空页码',
                clearPageHistoryTip: '清空续读页码记录，下次从第1页开始',
                pageHistoryCleared: '页码记录已清空',
                refresh: '🔄 刷新',
                refreshing: '刷新中...',
                autoLikeTopic: '👍 自动点赞',
                autoLikeStatus: '👍 点赞状态',
                autoLikeReady: '等待下一个帖子',
                autoLikeChecking: '正在检查首帖',
                autoLikeSuccess: '首帖点赞成功',
                autoLikeAlready: '首帖已经点赞',
                autoLikeFiltered: '未通过点赞过滤',
                autoLikeCountUnavailable: '未读取到首帖赞数',
                autoLikeCategoryExcluded: '当前板块已排除',
                autoLikeSelfTopic: '自己的帖子不点赞',
                autoLikeUnavailable: '点赞按钮加载超时',
                autoLikeFailed: '点赞未成功，稍后可重试',
                autoLikeCooling: '点赞冷却中',
                autoLikeDisabled: '自动点赞已关闭',
                accountPostsRead: '近100日浏览',
                accountPostsReadTip: '点击同步账户页面中的近100日浏览帖子数',
                accountPostsReadSyncSuccess: '浏览帖子数同步成功',
                accountPostsReadSyncFailed: '浏览帖子数同步失败',
                readUnread: '📬 读取未读',
                layoutSwitchTip: '💡 点击面板标题栏的 ⫼ 按钮可切换到标签页布局',
                loading: '加载中...',
                loadingLevel: '加载等级信息...',
                clickToLoad: '点击展开加载...',
                loadFailed: '加载失败，请点击刷新重试',
                notLoggedIn: '未登录',
                switchedToCollapse: '已切换到折叠布局',
                switchedToTab: '已切换到标签页布局',
                remaining: '剩余',
                hours: '小时',
                minutes: '分',
                seconds: '秒',
                likeCooldownCleared: '✅ 点赞冷却已清除，可以正常点赞了！',
                noCooldown: '当前没有点赞冷却',
                ipRateLimited: '🚫 IP 被限流，自动阅读已暂停',
                ipRateLimitWait: '将在 30 分钟后自动恢复',
                ipRateLimitResume: '✅ IP 限流已解除，恢复自动阅读',
                ipRateLimitDetected: '检测到 IP 限流',
                loadingComplete: '加载完成',
                loadingFailed: '加载失败',
                noUnreadPosts: '📭 没有未读帖子，将切换到最新帖子',
                likeLimitReached: '点赞已达上限，将在 ',
                likeCoolingDown: '点赞功能冷却中',
                likeRemaining: '剩余点赞',
                likeUsed: '已用',
                likeCooldown: '冷却中',
                likeCountMismatch: '计数可能不准确，点击同步',
                likeSyncing: '同步中...',
                likeSyncSuccess: '同步成功',
                randomOrder: '🔀 随机阅读',
                randomOrderTip: '打乱帖子顺序，随机阅读',
                skipRead: '⏭️ 跳过已读',
                skipReadTip: '自动跳过已经阅读过的帖子',
                fullTopicRead: '📜 完整阅读',
                fullTopicReadTip: '从帖子开头开始，滚动到页面底部后再切换下一篇',
                topicLimit: '📚 获取数量',
                topicLimitTip: '每次获取的帖子数量',
                readSpeedLabel: '🚀 阅读速度（倍）',
                readSpeedTip: '0.1–1 倍每次调整 0.1，1–20 倍每次调整 0.5；1 倍为默认速度',
                skipLargeReplyTopics: '⏭️ 跳过200+帖',
                skipLargeReplyTopicsTip: '自动跳过回复数大于 200 的帖子',
                stopAfterRead: '🛑 阅读限制',
                stopAfterReadTip: '今日阅读达到指定数量后自动停止',
                stopAfterReadCount: '📖 阅读数量',
                stopAfterReadCountTip: '今日累计阅读多少帖子后停止',
                stopOnLikeLimit: '❤️ 点赞停止',
                stopOnLikeLimitTip: '点赞达到上限后自动停止阅读',
                stoppedByReadLimit: '✅ 已达到阅读数量限制，自动停止',
                stoppedByLikeLimit: '❤️ 点赞已达上限，自动停止阅读',
                stoppedByServerBusy: '⚠️ 检测到 502，已停止自动阅读，避免负载过高',
                stoppedByPageLoading: '⚠️ 页面加载超时，已停止自动阅读，请稍后重试',
                // 点赞过滤相关
                likeFilterMode: '🎯 点赞过滤',
                likeFilterModeTip: '根据帖子已有赞数过滤，避免给奇怪的帖子点赞',
                likeFilterOff: '关闭',
                likeFilterThreshold: '阈值模式',
                likeFilterProbability: '概率模式',
                likeMinThreshold: '📊 最低赞数',
                likeMinThresholdTip: '帖子已有赞数大于或等于此值才会点赞',
                likeFilterThresholdDesc: '只对赞数 ≥ 设定值的帖子点赞',
                likeFilterProbabilityDesc: '赞数越多点赞几率越高，0-1赞不点',
                likeSkippedLowLikes: '跳过低赞帖子',
                sessionReadCount: '本次已读',
                fetchingTopics: '📥 获取帖子中...',
                fetchProgress: '获取进度',
                totalFetched: '已获取',
                skippedRead: '跳过已读',
                unreadTopics: '未读帖子',
                latestTopics: '最新帖子',
                topicsReady: '帖子已就绪',
                currentReading: '📖 当前阅读',
                remainingTopics: '剩余帖子',
                todayRead: '今日阅读',
                readingTime: '\u672C\u6B21\u7528\u65F6',
                likeSettings: '\u2764\uFE0F \u70B9\u8D5E\u8BBE\u7F6E',
                // 主题配色相关
                themeColorLabel: '🎨 主题配色',
                themeColorTip: '选择面板的主题配色方案',
                themePurple: '💜 紫罗兰',
                themeBlue: '💙 海洋蓝',
                themeGreen: '💚 森林绿',
                themeOrange: '🧡 暖阳橙',
                themePink: '💗 樱花粉',
                themeDark: '🖤 暗夜黑',
                themeChanged: '主题配色已切换',
                topicCreatedTimeLabel: '🕒 创建时间标签',
                topicCreatedTimeVisible: '👁️ 显示创建时间',
                topicCreatedTimeVisibleTip: '开启显示/关闭隐藏帖子创建时间标签',
                topicCreatedTimeEnabled: '创建时间标签已显示',
                topicCreatedTimeDisabled: '创建时间标签已隐藏',
                topicAgeColorLabel: '🎯 帖龄高亮',
                topicAgeColorTip: '控制创建时间标签是否按帖龄着色',
                topicAgeColorFresh: '新帖(≤30天)',
                topicAgeColorOld: '老帖(>30天)',
                topicAgeColorAncient: '坟帖(>90天)',
                topicAgeColorEnabled: '帖龄高亮已启用',
                topicAgeColorDisabled: '帖龄高亮已禁用',
                topicAgeColorUpdated: '帖龄高亮颜色已更新',
                // 捐赠打赏相关
                donateLabel: '💝 捐赠打赏',
                donateTip: '如果觉得好用，可以请作者喝杯咖啡 ☕',
                donateAmount: '选择金额',
                // CloudFlare 5秒盾相关
                cfBypassLabel: '🛡️ CF 5秒盾',
                cfBypassTip: '当 CloudFlare 5秒盾检测失败时，自动跳转到 challenge 页面',
                cfBypassEnabled: 'CF 5秒盾自动跳转已启用',
                cfBypassDisabled: 'CF 5秒盾自动跳转已禁用',
                cfBypassDetected: '🛡️ 检测到 CF 验证失败，正在跳转...',
                cfBypassManual: '🛡️ 手动触发 CF 验证',
                cfBypassManualTip: '手动跳转到 CloudFlare challenge 页面',
                cfBypassAlreadyOnChallenge: '已在 Challenge 页面，无需跳转'
            }
        };

        this.t = key => this.i18n?.zh?.[key] || key;

        // 使用 sessionStorage 存储窗口独立的状态
        this.isTopicPage = window.location.href.includes("/t/topic/");

        // 检查是否是新开的窗口（通过 window.opener 判断）
        // 如果是新开的窗口，不继承自动阅读状态，确保窗口独立性
        const isNewWindow = window.opener !== null;
        if (isNewWindow) {
            // 新开的窗口，清除可能继承的自动阅读状态
            this.autoRunning = false;
            this.setSessionStorage('autoRunning', false);
            this.topicList = [];
            this.setSessionStorage('topicList', []);
            console.log('[窗口独立] 检测到新开窗口，已清除继承的自动阅读状态');
        } else {
            this.autoRunning = this.getSessionStorage('autoRunning', false);
            this.topicList = this.getSessionStorage('topicList', []);
        }

        // 使用 localStorage 存储全局共享的状态
        this.tabMode = this.getSessionStorage('tabMode', Storage.get('tabMode', false));
        // 如果正在自动阅读且是标签页模式，强制显示阅读标签页（标签3）
        if (this.autoRunning && this.tabMode) {
            this.activeTab = 3;
            console.log('[标签页] 自动阅读运行中，强制切换到阅读标签页');
        } else {
            this.activeTab = Storage.get('activeTab', 1);
            if (![1, 3, 6].includes(this.activeTab)) {
                this.activeTab = 1;
                Storage.set('activeTab', this.activeTab);
            }
        }
        this.firstUseChecked = Storage.get('firstUseChecked', false);
        this.autoLikeEnabled = Storage.get('autoLikeEnabled', false);
        this.themeColor = this.getSessionStorage('themeColor', Storage.get('themeColor', 'purple'));

        // 主题配色配置（必须在 setupButton 之前定义，因为 createThemeSelector 需要使用）
        this.themeConfigs = {
            purple: {
                name: 'themePurple',
                gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                primary: '#667eea',
                secondary: '#764ba2'
            },
            blue: {
                name: 'themeBlue',
                gradient: 'linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)',
                primary: '#2193b0',
                secondary: '#6dd5ed'
            },
            green: {
                name: 'themeGreen',
                gradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
                primary: '#11998e',
                secondary: '#38ef7d'
            },
            orange: {
                name: 'themeOrange',
                gradient: 'linear-gradient(135deg, #f2994a 0%, #f2c94c 100%)',
                primary: '#f2994a',
                secondary: '#f2c94c'
            },
            pink: {
                name: 'themePink',
                gradient: 'linear-gradient(135deg, #ee9ca7 0%, #ffdde1 100%)',
                primary: '#ee9ca7',
                secondary: '#ffdde1'
            },
            dark: {
                name: 'themeDark',
                gradient: 'linear-gradient(135deg, #232526 0%, #414345 100%)',
                primary: '#232526',
                secondary: '#414345'
            }
        };

        this.randomOrderEnabled = Storage.get('randomOrderEnabled', false); // 随机顺序阅读
        this.fullTopicReadEnabled = Storage.get('fullTopicReadEnabled', false); // 完整阅读帖子（默认关闭）
        const savedReadSpeedMultiplier = Number(Storage.get('readSpeedMultiplier', NaN));
        const legacyReadSpeedPercent = Number(Storage.get('readSpeedPercent', 100));
        const initialReadSpeedMultiplier = Number.isFinite(savedReadSpeedMultiplier)
            ? savedReadSpeedMultiplier
            : legacyReadSpeedPercent / 100;
        this.readSpeedMultiplier = Math.min(20, Math.max(0.1, initialReadSpeedMultiplier || 1));

                this.topicCreatedTimeVisible = Storage.get('topicCreatedTimeVisible', true);
        this.topicAgeColorEnabled = Storage.get('topicAgeColorEnabled', true);
                this.topicAgeHighlightColors = Storage.get('topicAgeHighlightColors', {
            fresh0: '#f97316',
            fresh1: '#22c55e',
            fresh2: '#38bdf8',
            fresh3: '#a78bfa',
            fresh5: '#f59e0b',
            old: '#fdba74',
            ancient: '#fca5a5'
        });
        this.innerCollapsibleState = Storage.get('innerCollapsibleState', {});
        // 新增：阅读帖子数量限制功能
        this.stopAfterReadEnabled = Storage.get('stopAfterReadEnabled', false); // 是否开启阅读数量限制
        this.stopAfterReadCount = Math.min(200, Math.max(5, Math.round(Number(Storage.get('stopAfterReadCount', 10)) || 10))); // 阅读多少帖子后停止
        this.skipLargeReplyTopicsEnabled = Storage.get('skipLargeReplyTopicsEnabled', true); // 默认跳过回复数大于 200 的帖子
        this.currentSessionReadCount = this.getSessionStorage('currentSessionReadCount', 0); // 当前会话已阅读数量
        this.lastCountedTopicId = this.getSessionStorage('lastCountedTopicId', null);

        // 新增：点赞上限停止阅读功能
        this.stopOnLikeLimitEnabled = Storage.get('stopOnLikeLimitEnabled', false); // 点赞达到上限后是否停止阅读

        // 新增：点赞过滤功能
        this.likeFilterMode = Storage.get('likeFilterMode', 'off'); // 'off' | 'threshold' | 'probability'
        this.likeMinThreshold = Storage.get('likeMinThreshold', 5); // 最低点赞数阈值
        this.likeMinThreshold = Math.min(20, Math.max(1, Math.round(Number(this.likeMinThreshold) || 5)));

        // 新增：CloudFlare 5秒盾自动跳转功能
        this.cfBypassEnabled = Storage.get('cfBypassEnabled', true); // 默认开启

        // v2.3.1：清理已移除的回复点赞模式及旧版不可靠的主题点赞记录
        if (!Storage.get('autoLikeStrategyV231Migrated', false)) {
            Storage.remove('quickLikeEnabled');
            Storage.remove('ultraLikeEnabled');
            Storage.remove('quickLikedFloors');
            Storage.remove('likedTopics');
            Storage.set('autoLikeStrategyV231Migrated', true);
        }
        this.likedTopics = Storage.get('likedTopics', []);
        this.autoLikeStatusKey = this.autoLikeEnabled ? 'autoLikeReady' : 'autoLikeDisabled';
        this.panelMinimized = Storage.get('panelMinimized', false);
        this.panelPosition = Storage.get('panelPosition', { x: null, y: null });
        this.likeResumeTime = Storage.get('likeResumeTime', null);
        this.ipRateLimitResumeTime = Storage.get('ipRateLimitResumeTime', null); // IP 限流恢复时间
        this.ipRateLimitCheckInterval = null; // IP 限流恢复检测定时器
        this.currentUsername = null; // 当前用户名
        this.lastDetectedUser = null; // 上次检测到的用户名（用于账号切换检测）
        this.readTopics = []; // 当前用户的已阅读帖子列表，初始化后会加载
        this.readTopicIds = new Set(); // O(1) 已读判断，避免大量历史记录时反复扫描数组
        this.awaitingHomeTopicClick = this.getSessionStorage('awaitingHomeTopicClick', false);
        this.homeTopicClickInProgress = false;
        this.remainingHomeUnreadCount = Math.max(0, Number(this.getSessionStorage('remainingHomeUnreadCount', 0)) || 0);
        this.hasRemainingHomeUnreadSnapshot = this.getSessionStorage('hasRemainingHomeUnreadSnapshot', false);
        this.skippedReadCount = this.getSessionStorage('skippedReadCount', 0); // 本次会话跳过的已读帖子数
        this.todayReadCount = this.loadTodayReadCount(); // 今日阅读帖子数
        this.readingStartedAt = this.autoRunning
            ? Math.max(0, Number(this.getSessionStorage('readingStartedAt', Date.now())) || Date.now())
            : 0;
        this.lastReadingElapsedMs = Math.max(0, Number(this.getSessionStorage('lastReadingElapsedMs', 0)) || 0);
        this.readingTimerInterval = null;
        this.officialPostsReadCount = null; // 账号信息中的“浏览帖子”数（posts_read_count）
        this.officialReadCountSyncing = false;
        this.officialReadCountSyncPending = false;
        this.autoLikeInFlightTopics = new Set();

        this.autoLikeDecisionCache = new Map();
        this._topicCreatedTimeObserver = null; // 列表页创建时间观察器

        // 检查是否到达恢复点赞的时间
        this.checkLikeResumeTime();
        // 监听点赞限制弹窗
        this.observeLikeLimit();
        // 检查 IP 限流状态并检测当前页面
        this.checkIpRateLimitStatus();
        this.detectIpRateLimit();

        this.setupButton();
        // 根据当前布局和激活状态决定是否加载账号信息
        if (this.autoRunning) this.startReadingTimer(true);
        this.initDataLoading();
        this.startUserSwitchMonitoring(); // 启动账号切换监控
        this.initFloorNumberDisplay();
        this.setupWindowResizeHandler(); // 设置窗口大小调整处理
        this.initOnlyOwnerView();
        this.initTopicCreatedTimeEnhancer();

        if (!this.firstUseChecked) {
            this.handleFirstUse();
        } else if (this.autoRunning) {
            // 先加载阅读历史，再根据当前页面恢复阅读
            this.loadUserReadHistory().then(() => {
                this.resumeHomeClickReading();
            });
        } else {
            // 非自动运行模式，也加载阅读历史
            this.loadUserReadHistory();
        }

        // 启动导航守护程序 - 防止卡住
        this.startNavigationGuard();

        // 初始化用户信息助手 - 默认启用，让每个窗口独立工作
        this.userInfoHelper = new UserInfoHelper();

        // 初始化点赞计数器（仅在 linux.do 和 idcflare.com 上启用）
        if (CURRENT_DOMAIN === 'linux.do' || CURRENT_DOMAIN === 'idcflare.com') {
            this.initLikeCounter();
        }

        // 启动等级监控（60秒刷新一次）- 默认启用
        this.startTrustLevelMonitor();

        // 应用保存的主题配色
        this.applyThemeColor();
        this.applyTopicAgeHighlightColors();


        // 初始化 CloudFlare 5秒盾自动跳转功能（仅在 linux.do 上启用）
        if (CURRENT_DOMAIN === 'linux.do') {
            this.initCloudFlareBypass();
        }
    }

    // 应用主题配色
    applyThemeColor() {
        const theme = this.themeConfigs[this.themeColor] || this.themeConfigs.purple;

        // 更新面板背景渐变
        if (this.container) {
            this.container.style.background = theme.gradient;
        }

        console.log(`[主题] 已应用主题配色: ${this.themeColor}`);
    }

                applyTopicAgeHighlightColors() {
        const root = document.documentElement;
        const colors = this.topicAgeHighlightColors || {};
        root.style.setProperty('--lda-topic-age-fresh0', colors.fresh0 || '#f97316');
        root.style.setProperty('--lda-topic-age-fresh1', colors.fresh1 || colors.fresh || '#22c55e');
        root.style.setProperty('--lda-topic-age-fresh2', colors.fresh2 || '#38bdf8');
        root.style.setProperty('--lda-topic-age-fresh3', colors.fresh3 || '#a78bfa');
        root.style.setProperty('--lda-topic-age-fresh5', colors.fresh5 || '#f59e0b');
        root.style.setProperty('--lda-topic-age-old', colors.old || '#fdba74');
        root.style.setProperty('--lda-topic-age-ancient', colors.ancient || '#fca5a5');
        root.style.setProperty('--lda-topic-age-enabled', this.topicAgeColorEnabled ? '1' : '0');
    }

    // 切换主题配色
    switchTheme(themeName) {
        if (!this.themeConfigs[themeName]) {
            console.warn(`[主题] 未知的主题: ${themeName}`);
            return;
        }

        this.themeColor = themeName;
        this.applyTopicAgeHighlightColors();

        Storage.set('themeColor', themeName);
        this.setSessionStorage('themeColor', themeName);
        this.applyThemeColor();

        // 更新主题选择器 UI
        this.updateThemeSelectorUI();

        this.showNotification(this.t('themeChanged'));
        console.log(`[主题] 切换到主题: ${themeName}`);
    }

    // 更新主题选择器 UI
    updateThemeSelectorUI() {
        const themeButtons = this.container?.querySelectorAll('.theme-btn');
        if (!themeButtons) return;

        themeButtons.forEach(btn => {
            const btnTheme = btn.getAttribute('data-theme');
            if (btnTheme === this.themeColor) {
                btn.classList.add('active');
                btn.style.border = '2px solid white';
                btn.style.transform = 'scale(1.1)';
            } else {
                btn.classList.remove('active');
                btn.style.border = '2px solid transparent';
                btn.style.transform = 'scale(1)';
            }
        });
    }

    // 创建主题选择器 UI
    createThemeSelector() {
        const container = document.createElement('div');
        container.className = 'theme-selector';
        container.style.cssText = `
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            margin-top: 8px;
        `;

        Object.entries(this.themeConfigs).forEach(([key, config]) => {
            const btn = document.createElement('button');
            btn.className = 'theme-btn';
            btn.setAttribute('data-theme', key);
            btn.style.cssText = `
                width: 100%;
                height: 36px;
                border-radius: 8px;
                border: 2px solid ${this.themeColor === key ? 'white' : 'transparent'};
                background: ${config.gradient};
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                color: white;

                text-shadow: 0 1px 2px rgba(0,0,0,0.3);
                transform: ${this.themeColor === key ? 'scale(1.1)' : 'scale(1)'};
            `;
            btn.innerHTML = this.t(config.name);
            btn.title = this.t(config.name);

            btn.addEventListener('mouseenter', () => {
                if (this.themeColor !== key) {
                    btn.style.transform = 'scale(1.05)';
                    btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
                }
            });

            btn.addEventListener('mouseleave', () => {
                if (this.themeColor !== key) {
                    btn.style.transform = 'scale(1)';
                    btn.style.boxShadow = 'none';
                }
            });

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.switchTheme(key);
            });

            if (this.themeColor === key) {
                btn.classList.add('active');
            }

            container.appendChild(btn);
        });

        return container;
    }

    createTopicAgeColorSettings() {
        const section = document.createElement('div');
        section.className = 'tab-sub-section';
        section.innerHTML = `<div class="tab-sub-title">${this.t('topicCreatedTimeLabel')}</div>`;

        const innerTitle = section.querySelector('.tab-sub-title');
        if (innerTitle) innerTitle.remove();

        const visibilityToggleRow = this.createToggleRow(
            this.t('topicCreatedTimeVisible'),
            this.topicCreatedTimeVisible,
            (checked) => {
                this.topicCreatedTimeVisible = checked;
                Storage.set('topicCreatedTimeVisible', checked);
                this.renderTopicCreatedTimeInList();
                this.showNotification(checked ? this.t('topicCreatedTimeEnabled') : this.t('topicCreatedTimeDisabled'));
            }
        );
        visibilityToggleRow.title = this.t('topicCreatedTimeVisibleTip');
        section.appendChild(visibilityToggleRow);

        const toggleRow = this.createToggleRow(
            this.t('topicAgeColorLabel'),
            this.topicAgeColorEnabled,
            (checked) => {
                this.topicAgeColorEnabled = checked;
                Storage.set('topicAgeColorEnabled', checked);
                this.applyTopicAgeHighlightColors();
                this.renderTopicCreatedTimeInList();
                this.showNotification(checked ? this.t('topicAgeColorEnabled') : this.t('topicAgeColorDisabled'));
            }
        );
        toggleRow.title = this.t('topicAgeColorTip');
        section.appendChild(toggleRow);

                const presets = [
            { key: 'fresh0', label: '小于1天，但已过北京时间00:00' },
            { key: 'fresh1', label: '新帖：1天（含<1天）' },
            { key: 'fresh2', label: '新帖：2天' },
            { key: 'fresh3', label: '新帖：3天' },
            { key: 'fresh5', label: '新帖：5天' },
            { key: 'old', label: this.t('topicAgeColorOld') },
            { key: 'ancient', label: this.t('topicAgeColorAncient') }
        ];

                presets.forEach(({ key, label }) => {
            const row = document.createElement('div');
            row.className = 'topic-age-color-row';

            const labelEl = document.createElement('span');
            labelEl.className = 'toggle-label';
            labelEl.textContent = label;

            const input = document.createElement('input');
            input.type = 'color';
            input.className = 'topic-age-color-input';
            input.value = this.topicAgeHighlightColors?.[key] || '#ffffff';
            input.addEventListener('input', (e) => {
                this.topicAgeHighlightColors = {
                    ...(this.topicAgeHighlightColors || {}),
                    [key]: e.target.value
                };
                Storage.set('topicAgeHighlightColors', this.topicAgeHighlightColors);
                this.applyTopicAgeHighlightColors();
            });
            input.addEventListener('change', () => {
                this.showNotification(this.t('topicAgeColorUpdated'));
            });

            row.appendChild(labelEl);
            row.appendChild(input);
            section.appendChild(row);
        });

        const highlightCfg = this.getTopicHighlightEnhanceConfig();

        const highlightEnhanceTitle = document.createElement('div');
        highlightEnhanceTitle.className = 'toggle-label';
        highlightEnhanceTitle.textContent = '🔥 NEW / 热门高亮设置';
        highlightEnhanceTitle.style.cssText = 'margin-top: 12px; font-weight: 700; opacity: 0.95;';
        section.appendChild(highlightEnhanceTitle);

        const onlyUnreadRow = this.createToggleRow(
            '仅未读帖子生效',
            !!highlightCfg.onlyUnread,
            (checked) => {
                this.saveTopicHighlightEnhanceConfig({ onlyUnread: checked });
                this.renderTopicCreatedTimeInList();
                this.showNotification(`仅未读生效：${checked ? '开启' : '关闭'}`);
            }
        );
        section.appendChild(onlyUnreadRow);

        const showNewTagRow = this.createToggleRow(
            '显示 NEW 标签',
            !!highlightCfg.showNewTag,
            (checked) => {
                this.saveTopicHighlightEnhanceConfig({ showNewTag: checked });
                this.renderTopicCreatedTimeInList();
                this.showNotification(`NEW 标签：${checked ? '开启' : '关闭'}`);
            }
        );
        section.appendChild(showNewTagRow);

        const newTagDaysRow = this.createSliderRow(
            'NEW 标签天数',
            Number(highlightCfg.newTagDays || 2),
            1, 7, 1,
            (value) => {
                this.saveTopicHighlightEnhanceConfig({ newTagDays: Number(value) || 2 });
                this.renderTopicCreatedTimeInList();
            }
        );
        newTagDaysRow.title = '小于等于该天数时显示 NEW 标签';
        section.appendChild(newTagDaysRow);

        const hotThresholdRow = this.createSliderRow(
            '热门阈值（回复数）',
            Number(highlightCfg.hotThreshold || 30),
            1, 200, 1,
            (value) => {
                this.saveTopicHighlightEnhanceConfig({ hotThreshold: Number(value) || 30 });
                this.renderTopicCreatedTimeInList();
            }
        );
        hotThresholdRow.title = '达到该回复数后高亮为热门';
        section.appendChild(hotThresholdRow);

        const hotColorRow = document.createElement('div');
        hotColorRow.className = 'topic-age-color-row';

        const hotColorLabel = document.createElement('span');
        hotColorLabel.className = 'toggle-label';
        hotColorLabel.textContent = '热门描边颜色';

        const hotColorInput = document.createElement('input');
        hotColorInput.type = 'color';
        hotColorInput.className = 'topic-age-color-input';
        hotColorInput.value = highlightCfg.hotColor || '#722ed1';
        hotColorInput.addEventListener('input', (e) => {
            this.saveTopicHighlightEnhanceConfig({ hotColor: e.target.value || '#722ed1' });
            this.renderTopicCreatedTimeInList();
        });
        hotColorInput.addEventListener('change', () => {
            this.showNotification('热门高亮颜色已更新');
        });

        hotColorRow.appendChild(hotColorLabel);
        hotColorRow.appendChild(hotColorInput);
        section.appendChild(hotColorRow);

        return section;

    }

    createInnerCollapsibleSection(title, contentNode, collapsed = true, stateKey = '') {
        const resolvedCollapsed = stateKey && Object.prototype.hasOwnProperty.call(this.innerCollapsibleState || {}, stateKey)
            ? !!this.innerCollapsibleState[stateKey]
            : collapsed;

        const wrapper = document.createElement('div');
        wrapper.className = `settings-inner-collapsible${resolvedCollapsed ? ' collapsed' : ''}`;
        if (stateKey) {
            wrapper.dataset.stateKey = stateKey;
        }

        const header = document.createElement('div');
        header.className = 'settings-inner-collapsible-header';
        header.innerHTML = `<span>${title}</span><span class="collapse-icon">▼</span>`;

        const body = document.createElement('div');
        body.className = 'settings-inner-collapsible-content';
        if (contentNode) {
            body.appendChild(contentNode);
        }

        header.addEventListener('click', () => {
            wrapper.classList.toggle('collapsed');

            if (stateKey) {
                this.innerCollapsibleState = {
                    ...(this.innerCollapsibleState || {}),
                    [stateKey]: wrapper.classList.contains('collapsed')
                };
                Storage.set('innerCollapsibleState', this.innerCollapsibleState);
            }
        });

        wrapper.appendChild(header);
        wrapper.appendChild(body);
        return wrapper;
    }


    // 初始化点赞计数器
    initLikeCounter() {
        // 创建全局实例（如果还没有）
        if (!globalLikeCounter) {
            globalLikeCounter = new LikeCounter();
        }
        this.likeCounter = globalLikeCounter;

        // 注册 UI 更新回调
        this.likeCounter.onUIUpdate((status) => {
            this.updateLikeCounterUI(status);

            // 如果进入冷却状态，自动关闭点赞开关
            if (status.isInCooldown) {
                if (this.autoLikeEnabled) {
                    this.disableAutoLike();
                    this.updateAutoLikeStatus('autoLikeCooling');
                    console.log('[LikeCounter] 检测到冷却，已自动关闭自动点赞');
                }
            }
        });

        this.getCurrentUsername().then((username) => {
            if (!username) return;
            this.likeCounter.setCurrentUser({ username });
        });

        // 初始更新 UI
        setTimeout(() => {
            this.updateLikeCounterUI(this.likeCounter.getStatus());
        }, 500);
    }

    // 更新点赞计数器 UI
    updateLikeCounterUI(status) {
        if (!this.likeCounterContainer) return;

        const { remaining, used, limit, isInCooldown, cooldownFormatted, matched } = status;

        // 如果是冷却状态且定时器已在运行，只更新时间显示，不重建整个UI
        if (isInCooldown && this.likeCounterCooldownTimer) {
            const timeSpan = this.likeCounterContainer.querySelector('.like-cooldown-time');
            if (timeSpan && cooldownFormatted) {
                timeSpan.textContent = cooldownFormatted;
                return; // 定时器已在运行，直接返回
            }
        }

        // 清除之前的冷却倒计时定时器
        if (this.likeCounterCooldownTimer) {
            clearInterval(this.likeCounterCooldownTimer);
            this.likeCounterCooldownTimer = null;
        }

        let html = '';
        if (isInCooldown && cooldownFormatted) {
            // 冷却状态
            html = `
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 11px; color: #ff6b6b;">🔥 ${this.t('likeCooldown')}</span>
                    <span class="like-cooldown-time" style="font-size: 13px; font-weight: bold; color: #ff6b6b;">${cooldownFormatted}</span>
                </div>
            `;
            this.likeCounterContainer.style.background = 'linear-gradient(135deg, rgba(255,107,107,0.3) 0%, rgba(255,107,107,0.15) 100%)';
            this.likeCounterContainer.style.borderColor = 'rgba(255,107,107,0.4)';

            // 启动每秒更新倒计时（只有当定时器不存在时才创建）
            if (!this.likeCounterCooldownTimer) {
                this.likeCounterCooldownTimer = setInterval(() => {
                    if (!this.likeCounter) return;
                    const newFormatted = this.likeCounter.formatCooldown();
                    const timeSpan = this.likeCounterContainer?.querySelector('.like-cooldown-time');
                    if (timeSpan && newFormatted) {
                        timeSpan.textContent = newFormatted;
                    } else if (!newFormatted) {
                        // 冷却结束，重新获取完整状态并更新UI
                        clearInterval(this.likeCounterCooldownTimer);
                        this.likeCounterCooldownTimer = null;
                        this.updateLikeCounterUI(this.likeCounter.getStatus());
                    }
                }, 1000);
            }
        } else {
            // 正常状态
            const percentage = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
            const color = percentage > 50 ? '#7dffb3' : (percentage > 20 ? '#ffd700' : '#ff6b6b');

            html = `
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        ${!matched ? `<span class="like-sync-btn" title="${this.t('likeCountMismatch')}" style="cursor: pointer; opacity: 0.7;">⚠️</span>` : ''}
                        <span style="font-size: 11px; color: rgba(255,255,255,0.8);">❤️ ${this.t('likeRemaining')}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 16px; font-weight: bold; color: ${color};">${remaining}</span>
                        <span style="font-size: 11px; color: rgba(255,255,255,0.6);">/ ${limit}</span>
                    </div>
                </div>
                <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; margin-top: 4px; overflow: hidden;">
                    <div style="width: ${percentage}%; height: 100%; background: ${color}; border-radius: 2px; transition: width 0.3s;"></div>
                </div>
            `;
            this.likeCounterContainer.style.background = 'rgba(255, 255, 255, 0.1)';
            this.likeCounterContainer.style.borderColor = 'rgba(255, 255, 255, 0.15)';
        }

        this.likeCounterContainer.innerHTML = html;

        // 绑定同步按钮点击事件
        const syncBtn = this.likeCounterContainer.querySelector('.like-sync-btn');
        if (syncBtn) {
            syncBtn.onclick = async (e) => {
                e.stopPropagation();
                syncBtn.textContent = '🔄';
                syncBtn.style.animation = 'spin 1s linear infinite';
                await this.likeCounter.manualSync();
                syncBtn.style.animation = '';
            };
        }

        // 同步更新清除冷却按钮的显示状态
        this.updateClearCooldownButton();
    }

    // 更新点赞开关 UI 状态
    updateLikeToggleUI() {
        const toggleRows = this.container?.querySelectorAll('.toggle-row');
        if (!toggleRows) return;

        for (const row of toggleRows) {
            const label = row.querySelector('.toggle-label');
            if (label && (label.textContent.includes('自动点赞') || label.textContent.includes('Auto Like'))) {
                const input = row.querySelector('input[type="checkbox"]');
                if (input) input.checked = this.autoLikeEnabled;
            }
        }
    }

    disableAutoLike() {
        this.autoLikeEnabled = false;
        Storage.set('autoLikeEnabled', false);
        this.updateLikeToggleUI();
        this.updateAutoLikeStatus('autoLikeDisabled');
    }

    setAutoLikeEnabled(checked) {
        this.autoLikeEnabled = checked;
        Storage.set('autoLikeEnabled', checked);
        this.updateLikeToggleUI();
        this.updateAutoLikeStatus(checked ? 'autoLikeReady' : 'autoLikeDisabled');
    }

    updateAutoLikeStatus(statusKey, detail = '') {
        this.autoLikeStatusKey = statusKey;
        this.autoLikeStatusDetail = detail;
        if (!this.autoLikeStatusContainer) return;

        const label = document.createElement('span');
        label.style.color = 'rgba(255,255,255,0.72)';
        label.textContent = `${this.t('autoLikeStatus')}:`;

        const value = document.createElement('span');
        value.style.cssText = 'color: #ffd700; font-weight: 600; text-align: right;';
        value.textContent = `${this.t(statusKey)}${detail ? ` · ${detail}` : ''}`;
        this.autoLikeStatusContainer.replaceChildren(label, value);
    }

    async runLikeActionForCurrentTopic() {
        if (!this.autoRunning) return;
        if (!this.isTopicPage) return;
        if (!this.autoLikeEnabled) return;

        const topicId = window.location.pathname.match(/\/t\/[^/]+\/(\d+)/)?.[1] || null;
        if (!topicId || this.autoLikeInFlightTopics.has(topicId)) return;

        this.autoLikeInFlightTopics.add(topicId);
        try {
            await this.autoLikeTopic();
        } finally {
            this.autoLikeInFlightTopics.delete(topicId);
        }
    }

    getPageContextKey(urlString = window.location.href) {
        try {
            const base = window.location?.origin || BASE_URL;
            const url = new URL(urlString, base);
            const topicMatch = url.pathname.match(/^\/t\/topic\/(\d+)(?:\/\d+)?\/?$/);
            if (topicMatch) return `topic:${topicMatch[1]}`;
            return `${url.pathname}${url.search}`;
        } catch (_) {
            return String(urlString || '');
        }
    }

    getTopicProgressSnapshot() {
        const { scrollHeight } = document.documentElement || {};
        return {
            scrollHeight: scrollHeight || 0,
            postCount: document.querySelectorAll('.topic-post').length,
            maxLoadedPostNumber: this.getLoadedMaxPostNumber()
        };
    }

    getLoadedMaxPostNumber() {
        const posts = Array.from(document.querySelectorAll('.topic-post[data-post-number]'));
        return posts.reduce((max, post) => {
            const number = Number.parseInt(post.getAttribute('data-post-number') || '0', 10);
            return Number.isFinite(number) ? Math.max(max, number) : max;
        }, 0);
    }

    async getCurrentTopicMaxPostNumber() {
        const topicIdMatch = window.location.pathname.match(/\/t\/topic\/(\d+)/);
        const topicId = topicIdMatch ? topicIdMatch[1] : null;
        if (!topicId) return this.getLoadedMaxPostNumber();

        if (this._topicMaxPostNumberTopicId === topicId && Number.isFinite(this._topicMaxPostNumber)) {
            return this._topicMaxPostNumber;
        }

        const url = new URL(window.location.href);
        url.hash = '';
        const jsonUrl = url.toString().replace(/\/$/, '') + '.json';
        try {
            const response = await fetch(jsonUrl, { credentials: 'include' });
            const data = response && response.ok ? await response.json() : null;
            const maxPostNumber = Number(data?.highest_post_number || data?.posts_count || 0);
            this._topicMaxPostNumberTopicId = topicId;
            this._topicMaxPostNumber = Number.isFinite(maxPostNumber) && maxPostNumber > 0
                ? maxPostNumber
                : this.getLoadedMaxPostNumber();
            return this._topicMaxPostNumber;
        } catch (_) {
            return this.getLoadedMaxPostNumber();
        }
    }

    hasTopicProgressChanged(previous, current) {
        return current.scrollHeight > previous.scrollHeight + 50 ||
            current.postCount > previous.postCount ||
            current.maxLoadedPostNumber > previous.maxLoadedPostNumber;
    }

    async isTopicFullyRead() {
        const requiredStableChecks = CONFIG.scroll.bottomSettleChecks;
        const settleDelay = CONFIG.scroll.bottomSettleDelay;
        const maxRounds = CONFIG.scroll.tailLoadMaxRounds;
        const targetMaxPostNumber = await this.getCurrentTopicMaxPostNumber();
        let previous = this.getTopicProgressSnapshot();
        let stableChecks = 0;

        for (let attempt = 0; attempt < maxRounds; attempt++) {
            // 保持当前位置，只触发 Discourse 检查并加载下一批回复
            window.dispatchEvent(new Event('scroll'));
            document.dispatchEvent(new Event('scroll', { bubbles: true }));
            await Utils.sleep(settleDelay);
            if (!this.autoRunning || !this.isScrolling) return false;

            const current = this.getTopicProgressSnapshot();
            const reachedTarget = targetMaxPostNumber <= 0 || current.maxLoadedPostNumber >= targetMaxPostNumber;
            const progressChanged = this.hasTopicProgressChanged(previous, current);

            // 新回复已经追加：退出底部检测，从当前位置继续按阅读速度向下滚动
            if (progressChanged) return false;

            if (reachedTarget && Utils.isAtBottom()) {
                stableChecks++;
                if (stableChecks >= requiredStableChecks) return true;
            } else {
                stableChecks = 0;
            }

            previous = current;
        }

        return false;
    }

    isPageLoadingStalled(timeOnPage) {
        return this.isTopicPage &&
            timeOnPage > CONFIG.time.topicLoadingTimeout &&
            !Utils.isPageLoaded();
    }

    getScrollPlan(shouldReadFullTopic) {
        const pixelsPerSecond = shouldReadFullTopic
            ? CONFIG.scroll.fullTopicPixelsPerSecond
            : CONFIG.scroll.normalPixelsPerSecond;
        const velocity = pixelsPerSecond * this.readSpeedMultiplier;
        const idealStep = velocity * CONFIG.scroll.frameDelay / 1000;
        const delay = idealStep > CONFIG.scroll.maxFrameStep
            ? Math.max(
                CONFIG.scroll.minFrameDelay,
                Math.floor(CONFIG.scroll.maxFrameStep * 1000 / velocity)
            )
            : CONFIG.scroll.frameDelay;
        const accumulatedStep = velocity * delay / 1000 + this.scrollFractionRemainder;
        const step = Math.floor(accumulatedStep);
        this.scrollFractionRemainder = accumulatedStep - step;

        return {
            step,
            behavior: 'auto',
            delay
        };
    }

    prepareTopicBacktrackPlan() {
        const topicId = window.location.pathname.match(/\/t\/[^/]+\/(\d+)/)?.[1] || null;
        if (!topicId || this.backtrackTopicId === topicId) return;

        this.backtrackTopicId = topicId;
        const backtrackCount = Utils.random(1, 2);
        const triggerRanges = backtrackCount === 1
            ? [[0.4, 0.7]]
            : [[0.25, 0.42], [0.58, 0.78]];

        this.topicBacktrackPlan = triggerRanges.map(([minProgress, maxProgress]) => ({
            triggerProgress: Utils.random(Math.round(minProgress * 100), Math.round(maxProgress * 100)) / 100,
            distance: Utils.random(CONFIG.scroll.backtrackMinDistance, CONFIG.scroll.backtrackMaxDistance)
        }));

        console.log(`[阅读回滚] 本帖计划回滚 ${backtrackCount} 次`, this.topicBacktrackPlan);
    }

    async performScheduledBacktrackIfNeeded() {
        const nextBacktrack = this.topicBacktrackPlan[0];
        if (!nextBacktrack) return false;

        const documentElement = document.documentElement;
        const scrollTop = window.scrollY || documentElement?.scrollTop || 0;
        const viewportHeight = window.innerHeight || documentElement?.clientHeight || 0;
        const scrollHeight = Math.max(documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
        const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
        const progress = maxScrollTop > 0 ? scrollTop / maxScrollTop : 0;

        if (progress < nextBacktrack.triggerProgress || scrollTop < CONFIG.scroll.backtrackMinDistance) {
            return false;
        }

        this.topicBacktrackPlan.shift();
        const distance = Math.min(nextBacktrack.distance, Math.floor(scrollTop));
        window.scrollBy({ top: -distance, behavior: 'smooth' });
        console.log(`[阅读回滚] 向上回滚 ${distance}px，剩余 ${this.topicBacktrackPlan.length} 次`);
        await Utils.sleep(CONFIG.scroll.backtrackSettleDelay);
        return true;
    }

    // 启动等级监控（60秒刷新一次）- 仅在账号信息可见时才刷新
    startTrustLevelMonitor() {
        // 如果已经有定时器在运行，先清除
        if (this.trustLevelMonitorInterval) {
            clearInterval(this.trustLevelMonitorInterval);
        }

        this.trustLevelMonitorInterval = setInterval(() => {
            // 检查是否应该刷新等级信息
            if (this.shouldRefreshAccountInfo()) {
                console.log('自动刷新等级信息...');
                this.loadUserTrustLevel(false);
            }
        }, 30 * 60 * 1000); // 30分钟

        console.log('等级监控已启动（30分钟刷新一次，仅在可见时）');
    }

    // 停止等级监控
    stopTrustLevelMonitor() {
        if (this.trustLevelMonitorInterval) {
            clearInterval(this.trustLevelMonitorInterval);
            this.trustLevelMonitorInterval = null;
            console.log('等级监控已停止');
        }
    }

    // 检查是否应该刷新账号信息
    shouldRefreshAccountInfo() {
        // 如果面板已最小化，不刷新
        if (this.panelMinimized) {
            return false;
        }

        // 标签页模式：只有当前激活的是账号标签页(1)时才刷新
        if (this.tabMode) {
            return this.activeTab === 1;
        }

        // 折叠模式：只有账号信息区展开时才刷新
        if (this.accountSection && this.accountSectionContent) {
            return !this.accountSection.classList.contains('collapsed');
        }

        return false;
    }

    // 初始化数据加载 - 根据当前布局和激活状态决定加载哪些数据
    initDataLoading() {
        // 如果面板已最小化，不加载任何数据
        if (this.panelMinimized) {
            console.log('[初始化] 面板已最小化，跳过数据加载');
            return;
        }

        if (this.tabMode) {
            // 标签页模式：只加载当前激活标签页的数据
            console.log(`[初始化] 标签页模式，当前激活标签页: ${this.activeTab}`);
            switch (this.activeTab) {
                case 1: // 账号信息
                    this.loadUserTrustLevel();
                    break;
                // 其他标签页不需要初始加载数据
            }
        } else {
            // 折叠模式：只加载展开区域的数据
            console.log('[初始化] 折叠模式');

            // 检查账号信息区是否展开（默认展开，除非正在自动阅读）
            if (this.accountSection && !this.accountSection.classList.contains('collapsed')) {
                console.log('[初始化] 账号信息区已展开，加载数据');
                this.loadUserTrustLevel();
            } else {
                console.log('[初始化] 账号信息区已折叠，跳过加载');
            }
        }
    }

    // 启动导航守护程序 - 检测页面是否卡住
    startNavigationGuard() {
        if (this.navigationGuardInterval) {
            clearInterval(this.navigationGuardInterval);
        }

        // 记录页面加载时间
        this.pageLoadTime = Date.now();
        this.lastPageContextKey = this.getPageContextKey(window.location.href);

        // 每5秒检查一次页面状态
        this.navigationGuardInterval = setInterval(() => {
            if (!this.autoRunning) return;

            const currentTime = Date.now();
            const timeOnPage = currentTime - this.pageLoadTime;
            const currentPageContextKey = this.getPageContextKey(window.location.href);

            // 检测URL是否改变
            if (currentPageContextKey !== this.lastPageContextKey) {
                console.log('✅ 页面已跳转，重置守护定时器');
                this.pageLoadTime = currentTime;
                this.lastPageContextKey = currentPageContextKey;
                return;
            }

            if (this.isPageLoadingStalled(timeOnPage)) {
                console.warn('⚠️ 检测到页面持续加载超时，停止自动阅读');
                this.showNotification(this.t('stoppedByPageLoading'));
                this.stopAutoReading();
                return;
            }

            // 如果在同一个文章页面停留超过60秒且正在自动运行，说明可能卡住了
            if (this.isTopicPage && timeOnPage > 60000 && !this.isScrolling) {
                console.warn('⚠️ 检测到页面可能卡住（60秒未跳转且未滚动），尝试恢复...');
                this.recoverFromStuck();
            }

            // 如果不是文章页且停留超过30秒，也可能卡住
            if (!this.isTopicPage && timeOnPage > 30000) {
                console.warn('⚠️ 检测到在非文章页卡住，尝试恢复...');
                this.recoverFromStuck();
            }
        }, 5000);

        console.log('🛡️ 导航守护程序已启动');
    }

    async waitForElement(selector, timeoutMs = 15000) {
        const startedAt = Date.now();
        while (this.autoRunning && Date.now() - startedAt < timeoutMs) {
            const element = document.querySelector(selector);
            if (element) return element;
            await Utils.sleep(250);
        }
        return null;
    }

    getHomeUnreadTopicCandidates() {
        const seen = new Set();
        const candidates = [];
        const rows = document.querySelectorAll(
            'tr.topic-list-item, .topic-list-item, .latest-topic-list-item'
        );

        for (const row of rows) {
            const link = row.querySelector(
                'a.raw-topic-link[href*="/t/"], a.title[href*="/t/"], a[href^="/t/"]'
            );
            if (!link) continue;

            let topicId = null;
            try {
                const target = new URL(link.href, window.location.href);
                if (target.origin !== window.location.origin) continue;
                topicId = target.pathname.match(/^\/t\/[^/]+\/(\d+)/)?.[1] || null;
            } catch (_) {
                continue;
            }

            if (!topicId || seen.has(topicId) || this.isTopicRead(topicId)) continue;

            const replyCount = this.getTopicReplyCountFromRow(row);
            if (this.skipLargeReplyTopicsEnabled && replyCount !== null && replyCount > 200) {
                console.log(`[首页筛选] 跳过回复数超过 200 的帖子 ${topicId}（${replyCount} 回复）`);
                continue;
            }

            seen.add(topicId);
            candidates.push({ topicId, link, replyCount });
        }

        return candidates;
    }

    parseCompactCount(value) {
        const text = String(value ?? '').trim().toLowerCase().replace(/,/g, '');
        const match = text.match(/(\d+(?:\.\d+)?)\s*(万|千|[km])?/i);
        if (!match) return null;

        const number = Number(match[1]);
        if (!Number.isFinite(number)) return null;

        const unit = match[2]?.toLowerCase();
        const multiplier = unit === '万' ? 10000 : (unit === '千' || unit === 'k' ? 1000 : (unit === 'm' ? 1000000 : 1));
        return Math.round(number * multiplier);
    }

    getTopicReplyCountFromRow(row) {
        for (const value of [
            row.dataset?.replies,
            row.dataset?.replyCount,
            row.getAttribute('data-replies')
        ]) {
            const directReplyCount = this.parseCompactCount(value);
            if (directReplyCount !== null) return directReplyCount;
        }

        const replyCountNode = row.querySelector(
            'td.posts-map .number, td.posts .number, .topic-list-data.posts .number, .posts-map .number, [data-replies-count]'
        );
        if (replyCountNode) {
            for (const value of [
                replyCountNode.getAttribute('data-replies-count'),
                replyCountNode.getAttribute('aria-label'),
                replyCountNode.getAttribute('title'),
                replyCountNode.textContent
            ]) {
                const displayedCount = this.parseCompactCount(value);
                if (displayedCount !== null) return displayedCount;
            }
        }

        const totalPostCount = this.parseCompactCount(
            row.dataset?.postsCount ?? row.getAttribute('data-posts-count')
        );
        return totalPostCount === null ? null : Math.max(0, totalPostCount - 1);
    }

    setRemainingHomeUnreadCount(count) {
        this.remainingHomeUnreadCount = Math.max(0, Number(count) || 0);
        this.hasRemainingHomeUnreadSnapshot = true;
        this.setSessionStorage('remainingHomeUnreadCount', this.remainingHomeUnreadCount);
        this.setSessionStorage('hasRemainingHomeUnreadSnapshot', true);
        this.updateReadStatsDisplay();
        if (this.autoRunning) this.updateReadingStatus();
    }

    getDisplayedRemainingCount() {
        const homeRemaining = Math.max(0, Number(this.remainingHomeUnreadCount) || 0);
        if (this.stopAfterReadEnabled) {
            return Math.max(0, this.stopAfterReadCount - this.todayReadCount);
        }
        return homeRemaining;
    }

    async clickUnreadTopicFromHome() {
        if (!this.autoRunning || this.homeTopicClickInProgress) return false;
        this.homeTopicClickInProgress = true;

        try {
            await this.waitForElement('tr.topic-list-item, .topic-list-item, .latest-topic-list-item');
            let unchangedRounds = 0;
            let previousRowCount = -1;

            for (let round = 0; round < 10 && this.autoRunning; round++) {
                const candidates = this.getHomeUnreadTopicCandidates();
                if (candidates.length > 0) {
                    const selected = this.randomOrderEnabled
                        ? candidates[Math.floor(Math.random() * candidates.length)]
                        : candidates[0];

                    console.log(`[首页点击] 打开未读帖子 ${selected.topicId}`);
                    selected.link.scrollIntoView({ behavior: 'auto', block: 'center' });
                    await Utils.sleep(120);
                    if (!this.autoRunning || !selected.link.isConnected) return false;

                    this.awaitingHomeTopicClick = true;
                    this.setSessionStorage('awaitingHomeTopicClick', true);
                    this.setRemainingHomeUnreadCount(candidates.length - 1);
                    await HumanInput.click(selected.link);

                    clearTimeout(this.navigationTimeout);
                    this.navigationTimeout = setTimeout(() => {
                        if (!this.autoRunning || this.isTopicPage) return;
                        console.warn('[首页点击] 帖子链接未成功打开，刷新首页重试');
                        window.location.href = `${BASE_URL}/latest`;
                    }, 12000);
                    return true;
                }

                const rowCount = document.querySelectorAll(
                    'tr.topic-list-item, .topic-list-item, .latest-topic-list-item'
                ).length;
                unchangedRounds = rowCount === previousRowCount ? unchangedRounds + 1 : 0;
                previousRowCount = rowCount;
                if (unchangedRounds >= 2) break;

                window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
                await Utils.sleep(700);
            }

            if (this.autoRunning) {
                this.setRemainingHomeUnreadCount(0);
                this.showNotification('首页暂时没有新的未读帖子，已停止阅读');
                this.stopAutoReading();
            }
            return false;
        } finally {
            this.homeTopicClickInProgress = false;
        }
    }

    async resumeHomeClickReading() {
        if (!this.autoRunning) return;

        this.isTopicPage = window.location.pathname.includes('/t/topic/');
        if (this.isTopicPage) {
            clearTimeout(this.navigationTimeout);
            this.navigationTimeout = null;
            this.awaitingHomeTopicClick = false;
            this.setSessionStorage('awaitingHomeTopicClick', false);
            await this.waitForElement('.topic-post');
            if (this.autoRunning) {
                this.updateReadStatsDisplay();
                this.updateReadingStatus();
                if (!this.isScrolling) this.startScrolling();
            }
            return;
        }

        this.awaitingHomeTopicClick = true;
        this.setSessionStorage('awaitingHomeTopicClick', true);
        if (window.location.pathname !== '/latest') {
            window.location.href = `${BASE_URL}/latest`;
            return;
        }

        await this.clickUnreadTopicFromHome();
    }

    async returnHomeForNextTopic() {
        if (!this.autoRunning) return;
        this.stopScrolling();
        this.awaitingHomeTopicClick = true;
        this.setSessionStorage('awaitingHomeTopicClick', true);
        this.topicList = [];
        this.setSessionStorage('topicList', []);

        if (window.location.pathname !== '/latest') {
            console.log('[首页点击] 当前帖子已读完，返回首页选择下一帖');
            window.location.href = `${BASE_URL}/latest`;
            return;
        }

        await this.clickUnreadTopicFromHome();
    }

    // 从卡住状态恢复
    async recoverFromStuck() {
        console.log('🔧 开始恢复流程...');

        // 停止当前滚动
        this.stopScrolling();

        await Utils.sleep(1000);
        if (!this.autoRunning) return;

        // 尝试继续流程
        if (this.isTopicPage) {
            console.log('📖 在文章页，重新开始滚动');
            this.startScrolling();
        } else {
            console.log('📋 在列表页，重新尝试点击未读帖子');
            await this.resumeHomeClickReading();
        }

        // 重置页面加载时间
        this.pageLoadTime = Date.now();
    }

    // 停止导航守护
    stopNavigationGuard() {
        if (this.navigationGuardInterval) {
            clearInterval(this.navigationGuardInterval);
            this.navigationGuardInterval = null;
            console.log('🛡️ 导航守护程序已停止');
        }
    }

    // sessionStorage 辅助方法（用于窗口独立状态）
    getSessionStorage(key, defaultValue = null) {
        try {
            const value = sessionStorage.getItem(key);
            return value ? JSON.parse(value) : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    setSessionStorage(key, value) {
        try {
            sessionStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error('SessionStorage error:', error);
            return false;
        }
    }

    addGlobalStyles() {
        if (document.getElementById('linuxdo-helper-global-styles')) return;
        const style = document.createElement('style');
        style.id = 'linuxdo-helper-global-styles';
        style.textContent = `
            :root {
                --panel-expanded-width: auto;
                --panel-minimized-size: 50px;
                --panel-edge-margin: 30px;
                --panel-border-radius: 16px;
                --panel-top-offset: 70px;
                --panel-bottom-margin: 20px;
            }

            .section-collapsible {
                cursor: pointer;
                user-select: none;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .section-collapsible .collapse-icon {
                transition: transform 0.3s;
                font-size: 10px;
            }

            .section-collapsible.collapsed .collapse-icon {
                transform: rotate(-90deg);
            }

            .section-collapsible-content {
                max-height: 1000px;
                overflow: hidden;
                transition: max-height 0.3s ease-out, opacity 0.3s ease-out;
                opacity: 1;
            }

            .section-collapsible-content.collapsed {
                max-height: 0;
                opacity: 0;
            }

            /* 当折叠区域收起时，隐藏其后的分隔线 */
            .section-collapsible.collapsed + .section-collapsible-content + .section-divider {
                display: none;
            }

            .linuxdo-helper-panel {
                position: fixed;
                right: 20px;
                top: 50%;
                transform: translateY(-50%);
                width: min(320px, calc(100vw - 40px));
                min-width: min(280px, calc(100vw - 40px));
                max-width: 320px;
                box-sizing: border-box;
                max-height: calc(100vh - var(--panel-top-offset) - var(--panel-bottom-margin));
                max-height: calc(100dvh - var(--panel-top-offset) - var(--panel-bottom-margin));
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: var(--panel-border-radius);
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
                z-index: 99999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                overflow-y: auto;
                overflow-x: hidden;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                backdrop-filter: blur(10px);
                will-change: transform;
            }

            /* 标签页导航栏 */
            .tab-nav {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 5px;
                padding: 7px 10px;
                position: sticky;
                top: 0;
                z-index: 5;
                background: rgba(30, 30, 45, 0.28);
                backdrop-filter: blur(12px);
                border-bottom: 1px solid rgba(255, 255, 255, 0.15);
            }

            .tab-nav-btn {
                min-width: 0;
                min-height: 32px;
                padding: 6px 5px;
                border: 1px solid transparent;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 3px;
                white-space: nowrap;
            }

            .tab-nav-btn:hover {
                background: rgba(255, 255, 255, 0.2);
                color: white;
            }

            .tab-nav-btn.active {
                background: rgba(255, 255, 255, 0.28);
                border-color: rgba(255, 255, 255, 0.45);
                color: white;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            }

            .tab-nav-btn:focus-visible {
                outline: 2px solid rgba(255, 255, 255, 0.9);
                outline-offset: 1px;
            }

            .tab-remaining-badge {
                min-width: 17px;
                padding: 1px 5px;
                border-radius: 999px;
                background: rgba(125, 255, 179, 0.2);
                color: #7dffb3;
                font-size: 9px;
                line-height: 15px;
                text-align: center;
            }

            /* 标签页内容区 */
            .lda-tab-content {
                display: none;
                padding: 10px;
                flex-direction: column;
                gap: 7px;
                min-width: 0;
            }

            .lda-tab-content.active {
                display: flex;
            }

            .lda-tab-content-title {
                font-size: 13px;
                font-weight: 600;
                color: white;
                margin-bottom: 8px;
                padding-bottom: 6px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                display: flex;
                align-items: center;
                gap: 6px;
            }

            /* 标签页模式下隐藏折叠标题和分隔线 */
            .linuxdo-helper-panel.tab-mode .section-divider,
            .linuxdo-helper-panel.tab-mode .section-collapsible {
                display: none;
            }

            /* 标签页模式下内容区始终显示 */
            .linuxdo-helper-panel.tab-mode .section-collapsible-content {
                max-height: none !important;
                opacity: 1 !important;
            }

            /* 标签页模式下隐藏默认的 panel-content */
            .linuxdo-helper-panel.tab-mode .panel-content {
                display: none;
            }

            /* 标签页容器 */
            .tab-container {
                transition: all 0.3s;
            }

            .tab-container.hidden {
                display: none !important;
            }

            /* 标签页模式下的子区域标题 */
            .tab-sub-section {
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px dashed rgba(255, 255, 255, 0.15);
            }

            .tab-sub-title {
                font-size: 11px;
                color: rgba(255, 255, 255, 0.7);
                margin-bottom: 6px;
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .like-settings-card {
                margin: 8px 0 6px;
                padding: 8px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 10px;
                background: rgba(20, 24, 32, 0.2);
                box-sizing: border-box;
            }

            .like-settings-title {
                display: flex;
                align-items: center;
                font-size: 11px;
                font-weight: 650;
                color: rgba(255, 255, 255, 0.9);
                margin: 0 2px 7px;
                letter-spacing: 0.2px;
            }

            .like-settings-overview {
                display: grid;
                grid-template-columns: minmax(0, 1fr);
                gap: 6px;
                margin-bottom: 6px;
            }

            .like-settings-overview > * {
                margin: 0 !important;
                min-width: 0;
                padding: 6px 7px !important;
                border: 0 !important;
                background: rgba(255, 255, 255, 0.08) !important;
                box-sizing: border-box;
            }

            .like-settings-toggle-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 6px;
                margin-bottom: 5px;
            }

            .like-settings-toggle-grid .toggle-row {
                margin: 0;
                min-height: 28px;
                padding: 5px 7px;
            }

            .like-settings-card > .like-filter-mode-row,
            .like-settings-card > .like-min-threshold-row {
                margin-top: 5px;
            }

            .like-settings-filter-grid {
                display: grid;
                grid-template-columns: minmax(0, 1fr);
                gap: 6px;
                margin-top: 5px;
            }

            .like-settings-filter-grid .toggle-row {
                margin: 0;
                min-width: 0;
                min-height: 30px;
                padding: 5px 7px;
            }

            .like-settings-filter-grid select {
                min-width: 52px !important;
            }
            .like-settings-card .read-tab-action-btn {
                width: 100%;
                margin: 6px 0 0;
            }

            .like-settings-card {
                padding: 0;
                border: 0;
                border-radius: 0;
                background: transparent;
            }

            .like-settings-title {
                display: flex;
                align-items: center;
                font-size: 12px;
                font-weight: 600;
                color: rgba(255, 255, 255, 0.9);
                margin: 4px 0;
                padding: 0 4px;
                letter-spacing: 0.5px;
                text-transform: uppercase;
            }

            .like-settings-title,
            .like-settings-card .toggle-label,
            .like-settings-overview span {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                overflow-wrap: normal;
                word-break: keep-all;
            }

            .settings-inner-collapsible {
                margin-top: 10px;
                border-top: 1px dashed rgba(255, 255, 255, 0.15);
                padding-top: 8px;
            }

            .settings-inner-collapsible-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
                user-select: none;
                font-size: 11px;
                color: rgba(255, 255, 255, 0.78);
                padding: 4px 0;
            }

            .settings-inner-collapsible-header .collapse-icon {
                transition: transform 0.25s ease;
            }

            .settings-inner-collapsible.collapsed .settings-inner-collapsible-header .collapse-icon {
                transform: rotate(-90deg);
            }

            .settings-inner-collapsible-content {
                margin-top: 8px;
            }

            .settings-inner-collapsible.collapsed .settings-inner-collapsible-content {
                display: none;
            }

            /* 小屏幕适配 - 高度小于 800px */
            @media screen and (max-height: 800px) {
                .linuxdo-helper-panel .panel-content {
                    padding: 8px;
                    gap: 4px;
                }

                .linuxdo-helper-panel .toggle-row {
                    padding: 4px 8px;
                    min-height: 22px;
                }

                .linuxdo-helper-panel .toggle-label {
                    font-size: 11px;
                }

                .linuxdo-helper-panel .section-title {
                    font-size: 11px;
                    margin: 2px 0;
                }

                .linuxdo-helper-panel .trust-level-item {
                    font-size: 10px;
                    margin: 2px 0;
                    padding: 2px 0;
                }

                .linuxdo-helper-panel .main-action-btn {
                    padding: 5px 10px;
                    font-size: 12px;
                    min-height: 26px;
                }

                .linuxdo-helper-panel .random-floor-btn,
                .linuxdo-helper-panel .reveal-users-btn,
                .linuxdo-helper-panel .read-tab-action-btn {
                    padding: 4px 8px;
                    font-size: 11px;
                    min-height: 22px;
                    margin-bottom: 3px;
                }

                .linuxdo-helper-panel .section-divider {
                    margin: 3px 0;
                }

                .linuxdo-helper-panel .trust-level-row {
                    padding: 5px 8px;
                    margin-top: 3px;
                }

                .linuxdo-helper-panel .trust-level-header {
                    font-size: 11px;
                    margin-bottom: 4px;
                }

                .linuxdo-helper-panel .panel-header {
                    padding: 8px 12px;
                }

                .linuxdo-helper-panel .panel-title {
                    font-size: 12px;
                }

                .linuxdo-helper-panel .toggle-switch {
                    width: 32px;
                    height: 18px;
                }

                .linuxdo-helper-panel .toggle-slider:before {
                    height: 12px;
                    width: 12px;
                }

                .linuxdo-helper-panel .toggle-switch input:checked + .toggle-slider:before {
                    transform: translateX(14px);
                }
            }

            /* 更小屏幕适配 - 高度小于 650px */
            @media screen and (max-height: 650px) {
                .linuxdo-helper-panel .panel-content {
                    padding: 6px;
                    gap: 3px;
                }

                .linuxdo-helper-panel .toggle-row {
                    padding: 3px 6px;
                    min-height: 20px;
                }

                .linuxdo-helper-panel .toggle-label {
                    font-size: 10px;
                }

                .linuxdo-helper-panel .section-title {
                    font-size: 10px;
                    margin: 1px 0;
                }

                .linuxdo-helper-panel .trust-level-item {
                    font-size: 9px;
                    margin: 1px 0;
                    padding: 1px 0;
                }

                .linuxdo-helper-panel .main-action-btn {
                    padding: 4px 8px;
                    font-size: 11px;
                    min-height: 24px;
                }

                .linuxdo-helper-panel .random-floor-btn,
                .linuxdo-helper-panel .reveal-users-btn,
                .linuxdo-helper-panel .read-tab-action-btn {
                    padding: 3px 6px;
                    font-size: 10px;
                    min-height: 20px;
                    margin-bottom: 2px;
                }

                .linuxdo-helper-panel .section-divider {
                    margin: 2px 0;
                }

                .linuxdo-helper-panel .trust-level-row {
                    padding: 4px 6px;
                    margin-top: 2px;
                }

                .linuxdo-helper-panel .trust-level-header {
                    font-size: 10px;
                    margin-bottom: 3px;
                }

                .linuxdo-helper-panel .panel-header {
                    padding: 6px 10px;
                }

                .linuxdo-helper-panel .panel-title {
                    font-size: 11px;
                }

                .linuxdo-helper-panel .trust-level-bar {
                    width: 50px;
                    height: 5px;
                }

                .linuxdo-helper-panel .trust-level-value {
                    font-size: 9px;
                    min-width: 40px;
                }

                .linuxdo-helper-panel .toggle-switch {
                    width: 28px;
                    height: 16px;
                }

                .linuxdo-helper-panel .toggle-slider:before {
                    height: 10px;
                    width: 10px;
                }

                .linuxdo-helper-panel .toggle-switch input:checked + .toggle-slider:before {
                    transform: translateX(12px);
                }
            }

            /* 窄屏幕适配 - 宽度小于 400px */
            @media screen and (max-width: 400px) {
                .linuxdo-helper-panel {
                    min-width: 220px;
                    max-width: calc(100vw - 30px);
                    right: 10px;
                }
            }

            .linuxdo-helper-panel:hover {
                box-shadow: 0 15px 50px rgba(0, 0, 0, 0.4);
            }

            .linuxdo-helper-panel.minimized {
                width: var(--panel-minimized-size);
                height: var(--panel-minimized-size);
                min-width: var(--panel-minimized-size);
                border-radius: 50%;
                overflow: hidden;
                cursor: pointer;
                opacity: 0.7;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            .linuxdo-helper-panel.minimized:hover {
                transform: scale(1.15);
                box-shadow: 0 8px 25px rgba(102, 126, 234, 0.6);
                opacity: 1;
            }

            /* 左边展开：从左向右 */
            .linuxdo-helper-panel.on-left {
                transform-origin: left center;
            }

            /* 右边展开：从右向左 */
            .linuxdo-helper-panel.on-right {
                transform-origin: right center;
            }

            .panel-header {
                background: rgba(255, 255, 255, 0.15);
                padding: 12px 16px;
                cursor: move;
                display: flex;
                justify-content: space-between;
                align-items: center;
                user-select: none;
                border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                transition: opacity 0.3s;
            }

            .linuxdo-helper-panel.minimized .panel-header {
                opacity: 0;
                pointer-events: none;
                padding: 0;
                height: 0;
                overflow: hidden;
            }

            .panel-header:active {
                cursor: grabbing;
            }

            .panel-title {
                color: white;
                font-weight: 600;
                font-size: 14px;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            }

            .panel-controls {
                display: flex;
                gap: 8px;
            }

            .panel-control-btn {
                width: 24px;
                height: 24px;
                border-radius: 6px;
                border: none;
                background: rgba(255, 255, 255, 0.2);
                color: white;
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
                padding: 0;
                line-height: 1;
            }

            .panel-control-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.1);
            }

            .panel-control-btn:active {
                transform: scale(0.95);
            }

            .minimized-icon {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                display: none;
                align-items: center;
                justify-content: center;
                pointer-events: none;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                font-size: 20px;
                font-weight: 700;
                color: white;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                letter-spacing: -1px;
            }

            .linuxdo-helper-panel.minimized .minimized-icon {
                display: flex;
            }

            .linuxdo-helper-panel.minimized:hover .minimized-icon {
                transform: scale(1.1);
                text-shadow: 0 3px 8px rgba(255, 255, 255, 0.6);
            }

            .panel-content {
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                transition: all 0.3s;
                overflow: hidden;
                width: 100%;
                box-sizing: border-box;
            }

            /* 布局切换按钮 */
            .layout-toggle-btn {
                width: 24px;
                height: 24px;
                border-radius: 6px;
                border: none;
                background: rgba(255, 255, 255, 0.2);
                color: white;
                cursor: pointer;
                font-size: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
                padding: 0;
                line-height: 1;
            }

            .layout-toggle-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.1);
            }

            .layout-toggle-btn:active {
                transform: scale(0.95);
            }

            .panel-content.hidden {
                max-height: 0;
                padding: 0;
                opacity: 0;
            }

            .linuxdo-helper-panel.minimized .panel-content {
                display: none;
            }

            .main-action-btn {
                width: 100%;
                padding: 8px 12px;
                font-size: 13px;
                font-weight: 600;
                background: white;
                color: #667eea;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                white-space: nowrap;
                overflow: hidden;
                min-height: 32px;
                line-height: 1.2;
                text-align: center;
            }

            .main-action-btn .btn-text {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 0 1 auto;
                min-width: 0;
                display: inline-block;
                line-height: 1.2;
                text-align: center;
            }

            .main-action-btn .btn-icon {
                flex: 0 0 auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 14px;
                line-height: 1;
            }

            .main-action-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
            }

            .main-action-btn:active {
                transform: translateY(0);
            }

            .main-action-btn.running {
                background: #ff6b6b;
                color: white;
            }

            .btn-icon {
                font-size: 18px;
            }

            .trust-level-row {
                background: rgba(255, 255, 255, 0.15);
                padding: 8px 12px;
                border-radius: 10px;
                margin-top: 8px;
            }

            .trust-level-header {
                color: white;
                font-size: 13px;
                font-weight: 600;
                margin-bottom: 6px;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .trust-level-refresh {
                background: rgba(255, 255, 255, 0.2);
                border: none;
                color: white;
                padding: 4px 8px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
                transition: all 0.2s;
            }

            .trust-level-refresh:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            .trust-level-refresh:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .trust-level-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                color: rgba(255, 255, 255, 0.9);
                font-size: 11px;
                margin: 4px 0;
                padding: 3px 0;
                white-space: nowrap;
                gap: 4px;
            }

            .trust-level-name {
                flex-shrink: 0;
                width: 110px;
                min-width: 110px;
                margin-right: 4px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .trust-level-progress {
                display: flex;
                align-items: center;
                gap: 4px;
                flex: 1;
                justify-content: flex-end;
            }

            .trust-level-bar {
                display: none; /* 暂时隐藏进度条 */
                /*
                width: 30px;
                flex-shrink: 0;
                height: 6px;
                background: rgba(255, 255, 255, 0.2);
                border-radius: 3px;
                overflow: hidden;
                */
            }

            .trust-level-bar-fill {
                height: 100%;
                background: linear-gradient(90deg, #48bb78 0%, #68d391 100%);
                transition: width 0.3s;
            }

            .trust-level-bar-fill.completed {
                background: linear-gradient(90deg, #4299e1 0%, #63b3ed 100%);
            }

            .trust-level-value {
                font-size: 10px;
                color: rgba(255, 255, 255, 0.8);
                min-width: 75px;
                text-align: right;
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 3px;
                flex-shrink: 0;
            }

            /* 数据变化指示器样式 */
            .change-indicator {
                font-size: 9px;
                font-weight: 600;
                padding: 1px 2px;
                border-radius: 3px;
                white-space: nowrap;
                flex-shrink: 0;
            }

            .change-indicator.change-up {
                color: #48bb78;
                background: rgba(72, 187, 120, 0.2);
            }

            .change-indicator.change-down {
                color: #fc8181;
                background: rgba(252, 129, 129, 0.2);
            }

            .trust-level-loading {
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                text-align: center;
                padding: 8px 0;
            }

            .random-floor-btn, .reveal-users-btn, .read-tab-action-btn {
                width: 100%;
                padding: 7px 12px;
                font-size: 12px;
                font-weight: 600;
                background: rgba(255, 255, 255, 0.95);
                color: #667eea;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-height: 28px;
                line-height: 1.2;
                margin-bottom: 6px;
                text-align: center;
            }

            .reveal-users-btn {
                margin-bottom: 0;
            }

            .read-tab-action-btn {
                margin-bottom: 6px;
            }

            .read-tab-action-btn:last-of-type {
                margin-bottom: 0;
            }

            .random-floor-btn .btn-text,
            .reveal-users-btn .btn-text,
            .read-tab-action-btn .btn-text {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 0 1 auto;
                min-width: 0;
                display: inline-block;
                line-height: 1.2;
                text-align: center;
            }

            .random-floor-btn .btn-icon,
            .reveal-users-btn .btn-icon,
            .read-tab-action-btn .btn-icon {
                flex: 0 0 auto;
                font-size: 13px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                line-height: 1;
            }

                        .lda-topic-created-time {
                font-size: 12px;
                line-height: 1;
                white-space: nowrap;
                vertical-align: middle;
                opacity: 1;
                display: inline-flex;
                align-items: center;
            }

            .lda-topic-created-separator {
                color: rgba(255, 255, 255, 0.38);
                margin: 0 8px;
            }

            @media (max-width: 1280px) {
                .lda-topic-created-separator {
                    display: none;
                }

                .lda-topic-created-label {
                    padding: 2px 6px;
                    font-size: 11px;
                }
            }


            .lda-topic-created-label {
                color: rgba(255, 255, 255, 0.86);
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 999px;
                padding: 2px 8px;
                font-weight: 700;
                box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
            }

            .lda-topic-created-time[data-age-level="neutral"] .lda-topic-created-label {
                color: rgba(255, 255, 255, 0.86);
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.18);
                box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
            }

            .lda-topic-created-time[data-age-level="old"] .lda-topic-created-label {
                color: var(--lda-topic-age-old, #fdba74);
                background: rgba(251, 146, 60, 0.16);
                border-color: rgba(251, 146, 60, 0.34);
                box-shadow: 0 0 0 1px rgba(251, 146, 60, 0.05) inset;
            }

            .lda-topic-created-time[data-age-level="ancient"] .lda-topic-created-label {
                color: var(--lda-topic-age-ancient, #fca5a5);
                background: rgba(239, 68, 68, 0.16);
                border-color: rgba(239, 68, 68, 0.36);
                box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.05) inset;
            }

                                    .lda-topic-created-time[data-age-level="fresh0"] .lda-topic-created-label {
                color: var(--lda-topic-age-fresh0, #f97316);
                background: rgba(249, 115, 22, 0.14);
                border-color: rgba(249, 115, 22, 0.34);
                box-shadow: 0 0 0 1px rgba(249, 115, 22, 0.04) inset;
            }

            .lda-topic-created-time[data-age-level="fresh1"] .lda-topic-created-label {
                color: var(--lda-topic-age-fresh1, #22c55e);
                background: rgba(34, 197, 94, 0.14);
                border-color: rgba(34, 197, 94, 0.34);
                box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.04) inset;
            }

            .lda-topic-created-time[data-age-level="fresh2"] .lda-topic-created-label {
                color: var(--lda-topic-age-fresh2, #38bdf8);
                background: rgba(56, 189, 248, 0.14);
                border-color: rgba(56, 189, 248, 0.34);
                box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.04) inset;
            }

            .lda-topic-created-time[data-age-level="fresh3"] .lda-topic-created-label {
                color: var(--lda-topic-age-fresh3, #a78bfa);
                background: rgba(167, 139, 250, 0.14);
                border-color: rgba(167, 139, 250, 0.34);
                box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.04) inset;
            }

            .lda-topic-created-time[data-age-level="fresh5"] .lda-topic-created-label {
                color: var(--lda-topic-age-fresh5, #f59e0b);
                background: rgba(245, 158, 11, 0.14);
                border-color: rgba(245, 158, 11, 0.34);
                box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.04) inset;
            }

            .lda-topic-new-tag {
                            margin-left: 6px;
                            font-size: 11px;
                            padding: 2px 6px;
                            border-radius: 999px;
                            background: #ff4d4f;
                            color: #fff;
                            font-weight: 700;
                            line-height: 1.2;
                        }

                                                tr.lda-topic-hot {
                            box-shadow: inset 0 0 0 2px var(--lda-topic-hot-color, #722ed1);
                            transition: box-shadow 2.5s ease;
                        }

                                                tr.lda-topic-hot.lda-topic-hot-fade {
                            box-shadow: inset 0 0 0 2px transparent;
                        }




            .topic-list-item.visited .lda-topic-created-time,

            .latest-topic-list-item.visited .lda-topic-created-time {
                opacity: 0.92;
            }

            .topic-age-color-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 6px 8px;
                background: rgba(255,255,255,0.08);
                border-radius: 8px;
                margin-top: 6px;
            }

            .topic-age-color-input {
                width: 40px;
                height: 28px;
                border: none;
                background: transparent;
                cursor: pointer;
                padding: 0;
            }


            .random-floor-btn:hover, .reveal-users-btn:hover, .read-tab-action-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
                background: rgba(255, 255, 255, 1);
            }

            .random-floor-btn:active, .reveal-users-btn:active, .read-tab-action-btn:active {
                transform: translateY(0);
            }

            .reveal-users-btn:disabled, .read-tab-action-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                transform: none !important;
            }

            /* 阅读标签页按钮防变形（tab=3） */
            .linuxdo-helper-panel.tab-mode .lda-tab-content[data-tab="3"] .main-action-btn,
            .linuxdo-helper-panel.tab-mode .lda-tab-content[data-tab="3"] .read-tab-action-btn {
                width: 100%;
                min-height: 32px;
                height: 32px;
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }

            .linuxdo-helper-panel.tab-mode .lda-tab-content[data-tab="3"] .main-action-btn .btn-text,
            .linuxdo-helper-panel.tab-mode .lda-tab-content[data-tab="3"] .read-tab-action-btn .btn-text {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                min-width: 0;
                flex: 0 1 auto;
                text-align: center;
            }

            .linuxdo-helper-panel.tab-mode .lda-tab-content[data-tab="3"] .main-action-btn .btn-icon,
            .linuxdo-helper-panel.tab-mode .lda-tab-content[data-tab="3"] .read-tab-action-btn .btn-icon {
                flex: 0 0 auto;
                line-height: 1;
            }

            .toggle-row {
                background: rgba(255, 255, 255, 0.15);
                padding: 5px 10px;
                border-radius: 8px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: all 0.2s;
                min-height: 26px;
            }

            .toggle-row:hover {
                background: rgba(255, 255, 255, 0.22);
            }

            .toggle-label {
                color: white;
                font-size: 12px;
                font-weight: 500;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
                flex: 1;
                min-width: 0;
                margin-right: 8px;
            }

            /* 双列开关网格布局 */
            .toggle-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 6px;
                margin-bottom: 6px;
            }

            .toggle-grid .toggle-row {
                padding: 4px 8px;
                min-height: 24px;
                min-width: 0;
                gap: 5px;
                box-sizing: border-box;
            }

            .toggle-grid .toggle-label {
                font-size: 11px;
                line-height: 1.25;
                margin-right: 0;
                overflow-wrap: anywhere;
            }

            .toggle-grid .toggle-switch {
                width: 32px;
                height: 18px;
                flex-shrink: 0;
            }

            .toggle-grid .toggle-slider:before {
                height: 12px;
                width: 12px;
            }

            .toggle-grid .toggle-switch input:checked + .toggle-slider:before {
                transform: translateX(14px);
            }

            .toggle-switch {
                position: relative;
                width: 36px;
                height: 20px;
                flex-shrink: 0;
            }

            .toggle-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }

            .toggle-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: rgba(255, 255, 255, 0.3);
                transition: 0.3s;
                border-radius: 26px;
            }

            .toggle-slider:before {
                position: absolute;
                content: "";
                height: 14px;
                width: 14px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: 0.3s;
                border-radius: 50%;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            }

            .toggle-switch input:checked + .toggle-slider {
                background-color: rgba(76, 175, 80, 0.8);
            }

            .toggle-switch input:checked + .toggle-slider:before {
                transform: translateX(16px);
            }

            .section-divider {
                height: 1px;
                background: rgba(255, 255, 255, 0.2);
                margin: 6px 0;
            }

            .section-title {
                color: rgba(255, 255, 255, 0.9);
                font-size: 12px;
                font-weight: 600;
                margin: 4px 0 4px 0;
                padding: 0 4px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            @keyframes fadeIn {
                from {
                    opacity: 0;
                    transform: scale(0.8);
                }
                to {
                    opacity: 1;
                    transform: scale(1);
                }
            }

            .linuxdo-helper-panel {
                animation: fadeIn 0.3s ease-out;
            }
        `;
        document.head.appendChild(style);
    }

    setupButton() {
        this.addGlobalStyles();

        // 创建主容器
        this.container = document.createElement("div");
        this.container.className = "linuxdo-helper-panel";
        if (this.panelMinimized) {
            this.container.classList.add('minimized');
        }

        // 如果有保存的位置，使用保存的位置；否则默认右上角
        if (this.panelPosition.x !== null && this.panelPosition.y !== null) {
            this.applyPanelPosition(this.panelPosition.x, this.panelPosition.y);
        } else {
            // 默认位置：右上角
            const defaultX = window.innerWidth - 300; // 280px 宽度 + 20px 边距
            const defaultY = 70;
            this.applyPanelPosition(defaultX, defaultY);
        }

        // 创建最小化图标 - 使用简洁的文字标识
        const minimizedIcon = document.createElement("div");
        minimizedIcon.className = "minimized-icon";
        minimizedIcon.textContent = this.t('minimizedText');
        minimizedIcon.title = this.t('expandPanel');

        // 创建面板头部
        const header = document.createElement("div");
        header.className = "panel-header";
        // 根据当前布局模式显示不同的图标：标签页模式显示 ≡（切换到折叠），折叠模式显示 ⫼（切换到标签页）
        const layoutIcon = this.tabMode ? '≡' : '⫼';
        const layoutTitle = this.tabMode ? this.t('switchToCollapse') : this.t('switchToTab');
        header.innerHTML = `
            <span class="panel-title">${this.t('panelTitle')}</span>
            <div class="panel-controls">
                <button class="panel-control-btn layout-toggle-btn" title="${layoutTitle}">${layoutIcon}</button>
                <button class="panel-control-btn minimize-btn" title="${this.t('minimize')}">─</button>
            </div>
        `;

        // 创建面板内容区
        const content = document.createElement("div");
        content.className = "panel-content";
        if (this.panelMinimized) {
            content.classList.add('hidden');
        }

        // 应用标签页布局模式
        if (this.tabMode) {
            this.container.classList.add('tab-mode');
        }

        // 主按钮
        this.button = document.createElement("button");
        this.button.className = "main-action-btn" + (this.autoRunning ? " running" : "");
        this.button.innerHTML = this.autoRunning
            ? `<span class="btn-icon">⏸</span><span class="btn-text">${this.t('stopReading')}</span>`
            : `<span class="btn-icon">▶</span><span class="btn-text">${this.t('startReading')}</span>`;
        this.button.addEventListener("click", () => this.handleButtonClick());

        // 阅读统计显示区域（始终显示在按钮下方）
        this.readStatsContainer = document.createElement("div");
        this.readStatsContainer.className = "read-stats-container";
        this.readStatsContainer.style.cssText = `
            display: flex;
            justify-content: space-around;
            align-items: center;
            background: rgba(255, 255, 255, 0.1);
            padding: 6px 10px;
            border-radius: 8px;
            margin-top: 6px;
        `;
        this.updateReadStatsDisplay();

        // 点赞计数显示区域
        this.likeCounterContainer = document.createElement("div");
        this.likeCounterContainer.className = "like-counter-container";
        this.likeCounterContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            background: rgba(255, 255, 255, 0.1);
            padding: 8px 12px;
            border-radius: 8px;
            margin-top: 6px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            font-size: 12px;
            color: #e0e0e0;
        `;
        this.likeCounterContainer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <span class="like-counter-label">❤️ ${this.t('likeRemaining')}</span>
                <span class="like-counter-value" style="font-weight: 600;">-- / --</span>
            </div>
        `;
        // 点击同步（手动触发，忽略30分钟间隔限制）
        this.likeCounterContainer.style.cursor = 'pointer';
        this.likeCounterContainer.title = this.t('likeCountMismatch');
        this.likeCounterContainer.addEventListener('click', () => {
            if (this.likeCounter) {
                this.showNotification(this.t('likeSyncing'));
                this.likeCounter.manualSync().then(() => {
                    this.showNotification(this.t('likeSyncSuccess'));
                });
            }
        });

        this.autoLikeStatusContainer = document.createElement('div');
        this.autoLikeStatusContainer.className = 'auto-like-status-container';
        this.autoLikeStatusContainer.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 6px 9px;
            border-radius: 7px;
            background: rgba(255, 255, 255, 0.1);
            font-size: 10px;
        `;
        this.updateAutoLikeStatus(this.autoLikeStatusKey, this.autoLikeStatusDetail || '');

        // 随机楼层按钮
        this.randomBtn = document.createElement("button");
        this.randomBtn.className = "random-floor-btn";
        this.randomBtn.innerHTML = `<span class="btn-icon">🎲</span><span class="btn-text">${this.t('randomFloor')}</span>`;
        this.randomBtn.addEventListener("click", () => this.randomJump());
        this.randomBtn.style.display = this.isTopicPage ? 'flex' : 'none';
        this.randomBtn.title = this.t('randomFloorTip');

        // 批量展示用户信息按钮
        this.revealUsersBtn = document.createElement("button");
        this.revealUsersBtn.className = "reveal-users-btn";
        this.revealUsersBtn.innerHTML = `<span class="btn-icon">📊</span><span class="btn-text">${this.t('batchShowInfo')}</span>`;
        this.revealUsersBtn.addEventListener("click", () => this.handleRevealUsersClick());
        this.revealUsersBtn.style.display = this.isTopicPage ? 'flex' : 'none';
        this.revealUsersBtn.title = this.t('batchShowInfoTip');

        // 自动点赞开关
        const autoLikeRow = this.createToggleRow(
            this.t('autoLikeTopic'),
            this.autoLikeEnabled,
            (checked) => {
                // 检查是否在冷却期
                if (checked && this.likeResumeTime && Date.now() < this.likeResumeTime) {
                    const now = Date.now();
                    const remainingMinutes = Math.ceil((this.likeResumeTime - now) / 60000);
                    const resumeDate = new Date(this.likeResumeTime);
                    this.showNotification(`${this.t('likeCoolingDown')}，${resumeDate.toLocaleTimeString()}`);
                    console.log(`点赞冷却中，还需约 ${remainingMinutes} 分钟，无法开启`);

                    this.setAutoLikeEnabled(false);
                    this.updateAutoLikeStatus('autoLikeCooling');
                    return;
                }

                this.setAutoLikeEnabled(checked);
                console.log(`自动点赞主题: ${this.autoLikeEnabled ? '开启' : '关闭'}`);
            }
        );

        // 创建点赞过滤设置的工厂函数（因为两种布局模式需要独立的DOM元素）
        const createLikeFilterControls = () => {
            // 点赞过滤模式选择
            const modeRow = this.createSelectRow(
                this.t('likeFilterMode'),
                [
                    { value: 'off', label: this.t('likeFilterOff') },
                    { value: 'threshold', label: this.t('likeFilterThreshold') },
                    { value: 'probability', label: this.t('likeFilterProbability') }
                ],
                this.likeFilterMode,
                (value) => {
                    this.likeFilterMode = value;
                    Storage.set('likeFilterMode', this.likeFilterMode);
                    this.autoLikeDecisionCache.clear();
                    console.log(`点赞过滤模式: ${this.likeFilterMode}`);
                    // 更新所有阈值行的显示状态
                    document.querySelectorAll('.like-min-threshold-row').forEach(row => {
                        row.style.display = value === 'threshold' ? 'flex' : 'none';
                    });
                    modeRow.style.gridColumn = value === 'threshold' ? 'auto' : '1 / -1';
                }
            );
            modeRow.title = this.t('likeFilterModeTip');
            modeRow.classList.add('like-filter-mode-row');

            // 最低赞数阈值设置
            const thresholdRow = this.createSelectRow(
                this.t('likeMinThreshold'),
                Array.from({ length: 20 }, (_, index) => ({ value: index + 1, label: String(index + 1) })),
                this.likeMinThreshold,
                (value) => {
                    const selectedValue = Math.min(20, Math.max(1, Math.round(Number(value) || 5)));
                    this.likeMinThreshold = selectedValue;
                    Storage.set('likeMinThreshold', this.likeMinThreshold);
                    this.autoLikeDecisionCache.clear();
                    console.log(`最低赞数阈值: ${this.likeMinThreshold}`);
                }
            );
            thresholdRow.title = this.t('likeMinThresholdTip');
            thresholdRow.classList.add('like-min-threshold-row');
            // 根据过滤模式决定是否显示阈值设置
            modeRow.style.gridColumn = this.likeFilterMode === 'threshold' ? 'auto' : '1 / -1';
            thresholdRow.style.display = this.likeFilterMode === 'threshold' ? 'flex' : 'none';

            return { modeRow, thresholdRow };
        };

        // 为标签页模式创建点赞过滤控件
        const likeFilterControls1 = createLikeFilterControls();
        const likeFilterModeRow = likeFilterControls1.modeRow;
        const likeMinThresholdRow = likeFilterControls1.thresholdRow;

        // 为折叠布局模式创建点赞过滤控件
        const likeFilterControls2 = createLikeFilterControls();
        const likeFilterModeRow2 = likeFilterControls2.modeRow;
        const likeMinThresholdRow2 = likeFilterControls2.thresholdRow;

        // 随机顺序阅读开关
        const randomOrderRow = this.createToggleRow(
            this.t('randomOrder'),
            this.randomOrderEnabled,
            (checked) => {
                this.randomOrderEnabled = checked;
                Storage.set('randomOrderEnabled', this.randomOrderEnabled);
                console.log(`随机顺序阅读: ${this.randomOrderEnabled ? '开启' : '关闭'}`);

                // 切换模式时清空话题列表，强制重新获取
                this.topicList = [];
                this.setSessionStorage('topicList', []);
            }
        );
        randomOrderRow.title = this.t('randomOrderTip');

        const fullTopicReadRow = this.createToggleRow(
            this.t('fullTopicRead'),
            this.fullTopicReadEnabled,
            (checked) => {
                this.fullTopicReadEnabled = checked;
                Storage.set('fullTopicReadEnabled', this.fullTopicReadEnabled);
                console.log(`完整阅读帖子: ${this.fullTopicReadEnabled ? '开启' : '关闭'}`);
            }
        );
        fullTopicReadRow.title = this.t('fullTopicReadTip');

        const skipLargeReplyTopicsRow = this.createToggleRow(
            this.t('skipLargeReplyTopics'),
            this.skipLargeReplyTopicsEnabled,
            (checked) => {
                this.skipLargeReplyTopicsEnabled = checked;
                Storage.set('skipLargeReplyTopicsEnabled', checked);
                console.log(`跳过 >200 回复帖子: ${checked ? '开启' : '关闭'}`);
                if (this.autoRunning && /^\/(?:latest)?\/?$/.test(window.location.pathname)) {
                    this.setRemainingHomeUnreadCount(this.getHomeUnreadTopicCandidates().length);
                }
            }
        );
        skipLargeReplyTopicsRow.title = this.t('skipLargeReplyTopicsTip');

        // 阅读速度滑块
        const readSpeedIndex = READ_SPEED_VALUES.reduce((closestIndex, speed, index) =>
            Math.abs(speed - this.readSpeedMultiplier) < Math.abs(READ_SPEED_VALUES[closestIndex] - this.readSpeedMultiplier)
                ? index
                : closestIndex
        , 0);
        const readSpeedRow = this.createSliderRow(
            this.t('readSpeedLabel'),
            readSpeedIndex,
            0, READ_SPEED_VALUES.length - 1, 1,
            (index) => {
                const value = READ_SPEED_VALUES[index];
                this.readSpeedMultiplier = value;
                Storage.set('readSpeedMultiplier', value);
                console.log(`阅读速度: ${value} 倍`);
            },
            (index) => READ_SPEED_VALUES[index]
        );
        readSpeedRow.title = this.t('readSpeedTip');

        // 阅读数量限制开关
        const stopAfterReadRow = this.createToggleRow(
            this.t('stopAfterRead'),
            this.stopAfterReadEnabled,
            (checked) => {
                this.stopAfterReadEnabled = checked;
                Storage.set('stopAfterReadEnabled', this.stopAfterReadEnabled);
                console.log(`阅读数量限制: ${this.stopAfterReadEnabled ? '开启' : '关闭'}`);

                this.updateReadStatsDisplay();
                if (this.autoRunning) this.updateReadingStatus();
            }
        );
        stopAfterReadRow.title = this.t('stopAfterReadTip');

        // 阅读数量滑块
                const stopAfterReadCountRow = this.createSliderRow(
            this.t('stopAfterReadCount'),
            this.stopAfterReadCount,
            5, 200, 1,
            (value) => {
                this.stopAfterReadCount = value;
                Storage.set('stopAfterReadCount', this.stopAfterReadCount);
                console.log(`阅读数量限制: ${this.stopAfterReadCount} 篇`);
                this.updateReadStatsDisplay();
                if (this.autoRunning) this.updateReadingStatus();
            }
        );
        stopAfterReadCountRow.title = this.t('stopAfterReadCountTip');


        // 点赞上限停止阅读开关
        const stopOnLikeLimitRow = this.createToggleRow(
            this.t('stopOnLikeLimit'),
            this.stopOnLikeLimitEnabled,
            (checked) => {
                this.stopOnLikeLimitEnabled = checked;
                Storage.set('stopOnLikeLimitEnabled', this.stopOnLikeLimitEnabled);
                console.log(`点赞上限停止阅读: ${this.stopOnLikeLimitEnabled ? '开启' : '关闭'}`);
            }
        );
        stopOnLikeLimitRow.title = this.t('stopOnLikeLimitTip');

        // 清除点赞冷却按钮
        this.clearCooldownBtn = document.createElement("button");
        this.clearCooldownBtn.className = "reveal-users-btn read-tab-action-btn";
        this.clearCooldownBtn.innerHTML = `<span class="btn-icon">🔥</span><span class="btn-text">${this.t('clearCooldown')}</span>`;
        this.clearCooldownBtn.addEventListener("click", () => this.handleClearCooldown());
        this.clearCooldownBtn.title = this.t('clearCooldownTip');
        this.clearCooldownBtn.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
        this.clearCooldownBtn.style.display = 'none'; // 默认隐藏

        // 按钮创建后立即更新冷却显示状态
        setTimeout(() => this.updateClearCooldownButton(), 0);

        // 信任等级显示容器
        this.trustLevelContainer = document.createElement("div");
        this.trustLevelContainer.className = "trust-level-row";
        // 信任等级显示容器
        this.trustLevelContainer.innerHTML = `<div class="trust-level-loading">${this.t('loadingLevel')}</div>`;

        // 组装面板 - 根据布局模式选择不同的组装方式
        if (this.tabMode) {
            // ========== 标签页切换布局模式 ==========
            // 创建标签页容器（包含导航和内容）
            this.tabContainer = document.createElement("div");
            this.tabContainer.className = "tab-container";
            if (this.panelMinimized) {
                this.tabContainer.classList.add('hidden');
            }

            // 标签页配置
            this.tabConfig = {
                1: { icon: '📊', name: '账号' },
                3: { icon: '📖', name: '阅读' },
                6: { icon: '🔧', name: '设置' }
            };

            // 创建标签页导航栏
            const tabNav = document.createElement("div");
            tabNav.className = "tab-nav";
            tabNav.setAttribute('role', 'tablist');

            // 按照保存的顺序创建标签按钮
            this.tabButtons = {};
            [1, 3, 6].forEach(tabId => {
                const tabBtn = this.createTabButton(tabId);
                if (!tabBtn) return;
                tabNav.appendChild(tabBtn);
                this.tabButtons[tabId] = tabBtn;
            });

            this.tabContainer.appendChild(tabNav);
            this.tabNav = tabNav;

            // ========== 标签页1内容：账号信息 ==========
            const tab1Content = document.createElement("div");
            tab1Content.className = "lda-tab-content" + (this.activeTab === 1 ? " active" : "");
            tab1Content.setAttribute("data-tab", "1");
            tab1Content.innerHTML = `<div class="lda-tab-content-title">${this.t('sectionAccountInfo')}</div>`;
            tab1Content.appendChild(this.trustLevelContainer);
            this.tabContainer.appendChild(tab1Content);

            // ========== 标签页3内容：自动阅读 ==========
            const tab3Content = document.createElement("div");
            tab3Content.className = "lda-tab-content" + (this.activeTab === 3 ? " active" : "");
            tab3Content.setAttribute("data-tab", "3");
            tab3Content.innerHTML = `<div class="lda-tab-content-title">${this.t('sectionAutoRead')}</div>`;
            tab3Content.appendChild(this.button);
            tab3Content.appendChild(this.readStatsContainer);
            tab3Content.appendChild(this.likeCounterContainer);
            tab3Content.appendChild(this.autoLikeStatusContainer);
            tab3Content.appendChild(this.clearCooldownBtn);

            // 双列开关网格 - 所有开关合并到一个grid
            const toggleGrid = document.createElement("div");
            toggleGrid.className = "toggle-grid";
            toggleGrid.appendChild(autoLikeRow);
            toggleGrid.appendChild(randomOrderRow);
            toggleGrid.appendChild(fullTopicReadRow);
            toggleGrid.appendChild(skipLargeReplyTopicsRow);
            toggleGrid.appendChild(stopAfterReadRow);
            toggleGrid.appendChild(stopOnLikeLimitRow);
            tab3Content.appendChild(toggleGrid);

            // 滑块和选择器保持单列
            tab3Content.appendChild(likeFilterModeRow);
            tab3Content.appendChild(likeMinThresholdRow);
            tab3Content.appendChild(readSpeedRow);
            tab3Content.appendChild(stopAfterReadCountRow);

            const tabLikeSettings = document.createElement('div');
            tabLikeSettings.className = 'like-settings-card';
            tabLikeSettings.innerHTML = `<div class="like-settings-title">${this.t('likeSettings')}</div>`;
            const tabLikeOverview = document.createElement('div');
            tabLikeOverview.className = 'like-settings-overview';
            tabLikeOverview.appendChild(this.autoLikeStatusContainer);
            tabLikeOverview.appendChild(this.likeCounterContainer);
            const tabLikeToggles = document.createElement('div');
            tabLikeToggles.className = 'like-settings-toggle-grid';
            tabLikeToggles.appendChild(autoLikeRow);
            tabLikeToggles.appendChild(stopOnLikeLimitRow);
            tabLikeSettings.appendChild(tabLikeToggles);
            tabLikeSettings.appendChild(tabLikeOverview);
            const tabLikeFilters = document.createElement('div');
            tabLikeFilters.className = 'like-settings-filter-grid';
            tabLikeFilters.appendChild(likeFilterModeRow);
            tabLikeFilters.appendChild(likeMinThresholdRow);
            tabLikeSettings.appendChild(tabLikeFilters);
            tabLikeSettings.appendChild(this.clearCooldownBtn);
            tab3Content.appendChild(tabLikeSettings);

            // 帖子获取状态显示区域（标签页模式）
            this.topicStatusContainer = document.createElement("div");
            this.topicStatusContainer.className = "topic-status-container";
            this.topicStatusContainer.style.cssText = `
                display: none;
                background: rgba(255, 255, 255, 0.15);
                padding: 8px 10px;
                border-radius: 8px;
                margin-top: 6px;
            `;
            tab3Content.appendChild(this.topicStatusContainer);

            this.tabContainer.appendChild(tab3Content);

            // ========== 标签页6内容：设置 ==========
            const tab6Content = document.createElement("div");
            tab6Content.className = "lda-tab-content" + (this.activeTab === 6 ? " active" : "");
            tab6Content.setAttribute("data-tab", "6");
            tab6Content.innerHTML = `<div class="lda-tab-content-title">${this.t('sectionPluginSettings')}</div>`;

            // 文章页功能（仅在文章页显示）
            if (this.isTopicPage) {
                const toolSubSection = document.createElement("div");
                toolSubSection.className = "tab-sub-section";
                toolSubSection.innerHTML = `<div class="tab-sub-title">${this.t('sectionArticleTools')}</div>`;
                toolSubSection.appendChild(this.randomBtn);
                toolSubSection.appendChild(this.revealUsersBtn);
                tab6Content.appendChild(toolSubSection);
            }

            // 主题配色选择器
            const themeSection = document.createElement("div");
            themeSection.className = "tab-sub-section";
            themeSection.innerHTML = `<div class="tab-sub-title">${this.t('themeColorLabel')}</div>`;
            themeSection.appendChild(this.createThemeSelector());
            const themeInnerTitle = themeSection.querySelector('.tab-sub-title');
            if (themeInnerTitle) themeInnerTitle.remove();
            const themeCollapsible = this.createInnerCollapsibleSection(this.t('themeColorLabel'), themeSection, true, 'tab_theme');
            tab6Content.appendChild(themeCollapsible);

            const topicAgeSection = this.createTopicAgeColorSettings();
            const topicAgeCollapsible = this.createInnerCollapsibleSection(this.t('topicCreatedTimeLabel'), topicAgeSection, true, 'tab_topic_age');
            tab6Content.appendChild(topicAgeCollapsible);

            // CloudFlare 5秒盾设置区域（仅 linux.do 显示）
            if (CURRENT_DOMAIN === 'linux.do') {
                const cfBypassSection = document.createElement("div");
                cfBypassSection.className = "tab-sub-section";
                cfBypassSection.innerHTML = `<div class="tab-sub-title">${this.t('cfBypassLabel')}</div>`;

                // CF bypass 开关
                const cfBypassRow = this.createToggleRow(
                    this.t('cfBypassTip'),
                    this.cfBypassEnabled,
                    (checked) => {
                        this.cfBypassEnabled = checked;
                        Storage.set('cfBypassEnabled', this.cfBypassEnabled);
                        this.showNotification(checked ? this.t('cfBypassEnabled') : this.t('cfBypassDisabled'));
                        // 如果启用，立即初始化
                        if (checked) {
                            this.initCloudFlareBypass();
                        }
                    }
                );
                cfBypassSection.appendChild(cfBypassRow);

                // 手动触发按钮
                const manualCfBtn = document.createElement("button");
                manualCfBtn.className = "reveal-users-btn";
                manualCfBtn.style.cssText = 'margin-top: 8px;';
                manualCfBtn.innerHTML = `🛡️ ${this.t('cfBypassManual')}`;
                manualCfBtn.title = this.t('cfBypassManualTip');
                manualCfBtn.addEventListener('click', () => this.manualTriggerCF());
                cfBypassSection.appendChild(manualCfBtn);

                const cfInnerTitle = cfBypassSection.querySelector('.tab-sub-title');
                if (cfInnerTitle) cfInnerTitle.remove();
                const cfCollapsible = this.createInnerCollapsibleSection(this.t('cfBypassLabel'), cfBypassSection, true, 'tab_cf');
                tab6Content.appendChild(cfCollapsible);
            }



            this.tabContainer.appendChild(tab6Content);
            this.tab6Content = tab6Content;

            // 保存标签页内容引用
            this.tab1Content = tab1Content;
            this.tab3Content = tab3Content;
        } else {
            // ========== 单列折叠布局模式（默认） ==========
            // 📖 自动阅读区（包含阅读按钮和相关设置）
            const autoSection = document.createElement("div");
            autoSection.className = "section-collapsible";
            autoSection.innerHTML = `<div class="section-title"><span class="collapse-icon">▼</span> ${this.t('sectionAutoRead')}</div>`;
            content.appendChild(autoSection);

            // 自动阅读内容区
            this.autoSectionContent = document.createElement("div");
            this.autoSectionContent.className = "section-collapsible-content";
            // 根据运行状态决定初始折叠状态：停止时折叠，运行时展开
            if (!this.autoRunning) {
                autoSection.classList.add('collapsed');
                this.autoSectionContent.classList.add('collapsed');
            }

            this.autoSectionContent.appendChild(this.button);
            this.autoSectionContent.appendChild(this.readStatsContainer);
            this.autoSectionContent.appendChild(this.likeCounterContainer);
            this.autoSectionContent.appendChild(this.autoLikeStatusContainer);
            this.autoSectionContent.appendChild(this.clearCooldownBtn);

            // 双列开关网格 - 所有开关合并到一个grid
            const collapseToggleGrid = document.createElement("div");
            collapseToggleGrid.className = "toggle-grid";
            collapseToggleGrid.appendChild(autoLikeRow);
            collapseToggleGrid.appendChild(randomOrderRow);
            collapseToggleGrid.appendChild(fullTopicReadRow);
            collapseToggleGrid.appendChild(skipLargeReplyTopicsRow);
            collapseToggleGrid.appendChild(stopAfterReadRow);
            collapseToggleGrid.appendChild(stopOnLikeLimitRow);
            this.autoSectionContent.appendChild(collapseToggleGrid);

            // 滑块和选择器保持单列
            this.autoSectionContent.appendChild(likeFilterModeRow2);
            this.autoSectionContent.appendChild(likeMinThresholdRow2);
            this.autoSectionContent.appendChild(readSpeedRow);
            this.autoSectionContent.appendChild(stopAfterReadCountRow);

            const collapseLikeSettings = document.createElement('div');
            collapseLikeSettings.className = 'like-settings-card';
            collapseLikeSettings.innerHTML = `<div class="like-settings-title">${this.t('likeSettings')}</div>`;
            const collapseLikeOverview = document.createElement('div');
            collapseLikeOverview.className = 'like-settings-overview';
            collapseLikeOverview.appendChild(this.autoLikeStatusContainer);
            collapseLikeOverview.appendChild(this.likeCounterContainer);
            const collapseLikeToggles = document.createElement('div');
            collapseLikeToggles.className = 'like-settings-toggle-grid';
            collapseLikeToggles.appendChild(autoLikeRow);
            collapseLikeToggles.appendChild(stopOnLikeLimitRow);
            collapseLikeSettings.appendChild(collapseLikeToggles);
            collapseLikeSettings.appendChild(collapseLikeOverview);
            const collapseLikeFilters = document.createElement('div');
            collapseLikeFilters.className = 'like-settings-filter-grid';
            collapseLikeFilters.appendChild(likeFilterModeRow2);
            collapseLikeFilters.appendChild(likeMinThresholdRow2);
            collapseLikeSettings.appendChild(collapseLikeFilters);
            collapseLikeSettings.appendChild(this.clearCooldownBtn);
            this.autoSectionContent.appendChild(collapseLikeSettings);

            // 帖子获取状态显示区域
            this.topicStatusContainer = document.createElement("div");
            this.topicStatusContainer.className = "topic-status-container";
            this.topicStatusContainer.style.cssText = `
                display: none;
                background: rgba(255, 255, 255, 0.15);
                padding: 8px 10px;
                border-radius: 8px;
                margin-top: 6px;
            `;
            this.autoSectionContent.appendChild(this.topicStatusContainer);

            content.appendChild(this.autoSectionContent);

            // 自动阅读区折叠点击事件
            autoSection.addEventListener('click', () => {
                autoSection.classList.toggle('collapsed');
                this.autoSectionContent.classList.toggle('collapsed');
            });

            // 分隔线1
            this.divider1 = document.createElement("div");
            this.divider1.className = "section-divider";
            content.appendChild(this.divider1);

            // 📊 账号信息区
            this.accountSection = document.createElement("div");
            this.accountSection.className = "section-collapsible";
            // 如果正在自动阅读，默认折叠账号信息区
            if (this.autoRunning) {
                this.accountSection.classList.add('collapsed');
            }
            this.accountSection.innerHTML = `<div class="section-title"><span class="collapse-icon">▼</span> ${this.t('sectionAccountInfo')}</div>`;
            content.appendChild(this.accountSection);

            // 账号信息内容区（根据自动阅读状态决定是否折叠）
            this.accountSectionContent = document.createElement("div");
            this.accountSectionContent.className = "section-collapsible-content";
            if (this.autoRunning) {
                this.accountSectionContent.classList.add('collapsed');
            }
            this.accountSectionContent.appendChild(this.trustLevelContainer);
            content.appendChild(this.accountSectionContent);

            // 账号信息区折叠点击事件
            this.accountSection.addEventListener('click', () => {
                this.accountSection.classList.toggle('collapsed');
                this.accountSectionContent.classList.toggle('collapsed');
                // 展开时加载数据
                if (!this.accountSection.classList.contains('collapsed')) {
                    this.loadUserTrustLevel();
                }
            });

            // 🔧 插件设置区（默认折叠）
            // 分隔线6
            this.divider6 = document.createElement("div");
            this.divider6.className = "section-divider";
            content.appendChild(this.divider6);

            const settingsPluginSection = document.createElement("div");
            settingsPluginSection.className = "section-collapsible collapsed";
            settingsPluginSection.innerHTML = `<div class="section-title"><span class="collapse-icon">▼</span> ${this.t('sectionPluginSettings')}</div>`;
            content.appendChild(settingsPluginSection);

            // 插件设置内容区（默认折叠）
            this.settingsPluginSectionContent = document.createElement("div");
            this.settingsPluginSectionContent.className = "section-collapsible-content collapsed";

            // 文章页功能子区域（始终添加，通过 CSS 控制显示/隐藏）
            const toolSubSection = document.createElement("div");
            toolSubSection.className = "tool-sub-section";
            toolSubSection.style.cssText = 'margin-bottom: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15);';
            toolSubSection.innerHTML = `<div style="font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 6px;">${this.t('sectionArticleTools')}</div>`;
            toolSubSection.appendChild(this.randomBtn);
            toolSubSection.appendChild(this.revealUsersBtn);
            // 初始化时根据页面类型设置显示状态
            toolSubSection.style.display = this.isTopicPage ? 'block' : 'none';
            this.toolSubSection = toolSubSection; // 保存引用以便后续更新
            this.settingsPluginSectionContent.appendChild(toolSubSection);

            // 主题配色选择器（折叠模式）
            const collapseThemeSection = document.createElement("div");
            collapseThemeSection.style.cssText = 'margin-bottom: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15);';
            collapseThemeSection.innerHTML = `<div style="font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 6px;">${this.t('themeColorLabel')}</div>`;
            collapseThemeSection.appendChild(this.createThemeSelector());
            const collapseThemeTitle = collapseThemeSection.querySelector('div');
            if (collapseThemeTitle) collapseThemeTitle.remove();
            const collapseThemeWrapper = this.createInnerCollapsibleSection(this.t('themeColorLabel'), collapseThemeSection, true, 'collapse_theme');
            this.settingsPluginSectionContent.appendChild(collapseThemeWrapper);

            const collapseTopicAgeSection = this.createTopicAgeColorSettings();
            const collapseTopicAgeWrapper = this.createInnerCollapsibleSection(this.t('topicCreatedTimeLabel'), collapseTopicAgeSection, true, 'collapse_topic_age');
            this.settingsPluginSectionContent.appendChild(collapseTopicAgeWrapper);

            // CloudFlare 5秒盾设置区域（折叠模式，仅 linux.do 显示）
            if (CURRENT_DOMAIN === 'linux.do') {
                const collapseCfBypassSection = document.createElement("div");
                collapseCfBypassSection.style.cssText = 'margin-bottom: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15);';
                collapseCfBypassSection.innerHTML = `<div style="font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 6px;">${this.t('cfBypassLabel')}</div>`;

                // CF bypass 开关
                const cfBypassRow2 = this.createToggleRow(
                    this.t('cfBypassTip'),
                    this.cfBypassEnabled,
                    (checked) => {
                        this.cfBypassEnabled = checked;
                        Storage.set('cfBypassEnabled', this.cfBypassEnabled);
                        this.showNotification(checked ? this.t('cfBypassEnabled') : this.t('cfBypassDisabled'));
                        // 如果启用，立即初始化
                        if (checked) {
                            this.initCloudFlareBypass();
                        }
                    }
                );
                collapseCfBypassSection.appendChild(cfBypassRow2);

                // 手动触发按钮（折叠模式）
                const manualCfBtn2 = document.createElement("button");
                manualCfBtn2.className = "reveal-users-btn";
                manualCfBtn2.style.cssText = 'margin-top: 8px;';
                manualCfBtn2.innerHTML = `🛡️ ${this.t('cfBypassManual')}`;
                manualCfBtn2.title = this.t('cfBypassManualTip');
                manualCfBtn2.addEventListener('click', () => this.manualTriggerCF());
                collapseCfBypassSection.appendChild(manualCfBtn2);

                const collapseCfTitle = collapseCfBypassSection.querySelector('div');
                if (collapseCfTitle) collapseCfTitle.remove();
                const collapseCfWrapper = this.createInnerCollapsibleSection(this.t('cfBypassLabel'), collapseCfBypassSection, true, 'collapse_cf');
                this.settingsPluginSectionContent.appendChild(collapseCfWrapper);
            }



            // 布局切换说明
            const layoutSection = document.createElement("div");
            layoutSection.style.cssText = 'margin-top: 8px;';
            layoutSection.innerHTML = `
                <div style="font-size: 11px; color: rgba(255,255,255,0.7); padding: 8px; background: rgba(255,255,255,0.1); border-radius: 6px;">
                    ${this.t('layoutSwitchTip')}
                </div>
            `;
            this.settingsPluginSectionContent.appendChild(layoutSection);

            content.appendChild(this.settingsPluginSectionContent);

            // 插件设置区折叠点击事件
            settingsPluginSection.addEventListener('click', () => {
                settingsPluginSection.classList.toggle('collapsed');
                this.settingsPluginSectionContent.classList.toggle('collapsed');
            });
        }

        this.container.appendChild(minimizedIcon);
        this.container.appendChild(header);
        // 根据布局模式添加不同的内容容器
        if (this.tabMode) {
            this.tabContainer.querySelectorAll('.lda-tab-content').forEach(panel => {
                panel.setAttribute('role', 'tabpanel');
                panel.setAttribute('aria-hidden', String(!panel.classList.contains('active')));
            });
            this.container.appendChild(this.tabContainer);
        } else {
            this.container.appendChild(content);
        }
        document.body.appendChild(this.container);
        this.applyThemeColor();

        // 添加拖动功能（只在展开状态可拖动）
        this.makeDraggable(header);

        // 添加布局切换功能
        header.querySelector('.layout-toggle-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLayout();
        });

        // 添加最小化功能
        header.querySelector('.minimize-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMinimize();
        });

        // 点击最小化图标展开
        minimizedIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.panelMinimized) {
                this.toggleMinimize();
            }
        });

        // 点击最小化的面板也可以展开
        this.container.addEventListener('click', (e) => {
            if (this.panelMinimized && e.target === this.container) {
                this.toggleMinimize();
            }
        });

        // 给最小化面板添加拖动功能
        this.makeMinimizedDraggable();
    }

    createToggleRow(label, checked, onChange) {
        const row = document.createElement("div");
        row.className = "toggle-row";

        const labelEl = document.createElement("span");
        labelEl.className = "toggle-label";
        labelEl.textContent = label;

        const toggleSwitch = document.createElement("label");
        toggleSwitch.className = "toggle-switch";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.addEventListener("change", (e) => {
            onChange(e.target.checked);
        });

        const slider = document.createElement("span");
        slider.className = "toggle-slider";

        toggleSwitch.appendChild(input);
        toggleSwitch.appendChild(slider);

        row.appendChild(labelEl);
        row.appendChild(toggleSwitch);

        return row;
    }

    formatTopicCreatedTime(dateInput) {
        if (!dateInput) return '';
        const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
        if (Number.isNaN(date.getTime())) return '';

        const pad = (num) => String(num).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

                                getTopicAgeLevel(dateInput) {
        if (!dateInput) return 'fresh1';
        const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
        if (Number.isNaN(date.getTime())) return 'fresh1';

        const ageMs = Math.max(0, Date.now() - date.getTime());
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays >= 90) return 'ancient';
        if (ageDays >= 10) return 'old';

        const beijingDateKey = (value) => {
            const formatter = new Intl.DateTimeFormat('sv-SE', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });
            return formatter.format(value);
        };

        if (ageMs < 24 * 60 * 60 * 1000) {
            return beijingDateKey(date) === beijingDateKey(new Date()) ? 'fresh1' : 'fresh0';
        }
        if (ageDays <= 2) return 'fresh2';
        if (ageDays <= 3) return 'fresh3';
        return 'fresh5';
    }

        getTopicAgeBadge(dateInput, compact = false) {
        if (!dateInput) return { text: '1天', days: 1 };
        const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
        if (Number.isNaN(date.getTime())) return { text: '1天', days: 1 };

        const ageMs = Math.max(0, Date.now() - date.getTime());
        const ageDaysRaw = ageMs / (1000 * 60 * 60 * 24);
        const ageDays = Math.max(1, Math.ceil(ageDaysRaw));

        if (ageDays >= 90) {
            return { text: '≥90天', days: ageDays };
        }

        if (ageDays >= 10) {
            return { text: '≥10天', days: ageDays };
        }

                                                if (ageMs < 24 * 60 * 60 * 1000) {
                            const pad = (num) => String(num).padStart(2, '0');
                            const timeText = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
                            return { text: timeText, days: 0 };
                        }



        if (ageDays <= 1) return { text: '1天前', days: ageDays };
        if (ageDays <= 2) return { text: '2天前', days: ageDays };
        if (ageDays <= 3) return { text: '3天前', days: ageDays };
        if (ageDays <= 5) return { text: '5天前', days: ageDays };
        return { text: '≥5天', days: ageDays };
        }

        getTopicHighlightEnhanceConfig() {
        const defaultConfig = {
            onlyUnread: true,
            showNewTag: true,
            newTagDays: 2,
            hotThreshold: 30,
            hotColor: '#722ed1'
        };

        try {
            const raw = localStorage.getItem('topicHighlightConfig');
            if (!raw) return defaultConfig;
            const parsed = JSON.parse(raw) || {};
            return {
                ...defaultConfig,
                ...parsed
            };
        } catch (_) {
            return defaultConfig;
        }
    }

    saveTopicHighlightEnhanceConfig(patch = {}) {
        const next = {
            ...this.getTopicHighlightEnhanceConfig(),
            ...(patch || {})
        };
        localStorage.setItem('topicHighlightConfig', JSON.stringify(next));
        return next;
    }



        applyTopicExtraHighlight(row, createdAt) {
                if (!row) return;

                const clearHotTimers = () => {
                    if (row._ldaHotFadeTimer) {
                        clearTimeout(row._ldaHotFadeTimer);
                        row._ldaHotFadeTimer = null;
                    }
                    if (row._ldaHotClearTimer) {
                        clearTimeout(row._ldaHotClearTimer);
                        row._ldaHotClearTimer = null;
                    }
                };

                row.querySelectorAll('.lda-topic-new-tag').forEach((el) => el.remove());

                if (!createdAt) {
                    clearHotTimers();
                    row.classList.remove('lda-topic-hot', 'lda-topic-hot-fade');
                    row.style.removeProperty('--lda-topic-hot-color');
                    return;
                }

                const cfg = this.getTopicHighlightEnhanceConfig();
                const createdDate = createdAt instanceof Date ? createdAt : new Date(createdAt);
                if (Number.isNaN(createdDate.getTime())) return;


                const isUnread = row.classList.contains('unread') || !!row.querySelector('.badge-notification, .new-posts');
                const ageDays = Math.max(0, (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));

                const titleLink = row.querySelector('a.title, .topic-title a.title, .topic-title a, a.raw-topic-link, .title a');
                if (titleLink) {
                    let newTag = titleLink.querySelector('.lda-topic-new-tag');
                    const shouldShowNewTag = cfg.showNewTag && (!cfg.onlyUnread || isUnread) && ageDays <= Number(cfg.newTagDays || 2);
                    if (shouldShowNewTag) {
                        if (!newTag) {
                            newTag = document.createElement('span');
                            newTag.className = 'lda-topic-new-tag';
                            newTag.textContent = '🔥 NEW';
                            titleLink.appendChild(newTag);
                        }
                    } else if (newTag) {
                        newTag.remove();
                    }
                }

                const postsEl = row.querySelector('td.posts .posts, .posts, .badge-posts');
                const replies = postsEl
                    ? parseInt(String(postsEl.textContent || '').replace(/[^\d]/g, ''), 10) || 0
                    : 0;

                // onlyUnread 开关同样作用于热门描边
                const shouldHot = (!cfg.onlyUnread || isUnread) && replies >= Number(cfg.hotThreshold || 30);
                if (shouldHot) {
                    const wasHot = row.classList.contains('lda-topic-hot');
                    row.style.setProperty('--lda-topic-hot-color', cfg.hotColor || '#722ed1');
                    row.classList.add('lda-topic-hot');

                    if (!wasHot) {
                        row.classList.remove('lda-topic-hot-fade');
                        clearHotTimers();
                        row._ldaHotFadeTimer = setTimeout(() => {
                            row.classList.add('lda-topic-hot-fade');
                        }, 15000);
                        row._ldaHotClearTimer = setTimeout(() => {
                            row.classList.remove('lda-topic-hot', 'lda-topic-hot-fade');
                            row.style.removeProperty('--lda-topic-hot-color');
                            row._ldaHotFadeTimer = null;
                            row._ldaHotClearTimer = null;
                        }, 17500);
                    }
                } else {
                    clearHotTimers();
                    row.classList.remove('lda-topic-hot', 'lda-topic-hot-fade');
                    row.style.removeProperty('--lda-topic-hot-color');
                }
            }





    extractTopicCreatedAtFromRow(row) {
        if (!row) return '';

        const parsePossibleDate = (value) => {
            if (!value) return '';
            const normalized = String(value).trim();
            if (!normalized) return '';

            if (/^\d{13}$/.test(normalized)) {
                const date = new Date(Number(normalized));
                return Number.isNaN(date.getTime()) ? '' : date.toISOString();
            }

            if (/^\d{10}$/.test(normalized)) {
                const date = new Date(Number(normalized) * 1000);
                return Number.isNaN(date.getTime()) ? '' : date.toISOString();
            }

            const date = new Date(normalized);
            return Number.isNaN(date.getTime()) ? '' : normalized;
        };

        const parseChineseDateText = (value) => {
            if (!value) return '';
            const text = String(value).replace(/\s+/g, ' ').trim();
            const match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/);
            if (!match) return '';

            const [, year, month, day, hour, minute] = match;
            const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00`;
            const date = new Date(iso);
            return Number.isNaN(date.getTime()) ? '' : iso;
        };

        const candidates = [
            row.dataset.createdAt,
            row.getAttribute('data-created-at'),
            row.dataset.topicCreatedAt,
            row.getAttribute('data-topic-created-at'),
            row.dataset.bumpedAt,
            row.getAttribute('data-bumped-at')
        ].filter(Boolean);

        for (const value of candidates) {
            const parsed = parsePossibleDate(value);
            if (parsed) return parsed;
        }

        const topicLink = row.querySelector('a.title, .main-link a, a.raw-topic-link');
        if (topicLink) {
            const activityCell = topicLink.closest('tr')?.querySelector('td.activity[title], td.age[title], td.topic-list-data.age[title]');
            if (activityCell) {
                const activityTitle = activityCell.getAttribute('title') || '';
                const createdFromTitle = activityTitle.match(/创建日期[:：]\s*([^\n]+)/);
                if (createdFromTitle?.[1]) {
                    const parsedChinese = parseChineseDateText(createdFromTitle[1]);
                    if (parsedChinese) return parsedChinese;
                    const parsedDirect = parsePossibleDate(createdFromTitle[1]);
                    if (parsedDirect) return parsedDirect;
                }
            }

            const linkCandidates = [
                topicLink.dataset.createdAt,
                topicLink.getAttribute('data-created-at'),
                topicLink.getAttribute('title'),
                topicLink.getAttribute('aria-label')
            ].filter(Boolean);

            for (const value of linkCandidates) {
                const parsed = parsePossibleDate(value);
                if (parsed) return parsed;

                const datetimeMatch = String(value).match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/);
                if (datetimeMatch) {
                    return datetimeMatch[0].replace(' ', 'T');
                }
            }
        }

        const timeEls = row.querySelectorAll('time[datetime]');
        for (const timeEl of timeEls) {
            const dt = parsePossibleDate(timeEl.getAttribute('datetime'));
            if (dt) return dt;
        }

        const activityCell = row.querySelector('td.activity[title], td.age[title], td.topic-list-data.age[title]');
        if (activityCell) {
            const activityTitle = activityCell.getAttribute('title') || '';
            const createdFromTitle = activityTitle.match(/创建日期[:：]\s*([^\n]+)/);
            if (createdFromTitle?.[1]) {
                const parsedChinese = parseChineseDateText(createdFromTitle[1]);
                if (parsedChinese) return parsedChinese;
                const parsedDirect = parsePossibleDate(createdFromTitle[1]);
                if (parsedDirect) return parsedDirect;
            }
        }


        return '';
    }

    renderTopicCreatedTimeInList() {
        const rows = document.querySelectorAll('tr.topic-list-item, tr.latest-topic-list-item');
        rows.forEach((row) => {
            const activityLink = row.querySelector('td.activity a.post-activity, td.age a.post-activity, td.topic-list-data.age a.post-activity');
            const activityCell = activityLink?.closest('td.activity, td.age, td.topic-list-data.age') || row.querySelector('td.activity, td.age, td.topic-list-data.age');
            if (!activityCell) return;

            let meta = activityCell.querySelector('.lda-topic-created-time');
            if (!this.topicCreatedTimeVisible) {
                if (meta) meta.remove();
                return;
            }

            const createdAt = this.extractTopicCreatedAtFromRow(row);
            if (!createdAt) {
                if (meta) meta.remove();
                return;
            }

            const formatted = this.formatTopicCreatedTime(createdAt);
            if (!formatted) {
                if (meta) meta.remove();
                return;
            }

            this.applyTopicExtraHighlight(row, createdAt);

            if (!meta) {
                meta = document.createElement('span');
                meta.className = 'lda-topic-created-time';
                const anchor = activityLink || activityCell.querySelector('a');

                if (anchor) {
                    meta.style.display = 'inline-flex';
                    meta.style.alignItems = 'center';
                    meta.style.marginLeft = '8px';
                    anchor.appendChild(meta);
                } else {
                    meta.style.display = 'inline-flex';
                    meta.style.alignItems = 'center';
                    meta.style.marginLeft = '8px';
                    activityCell.appendChild(meta);
                }
            }

            const compactBadge = window.innerWidth <= 1280;
            const badgeInfo = this.getTopicAgeBadge(createdAt, compactBadge);

            meta.dataset.createdAt = createdAt;
            meta.dataset.ageLevel = this.topicAgeColorEnabled
                ? this.getTopicAgeLevel(createdAt)
                : 'neutral';
            let separator = meta.querySelector('.lda-topic-created-separator');
            let label = meta.querySelector('.lda-topic-created-label');
            if (!separator || !label) {
                separator = document.createElement('span');
                separator.className = 'lda-topic-created-separator';
                separator.textContent = '｜';
                label = document.createElement('span');
                label.className = 'lda-topic-created-label';
                meta.replaceChildren(separator, label);
            }
            label.textContent = badgeInfo.text;
            meta.title = `帖子创建时间：${formatted}（约 ${badgeInfo.days} 天）`;
        });
    }

    initTopicCreatedTimeEnhancer() {
        this.renderTopicCreatedTimeInList();

        if (this._topicCreatedTimeObserver) {
            try { this._topicCreatedTimeObserver.disconnect(); } catch (_) { }
        }

        let timer = null;
        const scheduleRender = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => this.renderTopicCreatedTimeInList(), 200);
        };

        if (!this._topicCreatedTimeResizeBound) {
            this._topicCreatedTimeResizeBound = true;
            window.addEventListener('resize', scheduleRender, { passive: true });
        }

        this._topicCreatedTimeObserver = new MutationObserver((mutations) => {

            for (const mutation of mutations) {
                if (mutation.type !== 'childList') continue;

                for (const node of mutation.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (
                        node.matches?.('tr.topic-list-item, tr.latest-topic-list-item, .topic-list') ||
                        node.querySelector?.('tr.topic-list-item, tr.latest-topic-list-item')
                    ) {
                        scheduleRender();
                        return;
                    }
                }
            }
        });

        if (document.body) {
            this._topicCreatedTimeObserver.observe(document.body, { childList: true, subtree: true });
        }
    }


    // 创建滑块行
    createSliderRow(label, value, min, max, step, onChange, formatValue = currentValue => currentValue) {
        const row = document.createElement("div");
        row.className = "toggle-row";
        row.style.flexDirection = "column";
        row.style.alignItems = "stretch";
        row.style.gap = "6px";

        const topRow = document.createElement("div");
        topRow.style.cssText = "display: flex; justify-content: space-between; align-items: center;";

        const labelEl = document.createElement("span");
        labelEl.className = "toggle-label";
        labelEl.textContent = label;

        const valueEl = document.createElement("span");
        valueEl.className = "toggle-label";
        valueEl.style.cssText = "color: #ffd700; font-weight: bold; min-width: 40px; text-align: right;";
        valueEl.textContent = formatValue(value);

        topRow.appendChild(labelEl);
        topRow.appendChild(valueEl);

        const sliderContainer = document.createElement("div");
        sliderContainer.style.cssText = "width: 100%; padding: 0 2px;";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;
        slider.className = "panel-slider-input";
        const percentage = ((value - min) / (max - min)) * 100;
        slider.style.cssText = `
            width: 100%;
            height: 4px;
            border-radius: 2px;
            background: linear-gradient(to right, #ffd700 0%, #ffd700 ${percentage}%, rgba(255, 255, 255, 0.3) ${percentage}%, rgba(255, 255, 255, 0.3) 100%);
            outline: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
            cursor: pointer;
        `;

        // 添加滑块样式
        if (!document.getElementById('panel-slider-style')) {
            const sliderStyle = document.createElement("style");
            sliderStyle.id = 'panel-slider-style';
            sliderStyle.textContent = `
                .panel-slider-input {
                    -webkit-appearance: none;
                    -moz-appearance: none;
                    appearance: none;
                }
                .panel-slider-input::-webkit-slider-runnable-track {
                    height: 4px;
                    border-radius: 2px;
                    background: transparent;
                }
                .panel-slider-input::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #fff 0%, #f0f0f0 100%);
                    cursor: pointer;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 215, 0, 0.5);
                    border: none;
                    margin-top: -5px;
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                }
                .panel-slider-input::-webkit-slider-thumb:hover {
                    transform: scale(1.15);
                    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.4), 0 0 0 2px rgba(255, 215, 0, 0.6);
                }
                .panel-slider-input::-webkit-slider-thumb:active {
                    transform: scale(1.05);
                    background: linear-gradient(135deg, #ffd700 0%, #ffb700 100%);
                }
                .panel-slider-input::-moz-range-track {
                    height: 4px;
                    border-radius: 2px;
                    background: transparent;
                    border: none;
                }
                .panel-slider-input::-moz-range-thumb {
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #fff 0%, #f0f0f0 100%);
                    cursor: pointer;
                    border: none;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 215, 0, 0.5);
                }
                .panel-slider-input::-moz-range-thumb:hover {
                    transform: scale(1.15);
                }
                .panel-slider-input::-moz-range-progress {
                    background: #ffd700;
                    border-radius: 2px;
                    height: 4px;
                }
                .panel-slider-input:focus {
                    outline: none;
                }
            `;
            document.head.appendChild(sliderStyle);
        }

        slider.addEventListener("input", (e) => {
            const newValue = Number.parseFloat(e.target.value);
            valueEl.textContent = formatValue(newValue);
            // 更新滑块背景渐变以显示进度
            const newPercentage = ((newValue - min) / (max - min)) * 100;
            slider.style.background = `linear-gradient(to right, #ffd700 0%, #ffd700 ${newPercentage}%, rgba(255, 255, 255, 0.3) ${newPercentage}%, rgba(255, 255, 255, 0.3) 100%)`;
            onChange(newValue);
        });

        sliderContainer.appendChild(slider);
        row.appendChild(topRow);
        row.appendChild(sliderContainer);

        return row;
    }

    // 创建下拉选择行
    createSelectRow(label, options, selectedValue, onChange) {
        const row = document.createElement("div");
        row.className = "toggle-row";

        const labelEl = document.createElement("span");
        labelEl.className = "toggle-label";
        labelEl.textContent = label;

        // 创建自定义下拉框容器
        const selectWrapper = document.createElement("div");
        selectWrapper.style.cssText = `
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            height: 100%;
        `;

        const select = document.createElement("select");
        select.style.cssText = `
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05));
            border: 1px solid rgba(255, 255, 255, 0.25);
            border-radius: 4px;
            color: white;
            padding: 5px 22px 5px 8px;
            font-size: 11px;
            cursor: pointer;
            outline: none;
            transition: all 0.2s ease;
            text-align: center;
            text-align-last: center;
            min-width: auto;
            width: auto;
            white-space: nowrap;
            overflow: visible;
            text-overflow: clip;
            margin-bottom: 0;
        `;

        // 添加悬停和聚焦效果
        select.addEventListener('mouseenter', () => {
            select.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0.1))';
            select.style.borderColor = 'rgba(255, 255, 255, 0.4)';
        });
        select.addEventListener('mouseleave', () => {
            if (document.activeElement !== select) {
                select.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05))';
                select.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }
        });
        select.addEventListener('focus', () => {
            select.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0.1))';
            select.style.borderColor = 'rgba(100, 180, 255, 0.6)';
            select.style.boxShadow = '0 0 0 2px rgba(100, 180, 255, 0.2)';
        });
        select.addEventListener('blur', () => {
            select.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05))';
            select.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            select.style.boxShadow = 'none';
        });

        // 添加下拉箭头
        const arrow = document.createElement("span");
        arrow.innerHTML = "▼";
        arrow.style.cssText = `
            position: absolute;
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 8px;
            color: rgba(255, 255, 255, 0.6);
            pointer-events: none;
        `;

        options.forEach(opt => {
            const option = document.createElement("option");
            option.value = opt.value;
            option.textContent = opt.label;
            option.selected = opt.value === selectedValue;
            option.style.cssText = `
                background: #2d2d2d;
                color: #fff;
                padding: 4px 8px;
            `;
            select.appendChild(option);
        });

        select.addEventListener("change", (e) => {
            onChange(e.target.value);
        });

        selectWrapper.appendChild(select);
        selectWrapper.appendChild(arrow);
        row.appendChild(labelEl);
        row.appendChild(selectWrapper);

        return row;
    }

    // 应用面板位置（带吸附效果）
    applyPanelPosition(x, y, snap = false) {
        let finalX = x;
        let finalY = y;
        const viewportWidth = window.visualViewport?.width || window.innerWidth;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const panelTopOffset = 70;
        const panelBottomMargin = 20;

        if (snap) {
            // 吸附逻辑：判断靠近哪一边
            const windowWidth = viewportWidth;
            const edgeMargin = 30; // 使用统一的边距变量
            const panelWidth = this.panelMinimized ? 50 : (this.container.offsetWidth || 280);
            const centerX = windowWidth / 2;

            // 判断在左边还是右边
            const isOnLeft = x < centerX;

            // 如果在左半边，吸附到左边；否则吸附到右边
            if (isOnLeft) {
                finalX = edgeMargin;
                this.container.classList.add('on-left');
                this.container.classList.remove('on-right');
            } else {
                finalX = windowWidth - panelWidth - edgeMargin;
                this.container.classList.add('on-right');
                this.container.classList.remove('on-left');
            }

            // 避开论坛顶部标题栏
            finalY = panelTopOffset;
        }

        // 恢复旧位置或窗口缩小时，确保面板始终完整留在可视区域内
        const panelWidth = this.panelMinimized ? 50 : (this.container.offsetWidth || 280);
        const panelHeight = this.panelMinimized
            ? 50
            : (this.container.offsetHeight || Math.max(0, viewportHeight - panelTopOffset - panelBottomMargin));
        const maxX = Math.max(0, viewportWidth - panelWidth);
        const maxY = Math.max(0, viewportHeight - panelHeight - panelBottomMargin);
        const minY = Math.min(panelTopOffset, maxY);
        finalX = Math.max(0, Math.min(Number.isFinite(finalX) ? finalX : panelBottomMargin, maxX));
        finalY = Math.max(minY, Math.min(Number.isFinite(finalY) ? finalY : panelTopOffset, maxY));

        // 应用位置
        this.container.style.position = 'fixed';
        this.container.style.left = finalX + 'px';
        this.container.style.top = finalY + 'px';
        this.container.style.right = 'auto';
        this.container.style.bottom = 'auto';
        this.container.style.transform = 'none';

        // 保存当前位置
        this.currentTranslateX = finalX;
        this.currentTranslateY = finalY;

        return { x: finalX, y: finalY };
    }

    makeDraggable(header) {
        let isDragging = false;
        let hasMoved = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let rafId = null;

        // 禁用过渡效果以提高拖动流畅度
        const disableTransition = () => {
            this.container.style.transition = 'none';
        };

        const enableTransition = () => {
            this.container.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        };

        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('panel-control-btn') ||
                e.target.closest('.panel-control-btn')) {
                return;
            }

            isDragging = true;
            hasMoved = false;
            disableTransition();

            const rect = this.container.getBoundingClientRect();
            initialX = e.clientX - rect.left;
            initialY = e.clientY - rect.top;

            // 使用捕获阶段，提高响应速度
            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mouseup', onMouseUp, true);

            // 防止文本选择
            e.preventDefault();
        });

        const updatePosition = () => {
            // 限制在视窗内
            const maxX = window.innerWidth - this.container.offsetWidth;
            const maxY = window.innerHeight - this.container.offsetHeight;

            currentX = Math.max(0, Math.min(currentX, maxX));
            currentY = Math.max(0, Math.min(currentY, maxY));

            // 实时更新位置（拖动时不吸附）
            this.container.style.position = 'fixed';
            this.container.style.left = currentX + 'px';
            this.container.style.top = currentY + 'px';
            this.container.style.right = 'auto';
            this.container.style.bottom = 'auto';
            this.container.style.transform = 'none';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;

            e.preventDefault();
            e.stopPropagation();

            hasMoved = true;
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;

            // 使用 requestAnimationFrame 确保流畅渲染
            if (rafId) {
                cancelAnimationFrame(rafId);
            }
            rafId = requestAnimationFrame(updatePosition);
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                enableTransition();

                // 取消未完成的动画帧
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }

                // 只有在真正移动过才吸附
                if (hasMoved) {
                    // 松开鼠标时吸附到最近的边角
                    const snappedPos = this.applyPanelPosition(currentX, currentY, true);

                    // 保存吸附后的位置
                    this.panelPosition = snappedPos;
                    Storage.set('panelPosition', this.panelPosition);
                }
            }
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
        };
    }

    makeMinimizedDraggable() {
        let isDragging = false;
        let hasMoved = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let rafId = null;

        this.container.addEventListener('mousedown', (e) => {
            // 只在最小化状态下才能拖动整个容器
            if (!this.panelMinimized) return;

            isDragging = true;
            hasMoved = false;
            this.container.style.transition = 'none';

            const rect = this.container.getBoundingClientRect();
            initialX = e.clientX - rect.left;
            initialY = e.clientY - rect.top;

            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mouseup', onMouseUp, true);

            e.preventDefault();
            e.stopPropagation();
        });

        const updatePosition = () => {
            const maxX = window.innerWidth - 50;
            const maxY = window.innerHeight - 50;

            currentX = Math.max(0, Math.min(currentX, maxX));
            currentY = Math.max(0, Math.min(currentY, maxY));

            this.container.style.position = 'fixed';
            this.container.style.left = currentX + 'px';
            this.container.style.top = currentY + 'px';
            this.container.style.right = 'auto';
            this.container.style.bottom = 'auto';
            this.container.style.transform = 'none';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;

            e.preventDefault();
            e.stopPropagation();

            hasMoved = true;
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;

            if (rafId) {
                cancelAnimationFrame(rafId);
            }
            rafId = requestAnimationFrame(updatePosition);
        };

        const onMouseUp = (e) => {
            if (isDragging) {
                isDragging = false;
                this.container.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }

                if (hasMoved) {
                    // 松开鼠标时吸附
                    const snappedPos = this.applyPanelPosition(currentX, currentY, true);
                    this.panelPosition = snappedPos;
                    Storage.set('panelPosition', this.panelPosition);

                    // 阻止点击事件触发展开
                    e.stopPropagation();
                } else {
                    // 没有移动，触发展开
                    // 不阻止事件，让点击事件继续冒泡
                }
            }
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
        };
    }

    // 切换布局模式（单列折叠 <-> 标签页切换）
    toggleLayout() {
        this.tabMode = !this.tabMode;
        Storage.set('tabMode', this.tabMode);
        this.setSessionStorage('tabMode', this.tabMode);

        // 重新加载面板以应用新布局
        // 保存当前位置
        const currentPos = { ...this.panelPosition };

        // 移除旧面板
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }

        // 重新创建面板
        this.setupButton();
        this.applyThemeColor();
        this.initDataLoading();
        if (this.likeCounter) {
            this.updateLikeCounterUI(this.likeCounter.getStatus());
        }
        if (this.autoRunning) {
            this.updateReadingStatus();
        }

        // 恢复位置（需要重新计算以适应新宽度）
        setTimeout(() => {
            const snappedPos = this.applyPanelPosition(currentPos.x, currentPos.y, true);
            this.panelPosition = snappedPos;
            Storage.set('panelPosition', this.panelPosition);
        }, 100);

        // 显示切换提示
        this.showNotification(this.t(this.tabMode ? 'switchedToTab' : 'switchedToCollapse'));

        console.log(`布局模式切换: ${this.tabMode ? 'tab' : 'collapse'}`);
    }

    // 切换标签页
    switchTab(tabNum) {
        if (!this.tabMode) return;
        if (this.activeTab === tabNum) return;

        this.activeTab = tabNum;
        Storage.set('activeTab', this.activeTab);

        // 更新标签按钮状态
        const tabBtns = this.container.querySelectorAll('.tab-nav-btn');
        tabBtns.forEach(btn => {
            const isActive = Number(btn.dataset.tabId) === tabNum;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        });

        // 更新标签内容显示
        const tabContents = this.container.querySelectorAll('.lda-tab-content');
        tabContents.forEach(content => {
            const contentTab = parseInt(content.getAttribute('data-tab'));
            const isActive = contentTab === tabNum;
            content.classList.toggle('active', isActive);
            content.setAttribute('aria-hidden', String(!isActive));
        });

        if (tabNum === 1) this.loadUserTrustLevel();

        console.log(`切换到标签页 ${tabNum}`);
    }

    createTabButton(tabId) {
        const config = this.tabConfig[tabId];
        if (!config) return null;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tab-nav-btn${this.activeTab === tabId ? ' active' : ''}`;
        button.dataset.tabId = tabId;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(this.activeTab === tabId));
        button.title = config.name;
        button.textContent = `${config.icon} ${config.name}`;
        if (tabId === 3) {
            const badge = document.createElement('span');
            badge.className = 'tab-remaining-badge';
            badge.textContent = String(this.getDisplayedRemainingCount());
            button.appendChild(badge);
        }
        button.addEventListener('click', () => this.switchTab(tabId));
        return button;
    }

    toggleMinimize() {
        const wasMinimized = this.panelMinimized;
        this.panelMinimized = !this.panelMinimized;
        Storage.set('panelMinimized', this.panelMinimized);

        // 根据布局模式获取内容容器
        const content = this.tabMode
            ? this.container.querySelector('.tab-container')
            : this.container.querySelector('.panel-content');

        // 判断当前在左边还是右边
        const windowWidth = window.innerWidth;
        const isOnRight = this.container.classList.contains('on-right');

        if (this.panelMinimized) {
            // 缩小：从 280px -> 50px
            if (content) content.classList.add('hidden');
            this.container.classList.add('minimized');

            // 如果在右边，需要调整 left 值以保持右边缘位置不变
            if (isOnRight) {
                const currentLeft = parseInt(this.container.style.left);
                // 280px 变成 50px，差值是 230px，需要向右移动 230px
                this.container.style.left = (currentLeft + 230) + 'px';
                this.currentTranslateX = currentLeft + 230;
            }

            setTimeout(() => {
                const snappedPos = this.applyPanelPosition(this.currentTranslateX, this.currentTranslateY, true);
                this.panelPosition = snappedPos;
                Storage.set('panelPosition', this.panelPosition);
            }, 100);
        } else {
            // 展开：从 50px -> 280px
            if (content) content.classList.remove('hidden');
            this.container.classList.remove('minimized');

            // 如果在右边，需要调整 left 值以保持右边缘位置不变
            if (isOnRight) {
                const currentLeft = parseInt(this.container.style.left);
                // 50px 变成 280px，差值是 230px，需要向左移动 230px
                this.container.style.left = (currentLeft - 230) + 'px';
                this.currentTranslateX = currentLeft - 230;
            }

            setTimeout(() => {
                // 强制浏览器重排
                void this.container.offsetWidth;

                const snappedPos = this.applyPanelPosition(this.currentTranslateX, this.currentTranslateY, true);
                this.panelPosition = snappedPos;
                Storage.set('panelPosition', this.panelPosition);
            }, 350);
        }
    }

    setupWindowResizeHandler() {
        // 监听窗口大小变化，确保面板始终在可见区域内
        let resizeTimer;

        const adjustPosition = () => {
            if (this.currentTranslateX !== null && this.currentTranslateY !== null) {
                // 重新应用吸附位置（窗口大小变化时重新计算）
                const snappedPos = this.applyPanelPosition(this.currentTranslateX, this.currentTranslateY, true);

                // 保存新位置
                this.panelPosition = snappedPos;
                Storage.set('panelPosition', this.panelPosition);
            }

            // 根据屏幕高度自动折叠区域
            this.autoCollapseForSmallScreen();
        };

        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(adjustPosition, 100);
        });

        // 初始调整一次
        setTimeout(adjustPosition, 500);
    }

    // 根据屏幕高度自动折叠区域
    autoCollapseForSmallScreen() {
        const screenHeight = window.innerHeight;

        // 如果屏幕高度小于 700px，自动折叠一些区域以确保内容能完整显示
        if (screenHeight < 700) {
            // 折叠插件设置区（如果未折叠）
            const allSections = this.container.querySelectorAll('.section-collapsible');
            for (const section of allSections) {
                const title = section.querySelector('.section-title');
                if (title && title.textContent.includes('插件设置')) {
                    if (!section.classList.contains('collapsed')) {
                        section.classList.add('collapsed');
                        if (this.settingsPluginSectionContent) {
                            this.settingsPluginSectionContent.classList.add('collapsed');
                        }
                    }
                    break;
                }
            }

            // 如果屏幕高度小于 600px，还要折叠账号信息区（除非正在自动阅读）
            if (screenHeight < 600 && !this.autoRunning) {
                if (this.accountSection && !this.accountSection.classList.contains('collapsed')) {
                    this.accountSection.classList.add('collapsed');
                    if (this.accountSectionContent) {
                        this.accountSectionContent.classList.add('collapsed');
                    }
                }
            }

            // 如果屏幕高度小于 500px，折叠自动阅读区（除非正在运行）
            if (screenHeight < 500 && !this.autoRunning) {
                const autoSection = this.container.querySelector('.section-collapsible');
                if (autoSection && !autoSection.classList.contains('collapsed')) {
                    autoSection.classList.add('collapsed');
                    if (this.autoSectionContent) {
                        this.autoSectionContent.classList.add('collapsed');
                    }
                }
            }
        }
    }

    checkLikeResumeTime() {
        if (this.likeResumeTime) {
            const now = Date.now();
            const maxResumeTime = now + LIKE_COOLDOWN_MS;
            if (this.likeResumeTime > maxResumeTime) {
                this.likeResumeTime = maxResumeTime;
                Storage.set('likeResumeTime', this.likeResumeTime);
            }
            if (now >= this.likeResumeTime) {
                // 时间到了，清除冷却时间
                console.log('点赞冷却时间已过，可以正常使用点赞功能');
                this.likeResumeTime = null;
                Storage.set('likeResumeTime', null);
                this.updateClearCooldownButton();
                // 不自动开启点赞，由用户决定
            } else {
                // 还在冷却期，记录状态但不修改开关
                const remainingMinutes = Math.ceil((this.likeResumeTime - now) / 60000);
                const resumeDate = new Date(this.likeResumeTime);
                console.log(`点赞功能冷却中，将在 ${resumeDate.toLocaleString()} (还需约 ${remainingMinutes} 分钟) 后恢复`);
                console.log(`提示：可以点击"清除点赞冷却"按钮立即恢复点赞功能`);
                this.updateClearCooldownButton();
            }
        } else {
            this.updateClearCooldownButton();
        }
    }

    // ========== IP 限流检测功能 ==========

    // 检测当前页面是否是 IP 限流页面
    detectIpRateLimit() {
        // 检查是否是正常的论坛页面（有 Discourse 特征）- 优先检查
        const isNormalPage = document.querySelector('#main-outlet') ||
                            document.querySelector('.topic-list') ||
                            document.querySelector('.topic-post') ||
                            document.querySelector('.d-header') ||
                            document.querySelector('.ember-application') ||
                            document.querySelector('[data-discourse-helper]');

        // 如果是正常页面，直接返回 false，不进行限流检测
        if (isNormalPage) {
            // 如果之前有误判的限流状态，清除它
            if (this.ipRateLimitResumeTime) {
                console.log('[IP限流] 检测到正常页面，清除之前的限流状态');
                this.ipRateLimitResumeTime = null;
                Storage.set('ipRateLimitResumeTime', null);
                this.stopIpRateLimitRecoveryCheck();
            }
            return false;
        }

        // 检查页面内容是否包含限流提示
        const pageText = document.body?.innerText || '';

        // 检测更严格的限流提示文本（必须是完整的错误页面特征）
        const rateLimitIndicators = [
            'You are being rate limited',
            'We have banned you temporarily',
            'Too Many Requests',
            'Error 429',
            'HTTP 429'
        ];

        // 使用更严格的匹配：必须包含这些完整短语
        const isRateLimited = rateLimitIndicators.some(indicator =>
            pageText.includes(indicator)
        );

        // 另外检查页面标题（更严格）
        const pageTitle = document.title || '';
        const titleRateLimited = pageTitle.includes('Rate Limited') ||
                                pageTitle.includes('429') ||
                                pageTitle.includes('Banned');

        // 额外检查：页面内容很短（错误页面通常内容很少）
        const isShortPage = pageText.length < 2000;

        // 只有同时满足：检测到限流指标 + 页面内容很短 + 不是正常页面，才判定为限流
        if ((isRateLimited || titleRateLimited) && isShortPage) {
            console.warn('🚫 [IP限流] 检测到 IP 被限流！');
            this.handleIpRateLimit();
            return true;
        }

        return false;
    }

    // 处理 IP 限流
    handleIpRateLimit() {
        // 如果已经在处理中，避免重复
        if (this.ipRateLimitResumeTime && Date.now() < this.ipRateLimitResumeTime) {
            console.log('[IP限流] 已在等待恢复中，跳过');
            return;
        }

        // 设置 30 分钟后恢复
        const waitTime = 30 * 60 * 1000; // 30 分钟
        this.ipRateLimitResumeTime = Date.now() + waitTime;
        Storage.set('ipRateLimitResumeTime', this.ipRateLimitResumeTime);

        // 停止自动阅读
        if (this.autoRunning) {
            console.log('[IP限流] 停止自动阅读...');
            this.stopScrolling();
            this.stopNavigationGuard();
            this.autoRunning = false;
            this.stopReadingTimer();
            this.setSessionStorage('autoRunning', false);

            // 更新按钮状态
            if (this.button) {
                this.button.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">${this.t('startReading')}</span>`;
                this.button.classList.remove('running');
            }

            // 清理定时器
            if (this.navigationTimeout) {
                clearTimeout(this.navigationTimeout);
                this.navigationTimeout = null;
            }
        }

        // 显示通知
        const resumeTime = new Date(this.ipRateLimitResumeTime);
        this.showNotification(`${this.t('ipRateLimited')}\n${this.t('ipRateLimitWait')} (${resumeTime.toLocaleTimeString()})`);

        console.log(`[IP限流] 自动阅读已暂停，将在 ${resumeTime.toLocaleString()} 后自动恢复`);

        // 启动恢复检测定时器
        this.startIpRateLimitRecoveryCheck();
    }

    // 检查 IP 限流状态（初始化时调用）
    checkIpRateLimitStatus() {
        if (this.ipRateLimitResumeTime) {
            const now = Date.now();

            // 首先检查当前页面是否是正常页面
            const isNormalPage = document.querySelector('#main-outlet') ||
                                document.querySelector('.topic-list') ||
                                document.querySelector('.topic-post') ||
                                document.querySelector('.d-header') ||
                                document.querySelector('.ember-application');

            if (isNormalPage) {
                // 当前是正常页面，说明之前的限流状态是误判，清除它
                console.log('[IP限流] 当前是正常页面，清除之前的限流状态（可能是误判）');
                this.ipRateLimitResumeTime = null;
                Storage.set('ipRateLimitResumeTime', null);
                return;
            }

            if (now >= this.ipRateLimitResumeTime) {
                // 时间到了，清除限流状态
                console.log('[IP限流] 限流时间已过，清除状态');
                this.ipRateLimitResumeTime = null;
                Storage.set('ipRateLimitResumeTime', null);
            } else {
                // 还在限流期，记录状态
                const remainingMinutes = Math.ceil((this.ipRateLimitResumeTime - now) / (1000 * 60));
                const resumeTime = new Date(this.ipRateLimitResumeTime);
                console.log(`[IP限流] IP 限流中，还需约 ${remainingMinutes} 分钟，将在 ${resumeTime.toLocaleString()} 后恢复`);

                // 如果正在自动阅读，强制停止
                if (this.autoRunning) {
                    console.log('[IP限流] 检测到自动阅读运行中，强制停止');
                    this.autoRunning = false;
                    this.stopReadingTimer();
                    this.setSessionStorage('autoRunning', false);
                }

                // 启动恢复检测定时器
                this.startIpRateLimitRecoveryCheck();
            }
        }
    }

    // 启动 IP 限流恢复检测定时器
    startIpRateLimitRecoveryCheck() {
        // 清除之前的定时器
        if (this.ipRateLimitCheckInterval) {
            clearInterval(this.ipRateLimitCheckInterval);
        }

        // 每分钟检查一次是否可以恢复
        this.ipRateLimitCheckInterval = setInterval(() => {
            if (!this.ipRateLimitResumeTime) {
                clearInterval(this.ipRateLimitCheckInterval);
                this.ipRateLimitCheckInterval = null;
                return;
            }

            const now = Date.now();
            if (now >= this.ipRateLimitResumeTime) {
                console.log('[IP限流] 限流时间到，尝试恢复...');
                this.tryResumeAfterIpRateLimit();
            } else {
                const remainingMinutes = Math.ceil((this.ipRateLimitResumeTime - now) / (1000 * 60));
                console.log(`[IP限流] 等待恢复中，还需 ${remainingMinutes} 分钟`);
            }
        }, 60000); // 每分钟检查一次

        console.log('[IP限流] 恢复检测定时器已启动');
    }

    // 尝试在 IP 限流解除后恢复
    tryResumeAfterIpRateLimit() {
        // 清除限流状态
        this.ipRateLimitResumeTime = null;
        Storage.set('ipRateLimitResumeTime', null);

        // 清除定时器
        if (this.ipRateLimitCheckInterval) {
            clearInterval(this.ipRateLimitCheckInterval);
            this.ipRateLimitCheckInterval = null;
        }

        // 显示恢复通知
        this.showNotification(this.t('ipRateLimitResume'));

        console.log('[IP限流] IP 限流已解除，可以恢复自动阅读');

        // 刷新页面以重新开始（因为当前页面可能是限流页面）
        // 跳转到首页
        window.location.href = `${BASE_URL}/latest`;
    }

    // 停止 IP 限流恢复检测
    stopIpRateLimitRecoveryCheck() {
        if (this.ipRateLimitCheckInterval) {
            clearInterval(this.ipRateLimitCheckInterval);
            this.ipRateLimitCheckInterval = null;
            console.log('[IP限流] 恢复检测定时器已停止');
        }
    }

    // ========== CloudFlare 5秒盾自动跳转功能 ==========

    CF_BYPASS_CONFIG = {
        ERROR_TEXTS: ['403 error', '该回应是很久以前创建的', 'reaction was created too long ago', '我们无法加载该话题'],
        DIALOG_SELECTOR: '.dialog-body',
        CHALLENGE_PATH: '/challenge'
    };

    isChallengePage() {
        return window.location.pathname.startsWith(this.CF_BYPASS_CONFIG.CHALLENGE_PATH);
    }

    isChallengeFailure() {
        if (this.isChallengePage()) return false;
        const el = document.querySelector(this.CF_BYPASS_CONFIG.DIALOG_SELECTOR);
        if (!el) return false;
        const text = el.innerText || '';
        return this.CF_BYPASS_CONFIG.ERROR_TEXTS.some(t => text.includes(t));
    }

    redirectToChallenge() {
        if (this.isChallengePage()) return;
        const url = `${this.CF_BYPASS_CONFIG.CHALLENGE_PATH}?redirect=${encodeURIComponent(window.location.href)}`;
        this.showNotification(this.t('cfBypassDetected'));
        window.location.href = url;
    }

    checkAndRedirectCF() {
        if (!this.cfBypassEnabled) return;
        if (this.isChallengeFailure()) this.redirectToChallenge();
    }

    initCloudFlareBypass() {
        if (!this.cfBypassEnabled) return;
        this.checkAndRedirectCF();
        this._cfBypassObserver?.disconnect();
        this._cfBypassObserver = new MutationObserver(() => this.checkAndRedirectCF());
        this._cfBypassObserver.observe(document.body, { childList: true, subtree: true });
    }

    manualTriggerCF() {
        if (this.isChallengePage()) {
            this.showNotification(this.t('cfBypassAlreadyOnChallenge'));
            return;
        }
        this.showNotification(this.t('cfBypassManual'));
        const url = `${this.CF_BYPASS_CONFIG.CHALLENGE_PATH}?redirect=${encodeURIComponent(window.location.href)}`;
        window.location.href = url;
    }

    updateClearCooldownButton() {
        if (!this.clearCooldownBtn) return;

        // 清除之前的定时器
        if (this.cooldownUpdateTimer) {
            clearInterval(this.cooldownUpdateTimer);
            this.cooldownUpdateTimer = null;
        }

        // 检查是否有冷却状态（来自 LikeCounter 或旧的 likeResumeTime）
        const likeCounterCooldown = this.likeCounter?.isInCooldown?.();
        const hasOldCooldown = this.likeResumeTime && Date.now() < this.likeResumeTime;

        if (likeCounterCooldown || hasOldCooldown) {
            // 如果 LikeCounter 已经显示冷却倒计时，按钮只显示简洁文字（不重复显示倒计时）
            if (likeCounterCooldown) {
                this.clearCooldownBtn.innerHTML = `<span class="btn-icon">❄️</span><span class="btn-text">${this.t('clearCooldown')}</span>`;
                this.clearCooldownBtn.style.display = 'flex';
            } else if (hasOldCooldown) {
                // 旧的冷却机制：显示倒计时（因为 LikeCounter 可能没有这个冷却信息）
                const updateDisplay = () => {
                    const now = Date.now();
                    if (now >= this.likeResumeTime) {
                        // 冷却结束
                        this.clearCooldownBtn.style.display = 'none';
                        if (this.cooldownUpdateTimer) {
                            clearInterval(this.cooldownUpdateTimer);
                            this.cooldownUpdateTimer = null;
                        }
                        // 清除冷却时间
                        this.likeResumeTime = null;
                        Storage.set('likeResumeTime', null);
                        this.showNotification(this.t('likeCooldownCleared'));
                        return;
                    }

                    const remaining = this.likeResumeTime - now;
                    const hours = Math.floor(remaining / (1000 * 60 * 60));
                    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
                    const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

                    // 构建显示文本
                    let timeText = this.t('remaining');
                    if (hours > 0) {
                        timeText += `${hours}${this.t('hours')}`;
                    }
                    if (minutes > 0 || hours > 0) {
                        timeText += `${minutes}${this.t('minutes')}`;
                    }
                    timeText += `${seconds}${this.t('seconds')}`;

                    this.clearCooldownBtn.innerHTML = `<span class="btn-icon">🔥</span><span class="btn-text">${this.t('clearCooldown')} (${timeText})</span>`;
                };

                // 立即更新一次
                updateDisplay();
                this.clearCooldownBtn.style.display = 'flex';

                // 每秒更新一次
                this.cooldownUpdateTimer = setInterval(updateDisplay, 1000);
            }
        } else {
            this.clearCooldownBtn.style.display = 'none';
        }
    }

    handleClearCooldown() {
        const likeCounterCooldown = this.likeCounter?.isInCooldown?.();
        const hasOldCooldown = this.likeResumeTime && Date.now() < this.likeResumeTime;

        if (!likeCounterCooldown && !hasOldCooldown) {
            this.showNotification(this.t('noCooldown'));
            return;
        }

        // 清除 LikeCounter 的冷却
        if (this.likeCounter) {
            this.likeCounter.clearCooldown();
        }

        // 清除旧的冷却时间
        this.likeResumeTime = null;
        Storage.set('likeResumeTime', null);

        // 更新按钮显示
        this.updateClearCooldownButton();

        // 显示成功提示
        this.showNotification(this.t('likeCooldownCleared'));
        console.log('[清除冷却] 点赞冷却时间已清除');
    }

    observeLikeLimit() {
        // 标志：是否已经通过 API 处理过点赞限制
        this._likeLimitHandledByAPI = false;
        this._lastLikeLimitTime = 0;
        // 标志：防止 DOM 监听器在短时间内重复触发（防抖）
        this._likeLimitPopupLastTime = 0;
        this._likeLimitPopupTimeout = null;

        // 优先：拦截 XHR 请求，捕获 429 错误响应（精确获取等待时间）
        this.interceptFetchForLikeLimit();

        // 备用：监听 DOM 变化，检测点赞限制弹窗
        // 只有当 XHR 拦截器未能处理时，才使用 DOM 解析的时间
        this._likeLimitObserver?.disconnect();
        this._likeLimitObserver = new MutationObserver((mutations) => {
            // 防抖：500ms 内不重复处理
            const now = Date.now();
            if (now - this._likeLimitPopupLastTime < 500) {
                return;
            }

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        // 首先检查是否是模态框/弹窗元素，排除普通内容（如通知、帖子、回复等）
                        // Discourse 的点赞限制弹窗通常有以下特征类名
                        const isModalElement = (
                            node.classList.contains('modal') ||
                            node.classList.contains('d-modal') ||
                            node.classList.contains('bootbox') ||
                            node.classList.contains('dialog-body') ||
                            node.classList.contains('popup-menu') ||
                            node.closest?.('.modal, .d-modal, .bootbox, .dialog-container, .fk-d-modal') ||
                            // 检查 node 本身是否包含模态框结构
                            node.querySelector?.('.modal, .d-modal, .bootbox, .dialog-body, .fk-d-modal__inner')
                        );

                        // 如果不是模态框元素，跳过检测（避免匹配通知、帖子等普通内容）
                        if (!isModalElement) {
                            continue;
                        }

                        const text = node.textContent || '';

                        // 检测点赞限制弹窗
                        const isLikeLimit = (
                            (text.includes('点赞上限') ||
                             text.includes('分享很多爱') ||
                             (text.includes('点赞') && text.includes('小时后再次点赞'))) &&
                            !text.includes('回复') &&
                            !text.includes('创建更多新回复')
                        );

                        if (isLikeLimit) {
                            // 更新最后处理时间
                            this._likeLimitPopupLastTime = now;

                            // 清除之前的超时
                            if (this._likeLimitPopupTimeout) {
                                clearTimeout(this._likeLimitPopupTimeout);
                            }

                            // 等待 XHR 拦截器处理（XHR load 事件通常在 DOM 更新后触发）
                            this._likeLimitPopupTimeout = setTimeout(() => {
                                const currentTime = Date.now();
                                // 检查 XHR 是否已经处理过（2秒内）
                                if (this._likeLimitHandledByAPI && (currentTime - this._lastLikeLimitTime) < 2000) {
                                    console.log('[点赞限制] XHR 已处理，DOM 监听器仅关闭弹窗');
                                } else {
                                    // XHR 未处理，使用 DOM 解析作为备用方案
                                    console.log('[点赞限制] XHR 未处理，使用 DOM 解析作为备用');
                                    this.handleLikeLimit(text);
                                }

                                // 无论如何都自动关闭弹窗
                                this.closeLikeLimitPopup();
                            }, 300); // 等待 300ms，让 XHR 拦截器有时间处理

                            return; // 找到后立即返回，不再继续遍历
                        }
                    }
                }
            }
        });

        this._likeLimitObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 拦截 fetch 和 XMLHttpRequest 请求，捕获点赞 API 的 429 错误
    interceptFetchForLikeLimit() {
        if (this._likeRateLimitEventHandler) return;

        this._likeRateLimitEventHandler = (event) => {
            const waitSeconds = Number(event.detail?.waitSeconds || 0);
            const timeLeft = event.detail?.timeLeft || '';
            if (waitSeconds <= 0) return;

            console.log(`[点赞限制] 获取精确等待时间: ${waitSeconds} 秒 (${timeLeft})`);
            this.handleLikeLimitFromAPI(waitSeconds, timeLeft);
        };

        window.addEventListener('lda:like-rate-limit', this._likeRateLimitEventHandler);
        console.log('[点赞限制] 已连接统一的点赞请求观察器');
    }

    // 处理从 API 获取的点赞限制
    handleLikeLimitFromAPI(waitSeconds, timeLeft) {
        console.log(`[点赞限制] API 返回等待 ${waitSeconds} 秒，本地统一冷却 5 分钟`);

        // 标记已通过 API 处理，防止 DOM 监听器重复处理
        this._likeLimitHandledByAPI = true;
        this._lastLikeLimitTime = Date.now();

        const resumeTime = Date.now() + LIKE_COOLDOWN_MS;
        this.likeResumeTime = resumeTime;
        Storage.set('likeResumeTime', resumeTime);

        // 同步到 LikeCounter 的冷却状态（确保两套机制一致）
        if (this.likeCounter && resumeTime > this.likeCounter.state.cooldownUntil) {
            this.likeCounter.state.cooldownUntil = resumeTime;
            this.likeCounter.saveState();
            this.likeCounter.notifyUIUpdate();
            console.log(`[点赞限制] 已同步冷却状态到 LikeCounter`);
        }

        this.disableAutoLike();
        this.updateAutoLikeStatus('autoLikeCooling');

        // 更新冷却按钮显示
        this.updateClearCooldownButton();

        const resumeDate = new Date(resumeTime);
        console.log(`[点赞限制] 已达到点赞上限，将在 ${resumeDate.toLocaleString()} (5分钟) 后恢复`);

        // 显示提示
        this.showNotification(`${this.t('likeLimitReached')}5${this.t('minutes')}`);
    }

    handleLikeLimit(text) {
        console.log('检测到点赞限制提示:', text);

        const waitMinutes = 5;

        // 计算恢复时间
        const resumeTime = Date.now() + (waitMinutes * 60 * 1000);
        this.likeResumeTime = resumeTime;
        Storage.set('likeResumeTime', resumeTime);

        // 同步到 LikeCounter 的冷却状态（确保两套机制一致）
        if (this.likeCounter && resumeTime > this.likeCounter.state.cooldownUntil) {
            this.likeCounter.state.cooldownUntil = resumeTime;
            this.likeCounter.saveState();
            this.likeCounter.notifyUIUpdate();
            console.log(`[点赞限制] 已同步冷却状态到 LikeCounter`);
        }

        this.disableAutoLike();
        this.updateAutoLikeStatus('autoLikeCooling');

        const resumeDate = new Date(resumeTime);
        const displayTime = `${waitMinutes}${this.t('minutes')}`;

        console.log(`已达到点赞上限，自动关闭点赞功能，将在 ${resumeDate.toLocaleString()} (${displayTime}后) 恢复`);

        // 显示提示 - 使用提取到的实际时间
        this.showNotification(`${this.t('likeLimitReached')}${displayTime}`);
    }

    // 关闭点赞限制弹窗
    closeLikeLimitPopup() {
        console.log('[点赞限制] 尝试关闭弹窗...');

        // 方法1：直接查找并点击确定/关闭按钮
        const buttonSelectors = [
            // Discourse 标准弹窗按钮
            '.dialog-footer .btn-primary',
            '.modal-footer .btn-primary',
            '.d-modal__footer .btn-primary',
            '.bootbox .btn-primary',
            // 通用按钮
            'button.btn-primary',
            'button.btn-default',
            // 关闭按钮
            '.modal-close',
            '.close-modal',
            '.d-modal__dismiss',
            'button[aria-label="关闭"]',
            'button[aria-label="Close"]',
            '.dialog-close',
            // Discourse 特定
            '.d-modal__dismiss-icon',
            '.modal-header .close'
        ];

        for (const selector of buttonSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                // 检查元素是否可见
                if (element.offsetParent === null) continue;

                const text = (element.textContent || '').trim();
                // 对于 btn-primary，直接点击（通常是确定按钮）
                if (selector.includes('btn-primary') ||
                    text.includes('确定') || text.includes('OK') || text.includes('关闭') || text.includes('好') ||
                    element.classList.contains('modal-close') ||
                    element.classList.contains('close-modal') ||
                    element.classList.contains('d-modal__dismiss')) {
                    console.log(`[点赞限制] 找到关闭按钮: ${selector}, 文本: "${text}"`);
                    try {
                        void HumanInput.click(element);
                        console.log('[点赞限制] 已点击关闭按钮');
                        return;
                    } catch (e) {
                        console.error('[点赞限制] 点击按钮失败:', e);
                    }
                }
            }
        }

        // 方法2：查找所有可见的弹窗，尝试点击其中的按钮
        const modalSelectors = ['.modal', '.d-modal', '.bootbox', '.dialog-body', '[role="dialog"]'];
        for (const modalSelector of modalSelectors) {
            const modal = document.querySelector(modalSelector);
            if (modal && modal.offsetParent !== null) {
                // 在弹窗内查找按钮
                const buttons = modal.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim();
                    if (text.includes('确定') || text.includes('OK') || text.includes('关闭') || text.includes('好') ||
                        btn.classList.contains('btn-primary')) {
                        console.log(`[点赞限制] 在弹窗内找到按钮: "${text}"`);
                        try {
                            void HumanInput.click(btn);
                            console.log('[点赞限制] 已点击弹窗内按钮');
                            return;
                        } catch (e) {
                            console.error('[点赞限制] 点击弹窗内按钮失败:', e);
                        }
                    }
                }
            }
        }

        // 方法3：尝试按 Escape 键关闭
        console.log('[点赞限制] 未找到关闭按钮，尝试按 Escape 键');
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true
        }));

        // 方法4：延迟后再次尝试（有时弹窗需要时间渲染）
        setTimeout(() => {
            const visibleButtons = document.querySelectorAll('.dialog-footer button, .modal-footer button');
            for (const btn of visibleButtons) {
                if (btn.offsetParent !== null) {
                    console.log(`[点赞限制] 延迟后找到按钮: "${btn.textContent}"`);
                    void HumanInput.click(btn);
                    return;
                }
            }
        }, 500);
    }

    showNotification(message) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 20px;
            border-radius: 10px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 100000;
            font-size: 14px;
            max-width: 300px;
            animation: slideIn 0.3s ease-out;
        `;
        notification.textContent = message;

        // 添加动画样式
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(notification);

        // 3秒后自动消失
        setTimeout(() => {
            notification.style.transition = 'all 0.3s';
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(400px)';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    // 获取当前用户名（参考 1.js 的多种方法，优先使用 DOM 方式，减少 API 调用避免 429）
    async getCurrentUsername(forceRefresh = false) {
        if (!forceRefresh && this.currentUsername) return this.currentUsername;

        try {
            // 方法1：从 Discourse 全局对象获取
            try {
                const currentUser = window.Discourse?.User?.current?.() ||
                    window.Discourse?.currentUser ||
                    window.User?.current?.();
                if (currentUser?.username) {
                    this.currentUsername = currentUser.username;
                    return this.currentUsername;
                }
            } catch (e) { }

            // 方法2：从页面 preload 数据获取
            try {
                const preloadData = document.getElementById('data-preloaded');
                if (preloadData) {
                    const data = JSON.parse(preloadData.dataset.preloaded);
                    if (data?.currentUser) {
                        const cu = JSON.parse(data.currentUser);
                        if (cu?.username) {
                            this.currentUsername = cu.username;
                            return this.currentUsername;
                        }
                    }
                }
            } catch (e) { }

            // 方法3：从用户菜单头像 alt 获取
            const userMenuBtn = document.querySelector('.header-dropdown-toggle.current-user');
            if (userMenuBtn) {
                const img = userMenuBtn.querySelector('img[alt]');
                if (img && img.alt) {
                    this.currentUsername = img.alt.trim().replace(/^@/, '');
                    return this.currentUsername;
                }
            }

            // 方法4：从用户头像 title 获取
            const userAvatar = document.querySelector('.current-user img[title]');
            if (userAvatar && userAvatar.title) {
                this.currentUsername = userAvatar.title.trim().replace(/^@/, '');
                return this.currentUsername;
            }

            // 方法5：从当前用户链接 href 获取
            const currentUserLink = document.querySelector('a.current-user, .header-dropdown-toggle.current-user a');
            if (currentUserLink) {
                const href = currentUserLink.getAttribute('href');
                if (href && href.includes('/u/')) {
                    const username = href.split('/u/')[1].split('/')[0];
                    if (username) {
                        this.currentUsername = username.trim().replace(/^@/, '');
                        return this.currentUsername;
                    }
                }
            }

            // 方法6：从导航栏用户头像链接获取
            try {
                const avatarLink = document.querySelector('#current-user a[href*="/u/"]');
                if (avatarLink) {
                    const match = avatarLink.href.match(/\/u\/([^\/]+)/);
                    if (match) {
                        this.currentUsername = match[1].trim().replace(/^@/, '');
                        return this.currentUsername;
                    }
                }
            } catch (e) { }

            // 方法7：从 localStorage 获取（Discourse 常用存储）
            try {
                const stored = localStorage.getItem('discourse_current_user');
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (parsed?.username) {
                        this.currentUsername = parsed.username;
                        return this.currentUsername;
                    }
                }
            } catch (e) { }

            // 方法8：遍历页面用户链接（排除帖子列表/帖子流）
            try {
                const userLinks = document.querySelectorAll('a[href*="/u/"]');
                for (const link of userLinks) {
                    if (link.closest('.topic-list') || link.closest('.post-stream')) continue;
                    const href = link.getAttribute('href');
                    if (href && href.includes('/u/')) {
                        const username = href.split('/u/')[1].split('/')[0];
                        if (username) {
                            this.currentUsername = username.trim().replace(/^@/, '');
                            return this.currentUsername;
                        }
                    }
                }
            } catch (e) { }

            // 方法9：如果当前 URL 在用户页面
            if (window.location.pathname.includes('/u/')) {
                const username = window.location.pathname.split('/u/')[1].split('/')[0];
                if (username) {
                    this.currentUsername = username.trim().replace(/^@/, '');
                    return this.currentUsername;
                }
            }

            // 方法10（最后手段）：从 API 获取 - 只在支持的站点使用，且只有前面所有方法都失败时才调用
            if (CURRENT_DOMAIN === 'linux.do' || CURRENT_DOMAIN === 'idcflare.com') {
                // 先检查是否在 429 冷却期
                const session429Until = Storage.get('session429Until', 0);
                if (session429Until > Date.now()) {
                    const remainMinutes = Math.ceil((session429Until - Date.now()) / 60000);
                    console.log(`[Session] session/current 429 冷却期中，剩余 ${remainMinutes} 分钟，跳过请求`);
                    return null;
                }

                const response = await fetch(`${BASE_URL}/session/current.json`);
                // 检测 429 错误
                if (response.status === 429) {
                    console.warn('[Session] session/current 遇到 429，设置 30 分钟冷却');
                    Storage.set('session429Until', Date.now() + 30 * 60 * 1000);
                    return null;
                }
                if (response.ok) {
                    const data = await response.json();
                    if (data.current_user && data.current_user.username) {
                        this.currentUsername = data.current_user.username;
                        return this.currentUsername;
                    }
                }
            }
        } catch (error) {
            console.error('获取用户名失败:', error);
        }
        return null;
    }

    // 加载用户信任等级
    async loadUserTrustLevel(isManualRefresh = false) {
        const username = await this.getCurrentUsername();
        if (!username) {
            this.trustLevelContainer.innerHTML = '<div class="trust-level-loading">未登录</div>';
            return;
        }

        const now = Date.now();
        const TRUST_LEVEL_CACHE_INTERVAL = 30 * 60 * 1000; // 30分钟
        const cacheKey = `trustLevelCache_${CURRENT_DOMAIN}_${username}`;
        const lastFetchKey = `lastTrustLevelFetch_${CURRENT_DOMAIN}_${username}`;
        const lastFetch = Storage.get(lastFetchKey, 0);

        // 非手动刷新时，检查30分钟缓存
        if (!isManualRefresh && lastFetch > 0 && (now - lastFetch) < TRUST_LEVEL_CACHE_INTERVAL) {
            const cachedData = Storage.get(cacheKey, null);
            if (cachedData) {
                console.log('使用缓存的等级数据，距上次获取:', Math.round((now - lastFetch) / 1000 / 60), '分钟');
                this.renderCachedTrustLevel(cachedData, lastFetch);
                return;
            }
        }

        // 手动刷新时显示加载状态
        if (isManualRefresh) {
            const refreshBtn = this.trustLevelContainer.querySelector('.trust-level-refresh');
            if (refreshBtn) {
                refreshBtn.textContent = this.t('refreshing');
                refreshBtn.disabled = true;
            }
        }

        try {
            // 域名判断：idcflare.com 使用原逻辑，linux.do 使用新逻辑
            if (CURRENT_DOMAIN === 'idcflare.com') {
                // idcflare.com 使用原来的 summary.json 逻辑
                const summaryResponse = await fetch(`${BASE_URL}/u/${username}/summary.json`);
                if (summaryResponse.ok) {
                    const data = await summaryResponse.json();
                    if (data.user_summary) {
                        this.renderTrustLevel(data, username);
                        return;
                    }
                }
                throw new Error('无法获取等级数据');
            } else if (CURRENT_DOMAIN === 'linux.do') {
                // linux.do: 完全使用 1.js 的逻辑（使用GM_xmlhttpRequest跨域请求）
                await this.fetchLinuxDoDataWithGM(username);
            }
        } catch (error) {
            console.error('加载信任等级失败:', error);
            this.trustLevelContainer.innerHTML = `
                <div class="trust-level-header">
                    📊 信任等级
                    <button class="trust-level-refresh" data-action="refresh">🔄 刷新</button>
                </div>
                <div class="trust-level-loading">加载失败，请点击刷新重试</div>
            `;
            this.bindTrustLevelRefresh();
        } finally {
            // 恢复刷新按钮状态
            if (isManualRefresh) {
                setTimeout(() => {
                    const refreshBtn = this.trustLevelContainer.querySelector('.trust-level-refresh');
                    if (refreshBtn) {
                        refreshBtn.textContent = '🔄 刷新';
                        refreshBtn.disabled = false;
                    }
                }, 1000);
            }
        }
    }

    // 保存等级数据缓存（区分域名）
    saveTrustLevelCache(username, data) {
        const cacheKey = `trustLevelCache_${CURRENT_DOMAIN}_${username}`;
        const lastFetchKey = `lastTrustLevelFetch_${CURRENT_DOMAIN}_${username}`;
        Storage.set(cacheKey, data);
        Storage.set(lastFetchKey, Date.now());
        console.log(`等级数据已缓存 (${CURRENT_DOMAIN})`);

        // 保存每日历史快照
        this.saveDailySnapshot(username, data);
    }

    // 保存每日历史快照（用于追踪数据变化）
    saveDailySnapshot(username, data) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式
        const historyKey = `trustLevelHistory_${CURRENT_DOMAIN}_${username}`;
        const history = Storage.get(historyKey, {});

        // 提取数值数据用于存储
        const snapshot = {
            date: today,
            timestamp: Date.now(),
            type: data.type,
            currentLevel: data.currentLevel,
            targetLevel: data.targetLevel,
            items: (data.items || data.requirements || []).map(item => {
                // 统一处理数值提取
                let currentNum = item.current;
                let requiredNum = item.required;

                // 如果是字符串，尝试提取数字
                if (typeof item.current === 'string') {
                    const match = item.current.match(/(\d+)/);
                    currentNum = match ? parseInt(match[1]) : 0;
                }
                if (typeof item.required === 'string') {
                    const match = item.required.match(/(\d+)/);
                    requiredNum = match ? parseInt(match[1]) : 0;
                }

                // 简化标签名称（与渲染时保持一致，确保匹配）
                let simpleName = item.name
                    .replace('已读帖子（所有时间）', '浏览帖子')
                    .replace('浏览的话题（所有时间）', '浏览话题')
                    .replace('访问次数（过去', '访问次数(')
                    .replace('个月）', '月)')
                    .replace('回复次数（最近', '回复(近')
                    .replace('天内）', '天)');

                return {
                    name: simpleName,
                    current: currentNum,
                    required: requiredNum,
                    isMet: item.isMet
                };
            })
        };

        // 保存今天的数据（覆盖当天的旧数据）
        history[today] = snapshot;

        // 只保留最近30天的数据
        const dates = Object.keys(history).sort().reverse();
        if (dates.length > 30) {
            dates.slice(30).forEach(d => delete history[d]);
        }

        Storage.set(historyKey, history);
        console.log(`等级历史快照已保存 (${today})`);
    }

    // 获取昨日的等级数据快照
    getYesterdaySnapshot(username) {
        const historyKey = `trustLevelHistory_${CURRENT_DOMAIN}_${username}`;
        const history = Storage.get(historyKey, {});

        // 获取昨天的日期
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        return history[yesterdayStr] || null;
    }

    // 计算数据变化（今天相对于昨天）
    calculateDataChange(currentValue, yesterdaySnapshot, itemName) {
        if (!yesterdaySnapshot || !yesterdaySnapshot.items) return null;

        const yesterdayItem = yesterdaySnapshot.items.find(item => item.name === itemName);
        if (!yesterdayItem) return null;

        const diff = currentValue - yesterdayItem.current;
        return diff;
    }

    // 生成变化指示器 HTML
    generateChangeIndicator(diff) {
        if (diff === null || diff === undefined) return '';

        if (diff > 0) {
            return `<span class="change-indicator change-up" title="较昨日 +${diff}">↑${diff}</span>`;
        } else if (diff < 0) {
            return `<span class="change-indicator change-down" title="较昨日 ${diff}">↓${Math.abs(diff)}</span>`;
        }
        return ''; // 无变化不显示
    }

    // 渲染缓存的等级数据
    renderCachedTrustLevel(cachedData, lastFetch) {
        if (!cachedData) return;

        const { type, username, currentLevel, targetLevel, items, requirements, achievedCount, totalCount, allMet } = cachedData;

        // 计算缓存时间显示
        const cacheAge = Date.now() - lastFetch;
        const cacheMinutes = Math.floor(cacheAge / 1000 / 60);
        const cacheTimeText = cacheMinutes < 1 ? '刚刚' : `${cacheMinutes}分钟前`;

        // 等级名称映射
        const levelNames = {
            0: 'Lv0 → Lv1',
            1: 'Lv1 → Lv2',
            2: 'Lv1 → Lv2',
            3: 'Lv2 → Lv3',
            4: 'Lv3 → Lv4'
        };

        // 获取昨日数据用于对比
        const yesterdaySnapshot = this.getYesterdaySnapshot(username);

        // 判断是否已满足所有要求，决定标题显示
        const isAllMetForHeader = type === 'low_level' ? allMet : (achievedCount === totalCount);
        const headerTitle = isAllMetForHeader
            ? `Lv${targetLevel} ✓`
            : (levelNames[type === 'low_level' ? currentLevel : targetLevel] || `Lv${currentLevel} → Lv${targetLevel}`);

        let html = `
            <div class="trust-level-header">
                <span>📊 ${headerTitle} (${username})</span>
                <button class="trust-level-refresh" data-action="refresh">🔄 刷新</button>
            </div>
            <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-bottom: 4px; text-align: right;">缓存: ${cacheTimeText}</div>
        `;

        // 根据类型渲染不同的数据
        const displayItems = type === 'low_level' ? items : requirements;

        displayItems.forEach(req => {
            let currentNum, requiredNum, displayCurrent, displayRequired;

            if (type === 'low_level') {
                currentNum = req.current;
                requiredNum = req.required;
                displayCurrent = req.current;
                displayRequired = req.required;
            } else {
                // 高级等级：从文本中提取数字
                const currentMatch = req.current.match(/(\d+)/);
                const requiredMatch = req.required.match(/(\d+)/);
                currentNum = currentMatch ? parseInt(currentMatch[1]) : 0;
                requiredNum = requiredMatch ? parseInt(requiredMatch[1]) : 1;
                displayCurrent = req.current;
                displayRequired = req.required;
            }

            const progress = Math.min((currentNum / requiredNum) * 100, 100);
            const isCompleted = req.isMet;
            const fillClass = isCompleted ? 'completed' : '';

            // 简化标签名称
            let simpleName = req.name
                .replace('已读帖子（所有时间）', '浏览帖子')
                .replace('浏览的话题（所有时间）', '浏览话题')
                .replace('访问次数（过去', '访问次数(')
                .replace('个月）', '月)')
                .replace('回复次数（最近', '回复(近')
                .replace('天内）', '天)');

            // 计算与昨日的变化
            const diff = this.calculateDataChange(currentNum, yesterdaySnapshot, simpleName);
            const changeIndicator = this.generateChangeIndicator(diff);

            html += `
                <div class="trust-level-item">
                    <span class="trust-level-name">${simpleName}</span>
                    <div class="trust-level-progress">
                        <div class="trust-level-bar">
                            <div class="trust-level-bar-fill ${fillClass}" style="width: ${progress}%"></div>
                        </div>
                        <span class="trust-level-value">${displayCurrent}/${displayRequired}${changeIndicator}</span>
                    </div>
                </div>
            `;
        });

        // 添加总结信息
        const isAllMet = type === 'low_level' ? allMet : (achievedCount === totalCount);
        if (isAllMet) {
            html += `
                <div style="background: rgba(255, 255, 255, 0.25); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: #fff; font-size: 11px; font-weight: 600; text-align: center;">
                        ✅ 已满足 Lv${targetLevel} 要求
                    </div>
                </div>
            `;
        } else {
            const unmetCount = totalCount - achievedCount;
            html += `
                <div style="background: rgba(255, 255, 255, 0.15); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 11px; font-weight: 500; text-align: center;">
                        还需完成 ${unmetCount} 项升级到 Lv${targetLevel}
                    </div>
                </div>
            `;
        }

        this.trustLevelContainer.innerHTML = html;

        this.bindTrustLevelRefresh();
    }

    // 使用 GM_xmlhttpRequest 获取 linux.do 数据（完全按照1.js的逻辑）
    async fetchLinuxDoDataWithGM(username) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: "https://connect.linux.do/",
                timeout: 15000,
                onload: (response) => {
                    if (response.status === 200) {
                        const responseText = response.responseText;
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = responseText;

                        // 1. 解析全局用户名和当前等级 (从 <h1>)
                        let globalUsername = username;
                        let currentLevel = '未知';
                        const h1 = tempDiv.querySelector('h1');
                        if (h1) {
                            const h1Text = h1.textContent.trim();
                            // 例如: "你好，一剑万生 (YY_WD) 2级用户" 或 "你好， (yy2025) 0级用户"
                            const welcomeMatch = h1Text.match(/你好，\s*([^(\s]*)\s*\(?([^)]*)\)?\s*(\d+)级用户/i);
                            if (welcomeMatch) {
                                // 优先使用括号内的用户名，如果没有则使用前面的
                                globalUsername = welcomeMatch[2] || welcomeMatch[1] || username;
                                currentLevel = welcomeMatch[3];
                                console.log(`从<h1>解析: 用户名='${globalUsername}', 当前等级='${currentLevel}'`);
                            }
                        }

                        // 检查用户等级，决定使用哪种数据获取方式
                        let userLevel = parseInt(currentLevel);

                        // 如果从 <h1> 无法解析等级，尝试从页面文本判断
                        if (isNaN(userLevel)) {
                            const pageText = tempDiv.textContent || '';

                            // 方法1: 检测 "信任级别 X 的要求" + "已达到/未达到" 模式
                            // 例如: "信任级别 3 的要求 已达到" 表示用户等级为3
                            // 例如: "信任级别 3 的要求 未达到" 表示用户等级为2
                            const levelRequirementMatch = pageText.match(/信任级别\s*(\d+)\s*的要求\s*(已达到|未达到)/);
                            if (levelRequirementMatch) {
                                const targetLevel = parseInt(levelRequirementMatch[1]);
                                const status = levelRequirementMatch[2];
                                if (status === '已达到') {
                                    userLevel = targetLevel;
                                    console.log(`检测到"已达到信任级别${targetLevel}的要求"，用户等级: ${userLevel}`);
                                } else {
                                    // 未达到表示等级比目标低一级
                                    userLevel = targetLevel - 1;
                                    console.log(`检测到"未达到信任级别${targetLevel}的要求"，用户等级: ${userLevel}`);
                                }
                                currentLevel = String(userLevel);
                            }

                            // 方法2: 检测 "已达到/不符合信任级别 X 要求" 模式
                            // 例如: "已达到信任级别 3 要求，请保持" 表示用户等级为3
                            // 例如: "不符合信任级别 3 要求，继续加油" 表示用户等级为2
                            if (isNaN(userLevel)) {
                                const statusMatch = pageText.match(/(已达到|不符合)信任级别\s*(\d+)\s*要求/);
                                if (statusMatch) {
                                    const status = statusMatch[1];
                                    const targetLevel = parseInt(statusMatch[2]);
                                    if (status === '已达到') {
                                        userLevel = targetLevel;
                                        console.log(`检测到"已达到信任级别${targetLevel}要求"，用户等级: ${userLevel}`);
                                    } else {
                                        // 不符合表示等级比目标低一级
                                        userLevel = targetLevel - 1;
                                        console.log(`检测到"不符合信任级别${targetLevel}要求"，用户等级: ${userLevel}`);
                                    }
                                    currentLevel = String(userLevel);
                                }
                            }
                        }

                        if (userLevel === 0 || userLevel === 1) {
                            console.log(`检测到${userLevel}级用户，使用summary.json获取数据`);
                            this.fetchLowLevelUserData(username, userLevel).then(resolve).catch(reject);
                        } else if (userLevel >= 2) {
                            console.log(`检测到${userLevel}级用户，使用connect.linux.do页面数据`);
                            const renderedFromConnect = this.processHighLevelUserData(tempDiv, globalUsername, currentLevel);
                            if (renderedFromConnect === false) {
                                reject(new Error('connect.linux.do account data parse failed'));
                                return;
                            }
                            resolve();
                        } else {
                            // 最后兜底：无法解析等级时，回退到 summary.json 获取数据
                            console.log('无法从 connect.linux.do 解析等级，回退到 summary.json');
                            this.fetchLowLevelUserData(username, 1).then(resolve).catch(reject);
                        }
                    } else {
                        // connect.linux.do 可能被 Cloudflare/权限策略拦截（常见 403）
                        // 降级到 summary.json，避免直接报错导致“加载信任等级失败”
                        console.warn(`[信任等级] connect.linux.do 请求失败(${response.status})，降级到 summary.json`);
                        this.fetchSummaryTrustLevelFallback(username)
                            .then(resolve)
                            .catch((fallbackErr) => {
                                reject(new Error(`请求失败，状态码: ${response.status}；降级也失败: ${fallbackErr.message}`));
                            });
                    }
                },
                onerror: (error) => {
                    console.error('GM_xmlhttpRequest 错误:', error);
                    // 网络异常时也降级
                    this.fetchSummaryTrustLevelFallback(username)
                        .then(resolve)
                        .catch((fallbackErr) => {
                            reject(new Error(`网络请求错误；降级也失败: ${fallbackErr.message}`));
                        });
                },
                ontimeout: () => {
                    console.error('GM_xmlhttpRequest 超时');
                    // 超时时也降级
                    this.fetchSummaryTrustLevelFallback(username)
                        .then(resolve)
                        .catch((fallbackErr) => {
                            reject(new Error(`请求超时；降级也失败: ${fallbackErr.message}`));
                        });
                }
            });
        });
    }

    // 处理0级和1级用户数据
    async fetchLowLevelUserData(username, currentLevel) {
        const summaryResponse = await fetch(`${BASE_URL}/u/${username}/summary.json`);
        if (summaryResponse.ok) {
            const data = await summaryResponse.json();
            const userSummary = data.user_summary;
            this.renderTrustLevelNew(username, currentLevel, userSummary);
        } else {
            throw new Error('无法获取用户summary数据');
        }
    }

    // connect.linux.do 不可用时的降级逻辑
    async fetchSummaryTrustLevelFallback(username) {
        const safeUsername = encodeURIComponent(username || '');
        const summaryResponse = await fetch(`${BASE_URL}/u/${safeUsername}/summary.json`, {
            credentials: 'include'
        });

        if (!summaryResponse.ok) {
            throw new Error(`summary.json 请求失败(${summaryResponse.status})`);
        }

        const data = await summaryResponse.json();
        if (!data || !data.user_summary) {
            throw new Error('summary.json 返回数据不完整');
        }

        // 复用现有渲染逻辑：
        // TL0/TL1 走配置化进度；TL2+ 走默认展示
        this.renderTrustLevel(data, username);
    }

    // 处理2级及以上用户数据
    processHighLevelUserData(tempDiv, globalUsername, currentLevel) {
        let targetInfoDiv = null;

        // 方案1: 新版页面结构 - div.card 包含 h2.card-title
        const cardDivs = tempDiv.querySelectorAll('div.card');
        for (let i = 0; i < cardDivs.length; i++) {
            const div = cardDivs[i];
            const h2 = div.querySelector('h2.card-title');
            if (h2 && h2.textContent.includes('信任级别') && h2.textContent.includes('的要求')) {
                targetInfoDiv = div;
                break;
            }
        }

        // 方案2: 旧版页面结构 - div.bg-white.p-6.rounded-lg
        if (!targetInfoDiv) {
            const potentialDivs = tempDiv.querySelectorAll('div.bg-white.p-6.rounded-lg');
            for (let i = 0; i < potentialDivs.length; i++) {
                const div = potentialDivs[i];
                const h2 = div.querySelector('h2');
                if (h2 && h2.textContent.includes('信任级别')) {
                    targetInfoDiv = div;
                    break;
                }
            }
        }

        // 方案3: 通用查找 - 任何包含"信任级别 X 的要求"的容器
        if (!targetInfoDiv) {
            const allDivs = tempDiv.querySelectorAll('div');
            for (let i = 0; i < allDivs.length; i++) {
                const div = allDivs[i];
                const headings = div.querySelectorAll('h1, h2, h3');
                for (let j = 0; j < headings.length; j++) {
                    if (headings[j].textContent.includes('信任级别') && headings[j].textContent.includes('的要求')) {
                        targetInfoDiv = div;
                        break;
                    }
                }
                if (targetInfoDiv) break;
            }
        }

        // 方案4: 如果仍然找不到，回退到使用summary.json获取数据
        if (!targetInfoDiv) {
            console.log('未找到信任级别数据块，回退到使用summary.json');
            return false;
        }

        // 解析标题获取目标等级
        const h2 = targetInfoDiv.querySelector('h2');
        const titleMatch = h2.textContent.match(/信任级别\s*(\d+)\s*的要求/);
        const targetLevel = titleMatch ? titleMatch[1] : '未知';

        // 解析数据 - 优先尝试新版视觉组件，回退到旧版表格
        const requirements = [];

        // === 新版页面结构: 环形图 + 条形图 + 配额卡片 + 否决项 ===
        // 1. 解析环形图 (tl3-ring) - 活跃程度指标
        const rings = targetInfoDiv.querySelectorAll('.tl3-ring');
        rings.forEach((ring) => {
            const label = ring.querySelector('.tl3-ring-label');
            const circle = ring.querySelector('.tl3-ring-circle');
            const currentEl = ring.querySelector('.tl3-ring-current');
            const targetEl = ring.querySelector('.tl3-ring-target');
            if (label && currentEl) {
                const name = label.textContent.trim();
                const current = currentEl.textContent.trim();
                // 从 "/ 50" 格式中提取要求值
                const required = targetEl ? targetEl.textContent.replace(/^[\s/]+/, '').trim() : '';
                const isMet = circle ? circle.classList.contains('met') : false;
                requirements.push({ name, current, required, isMet });
            }
        });

        // 2. 解析条形图 (tl3-bar-item) - 互动参与指标
        const bars = targetInfoDiv.querySelectorAll('.tl3-bar-item');
        bars.forEach((bar) => {
            const labelEl = bar.querySelector('.tl3-bar-label');
            const numsEl = bar.querySelector('.tl3-bar-nums');
            if (labelEl && numsEl) {
                const name = labelEl.textContent.trim();
                const numsText = numsEl.textContent.trim(); // 格式: "116/10"
                const parts = numsText.split('/');
                const current = parts[0] ? parts[0].trim() : numsText;
                const required = parts[1] ? parts[1].trim() : '';
                const isMet = numsEl.classList.contains('met');
                requirements.push({ name, current, required, isMet });
            }
        });

        // 3. 解析配额卡片 (tl3-quota-card) - 合规记录指标
        const quotas = targetInfoDiv.querySelectorAll('.tl3-quota-card');
        quotas.forEach((quota) => {
            const labelEl = quota.querySelector('.tl3-quota-label');
            const numsEl = quota.querySelector('.tl3-quota-nums');
            if (labelEl && numsEl) {
                const name = labelEl.textContent.trim();
                const numsText = numsEl.textContent.trim(); // 格式: "0 / 5"
                const parts = numsText.split('/');
                const current = parts[0] ? parts[0].trim() : numsText;
                const required = parts[1] ? parts[1].trim() : '';
                const isMet = quota.classList.contains('met');
                requirements.push({ name, current, required, isMet });
            }
        });

        // 4. 解析否决项 (tl3-veto-item) - 被禁言/被封禁
        const vetos = targetInfoDiv.querySelectorAll('.tl3-veto-item');
        vetos.forEach((veto) => {
            const labelEl = veto.querySelector('.tl3-veto-label');
            const valueEls = veto.querySelectorAll('.tl3-veto-value');
            if (labelEl && valueEls.length) {
                const name = labelEl.textContent.trim();
                const isMet = veto.classList.contains('met');
                let current = '0';
                const required = '0'; // 否决项要求为0

                if (isMet) {
                    current = valueEls[0].textContent.trim() || '0';
                } else {
                    // 未达标时，前面通常是 front(展示 0)，后面是 back(真实值)，优先取最后一个
                    current = valueEls[valueEls.length - 1].textContent.trim() || '0';
                }

                requirements.push({ name, current, required, isMet });
            }
        });

        // === 旧版页面结构回退: 表格解析 ===
        if (requirements.length === 0) {
            const tableRows = targetInfoDiv.querySelectorAll('table tbody tr');
            tableRows.forEach((row) => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    const name = cells[0].textContent.trim();
                    const required = cells[1].textContent.trim();
                    const current = cells[2].textContent.trim();
                    const isMet = cells[2].classList.contains('status-met') || cells[2].classList.contains('text-green-500');
                    requirements.push({ name, current, required, isMet });
                }
            });
        }

        // 渲染高级等级信息
        this.renderAdvancedTrustLevel(globalUsername, targetLevel, requirements);
    }

    // 新的渲染方法（基于1.js的逻辑，用于0级和1级用户）
    renderTrustLevelNew(username, currentLevel, userSummary) {
        const targetLevel = currentLevel + 1;
        const requirements = CONFIG.levelRequirements[currentLevel];

        if (!requirements) {
            this.trustLevelContainer.innerHTML = '<div class="trust-level-loading">无配置数据</div>';
            return;
        }

        const trustLevelDetails = {
            items: [],
            achievedCount: 0,
            totalCount: 0
        };

        // 检查各项要求
        Object.entries(requirements).forEach(([key, requiredValue]) => {
            let currentValue = 0;
            let label = '';
            let isMet = false;

            switch (key) {
                case 'topics_entered':
                    currentValue = userSummary.topics_entered || 0;
                    label = '浏览的话题';
                    isMet = currentValue >= requiredValue;
                    break;
                case 'posts_read_count':
                    currentValue = userSummary.posts_read_count || 0;
                    label = '浏览帖子';
                    isMet = currentValue >= requiredValue;
                    break;
                case 'time_read':
                    currentValue = Math.floor((userSummary.time_read || 0) / 60);
                    label = '阅读时长(分)';
                    isMet = (userSummary.time_read || 0) >= requiredValue;
                    requiredValue = Math.floor(requiredValue / 60);
                    break;
                case 'days_visited':
                    currentValue = userSummary.days_visited || 0;
                    label = '访问天数';
                    isMet = currentValue >= requiredValue;
                    break;
                case 'likes_given':
                    currentValue = userSummary.likes_given || 0;
                    label = '给出的赞';
                    isMet = currentValue >= requiredValue;
                    break;
                case 'likes_received':
                    currentValue = userSummary.likes_received || 0;
                    label = '收到的赞';
                    isMet = currentValue >= requiredValue;
                    break;
                case 'post_count':
                    currentValue = userSummary.post_count || 0;
                    label = '帖子数量';
                    isMet = currentValue >= requiredValue;
                    break;
            }

            if (label) {
                trustLevelDetails.items.push({
                    name: label,
                    current: currentValue,
                    required: requiredValue,
                    isMet: isMet
                });

                if (isMet) {
                    trustLevelDetails.achievedCount++;
                }
                trustLevelDetails.totalCount++;
            }
        });

        const achievedCount = trustLevelDetails.achievedCount;
        const totalCount = trustLevelDetails.totalCount;
        const allMet = achievedCount === totalCount;

        const levelNames = {
            0: 'Lv0 → Lv1',
            1: 'Lv1 → Lv2'
        };

        // 获取昨日数据用于对比
        const yesterdaySnapshot = this.getYesterdaySnapshot(username);

        // 判断是否已满足所有要求，决定标题显示
        const headerTitle = allMet
            ? `Lv${targetLevel} ✓`
            : (levelNames[currentLevel] || `Lv${currentLevel} → Lv${targetLevel}`);

        let html = `
            <div class="trust-level-header">
                <span>📊 ${headerTitle} (${username})</span>
                <button class="trust-level-refresh" data-action="refresh">🔄 刷新</button>
            </div>
        `;

        trustLevelDetails.items.forEach(req => {
            const progress = Math.min((req.current / req.required) * 100, 100);
            const isCompleted = req.isMet;
            const fillClass = isCompleted ? 'completed' : '';

            // 计算与昨日的变化
            const diff = this.calculateDataChange(req.current, yesterdaySnapshot, req.name);
            const changeIndicator = this.generateChangeIndicator(diff);

            // 检查是否是负面指标（需要红色显示当前值）
            const isNegativeIndicator = req.name.includes('被禁言') || req.name.includes('被封禁') || req.name.includes('被举报的帖子') || req.name.includes('发起举报的用户');
            const currentValueHtml = isNegativeIndicator ? `<span style="color: #ff6b6b;">${req.current}</span>` : req.current;

            html += `
                <div class="trust-level-item">
                    <span class="trust-level-name">${req.name}</span>
                    <div class="trust-level-progress">
                        <div class="trust-level-bar">
                            <div class="trust-level-bar-fill ${fillClass}" style="width: ${progress}%"></div>
                        </div>
                        <span class="trust-level-value">${currentValueHtml}/${req.required}${changeIndicator}</span>
                    </div>
                </div>
            `;
        });

        if (allMet) {
            html += `
                <div style="background: rgba(255, 255, 255, 0.25); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: #fff; font-size: 11px; font-weight: 600; text-align: center;">
                        ✅ 已满足 Lv${targetLevel} 要求
                    </div>
                </div>
            `;
        } else {
            const unmetCount = totalCount - achievedCount;
            html += `
                <div style="background: rgba(255, 255, 255, 0.15); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 11px; font-weight: 500; text-align: center;">
                        还需完成 ${unmetCount} 项升级到 Lv${targetLevel}
                    </div>
                </div>
            `;
        }

        this.trustLevelContainer.innerHTML = html;

        // 保存缓存数据
        this.saveTrustLevelCache(username, {
            type: 'low_level',
            username,
            currentLevel,
            targetLevel,
            items: trustLevelDetails.items,
            achievedCount,
            totalCount,
            allMet
        });

        this.bindTrustLevelRefresh();
    }

    // 渲染信任等级信息（支持 TL0->TL1 和 TL1->TL2 - 基于 summary.json）
    renderTrustLevel(data, username) {
        const summary = data.user_summary;
        if (!summary) {
            this.trustLevelContainer.innerHTML = '<div class="trust-level-loading">无数据</div>';
            return;
        }

        // 获取当前信任等级
        // 优先从 user_summary 中获取，如果没有则从外层获取
        const currentLevel = summary.trust_level !== undefined ? summary.trust_level :
                           (data.user && data.user.trust_level !== undefined ? data.user.trust_level : 1);
        const targetLevel = currentLevel + 1;

        // 根据当前等级获取对应的升级要求
        const levelConfig = CONFIG.levelRequirements[currentLevel];

        if (!levelConfig) {
            // 如果没有配置（比如已经是最高等级），使用原来的逻辑
            this.renderDefaultTrustLevel(summary, username);
            return;
        }

        const requirements = [];

        // 根据配置动态构建要求列表
        Object.entries(levelConfig).forEach(([key, requiredValue]) => {
            let currentValue = 0;
            let label = '';

            switch (key) {
                case 'topics_entered':
                    currentValue = summary.topics_entered || 0;
                    label = '浏览的话题';
                    break;
                case 'posts_read_count':
                    currentValue = summary.posts_read_count || 0;
                    label = '浏览帖子';
                    break;
                case 'time_read':
                    currentValue = Math.floor((summary.time_read || 0) / 60);
                    label = '阅读时长(分)';
                    requiredValue = Math.floor(requiredValue / 60);
                    break;
                case 'days_visited':
                    currentValue = summary.days_visited || 0;
                    label = '访问天数';
                    break;
                case 'likes_given':
                    currentValue = summary.likes_given || 0;
                    label = '给出的赞';
                    break;
                case 'likes_received':
                    currentValue = summary.likes_received || 0;
                    label = '收到的赞';
                    break;
                case 'post_count':
                    currentValue = summary.post_count || 0;
                    label = '帖子数量';
                    break;
            }

            if (label) {
                requirements.push({
                    name: label,
                    current: currentValue,
                    required: requiredValue
                });
            }
        });

        // 计算达标数量
        const achievedCount = requirements.filter(req => req.current >= req.required).length;
        const totalCount = requirements.length;
        const allMet = achievedCount === totalCount;

        const levelNames = {
            0: 'Lv0 → Lv1',
            1: 'Lv1 → Lv2',
            2: 'Lv2 → Lv3',
            3: 'Lv3 → Lv4'
        };

        // 获取昨日数据用于对比
        const yesterdaySnapshot = this.getYesterdaySnapshot(username);

        let html = `
            <div class="trust-level-header">
                <span>📊 ${levelNames[currentLevel] || `Lv${currentLevel} → Lv${targetLevel}`} (${username})</span>
                <button class="trust-level-refresh" data-action="refresh">🔄 刷新</button>
            </div>
        `;

        requirements.forEach(req => {
            const progress = Math.min((req.current / req.required) * 100, 100);
            const isCompleted = req.current >= req.required;
            const fillClass = isCompleted ? 'completed' : '';

            // 计算与昨日的变化
            const diff = this.calculateDataChange(req.current, yesterdaySnapshot, req.name);
            const changeIndicator = this.generateChangeIndicator(diff);

            // 检查是否是负面指标（需要红色显示当前值）
            const isNegativeIndicator = req.name.includes('被禁言') || req.name.includes('被封禁') || req.name.includes('被举报的帖子') || req.name.includes('发起举报的用户');
            const currentValueHtml = isNegativeIndicator ? `<span style="color: #ff6b6b;">${req.current}</span>` : req.current;

            html += `
                <div class="trust-level-item">
                    <span class="trust-level-name">${req.name}</span>
                    <div class="trust-level-progress">
                        <div class="trust-level-bar">
                            <div class="trust-level-bar-fill ${fillClass}" style="width: ${progress}%"></div>
                        </div>
                        <span class="trust-level-value">${currentValueHtml}/${req.required}${changeIndicator}</span>
                    </div>
                </div>
            `;
        });

        // 在数据下方添加总结信息
        if (allMet) {
            html += `
                <div style="background: rgba(255, 255, 255, 0.25); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: #fff; font-size: 11px; font-weight: 600; text-align: center;">
                        ✅ 已满足 Lv${targetLevel} 要求
                    </div>
                </div>
            `;
        } else {
            const unmetCount = totalCount - achievedCount;
            html += `
                <div style="background: rgba(255, 255, 255, 0.15); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 11px; font-weight: 500; text-align: center;">
                        还需完成 ${unmetCount} 项升级到 Lv${targetLevel}
                    </div>
                </div>
            `;
        }

        this.trustLevelContainer.innerHTML = html;

        // 保存缓存数据（idcflare.com）
        const cacheItems = requirements.map(req => ({
            name: req.name,
            current: req.current,
            required: req.required,
            isMet: req.current >= req.required
        }));
        this.saveTrustLevelCache(username, {
            type: 'low_level',
            username,
            currentLevel,
            targetLevel,
            items: cacheItems,
            achievedCount,
            totalCount,
            allMet
        });

        this.bindTrustLevelRefresh();
    }

    // 默认渲染方法（用于没有配置的等级）
    renderDefaultTrustLevel(summary, username) {
        const requirements = [
            { name: '访问天数', current: summary.days_visited, required: 15 },
            { name: '给出的赞', current: summary.likes_given, required: 1 },
            { name: '收到的赞', current: summary.likes_received, required: 1 },
            { name: '帖子数量', current: summary.post_count, required: 3 },
            { name: '进入主题', current: summary.topics_entered, required: 20 },
            { name: '浏览帖子', current: summary.posts_read_count, required: 100 },
            { name: '阅读时长(分)', current: Math.floor(summary.time_read / 60), required: 60 }
        ];

        // 计算达标数量
        const achievedCount = requirements.filter(req => req.current >= req.required).length;
        const totalCount = requirements.length;
        const allMet = achievedCount === totalCount;

        let html = `
            <div class="trust-level-header">
                <span>📊 等级 (L2+) (${username || ''})</span>
                <button class="trust-level-refresh" data-action="refresh">🔄 刷新</button>
            </div>
        `;

        // 添加总结信息
        if (allMet) {
            html += `
                <div style="background: rgba(16, 185, 129, 0.2); padding: 6px 8px; border-radius: 6px; margin: 6px 0;">
                    <div style="color: #10b981; font-size: 11px; font-weight: 600; text-align: center;">
                        🎉 所有要求已达标！
                    </div>
                </div>
            `;
        } else {
            const unmetCount = totalCount - achievedCount;
            html += `
                <div style="background: rgba(251, 146, 60, 0.2); padding: 6px 8px; border-radius: 6px; margin: 6px 0;">
                    <div style="color: #ea580c; font-size: 11px; font-weight: 600; text-align: center;">
                        还需完成 ${unmetCount} 项要求
                    </div>
                </div>
            `;
        }

        requirements.forEach(req => {
            const progress = Math.min((req.current / req.required) * 100, 100);
            const isCompleted = req.current >= req.required;
            const fillClass = isCompleted ? 'completed' : '';

            // 检查是否是负面指标（需要红色显示当前值）
            const isNegativeIndicator = req.name.includes('被禁言') || req.name.includes('被封禁') || req.name.includes('被举报的帖子') || req.name.includes('发起举报的用户');
            const currentValueHtml = isNegativeIndicator ? `<span style="color: #ff6b6b;">${req.current}</span>` : req.current;

            html += `
                <div class="trust-level-item">
                    <span class="trust-level-name">${req.name}</span>
                    <div class="trust-level-progress">
                        <div class="trust-level-bar">
                            <div class="trust-level-bar-fill ${fillClass}" style="width: ${progress}%"></div>
                        </div>
                        <span class="trust-level-value">${currentValueHtml}/${req.required}</span>
                    </div>
                </div>
            `;
        });

        this.trustLevelContainer.innerHTML = html;

        this.bindTrustLevelRefresh();
    }

    // 渲染高级信任等级信息（从 connect.linux.do 获取的TL2+数据）
    renderAdvancedTrustLevel(username, targetLevel, requirements) {
        const achievedCount = requirements.filter(r => r.isMet).length;
        const totalCount = requirements.length;

        // 计算当前等级
        const currentLevel = parseInt(targetLevel) - 1;

        // 等级名称映射（简化显示）
        const levelNames = {
            2: 'Lv1 → Lv2',
            3: 'Lv2 → Lv3',
            4: 'Lv3 → Lv4'
        };

        // 获取昨日数据用于对比
        const yesterdaySnapshot = this.getYesterdaySnapshot(username);

        // 判断是否已满足所有要求，决定标题显示
        const allRequirementsMet = achievedCount === totalCount;
        const headerTitle = allRequirementsMet
            ? `Lv${targetLevel} ✓`
            : (levelNames[targetLevel] || `Lv${currentLevel} → Lv${targetLevel}`);

        let html = `
            <div class="trust-level-header">
                <span>📊 ${headerTitle} (${username})</span>
                <button class="trust-level-refresh" data-action="refresh">🔄 刷新</button>
            </div>
        `;

        requirements.forEach(req => {
            // 尝试从文本中提取数字
            const currentMatch = req.current.match(/(\d+)/);
            const requiredMatch = req.required.match(/(\d+)/);

            const currentNum = currentMatch ? parseInt(currentMatch[1]) : 0;
            const requiredNum = requiredMatch ? parseInt(requiredMatch[1]) : 1;

            const progress = Math.min((currentNum / requiredNum) * 100, 100);
            const isCompleted = req.isMet;
            const fillClass = isCompleted ? 'completed' : '';

            // 简化标签名称
            let simpleName = req.name
                .replace('已读帖子（所有时间）', '浏览帖子')
                .replace('浏览的话题（所有时间）', '浏览话题')
                .replace('访问次数（过去', '访问次数(')
                .replace('个月）', '月)')
                .replace('回复次数（最近', '回复(近')
                .replace('天内）', '天)');

            // 计算与昨日的变化（使用简化后的名称匹配）
            const diff = this.calculateDataChange(currentNum, yesterdaySnapshot, simpleName);
            const changeIndicator = this.generateChangeIndicator(diff);

            // 检查是否是负面指标（需要红色显示当前值）
            const isNegativeIndicator = req.name.includes('被禁言') || req.name.includes('被封禁') || req.name.includes('被举报的帖子') || req.name.includes('发起举报的用户');
            const currentValueHtml = isNegativeIndicator ? `<span style="color: #ff6b6b;">${req.current}</span>` : req.current;

            html += `
                <div class="trust-level-item">
                    <span class="trust-level-name">${simpleName}</span>
                    <div class="trust-level-progress">
                        <div class="trust-level-bar">
                            <div class="trust-level-bar-fill ${fillClass}" style="width: ${progress}%"></div>
                        </div>
                        <span class="trust-level-value">${currentValueHtml}/${req.required}${changeIndicator}</span>
                    </div>
                </div>
            `;
        });

        // 在数据下方添加总结信息
        if (achievedCount === totalCount) {
            html += `
                <div style="background: rgba(255, 255, 255, 0.25); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: #fff; font-size: 11px; font-weight: 600; text-align: center;">
                        ✅ 已满足 Lv${targetLevel} 要求
                    </div>
                </div>
            `;
        } else {
            const unmetCount = totalCount - achievedCount;
            html += `
                <div style="background: rgba(255, 255, 255, 0.15); padding: 6px 8px; border-radius: 6px; margin: 6px 0 0 0;">
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 11px; font-weight: 500; text-align: center;">
                        还需完成 ${unmetCount} 项升级到 Lv${targetLevel}
                    </div>
                </div>
            `;
        }

        this.trustLevelContainer.innerHTML = html;

        // 保存缓存数据
        this.saveTrustLevelCache(username, {
            type: 'high_level',
            username,
            targetLevel,
            currentLevel,
            requirements,
            achievedCount,
            totalCount
        });

        this.bindTrustLevelRefresh();
    }

    bindTrustLevelRefresh() {
        this.trustLevelContainer
            ?.querySelector('.trust-level-refresh')
            ?.addEventListener('click', () => this.loadUserTrustLevel(true), { once: true });
    }

    // 加载用户阅读历史
    async loadUserReadHistory() {
        const username = await this.getCurrentUsername();
        if (!username) {
            console.log('未获取到用户名，无法加载阅读历史');
            this.readTopics = [];
            this.readTopicIds = new Set();
            return;
        }
        // 从 localStorage 加载该用户的阅读历史
        const storageKey = `readTopics_${username}`;
        const storedTopics = Storage.get(storageKey, []);
        const normalizedTopics = Array.isArray(storedTopics)
            ? storedTopics.map(topicId => String(topicId)).filter(Boolean)
            : [];
        this.readTopics = [...new Set(normalizedTopics)].slice(-10000);
        this.readTopicIds = new Set(this.readTopics);
        if (this.readTopics.length !== normalizedTopics.length ||
            normalizedTopics.some((topicId, index) => topicId !== storedTopics[index])) {
            Storage.set(storageKey, this.readTopics);
        }
        console.log(`已加载用户 ${username} 的阅读历史，共 ${this.readTopics.length} 篇帖子`);

        // 页面打开时只读取账号信息缓存，不发起网络请求。
        this.loadCachedOfficialPostsReadCount(username);
    }

    isAccountBrowsePostsName(name) {
        const normalizedName = String(name ?? '')
            .replace(/[\s（）()]/g, '')
            .replace('所有时间', '');
        return normalizedName === '浏览帖子' ||
            normalizedName === '已读帖子' ||
            normalizedName === '阅读帖子';
    }

    getAccountBrowsePostsCount(trustLevelData) {
        if (!trustLevelData) return null;

        const items = trustLevelData.type === 'low_level'
            ? trustLevelData.items
            : trustLevelData.requirements;
        if (!Array.isArray(items)) return null;

        const browsePostsItem = items.find(item => this.isAccountBrowsePostsName(item?.name));

        // 账号卡片格式为 current/required，例如 15545/20000。
        // 底部统计只显示左侧 current，绝不使用右侧升级要求 required。
        return this.parseDisplayedLikeCount(browsePostsItem?.current);
    }

    getDisplayedAccountBrowsePostsCount() {
        const rows = this.trustLevelContainer?.querySelectorAll('.trust-level-item') || [];
        for (const row of rows) {
            const name = row.querySelector('.trust-level-name')?.textContent;
            if (!this.isAccountBrowsePostsName(name)) continue;

            const currentText = row.querySelector('.trust-level-value')?.textContent?.split('/')[0];
            return this.parseDisplayedLikeCount(currentText);
        }
        return null;
    }

    loadCachedOfficialPostsReadCount(username) {
        const cached = Storage.get(`officialPostsRead_${CURRENT_DOMAIN}_${username}`, null);
        const cachedValue = cached?.source === 'account_recent_100_days' && cached?.periodDays === 100
            ? Number(cached.value)
            : NaN;
        this.officialPostsReadCount = Number.isFinite(cachedValue) && cachedValue >= 0
            ? Math.floor(cachedValue)
            : null;
        this.updateReadStatsDisplay();
    }

    applyOfficialPostsReadCount(value, username) {
        const normalizedValue = Number(value);
        if (!Number.isFinite(normalizedValue) || normalizedValue < 0) return false;

        this.officialPostsReadCount = Math.floor(normalizedValue);
        Storage.set(`officialPostsRead_${CURRENT_DOMAIN}_${username}`, {
            value: this.officialPostsReadCount,
            source: 'account_recent_100_days',
            periodDays: 100,
            timestamp: Date.now()
        });
        this.updateReadStatsDisplay();
        return true;
    }

    extractRecent100DaysPostsRead(html) {
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const candidates = Array.from(doc.querySelectorAll('tr, li, article, section, .requirement, .card, .row, .item, div'));
        let best = null;
        for (const element of candidates) {
            const text = element.textContent?.replace(/\s+/g, ' ').trim() || '';
            if (text.length > 260) continue;
            if (!/(?:浏览|已读|阅读)帖子/.test(text) || !/(?:近|最近|过去)?\s*100\s*天/.test(text)) continue;
            const valueText = element.querySelector('[data-current], .current, .value, .requirement-value, strong, b')?.textContent || text;
            const numbers = [...valueText.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)]
                .map(match => Number(match[0]))
                .filter(Number.isFinite);
            const withoutPeriod = numbers.filter(value => value !== 100);
            if (!withoutPeriod.length) continue;
            const value = withoutPeriod[0];
            const score = (element.matches('tr, li, .requirement, .row, .item') ? 10 : 0) - text.length / 1000;
            if (!best || score > best.score) best = { value, score, text };
        }
        return best?.value ?? null;
    }

    fetchRecent100DaysPostsRead() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://connect.linux.do/',
                timeout: 15000,
                onload: response => {
                    if (response.status !== 200) {
                        reject(new Error(`账户页面请求失败(${response.status})`));
                        return;
                    }
                    const value = this.extractRecent100DaysPostsRead(response.responseText);
                    if (!Number.isFinite(value)) {
                        reject(new Error('账户页面未找到“近 100 天浏览帖子”字段'));
                        return;
                    }
                    resolve(value);
                },
                onerror: error => reject(error instanceof Error ? error : new Error('账户页面请求失败')),
                ontimeout: () => reject(new Error('账户页面请求超时'))
            });
        });
    }

    async syncOfficialPostsReadCount(showResult = false) {
        if (this.officialReadCountSyncing) {
            this.officialReadCountSyncPending = true;
            return false;
        }
        const currentUsername = await this.getCurrentUsername();
        if (!currentUsername) return false;
        this.officialReadCountSyncing = true;
        this.updateReadStatsDisplay();
        try {
            // 账号信息卡片已经按站点账户页规则取得统计数据。
            // 强制刷新卡片后读取“浏览帖子”一行 current/required 左侧的 current，
            // 例如 18142/20000 只取 18142，不再另外解析 connect 页面文字。
            await this.loadUserTrustLevel(true);
            const accountBrowsePostsValue = this.getDisplayedAccountBrowsePostsCount();
            if (!this.applyOfficialPostsReadCount(accountBrowsePostsValue, currentUsername)) {
                throw new Error('账号信息中缺少“浏览帖子”当前值');
            }

            if (showResult) this.showNotification(this.t('accountPostsReadSyncSuccess'));
            return true;
        } catch (error) {
            console.warn('[浏览帖子] 同步失败:', error);
            if (showResult) this.showNotification(this.t('accountPostsReadSyncFailed'));
            return false;
        } finally {
            this.officialReadCountSyncing = false;
            this.updateReadStatsDisplay();
            if (this.officialReadCountSyncPending) {
                this.officialReadCountSyncPending = false;
                void this.syncOfficialPostsReadCount();
            }
        }
    }

    // 保存用户阅读历史
    async saveUserReadHistory(topicId) {
        const username = await this.getCurrentUsername();
        if (!username) {
            console.log('未获取到用户名，无法保存阅读历史');
            return false;
        }

        const normalizedTopicId = String(topicId ?? '');
        if (!normalizedTopicId) return false;

        // 添加到已读列表（避免重复）
        if (!this.readTopicIds.has(normalizedTopicId)) {
            this.readTopics.push(normalizedTopicId);
            this.readTopicIds.add(normalizedTopicId);

            // 扩大历史容量，降低旧帖被淘汰后再次阅读的概率
            if (this.readTopics.length > 10000) {
                this.readTopics = this.readTopics.slice(-10000);
                this.readTopicIds = new Set(this.readTopics);
            }

            // 保存到 localStorage
            const storageKey = `readTopics_${username}`;
            Storage.set(storageKey, this.readTopics);
            console.log(`已保存帖子 ${normalizedTopicId} 到用户 ${username} 的阅读历史`);
            return true;
        }
        return false;
    }

    // 检查帖子是否已读
    isTopicRead(topicId) {
        return this.readTopicIds.has(String(topicId));
    }

    // 加载今日阅读统计
    loadTodayReadCount() {
        const now = new Date();
        const today = this.getLocalDateKey();
        const savedData = Storage.get('todayReadStats', null);
        const savedDate = savedData?.date;
        const isToday = savedDate === today || savedDate === now.toDateString();

        if (isToday) {
            const topicIds = Array.isArray(savedData.topicIds)
                ? [...new Set(savedData.topicIds.map(id => String(id)).filter(Boolean))]
                : [];
            this.todayReadTopicIds = new Set(topicIds);
            const count = Math.max(topicIds.length, Number(savedData.count) || 0);
            Storage.set('todayReadStats', { date: today, count, topicIds });
            return count;
        }

        this.todayReadTopicIds = new Set();
        Storage.set('todayReadStats', { date: today, count: 0, topicIds: [] });
        return 0;
    }

    // 增加今日阅读计数；账号累计已读由 summary.json 提供
    incrementTodayReadCount(topicId) {
        const today = this.getLocalDateKey();
        const savedData = Storage.get('todayReadStats', null);
        if (savedData?.date !== today) {
            this.todayReadCount = 0;
            this.todayReadTopicIds = new Set();
        }

        const normalizedTopicId = String(topicId ?? '');
        if (!normalizedTopicId || this.todayReadTopicIds.has(normalizedTopicId)) {
            return false;
        }

        this.todayReadTopicIds.add(normalizedTopicId);
        this.todayReadCount++;

        Storage.set('todayReadStats', {
            date: today,
            count: this.todayReadCount,
            topicIds: [...this.todayReadTopicIds]
        });
        console.log(`今日已阅读 ${this.todayReadCount} 篇不同帖子，账号浏览帖子 ${this.officialPostsReadCount ?? '待同步'} 篇`);
        this.updateReadStatsDisplay();
        return true;
    }

    formatReadingElapsed(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const pad = value => String(value).padStart(2, '0');
        return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }

    getReadingElapsedMs() {
        if (this.readingStartedAt > 0) return Math.max(0, Date.now() - this.readingStartedAt);
        return this.lastReadingElapsedMs || 0;
    }

    startReadingTimer(resume = false) {
        if (this.readingTimerInterval) clearInterval(this.readingTimerInterval);
        if (!resume || !Number.isFinite(this.readingStartedAt) || this.readingStartedAt <= 0) {
            this.readingStartedAt = Date.now();
            this.lastReadingElapsedMs = 0;
            this.setSessionStorage('lastReadingElapsedMs', 0);
        }
        this.setSessionStorage('readingStartedAt', this.readingStartedAt);
        this.updateReadStatsDisplay();
        this.readingTimerInterval = setInterval(() => {
            if (!this.autoRunning) {
                clearInterval(this.readingTimerInterval);
                this.readingTimerInterval = null;
                return;
            }
            this.updateReadStatsDisplay();
        }, 1000);
    }

    stopReadingTimer() {
        if (this.readingTimerInterval) {
            clearInterval(this.readingTimerInterval);
            this.readingTimerInterval = null;
        }
        if (this.readingStartedAt > 0) {
            this.lastReadingElapsedMs = Math.max(0, Date.now() - this.readingStartedAt);
            this.setSessionStorage('lastReadingElapsedMs', this.lastReadingElapsedMs);
        }
        this.readingStartedAt = 0;
        this.setSessionStorage('readingStartedAt', 0);
        this.updateReadStatsDisplay();
    }

    // 更新阅读统计显示
    updateReadStatsDisplay() {
        if (!this.readStatsContainer) return;

        const todayCount = this.todayReadCount || 0;
        const elapsedDisplay = this.formatReadingElapsed(this.getReadingElapsedMs());
        const remainingCount = this.getDisplayedRemainingCount();
        const officialReadDisplay = this.officialReadCountSyncing
            ? '…'
            : Number.isFinite(this.officialPostsReadCount)
                ? this.officialPostsReadCount
                : '--';

        this.readStatsContainer.style.display = 'grid';
        this.readStatsContainer.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        this.readStatsContainer.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 10px; color: rgba(255,255,255,0.7);">📅 ${this.t('todayRead')}</div>
                <div style="font-size: 16px; font-weight: bold; color: #7dffb3;">${todayCount}</div>
            </div>
            <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.2);"></div>
            <div style="text-align: center;">
                <div style="font-size: 10px; color: rgba(255,255,255,0.7);">📬 ${this.t('remainingTopics')}</div>
                <div style="font-size: 16px; font-weight: bold; color: #87ceeb;">${remainingCount}</div>
            </div>
            <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.2);"></div>
            <button type="button" class="official-posts-read-sync" title="${this.t('accountPostsReadTip')}" style="appearance: none; border: 0; background: transparent; color: inherit; padding: 0; text-align: center; cursor: pointer; min-width: 58px;">
                <div style="font-size: 10px; color: rgba(255,255,255,0.7);">📚 ${this.t('accountPostsRead')}</div>
                <div style="font-size: 16px; font-weight: bold; color: #ffd700;">${officialReadDisplay}</div>
            </button>
        `;
        const syncButton = this.readStatsContainer.querySelector('.official-posts-read-sync');
        if (syncButton) {
            syncButton.disabled = this.officialReadCountSyncing;
            syncButton.addEventListener('click', () => void this.syncOfficialPostsReadCount(true), { once: true });
        }
        Array.from(this.readStatsContainer.children).forEach(child => {
            if (child instanceof HTMLDivElement && child.style.width === '1px') child.remove();
        });
        const accountSyncButton = this.readStatsContainer.querySelector('.official-posts-read-sync');
        accountSyncButton?.insertAdjacentHTML('beforebegin', `
            <div style="text-align: center; padding: 3px 0;">
                <div style="font-size: 10px; color: rgba(255,255,255,0.7);">\u23F1\uFE0F ${this.t('readingTime')}</div>
                <div style="font-size: 16px; font-weight: bold; color: #ffb86c; font-variant-numeric: tabular-nums;">${elapsedDisplay}</div>
            </div>
        `);
        this.container?.querySelectorAll('.tab-remaining-badge').forEach(badge => {
            badge.textContent = String(remainingCount);
        });
    }

    // 生成本地日期键，避免 UTC 日期在零点附近误判
    getLocalDateKey() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }


    // 启动账号切换监控
    startUserSwitchMonitoring() {
        if (this.userSwitchMonitorInterval) {
            clearInterval(this.userSwitchMonitorInterval);
        }

        // 初始化当前用户
        this.getCurrentUsername().then(username => {
            this.lastDetectedUser = username;
        });

        // 每5秒检查一次是否切换账号
        this.userSwitchMonitorInterval = setInterval(async () => {
            if (this._checkingUserSwitch) return;
            this._checkingUserSwitch = true;

            try {
                const currentDetectedUser = await this.getCurrentUsername(true);

                if (currentDetectedUser && this.lastDetectedUser &&
                    currentDetectedUser !== this.lastDetectedUser) {
                    console.log(`检测到账号切换: ${this.lastDetectedUser} -> ${currentDetectedUser}`);
                    this.lastDetectedUser = currentDetectedUser;
                    this.currentUsername = currentDetectedUser;
                    this.topicList = [];
                    this.setSessionStorage('topicList', []);
                    this.readTopics = [];
                    this.readTopicIds = new Set();
                    this.officialPostsReadCount = null;
                    this.currentSessionReadCount = 0;
                    this.lastCountedTopicId = null;
                    this.setSessionStorage('currentSessionReadCount', 0);
                    this.setSessionStorage('lastCountedTopicId', null);
                    await this.loadUserReadHistory();

                    if (this.likeCounter) {
                        this.likeCounter.setCurrentUser({ username: currentDetectedUser });
                        this.likeCounter.syncRemote(true);
                    }

                    // 延迟一点时间再刷新，确保页面稳定
                    setTimeout(() => {
                        console.log('账号切换后重新加载等级信息');
                        this.loadUserTrustLevel(true);
                    }, 1000);
                } else if (currentDetectedUser) {
                    this.lastDetectedUser = currentDetectedUser;
                }
            } finally {
                this._checkingUserSwitch = false;
            }
        }, 5000);
    }

    initOnlyOwnerView() {
        this.createToggleButton();
        this.observePageChanges();
        this.toggleVisibility();
    }

    toggleVisibility() {
        const displayMode = localStorage.getItem("on_off") || "当前查看全部";
        const userId = document.getElementById("post_1")?.getAttribute('data-user-id');
        if (userId) {
            document.querySelectorAll('article').forEach(article => {
                article.style.display = (displayMode === "当前只看楼主" && article.dataset.userId !== userId) ? 'none' : '';
            });
        }
    }

    createToggleButton() {
        if (document.getElementById("toggleVisibilityBtn")) {
            return;
        }

        const btn = document.createElement("button");
        btn.id = "toggleVisibilityBtn";
        btn.textContent = localStorage.getItem("on_off") || "当前查看全部";
        btn.onclick = () => {
            const newText = btn.textContent === '当前查看全部' ? '当前只看楼主' : '当前查看全部';
            const startDateButton = document.getElementsByClassName("start-date")[0];
            if (startDateButton) void HumanInput.click(startDateButton);
            btn.textContent = newText;
            localStorage.setItem("on_off", newText);
            this.toggleVisibility();
        };

        btn.style.backgroundColor = "#333";
        btn.style.color = "#FFF";
        btn.style.border = "none";
        btn.style.padding = "8px 16px";
        btn.style.marginLeft = "10px";
        btn.style.borderRadius = "5px";
        btn.style.cursor = "pointer";

        const saveButton = document.querySelector('.save-to-local-btn');
        if (saveButton) {
            saveButton.parentElement.appendChild(btn);
        } else {
            const firstPostContent = document.querySelector('.boxed.onscreen-post[data-post-id] .cooked');
            if (firstPostContent) {
                firstPostContent.appendChild(btn);
            }
        }
    }

    observePageChanges() {
        const observer = new MutationObserver(() => {
            if (document.querySelector(".timeline-footer-controls") && !document.getElementById("toggleVisibilityBtn")) {
                this.createToggleButton();
            }
            this.toggleVisibility();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    initFloorNumberDisplay() {
        this.addFloorNumbers();
        this.initMutationObserver();
        this.setupRandomJumpButton();
        this.monitorURLChangeAndUpdateButton();
    }

    addFloorNumbers() {
        const posts = Array.from(document.querySelectorAll('.boxed.onscreen-post'));
        if (!posts.length) {
            this.setupSaveButton();
            return;
        }

        // 以 topic.json 的 post_stream 为准识别系统楼层（类别/标签更新等），避免仅靠 DOM class 漏判
        const topicIdMatch = window.location.pathname.match(/\/t\/topic\/(\d+)/);
        const topicId = topicIdMatch ? topicIdMatch[1] : null;

        if (topicId && this._floorTopicId !== topicId) {
            this._floorTopicId = topicId;
            this._floorSmallActionNumbers = null;
            this._floorSmallActionPromise = null;
        }

        const ensureSmallActionNumbers = () => {
            if (!topicId) return;

            if (Array.isArray(this._floorSmallActionNumbers)) return;
            if (this._floorSmallActionPromise) return;

            const url = new URL(window.location.href);
            url.hash = '';
            const jsonUrl = url.toString().replace(/\/$/, '') + '.json';

            this._floorSmallActionPromise = fetch(jsonUrl, { credentials: 'include' })
                .then(r => (r && r.ok ? r.json() : null))
                .then(data => {
                    const arr = data?.post_stream?.posts;
                    if (!Array.isArray(arr)) return null;

                    const smallNums = [];
                    for (const p of arr) {
                        const n = p?.post_number;
                        if (!Number.isFinite(n)) continue;

                        // 经验规则（优先使用结构化字段）：
                        // - action_code 存在时通常是系统动作贴（如类别/标签变动）
                        // - post_type !== 1 通常也不是普通回复
                        const hasActionCode = typeof p?.action_code === 'string' && p.action_code.length > 0;
                        const postType = p?.post_type;
                        const isNonRegularType = Number.isFinite(postType) && postType !== 1;

                        // 兜底（linux.do 可能缺 action_code）：短文本 + 类别/标签 + 更新/移除
                        let looksLikeSystemText = false;
                        if (!hasActionCode && !isNonRegularType) {
                            const cooked = typeof p?.cooked === 'string' ? p.cooked : '';
                            if (cooked) {
                                const plain = cooked.replace(/<[^>]*>/g, '').trim();
                                if (plain.length > 0 && plain.length <= 80) {
                                    const hasCatTag = /类别|标签|category|tag/i.test(plain);
                                    const hasUpdate = /更新|移除|removed|updated|change/i.test(plain);
                                    if (hasCatTag && hasUpdate) looksLikeSystemText = true;
                                }
                            }
                        }

                        if (hasActionCode || isNonRegularType || looksLikeSystemText) {
                            smallNums.push(n);
                        }
                    }
                    smallNums.sort((a, b) => a - b);
                    return smallNums;
                })
                .then(smallNums => {
                    if (Array.isArray(smallNums)) {
                        const prev = this._floorSmallActionNumbers;
                        this._floorSmallActionNumbers = smallNums;

                        // JSON 异步回来后强制重算一次，避免页面无 DOM 变化时仍显示旧楼层
                        if (!Array.isArray(prev) || prev.length !== smallNums.length) {
                            setTimeout(() => {
                                if (this._floorTopicId === topicId) {
                                    try { this.addFloorNumbers(); } catch (_) { }
                                }
                            }, 0);
                        }
                    }
                })
                .catch(() => { })
                .finally(() => {
                    this._floorSmallActionPromise = null;
                });
        };

        ensureSmallActionNumbers();

        // 优先用 JSON 结果，否则用 DOM 兜底（可能会漏判，但 JSON 一旦回来就会矫正）
        let smallActionPostNumbers = Array.isArray(this._floorSmallActionNumbers) ? this._floorSmallActionNumbers : null;
        if (!smallActionPostNumbers) {
            const topicPosts = Array.from(document.querySelectorAll('.topic-post[data-post-number]'));
            const nums = [];
            for (const tp of topicPosts) {
                const isSmallAction = tp.classList.contains('small-action') || !!tp.querySelector('.small-action');
                if (!isSmallAction) continue;

                const postNumberStr = tp.getAttribute('data-post-number');
                const n = postNumberStr ? parseInt(postNumberStr, 10) : NaN;
                if (Number.isFinite(n)) nums.push(n);
            }
            nums.sort((a, b) => a - b);
            smallActionPostNumbers = nums;
        }

        const countSmallActionsBefore = (postNumber) => {
            let count = 0;
            for (const n of smallActionPostNumbers) {
                if (n < postNumber) count++;
                else break;
            }
            return count;
        };

        for (const post of posts) {
            const postWrapper = post.closest('.topic-post');
            const isSmallActionWrapper = !!(postWrapper && (postWrapper.classList.contains('small-action') || !!postWrapper.querySelector('.small-action')));

            // 系统动作楼层不显示楼层号
            if (isSmallActionWrapper) {
                const existing = post.querySelector('.floor-number');
                if (existing) existing.remove();
                continue;
            }

            const postNumberStr = postWrapper?.getAttribute('data-post-number');
            let postNumber = postNumberStr ? parseInt(postNumberStr, 10) : NaN;
            if (!Number.isFinite(postNumber)) {
                const idPart = (post.id || '').split('_')[1];
                postNumber = idPart ? parseInt(idPart, 10) : NaN;
            }
            if (!Number.isFinite(postNumber)) continue;

            const adjustedFloor = postNumber - countSmallActionsBefore(postNumber);

            const meta = post.querySelector('.topic-meta-data');
            if (!meta) continue;

            let floorNumber = post.querySelector('.floor-number');
            if (!floorNumber) {
                floorNumber = document.createElement('div');
                floorNumber.className = 'floor-number';
                floorNumber.style.cssText = 'color: grey; margin-left: 10px;';
                meta.appendChild(floorNumber);
            }
            floorNumber.textContent = '楼层: ' + adjustedFloor;
            floorNumber.title = '原始楼层: ' + postNumber;
        }

        this.setupSaveButton();
    }

    initMutationObserver() {
        // 避免重复创建 observer
        if (this._floorMutationObserver) {
            try { this._floorMutationObserver.disconnect(); } catch (_) { }
        }

        // 防止 observer 被自身 DOM 更新反复触发导致卡顿/假死
        this._floorObserverRunning = false;
        this._floorObserverScheduled = false;

        const scheduleUpdate = () => {
            if (this._floorObserverRunning || this._floorObserverScheduled) return;

            this._floorObserverScheduled = true;
            setTimeout(() => {
                this._floorObserverScheduled = false;
                this._floorObserverRunning = true;
                try {
                    this.addFloorNumbers();
                } catch (e) {
                    console.error('[楼层号] 更新失败:', e);
                } finally {
                    this._floorObserverRunning = false;
                }
            }, 80);
        };

        this._floorMutationObserver = new MutationObserver(() => {
            scheduleUpdate();
        });

        this._floorMutationObserver.observe(document.body, { childList: true, subtree: true });

        // 首次也走一次合并更新
        scheduleUpdate();
    }

    randomJump() {
        fetch(window.location.href + '.json')
            .then(response => response.json())
            .then(data => {
                const maxPostNumber = data?.highest_post_number || data?.posts_count;
                if (maxPostNumber) {
                    const postId = 1 + Math.floor(Math.random() * maxPostNumber);
                    const currentUrl = new URL(window.location.href);
                    const list1 = currentUrl.pathname.split("/");
                    if (list1[list1.length - 2] === "topic") {
                        list1.push(postId);
                    } else if (list1[list1.length - 3] === "topic") {
                        list1[list1.length - 1] = postId;
                    }
                    const newUrl = list1.join("/");
                    window.location.href = newUrl;
                    alert('恭喜楼层【' + postId + '】的用户被抽中！');
                }
            })
            .catch(error => console.error('Error:', error));
    }

    setupRandomJumpButton() {
        // 随机按钮已集成到主面板中，不需要单独创建
    }

    setupSaveButton() {
        const firstPost = document.querySelector('.boxed.onscreen-post[data-post-id]');
        if (firstPost && firstPost.id.includes('post_1')) {
            if (!firstPost.querySelector('.save-to-local-btn')) {
                // 创建按钮容器
                const buttonContainer = document.createElement('div');
                buttonContainer.className = 'save-buttons-container';
                Object.assign(buttonContainer.style, {
                    display: 'flex',
                    gap: '10px',
                    marginTop: '10px',
                    flexWrap: 'wrap'
                });

                // 保存为 HTML 按钮
                const saveButton = document.createElement('button');
                saveButton.className = 'save-to-local-btn';
                saveButton.textContent = '💾 保存到本地';
                Object.assign(saveButton.style, {
                    padding: '10px 20px',
                    fontSize: '15px',
                    fontWeight: '600',
                    backgroundColor: '#ff9800',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(255, 152, 0, 0.3)',
                    transition: 'all 0.3s'
                });
                saveButton.addEventListener('mouseover', () => {
                    saveButton.style.transform = 'translateY(-2px)';
                    saveButton.style.boxShadow = '0 6px 20px rgba(255, 152, 0, 0.4)';
                });
                saveButton.addEventListener('mouseout', () => {
                    saveButton.style.transform = 'translateY(0)';
                    saveButton.style.boxShadow = '0 4px 12px rgba(255, 152, 0, 0.3)';
                });
                saveButton.addEventListener('click', () => this.savePostToLocal(firstPost));

                // 保存为图片按钮
                const saveImageButton = document.createElement('button');
                saveImageButton.className = 'save-to-image-btn';
                saveImageButton.textContent = '🖼️ 保存为图片';
                Object.assign(saveImageButton.style, {
                    padding: '10px 20px',
                    fontSize: '15px',
                    fontWeight: '600',
                    backgroundColor: '#4CAF50',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(76, 175, 80, 0.3)',
                    transition: 'all 0.3s'
                });
                saveImageButton.addEventListener('mouseover', () => {
                    saveImageButton.style.transform = 'translateY(-2px)';
                    saveImageButton.style.boxShadow = '0 6px 20px rgba(76, 175, 80, 0.4)';
                });
                saveImageButton.addEventListener('mouseout', () => {
                    saveImageButton.style.transform = 'translateY(0)';
                    saveImageButton.style.boxShadow = '0 4px 12px rgba(76, 175, 80, 0.3)';
                });
                saveImageButton.addEventListener('click', () => this.savePostAsImage(firstPost));

                buttonContainer.appendChild(saveButton);
                buttonContainer.appendChild(saveImageButton);

                const postContent = firstPost.querySelector('.cooked');
                if (postContent) {
                    postContent.appendChild(buttonContainer);
                }
            }
        }
    }

    async savePostToLocal(postElement) {
        try {
            const topicTitle = document.querySelector('.fancy-title')?.textContent.trim() || 'Untitled_Topic';
            const postContent = postElement.querySelector('.cooked');
            if (!postContent) {
                alert('无法获取帖子内容！');
                return;
            }

            const contentClone = postContent.cloneNode(true);
            contentClone.querySelector('.save-to-local-btn')?.remove();

            const images = contentClone.querySelectorAll('img');
            for (const img of images) {
                try {
                    const response = await fetch(img.src);
                    const blob = await response.blob();
                    const reader = new FileReader();
                    await new Promise((resolve) => {
                        reader.onload = resolve;
                        reader.readAsDataURL(blob);
                    });
                    img.src = reader.result;
                } catch (error) {
                    console.error('图片加载失败:', img.src, error);
                    img.alt = '[图片加载失败]';
                }
            }

            const htmlContent = `
                <!DOCTYPE html>
                <html lang="zh-CN">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>${topicTitle}</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        .post-content { max-width: 800px; margin: 0 auto; }
                        img { max-width: 100%; height: auto; }
                    </style>
                </head>
                <body>
                    <div class="post-content">
                        <h1>${topicTitle}</h1>
                        ${contentClone.innerHTML}
                    </div>
                </body>
                </html>
            `;

            const blob = new Blob([htmlContent], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const fileName = topicTitle
                .replace(/[\\/:*?"<>|]/g, '_')
                .replace(/\s+/g, '_')
                + '.html';
            link.download = fileName;
            link.click();
            URL.revokeObjectURL(url);

            alert('帖子内容已保存到本地！');
        } catch (error) {
            console.error('保存帖子失败:', error);
            alert('保存失败，请查看控制台错误信息。');
        }
    }

    // 获取 html2canvas 库（通过 @require 预加载）
    async loadHtml2Canvas() {
        // html2canvas 已通过 @require 在脚本头部预加载
        // 检查是否已加载成功
        if (typeof html2canvas !== 'undefined') {
            console.log('[html2canvas] 库已通过 @require 预加载');
            return html2canvas;
        }

        // 检查 window 上是否有
        if (window.html2canvas) {
            console.log('[html2canvas] 从 window 获取');
            return window.html2canvas;
        }

        // 如果都没有，抛出错误并提示用户
        throw new Error('html2canvas 库未加载，请确保油猴脚本已正确安装并刷新页面');
    }

    // 保存帖子为图片
    async savePostAsImage(postElement) {
        const saveImageBtn = postElement.querySelector('.save-to-image-btn');
        const originalText = saveImageBtn?.textContent;

        try {
            // 更新按钮状态
            if (saveImageBtn) {
                saveImageBtn.textContent = '⏳ 加载中...';
                saveImageBtn.disabled = true;
            }

            // 加载 html2canvas
            const html2canvas = await this.loadHtml2Canvas();

            if (saveImageBtn) {
                saveImageBtn.textContent = '⏳ 生成图片中...';
            }

            const topicTitle = document.querySelector('.fancy-title')?.textContent.trim() || 'Untitled_Topic';
            const postContent = postElement.querySelector('.cooked');

            if (!postContent) {
                alert('无法获取帖子内容！');
                return;
            }

            // 创建临时容器用于渲染
            const tempContainer = document.createElement('div');
            tempContainer.style.cssText = `
                position: fixed;
                left: -9999px;
                top: 0;
                width: 800px;
                background: #ffffff;
                padding: 30px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            `;

            // 添加标题
            const titleElement = document.createElement('h1');
            titleElement.textContent = topicTitle;
            titleElement.style.cssText = `
                margin: 0 0 20px 0;
                padding-bottom: 15px;
                border-bottom: 2px solid #e0e0e0;
                font-size: 24px;
                color: #333;
                word-wrap: break-word;
            `;
            tempContainer.appendChild(titleElement);

            // 克隆帖子内容
            const contentClone = postContent.cloneNode(true);

            // 移除按钮容器
            contentClone.querySelector('.save-buttons-container')?.remove();
            contentClone.querySelector('.save-to-local-btn')?.remove();
            contentClone.querySelector('.save-to-image-btn')?.remove();

            // 设置内容样式
            contentClone.style.cssText = `
                font-size: 16px;
                line-height: 1.8;
                color: #333;
            `;

            // 处理图片样式
            const images = contentClone.querySelectorAll('img');
            images.forEach(img => {
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                img.crossOrigin = 'anonymous';
            });

            tempContainer.appendChild(contentClone);

            // 添加水印/来源
            const footer = document.createElement('div');
            footer.style.cssText = `
                margin-top: 20px;
                padding-top: 15px;
                border-top: 1px solid #e0e0e0;
                font-size: 12px;
                color: #999;
                text-align: right;
            `;
            footer.textContent = `来源: ${window.location.href}`;
            tempContainer.appendChild(footer);

            document.body.appendChild(tempContainer);

            // 等待图片加载完成
            const imgElements = tempContainer.querySelectorAll('img');
            await Promise.all(Array.from(imgElements).map(img => {
                if (img.complete) return Promise.resolve();
                return new Promise((resolve) => {
                    img.onload = resolve;
                    img.onerror = resolve;
                    // 设置超时
                    setTimeout(resolve, 3000);
                });
            }));

            // 使用 html2canvas 生成图片
            const canvas = await html2canvas(tempContainer, {
                backgroundColor: '#ffffff',
                scale: 2,
                useCORS: true,
                allowTaint: true,
                logging: false,
                windowWidth: 800
            });

            // 移除临时容器
            document.body.removeChild(tempContainer);

            // 转换为图片并下载
            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                const fileName = topicTitle
                    .replace(/[\\/:*?"<>|]/g, '_')
                    .replace(/\s+/g, '_')
                    + '.png';
                link.download = fileName;
                link.click();
                URL.revokeObjectURL(url);

                alert('帖子已保存为图片！');
            }, 'image/png');

        } catch (error) {
            console.error('保存图片失败:', error);
            alert('保存图片失败: ' + error.message);
        } finally {
            // 恢复按钮状态
            if (saveImageBtn) {
                saveImageBtn.textContent = originalText || '🖼️ 保存为图片';
                saveImageBtn.disabled = false;
            }
        }
    }

    monitorURLChangeAndUpdateButton() {
        let lastPageContextKey = this.getPageContextKey(location.href);

        // 初始检查一次
        this.updateButtonVisibility();

        if (this.urlMonitorInterval) {
            clearInterval(this.urlMonitorInterval);
        }

        this.urlMonitorInterval = setInterval(() => {
            const currentURL = location.href;
            const currentPageContextKey = this.getPageContextKey(currentURL);
            if (currentPageContextKey !== lastPageContextKey) {
                lastPageContextKey = currentPageContextKey;
                this.isTopicPage = location.pathname.includes('/t/topic/');
                this.updateButtonVisibility();
                if (this.autoRunning) this.resumeHomeClickReading();
            }
        }, 300);
    }

    updateButtonVisibility() {
        const isTopicPage = location.pathname.includes('/t/topic/');

        // 随机楼层按钮和批量展示按钮：只在文章页显示
        if (this.randomBtn) {
            this.randomBtn.style.display = isTopicPage ? 'flex' : 'none';
        }
        if (this.revealUsersBtn) {
            this.revealUsersBtn.style.display = isTopicPage ? 'flex' : 'none';
        }

        // 折叠模式下的文章页功能子区域：只在文章页显示
        if (this.toolSubSection) {
            this.toolSubSection.style.display = isTopicPage ? 'block' : 'none';
        }

        console.log(`页面类型: ${isTopicPage ? '文章页' : '非文章页'}，文章页功能${isTopicPage ? '显示' : '隐藏'}`);
    }

    async handleRevealUsersClick() {
        if (this.userInfoHelper.revealInProgress) return;

        // 更新按钮状态
        this.revealUsersBtn.disabled = true;
        this.revealUsersBtn.innerHTML = `<span class="btn-icon">⏳</span><span class="btn-text">${this.t('loading')}</span>`;

        try {
            await this.userInfoHelper.revealAllVisibleReplies();
            this.revealUsersBtn.innerHTML = `<span class="btn-icon">✅</span><span class="btn-text">${this.t('loadingComplete')}</span>`;

            // 2秒后恢复按钮
            setTimeout(() => {
                this.revealUsersBtn.disabled = false;
                this.revealUsersBtn.innerHTML = `<span class="btn-icon">📊</span><span class="btn-text">${this.t('batchShowInfo')}</span>`;
            }, 2000);
        } catch (error) {
            console.error('展示用户信息失败:', error);
            this.revealUsersBtn.disabled = false;
            this.revealUsersBtn.innerHTML = `<span class="btn-icon">❌</span><span class="btn-text">${this.t('loadingFailed')}</span>`;

            setTimeout(() => {
                this.revealUsersBtn.innerHTML = `<span class="btn-icon">📊</span><span class="btn-text">${this.t('batchShowInfo')}</span>`;
            }, 2000);
        }
    }

    async handleButtonClick() {
        if (this.isScrolling || this.autoRunning) {
            this.stopAutoReading();
        } else {
            // 阅读限制按“今日已读”计算，达到当天目标后不再启动。
            if (this.stopAfterReadEnabled && this.todayReadCount >= this.stopAfterReadCount) {
                console.log(`[阅读限制] 今日已读已达到目标 (${this.todayReadCount}/${this.stopAfterReadCount})`);
                this.showNotification(this.t('stoppedByReadLimit'));
                this.updateReadStatsDisplay();
                return;
            }

            // 开启自动阅读前，检查点赞上限
            if (this.stopOnLikeLimitEnabled) {
                // 检查多种点赞上限状态
                const likeStatus = this.likeCounter?.getStatus?.();
                const isLikeCounterCooldown = likeStatus && likeStatus.isInCooldown;
                const isOldCooldown = this.likeResumeTime && Date.now() < this.likeResumeTime;
                const hasNoRemainingLikes = likeStatus && likeStatus.remaining === 0;

                if (isLikeCounterCooldown || isOldCooldown || hasNoRemainingLikes) {
                    console.log(`[点赞上限] 点赞已达上限，无法开始阅读 (cooldown: ${isLikeCounterCooldown}, oldCooldown: ${isOldCooldown}, noRemaining: ${hasNoRemainingLikes})`);
                    this.showNotification(this.t('stoppedByLikeLimit'));
                    return; // 阻止开始阅读
                }
            }

            if (this.startReadingInFlight) return;
            this.startReadingInFlight = true;
            try {
                await this.syncOfficialPostsReadCount();
            } finally {
                this.startReadingInFlight = false;
            }

            // 开启自动阅读
            this.autoRunning = true;
            this.currentSessionReadCount = 0;
            this.lastCountedTopicId = null;
            this.skippedReadCount = 0;
            this.setSessionStorage('currentSessionReadCount', 0);
            this.setSessionStorage('lastCountedTopicId', null);
            this.setSessionStorage('skippedReadCount', 0);
            this.autoLikeDecisionCache.clear();
            this.startReadingTimer(false);

            this.setSessionStorage('autoRunning', true);
            this.hasRemainingHomeUnreadSnapshot = false;
            this.setSessionStorage('hasRemainingHomeUnreadSnapshot', false);
            this.updateReadStatsDisplay();
            this.button.innerHTML = `<span class="btn-icon">⏸</span><span class="btn-text">${this.t('stopReading')}</span>`;
            this.button.classList.add('running');

            // 启动导航守护
            this.startNavigationGuard();

            // 开始阅读时，折叠账号信息区
            if (this.accountSection && this.accountSectionContent) {
                if (!this.accountSection.classList.contains('collapsed')) {
                    this.accountSection.classList.add('collapsed');
                    this.accountSectionContent.classList.add('collapsed');
                }
            }

            // 开始阅读时，展开自动阅读区
            if (this.autoSectionContent) {
                const autoSection = this.container.querySelector('.section-collapsible');
                if (autoSection && autoSection.classList.contains('collapsed')) {
                    autoSection.classList.remove('collapsed');
                    this.autoSectionContent.classList.remove('collapsed');
                }
            }

            if (!this.firstUseChecked) {
                this.handleFirstUse();
            } else if (this.isTopicPage) {
                this.startScrolling();
            } else {
                this.loadUserReadHistory().then(() => this.resumeHomeClickReading());
            }
        }
    }

    parseDisplayedLikeCount(value) {
        if (Number.isFinite(value)) return Math.max(0, Math.floor(value));

        const text = String(value ?? '').replace(/[,，\s]/g, '');
        const match = text.match(/(\d+(?:\.\d+)?)(万|[kKmM])?/);
        if (!match) return null;

        const base = Number(match[1]);
        const unit = match[2]?.toLowerCase();
        const multiplier = unit === '万' ? 10000 : unit === 'k' ? 1000 : unit === 'm' ? 1000000 : 1;
        return Number.isFinite(base) ? Math.max(0, Math.round(base * multiplier)) : null;
    }

    getPostIdFromElement(postElement) {
        const topicPost = postElement?.matches?.('.topic-post')
            ? postElement
            : postElement?.closest?.('.topic-post');
        const dataId = topicPost?.dataset?.postId || postElement?.dataset?.postId;
        if (dataId) return String(dataId);

        const idValue = topicPost?.id || postElement?.id || '';
        return idValue.match(/(?:post_|post-)(\d+)/)?.[1] || null;
    }

    readPostLikeCountFromDom(postElement) {
        if (!postElement) return null;

        const postId = this.getPostIdFromElement(postElement);
        const counters = [];
        const addCounter = element => {
            if (element && !counters.includes(element)) counters.push(element);
        };

        // linux.do 当前结构：#discourse-reactions-counter-{帖子ID}-left > span
        if (postId) {
            ['left', 'right'].forEach(side => {
                const container = document.getElementById(`discourse-reactions-counter-${postId}-${side}`);
                addCounter(container?.querySelector('span') || container);
            });
        }

        postElement.querySelectorAll([
            '[id^="discourse-reactions-counter-"][id$="-left"] > span',
            '[id^="discourse-reactions-counter-"][id$="-right"] > span',
            '[id^="discourse-reactions-counter-"] > span',
            '.discourse-reactions-counter > span',
            '.discourse-reactions-counter',
            '[data-like-count]',
            '.post-action-menu__like-count',
            '.like-count'
        ].join(', ')).forEach(addCounter);

        for (const counter of counters) {
            const values = [
                counter.dataset?.likeCount,
                counter.dataset?.count,
                counter.getAttribute?.('aria-label'),
                counter.getAttribute?.('title'),
                counter.textContent
            ];
            for (const value of values) {
                const count = this.parseDisplayedLikeCount(value);
                if (count !== null) return count;
            }
        }

        return null;
    }

    async fetchPostLikeSnapshot(postId, forceRefresh = false) {
        if (!postId) return { count: null, liked: null };

        try {
            const suffix = forceRefresh ? `?_=${Date.now()}` : '';
            const response = await fetch(`/posts/${encodeURIComponent(postId)}.json${suffix}`, {
                credentials: 'same-origin',
                cache: forceRefresh ? 'no-store' : 'default',
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) return { count: null, liked: null };

            const postData = await response.json();
            const likeAction = postData.actions_summary?.find(action => Number(action.id) === 2);
            const directCounts = [
                postData.reaction_users_count,
                postData.reactions_users_count,
                postData.like_count,
                likeAction?.count
            ];
            let count = null;
            for (const value of directCounts) {
                count = this.parseDisplayedLikeCount(value);
                if (count !== null) break;
            }

            const currentReaction = postData.current_user_reaction ?? postData.user_reaction;
            const liked = Boolean(
                currentReaction && currentReaction !== 'none' ||
                likeAction?.acted === true ||
                likeAction?.can_undo === true
            );
            const hasExplicitLikeState = currentReaction !== undefined ||
                likeAction?.acted !== undefined || likeAction?.can_undo !== undefined;
            return { count, liked: hasExplicitLikeState ? liked : null };
        } catch (error) {
            console.warn(`[点赞检查] 请求帖子 ${postId} 状态失败`, error);
            return { count: null, liked: null };
        }
    }

    async fetchPostLikeCount(postId) {
        return (await this.fetchPostLikeSnapshot(postId)).count;
    }

    // 按当前 postElement 读取对应楼层的赞数，不会串读其他回复的计数器
    async getPostLikeCount(postElement, timeoutMs = 2500) {
        const startedAt = Date.now();
        while (this.autoRunning && Date.now() - startedAt < timeoutMs) {
            const domCount = this.readPostLikeCountFromDom(postElement);
            if (domCount !== null) return domCount;
            await Utils.sleep(150);
        }

        return this.fetchPostLikeCount(this.getPostIdFromElement(postElement));
    }

    // 检查是否应该点赞该帖子（基于过滤模式）
    async shouldLikePost(postElement) {
        // 如果过滤模式关闭，直接返回 true
        if (this.likeFilterMode === 'off') {
            return { shouldLike: true, reason: 'filter_off' };
        }

        const likeCount = await this.getPostLikeCount(postElement);
        console.log(`[点赞过滤] 帖子当前赞数: ${likeCount}, 过滤模式: ${this.likeFilterMode}, 阈值: ${this.likeMinThreshold}`);

        if (likeCount === null) {
            return { shouldLike: false, reason: 'like_count_unavailable', likeCount: null };
        }

        if (this.likeFilterMode === 'threshold') {
            // 阈值模式：只有赞数 >= 阈值才点赞
            if (likeCount >= this.likeMinThreshold) {
                return { shouldLike: true, reason: 'threshold_passed', likeCount };
            } else {
                return { shouldLike: false, reason: 'below_threshold', likeCount };
            }
        } else if (this.likeFilterMode === 'probability') {
            // 概率模式：赞数越多，点赞概率越高
            // 0-1 赞：不点赞
            // 2+ 赞：概率递增
            if (likeCount <= 1) {
                return { shouldLike: false, reason: 'too_few_likes', likeCount };
            }

            // 计算概率：基于赞数的对数增长
            // 2赞 ≈ 20%, 5赞 ≈ 50%, 10赞 ≈ 70%, 20赞 ≈ 85%, 50赞 ≈ 95%
            const probability = Math.min(0.95, 0.2 + Math.log10(likeCount) * 0.35);
            const topicId = window.location.pathname.match(/\/t\/[^/]+\/(\d+)/)?.[1] || 'unknown';
            const decisionKey = `${topicId}:${this.likeFilterMode}:${this.likeMinThreshold}`;
            let random = this.autoLikeDecisionCache.get(decisionKey);
            if (!Number.isFinite(random)) {
                random = Math.random();
                this.autoLikeDecisionCache.set(decisionKey, random);
            }

            console.log(`[点赞过滤] 概率计算: ${(probability * 100).toFixed(1)}%, 随机值: ${(random * 100).toFixed(1)}%`);

            if (random < probability) {
                return { shouldLike: true, reason: 'probability_passed', likeCount, probability };
            } else {
                return { shouldLike: false, reason: 'probability_failed', likeCount, probability };
            }
        }

        return { shouldLike: true, reason: 'unknown_mode' };
    }

    // 检查当前页面的板块是否允许点赞
    isLikeAllowedInCurrentCategory() {
        if (CURRENT_DOMAIN === 'idcflare.com') {
            return { allowed: true, reason: 'idcflare_no_restriction' };
        }

        const config = CONFIG.likeAllowedCategories;
        const categoryNodes = document.querySelectorAll(
            '.topic-category .badge-category__name, .topic-category .category-name, ' +
            '.extra-info-wrapper .badge-category__name, .extra-info-wrapper .category-name'
        );
        const detectedCategories = [...new Set(
            Array.from(categoryNodes, node => node.textContent?.trim()).filter(Boolean)
        )];

        if (detectedCategories.length === 0) {
            console.log('[板块检查] 板块信息尚未加载');
            return { allowed: false, reason: 'category_not_found', categories: [] };
        }

        const excludedCategory = detectedCategories.find(category => config?.excluded?.includes(category));
        if (excludedCategory) {
            console.log(`[板块检查] 板块 "${excludedCategory}" 在排除列表中，不允许点赞`);
            return { allowed: false, reason: 'category_excluded', category: excludedCategory, categories: detectedCategories };
        }

        console.log('[板块检查] 允许点赞:', detectedCategories.join(' > '));
        return { allowed: true, reason: 'category_allowed', category: detectedCategories[0], categories: detectedCategories };
    }

    getAutoLikeButton(firstPost) {
        return firstPost?.querySelector([
            '.discourse-reactions-reaction-button button.btn-toggle-reaction-like',
            'button.btn-toggle-reaction-like',
            '.post-controls button.like',
            '.post-controls button[data-action="like"]',
            '.post-controls button.create-like'
        ].join(', ')) || null;
    }

    isLikeButtonActive(button) {
        if (!button) return false;
        const stateText = [button.getAttribute('aria-label'), button.getAttribute('title')]
            .filter(Boolean).join(' ').toLowerCase();
        const activeClasses = [
            'has-like', 'liked', 'my-reaction',
            'is-active', 'chosen', 'selected', 'btn-toggle-reaction-like--active'
        ];
        return button.getAttribute('aria-pressed') === 'true' ||
            button.dataset.userReacted === 'true' ||
            activeClasses.some(className => button.classList.contains(className)) ||
            /撤销|取消.*赞|移除.*赞|unlike|remove.*like|undo.*like|already liked|已赞/.test(stateText) ||
            Boolean(button.closest([
                '.has-like', '.liked', '.my-reaction',
                '[data-user-reacted="true"]',
                '[data-current-user-reaction]:not([data-current-user-reaction=""]):not([data-current-user-reaction="none"]):not([data-current-user-reaction="false"])'
            ].join(', ')));
    }

    hasCurrentUserLikeInPost(postElement) {
        if (!postElement) return false;
        const activeSelector = [
            '.discourse-reactions-reaction-button.has-like',
            '.discourse-reactions-reaction-button.liked',
            '.discourse-reactions-reaction-button.my-reaction',
            '.discourse-reactions-reaction-button [data-user-reacted="true"]',
            '.discourse-reactions-reaction-button .my-reaction',
            '.post-controls .has-like',
            '.post-controls button.like[aria-pressed="true"]'
        ].join(', ');
        return Boolean(postElement.querySelector(activeSelector)) ||
            this.isLikeButtonActive(this.getAutoLikeButton(postElement));
    }

    rememberLikedTopic(topicId) {
        const normalizedId = String(topicId);
        const uniqueIds = this.likedTopics.filter(id => String(id) !== normalizedId);
        uniqueIds.push(normalizedId);
        this.likedTopics = uniqueIds.slice(-2000);
        Storage.set('likedTopics', this.likedTopics);
    }

    async waitForAutoLikeContext(currentUsername, timeoutMs = 8000) {
        const startedAt = Date.now();
        let lastContext = null;

        while (this.autoRunning && this.autoLikeEnabled && Date.now() - startedAt < timeoutMs) {
            const firstPost = document.querySelector('.topic-post[data-post-number="1"], .topic-post');
            const categoryCheck = this.isLikeAllowedInCurrentCategory();
            const likeButton = this.getAutoLikeButton(firstPost);
            const authorSlug = this.getPostAuthorSlug(firstPost);
            const isOwnTopic = Boolean(currentUsername && authorSlug && currentUsername === authorSlug);
            lastContext = { firstPost, categoryCheck, likeButton, isOwnTopic };

            if (firstPost && categoryCheck.reason !== 'category_not_found' &&
                (categoryCheck.reason === 'category_excluded' || likeButton || isOwnTopic)) {
                return lastContext;
            }
            await Utils.sleep(250);
        }

        return lastContext;
    }

    async verifyAutoLikeSuccess(firstPost, postId, previousCount = null, timeoutMs = 5000) {
        const startedAt = Date.now();
        let lastApiCheckAt = 0;
        while (this.autoRunning && Date.now() - startedAt < timeoutMs) {
            if (this.hasCurrentUserLikeInPost(firstPost)) return true;

            const currentCount = this.readPostLikeCountFromDom(firstPost);
            if (Number.isFinite(previousCount) && Number.isFinite(currentCount) && currentCount > previousCount) {
                return true;
            }

            if (Date.now() - lastApiCheckAt >= 700) {
                lastApiCheckAt = Date.now();
                const snapshot = await this.fetchPostLikeSnapshot(postId, true);
                if (snapshot.liked === true ||
                    Number.isFinite(previousCount) && Number.isFinite(snapshot.count) && snapshot.count > previousCount) {
                    return true;
                }
            }
            if (this.likeResumeTime && Date.now() < this.likeResumeTime) return false;
            await Utils.sleep(150);
        }
        return false;
    }

    async autoLikeTopic() {
        if (!this.autoLikeEnabled || !this.autoRunning) return;

        if (this.likeResumeTime && Date.now() < this.likeResumeTime) {
            console.log('[自动点赞] 点赞功能冷却中，跳过');
            this.updateAutoLikeStatus('autoLikeCooling');
            return;
        }

        const topicId = window.location.pathname.match(/\/t\/[^/]+\/(\d+)/)?.[1] || null;
        if (!topicId) {
            console.log('[自动点赞] 无法获取当前主题ID');
            this.updateAutoLikeStatus('autoLikeFailed');
            return;
        }

        if (this.likedTopics.some(id => String(id) === topicId)) {
            console.log(`[自动点赞] 主题 ${topicId} 已经确认点赞，跳过`);
            this.updateAutoLikeStatus('autoLikeAlready');
            return;
        }

        this.updateAutoLikeStatus('autoLikeChecking');
        const currentUsername = String(this.currentUsername || await this.getCurrentUsername() || '').trim().toLowerCase();
        const context = await this.waitForAutoLikeContext(currentUsername);
        if (!this.autoRunning || !this.autoLikeEnabled) return;

        if (!context?.categoryCheck?.allowed) {
            const detail = context?.categoryCheck?.category || context?.categoryCheck?.reason || '';
            console.log(`[自动点赞] 当前板块不允许点赞: ${detail}`);
            this.updateAutoLikeStatus(
                context?.categoryCheck?.reason === 'category_excluded' ? 'autoLikeCategoryExcluded' : 'autoLikeUnavailable',
                detail
            );
            return;
        }

        if (context.isOwnTopic) {
            console.log('[自动点赞] 当前主题是自己的帖子，跳过');
            this.updateAutoLikeStatus('autoLikeSelfTopic');
            return;
        }

        const { firstPost, likeButton } = context;
        if (!firstPost || !likeButton || likeButton.disabled) {
            console.log('[自动点赞] 点赞按钮加载超时或不可用');
            this.updateAutoLikeStatus('autoLikeUnavailable');
            return;
        }

        if (this.isLikeButtonActive(likeButton)) {
            this.rememberLikedTopic(topicId);
            this.updateAutoLikeStatus('autoLikeAlready');
            return;
        }

        const filterResult = await this.shouldLikePost(firstPost);
        if (!this.autoRunning || !this.autoLikeEnabled) return;
        if (!filterResult.shouldLike) {
            console.log(`[自动点赞] 未通过过滤: ${filterResult.reason}`);
            if (filterResult.reason === 'like_count_unavailable') {
                this.updateAutoLikeStatus('autoLikeCountUnavailable');
                return;
            }

            const filterDetail = this.likeFilterMode === 'threshold'
                ? `${filterResult.likeCount} < ${this.likeMinThreshold} 赞`
                : `${filterResult.likeCount} 赞`;
            this.updateAutoLikeStatus('autoLikeFiltered', filterDetail);
            return;
        }

        const postId = this.getPostIdFromElement(firstPost);
        if (!postId) {
            console.warn('[Auto Like] Missing first-post ID; skipping this topic.');
            this.updateAutoLikeStatus('autoLikeUnavailable');
            return;
        }
        const countBeforeClick = Number.isFinite(filterResult.likeCount)
            ? filterResult.likeCount
            : this.readPostLikeCountFromDom(firstPost);
        const preClickSnapshot = await this.fetchPostLikeSnapshot(postId, true);
        if (!this.autoRunning || !this.autoLikeEnabled) return;
        if (preClickSnapshot.liked === true || this.hasCurrentUserLikeInPost(firstPost)) {
            this.rememberLikedTopic(topicId);
            this.updateAutoLikeStatus('autoLikeAlready');
            return;
        }

        const verifiedCountBeforeClick = Number.isFinite(countBeforeClick)
            ? countBeforeClick
            : preClickSnapshot.count;
        const currentLikeButton = this.getAutoLikeButton(firstPost);
        if (!this.autoRunning || !this.autoLikeEnabled || !currentLikeButton || currentLikeButton.disabled) return;

        console.log('[自动点赞] 点击主题首帖点赞按钮');
        await HumanInput.click(currentLikeButton);
        const likedSuccessfully = await this.verifyAutoLikeSuccess(
            firstPost,
            postId,
            verifiedCountBeforeClick
        );

        if (this.likeResumeTime && Date.now() < this.likeResumeTime) {
            this.updateAutoLikeStatus('autoLikeCooling');
            return;
        }

        if (likedSuccessfully) {
            this.rememberLikedTopic(topicId);
            this.updateAutoLikeStatus('autoLikeSuccess');
            console.log(`[自动点赞] 主题 ${topicId} 点赞成功`);
        } else {
            this.updateAutoLikeStatus('autoLikeFailed');
            console.warn(`[自动点赞] 主题 ${topicId} 未确认点赞成功，不写入历史`);
        }
    }

    getPostAuthorSlug(postElement) {
        const anchor = postElement?.querySelector('.names a[data-user-card]');
        const slug = anchor?.getAttribute('data-user-card');
        return slug ? slug.trim().toLowerCase() : '';
    }

    async handleFirstUse() {
        if (!this.autoRunning) return;
        Storage.set('firstUseChecked', true);
        this.firstUseChecked = true;
        await this.loadUserReadHistory();
        await this.resumeHomeClickReading();
    }



    // 更新当前阅读状态（在导航到下一篇时调用）
    updateReadingStatus() {
        if (!this.topicStatusContainer || !this.autoRunning) return;

        const remaining = this.getDisplayedRemainingCount();
        const topicType = this.t('unreadTopics');
        const skipped = this.skippedReadCount || 0;
        const todayRead = this.todayReadCount || 0;

        this.topicStatusContainer.style.display = 'block';
        this.topicStatusContainer.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: rgba(255,255,255,0.9); margin-bottom: 4px;">
                <span>${this.t('currentReading')}: <span style="color: #ffd700;">${topicType}</span></span>
                <span>${this.t('remainingTopics')}: <span style="color: #7dffb3; font-weight: bold;">${remaining}</span></span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: rgba(255,255,255,0.7);">
                <span>📅 ${this.t('todayRead')}: <span style="color: #87ceeb; font-weight: bold;">${todayRead}</span></span>
                ${skipped > 0 ? `<span>⏭️ ${this.t('skippedRead')}: <span style="color: #ffa500;">${skipped}</span></span>` : ''}
            </div>
        `;
    }


    async startScrolling() {
        if (this.isScrolling) return;

        this.isScrolling = true;
        this.scrollFractionRemainder = 0;
        this.button.innerHTML = `<span class="btn-icon">⏸</span><span class="btn-text">${this.t('stopReading')}</span>`;
        this.button.classList.add('running');
        const shouldReadFullTopic = this.fullTopicReadEnabled && this.isTopicPage;

        if (shouldReadFullTopic) {
            window.scrollTo({ top: 0, behavior: 'auto' });
            await Utils.sleep(300);
        }

        // 点赞在后台执行，不阻塞当前帖滚动和阅读计时。
        if (this.isTopicPage) {
            this.runLikeActionForCurrentTopic().catch(error => {
                console.warn('[自动点赞] 后台任务异常:', error);
            });
        }

        this.prepareTopicBacktrackPlan();

        // 记录页面开始滚动的时间,用于强制跳转
        this.scrollStartTime = Date.now();
        // 速度降低时同比延长单帖时限，避免尚未滚到底部就强制跳转
        const maxScrollTime = shouldReadFullTopic
            ? null
            : Math.round(30000 / this.readSpeedMultiplier);

        while (this.isScrolling) {
            const scrollPlan = this.getScrollPlan(shouldReadFullTopic);

            window.scrollBy({
                top: scrollPlan.step,
                behavior: scrollPlan.behavior
            });

            await Utils.sleep(scrollPlan.delay);
            if (!this.isScrolling || !this.autoRunning) break;

            // 每帖只按预定进度随机回滚 1-2 次，避免循环概率造成连续抖动
            if (await this.performScheduledBacktrackIfNeeded()) {
                continue;
            }

            // 只有真正到达当前已加载内容的底部才等待加载；接近底部时保持正常阅读速度
            if (Utils.isAtBottom()) {
                let canNavigate = false;
                if (shouldReadFullTopic) {
                    canNavigate = await this.isTopicFullyRead();
                } else {
                    // 仅触发下一批回复加载，不跳到新生成的页面底部
                    const beforeLoading = this.getTopicProgressSnapshot();
                    window.dispatchEvent(new Event('scroll'));
                    document.dispatchEvent(new Event('scroll', { bubbles: true }));
                    await Utils.sleep(350);
                    const afterLoading = this.getTopicProgressSnapshot();
                    const loadedMorePosts = this.hasTopicProgressChanged(beforeLoading, afterLoading);
                    canNavigate = !loadedMorePosts && Utils.isAtBottom() && Utils.isPageLoaded();
                }

                if (!this.autoRunning || !this.isScrolling) break;

                if (canNavigate) {
                    console.log("已到达页面底部，准备导航到下一篇文章...");
                    await Utils.sleep(300);
                    if (!this.autoRunning) break;
                    await this.navigateNextTopic();
                    break;
                }
            }

            // 强制跳转检查:如果在当前页面滚动超过最大时间,强制跳转到下一篇
            const scrolledTime = Date.now() - this.scrollStartTime;
            if (maxScrollTime !== null && scrolledTime > maxScrollTime) {
                console.log(`已在当前页面滚动${Math.floor(scrolledTime/1000)}秒，强制跳转到下一篇文章...`);
                await this.navigateNextTopic();
                break;
            }

        }
    }


    stopScrolling() {
        this.isScrolling = false;
        clearInterval(this.scrollInterval);
        clearTimeout(this.pauseTimeout);
        this.button.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">${this.t('startReading')}</span>`;
        this.button.classList.remove('running');
    }



    async navigateNextTopic() {
        // 只有真正读完当前帖子时才计数；从列表页首次进入帖子不计入已读数
        const currentMatch = window.location.pathname.match(/\/t\/topic\/(\d+)/);
        const currentTopicId = currentMatch?.[1] || null;
        if (currentTopicId && this.lastCountedTopicId !== currentTopicId) {
            await this.saveUserReadHistory(currentTopicId);
            const countedToday = this.incrementTodayReadCount(currentTopicId);
            if (countedToday) this.currentSessionReadCount++;
            this.lastCountedTopicId = currentTopicId;
            this.setSessionStorage('currentSessionReadCount', this.currentSessionReadCount);
            this.setSessionStorage('lastCountedTopicId', this.lastCountedTopicId);
            console.log(`当前会话已阅读: ${this.currentSessionReadCount}/${this.stopAfterReadCount}`);
            this.updateReadStatsDisplay();
            this.updateReadingStatus();
        }

        // 检查阅读数量限制
        if (this.stopAfterReadEnabled && this.todayReadCount >= this.stopAfterReadCount) {
            console.log(`今日已达到阅读数量限制 (${this.todayReadCount}/${this.stopAfterReadCount})，自动停止`);
            this.showNotification(this.t('stoppedByReadLimit'));
            this.stopAutoReading();
            return;
        }

        // 检查点赞上限是否需要停止阅读
        if (this.stopOnLikeLimitEnabled) {
            // 检查多种点赞上限状态
            const likeStatus = this.likeCounter?.getStatus?.();
            const isLikeCounterCooldown = likeStatus && likeStatus.isInCooldown;
            const isOldCooldown = this.likeResumeTime && Date.now() < this.likeResumeTime;
            const hasNoRemainingLikes = likeStatus && likeStatus.remaining === 0;

            if (isLikeCounterCooldown || isOldCooldown || hasNoRemainingLikes) {
                console.log(`[点赞上限] 点赞已达上限，自动停止阅读 (cooldown: ${isLikeCounterCooldown}, oldCooldown: ${isOldCooldown}, noRemaining: ${hasNoRemainingLikes})`);
                this.showNotification(this.t('stoppedByLikeLimit'));
                this.stopAutoReading();
                return;
            }
        }

        await this.returnHomeForNextTopic();
    }

    // 停止自动阅读的统一方法
    stopAutoReading() {
        const wasAutoRunning = this.autoRunning || this.isScrolling;
        this.stopScrolling();
        this.stopNavigationGuard();
        this.autoRunning = false;
        this.stopReadingTimer();
        this.setSessionStorage('autoRunning', false);
        this.awaitingHomeTopicClick = false;
        this.setSessionStorage('awaitingHomeTopicClick', false);
        this.button.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">${this.t('startReading')}</span>`;
        this.button.classList.remove('running');

        // 清理所有定时器
        if (this.navigationTimeout) {
            clearTimeout(this.navigationTimeout);
            this.navigationTimeout = null;
        }

        // 停止阅读时，折叠自动阅读区
        if (this.autoSectionContent) {
            const autoSection = this.container.querySelector('.section-collapsible');
            if (autoSection && !autoSection.classList.contains('collapsed')) {
                autoSection.classList.add('collapsed');
                this.autoSectionContent.classList.add('collapsed');
            }
        }

        // 停止阅读时，展开账号信息区
        if (this.accountSection && this.accountSectionContent) {
            if (this.accountSection.classList.contains('collapsed')) {
                this.accountSection.classList.remove('collapsed');
                this.accountSectionContent.classList.remove('collapsed');
            }
        }

        console.log('自动阅读已停止');
        if (wasAutoRunning) {
            // 给 Discourse 留出提交最后阅读进度的时间；跳转和插件重载不会进入这里。
            setTimeout(() => void this.syncOfficialPostsReadCount(), 1800);
        }
    }



}

// 初始化
(function() {
    window.browseController = new BrowseController();
})();
