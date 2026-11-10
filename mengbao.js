// ============================================================
// 感谢明里小秘书（etal2019）的交互设计参考
// ============================================================
// 萌宝小秘书
// 功能：图片画廊预览、搜索过滤、自动翻页、收藏用户与帖子、
//       评论侧边面板、浏览历史标记、自定义头像、按时间排序
// ============================================================

// ==UserScript==
// @name         萌宝小秘书
// @namespace    https://violentmonkey.mengbao.local/
// @version      1.3
// @updateURL    https://cdn.jsdelivr.net/gh/mengbao-tools/mengbao@main/mengbao.js
// @downloadURL  https://cdn.jsdelivr.net/gh/mengbao-tools/mengbao@main/mengbao.js
// @description  Discuz 论坛增强套件：图片画廊预览、大图查看器、搜索过滤、自动翻页、收藏用户与帖子、评论侧边面板、评分自动满分、浏览历史标记、自定义头像
// @author       Slient_桃萌
// @icon         https://aka.doubaocdn.com/s/ZHcpkVi54s
// @license      MIT
// @match        *://*/*
// 说明：这里用通配匹配而不是具体域名——部署站点可能变动、也可能同时用多个镜像域名，
//       写死域名一旦换站点脚本就整体失效。代价是脚本会在所有站点注入执行，
//       实际功能由运行时白名单（IS_HOST_ALLOWED）收口，非白名单站点只加载不动作。
// @run-at       document-start
// @require      https://fastly.jsdelivr.net/npm/vue@3/dist/vue.global.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_listValues
// ==/UserScript==

(function () {
    'use strict';
    if (window.MengBaoLoaded) return;
    window.MengBaoLoaded = true;
    // ============================================================
    // ===================== 常量区 =====================
    const CONST = {
        DRAG_THRESHOLD: 3,            // 拖拽判定位移阈值（px）
        REQUEST_TIMEOUT: 15000,      // 单个请求超时（ms）
        QUEUE_CONCURRENCY: 2,         // 看图队列并发数
        QUEUE_TASK_TIMEOUT: 20000,    // 看图队列单任务硬上限（ms）：请求超时没兜住时由它兜底，超时即算完成
        STALL_RESET_MS: 18000,        // 进度计数连续不动多久判定卡死（ms）：清残留 tid 并收尾，避免提示条永久挂着
        LAZY_ROOT_MARGIN: '200px 0px',     // 图片懒加载观察边距
        POST_ROOT_MARGIN: '300px 0px',      // 帖子懒加载观察边距
        LOADING_MIN_SHOW_MS: 1500,    // 加载提示最小展示时长
        POLL_INTERVAL_MS: 300,        // 完成状态轮询间隔
        RATE_OBSERVE_TIMEOUT_MS: 120000,// 评分观察兜底时限：2 分钟。成功提示可即时判定，超时仅作兜底（论坛评分回调可能延迟，不宜取小值）
        CACHE_MAX_POSTS: 200,         // 看图预览持久化缓存上限（帖）
        SORT_FILTER: 'author',
        SORT_ORDERBY: 'dateline',
        // 尺寸只认 CSS 变量（:root --mb-fab-size），JS 不再另写一份 44，免得改一处漏一处
        get FAB_SIZE() {
            if (this._fabSize == null) {
                const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mb-fab-size'), 10);
                this._fabSize = v > 0 ? v : 44;
            }
            return this._fabSize;
        },
        FIX_PRELOAD: 3,
        CACHE_SERIALIZED_LIMIT: 2000000,
        CACHE_PERSIST_DELAY_MS: 300,   // 看图缓存合并写延迟（ms）
        PREVIEW_ID_PREFIX: 'mb-kantu-',
        OBSERVER_THROTTLE_MS: 200,    // DOM observer 回调节流间隔
        FAV_USER_PAGE_GUARD: 50,      // 收藏用户翻页最大深度
        FAV_SYNC_THROTTLE_MS: 60 * 60 * 1000,
        AVATAR_MAX_SIZE: 5 * 1024 * 1024, // 头像上传大小上限
        TOAST_DURATION: 2200,         // Toast 默认展示时长
        CONTINUOUS_PAGER_DELAY_MS: 3000, // 持续自动翻页每页间隔（ms）
        GALLERY_PRELOAD_DELAY_MS: 300,   // 画廊打开后预加载下一张的延时（ms）
        LAZY_PRELOAD_DISTANCE: 300,      // 懒加载预加载触发距离（px）
        LAZY_SCROLL_IDLE_MS: 800,        // 停止滚动多久后触发懒加载（ms）
        AVATAR_FETCH_TIMEOUT_MS: 10000,   // 头像抓取超时（ms）
        MUTATION_RAF_INTERVAL_MS: 16,    // DOM observer rAF 节流间隔（≈60fps）
        MAX_PENDING_MUTATIONS: 200,      // mutations 队列最大长度保护
    };

    // ===================== 统一配置 Schema（所有存储键的唯一登记处） =====================
    // 字段：def=默认值 / type=类型 / backup=是否参与全量备份与导入 / min,max=数值范围 / validate=附加校验
    // 旧结构示例：favorite={time,data} / favorite_users={uid:{username}} / avatar='data:...' / width=22
    // 新结构示例：favorite={'123':{time,data}} / favorite_users={'123':{uid:{username}}} / avatar={'123':'data:...'} / width={'123':22}

    const vOldOrNew = (check) => (v) => {
        if (check(v)) return true;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
        return Object.values(v).every(x => check(x));
    };
    // v1.2 起移除「收藏关键词」功能：清掉历史残留键，避免死数据留在本地
    try {
        if (typeof GM_deleteValue === 'function') {
            GM_deleteValue('mengbao.comment.favorite');
            GM_deleteValue('mengbao.comment.keywordStats');
        }
    } catch (e) {}

    const CONFIG_SCHEMA = {
        'mengbao.sort.config':               { type: 'object',   def: { enabled: true }, backup: true },
        'mengbao.kantu.config':              { type: 'object',   def: { THUMB_W: 300, THUMB_H: 300, GALLERY_BG_COLOR: '#faf8f5', GALLERY_CELL_COLOR: '#f8fafc' }, backup: true },
        'mengbao.guolv.config':              { type: 'object',   def: { hiddenSections: {}, keywordBlackList: '', kwScopeFid: null }, backup: true },
        'mengbao.zengqiang.main':            { type: 'object',   def: { initFavorRecords: false }, backup: true },
        'mengbao.zengqiang.favorite':        { type: 'object',   def: { time: 0, data: {} }, backup: true, validate: vOldOrNew(x => !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.time === 'number' && !!x.data && typeof x.data === 'object' && !Array.isArray(x.data)) },
        'mengbao.zengqiang.rated':           { type: 'object',   def: { time: 0, data: {} }, backup: true, validate: vOldOrNew(x => !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.time === 'number' && !!x.data && typeof x.data === 'object' && !Array.isArray(x.data)) },
        'mengbao.zengqiang.favorite_users':  { type: 'object',   def: {}, backup: true },
        'mengbao.zengqiang.favorite_groups': { type: 'string[]', def: [], backup: true, validate: vOldOrNew(x => Array.isArray(x) && x.every(g => typeof g === 'string')) },
        'mengbao.zengqiang.favorite_users_order': { type: 'string[]', def: [], backup: true, validate: vOldOrNew(x => Array.isArray(x) && x.every(u => typeof u === 'string')) },
        'mengbao.site.hosts':                { type: 'string[]', def: ['www.sehuatang.net', 'www.sehuatang.org', 'lw7f.srg3f.net', 'rlh8.khy1j.com', 'plwt.kpqq4.com'], backup: true, validate: v => v.every(h => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) },
        'mengbao.fanye.delaySec':            { type: 'number',   def: 5, min: 0, max: 10, backup: true },
        'mengbao.debug':                     { type: 'boolean',  def: false, backup: true },
        'mengbao.browse.enabled':            { type: 'boolean',  def: true, backup: true },
        'mengbao.browse.history':            { type: 'object',   def: { time: 0, data: {} }, validate: vOldOrNew(x => !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.time === 'number' && !!x.data && typeof x.data === 'object' && !Array.isArray(x.data)) },
        'mengbao.browse.color':              { type: 'color',    def: '#f0f0f0', backup: true },
        'mengbao.browse.strike':             { type: 'boolean',  def: true, backup: true },
        'mengbao.jump_target':               { type: 'enum',     def: 'home', values: ['home', 'thread', 'reply', 'off'], backup: true },
        'mengbao.favorite_highlight_bg':     { type: 'color',    def: '#dbeafe', backup: true },
        'mengbao.favorite_highlight_title':  { type: 'color',    def: '#d97706', backup: true },
        'mengbao.kantu.cache':               { type: 'object',   def: {} },
        'mengbao.kantu.preload':             { type: 'number',   def: 3, min: 1, max: 12, backup: true, validate: vOldOrNew(x => typeof x === 'number' && Number.isFinite(x)) },
        'mengbao.kantu.thumbH':              { type: 'number',   def: 200, min: 120, max: 320, backup: true, validate: vOldOrNew(x => typeof x === 'number' && Number.isFinite(x)) },
        'mengbao.avatars.user':              { type: 'array',    def: [], backup: true, validate: vOldOrNew(x => Array.isArray(x) && x.every(a => a === null || (!!a && typeof a === 'object' && typeof a.data === 'string' && /^data:image\//.test(a.data))) && x.filter(Boolean).length <= 9) },
        'mengbao.avatars.backup.v132':       { type: 'array',    def: [], backup: true, validate: vOldOrNew(x => Array.isArray(x)) },
        'mengbao.comment.avatarChoice':      { type: 'string',   def: '', backup: true, validate: vOldOrNew(x => typeof x === 'string') },
        'mengbao.comment.avatar':            { type: 'string',   def: '', backup: true, validate: vOldOrNew(x => typeof x === 'string' && (!x || /^(?:data:image\/|builtin:[12]$)/.test(x))) },
        'mengbao.cmtfav.avatarChoice':       { type: 'string',   def: '', backup: true, validate: vOldOrNew(x => typeof x === 'string') },
        'mengbao.cmtfav.avatar':             { type: 'string',   def: '', backup: true, validate: vOldOrNew(x => typeof x === 'string' && (!x || /^(?:data:image\/|builtin:[12]$)/.test(x))) },
        'mengbao.comment.width':             { type: 'number',   def: 24, min: 15, max: 50, backup: true, validate: vOldOrNew(x => typeof x === 'number' && Number.isFinite(x)) },
        'mengbao.comment.minLen':            { type: 'number',   def: 1, min: 1, max: 30, backup: true, validate: vOldOrNew(x => typeof x === 'number' && Number.isFinite(x)) },
        'mengbao.panel.nickname':            { type: 'string',   def: '萌宝', maxLen: 64, backup: true, validate: vOldOrNew(x => typeof x === 'string' && x.length <= 64) },
        'mengbao.settings':                  { type: 'object',   def: {} },
        'mengbao.kantu.fab_pos':             { type: 'object',   def: {} },
        'mengbao.kantu.fab_pos_fold':        { type: 'any',      def: null },
        'mengbao.fanye.fab_pos':             { type: 'object',   def: {} },
        'mengbao.fanye.fab_pos_fold':        { type: 'any',      def: null },
        'mengbao.guolv.fab_pos_v2':          { type: 'object',   def: {} },
        'mengbao.guolv.fab_pos_fold':        { type: 'any',      def: null },
        'mengbao.zengqiang.fab_pos':         { type: 'object',   def: {} },
        'mengbao.zengqiang.fab_pos_fold':    { type: 'any',      def: null }
    };

    // 配置门面：校验 / 备份键 / 重置全部以 schema 为准，避免多处硬编码
    const Cfg = {
        schema: CONFIG_SCHEMA,
        keys() { return Object.keys(CONFIG_SCHEMA); },
        has(key) { return Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, key); },
        def(key) {
            const s = CONFIG_SCHEMA[key];
            if (!s) return undefined;
            if (s.def === null || typeof s.def !== 'object') return s.def;
            try { return JSON.parse(JSON.stringify(s.def)); } catch (e) { return s.def; }
        },
        backupKeys() { return Object.keys(CONFIG_SCHEMA).filter(k => CONFIG_SCHEMA[k].backup); },
        validate(key, v) {
            const s = CONFIG_SCHEMA[key];
            if (!s) return false;
            if (v === null || v === undefined) return false;
            // 直接走附加 validate（vOldOrNew 同时兼容旧结构与分桶结构）
            if (USER_STORE_KEYS.includes(key)) {
                return s.validate ? !!s.validate(v) : true;
            }
            switch (s.type) {
                case 'object':
                    if (typeof v !== 'object' || Array.isArray(v)) return false;
                    break;
                case 'array':
                    if (!Array.isArray(v)) return false;
                    break;
                case 'string[]':
                    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return false;
                    break;
                case 'number':
                    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
                    if (s.min !== undefined && (v < s.min || v > s.max)) return false;
                    break;
                case 'boolean':
                    if (typeof v !== 'boolean') return false;
                    break;
                case 'string':
                    if (typeof v !== 'string') return false;
                    if (s.maxLen && v.length > s.maxLen) return false;
                    break;
                case 'enum':
                    if (!s.values.includes(v)) return false;
                    break;
                case 'color':
                    if (typeof v !== 'string' || !Util.isValidColor(v)) return false;
                    break;
                default:
                    break;
            }
            return s.validate ? !!s.validate(v) : true;
        },
        // 重置：GM_listValues 全量清扫 + schema 键兜底，返回真实删除条数
        resetAll() {
            let n = 0;
            const seen = new Set();
            try {
                if (typeof GM_listValues === 'function') {
                    GM_listValues().forEach(k => {
                        if (!k.startsWith('mengbao.') || seen.has(k)) return;
                        seen.add(k);
                        if (GM_getValue(k, null) !== null) { GM_deleteValue(k); n++; }
                    });
                }
            } catch (e) { /* 未授权时走 schema 兜底 */ }
            Object.keys(CONFIG_SCHEMA).forEach(k => {
                if (seen.has(k)) return;
                try {
                    if (GM_getValue(k, null) !== null) { GM_deleteValue(k); n++; }
                } catch (e) { /* 单个键读写异常不能中断整轮重置，否则连 toast 和刷新都执行不到 */ }
            });
            return n;
        }
    };

    // ===================== 命名空间 =====================
    const Mengbao = {};

    Mengbao.Preview = {
        el(tid) { return document.getElementById(CONST.PREVIEW_ID_PREFIX + tid); },
        all() { return document.querySelectorAll('[id^="' + CONST.PREVIEW_ID_PREFIX + '"]'); },
        tidOf(id) { return String(id || '').slice(CONST.PREVIEW_ID_PREFIX.length); },
        clearAll() { this.all().forEach(el => el.remove()); }
    };

    // ===================== 右下角 Toast 提示 =====================
    // type: info | success | error | kantu | fanye | favorite
    function mbToast(msg, duration = CONST.TOAST_DURATION, type = 'info') {
        let container = document.getElementById('mb-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'mb-toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        const icons = { info:'ℹ️', success:'✅', error:'❌', kantu:'🖼️', fanye:'📄', favorite:'⭐' };
        toast.innerHTML = (icons[type] || icons.info) + ' <span>' + Util.escapeHtml(msg) + '</span>';
        toast.className = 'mb-toast mb-toast--' + type;
        container.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(24px)';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ===================== 工具函数 =====================
    const Util = Mengbao.Util = {
        storage: {
            // 未显式传 def 时回落到 schema 默认值
            get(key, def) {
                const fallback = (def === undefined && Cfg.has(key)) ? Cfg.def(key) : def;
                const raw = GM_getValue(key, null);
                if (raw === null || raw === undefined) return fallback;
                try { return JSON.parse(raw); } catch (e) { return fallback; }
            },
            set(key, val) {
                if (Cfg.has(key) && !Cfg.validate(key, val)) Util.log('warn', '配置值不符合 schema（仍写入）：', key);
                try { GM_setValue(key, JSON.stringify(val)); } catch (e) { Util.log('error', '存储写入失败：', e); }
            },
            remove(key) { try { GM_deleteValue(key); } catch (e) { Util.log('error', '存储删除失败：', e); } }
        },
        escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },
        escapeTextarea(str) {
            // escapeHtml 已把 < 转成 &lt;，</textarea> 不可能再被解析，无需二次转义
            return this.escapeHtml(str);
        },
        isValidColor(v) {
            if (typeof v !== 'string' || !v) return false;
            const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
            if (hex.test(v)) return true;
            const rgb = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+))?\s*\)$/);
            if (rgb) {
                return rgb.slice(1, 4).every(n => Number(n) >= 0 && Number(n) <= 255)
                    && (!rgb[4] || Number(rgb[4]) <= 1);
            }
            const hsl = v.match(/^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*(?:,\s*(0|1|0?\.\d+))?\s*\)$/);
            if (hsl) {
                return Number(hsl[1]) <= 360 && Number(hsl[2]) <= 100 && Number(hsl[3]) <= 100
                    && (!hsl[4] || Number(hsl[4]) <= 1);
            }
            return false;
        },
        clampNum(v, min, max, def) {
            if (v === null || v === undefined || String(v).trim() === '') return def;
            const n = Number(v);
            if (Number.isNaN(n)) return def;
            return Math.min(max, Math.max(min, n));
        },
        safeRun(label, fn) {
            try { return fn(); }
            catch (e) {
                this.log('error', label + ' 执行失败：', e);
                this.failToast(label, label + ' 执行失败：' + e.message, '模块');
            }
        },
        mergeConfig(defaults, saved) {
            const out = Object.assign({}, defaults);
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
            Object.keys(defaults).forEach(k => {
                const v = saved[k];
                if (v === undefined || v === null) return;
                const d = defaults[k];
                if (d === null) { out[k] = v; return; }
                if (typeof d === 'number' && typeof v === 'number' && !Number.isNaN(v)) out[k] = v;
                else if (typeof d === 'string' && typeof v === 'string') out[k] = v;
                else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
                else if (d && typeof d === 'object' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
            });
            return out;
        },
        async copyText(text) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                    return true;
                }
            } catch (e) {}
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.className = 'mb-copy-clipboard';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                return ok;
            } catch (e) { return false; }
        },
        // 日志分级输出到控制台；debug 级别读 mengbao.debug 开关（默认关），不刷生产控制台
        log(level, ...args) {
            if (level === 'debug') {
                const dbg = this.storage.get('mengbao.debug', false);
                if (!dbg) return;
            }
            const fn = console[level] || console.log;
            fn.apply(console, ['[萌宝小秘书]'].concat(args));
        },
        httpGet(url, extraHeaders) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: CONST.REQUEST_TIMEOUT,
                    headers: Object.assign({ 'Accept': 'text/html' }, extraHeaders || {}),
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) resolve(res.responseText);
                        else reject(new Error('HTTP ' + res.status));
                    },
                    onerror: () => reject(new Error('network')),
                    ontimeout: () => reject(new Error('timeout'))
                });
            });
        },
        httpPost(url, body) {
            return new Promise((resolve, reject) => {
                const headers = {};
                let data = body;
                if (body instanceof URLSearchParams) {
                    headers['Content-Type'] = 'application/x-www-form-urlencoded';
                    data = body.toString();
                }
                GM_xmlhttpRequest({
                    method: 'POST', url, timeout: CONST.REQUEST_TIMEOUT,
                    headers, data,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) resolve(res.responseText);
                        else reject(new Error('HTTP ' + res.status));
                    },
                    onerror: () => reject(new Error('network')),
                    ontimeout: () => reject(new Error('timeout'))
                });
            });
        },
        // 请求失败分级留痕，仅写入控制台日志
        recordFail(code, source) {
            this.log('warn', '请求失败', source || '', code || 'network');
        },
        toast(msg, t = 2000, type = 'info') {
            mbToast(msg, t, type);
        },
        _failToastBucket: {},
        failToast(key, singleMsg, pluralNoun = '帖子', windowMs = 4000) {
            const now = Date.now();
            // 顺带清理过期 key
            Object.keys(this._failToastBucket).forEach(k => {
                if (now - this._failToastBucket[k].ts > windowMs * 2) delete this._failToastBucket[k];
            });
            let b = this._failToastBucket[key];
            if (b && now - b.ts < windowMs) b.count++;
            else b = { ts: now, count: 1 };
            this._failToastBucket[key] = b;
            const msg = b.count > 1 ? `${b.count} 个${pluralNoun}加载失败，请稍后再试` : singleMsg;
            this.toast(msg, 2000);
        },
        showLoading(msg = '正在加载中…') {
            let container = document.getElementById('mb-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'mb-toast-container';
                document.body.appendChild(container);
            }
            let el = document.getElementById('mb-loading-indicator');
            if (!el) {
                el = document.createElement('div');
                el.id = 'mb-loading-indicator';
                el.className = 'mb-toast mb-toast--kantu';
                el.innerHTML = '<span class="mb-loading-spinner"></span><span class="mb-loading-text"></span>';
                container.insertBefore(el, container.firstChild);
            }
            el.querySelector('.mb-loading-text').textContent = msg;
            el.style.display = 'flex';
            requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(0)'; });
        },
        hideLoading() {
            const el = document.getElementById('mb-loading-indicator');
            if (el) {
                el.style.opacity = '0';
                el.style.transform = 'translateX(24px)';
                setTimeout(() => el.remove(), 300);
            }
        },
        parseHtml(html) { return new DOMParser().parseFromString(html, 'text/html'); },
        sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
        extractImages(root) {
            if (!root) return [];
            return this.extractImageNodes(root)
                .map(el => el.getAttribute('zoomfile') || el.getAttribute('file') || el.getAttribute('src')).filter(Boolean);
        },
        extractImageNodes(root) {
            if (!root) return [];
            return Array.from(root.querySelectorAll('img.zoom[file^="http"]:not([file*="static/image"])'));
        }
    };

    // ===================== 用户数据分桶存储 =====================
    // 需求：所有用户数据（收藏/评分/浏览历史/头像/面板设置/悬浮球记忆位置）按登录用户 ID 分离，
    //       A 网站账号 a 的数据不再出现在 B 网站账号 b 下。
    // 方案：键名不变，值结构改为 { 登录uid: 原值 }；未登录统一用 'guest' 桶。
    // 迁移：旧结构（无用户分桶）数据在首次启动时一次性迁移到当前登录用户桶。
    const USER_STORE_KEYS = [
        'mengbao.zengqiang.favorite_users',
        'mengbao.zengqiang.favorite',
        'mengbao.zengqiang.rated',
        'mengbao.zengqiang.favorite_groups',
        'mengbao.browse.history',
        'mengbao.avatars.user',
        'mengbao.comment.avatarChoice',
        'mengbao.comment.avatar',
        'mengbao.cmtfav.avatarChoice',
        'mengbao.cmtfav.avatar',
        'mengbao.panel.nickname',
        'mengbao.comment.width',
        'mengbao.comment.minLen',
        'mengbao.kantu.fab_pos',
        'mengbao.kantu.fab_pos_fold',
        'mengbao.fanye.fab_pos',
        'mengbao.fanye.fab_pos_fold',
        'mengbao.guolv.fab_pos_v2',
        'mengbao.guolv.fab_pos_fold',
        'mengbao.zengqiang.fab_pos',
        'mengbao.zengqiang.fab_pos_fold'
    ];
    let _currentUserId = -1;
    let _currentUserIdResolved = false;
    let _currentUserIdTries = 0;
    const UIDMAP_KEY = 'mengbao.user.uidmap';
    function uidMapGet(host) {
        try {
            const m = Util.storage.get(UIDMAP_KEY, null);
            if (m && typeof m === 'object' && !Array.isArray(m) && m[host]) return Number(m[host]);
        } catch (e) {}
        return -1;
    }
    function uidMapSet(host, uid) {
        try {
            if (!uid || uid === -1) return;
            const m = Util.storage.get(UIDMAP_KEY, null);
            const obj = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
            if (obj[host] === uid) return;
            obj[host] = uid;
            Util.storage.set(UIDMAP_KEY, obj);
        } catch (e) {}
    }
    // 当前登录用户 ID（-1=未登录）
    //         ② 解析成功后写 hostname→uid 映射；失败时先查本域名历史 uid，仍失败才落 guest
    function currentUserId() {
        if (_currentUserIdResolved) return _currentUserId;
        _currentUserIdTries++;
        try {
            if (typeof moduleZengqiang !== 'undefined' && moduleZengqiang.findMyUserId) {
                _currentUserId = moduleZengqiang.findMyUserId();
            }
        } catch (e) { /* 保持 -1 */ }
        const host = location.hostname;
        if (_currentUserId !== -1) {
            _currentUserIdResolved = true;
            uidMapSet(host, _currentUserId);
        } else if (_currentUserIdTries >= 5) {
            // 5 次都解析失败：按本域名历史 uid 兜底（同一域名下曾成功过，不是串号）
            const hist = uidMapGet(host);
            if (hist !== -1) { _currentUserId = hist; }
            _currentUserIdResolved = true;
        }
        return _currentUserId;
    }
    function userBucket(uid) {
        return (uid !== null && uid !== undefined && uid !== -1) ? String(uid) : 'guest';
    }
    const UserStore = {
        bucket: userBucket,
        curBucket() { return userBucket(currentUserId()); },
        // 读当前登录用户的分桶值；该用户无记录或无此键时返回 def
        get(key, def) {
            const raw = Util.storage.get(key, null);
            if (raw === null || raw === undefined) return def;
            const b = this.curBucket();
            if (typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, b)) {
                return raw[b];
            }

            // 当前桶是具体 uid 时绝不回退——否则账号 B 尚无自己的桶会读到账号 A 的数据（跨账号串号）
            if (b === 'guest' && typeof raw === 'object' && !Array.isArray(raw)) {
                const buckets = Object.keys(raw);
                if (buckets.length === 1) return raw[buckets[0]];
            }
            return def;
        },
        // 写当前登录用户的分桶值；保留其他用户的分桶
        set(key, val) {
            const raw = Util.storage.get(key, null);
            let obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
            const b = this.curBucket();
            let target = b;
            if (b === 'guest' && obj && typeof obj === 'object') {
                const buckets = Object.keys(obj);
                if (buckets.length === 1) target = buckets[0];
            }
            obj[target] = val;
            Util.storage.set(key, obj);
        },
        // 读指定用户的分桶（导出/迁移等场景）
        getFor(key, uid, def) {
            const raw = Util.storage.get(key, null);
            if (raw === null || raw === undefined) return def;
            const b = userBucket(uid);
            if (typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, b)) {
                return raw[b];
            }
            return def;
        },
        // 写指定用户的分桶（导入/迁移等场景）
        setFor(key, uid, val) {
            const raw = Util.storage.get(key, null);
            let obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
            obj[userBucket(uid)] = val;
            Util.storage.set(key, obj);
        },
        // 删除当前用户的分桶（保留其他用户桶）
        remove(key) {
            const raw = Util.storage.get(key, null);
            if (raw === null || raw === undefined) return;
            if (typeof raw === 'object' && !Array.isArray(raw)) {
                const b = this.curBucket();
                if (Object.prototype.hasOwnProperty.call(raw, b)) {
                    delete raw[b];
                    Util.storage.set(key, raw);
                }
            }
        },
        // 判断键的当前存储值是否为旧结构（无用户分桶）
        isOldStyle(key, raw) {
            if (raw === null || raw === undefined) return false;
            switch (key) {
                case 'mengbao.zengqiang.favorite_users':
                    return typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0
                        && Object.values(raw).every(v => v && typeof v === 'object' && !Array.isArray(v) && ('username' in v || 'favorited' in v));
                case 'mengbao.zengqiang.favorite':
                case 'mengbao.zengqiang.rated':
                case 'mengbao.browse.history':
                    return typeof raw === 'object' && !Array.isArray(raw) && typeof raw.time === 'number' && !!raw.data && typeof raw.data === 'object';
                case 'mengbao.zengqiang.favorite_groups':
                case 'mengbao.avatars.user':
                    return Array.isArray(raw);
                case 'mengbao.kantu.fab_pos':
                case 'mengbao.fanye.fab_pos':
                case 'mengbao.guolv.fab_pos_v2':
                case 'mengbao.zengqiang.fab_pos':
                    return typeof raw === 'object' && !Array.isArray(raw) && typeof raw.left === 'number';
                case 'mengbao.kantu.fab_pos_fold':
                case 'mengbao.fanye.fab_pos_fold':
                case 'mengbao.guolv.fab_pos_fold':
                case 'mengbao.zengqiang.fab_pos_fold':
                    return typeof raw === 'boolean';
                default:
                    return typeof raw !== 'object' || raw === null;
            }
        },
        // 将单个键的旧结构数据迁移到当前用户桶（导入场景复用）
        migrateKey(key) {
            const raw = Util.storage.get(key, null);
            if (raw === null || raw === undefined) return;
            if (this.isOldStyle(key, raw)) {
                Util.storage.set(key, { [this.curBucket()]: raw });
                Util.log('debug', '用户数据迁移：', key, '→', this.curBucket());
            }
        },
        // 首次启动一次性迁移全部旧结构数据到当前登录用户桶
        migrateAllOnce() {
            // 单独把旧平铺结构（含 hiddenSections/keywordBlackList 键）迁到当前用户桶；guest 桶由单桶回退兜底读取
            try {
                const gRaw = Util.storage.get('mengbao.guolv.config', null);
                const gb = this.curBucket();
                if (gRaw && typeof gRaw === 'object' && !Array.isArray(gRaw)
                    && ('hiddenSections' in gRaw || 'keywordBlackList' in gRaw)
                    && !Object.prototype.hasOwnProperty.call(gRaw, gb)) {
                    Util.storage.set('mengbao.guolv.config', { [gb]: gRaw });
                    Util.log('info', '过滤配置迁移到用户分桶：', gb);
                }
            } catch (e) { Util.log('error', '过滤配置迁移失败：', e); }
            if (Util.storage.get('mengbao.userstore.migrated', false)) return;
            USER_STORE_KEYS.forEach(k => this.migrateKey(k));
            Util.storage.set('mengbao.userstore.migrated', true);
            Util.log('info', '用户数据存储迁移完成');
        }
    };
    Util.userStore = UserStore;

    // 收藏用户的显示顺序。必须单独存数组：favorite_users 的键是 uid（纯数字字符串），
    // JS 会把整数键强制按数值升序排列，所以对象本身记不住拖拽顺序。
    const FAV_USER_ORDER_KEY = 'mengbao.zengqiang.favorite_users_order';
    Util.favUserOrder = {
        // 读顺序：以保存的数组为准，剔除已不存在的 uid，补齐新增（补在末尾）
        get(all) {
            const keys = Object.keys(all || {}).map(String);
            const saved = Util.userStore.get(FAV_USER_ORDER_KEY, []);
            if (!Array.isArray(saved) || !saved.length) return keys.slice();
            const out = saved.map(String).filter(uid => keys.indexOf(uid) !== -1);
            keys.forEach(uid => { if (out.indexOf(uid) === -1) out.push(uid); });
            return out;
        },
        save(list) {
            Util.userStore.set(FAV_USER_ORDER_KEY, Array.isArray(list) ? list.map(String) : []);
        },
        // 新收藏追加到末尾（须在写入 favorite_users 之前调用）
        add(uid) {
            const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            const list = this.get(all);
            const k = String(uid);
            if (list.indexOf(k) === -1) { list.push(k); this.save(list); }
        },
        remove(uid) {
            const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            const list = this.get(all).filter(x => x !== String(uid));
            this.save(list);
        }
    };

    function isSearchResultPage(url) { return /search\.php/.test(url || location.href); }
    function isDarkroomPage(url) { return /mod=misc&action=showdarkroom/.test(url || location.href); }
    function isGuidePage(url) { return /mod=guide/.test(url || location.href); }
    function isForumListPage(url) { return /mod=forumdisplay|\/forum-\d+-\d+\.html/.test(url || location.href); }
    function isThreadPage(url) { return /mod=viewthread/.test(url || location.href) || /thread-\d+(-\d+)*\.html/.test(url || location.href); }
    function isSpaceThreadPage(url) { return /mod=space.*do=thread.*view=me(?!.*type=reply)/.test(url || location.href); }
    function isSpaceReplyPage(url) { return /mod=space.*do=thread.*type=reply/.test(url || location.href); }
    function isSpaceFavPage(url) {
        const u = url || location.href;
        return u.includes('mod=space') && u.includes('do=favorite');
    }

    // 右键用户名跳转：解析设置，返回目标地址；返回空值表示不接管（交还原生右键菜单）
    // 主闭包四处绑定 + Vue 评论区委托共用这一份判断，设置里选「关闭」时全部放行
    function resolveUserJump(uid) {
        if (!uid) return '';
        const target = Util.storage.get('mengbao.jump_target', 'home');
        if (target === 'off') return '';
        let url = `home.php?mod=space&uid=${uid}`;
        if (target === 'thread') url = `home.php?mod=space&uid=${uid}&do=thread&view=me&from=space&type=thread`;
        else if (target === 'reply') url = `home.php?mod=space&uid=${uid}&do=thread&view=me&from=space&type=reply`;
        return url;
    }

    // 给元素挂右键跳转（收藏用户胶囊 / 列表页作者 / 搜索页作者 / 详情页楼层作者）
    function bindUserJumpMenu(el, uid) {
        if (!el || !uid || el.dataset.mbJumpBound === '1') return;
        el.dataset.mbJumpBound = '1';
        el.addEventListener('contextmenu', (e) => {
            const url = resolveUserJump(uid);
            if (!url) return;
            e.preventDefault();
            window.open(url, '_blank');
        });
    }

    // ===================== 域名白名单（@match 通配由 JS 守卫；设置页可编辑） =====================
    // 默认白名单域名（清空自定义配置时回落此项）：1.0 起内置 5 个常用站群域名，精确匹配 hostname
    const DEFAULT_HOSTS = Cfg.def('mengbao.site.hosts');
    let TARGET_HOSTS = Util.storage.get('mengbao.site.hosts', DEFAULT_HOSTS);
    if (!Array.isArray(TARGET_HOSTS) || !TARGET_HOSTS.length) TARGET_HOSTS = DEFAULT_HOSTS;
    const IS_HOST_ALLOWED = TARGET_HOSTS.includes(location.hostname);

    // 非白名单域名也保留独立「白名单管理」菜单，避免默认域名失效后无法自助加白；其余功能在守卫后零副作用
    GM_registerMenuCommand('🌐 白名单管理', openHostManager);
    if (!IS_HOST_ALLOWED) return;

    // 跨闭包通信统一挂到 MB_BRIDGE（沿用原有全局暴露策略，不新增对外接口）
    window.MB_BRIDGE = window.MB_BRIDGE || {};
    window.MB_BRIDGE.storage = Util.storage;
    window.MB_BRIDGE.userStore = Util.userStore;
    window.MB_BRIDGE.httpGet = (url) => Util.httpGet(url);
    window.MB_BRIDGE.log = (level, ...args) => Util.log(level, ...args);
    window.MB_BRIDGE.toast = (msg, t, type) => mbToast(msg, t, type);
    window.MB_BRIDGE.defaultHosts = DEFAULT_HOSTS;
    window.MB_BRIDGE.resolveUserJump = resolveUserJump;

    // ===================== CSS 注入 =====================
    function injectStyle() {
        const kantuCfg = Util.storage.get('mengbao.kantu.config', {});
        const galleryBg = Util.isValidColor(kantuCfg.GALLERY_BG_COLOR) ? kantuCfg.GALLERY_BG_COLOR : '#faf8f5';
        const galleryCell = Util.isValidColor(kantuCfg.GALLERY_CELL_COLOR) ? kantuCfg.GALLERY_CELL_COLOR : '#f8fafc';
        const favoriteHlBg = Util.isValidColor(Util.storage.get('mengbao.favorite_highlight_bg', '')) ? Util.storage.get('mengbao.favorite_highlight_bg') : '#dbeafe';
        const favoriteHlTitle = Util.isValidColor(Util.storage.get('mengbao.favorite_highlight_title', '')) ? Util.storage.get('mengbao.favorite_highlight_title') : '#d97706';
        GM_addStyle(`
        :root{
            --mb-accent:#4096ff; --mb-danger:#dc2626; --mb-danger-soft:#fee2e2;
            --mb-accent-soft:#eef4ff; --mb-accent-deep:#1d6fd1; --mb-accent-line:#d6e4ff;
            --mb-accent-soft-hover:#ddeeff;
            --mb-text-muted:#666;
            --mb-text-primary:#222; --mb-text-hint:#999;
            --mb-bg-page:#fff; --mb-bg-secondary:#f0f0f0; --mb-border:#e5e7eb; --mb-disabled-hover:#d1d5db;
            --mb-text-on-accent:#fff;
            /* 四球色系：看图=蓝 / 翻页=紫 / 过滤=绿 / 增强=中性白 */
            --mb-amber:#f9a825; --mb-amber-glow:rgba(249,168,37,0.22);   /* 选中高亮黄：缩略条 active 框、收藏定位闪环 */
            --mb-blue:#3b82f6; --mb-blue-soft:#bfdbfe; --mb-blue-soft-hover:#93c5fd; --mb-blue-glow:rgba(59,130,246,0.35);
            --mb-purple:#8b5cf6; --mb-purple-soft:#ddd6fe; --mb-purple-soft-hover:#c4b5fd; --mb-purple-glow:rgba(139,92,246,0.35);
            --mb-green-soft:#bbf7d0; --mb-green-soft-hover:#86efac;   /* 过滤球只做浅底，无连续态故不设主色 */
            --mb-neutral-soft:#e2e8f0; --mb-neutral-soft-hover:#cbd5e1;
            /* toast 浮层色系：深色调 + 92% 不透明，浮在页面上不糊字 */
            --mb-toast-info:rgba(55,65,81,0.92);
            --mb-toast-success:rgba(22,101,52,0.92);
            --mb-toast-error:rgba(153,27,27,0.92);
            --mb-toast-kantu:rgba(30,64,175,0.92);
            --mb-toast-fanye:rgba(107,33,168,0.92);
            --mb-toast-favorite:rgba(245,166,35,0.92);
            --mb-font-title:15px; --mb-font-md:13px; --mb-font-sm:12px;
            --mb-font-xs:11px; --mb-font-xl:24px; --mb-font-fab:22px;
            --mb-radius:12px; --mb-radius-sm:6px; --mb-radius-lg:16px; --mb-radius-pill:999px;
            --mb-shadow-xs:0 1px 3px rgba(0,0,0,0.1);
            --mb-shadow-sm:0 2px 8px rgba(0,0,0,0.12);
            --mb-shadow-md:0 4px 16px rgba(0,0,0,0.12);
            --mb-shadow-lg:0 8px 20px rgba(0,0,0,0.16);
            --mb-modal-padding:20px;
            --mb-t-fast:0.15s; --mb-t-base:0.2s; --mb-t-slow:0.25s;
            --mb-size-icon-sm:16px; --mb-size-icon-md:32px;
            --mb-active-bg:#fff3b8;
            --mb-z-fab:2147482000; --mb-z-toast:2147485000; --mb-z-modal:2147483500; --mb-z-guide:2147483400;
            --mb-z-gallery:2147484000; --mb-z-single:2147484500;
            --mb-gallery-bg:${galleryBg}; --mb-gallery-cell:${galleryCell};
            --mb-favorite-on:#f5a623;
            --mb-favorite-highlight-bg:${favoriteHlBg}; --mb-favorite-highlight-title:${favoriteHlTitle};
            /* 布局尺寸变量（集中管理） */
            --mb-dialog-width-sm:460px;      /* 弹窗外框宽（小：提示/确认/白名单等） */
            --mb-dialog-width-md:548px;      /* 弹窗外框宽（中：收藏馆） */
            --mb-dialog-width-lg:600px;      /* 弹窗外框宽（大：仅通用设置，两列控件右对齐后 600 更匀称） */
        }
        /* 底色与划线由 --mb-browsed-bg / --mb-browsed-strike 控制，运行时按设置注入（见 BrowseHistory.markList） */
        .mb-browsed, .mb-browsed th, .mb-browsed td {
            background:var(--mb-browsed-bg, #f0f0f0) !important;
        }
        .mb-browsed a.xst, .mb-browsed th a, .mb-browsed a.mb-favorite-user-thread-title {
            color:var(--mb-text-hint, #999) !important;
            text-decoration:var(--mb-browsed-strike, line-through) !important;
        }
        .mb-browsed td.icn img, .mb-browsed td.icn a img, .mb-browsed .icn img, .mb-browsed .icn a img {
            filter:none !important;
            opacity:1 !important;
        }
        /* New 标签恢复原生可见（不再淡化） */
        .mb-browsed .new, .mb-browsed .new img { opacity:1 !important; }
        /*收藏用户发的帖子高亮（列表页 + 搜索页）——左缘主题条 + 整行背景（恢复整行底色） */
        tr.mb-favorite-user-thread-row th,
        tr.mb-favorite-user-thread-row td,
        #threadlist li.pbw.mb-favorite-user-thread-row {
            background: var(--mb-favorite-highlight-bg, #dbeafe) !important;
        }
        tr.mb-favorite-user-thread-row th:first-child,
        tr.mb-favorite-user-thread-row td:first-child,
        #threadlist li.pbw.mb-favorite-user-thread-row {
            box-shadow: inset 3px 0 0 var(--mb-accent) !important;
        }
        tr.mb-favorite-user-thread-row:hover th,
        tr.mb-favorite-user-thread-row:hover td,
        #threadlist li.pbw.mb-favorite-user-thread-row:hover {
            background: var(--mb-accent-soft-hover) !important;
        }
        a.mb-favorite-user-thread-title {
            font-weight: bold !important;
            color: var(--mb-favorite-highlight-title) !important;
            text-decoration: none !important;
        }
        /* 已读+收藏用户：保留划线（删除线），颜色背景按收藏行方式（蓝底 + 左缘条 + 橙标题降透明度） */
        tr.mb-favorite-user-thread-row.mb-browsed th,
        tr.mb-favorite-user-thread-row.mb-browsed td,
        #threadlist li.pbw.mb-favorite-user-thread-row.mb-browsed {
            background: var(--mb-favorite-highlight-bg, #dbeafe) !important;
        }
        tr.mb-favorite-user-thread-row.mb-browsed th:first-child,
        tr.mb-favorite-user-thread-row.mb-browsed td:first-child,
        #threadlist li.pbw.mb-favorite-user-thread-row.mb-browsed {
            box-shadow: inset 3px 0 0 var(--mb-accent) !important;
        }
        tr.mb-favorite-user-thread-row.mb-browsed a.mb-favorite-user-thread-title,
        tr.mb-favorite-user-thread-row.mb-browsed a.xst,
        #threadlist .pbw.mb-favorite-user-thread-row.mb-browsed a.mb-favorite-user-thread-title,
        #threadlist .pbw.mb-favorite-user-thread-row.mb-browsed a.xst,
        #threadlist .pbw.mb-favorite-user-thread-row.mb-browsed h3 a,
        #threadlist .pbw.mb-favorite-user-thread-row.mb-browsed .xs3 a {
            color:var(--mb-text-hint, #999) !important;
            opacity:1;
            text-decoration:line-through !important;
        }
        .mb-favorite-user-author { font-weight:bold !important; color:var(--mb-accent) !important; }
        /* 已浏览行里的作者名仍按收藏色，不被已读的灰色压掉 */
        .mb-browsed a.mb-favorite-user-author { color:var(--mb-accent) !important; text-decoration:none !important; }
        /*公共胶囊基础 class，各变体用 modifier 调整尺寸/颜色 */
        .mb-pill { display:inline-flex; align-items:center; border-radius:var(--mb-radius); cursor:pointer; user-select:none; white-space:nowrap; }
        .mb-pill--outline { background:var(--mb-bg-page); border:1px solid var(--mb-accent-line); color:var(--mb-accent-deep); }
        @keyframes mb-spin { to { transform:rotate(360deg); } }
        .mb-fab { position:fixed;z-index:var(--mb-z-fab);user-select:none;-webkit-user-select:none; }
        :root { --mb-fab-size:44px; }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
        input[type=number] { -moz-appearance:textfield; appearance:textfield; }
        .mb-fab--kantu { left:24px;right:auto;bottom:280px;top:auto; }
        .mb-fab--fanye { left:24px;right:auto;bottom:200px;top:auto; } .mb-fanye-page-label { position:absolute; bottom:-24px; left:50%; transform:translateX(-50%); font-size:var(--mb-font-sm); color:var(--mb-purple); background:rgba(237,233,254,0.85); padding:4px 10px; border-radius:var(--mb-radius); white-space:nowrap; box-shadow:var(--mb-shadow-sm); backdrop-filter:blur(8px); transition:all var(--mb-t-base); cursor:default; }
        .mb-fanye-page-label:hover { background:rgba(221,214,254,0.95); box-shadow:var(--mb-shadow-md); }
        .mb-fab--zengqiang { left:24px;right:auto;bottom:360px;top:auto; }
        .mb-fab--guolv { left:24px;right:auto;bottom:720px;top:auto; } .mb-fab-btn--guolv { background:var(--mb-green-soft); border:1px solid rgba(34,197,94,0.30); }
        .mb-fab-btn--guolv:hover { background:var(--mb-green-soft-hover); }
        body:has(#threadlist.mb-search-card) #scform,
        body:has(#threadlist.mb-search-card) .by,
        body:has(#threadlist.mb-search-card) .pg,
        body:has(#threadlist.mb-search-card) .pgs,
        /* 搜索页宽度对齐论坛版心。论坛 #wp 固定 1200，实测列表页 / 帖子页 / 首页的内容容器均为 1200，左右边界 47 / 1247；搜索页限宽同步为 1200，四页边缘重合。 */
        /* 搜索页模板没有 #wp，外层 #ct 原生按「视口减左右各 20」撑到 1254，比版心左右各宽出 27px，因此连 #ct 一并收进版心。 */
        /* 原值 1400 是按 1311 视口调宽的临时值，实绘会超出论坛版心 200px。实测搜索页是卡片垂直流、无表格列，收窄后标题仍正常折行，不挤压作者、分页等信息，视觉变化仅为个别长标题的折行位置。 */
        #threadlist.mb-search-card { max-width:1200px !important; margin:0 auto !important; float:none !important; width:100% !important; box-sizing:border-box; }
        body:has(#threadlist.mb-search-card) #ct { max-width:1200px !important; margin-left:auto !important; margin-right:auto !important; }
        /* 卡片区去掉左右 12px 内边距，让卡片左右边缘与论坛表格完全齐平（搜索页两侧本就留有大片空白，无需再额外留白）；上下方向的外边距不变，卡片间距照旧。 */
        #threadlist.mb-search-card { padding:0; }
        #threadlist.mb-search-card .pbw { border:1px solid rgba(128,140,150,.35) !important; border-radius:var(--mb-radius) !important; padding:12px !important; margin:0 0 12px 0 !important; background:var(--mb-bg-page) !important; float:none !important; clear:both !important; list-style:none !important; }
        /* 搜索页卡片与表格页共用同一组变量，之前这里写死 --mb-bg-secondary，导致自定义底色在搜索页不生效 */
        #threadlist .pbw.mb-browsed,
        #threadlist.mb-search-card .pbw.mb-browsed {
            background:var(--mb-browsed-bg, #f0f0f0) !important;
        }
        #threadlist .pbw.mb-browsed h3 a,
        #threadlist .pbw.mb-browsed .xs3 a,
        #threadlist .pbw.mb-browsed a.xst,
        #threadlist .pbw.mb-browsed a.mb-favorite-user-thread-title {
            color:var(--mb-text-hint, #999) !important;
            text-decoration:var(--mb-browsed-strike, line-through) !important;
        }
        #threadlist.mb-search-card .pbw:last-child { margin-bottom:0 !important; }
        .mb-fab-btn { width:var(--mb-fab-size);height:var(--mb-fab-size);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:var(--mb-font-fab);line-height:1;cursor:pointer;box-shadow:var(--mb-shadow-sm);border:1px solid rgba(0,0,0,0.06);outline:none;box-sizing:border-box; transition:background var(--mb-t-fast), opacity var(--mb-t-base); }
        .mb-fab-loading { opacity:0.6; cursor:wait; }
        .mb-fab-panel { position:absolute;top:calc(100% + 8px);left:0;width:fit-content;max-width:min(260px, calc(100vw - 48px));border-radius:var(--mb-radius);background:var(--mb-bg-page);box-shadow:var(--mb-shadow-sm);border:1px solid var(--mb-border);padding:16px; opacity:0; transform:translateY(-6px); transition:opacity var(--mb-t-base) ease, transform var(--mb-t-base) ease; pointer-events:none; }
        .mb-fab-panel--open { opacity:1; transform:translateY(0); pointer-events:auto; }
        .mb-zengqiang-panel { padding:12px 0; width:96px; box-sizing:border-box; border-radius:var(--mb-radius-lg); }
        .mb-zengqiang-panel .mb-quick-btn { border-radius:0; padding:8px 12px; justify-content:center; text-align:center; }
        body.mb-kantu-hidden [id^="mb-kantu-"] { display:none !important; }
        .mb-fab-btn--kantu { background:var(--mb-blue-soft); border:1px solid rgba(59,130,246,0.30); }
        .mb-fab-btn--kantu:hover { background:var(--mb-blue-soft-hover); }
        .mb-fab-btn--kantu.mb-continuous { background:var(--mb-blue-soft-hover); border:2px solid var(--mb-blue); animation:mb-spin 1s linear infinite; box-shadow:0 0 0 4px var(--mb-blue-glow); }
        .mb-fab-btn--kantu.mb-continuous:hover { background:var(--mb-blue-soft-hover); }
        .mb-fab-btn--kantu.mb-paused { background:var(--mb-border); }
        .mb-fab-btn--kantu.mb-paused:hover { background:var(--mb-disabled-hover); }
        .mb-fab-btn--zengqiang { background:var(--mb-neutral-soft); border:1px solid rgba(100,116,139,0.22); }
        .mb-fab-btn--fanye { background:var(--mb-purple-soft); border:1px solid rgba(139,92,246,0.30); }
        .mb-fab-btn--fanye:hover { background:var(--mb-purple-soft-hover); }
        .mb-fab-btn--fanye.mb-loading { background:var(--mb-purple-soft-hover); border:2px solid var(--mb-purple); animation:mb-spin 1s linear infinite; box-shadow:0 0 0 3px var(--mb-purple-glow); }
        .mb-fab-btn--fanye.mb-continuous { background:var(--mb-purple-soft-hover); border:2px solid var(--mb-purple); animation:mb-spin 1s linear infinite; box-shadow:0 0 0 4px var(--mb-purple-glow); }
        .mb-fab-btn--zengqiang:hover { background:var(--mb-neutral-soft-hover); }
        .mb-guolv-panel { position:absolute;top:calc(100% + 8px);left:0;right:auto;transform:none;width:max-content;min-width:0;max-width:min(300px, calc(100vw - 48px));background:var(--mb-bg-page);border-radius:var(--mb-radius);box-shadow:var(--mb-shadow-md);border:none;padding:16px;box-sizing:border-box; max-height:min(80vh,620px); overflow-y:auto; transition:opacity var(--mb-t-base) ease; }
        .mb-guolv-panel--2col { max-width:min(460px, calc(100vw - 48px)); }
        .mb-guolv-panel--1col { max-width:min(300px, calc(100vw - 48px)); }
        .mb-guolv-grid { display:grid;grid-template-columns:1fr;gap:8px 10px; }
        .mb-guolv-grid .mb-guolv-item { margin:0;justify-content:flex-start;text-align:left; }
        .mb-guolv-grid .mb-guolv-item .mb-guolv-count { flex-shrink:0;width:18px;height:18px; }
        .mb-quick-btn { border:none;background:transparent;text-align:left;padding:8px 10px;border-radius:var(--mb-radius);cursor:pointer;font-size:var(--mb-font-md);color:var(--mb-text-primary);width:100%;display:flex;align-items:center;gap:8px;white-space:nowrap;box-sizing:border-box;min-height:32px; }
        .mb-quick-btn:hover { background:var(--mb-bg-secondary); }
        .mb-quick-btn.mb-active { background:var(--mb-active-bg); }
        .mb-guolv-item { display:flex;align-items:center;justify-content:center;gap:6px;font-size:var(--mb-font-sm);padding:4px 10px;margin:0;border-radius:var(--mb-radius);cursor:pointer;text-decoration:none !important;color:var(--mb-text-primary);white-space:nowrap;background:var(--mb-bg-page);border:1px solid var(--mb-border);max-width:100%;overflow:hidden;text-overflow:ellipsis;transition:background var(--mb-t-fast) ease, border-color var(--mb-t-fast) ease; }
        .mb-guolv-item:hover{background:var(--mb-accent-soft);border-color:var(--mb-accent-line);}
        .mb-guolv-item.mb-hidden{color:var(--mb-text-muted);text-decoration:line-through !important;text-decoration-color:var(--mb-text-muted) !important;text-decoration-thickness: 1.5px;background:var(--mb-bg-secondary);border-color:var(--mb-border);}
        .mb-guolv-item.mb-only { background:var(--mb-accent); border-color:var(--mb-accent); color:var(--mb-text-on-accent); font-weight:600; }
        .mb-guolv-item.mb-only:hover { background:var(--mb-accent-deep); }
        .mb-guolv-item.mb-only .mb-guolv-count { background:rgba(255,255,255,0.25); color:var(--mb-text-on-accent); }
        .mb-guolv-count { display:inline-flex;align-items:center;justify-content:center;min-width:20px;width:20px;height:20px;padding:0 2px;background:var(--mb-accent-soft,#eef2ff);color:var(--mb-accent-deep,#1d4ed8);border-radius:var(--mb-radius-pill);font-size:var(--mb-font-sm);font-weight:600; }
        .mb-guolv-grid .mb-guolv-item.mb-hidden .mb-guolv-count { background:var(--mb-bg-secondary);color:var(--mb-text-muted); }
        .mb-modal-mask { position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:var(--mb-z-modal);display:flex;align-items:center;justify-content:center; }
        .mb-modal-box { box-sizing:border-box;background:var(--mb-bg-page);border-radius:var(--mb-radius);padding:var(--mb-modal-padding);box-shadow:var(--mb-shadow-sm);max-width:92%;max-height:92vh;overflow-y:auto;overflow-x:hidden;font-family:Tahoma, Helvetica, "Microsoft Yahei", sans-serif; }
        .mb-modal-box--sm { width:var(--mb-dialog-width-sm); }
        /* 头像弹窗：昵称行 + 3×3 九宫格要同时放得下，比通用小弹窗再宽一档 */
        .mb-modal-box.mb-avatar-modal { width:500px; }
        .mb-modal-box--md { width:var(--mb-dialog-width-md); }
        .mb-modal-box--setting { padding:24px 20px 20px; width:var(--mb-dialog-width-lg); }
        .mb-gallery-mask { position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:var(--mb-z-gallery);display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);opacity:0;transition:opacity var(--mb-t-base) ease; }
        .mb-gallery-box { width:90%;max-width:1500px;height:82vh;background:var(--mb-gallery-bg);border-radius:var(--mb-radius);display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--mb-shadow-sm);transform:scale(0.95);transition:transform var(--mb-t-base) ease; }
        .mb-gallery-header { padding:12px 20px;color:var(--mb-text-primary);flex-shrink:0;position:relative;background:var(--mb-gallery-bg,#faf8f5);border-radius:var(--mb-radius) var(--mb-radius) 0 0;display:flex;align-items:center;gap:12px;box-shadow:var(--mb-shadow-xs); }
        .mb-gallery-count { margin-left:auto;flex-shrink:0;background:var(--mb-accent-soft,#eef2ff);padding:4px 12px;border-radius:var(--mb-radius);font-size:var(--mb-font-md);color:var(--mb-accent-deep,#1d4ed8);font-weight:500;user-select:none;white-space:nowrap; }
        .mb-gallery-title { font-size:var(--mb-font-title);font-weight:600;color:var(--mb-text-primary);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .mb-gallery-grid { flex:1;padding:20px;overflow:auto;display:grid;grid-template-columns:repeat(5, 1fr);gap:16px;align-content:flex-start;background:var(--mb-gallery-bg); }
        
        .mb-gallery-grid::-webkit-scrollbar { width:8px; height:8px; }
        .mb-gallery-grid::-webkit-scrollbar-thumb { background:var(--mb-border);border-radius:var(--mb-radius-sm); }
        .mb-gallery-grid::-webkit-scrollbar-thumb:hover { background:var(--mb-text-hint); }
        .mb-gallery-grid::-webkit-scrollbar-track { background:transparent; }
        .mb-modal-box::-webkit-scrollbar, .mb-favorite-users-list::-webkit-scrollbar,
        .mb-comment-scroll::-webkit-scrollbar,
        .mb-comment-content::-webkit-scrollbar, .mb-guolv-kw-input::-webkit-scrollbar { width:8px; height:8px; }
        .mb-modal-box::-webkit-scrollbar-thumb, .mb-favorite-users-list::-webkit-scrollbar-thumb,
        .mb-comment-scroll::-webkit-scrollbar-thumb,
        .mb-comment-content::-webkit-scrollbar-thumb, .mb-guolv-kw-input::-webkit-scrollbar-thumb { background:var(--mb-border); border-radius:var(--mb-radius-sm); }
        .mb-modal-box::-webkit-scrollbar-thumb:hover, .mb-favorite-users-list::-webkit-scrollbar-thumb:hover,
        .mb-comment-scroll::-webkit-scrollbar-thumb:hover,
        .mb-comment-content::-webkit-scrollbar-thumb:hover, .mb-guolv-kw-input::-webkit-scrollbar-thumb:hover { background:var(--mb-text-hint); }
        .mb-modal-box::-webkit-scrollbar-track, .mb-favorite-users-list::-webkit-scrollbar-track,
        .mb-comment-scroll::-webkit-scrollbar-track,
        .mb-comment-content::-webkit-scrollbar-track, .mb-guolv-kw-input::-webkit-scrollbar-track { background:transparent; }
        .mb-gallery-divider { grid-column: 1 / -1; width:100%; display:flex; align-items:center; gap:12px; color:var(--mb-text-hint); font-size:var(--mb-font-md); padding:8px 0; margin:4px 0; }
        .mb-gallery-divider::before, .mb-gallery-divider::after { content:""; flex:1; height:1px; background:var(--mb-border); }
        .mb-gallery-cell { height:300px;border-radius:var(--mb-radius);display:flex;align-items:center;justify-content:center;background:var(--mb-gallery-cell);box-sizing:border-box;overflow:hidden;cursor:pointer;position:relative;box-shadow:var(--mb-shadow-sm);transition:box-shadow var(--mb-t-base) ease, transform var(--mb-t-base) ease; }
        .mb-gallery-cell:hover { box-shadow:var(--mb-shadow-lg); transform:translateY(-2px); }
        .mb-gallery-cell img { width:100%;height:100%;object-fit:contain;display:none;border-radius:var(--mb-radius); }
        .mb-gallery-slow { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); display:none; font-size:var(--mb-font-sm); color:var(--mb-text-muted); background:rgba(255,255,255,0.88); padding:3px 10px; border-radius:var(--mb-radius-sm); white-space:nowrap; z-index:2; }
        .mb-gallery-fallback { color:var(--mb-text-hint);font-size:var(--mb-font-sm);text-align:center;padding:0 12px;line-height:1.6; }
        .mb-gallery-cell.is-error { background:var(--mb-bg-secondary); box-shadow:var(--mb-shadow-xs); }
        .mb-gallery-loading { width:var(--mb-size-icon-md); height:var(--mb-size-icon-md); border:3px solid rgba(255,255,255,0.3); border-top-color:var(--mb-accent); border-radius:50%;animation:mb-spin 0.8s linear infinite; position:relative; z-index:1; }
        .mb-gallery-go { position:absolute;bottom:6px;right:6px;background:rgba(255,255,255,0.85);color:var(--mb-accent-deep);font-size:var(--mb-font-sm);padding:4px 8px;border-radius:var(--mb-radius);cursor:pointer;opacity:0.85;z-index:2;display:flex;align-items:center;gap:4px;user-select:none;outline:none;backdrop-filter:blur(4px);transition:opacity var(--mb-t-fast); }
        .mb-gallery-cell:hover .mb-gallery-go { opacity:1; }
        .mb-gallery-go:hover { background:var(--mb-bg-page); }
        /* 大图上限为内容区 100%，超大图等比缩到视口内完整可见；
           早前 max:none 会让 1536×2048 这类原图按 1:1 溢出视口、四周被裁 */
        .mb-single-view { position:fixed;inset:0;background:rgba(0,0,0,0.82);display:none;align-items:center;justify-content:center;z-index:var(--mb-z-single);box-sizing:border-box;padding:76px 24px 104px; }
        .mb-single-bar { position:absolute;top:0;left:0;right:0;height:52px;display:flex;align-items:center;gap:8px;padding:0 20px;box-sizing:border-box;background:linear-gradient(180deg,rgba(0,0,0,0.82) 0%,rgba(0,0,0,0.58) 58%,rgba(0,0,0,0) 100%);box-shadow:inset 0 -1px 0 rgba(255,255,255,0.08);z-index:12;cursor:pointer;transition:background var(--mb-t-base) ease; }
        .mb-single-bar:hover { background:linear-gradient(180deg,rgba(0,0,0,0.88) 0%,rgba(0,0,0,0.66) 58%,rgba(0,0,0,0) 100%); }
        .mb-single-view img { max-width:100%;max-height:100%;width:auto;height:auto;flex:none;object-fit:contain;z-index:1;cursor:default;transition:transform var(--mb-t-base) ease;user-select:none;-webkit-user-drag:none; }
        .mb-single-loading { position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:var(--mb-text-on-accent); z-index:2; }
        .mb-single-loading::before { content:''; display:inline-block; width:40px; height:40px; border:3px solid var(--mb-text-on-accent); border-top-color:transparent; border-radius:50%; animation:mb-spin 0.8s linear infinite; margin-right:12px; vertical-align:middle; }
        .mb-single-slow { display:none; margin-left:12px; vertical-align:middle; font-size:var(--mb-font-md); white-space:nowrap; }
        .mb-single-fail { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:var(--mb-text-on-accent); font-size:var(--mb-font-md); z-index:2; display:none; }
        .mb-single-thumbs { position:absolute; bottom:10px; left:50%; transform:translateX(-50%); display:flex; gap:6px; z-index:2; max-width:70%; overflow-x:auto; padding:6px 10px 16px; background:rgba(0,0,0,0.4); border-radius:var(--mb-radius-sm); scrollbar-width:none; }
        .mb-single-thumbs::-webkit-scrollbar { display:none; }
        .mb-single-thumb { flex-shrink:0; width:56px; height:56px; border-radius:var(--mb-radius-sm); overflow:hidden; cursor:pointer; opacity:0.5; transition:opacity var(--mb-t-base), transform var(--mb-t-base); border:2px solid transparent; position:relative; }
        .mb-single-thumb:hover { opacity:0.8; transform:scale(1.1); }
        .mb-single-thumb.active { opacity:1; border:3px solid var(--mb-amber); transform:scale(1.15); box-shadow:0 0 0 2px var(--mb-amber-glow); }
        .mb-single-thumb img { width:100%; height:100%; object-fit:cover; }
        .mb-single-counter { background:none;padding:0;color:rgba(255,255,255,0.92);font-size:13px;font-weight:500;letter-spacing:0.3px;text-shadow:0 1px 2px rgba(0,0,0,0.65);user-select:none;white-space:nowrap;margin-right:auto;pointer-events:none; }
        .mb-single-btn { width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.28);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background var(--mb-t-base) ease,border-color var(--mb-t-base) ease; }
        .mb-single-btn:hover { background:rgba(255,255,255,0.22); border-color:rgba(255,255,255,0.55); }
        /* 关闭键与旋转键同款玻璃底，只靠图标区分；仅悬停时变红，提示「这是关闭」 */
        .mb-single-btn.mb-close:hover { background:#e5534b; border-color:#e5534b; }
        .mb-setting-section { margin:0 16px; }
        .mb-setting-section h4 { margin:0 0 10px;font-weight:600;font-size:var(--mb-font-title);color:var(--mb-text-primary); }
        .mb-setting-section h4 { padding-left:8px; border-left:3px solid var(--mb-accent); line-height:1.3; }
        .mb-setting-section h4 .icon { margin-right:4px; }
        .mb-setting-h4 .icon { margin-right:4px; }
        .mb-setting-grid { display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin:4px 0 0; }
        .mb-setting-row { display:flex;align-items:center;gap:8px;font-size:var(--mb-font-md); }
        /* 输入框 / 下拉 / 色块（都带 mb-input-base）贴列右侧，两列形成一条对齐竖线，右侧不留空白；
           复选框是 mb-setting-checkbox，不受这条影响，仍紧跟标签，避免标签和勾选框被拉开 */
        .mb-setting-row .mb-input-base { margin-left:auto; }
        .mb-setting-row label { width:110px;color:var(--mb-text-muted);font-size:var(--mb-font-md);flex-shrink:0;text-align:left; }
        .mb-setting-row > *:not(label) { margin-left:0;margin-right:auto; }
        /* 通用输入框基础类：边框、圆角、字号、背景 */
        .mb-input-base { border:1px solid var(--mb-border); border-radius:var(--mb-radius); font-size:var(--mb-font-md); box-sizing:border-box; background:var(--mb-bg-page); outline:none; transition:border-color var(--mb-t-base), box-shadow var(--mb-t-base); padding:6px 10px; width:75px; }
        .mb-input-base:focus { border-color:var(--mb-accent); box-shadow:0 0 0 3px var(--mb-accent-soft); }
        .mb-setting-row input { text-align:center; }
        .mb-setting-row input[type="checkbox"] { cursor:pointer; }
        .mb-setting-row select { cursor:pointer; text-align:left; appearance:none; -webkit-appearance:none; -moz-appearance:none; background-image:none; }
        .mb-setting-row input[type=color] { height:34px; padding:4px; cursor:pointer; -webkit-appearance:none; appearance:none; display:flex; align-items:center; justify-content:center; }
        .mb-setting-row .mb-input-base:focus { box-shadow:0 0 0 2px var(--mb-accent-soft); }
        .mb-setting-row .mb-input-base { height:24px; padding:0 8px; width:96px; line-height:22px; border:1px solid var(--mb-border); background:var(--mb-bg-page); border-radius:var(--mb-radius-sm); }
        .mb-setting-row select.mb-input-base { width:auto; min-width:96px; height:24px; padding:0 10px; line-height:22px; text-align:center; text-align-last:center; }
        .mb-setting-row input[type=color].mb-input-base { width:96px; height:24px; padding:2px; }
        .mb-setting-row input[type="checkbox"] { width:14px; height:14px; }
        .mb-setting-row input[type=color]::-webkit-color-swatch-wrapper { padding:0; display:flex; align-items:center; justify-content:center; }
        .mb-setting-row input[type=color]::-webkit-color-swatch { border:none; border-radius:var(--mb-radius-sm); width:100%; height:100%; }
        .mb-setting-h4 { display:flex; justify-content:space-between; align-items:center; margin:0 0 12px; font-size:var(--mb-font-title); color:var(--mb-text-primary); }
        .mb-setting-h4-right { display:flex; align-items:center; gap:4px; font-size:var(--mb-font-sm); color:var(--mb-text-muted); cursor:pointer; }
        .mb-setting-h4-right.btn-help { font-size:var(--mb-font-sm); color:#3f7f5c; background:#f2fbf5; padding:4px 10px; border-radius:var(--mb-radius-sm); border:1px solid #d9efdf; user-select:none; transition:all var(--mb-t-fast) ease; }
        .mb-setting-h4-right.btn-help:hover { background:#e4f6ea; color:#276749; border-color:#c9e8d4; }
        .mb-setting-row textarea { padding:8px; }
        .mb-setting-sep { margin:10px 16px 0;padding-top:24px;border-top:1px solid var(--mb-border); }
        /* 胶囊宽度恒定：悬停不再展开任何图标，鼠标划过不会把后面的胶囊挤到第二行 */
        .mb-user-tag { display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;box-sizing:border-box;background:var(--mb-bg-page);border:1px solid var(--mb-accent-line);border-radius:var(--mb-radius);font-size:var(--mb-font-sm);color:var(--mb-accent-deep);line-height:1; }
        .mb-user-tag.mb-tag-selected { border-color:var(--mb-danger); background:var(--mb-danger-soft); }
        .mb-tag-check { display:none; width:15px; height:15px; margin:0 2px 0 0; accent-color:var(--mb-danger); cursor:pointer; flex:0 0 auto; }
        .mb-fav-host.mb-editing .mb-tag-check { display:inline-block; }
        .mb-fav-host.mb-editing .mb-user-tag { cursor:pointer; }
        /* 编辑入口移到头部副标题行右侧，工具条只在编辑态整条展开 */
        .mb-fav-edit-bar { display:none; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
        .mb-fav-edit-bar .mb-btn { padding:5px 12px; font-size:var(--mb-font-sm); }
        .mb-fav-host.mb-editing .mb-fav-edit-bar { display:flex; }
        .mb-favorite-tab.mb-tab-drop { border-color:var(--mb-accent); background:var(--mb-accent-soft); color:var(--mb-accent-deep); box-shadow:0 0 0 2px var(--mb-accent-soft); }
        .mb-floor-plus { cursor:pointer;font-size:var(--mb-font-sm);margin-left:4px;outline:none;font-weight:400; }
        .mb-favorite-on { color:var(--mb-favorite-on) !important; }
        .mb-favorite-on .mb-star-svg { color:var(--mb-favorite-on) !important; }
        .mb-favorite-off,
        .mb-favorite-off .mb-star-svg { color:var(--mb-text-hint) !important; }
        .mb-favorite-off:hover,
        .mb-favorite-off:hover .mb-star-svg { color:var(--mb-text-hint) !important; }
        .mb-star-svg { display:inline-block; vertical-align:-2px; }
        .mb-btn { padding:10px 16px;border:none;border-radius:var(--mb-radius);cursor:pointer;font-size:var(--mb-font-md);outline:none;transition:transform var(--mb-t-fast) ease, box-shadow var(--mb-t-fast) ease; }
        .mb-btn:focus-visible { outline:2px solid var(--mb-accent); outline-offset:2px; }
        .mb-btn:active { transform:scale(0.98); }
        .mb-btn-primary { background:var(--mb-accent); color:var(--mb-text-on-accent); border:1px solid var(--mb-accent); }
        .mb-btn-primary:hover { background:var(--mb-accent-deep); }
        .mb-btn-save { background:var(--mb-accent); color:var(--mb-text-on-accent); border-color:var(--mb-accent); padding:8px 28px; font-weight:600; min-width:120px; }
        .mb-actions-btns { display:flex; gap:8px; align-items:center; }
        .mb-btn-save:hover { background:var(--mb-accent-deep); }
        .mb-btn-secondary { background:var(--mb-bg-page); color:var(--mb-text-primary); border:1px solid var(--mb-border); }
        .mb-btn-secondary:hover { background:var(--mb-bg-secondary); }
        .mb-setting-sep + .mb-actions { margin-top:0; }
        .mb-actions { display:flex;flex-direction:column;gap:8px;margin:20px 16px 0; }
        .mb-actions-row { display:flex;gap:12px; }
        .mb-actions .mb-btn { flex:1 1 0;padding:8px 12px;white-space:nowrap; }
        .mb-host-text { width:100%;height:80px;padding:8px;resize:none; }
        .mb-modal-textarea { width:100%;padding:8px;resize:none; }
        .mb-modal-textarea:focus { outline:none;border-color:var(--mb-accent); }
        /* 面板边缘翻转改为修饰类，JS 只切类不再内联坐标 */
        .mb-fab-panel { left:0;right:auto;top:calc(100% + 8px);bottom:auto; }
        .mb-fab-panel--flip-x { left:auto;right:0; }
        .mb-fab-panel--flip-y { top:auto;bottom:calc(100% + 8px); }
        /* 窄屏响应式 */
        @media (max-width:640px) {
            .mb-setting-grid { grid-template-columns:1fr !important; }
            .mb-setting-row label { width:auto; }
            .mb-gallery-grid { grid-template-columns:repeat(3, 1fr) !important; gap:10px; padding:12px; }
            .mb-gallery-cell { height:220px; }
        }
        @media (max-width:480px) {
            .mb-guolv-grid { grid-template-columns:1fr !important; }
            .mb-gallery-grid { grid-template-columns:repeat(2, 1fr) !important; }
            .mb-gallery-cell { height:180px; }
            .mb-avatar-grid { grid-template-columns:repeat(3, 1fr) !important; }
        }
        /* 减弱动效偏好：仅画廊内 loading 尊重系统设置；悬浮球 loading 旋转为保证状态可区分，始终生效 */
        @media (prefers-reduced-motion: reduce) {
            .mb-gallery-loading { animation:none !important; }
        }
        /* 头像设置弹窗 */
        .mb-avatar-head { display:block; margin-bottom:0; }
        .mb-avatar-head h3 { margin:0 0 8px; font-size:var(--mb-font-title); }
        .mb-avatar-nickname-row { display:flex; align-items:center; gap:8px; }
        .mb-avatar-nickname-row label { flex-shrink:0; font-size:var(--mb-font-md); color:var(--mb-text-muted); }
        .mb-avatar-nickname-row input { flex:0 0 88px; width:88px; box-sizing:border-box; padding:0 8px; height:30px; line-height:28px; text-align:center; }
        .mb-avatar-nickname-hint { flex:1 1 auto; min-width:0; color:var(--mb-text-hint); font-size:var(--mb-font-sm); text-align:right; }
        .mb-avatar-hint-text { color:var(--mb-text-hint); font-size:var(--mb-font-sm); margin:6px 0 0; text-align:left; }
        .mb-avatar-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin:4px 0 12px; }
        .mb-avatar-cell { aspect-ratio:1; border:1px solid var(--mb-border); border-radius:0; cursor:pointer; position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden; background:var(--mb-bg-secondary); }
        .mb-avatar-cell.active { border-color:var(--mb-accent); background:var(--mb-accent-soft); }
        .mb-avatar-cell.empty { border-style:dashed; border-color:var(--mb-border); cursor:pointer; background:transparent; transition:border-color var(--mb-t-base); }
        .mb-avatar-cell.empty:hover { border-color:var(--mb-accent); }
        .mb-avatar-cell img { width:100%; height:100%; object-fit:cover; cursor:grab; }
        .mb-avatar-cell img:active { cursor:grabbing; }
        .mb-avatar-cell--dragging { opacity:.45; }
        .mb-avatar-cell--drop { border-color:var(--mb-accent); background:var(--mb-accent-soft); }
        .mb-avatar-cell-plus { font-size:var(--mb-font-xl); color:var(--mb-text-hint); transition:color var(--mb-t-base); }
        .mb-avatar-cell.empty:hover .mb-avatar-cell-plus { color:var(--mb-accent); }
        .mb-avatar-cell-label { position:absolute; bottom:3px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.55); color:var(--mb-text-on-accent); font-size:var(--mb-font-xs); text-align:center; padding:1px 8px; border-radius:var(--mb-radius-pill); max-width:90%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
        .mb-avatar-cell-x { position:absolute; top:2px; right:2px; cursor:pointer; display:none; color:var(--mb-text-on-accent); background:rgba(0,0,0,0.45); border-radius:50%; padding:2px; line-height:0; transition:background var(--mb-t-fast); z-index:2; }
        .mb-avatar-cell:hover .mb-avatar-cell-x { display:block; }
        .mb-avatar-cell-x:hover { background:rgba(220,38,38,0.85); }
        .mb-avatar-actions-row { display:flex; gap:10px; margin:12px 0; }
        .mb-avatar-actions-row .mb-btn { flex:1; white-space:nowrap; }
        .mb-avatar-file-input { display:none; }
        /* Toast / Loading 样式收拢 */
        .mb-guide-card { position:fixed; right:24px; bottom:24px; z-index:var(--mb-z-guide); width:min(340px, calc(100vw - 48px)); box-sizing:border-box; background:var(--mb-bg-page); border:1px solid var(--mb-border); border-radius:var(--mb-radius); box-shadow:var(--mb-shadow-lg); padding:16px; font-size:var(--mb-font-md); line-height:1.8; color:var(--mb-text-primary); }
        .mb-guide-card .mb-guide-title { font-size:var(--mb-font-title); font-weight:600; margin-bottom:8px; }
        .mb-guide-card .mb-guide-row { display:flex; gap:8px; }
        .mb-guide-card .mb-guide-hint { color:var(--mb-text-hint); font-size:var(--mb-font-sm); margin-top:6px; }
        .mb-guide-card .mb-guide-ok { margin-top:12px; width:100%; padding:8px 0; border:none; border-radius:var(--mb-radius); background:var(--mb-accent); color:var(--mb-text-on-accent); font-size:var(--mb-font-md); cursor:pointer; transition:opacity var(--mb-t-fast) ease; }
        .mb-guide-card .mb-guide-ok:hover { opacity:0.9; }
        .mb-guide-mask { position:fixed; inset:0; z-index:var(--mb-z-guide); background:rgba(15,23,42,.38); display:flex; align-items:center; justify-content:center; padding:24px; }
        .mb-guide-card--center { position:relative; right:auto; bottom:auto; width:min(440px, calc(100vw - 48px)); max-height:min(80vh, 620px); overflow:auto; }
        #mb-toast-container { position:fixed; bottom:24px; right:24px; z-index:var(--mb-z-toast); display:flex; flex-direction:column; gap:8px; align-items:flex-end; width:320px; max-width:calc(100vw - 48px); pointer-events:none; }
        .mb-toast { background:var(--mb-toast-info); color:var(--mb-text-on-accent); padding:10px 16px; border-radius:var(--mb-radius); font-size:var(--mb-font-md); box-shadow:var(--mb-shadow-lg); opacity:0; transform:translateX(24px); transition:all var(--mb-t-slow) ease; max-width:min(320px, calc(100vw - 48px)); pointer-events:auto; display:flex; align-items:center; gap:6px; line-height:1.5; backdrop-filter:blur(8px); }
        .mb-toast--success { background:var(--mb-toast-success); color:var(--mb-text-on-accent); }
        .mb-toast--error { background:var(--mb-toast-error); color:var(--mb-text-on-accent); }
        .mb-toast--kantu { background:var(--mb-toast-kantu); color:var(--mb-text-on-accent); }
        .mb-toast--fanye { background:var(--mb-toast-fanye); color:var(--mb-text-on-accent); }
        .mb-toast--favorite { background:var(--mb-toast-favorite); color:var(--mb-text-on-accent); }
        /* loading 指示器直接走 .mb-toast 新毛玻璃样式，不再单独黑泡 */
        .mb-loading-spinner { display:inline-block; width:var(--mb-size-icon-sm); height:var(--mb-size-icon-sm); border:2px solid var(--mb-text-on-accent); border-top-color:transparent; border-radius:50%; animation:mb-spin 0.8s linear infinite; flex-shrink:0; }
        .mb-copy-clipboard { position:fixed; top:0; left:0; opacity:0; }
        /* 看图预览注入 DOM 收拢 */
        .mb-kantu-td { padding:2px 8px !important; line-height:0; }
        .mb-kantu-preview-wrap { margin:6px 0 0; padding:0; background:transparent; border-radius:0; clear:both; }
        .mb-kantu-fail-text { padding:6px 12px; color:var(--mb-danger); font-size:var(--mb-font-sm); }
        .mb-kantu-retry-btn { margin-left:6px; padding:2px 8px; font-size:var(--mb-font-sm); cursor:pointer; border:1px solid var(--mb-border); border-radius:var(--mb-radius); background:var(--mb-bg-page); color:var(--mb-text-primary); }
        .mb-kantu-scroll-wrap { width:100%; max-width:100%; box-sizing:border-box; margin:6px 0; overflow-x:auto; }
        .mb-flash-ring { transition:box-shadow .3s; box-shadow:0 0 0 3px var(--mb-amber), 0 0 0 5px var(--mb-amber-glow) !important; }
        .mb-kantu-scroll-inner { display:flex; align-items:center; gap:6px; overflow-x:auto; scrollbar-width:none; }
        .mb-kantu-scroll-inner::-webkit-scrollbar { display:none; }
        .mb-kantu-empty-wrap { width:100%; box-sizing:border-box; margin:6px 0; padding:4px 12px; border:1px dashed var(--mb-border); border-radius:var(--mb-radius-sm); background:transparent; color:var(--mb-text-hint); font-size:var(--mb-font-sm); line-height:1.4; }
        .mb-kantu-thumb { cursor:pointer; display:block; background:#eef1f4; border-radius:var(--mb-radius); object-fit:cover; flex-shrink:0; height:200px; max-width:340px; }
        /* 搜索过滤面板收拢 */
        .mb-guolv-head { display:flex; flex-direction:row; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
        .mb-guolv-title { font-size:var(--mb-font-title); font-weight:600; color:var(--mb-text-primary); }
        .mb-guolv-save { padding:4px 12px !important; font-size:var(--mb-font-md) !important; flex-shrink:0; }
        .mb-guolv-head-btns { display:flex; gap:8px; align-items:center; flex-shrink:0; }
        .mb-guolv-cancel { padding:4px 12px !important; font-size:var(--mb-font-md) !important; flex-shrink:0; }
        .mb-guolv-kw-input { height:180px; font-size:var(--mb-font-md); line-height:1.7; resize:none; }
        .mb-guolv-tip { font-size:var(--mb-font-xs); line-height:1.5; white-space:normal; max-width:200px; color:var(--mb-text-hint); }
        .mb-guolv-tip code { background:var(--mb-bg-secondary); padding:1px 4px; border-radius:var(--mb-radius-sm); font-family:Consolas,Menlo,monospace; font-size:var(--mb-font-sm); }
        .mb-guolv-scope { display:flex; align-items:center; gap:6px; margin-top:10px; font-size:var(--mb-font-md); color:var(--mb-text-primary); cursor:pointer; }
        /* 设置弹窗收拢 */
        .mb-setting-checkbox { width:auto; }
        .mb-fav-note { font-size:var(--mb-font-sm); color:var(--mb-text-hint); line-height:1.6; margin:-4px 0 10px; padding-left:12px; }
        .mb-user-tag .mb-tag-name { color:var(--mb-accent-deep); cursor:default; }
        .mb-favorite-users-section { display:flex; flex-direction:column; }
        .mb-favorite-users-list { display:flex; flex-wrap:wrap; align-items:flex-start; align-content:flex-start; gap:6px; min-height:56px; max-height:120px; overflow-y:auto; padding-right:4px; }
        .mb-favorite-users-empty { color:var(--mb-text-hint); font-size:var(--mb-font-md); padding:10px 2px; }
        /* 拖拽排序期间禁用悬停展开，避免鼠标划过时胶囊变宽把后面的挤下第二行 */
        .mb-favorite-users-list.mb-dragging .mb-user-tag { cursor:grabbing; }
        /* 设置面板里的收藏馆入口卡片 */
        .mb-fav-entry-card { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border:1px solid var(--mb-border); border-radius:var(--mb-radius); background:var(--mb-bg-page); }
        .mb-fav-entry-title { font-size:var(--mb-font-md); font-weight:600; color:var(--mb-text-primary); line-height:1.3; }
        .mb-fav-entry-sub { font-size:var(--mb-font-sm); color:var(--mb-text-hint); margin-top:3px; }
        .mb-fav-entry-card .mb-btn { flex:0 0 auto; padding:8px 20px; }
        /* 收藏馆独立弹窗：比设置弹窗更宽更高，内部留白放开，拖拽才好操作 */
        .mb-fav-gallery-modal { width:900px; max-width:95vw; padding:30px 32px; }
        .mb-fav-gallery-head { display:flex; align-items:center; gap:14px; margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--mb-border); }
        .mb-fav-gallery-avatar { width:46px; height:46px; border-radius:50%; object-fit:cover; flex:0 0 auto; background:var(--mb-bg-page); }
        .mb-fav-gallery-avatar--empty { display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #fde2e2, #fbc7c7); color:#e05a5a; font-size:20px; }
        .mb-fav-gallery-head-text { flex:1 1 auto; min-width:0; }
        .mb-fav-gallery-modal .mb-dialog-title { font-size:18px; margin-bottom:6px; }
        .mb-fav-gallery-modal .mb-dialog-sub { line-height:1.75; margin-bottom:0; }
        /* 标题行内放「编辑」与「关闭 ×」，不再单独占行 */
        .mb-fav-title-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
        .mb-fav-title-row .mb-dialog-title { margin-bottom:0; }
        .mb-fav-title-actions { display:flex; align-items:center; gap:6px; margin-left:auto; flex:0 0 auto; }
        .mb-fav-gallery-edit { padding:3px 10px; font-size:var(--mb-font-sm); }
        .mb-fav-gallery-x { width:24px; height:24px; padding:0; border:none; background:transparent; color:var(--mb-text-muted); font-size:18px; line-height:1; cursor:pointer; border-radius:var(--mb-radius); display:inline-flex; align-items:center; justify-content:center; transition:background var(--mb-t-fast) ease, color var(--mb-t-fast) ease; }
        .mb-fav-gallery-x:hover { background:var(--mb-bg-secondary); color:var(--mb-text-primary); }
        .mb-fav-group-picker { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 16px; }
        .mb-fav-gallery-modal .mb-fav-gallery-tabs { max-height:126px; margin-bottom:18px; gap:8px; }
        .mb-fav-gallery-modal .mb-fav-gallery-list { max-height:min(560px, 58vh); min-height:210px; gap:8px; padding:4px 6px 4px 0; }
        /* 大弹窗里胶囊也放大一档，24px 在这儿显得局促 */
        .mb-fav-gallery-modal .mb-favorite-tab { height:28px; padding:0 13px 0 5px; }
        .mb-fav-gallery-modal .mb-favorite-tab i { min-width:22px; height:22px; font-size:12px; }
        .mb-fav-gallery-modal .mb-user-tag { height:28px; padding:0 13px; }
        .mb-fav-gallery-modal .mb-favorite-users-actions { gap:12px; padding-top:20px; }
        .mb-fav-gallery-modal .mb-favorite-users-actions .mb-btn { padding:8px 14px; }
        .mb-fav-kw-tip { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:18px; padding-top:14px; border-top:1px dashed var(--mb-border); font-size:var(--mb-font-sm); color:var(--mb-text-hint); cursor:pointer; }
        .mb-fav-gallery-modal .mb-dialog-actions { margin-top:18px; }
        .mb-favorite-users-actions { display:flex; gap:8px; margin-top:auto; justify-content:space-between; align-items:center; padding-top:12px; }
        .mb-favorite-users-actions .mb-btn { flex:1 1 0; padding:6px 10px; }
        /* 分组 tab 栏：最多两行 */
        /* 自定义分组为人工创建且数量可增长，锁定单行 + 横向滚动，避免换行把弹窗撑高 */
        .mb-favorite-tabs { display:flex; flex-wrap:nowrap; gap:6px; margin-bottom:10px; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; -ms-overflow-style:none; padding-bottom:2px; }
        .mb-favorite-tabs::-webkit-scrollbar { display:none; }
        /* 分组 tab 用浅底无描边，与白底描边的用户胶囊拉开层级 */
        .mb-favorite-tab { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 10px 0 4px; box-sizing:border-box; border-radius:var(--mb-radius); background:var(--mb-bg-secondary); border:1px solid transparent; font-size:var(--mb-font-sm); cursor:pointer; color:var(--mb-text-muted); user-select:none; }
        .mb-favorite-tab i { font-style:normal; min-width:20px; height:20px; padding:0 4px; margin:0; border-radius:var(--mb-radius-pill); background:var(--mb-accent-soft); color:var(--mb-accent-deep); font-size:var(--mb-font-xs); font-weight:600; display:inline-flex; align-items:center; justify-content:center; opacity:1; }
        .mb-favorite-tab.active { background:var(--mb-accent-soft, #eef4ff); border-color:var(--mb-accent-line, #d6e4ff); color:var(--mb-accent-deep, #1d6fd1); }
        .mb-favorite-tab.active i { opacity:1; background:var(--mb-bg-page, #fff); }
        /* 标签上的分组切换/取消图标：hover 才显示（display:none 方案，见上方 .mb-user-tag 规则） */
        /* 通用导入导出弹窗收拢 */
        .mb-dialog-title { font-size:var(--mb-font-title); font-weight:bold; margin-bottom:8px; }
        .mb-dialog-sub { color:var(--mb-text-muted); font-size:var(--mb-font-md); margin-bottom:10px; }
        .mb-dialog-textarea { font-size:var(--mb-font-md); }
        .mb-dialog-textarea.h-56 { height:56px; white-space:pre; overflow-x:auto; resize:none; }
        .mb-dialog-textarea.h-180 { height:180px; }
        .mb-dialog-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:12px; }
        /* GM 设置弹窗按钮收拢 */
        .mb-actions-row--between { display:flex; justify-content:space-between; align-items:center; }
        .mb-debug-label { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 12px; box-sizing:border-box; border-radius:var(--mb-radius); border:1px solid var(--mb-border); background:var(--mb-bg-page); font-size:var(--mb-font-md); color:var(--mb-text-muted); cursor:pointer; user-select:none; transition:all var(--mb-t-fast) ease; }
        .mb-debug-label:hover { border-color:var(--mb-accent-line); color:var(--mb-text-primary); }
        .mb-debug-label:has(.mb-debug-checkbox:checked) { background:var(--mb-accent-soft); border-color:var(--mb-accent-line); color:var(--mb-accent-deep); }
        .mb-debug-checkbox { margin:0; width:14px; height:14px; }
        .mb-btn-danger { color:var(--mb-danger); border-color:var(--mb-danger-soft); }
        `);
        //   直接取 .style.setProperty 会抛 TypeError；而 injectStyle 是 main() 的第一行，
        //   一抛错后面注册菜单、挂 DOMContentLoaded、启动各模块全部执行不到 —— 整个脚本静默失效。
        //   改成判空 + 每 16ms 重试，等 <html> 出现再设。
        const setColorVars = () => {
            const rootEl = document.documentElement;
            if (!rootEl) return false;
            rootEl.style.setProperty('--mb-gallery-bg', galleryBg);
            rootEl.style.setProperty('--mb-gallery-cell', galleryCell);
            rootEl.style.setProperty('--mb-favorite-highlight-bg', favoriteHlBg);
            rootEl.style.setProperty('--mb-favorite-highlight-title', favoriteHlTitle);
            return true;
        };
        if (!setColorVars()) {
            const retrySetColorVars = () => { if (!setColorVars()) setTimeout(retrySetColorVars, 16); };
            retrySetColorVars();
        }
    }

    // ===================== 通用懒加载观察器单例 =====================
    const Lazy = Mengbao.Lazy = {
        _imgObserver: null,
        _postObserver: null,
        _forceAll: false,   // 持续看图模式：跳过视口判断，注册即触发
        imgObserver() {
            if (this._imgObserver) return this._imgObserver;
            this._imgObserver = new IntersectionObserver((entries) => {
                entries.forEach(en => {
                    const img = en.target;
                    if (en.isIntersecting) {
                        if (!img.src && img.dataset.src) img.src = img.dataset.src;
                        this._imgObserver.unobserve(img);
                    }
                });
            }, { rootMargin: CONST.LAZY_ROOT_MARGIN });
            return this._imgObserver;
        },
        postObserver() {
            if (this._postObserver) return this._postObserver;
            this._postObserver = new IntersectionObserver((entries) => {
                entries.forEach(en => {
                    if (en.isIntersecting) {
                        en.target._mbOnEnter && en.target._mbOnEnter(en.target);
                        this._postObserver.unobserve(en.target);
                    }
                });
            }, { rootMargin: CONST.POST_ROOT_MARGIN });
            return this._postObserver;
        },
        observeImage(img) {
            this.imgObserver().observe(img);
        },
        ensureImgObserver() { this._imgObserver = this.imgObserver(); },
        observePost(el, onEnter) {
            el._mbOnEnter = onEnter;
            // 持续加载要求「所有帖子都加载」，而 observer 只在 300px 视口内触发，
            // 不滚动就永远不进队列——这就是进度停在某个数字不动的根因。
            // 持续模式下直接触发，普通模式仍走视口懒加载
            if (this._forceAll) { onEnter(el); return; }
            this.postObserver().observe(el);
        }
    };

    // ===================== FAB 工厂 =====================
    function createFab(options) {
        const fab = {
            el: null, panel: null, folded: true,
            storageKey: options.storageKey,
            dragState: { offsetX: 0, offsetY: 0, moved: false },
            init() {
                if (options.panelClass) {
                    const cls = '.' + options.panelClass.replace(/ /g, '.');
                    const oldPanel = document.querySelector(cls);
                    if (oldPanel && oldPanel.closest('.mb-fab')) { this.el = oldPanel.closest('.mb-fab'); this.panel = oldPanel; return; }
                }
                this.el = document.createElement('div');
                this.el.className = 'mb-fab';
                const btn = document.createElement('div');
                btn.className = 'mb-fab-btn mb-fab-btn--' + options.module;
                const fabIcons = {
                    kantu: '🖼️',
                    fanye: '📄',
                    guolv: '🎯',
                    zengqiang: '⚡'
                };
                btn.innerHTML = fabIcons[options.module] || '⭐';
                const panel = document.createElement('div');
                panel.className = 'mb-fab-panel' + (options.panelClass ? ' ' + options.panelClass : '');
                panel.style.display = 'none';
                this.el.appendChild(btn);
                this.el.appendChild(panel);
                this.panel = panel;

                const saved = Util.userStore.get(options.storageKey, null);
                const _w = () => this.el.offsetWidth || CONST.FAB_SIZE;
                const _h = () => this.el.offsetHeight || CONST.FAB_SIZE;
                if (saved && saved.left !== undefined && saved.top !== undefined) {
                    const maxX = document.documentElement.clientWidth - _w();
                    const maxY = document.documentElement.clientHeight - _h();
                    const l = Number(saved.left), t = Number(saved.top);
                    if (Number.isFinite(l) && Number.isFinite(t) && l >= 0 && t >= 0 && l <= maxX && t <= maxY) {
                        this.el.style.left = l + 'px';
                        this.el.style.top = t + 'px';
                        this.el.style.right = 'auto';
                        this.el.style.bottom = 'auto';
                        this.el.style.transform = 'none';
                    } else if (options.defaultPos) {
                        this._applyDefaultPos(options.defaultPos);
                    }
                } else if (options.defaultPos) {
                    this._applyDefaultPos(options.defaultPos);
                }

                const foldKey = options.storageKey + '_fold';
                const savedFold = Util.userStore.get(foldKey, true);
                this.folded = savedFold;
                panel.style.display = savedFold ? 'none' : 'block';
                if (!savedFold) panel.classList.add('mb-fab-panel--open');

                document.body.appendChild(this.el);
                if (options.panelBuilder) options.panelBuilder(panel);

                btn.addEventListener('click', () => {
                    if (this.dragState.moved) return;
                    if (options.onClick) options.onClick(this);
                });
                btn.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if (options.onContextMenu) options.onContextMenu(this);
                });
                btn.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    this.dragState.moved = false;
                    const rect = this.el.getBoundingClientRect();
                    this.dragState.offsetX = e.clientX - rect.left;
                    this.dragState.offsetY = e.clientY - rect.top;
                    const startX = e.clientX, startY = e.clientY;
                    const onMove = (ev) => {
                        if (Math.abs(ev.clientX - startX) > CONST.DRAG_THRESHOLD || Math.abs(ev.clientY - startY) > CONST.DRAG_THRESHOLD) {
                            this.dragState.moved = true;
                            this.el.style.transform = 'none';
                            this.el.style.right = 'auto';
                            this.el.style.bottom = 'auto';
                            const maxX = document.documentElement.clientWidth - (this.el.offsetWidth || CONST.FAB_SIZE) - 4;
                            const maxY = document.documentElement.clientHeight - (this.el.offsetHeight || CONST.FAB_SIZE) - 4;
                            let nx = ev.clientX - this.dragState.offsetX;
                            let ny = ev.clientY - this.dragState.offsetY;
                            nx = Math.max(0, Math.min(maxX, nx));
                            ny = Math.max(0, Math.min(maxY, ny));
                            this.el.style.left = nx + 'px';
                            this.el.style.top = ny + 'px';
                            this._scheduleFlip();
                        }
                    };
                    const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        if (this.dragState.moved) {
                            Util.userStore.set(options.storageKey, {
                                left: parseInt(this.el.style.left, 10),
                                top: parseInt(this.el.style.top, 10)
                            });
                        }
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
            },
            _clampY(v) {
                const ch = document.documentElement.clientHeight || window.innerHeight;
                const sizeH = this.el.offsetHeight || CONST.FAB_SIZE;
                return Math.max(0, Math.min(v, ch - sizeH - 4));
            },
            _applyDefaultPos(dp) {
                this.el.style.transform = 'none';
                if (dp && dp.right) {
                    this.el.style.left = 'auto';
                    this.el.style.right = (typeof dp.right === 'number' ? dp.right : 220) + 'px';
                    if (dp.top != null) {
                        this.el.style.top = dp.top + 'px';
                        this.el.style.bottom = 'auto';
                    } else {
                        this.el.style.top = 'auto';
                        this.el.style.bottom = this._clampY(dp.bottom != null ? dp.bottom : 200) + 'px';
                    }
                } else if (dp && dp.verticalCenter) {
                    this.el.style.left = (dp.left != null ? dp.left : 12) + 'px';
                    this.el.style.right = 'auto';
                    this.el.style.top = '50%';
                    this.el.style.bottom = 'auto';
                    this.el.style.transform = 'translateY(-50%)';
                } else if (dp) {
                    this.el.style.left = (dp.left != null ? dp.left : 12) + 'px';
                    this.el.style.right = 'auto';
                    if (dp.bottom != null) {
                        this.el.style.top = 'auto';
                        this.el.style.bottom = this._clampY(dp.bottom) + 'px';
                    } else {
                        this.el.style.top = this._clampY(dp.top != null ? dp.top : 120) + 'px';
                        this.el.style.bottom = 'auto';
                    }
                }
            },
            togglePanel() {
                this.folded = !this.folded;
                if (this.storageKey) Util.userStore.set(this.storageKey + '_fold', this.folded);
                if (!this.folded) {
                    this.panel.style.display = 'block';
                    this.panel.classList.remove('mb-fab-panel--open');
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => this.panel.classList.add('mb-fab-panel--open'));
                    });
                } else {
                    this.panel.classList.remove('mb-fab-panel--open');
                    setTimeout(() => { if (this.folded) this.panel.style.display = 'none'; }, 220);
                }
                if (!this.folded) {
                    this.recalcFlip();
                    this._bindResize();
                } else {
                    this.panel.classList.remove('mb-fab-panel--flip-x', 'mb-fab-panel--flip-y');
                    this._unbindResize();
                }
            },
            recalcFlip() {
                if (this.folded) return;
                const rect = this.el.getBoundingClientRect();
                const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
                const pw = this.panel.offsetWidth || 260, ph = this.panel.offsetHeight || 200;
                const flipX = (rect.left + pw > vw);
                const flipY = (rect.bottom + ph > vh);
                this.panel.classList.toggle('mb-fab-panel--flip-x', flipX);
                this.panel.classList.toggle('mb-fab-panel--flip-y', flipY);
            },
            _scheduleFlip() {
                if (this._flipRaf) return;
                this._flipRaf = requestAnimationFrame(() => {
                    this._flipRaf = 0;
                    if (!this.folded) this.recalcFlip();
                });
            },
            _bindResize() {
                if (this._resizeHandler) return;
                let t = null;
                this._resizeHandler = () => {
                    if (t) clearTimeout(t);
                    t = setTimeout(() => this.recalcFlip(), 150);
                };
                window.addEventListener('resize', this._resizeHandler);
            },
            _unbindResize() {
                if (this._resizeHandler) {
                    window.removeEventListener('resize', this._resizeHandler);
                    this._resizeHandler = null;
                }
            }
        };
        fab.init();
        return fab;
    }

    // ===================== 共享 DOM Observer（合并多个常驻监听为单实例，同帧 rAF 批量派发） =====================
    let _sharedDomObserver = null;
    const _domObserverHandlers = [];
    let _pendingMutations = [];
    let _observerRaf = 0;
    // 注册一个处理新增节点/表单的回调；首个注册者创建单例，之后全部共享一个 MutationObserver
    function registerDomObserver(handler, timeoutMs) {
        _domObserverHandlers.push(handler);
        if (!_sharedDomObserver) {
            _sharedDomObserver = new MutationObserver((mutations) => {
                mutations.forEach(m => { if (m.type === 'childList') _pendingMutations.push(m); });
                // 队列过长时强制清空一次，避免持续翻页模式下内存累积
                if (_pendingMutations.length > CONST.MAX_PENDING_MUTATIONS) {
                    const batch = _pendingMutations.splice(0, _pendingMutations.length);
                    for (const h of _domObserverHandlers) {
                        try { h(batch); } catch (e) { Util.log('warn', 'DOM 观察回调异常', e); }
                    }
                    return;
                }
                if (_observerRaf) return;
                _observerRaf = requestAnimationFrame(() => {
                    _observerRaf = 0;
                    const batch = _pendingMutations.splice(0, _pendingMutations.length);
                    for (const h of _domObserverHandlers) {
                        try { h(batch); } catch (e) { Util.log('warn', 'DOM 观察回调异常', e); }
                    }
                });
            });
            _sharedDomObserver.observe(document.body, { childList: true, subtree: true });
        }
        let timer = 0;
        function unsubscribe() {
            if (timer) { clearTimeout(timer); timer = 0; }
            const i = _domObserverHandlers.indexOf(handler);
            if (i >= 0) _domObserverHandlers.splice(i, 1);
        }
        if (timeoutMs > 0) timer = setTimeout(unsubscribe, timeoutMs);
        return unsubscribe;
    }

    // ===================== 公共弹窗组件（统一遮罩 / 背景锁滚动 / 宽度修饰类） =====================
    function mbIconSvg(kind, size = 12) {
        const s = `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
        if (kind === 'x') return `<svg ${s}><path d="M18 6 6 18M6 6l12 12"/></svg>`;
        if (kind === 'switch') return `<svg ${s}><path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/></svg>`;
        return '';
    }
    //   原先每个 openModal 都往 document 挂 keydown，按一次 Esc 会把父弹窗和子弹窗一起关掉。
    const mbModalStack = [];
    // 多个弹窗并存时，任一弹窗关闭就恢复 overflow 会让背景提前解锁，用计数锁统一收口
    let mbBodyLock = null;
    function openModal({ body, width, closeOnMaskClick = true, extraClass = "", autoFocusFirst = true }) {
        const mask = document.createElement('div');
        mask.className = 'mb-modal-mask';
        const box = document.createElement('div');
        box.className = 'mb-modal-box ' + (width ? 'mb-modal-box--' + width : 'mb-modal-box--sm') + (extraClass ? ' ' + extraClass : '');
        box.innerHTML = body;
        mask.appendChild(box);
        document.body.appendChild(mask);
        mbModalStack.push(mask);
        if (!mbBodyLock) {
            mbBodyLock = { count: 0, body: document.body.style.overflow, html: document.documentElement.style.overflow };
        }
        mbBodyLock.count++;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        function close() {
            mask.remove();
            if (mbBodyLock) {
                mbBodyLock.count--;
                if (mbBodyLock.count <= 0) {
                    document.body.style.overflow = mbBodyLock.body;
                    document.documentElement.style.overflow = mbBodyLock.html;
                    mbBodyLock = null;
                }
            }
        }
        if (closeOnMaskClick) {
            mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
        }
        function onKey(e) {
            if (e.key !== 'Escape') return;
            // 只有栈顶弹窗响应 Esc
            if (mbModalStack[mbModalStack.length - 1] !== mask) return;
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
            close();
        }
        document.addEventListener('keydown', onKey);
        const origClose = close;
        close = function () {
            document.removeEventListener('keydown', onKey);
            const si = mbModalStack.indexOf(mask);
            if (si > -1) mbModalStack.splice(si, 1);
            origClose();
        };
        //   只认文本类输入，复选框/下拉/文件框不参与，避免设置弹窗打开就把光标落在某个开关上
        //   自动聚焦是给「输入-确定」类弹窗用的；头像弹窗里的昵称框已有值，全选会让一次输入整段替换掉
        if (autoFocusFirst) {
            try {
                const firstField = box.querySelector('input[type="text"], input:not([type]), textarea');
                if (firstField) {
                    firstField.focus();
                    if (firstField.select && firstField.value) firstField.select();
                }
            } catch (e) {}
        }
        return { box, close, query: (sel) => box.querySelector(sel) };
    }

    function openPromptDialog({ title, placeholder = '', defaultValue = '', onOk }) {
        const modal = openModal({
            width: 'sm',
            body: `
            <div class="mb-dialog-title">${Util.escapeHtml(title)}</div>
            <input type="text" class="mb-prompt-input mb-modal-textarea mb-input-base" placeholder="${Util.escapeHtml(placeholder)}" value="${Util.escapeHtml(defaultValue)}">
            <div class="mb-dialog-actions">
                <button class="mb-btn-cancel mb-btn mb-btn-secondary">取消</button>
                <button class="mb-btn-ok mb-btn mb-btn-primary">确定</button>
            </div>`
        });
        const input = modal.query('.mb-prompt-input');
        input.focus(); input.select();
        modal.query('.mb-btn-ok').onclick = () => {
            const v = input.value.trim();
            modal.close();
            if (onOk) onOk(v);
        };
        modal.query('.mb-btn-cancel').onclick = () => modal.close();
        input.addEventListener('keydown', e => { if (e.key === 'Enter') modal.query('.mb-btn-ok').click(); });
    }

    // 独立白名单管理弹窗（所有域名可见，仅读写站点域名配置）
    function openHostManager() {
        const cur = Util.storage.get('mengbao.site.hosts', DEFAULT_HOSTS);
        const list = Array.isArray(cur) && cur.length ? cur : DEFAULT_HOSTS;
        // 直接创建弹窗，不依赖 openModal（避免非白名单网站时 CSS 样式未加载）
        // 同理，这里的配色一律写字面量而不引 CSS 变量——变量定义在主 CSS 里，非白名单站点根本没注入
        const mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:var(--mb-z-modal,2147483500);display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.12);max-width:92%;max-height:92vh;overflow-y:auto;width:420px;';
        box.innerHTML = `
            <div style="font-size:15px;font-weight:600;margin-bottom:8px;">🌐 站点白名单</div>
            <div style="font-size:13px;color:#666;margin-bottom:12px;">每行一个域名，仅这些域名启用脚本；留空保存即恢复默认域名。</div>
            <textarea class="mb-host-text mb-input-base" spellcheck="false" style="width:100%;height:180px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;resize:none;overflow-y:auto;box-sizing:border-box;">${Util.escapeTextarea(list.join('\n'))}</textarea>
            <div style="margin-top:16px;text-align:right;">
                <button class="mb-host-cancel mb-btn" style="padding:8px 16px;border:1px solid #d9d9d9;background:#fff;color:#333;border-radius:6px;cursor:pointer;margin-right:8px;">取消</button>
                <button class="mb-host-save mb-btn mb-btn-primary" style="padding:8px 16px;background:#4096ff;color:#fff;border:none;border-radius:6px;cursor:pointer;">保存</button>
            </div>`;
        mask.appendChild(box);
        document.body.appendChild(mask);
        box.querySelector('.mb-host-cancel').onclick = () => mask.remove();
        box.querySelector('.mb-host-save').onclick = () => {
            const arr = box.querySelector('.mb-host-text').value.split(/[\n\r]+/).map(x => x.trim().toLowerCase())
                .map(x => x.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\.+|\.+$/g, ''))
                .filter(x => x && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x));
            if (arr.length) Util.storage.set('mengbao.site.hosts', arr);
            else Util.storage.remove('mengbao.site.hosts');
            mask.remove();
            mbToast('白名单已保存，刷新后生效', 2000, 'success');
        };
    }

    // ===================== 模块一：按发帖时间自动排序 =====================
    function moduleSortByDateline() {
        const sortConfig = Util.storage.get('mengbao.sort.config', Cfg.def('mengbao.sort.config'));
        if (!sortConfig.enabled) return;
        const getFixedUrl = (href) => {
            try {
                const url = new URL(href, location.origin);
                if (url.searchParams.get('mbNoSort') === '1') return null;
                if (url.pathname.endsWith('/forum.php') && url.searchParams.get('mod') === 'forumdisplay') {
                    url.searchParams.set('filter', CONST.SORT_FILTER);
                    url.searchParams.set('orderby', CONST.SORT_ORDERBY);
                    return url.toString();
                }
            } catch (e) {}
            return null;
        };
        const initUrl = getFixedUrl(location.href);
        if (initUrl && initUrl !== location.href) { location.replace(initUrl); return; }
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (!link || !link.href) return;
            if ((e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) && link.href.includes('forumdisplay')) {
                try {
                    const url = new URL(link.href);
                    if (!url.searchParams.get('mbNoSort')) {
                        url.searchParams.set('mbNoSort', '1');
                        link.href = url.toString();
                    }
                } catch (err) {}
            }
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            if (link.target === '_blank' || link.dataset.mbNoIntercept) return;
            const target = getFixedUrl(link.href);
            if (target) { e.preventDefault(); location.href = target; }
        }, true);
    }

    // ===================== 公共画廊服务（锁定背景滚动） =====================
    const Gallery = Mengbao.Gallery = {
        _locked: false,
        _prevOverflow: { body: '', html: '' },

        _lockScroll() {
            if (this._locked) return;
            this._prevOverflow.body = document.body.style.overflow || '';
            this._prevOverflow.html = document.documentElement.style.overflow || '';
            document.body.style.overflow = 'hidden';
            document.documentElement.style.overflow = 'hidden';
            this._locked = true;
        },
        _unlockScroll() {
            if (!this._locked) return;
            document.body.style.overflow = this._prevOverflow.body;
            document.documentElement.style.overflow = this._prevOverflow.html;
            this._locked = false;
        },

        _closeExisting() {
            const existing = document.querySelectorAll('.mb-gallery-mask');
            existing.forEach(mask => {
                //          showSingle 用全局 querySelectorAll 按 index 设 active 会错位到旧画廊的缩略图上
                if (typeof mask._mbCleanup === 'function') mask._mbCleanup(false, true);
                if (mask.parentNode) mask.remove();
            });
        },

        open(imgArr, startIndex, postTitle, imgRefs, mainCount, direct, originImg, fromThread) {
            if (!imgArr || imgArr.length === 0) return null;
            mainCount = mainCount || 0;
            const replyCount = imgArr.length - mainCount;
            this._closeExisting();
            this._lockScroll();
            const mask = document.createElement('div');
            mask.className = 'mb-gallery-mask';
            const totalLabel = (mainCount > 0 && replyCount > 0)
                ? `🖼️ 共 ${imgArr.length} 张（主贴 ${mainCount} · 回复 ${replyCount}）`
                : `🖼️ 共 ${imgArr.length} 张`;
            mask.innerHTML = `
            <div class="mb-gallery-box">
                <div class="mb-gallery-header">
                    <div class="mb-gallery-title"></div>
                    <span class="mb-gallery-count">${totalLabel}</span>
                </div>
                <div class="mb-gallery-grid"></div>
            </div>
            <div class="mb-single-view">
                <div class="mb-single-bar"><div class="mb-single-counter"></div></div>
                <img>
                <div class="mb-single-loading"><span class="mb-single-slow">原图较大，正在加载…</span></div>
                <div class="mb-single-fail">图片加载失败</div>
            </div>`;
            // 标题清洗：取第一个 " - " 之前部分；使用 textContent，避免注入
            let cleanTitle = postTitle || '帖子图片画廊';
            const dashIndex = cleanTitle.indexOf(' - ');
            if (dashIndex > 0) cleanTitle = cleanTitle.substring(0, dashIndex);
            mask.querySelector('.mb-gallery-title').textContent = cleanTitle;
            const grid = mask.querySelector('.mb-gallery-grid');
            const single = mask.querySelector('.mb-single-view');
            const bigImg = mask.querySelector('.mb-single-view img');
            const counter = mask.querySelector('.mb-single-counter');
            const singleBar = mask.querySelector('.mb-single-bar');
            const galleryBox = mask.querySelector('.mb-gallery-box');
            let currentIdx = startIndex;
            let singleSlowTimer = null;   // 单图慢加载提示定时器，跨 showSingle 调用只留一个
            // 平移量（panX/panY）只在放大后（scale > 1）生效，换图、旋转、缩回原尺寸都会清零
            let scale = 1, rotate = 0, panX = 0, panY = 0;
            const applyTransform = () => {
                // translate 放在 scale 之前：位移按屏幕像素算，不会被缩放倍率放大
                bigImg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) rotate(${rotate}deg)`;
                // 放大后才有拖动语义，光标切 grab；未放大时保持默认，避免和「点背景退出」抢手势
                bigImg.style.cursor = scale > 1 ? 'grab' : '';
            };
            // 视图归位：换图 / 旋转 / 缩回原尺寸统一走这里，防止平移量残留导致图片偏到一边
            const resetView = () => { scale = 1; rotate = 0; panX = 0; panY = 0; applyTransform(); };
            const showSingle = (idx) => {
                if (!Util.storage.get('mengbao.gallery.hintShown', false)) {
                    Util.storage.set('mengbao.gallery.hintShown', true);
                    Util.toast('💡 滚轮切换图片 · Ctrl+滚轮缩放 · 放大后可拖动 · 双击图片或点顶部条退出 · Esc 也可关闭', 4000, 'kantu');
                }
                currentIdx = (idx + imgArr.length) % imgArr.length;
                // 切换图片时，先显示加载中，隐藏大图
                const loading = mask.querySelector('.mb-single-loading');
                const failEl = mask.querySelector('.mb-single-fail');
                const slowEl = mask.querySelector('.mb-single-slow');
                loading.style.display = 'block';
                if (failEl) failEl.style.display = 'none';
                if (slowEl) slowEl.style.display = 'none';
                bigImg.style.display = 'none';
                // 慢加载提示：超过 3 秒才补一行字，快速加载时不打扰
                //         连续切图会重入，先清上一个定时器，否则旧图残留的定时器会提前替新图亮字
                if (singleSlowTimer) { clearTimeout(singleSlowTimer); singleSlowTimer = null; }
                singleSlowTimer = setTimeout(() => {
                    singleSlowTimer = null;
                    if (slowEl && loading.style.display === 'block') slowEl.style.display = 'inline-block';
                }, 3000);
                const clearSlow = () => { if (singleSlowTimer) { clearTimeout(singleSlowTimer); singleSlowTimer = null; } if (slowEl) slowEl.style.display = 'none'; };
                // 用一个临时的加载状态，等新图片加载完成后再显示
                const newImg = new Image();
                newImg.onload = () => {
                    clearSlow();
                    bigImg.src = imgArr[currentIdx];
                    bigImg.style.display = 'block';
                    loading.style.display = 'none';
                    if (failEl) failEl.style.display = 'none';
                    resetView();
                };
                newImg.onerror = () => {
                    clearSlow();
                    bigImg.style.display = 'none';
                    loading.style.display = 'none';
                    if (failEl) failEl.style.display = 'block';
                };
                newImg.src = imgArr[currentIdx];
                if (currentIdx < mainCount) {
                    counter.textContent = (currentIdx + 1) + ' / ' + mainCount;
                } else {
                    counter.textContent = (currentIdx - mainCount + 1) + ' / ' + replyCount;
                }
                resetView();
                // 更新底部缩略图条的active状态
                //          document 级查询查不到缩略条，首次直入大图会一张都不亮
                mask.querySelectorAll('.mb-single-thumb').forEach((el, i) => {
                    el.classList.toggle('active', i === currentIdx);
                });
                const thumbsBar = mask.querySelector('.mb-single-thumbs');
                const activeThumb = thumbsBar ? thumbsBar.children[currentIdx] : null;
                if (thumbsBar && activeThumb) {
                    const targetLeft = activeThumb.offsetLeft - (thumbsBar.clientWidth - activeThumb.offsetWidth) / 2;
                    thumbsBar.scrollTo({ left: targetLeft, behavior: 'smooth' });
                }
            };
            
            // 如果是直接进入大图浏览模式（先切显示，等缩略条建好再进图）
            if (direct) {
                galleryBox.style.display = 'none';
                single.style.display = 'flex';
            }
            // 创建底部缩略图条
            const thumbsBar = document.createElement('div');
            thumbsBar.className = 'mb-single-thumbs';
            imgArr.forEach((url, idx) => {
                const thumb = document.createElement('div');
                thumb.className = 'mb-single-thumb';
                // 用 createElement + src 属性赋值，不让 URL 参与 HTML 解析
                const thumbImg = document.createElement('img');
                // 300 图的大帖若一次性全赋 src 会瞬间打满连接，交给浏览器按视口懒加载
                thumbImg.loading = 'lazy';
                thumbImg.decoding = 'async';
                thumbImg.src = url;
                thumb.appendChild(thumbImg);
                thumb.onclick = (e) => { e.stopPropagation(); showSingle(idx); };
                thumbsBar.appendChild(thumb);
            });
            single.appendChild(thumbsBar);
            //          缩略条虽已在 mask 内部，但 document 级查询根本看不到它，首次仍不会亮。
            //          改为等 mask 挂载完成后（下方 appendChild 之后）再进图。
            
            const closeGallery = (fromBackBtn, skipScroll) => {
                if (mask._closed) return; // 防止重复关闭
                mask._closed = true;
                if (mask._lazyObserver) mask._lazyObserver.disconnect();
                // 未加载完的格子若还挂着慢提示定时器，随画廊一起清掉，避免关掉后仍有定时器在跑
                mask.querySelectorAll('.mb-gallery-cell').forEach(c => { if (c._mbSlowTimer) { clearTimeout(c._mbSlowTimer); c._mbSlowTimer = null; } });
                document.removeEventListener('keydown', onGalleryKey);
                // 先隐藏single-view
                single.style.display = 'none';
                // 淡出动画：先设置opacity为0，再移除
                mask.style.opacity = '0';
                const galleryBox = mask.querySelector('.mb-gallery-box');
                if (galleryBox) galleryBox.style.transform = 'scale(0.95)';
                // 等动画结束后再移除元素（只移除当前mask，不要全局查询）
                setTimeout(() => {
                    if (mask.parentNode) mask.remove();
                }, 200);
                // 解锁滚动
                this._unlockScroll();
                // 关闭：滚动到目标图片
                if (!skipScroll) {
                    // 如果是点击X按钮，就回到最初点击的图片（originImg）；否则回到最后浏览的图片
                    // 兜底：从当前下标环形找最近的有效图片元素，保证关闭后能滚动
                    let targetImg = fromBackBtn ? originImg : ((imgRefs && imgRefs[currentIdx]) || originImg);
                    if (!targetImg && imgRefs) {
                        for (let i = currentIdx; i < imgRefs.length + currentIdx; i++) {
                            const el = imgRefs[i % imgRefs.length];
                            if (el && el.isConnected) { targetImg = el; break; }
                        }
                    }
                    if (targetImg && document.body.contains(targetImg)) {
                        setTimeout(() => {
                            targetImg.scrollIntoView({ behavior: 'smooth', block: 'center' });

                            // 列表页（imgRefs=null）无对应大图元素，关闭仅滚动定位不闪（闪烁无增益）；X 按钮回原位置必闪
                            const doHighlight = fromBackBtn || !!imgRefs;
                            if (doHighlight) {
                                // 加高亮闪烁
                                targetImg.classList.add('mb-flash-ring');
                                setTimeout(() => targetImg.classList.remove('mb-flash-ring'), 1500);
                            }
                        }, 100);
                    }
                }
            };
            function onGalleryKey(e) {
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;

                if (e.key === 'Escape') { closeGallery(); return; }
            }
            document.addEventListener('keydown', onGalleryKey);
            mask._mbCleanup = closeGallery;
            const rotateBtn = document.createElement('span');
            rotateBtn.className = 'mb-single-btn';
            rotateBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';
            rotateBtn.title = '旋转90°';
            // 旋转后坐标系跟着转，平移量沿用会让图片"甩"到别处，所以旋转同时归位
            rotateBtn.onclick = (e) => { e.stopPropagation(); rotate += 90; panX = 0; panY = 0; applyTransform(); };
            singleBar.appendChild(rotateBtn);
            
            // 回到原位置按钮（用X关闭图标，更明显）
            const backBtn = document.createElement('span');
            backBtn.className = 'mb-single-btn mb-close';
            // 样式和旋转按钮一致，只靠图标区分
            backBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            backBtn.title = '关闭并回到原位置';
            backBtn.onclick = (e) => { 
                e.stopPropagation(); 
                // 点击X按钮：回到最初点击的图片位置（originImg）
                closeGallery(true); // 传入true表示回到原位置
            };
            //          关闭按钮常驻：任何入口进大图都必须有可见的退出键
            singleBar.appendChild(backBtn);

            // 先定义cellObjs，放在外面，这样single.onclick也能访问到
            const cellObjs = [];
            // 等下一帧渲染 mask 后再填充 grid，避免阻塞首帧绘制
            requestAnimationFrame(() => {
                const fragment = document.createDocumentFragment();
                imgArr.forEach((url, idx) => {
                    if (idx === mainCount && replyCount > 0) {
                        // 只有在帖子详情页才显示水平分隔线，占满整行
                        if (isThreadPage()) {
                            const divider = document.createElement('div');
                            divider.className = 'mb-gallery-divider';
                            divider.textContent = '回复 / 评论';
                            fragment.appendChild(divider);
                        }
                    }
                    const cell = document.createElement('div');
                    cell.className = 'mb-gallery-cell is-loading';
                    const loading = document.createElement('div');
                    loading.className = 'mb-gallery-loading';
                    const gImg = document.createElement('img');
                    gImg.alt = '';
                    const goBtn = document.createElement('span');
                    goBtn.className = 'mb-gallery-go';
                    goBtn.textContent = 'Go';
                    goBtn.onclick = (e) => {
                        e.stopPropagation();
                        closeGallery(false, true);
                        const ref = (imgRefs && imgRefs[idx]) || originImg;
                        if (ref && ref.scrollIntoView) {
                            setTimeout(() => {
                                ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                ref.classList.add('mb-flash-ring');
                                setTimeout(() => ref.classList.remove('mb-flash-ring'), 1500);
                            }, 250);
                        }
                    };
                    // 慢加载提示：超过 3 秒才显示一行字
                    const slowEl = document.createElement('div');
                    slowEl.className = 'mb-gallery-slow';
                    slowEl.textContent = '原图较大，正在加载…';
                    const slowTimer = setTimeout(() => { if (slowEl.parentNode) slowEl.style.display = 'block'; }, 3000);
                    cell._mbSlowTimer = slowTimer;
                    gImg.onload = () => {
                        clearTimeout(slowTimer);
                        cell.classList.remove('is-loading');
                        loading.remove();
                        slowEl.remove();
                        gImg.style.display = 'block';
                        if (imgRefs && imgRefs[idx]) cell.appendChild(goBtn);
                    };
                    gImg.onerror = () => {
                        clearTimeout(slowTimer);
                        cell.classList.remove('is-loading');
                        cell.classList.add('is-error'); // 标记为加载失败
                        loading.remove();
                        slowEl.remove();
                        gImg.remove();
                        const fallback = document.createElement('div');
                        fallback.className = 'mb-gallery-fallback';
                        fallback.textContent = '图片加载失败';
                        cell.appendChild(fallback);
                    };
                    cell.appendChild(loading);
                    cell.appendChild(gImg);
                    cell.appendChild(slowEl);
                    cell.onclick = (e) => { 
                        e.stopPropagation(); 
                        if (cell.classList.contains('is-error')) return; // 加载失败的不打开大图
                        single.style.display = 'flex'; 
                        showSingle(idx); 
                    };
                    fragment.appendChild(cell);
                    cellObjs.push({ cell, gImg, url });
                });
                grid.appendChild(fragment);
                // 用 requestIdleCallback 低优先级串行预加载剩余全部图，滚到即看
                const loadOne = (obj) => { if (obj && !obj.gImg.src) obj.gImg.src = obj.url; };
                if ('IntersectionObserver' in window) {
                    const lazyObserver = new IntersectionObserver((entries) => {
                        entries.forEach(entry => {
                            if (!entry.isIntersecting) return;
                            lazyObserver.unobserve(entry.target);
                            loadOne(cellObjs[Number(entry.target.dataset.idx)]);
                        });
                    }, { root: grid, rootMargin: '300px 0px' });
                    cellObjs.forEach((o, i) => { o.cell.dataset.idx = i; lazyObserver.observe(o.cell); });
                    mask._lazyObserver = lazyObserver;
                } else {
                    cellObjs.forEach(loadOne);
                }
                // 后台预加载剩余：立即开始空闲时串行拉取所有 cell
                const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
                let i = 0;
                const pump = () => {
                    if (mask._closed) return;
                    while (i < cellObjs.length) {
                        const obj = cellObjs[i++];
                        if (!obj.gImg.src) { loadOne(obj); break; }
                    }
                    if (i < cellObjs.length) ric(pump);
                };
                ric(pump);
            }, 16);
            mask.onclick = (e) => { if (e.target === mask) closeGallery(); };
            single.onwheel = (e) => {
                e.preventDefault();
                if (e.ctrlKey) {
                    scale += e.deltaY > 0 ? -0.1 : 0.1;
                    scale = Math.max(0.3, Math.min(5, scale));
                    // 缩回原尺寸（scale <= 1）时平移量一起清零，否则图片会停在偏移位置
                    if (scale <= 1) { panX = 0; panY = 0; }
                    applyTransform();
                } else {
                    showSingle(currentIdx + (e.deltaY > 0 ? 1 : -1));
                }
            };
            //          点背景与按 Esc 共用同一份，保证两种退出方式落到同一层
            function backToGrid() {
                galleryBox.style.display = 'flex';
                single.style.display = 'none';
                if (cellObjs[currentIdx]) {
                    const cell = cellObjs[currentIdx].cell;
                    cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    cell.classList.add('mb-flash-ring');
                    setTimeout(() => cell.classList.remove('mb-flash-ring'), 1500);
                }
            }
            // ===== 单图交互：原尺寸显示 / 双击图片或点顶部条退出 / Esc 关闭 =====
            const exitSingle = () => {
                if (fromThread || direct) closeGallery();
                else backToGrid();
            };
            // 双击图片退出（单击不再退出，避免误触）
            bigImg.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                exitSingle();
            });
            // ===== 放大后拖拽平移：只在 scale > 1 时启用 =====
            // 未放大时图片本来就完整可见，拖动没有意义，还会和「点背景退出」抢手势，所以直接不接管
            let dragging = false, dragMoved = false;
            let dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
            let suppressClick = false;   // 拖完松手那一下会被浏览器当成 click，需要吞掉
            const clampPan = () => {
                // 限制在「图片相对容器的溢出范围」内，拖再多也不会把图甩出屏幕找不回来
                const w = single.clientWidth || 0, h = single.clientHeight || 0;
                const maxX = Math.max(0, (w * (scale - 1)) / 2);
                const maxY = Math.max(0, (h * (scale - 1)) / 2);
                panX = Math.max(-maxX, Math.min(maxX, panX));
                panY = Math.max(-maxY, Math.min(maxY, panY));
            };
            single.addEventListener('pointerdown', (e) => {
                if (scale <= 1) return;
                if (e.button !== 0) return;
                // 顶部工具条、底部缩略条、按钮不参与拖动
                if (e.target.closest && (e.target.closest('.mb-single-btn') || e.target.closest('.mb-single-bar') || e.target.closest('.mb-single-thumbs'))) return;
                dragging = true; dragMoved = false;
                dragStartX = e.clientX; dragStartY = e.clientY;
                panStartX = panX; panStartY = panY;
                bigImg.style.cursor = 'grabbing';
                try { single.setPointerCapture(e.pointerId); } catch (err) {}
                e.preventDefault();
            });
            single.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
                panX = panStartX + dx; panY = panStartY + dy;
                clampPan();
                applyTransform();
            });
            const endDrag = (e) => {
                if (!dragging) return;
                dragging = false;
                bigImg.style.cursor = scale > 1 ? 'grab' : '';
                try { single.releasePointerCapture(e.pointerId); } catch (err) {}
                if (dragMoved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
            };
            single.addEventListener('pointerup', endDrag);
            single.addEventListener('pointercancel', endDrag);
            // 点背景退出：原尺寸下只有小图四周才点得到背景
            single.onclick = (e) => {
                if (suppressClick) { suppressClick = false; return; }
                if (e.target === single) exitSingle();
            };
            // 顶部条整条可点退出；条内按钮自带 stopPropagation，不会误触
            singleBar.addEventListener('click', (e) => {
                if (e.target === singleBar) exitSingle();
            });
            document.body.appendChild(mask);
            //          （「首张直入大图不亮、翻一张才亮」的根因就是挂载前调用了 showSingle）
            if (direct) showSingle(startIndex);
            // 淡入动画：下一帧设置opacity为1
            requestAnimationFrame(() => {
                mask.style.opacity = '1';
                const galleryBox = mask.querySelector('.mb-gallery-box');
                if (galleryBox) galleryBox.style.transform = 'scale(1)';
            });
            return closeGallery;
        }
    };

        // ===================== 模块二：萌宝看图 =====================
    // removeStickyAndAds：删除置顶帖与广告分隔线（业务规则：置顶帖按广告处理）
    const moduleKantu = Mengbao.Kantu = {
        config: { THUMB_W: 300, THUMB_H: 300, GALLERY_BG_COLOR: '#faf8f5', GALLERY_CELL_COLOR: '#f8fafc' },
        fab: null, _fabState: 'idle',
        loadedPostCache: new Map(),      // 内存：tid -> {title, imgs, dom?}
        _cacheStore: { data: {}, order: [] },
        processingTids: new Set(),
        requestQueue: [], queueRunning: false,
        _lastScanCount: 0, _loadDone: 0, _loadTotal: 0, _checkDoneTimer: null,
        _pageDone: false, _countedTids: new Set(),
        _continuous: false, _doneToastShown: false, _listObserver: null, _obsTimer: null,

        _memCacheSet(tid, entry) {
            if (this.loadedPostCache.has(tid)) this.loadedPostCache.delete(tid);
            this.loadedPostCache.set(tid, entry);
            while (this.loadedPostCache.size > CONST.CACHE_MAX_POSTS) {
                const oldestKey = this.loadedPostCache.keys().next().value;
                const old = this.loadedPostCache.get(oldestKey);
                if (old && old.dom) {
                    if (old.dom.parentNode) old.dom.parentNode.removeChild(old.dom);
                    else old.dom.remove();
                }
                this.loadedPostCache.delete(oldestKey);
            }
        },

        _restoreOrRebuild(tid, anchor) {
            const entry = this.loadedPostCache.get(tid);
            if (!entry) return;
            const existing = document.getElementById(CONST.PREVIEW_ID_PREFIX + tid);
            if (existing) {
                existing.style.display = '';
                return;
            }
            if (entry.imgs && anchor) {
                this.renderCachedPreview(anchor, tid, entry.title, entry.imgs);
            }
        },

        _makeTd(rowAnchor) {
            const td = document.createElement('td');
            td.colSpan = (rowAnchor && rowAnchor.cells) ? rowAnchor.cells.length : 99;
            td.className = 'mb-kantu-td';
            return td;
        },
        _makeDivWrap(tid) {
            const wrap = document.createElement('div');
            wrap.id = CONST.PREVIEW_ID_PREFIX + tid;
            wrap.className = 'mb-kantu-preview-wrap';
            return wrap;
        },
        //      清空 td/th 后塞跨列 td，注入的永远是合法 tbody，杜绝裸 <tr> 直接进 table 压塌列宽
        _buildPreviewWrap(anchor, tid) {
            if (anchor.tagName === 'TBODY') {
                const wrap = anchor.cloneNode(true);
                wrap.id = CONST.PREVIEW_ID_PREFIX + tid;
                Array.from(wrap.querySelectorAll('td,th')).forEach(el => el.remove());
                const firstTr = anchor.querySelector('tr');
                const tdWrap = this._makeTd(firstTr || anchor);
                const cloneTr = wrap.querySelector('tr');
                if (cloneTr) cloneTr.appendChild(tdWrap);
                return { wrap, tdWrap };
            }
            if (anchor.tagName === 'TR') {
                const wrap = document.createElement('tr');
                wrap.id = CONST.PREVIEW_ID_PREFIX + tid;
                const tdWrap = this._makeTd(anchor);
                wrap.appendChild(tdWrap);
                return { wrap, tdWrap };
            }
            const wrap = this._makeDivWrap(tid);
            return { wrap, tdWrap: wrap };
        },

        init() {
            this.config = Util.mergeConfig(this.config, Util.storage.get('mengbao.kantu.config', null));
            Util.storage.set('mengbao.kantu.config', this.config);
            this._loadPersistentCache();
            Lazy.ensureImgObserver();
            this.fab = createFab({
                module: 'kantu', storageKey: 'mengbao.kantu.fab_pos',
                defaultPos: { left: 24, bottom: 280 },
                onClick: (fab) => this.handleFabClick(fab),
                onContextMenu: (fab) => this.handleFabRightClick(fab)
            });
            if (this.fab && this.fab.el) this.fab.el.classList.add('mb-fab--kantu');
            this._setFabState('idle');
        },

        _loadPersistentCache() {
            this._cacheStore = { data: {}, order: [] };
            const stored = Util.storage.get('mengbao.kantu.cache', null);
            if (!stored || typeof stored !== 'object' || !stored.data || typeof stored.data !== 'object' || Array.isArray(stored.data)) {
                return;
            }
            const data = {};
            Object.keys(stored.data).forEach(k => {
                const v = stored.data[k];
                if (v && typeof v === 'object' && Array.isArray(v.imgs) && typeof v.title === 'string') data[k] = v;
            });
            const order = Array.isArray(stored.order) ? stored.order.filter(x => typeof x === 'string' && data[x]) : Object.keys(data);
            this._cacheStore = { data, order };
        },
        _persistCache(tid, title, imgs) {
            if (!imgs || imgs.length === 0) return;
            const store = this._cacheStore;
            if (store.data[tid]) {
                store.order = store.order.filter(x => x !== tid);
            }
            store.data[tid] = { title, imgs };
            store.order.push(tid);
            while (store.order.length > CONST.CACHE_MAX_POSTS) {
                const old = store.order.shift();
                delete store.data[old];
            }
            // 一页 40 帖会把整个缓存块序列化 40 遍（O(n²)），改成标脏 + 空闲合并写
            this._cacheDirty = true;
            if (this._cachePersistTimer) return;
            this._cachePersistTimer = setTimeout(() => {
                this._cachePersistTimer = 0;
                this._flushCache();
            }, CONST.CACHE_PERSIST_DELAY_MS);
        },
        _flushCache() {
            if (!this._cacheDirty) return;
            this._cacheDirty = false;
            const store = this._cacheStore;
            const payload = { data: store.data, order: store.order };
            // 写入前体积估算：超过保守阈值先淘汰最旧一半，避免直接触发配额异常
            let serialized = JSON.stringify(payload);
            if (serialized.length > CONST.CACHE_SERIALIZED_LIMIT) {
                while (store.order.length > Math.max(10, CONST.CACHE_MAX_POSTS / 2)) {
                    const old = store.order.shift();
                    delete store.data[old];
                }
                payload.data = store.data; payload.order = store.order;
                serialized = JSON.stringify(payload);
            }
            try {
                Util.storage.set('mengbao.kantu.cache', payload);
            } catch (e) {
                // 配额超限：再淘汰最旧一半后重试一次，重试仍失败仅降级为内存缓存，不抛错
                while (store.order.length > Math.max(10, CONST.CACHE_MAX_POSTS / 2)) {
                    const old = store.order.shift();
                    delete store.data[old];
                }
                try {
                    Util.storage.set('mengbao.kantu.cache', { data: store.data, order: store.order });
                } catch (e2) {
                    Util.log('warn', '图片预览缓存二次写入失败，降级为仅内存缓存', e2);
                }
                Util.toast('图片缓存已满，已自动清理最旧的缓存', 2000, 'kantu');
            }
        },

        scanCurrentPage() {
            const url = location.href;
            let count = 0;
            if (isForumListPage(url)) {
                this.removeStickyAndAds();
                count = this.scanThreads();
            } else if (isSpaceFavPage(url)) { this.genericListScan(['.bm_c ul.bmlist']); count = this._lastScanCount; }
            else if (isSearchResultPage(url)) { this.genericListScan(['.common.xi2', '.se_ThreadList', '.tl']); count = this._lastScanCount; }
            else if (isSpaceThreadPage(url) || isSpaceReplyPage(url)) { this.genericListScan(['.tl', '.threadlist', '.bm_c']); count = this._lastScanCount; }
            else if (isGuidePage(url)) { this.genericListScan(['.tl', '.threadlist', '.bm_c']); count = this._lastScanCount; }
            return count;
        },
        removeStickyAndAds() {
            try {
                const root = document.querySelector('#threadlist') || document;
                root.querySelectorAll('.tl tr:has(td.tpin)').forEach(el => el.remove());
                root.querySelectorAll('div.show-text2').forEach(el => {
                    if (!el.querySelector('.tl tr:has(td.icn)')) el.remove();
                });
                const sep = root.querySelector('#separatorline');
                if (sep) sep.remove();
            } catch (e) {}
        },
        scanThreads() {
            const tbodyList = document.querySelectorAll(".tl tr:has(td.icn)");
            let count = 0;
            const favoriteMap = Mengbao.Zengqiang ? Mengbao.Zengqiang.favoriteThreads : {};
            tbodyList.forEach(tbody => {
                const tidMatch = tbody.querySelector('a[href*="mod=viewthread"]')?.href.match(/tid=(\d+)/); const tid = tidMatch ? tidMatch[1] : '';
                // 取不到 tid 的行不能往下走：空 tid 会以 '' 为键跑完整请求与缓存流程
                if (!tid) return;
                // 前置过滤——被过滤板块的帖子直接跳过，不发请求、不插预览行
                if (typeof Mengbao.Guolv !== 'undefined' && Mengbao.Guolv._initialized && Mengbao.Guolv.isTidHidden(tid)) return;
                if (this.loadedPostCache.has(tid)) { this._restoreOrRebuild(tid, tbody); return; }
                if (this.processingTids.has(tid)) return;
                const titleEl = tbody.querySelector('th a.xst') || tbody.querySelector('th a');
                const title = titleEl ? titleEl.innerText.trim() : '图片预览';
                // 每个 tid 只计一次：否则 MutationObserver 每次插入预览行都会重扫一遍，
                // 把尚未完成的帖子重复计入，分母被翻成实际帖数的好几倍
                if (!this._countedTids.has(tid)) { this._countedTids.add(tid); count++; }
                const cached = this._cacheStore.data[tid];
                // 缓存命中直接渲染、不走请求队列，完成数要同步计入，否则分母含它、分子不含它
                if (cached) { this.renderCachedPreview(tbody, tid, cached.title, cached.imgs); this._loadDone++; return; }
                // 残留失败行：清掉并直接重试（data-mb-empty 的"本帖无图片"行保留不动）
                const oldRow = document.getElementById(CONST.PREVIEW_ID_PREFIX + tid);
                if (oldRow && oldRow.dataset.mbFailed === '1') {
                    oldRow.remove();
                    this.loadThreadPreview(tbody, tid, title);
                    return;
                }
                tbody.dataset.mbTid = tid;
                tbody.dataset.mbTitle = title;
                Lazy.observePost(tbody, (el) => { if (this._stopped) return; this.loadThreadPreview(el, tid, title); });
            });
            return count;
        },
        genericListScan(containerSelectors) {
            let container = null;
            for (const sel of containerSelectors) { container = document.querySelector(sel); if (container) break; }
            if (!container) {
                container = document.querySelector('#threadlist, .bm_c, .tl, .se_ThreadList, .common.xi2, .postlist, .threadlist') || document.body;
            }
            const links = Array.from(container.querySelectorAll('a[href*="mod=viewthread"], a[href*="-thread-"], a[href*="/thread-"]'));
            const seen = new Set(); let count = 0;
            links.forEach(a => {
                const href = a.href;
                const m = href.match(/[?&]tid=(\d+)/) || href.match(/thread-(\d+)/);
                const tid = m ? m[1] : null;
                if (!tid || seen.has(tid) || this.processingTids.has(tid)) return;
                // 前置过滤
                if (typeof Mengbao.Guolv !== 'undefined' && Mengbao.Guolv._initialized && Mengbao.Guolv.isTidHidden(tid)) return;
                if (this.loadedPostCache.has(tid)) {
                    const rowAnchor = a.closest('.pbw, li, tr') || a.parentElement;
                    this._restoreOrRebuild(tid, rowAnchor);
                    return;
                }
                if (!a.innerText || a.innerText.trim().length < 2) return;
                if (a.closest('.tbm, .hm, .pg, #header, #footer, .pn')) return;
                seen.add(tid);
                const title = a.innerText.trim().slice(0, 80) || '图片预览';
                if (!this._countedTids.has(tid)) { this._countedTids.add(tid); count++; }
                const rowAnchor = a.closest('li, dl, div.item, div.threadlist, div.thread, tr') || a.parentElement;
                const cached = this._cacheStore.data[tid];
                if (cached) { this.renderCachedPreview(rowAnchor, tid, cached.title, cached.imgs); this._loadDone++; return; }
                // 残留失败行：清掉并直接重试
                const oldRow = document.getElementById(CONST.PREVIEW_ID_PREFIX + tid);
                if (oldRow && oldRow.dataset.mbFailed === '1') {
                    oldRow.remove();
                    this.genericLoadPreview(rowAnchor, tid, title);
                    return;
                }
                a.dataset.mbTid = tid;
                a.dataset.mbTitle = title;
                Lazy.observePost(a, (el) => { if (this._stopped) return; this.genericLoadPreview(el, tid, title); });
            });
            this._lastScanCount = count;
        },
        _syncRowHidden(anchor, wrap, tid) {
            try {
                const hidden = Mengbao.Guolv && typeof Mengbao.Guolv.isTidHidden === 'function' && Mengbao.Guolv.isTidHidden(tid);
                if (hidden) wrap.style.display = 'none';
            } catch (e) {}
        },
        renderCachedPreview(anchor, tid, postTitle, imgs) {
            const old = document.getElementById(CONST.PREVIEW_ID_PREFIX + tid);
            if (old) old.remove();
            const { wrap, tdWrap } = this._buildPreviewWrap(anchor, tid);
            this.loadImagesInto(null, tdWrap, postTitle, imgs);
            if (anchor.tagName === 'LI') anchor.appendChild(wrap); else anchor.after(wrap);
            this._syncRowHidden(anchor, wrap, tid);
            this._memCacheSet(tid, { title: postTitle, imgs, dom: wrap });
        },
        //      处理完统一释放 processingTids，单任务异常隔离
        _requestPreview(url, tid, onOk, onFail) {
            this.processingTids.add(tid);
            this.enqueueRequest(() => Util.httpGet(url).then(
                (html) => {
                    try {
                        const doc = Util.parseHtml(html);
                        const postEl = doc.querySelector('#postlist > div[id^=post_]');
                        if (postEl) onOk(postEl);
                        else if (onFail) onFail('未找到帖子内容');
                    } catch (e) {
                        Util.log('warn', '解析帖子预览失败', tid, e);
                        if (onFail) onFail('帖子加载失败，请稍后再试');
                    } finally {
                        this.processingTids.delete(tid);
                    }
                },
                (err) => {
                    const status = (err && err.message) || 'network';
                    Util.recordFail(status, '看图预览');
                    if (onFail) {
                        if (status === '403') onFail('访问被拒绝（403），请重新登录');
                        else if (status === 'timeout') onFail('帖子加载超时');
                        else onFail('帖子加载失败，请稍后再试');
                    }
                    this.processingTids.delete(tid);
                }
            ));
        },
        loadThreadPreview(tbody, tid, postTitle) {
            if (this.loadedPostCache.has(tid) || this.processingTids.has(tid)) return;
            const linkA = tbody.querySelector('.icn > a');
            if (!linkA) return;
            const url = new URL(linkA.href, location.origin).href;
            this._requestPreview(url, tid,
                (postEl) => {
                    if (this._stopped) return;
                    const infoId = CONST.PREVIEW_ID_PREFIX + tid;
                    const old = document.getElementById(infoId); if (old) old.remove();
                    const { wrap, tdWrap } = this._buildPreviewWrap(tbody, tid);
                    const imgs = Util.extractImages(postEl);
                    this.loadImagesInto(postEl, tdWrap, postTitle, imgs);
                    this._persistCache(tid, postTitle, imgs);
                    this._memCacheSet(tid, { title: postTitle, imgs, dom: wrap });
                    tbody.after(wrap);
                    this._syncRowHidden(tbody, wrap, tid);
                },
                (reason) => {
                    if (this._stopped) return;
                    const infoId = CONST.PREVIEW_ID_PREFIX + tid;
                    const old = document.getElementById(infoId); if (old) old.remove();
                    const { wrap, tdWrap } = this._buildPreviewWrap(tbody, tid);
                    tdWrap.className = 'mb-kantu-fail-text';
                    tdWrap.textContent = '⚠️ ' + reason + ' ';
                    const retryBtn = document.createElement('button');
                    retryBtn.type = 'button';
                    retryBtn.textContent = '[重试]';
                    retryBtn.className = 'mb-kantu-retry-btn';
                    retryBtn.onclick = (e) => {
                        e.stopPropagation();
                        wrap.remove();
                        this.loadThreadPreview(tbody, tid, postTitle);
                    };
                    tdWrap.appendChild(retryBtn);
                    wrap.dataset.mbFailed = '1';
                    tbody.after(wrap);
                    this._syncRowHidden(tbody, wrap, tid);
                });
        },
        genericLoadPreview(linkEl, tid, postTitle) {
            if (this.loadedPostCache.has(tid) || this.processingTids.has(tid)) return;
            const url = new URL(linkEl.href, location.origin).href;
            let anchor = linkEl.closest('li, dl, div.item, div.threadlist, div.thread, tr');
            if (!anchor) anchor = linkEl.parentElement;
            this._requestPreview(url, tid,
                (postEl) => {
                    if (this._stopped) return;
                    const infoId = CONST.PREVIEW_ID_PREFIX + tid;
                    const old = document.getElementById(infoId); if (old) old.remove();
                    const { wrap, tdWrap } = this._buildPreviewWrap(anchor, tid);
                    const imgs = Util.extractImages(postEl);
                    this.loadImagesInto(postEl, tdWrap, postTitle, imgs);
                    this._persistCache(tid, postTitle, imgs);
                    this._memCacheSet(tid, { title: postTitle, imgs, dom: wrap });
                    if (anchor.tagName === 'LI') anchor.appendChild(wrap); else anchor.after(wrap);
                    this._syncRowHidden(anchor, wrap, tid);
                },
                (reason) => {
                    if (this._stopped) return;
                    const infoId = CONST.PREVIEW_ID_PREFIX + tid;
                    const old = document.getElementById(infoId); if (old) old.remove();
                    const { wrap, tdWrap } = this._buildPreviewWrap(anchor, tid);
                    tdWrap.className = 'mb-kantu-fail-text';
                    tdWrap.textContent = '⚠️ ' + reason + ' ';
                    const retryBtn = document.createElement('button');
                    retryBtn.type = 'button';
                    retryBtn.textContent = '[重试]';
                    retryBtn.className = 'mb-kantu-retry-btn';
                    retryBtn.onclick = (e) => {
                        e.stopPropagation();
                        wrap.remove();
                        this.genericLoadPreview(anchor, tid, postTitle);
                    };
                    tdWrap.appendChild(retryBtn);
                    wrap.dataset.mbFailed = '1';
                    if (anchor.tagName === 'LI') anchor.appendChild(wrap); else anchor.after(wrap);
                    this._syncRowHidden(anchor, wrap, tid);
                });
        },
        loadImagesInto(doc, container, postTitle, presetImgs) {
            const fullSrcList = presetImgs || (doc ? Util.extractImages(doc) : []);
            const wrap = document.createElement('div');
            wrap.className = 'mb-kantu-scroll-wrap';
            const thumbHRaw = parseInt(Util.storage.get('mengbao.kantu.thumbH', 200), 10);
            const thumbH = Number.isFinite(thumbHRaw) ? Math.min(320, Math.max(120, thumbHRaw)) : 200;
            wrap.style.maxHeight = (thumbH + 10) + 'px';
            const inner = document.createElement('div');
            inner.className = 'mb-kantu-scroll-inner';
            const preloadRaw = parseInt(Util.storage.get('mengbao.kantu.preload', CONST.FIX_PRELOAD));
            const preloadCount = Number.isFinite(preloadRaw) ? Math.min(12, Math.max(1, preloadRaw)) : CONST.FIX_PRELOAD;
            const initialList = fullSrcList.slice(0, preloadCount);
            if (initialList.length === 0) {
                // 真·无图：帖子加载成功但 extractImages 抓不到，重试无意义，低调提示即可
                wrap.textContent = '本帖无图片';
                wrap.className = 'mb-kantu-empty-wrap';
                wrap.dataset.mbEmpty = '1';
                container.appendChild(wrap);
                return;
            }
            initialList.forEach((picUrl, idx) => {
                const img = document.createElement('img');
                img.className = 'mb-kantu-thumb';
                img.style.width = 'auto';
                img.style.objectFit = 'cover';
                img.style.minWidth = '120px';
                img.style.height = thumbH + 'px';
                img.onerror = () => {
                    img.style.display = 'none';
                    const placeholder = document.createElement('div');
                    placeholder.style.cssText = 'height:' + thumbH + 'px; width:120px; background:var(--mb-bg-secondary); border-radius:var(--mb-radius-sm); display:flex; align-items:center; justify-content:center; color:var(--mb-text-hint); font-size:var(--mb-font-sm); flex-shrink:0;';
                    placeholder.textContent = '加载失败';
                    img.parentNode.insertBefore(placeholder, img);
                };
                img.onclick = (e) => { e.stopPropagation(); Gallery.open(fullSrcList, idx, postTitle, null, 0, true, img); };
                img.dataset.src = picUrl;
                Lazy.observeImage(img);
                inner.appendChild(img);
            });
            // 如果还有更多图片，加一个"+"占位
            if (fullSrcList.length > initialList.length) {
                const more = document.createElement('div');
                more.className = 'mb-kantu-more';
                more.innerHTML = '<div style="width:60px;height:60px;border-radius:50%;background:var(--mb-border);display:flex;align-items:center;justify-content:center;color:var(--mb-text-muted);font-size:28px;font-weight:bold;">+</div>';
                more.style.cssText = 'height:' + thumbH + 'px; width:100px; display:flex; align-items:center; justify-content:center; flex-shrink:0; cursor:pointer;';
                more.title = `还有 ${fullSrcList.length - initialList.length} 张图片，点击查看全部`;
                more.onclick = (e) => { e.stopPropagation(); Gallery.open(fullSrcList, 0, postTitle, null, 0, false, more); };
                inner.appendChild(more);
            }
            wrap.appendChild(inner); container.appendChild(wrap);
        },
        enqueueRequest(task) {
            this.requestQueue.push(task);
            this.runQueue();
        },
        async runQueue() {
            if (this.queueRunning) return;
            this.queueRunning = true;
            try {
                while (this.requestQueue.length > 0) {
                    const batch = this.requestQueue.splice(0, CONST.QUEUE_CONCURRENCY);
                    // 单任务加硬上限：请求返回了但后续处理没走完、或连接挂住时，15s 的请求超时兜不住，
                    // 这里是最后一道闸——超时也计入完成，队列绝不会被一个任务永久锁死
                    await Promise.all(batch.map(fn => Promise.race([
                        fn().catch(() => {}),
                        new Promise(resolve => setTimeout(resolve, CONST.QUEUE_TASK_TIMEOUT))
                    ]).then(() => { this._loadDone++; })));
                }
            } finally {
                this.queueRunning = false;
            }
        },
        _setFabState(state) {
            this._fabState = state;
            const fabBtn = this.fab && this.fab.el && this.fab.el.querySelector('.mb-fab-btn');
            if (!fabBtn) return;
            fabBtn.classList.remove('mb-loading', 'mb-continuous', 'mb-paused');
            fabBtn.title = '';
            // paused 时给 body 加 class，CSS 自动隐藏所有图片预览（包括新加载的）
            if (state === 'paused') {
                document.body.classList.add('mb-kantu-hidden');
            } else {
                document.body.classList.remove('mb-kantu-hidden');
            }
            if (state === 'loading') {
                fabBtn.classList.add('mb-continuous');
                fabBtn.title = '🖼️ 持续加载中 · 左键停止';
            } else if (state === 'paused') {
                fabBtn.classList.add('mb-paused');
                fabBtn.title = '🖼️ 已收起 · 左键展开预览';
            } else {
                fabBtn.title = '🖼️ 左键：开启持续加载（把列表里所有帖子的图都加载出来）｜ 右键：停止加载并收起预览（图片缓存保留）｜ 拖拽：移动位置';
            }
        },
        _startListObserver() {
            if (this._listObserver) return;
            const root = document.querySelector('#threadlist') || document.querySelector('.bm_c') || document;
            this._listObserver = new MutationObserver(() => {
                if (!this._continuous || this._stopped) return;
                if (this._obsTimer) clearTimeout(this._obsTimer);
                this._obsTimer = setTimeout(() => {
                    if (!this._continuous || this._stopped) return;
                    const total = this.scanCurrentPage();
                    if (total > 0) {
                        this._loadTotal += total;
                        this._pageDone = false;
                        Util.showLoading(`持续加载中，新增 ${total} 个帖子…`);
                    }
                }, 300);
            });
            this._listObserver.observe(root, { childList: true, subtree: true });
        },
        _stopListObserver() {
            if (this._obsTimer) { clearTimeout(this._obsTimer); this._obsTimer = null; }
            if (this._listObserver) { this._listObserver.disconnect(); this._listObserver = null; }
        },
        _startContinuous() {
            this._continuous = true;
            this._stopped = false;
            this._doneToastShown = false;
            this._pageDone = false;
            this._countedTids = new Set();
            this._loadDone = 0; this._loadTotal = 0;
            Lazy._forceAll = true;
            const total = this.scanCurrentPage();
            this._setFabState('loading');
            if (total === 0) {
                Util.toast('已开启持续看图，翻页后自动加载', 1500, 'kantu');
            } else {
                this._loadTotal = total;
                Util.showLoading(`开始加载 ${total} 个帖子图片…`);
            }
            this._startListObserver();
            const loadingStart = Date.now();
            let lastDone = -1, idleSince = 0, stallHandled = false;   // 无进展检测：计数长时间不变即视为卡死
            this._checkDoneTimer = setInterval(() => {
                const done = this._loadDone;
                if (done !== lastDone) { lastDone = done; idleSince = Date.now(); stallHandled = false; }
                if (done > 0 && !this._pageDone) Util.showLoading(`正在加载图片 ${done}/${this._loadTotal}…`);
                if (Date.now() - loadingStart < CONST.LOADING_MIN_SHOW_MS) return;
                // 队列与 tid 都清空 = 正常收尾；计数追平总数也算收尾（_loadTotal 可能比实际可入队任务多算）
                const queueIdle = !this.queueRunning && this.requestQueue.length === 0 && this.processingTids.size === 0;
                const countMatched = this._loadTotal > 0 && done >= this._loadTotal && !this.queueRunning;
                if (queueIdle || countMatched) {
                    if (this._pageDone) return;      // 已收尾，等翻页新增把 _pageDone 置回 false
                    // 提示条无条件收掉：原先 hideLoading 只写在 _doneToastShown 首次为 false 的分支里，
                    // 第二次翻页完成后该标记已为 true，两条分支都不进，提示条会永久挂在右下角
                    this._pageDone = true;
                    Util.hideLoading();
                    if (this._continuous) {
                        if (!this._doneToastShown) {
                            this._doneToastShown = true;
                            Util.toast('本页图片加载完成，翻页后自动继续', 2000, 'kantu');
                        }
                    } else {
                        clearInterval(this._checkDoneTimer); this._checkDoneTimer = null;
                        this._setFabState('idle');
                        Util.toast(`帖子图片加载完成，共识别到 ${this._loadTotal} 帖`, 2000, 'kantu');
                    }
                    return;
                }
                // 兜底：队列有活或 tid 有残留，但计数已 STALL_RESET_MS 没动过 → 判定卡死，强制复位。
                //       典型现场就是「58/59 一直挂着，点一下球就恢复」——图其实早加载完了，只是收尾条件永远不成立
                if (!stallHandled && idleSince && Date.now() - idleSince >= CONST.STALL_RESET_MS) {
                    stallHandled = true;
                    const stuck = Array.from(this.processingTids);
                    if (Util.storage.get('mengbao.debug', false)) {
                        Util.log('debug', '持续加载判定卡死，强制复位', {
                            loadDone: this._loadDone, loadTotal: this._loadTotal,
                            queue: this.requestQueue.length, processing: stuck, queueRunning: this.queueRunning
                        });
                    }
                    const left = Math.max(0, this._loadTotal - this._loadDone);
                    this.requestQueue.length = 0;
                    // 清残留 tid 顺带修掉「点[重试]没反应」：重试入口的卫语句会把残留 tid 直接 return 掉
                    this.processingTids.clear();
                    this._pageDone = true;
                    Util.hideLoading();
                    if (!this._continuous) {
                        clearInterval(this._checkDoneTimer); this._checkDoneTimer = null;
                        this._setFabState('idle');
                    }
                    if (left > 0) Util.toast(`有 ${left} 帖加载超时，可点该帖的[重试]再试`, 2500, 'kantu');
                }
            }, CONST.POLL_INTERVAL_MS);
        },
        _stopContinuous() {
            this._continuous = false;
            this._stopped = true;
            this.requestQueue.length = 0;
            this.processingTids.clear();
            this._loadDone = 0; this._loadTotal = 0;
            this._countedTids = new Set();
            this._pageDone = false;
            Lazy._forceAll = false;
            if (this._checkDoneTimer) { clearInterval(this._checkDoneTimer); this._checkDoneTimer = null; }
            Util.hideLoading();
            this._stopListObserver();
        },
        handleFabClick(fab) {
            // 暂停态（灰）：左键只展开预览，不自动恢复加载
            if (this._fabState === 'paused') {
                // 只展开预览，_stopped 保持 true（不恢复加载）
                document.body.classList.remove('mb-kantu-hidden');
                this._setFabState('idle');
                Util.toast('帖子图片预览已展开', 1500, 'kantu');
                return;
            }
            if (this._fabState === 'loading') {
                this._stopContinuous();
                this._setFabState('idle');
                Util.toast('已停止持续加载，已加载图片保持显示', 1500, 'kantu');
                return;
            }
            // 就绪态（浅黄）：左键开启持续加载（保持旋转，翻页新增行自动加载）
            this._startContinuous();
        },
        handleFabRightClick(fab) {
            if (this._fabState === 'paused') {
                Util.toast('预览已收起', 1200, 'kantu');
                return;
            }
            this._stopContinuous();
            this._setFabState('paused');
            Util.toast('已清空队列并收起预览，左键展开', 1500, 'kantu');
        },
        isTargetPage() {
            const url = location.href;
            if (/[?&]type=reply\b/.test(url)) return false;
            if (isDarkroomPage(url)) return false;
            return isForumListPage(url) || isSpaceFavPage(url) || isSearchResultPage(url) || isGuidePage(url) || isSpaceThreadPage(url);
        }
    };

    // ===================== 模块三：萌宝翻页 =====================
    // 列表页/主题页/收藏页/搜索结果页：原生「下一页」与右下角悬浮按钮均 AJAX 追加，不刷新；
    // 左键=加载一页；右键切常驻持续加载（绿，每延时追一页到末页，再右键停）；列表页按 tid 去重保序
    const modulePager = Mengbao.Fanye = {
        _busy: false,
        _currentPage: 1,
        _fab: null,
        _continuous: false,
        _continuousTimer: null,
        init() {
            this._buildFabButton();
        },
        isTargetPage() {
            return isForumListPage() || isSpaceFavPage() || isSearchResultPage() || isDarkroomPage() || isGuidePage() || isSpaceThreadPage() || isSpaceReplyPage();
        },
        _delayMs() {
            const v = Number(Util.storage.get('mengbao.fanye.delaySec', 5));
            return (Number.isFinite(v) ? v : 5) * 1000;
        },
        _nextHref() {
            // 多种分页选择器兼容：列表页/搜索页/收藏页
            let a = document.querySelector('.pg a.nxt, a.nxt');
            if (!a) {
                // 兜底：找文本是"下一页"的链接
                const links = document.querySelectorAll('a');
                for (const l of links) {
                    if (l.textContent.trim().includes('下一页')) { a = l; break; }
                }
            }
            return a ? a.href : null;
        },
        _buildFabButton() {
            this._fab = createFab({
                module: 'fanye',
                storageKey: 'mengbao.fanye.fab_pos',
                defaultPos: { left: 24, bottom: 200 },
                onClick: () => {
                    if (this._continuous) { this._setContinuous(false); return; }
                    if (this._busy) return;
                    if (isDarkroomPage()) { this._loadNext(null); return; }
                    const href = this._nextHref();
                    if (href) this._loadNext(href);
                    else Util.toast('已是最后一页', 1500, 'fanye');
                },
                onContextMenu: () => {
                    if (!this._continuous) {
                        if (isDarkroomPage() ? !document.querySelector('a#darkroommore') : !this._nextHref()) {
                            Util.toast('已是最后一页，无法自动加载', 1500, 'fanye');
                            return;
                        }
                        this._setContinuous(true);
                        this._scheduleNext(0);
                    } else {
                        this._setContinuous(false);
                    }
                }
            });
            if (this._fab && this._fab.el) { this._fab.el.classList.add('mb-fab--fanye'); const pageLabel = document.createElement('div'); pageLabel.className = 'mb-fanye-page-label'; pageLabel.textContent = '共 1 页'; pageLabel.style.display = 'none'; this._fab.el.appendChild(pageLabel); this._pageLabel = pageLabel; }
            this._refreshBtn();
        },
        _setContinuous(on) {
            this._continuous = on;
            this._refreshBtn();
            if (!on && this._continuousTimer) { clearTimeout(this._continuousTimer); this._continuousTimer = null; }
            Util.toast(on ? '已开启自动翻页，点击停止' : '已停止自动翻页', 2000, 'fanye');
        },
        _refreshBtn() {
            if (!this._fab || !this._fab.el) return;
            this._fab.el.style.display = '';
            const btn = this._fab.el.querySelector('.mb-fab-btn');
            if (btn) {
                btn.classList.toggle('mb-loading', !!(this._busy && !this._continuous));
                btn.classList.toggle('mb-continuous', !!this._continuous);
                if (this._continuous) btn.title = '📄 持续加载中 · 左键停止 ｜ 拖拽：移动位置';
                else if (this._busy) btn.title = '📄 正在加载下一页…';
                else btn.title = '📄 左键：加载下一页 ｜ 右键：持续加载（自动翻完所有页）｜ 拖拽：移动位置';
            }
            // 慢加载提示：同一页超过 3 秒才把页码标签临时切成「加载中…」
            if (this._pageLabel) {
                if (this._busy) {
                    if (!this._slowTimer) {
                        this._slowTimer = setTimeout(() => {
                            this._slowTimer = null;
                            if (this._busy && this._pageLabel) { this._pageLabel.textContent = '加载中…'; this._pageLabel.style.display = ''; }
                        }, 3000);
                    }
                } else {
                    if (this._slowTimer) { clearTimeout(this._slowTimer); this._slowTimer = null; }
                    if (this._currentPage) { this._pageLabel.textContent = `共 ${this._currentPage} 页`; this._pageLabel.style.display = ''; }
                }
            }
        },
        _scheduleNext(ms) {
            if (this._continuousTimer) clearTimeout(this._continuousTimer);
            this._continuousTimer = setTimeout(() => {
                this._continuousTimer = null;
                if (!this._continuous || this._busy) return;
                if (isDarkroomPage()) { this._loadNext(null); return; }
                const href = this._nextHref();
                if (href) this._loadNext(href);
            }, ms);
        },
        _replacePager(doc) {
            const curList = Array.from(document.querySelectorAll('div.pg'));
            const nextList = Array.from(doc.querySelectorAll('div.pg'));
            curList.forEach((cur, i) => { const next = nextList[i] || nextList[nextList.length - 1]; if (next) cur.replaceWith(next); });
        },
        async _loadNext(href) {
            this._busy = true; this._refreshBtn();
            let appended = 0;
            try {
                // 小黑屋页：翻页按钮是 a#darkroommore（javascript:;），直接点击触发页面自带AJAX
                if (isDarkroomPage()) {
                    const moreBtn = document.querySelector('a#darkroommore');
                    if (!moreBtn) {
                        Util.toast('已是最后一页', 1500, 'fanye');
                        return;
                    }
                    const rowSel = 'table#darkroomtable tr';
                    const beforeRows = document.querySelectorAll(rowSel).length;
                    // 点击按钮触发页面自带翻页
                    moreBtn.click();
                    let afterRows = beforeRows;
                    const waitStart = Date.now();
                    while (Date.now() - waitStart < 6000) {
                        await new Promise(resolve => setTimeout(resolve, 400));
                        afterRows = document.querySelectorAll(rowSel).length;
                        if (afterRows > beforeRows) break;
                    }
                    appended = afterRows - beforeRows;
                    if (appended > 0) {
                        this._failCount = 0;
                        this._currentPage++;
                        if (this._pageLabel) { this._pageLabel.textContent = `共 ${this._currentPage} 页`; this._pageLabel.style.display = ''; }
                        Util.toast(`已加载成功一页，新增 ${appended} 个用户`, 2000, 'fanye');
                    } else {
                        const stillThere = !!document.querySelector('a#darkroommore');
                        if (stillThere) {
                            Util.toast(this._continuous ? '网络较慢，正在等待加载…' : '网络较慢，暂未加载到新用户，请稍后再试', 1800, 'fanye');
                        } else {
                            Util.toast('已是最后一页', 1500, 'fanye');
                        }
                    }
                    return;
                }

                // 带上 Referer：部分 Discuz 站开了防盗链/WAF，无 Referer 的请求会被直接拒绝
                const html = await Util.httpGet(href, {
                    'Referer': location.href,
                    // 补齐浏览器导航请求常见的头，缺这些时部分 WAF 会直接回 503
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': navigator.language || 'zh-CN,zh;q=0.9',
                    'Upgrade-Insecure-Requests': '1'
                });
                const doc = Util.parseHtml(html);
                appended = isForumListPage() ? this._appendForumRows(doc)
                    : isSpaceFavPage() || isGuidePage() || isSpaceThreadPage() || isSpaceReplyPage() ? this._appendSpaceRows(doc)
                    : this._appendSearchRows(doc);
                this._replacePager(doc);
                Util.safeRun('翻页后归位游离行', () => this._reparentNakedRows());
                Util.hideLoading();
                // 翻页后清掉孤立的预览节点（缓存命中的由 kantu 下次扫描时重建）
                Mengbao.Preview.all().forEach(n => {
                    const tid = Mengbao.Preview.tidOf(n.id);
                    if (!Mengbao.Kantu.loadedPostCache.has(tid)) n.remove();
                });
                if (appended > 0) {
                    this._failCount = 0;
                    this._currentPage++;
                    if (this._pageLabel) { this._pageLabel.textContent = `共 ${this._currentPage} 页`; this._pageLabel.style.display = ''; }
                    Util.toast(`已自动加载 ${appended} 个新帖到当前页`, 2000, 'fanye');
                    // 追加后联动：搜索页同步板块筛选（看图不自动扫，等用户点球）
                    Util.safeRun('翻页后重建过滤面板', () => {
                        if (Mengbao.Guolv && Mengbao.Guolv.isTargetPage()) {
                            Mengbao.Guolv.scanThreads();
                            Mengbao.Guolv.applyAllHidden();
                            Mengbao.Guolv.renderSectionButtons();
                        }
                    });
                } else {
                    Util.toast('已是最后一页', 1500, 'fanye');
                }
            } catch (e) {
                Util.hideLoading();
                const msg = (e && e.message) || 'unknown';
                Util.log('error', '[翻页] 请求失败', href, msg);
                // 区分失败原因，别再统一报"请刷新重试"，那样排不出问题
                this._failCount = (this._failCount || 0) + 1;
                // 503/429 是限流，属于暂时状态：等更久再试，别直接放弃
                if (/HTTP (503|429)/.test(msg)) {
                    if (this._failCount <= 3) {
                        this._backoffMs = [12000, 24000, 40000][this._failCount - 1];
                        Util.toast(`服务器限流（${msg}），${this._backoffMs / 1000} 秒后重试（第 ${this._failCount}/3 次）`, 3000, 'fanye');
                    } else {
                        Util.toast('连续被限流，已停止自动翻页。建议把「翻页延时」调大，或过几分钟再试', 3200, 'fanye');
                    }
                } else {
                    let tip = '翻页加载失败：' + msg;
                    if (/timeout/i.test(msg)) tip = '翻页请求超时，该页太大或服务器响应慢';
                    else if (/HTTP (4|5)/.test(msg)) tip = '翻页被拒绝（' + msg + '）';
                    else if (/network/i.test(msg)) tip = '翻页网络错误，连接被中断';
                    Util.toast(tip, 3000, 'fanye');
                }
            } finally {
                this._busy = false;
                this._refreshBtn();

                if (this._continuous) {
                    const hasNext = isDarkroomPage() ? !!document.querySelector('a#darkroommore') : !!this._nextHref();
                    if (!hasNext) {
                        this._continuous = false; this._refreshBtn(); Util.toast('已到末页，持续加载结束', 1500, 'fanye');
                    } else if (this._failCount > 3) {
                        this._continuous = false; this._failCount = 0; this._refreshBtn();
                        Util.toast('多次翻页失败，已停止自动翻页', 2600, 'fanye');
                    } else if (this._backoffMs > 0) {
                        const w = this._backoffMs; this._backoffMs = 0; this._scheduleNext(w);
                    } else if (this._failCount >= 2) {
                        this._continuous = false; this._failCount = 0; this._refreshBtn();
                        Util.toast('连续两次翻页失败，已停止自动翻页', 2400, 'fanye');
                    } else {
                        this._scheduleNext(this._delayMs());
                    }
                }
            }
        },
        // 列表页：追加 normalthread tbody，按 tid(id) 去重

        //   新帖被塞进表头 → 页码翻了却看不到新帖；

        //   现在统一：按 td.icn 认列表表格，按 normalthread_* 行组整组搬运，一帖一组。
        _forumTable(src) {
            const root = src || document;
            const byId = root.querySelector('#threadlisttableid');
            if (byId) return byId;
            const inList = root.querySelector('#threadlist table');
            if (inList) return inList;
            const cands = Array.from(root.querySelectorAll('table')).filter(t => t.querySelector('td.icn'));
            return cands.length ? cands[cands.length - 1] : null;
        },
        // 一帖一组：取含 td.icn 的 tbody；万一没有分组，就把主行各自包成 tbody（绝不产生裸 tr）
        _postGroups(tableEl) {
            const groups = Array.from(tableEl.querySelectorAll('tbody')).filter(tb => tb.querySelector('td.icn'));
            if (groups.length) return groups;
            const made = [];
            Array.from(tableEl.querySelectorAll('tr')).forEach(tr => {
                if (!tr.querySelector('td.icn')) return;
                const tb = tableEl.ownerDocument.createElement('tbody');
                tb.appendChild(tr);
                made.push(tb);
            });
            return made;
        },
        _tidOfGroup(tb) {
            const byId = (tb.id || '').match(/normalthread_(\d+)/);
            if (byId) return byId[1];
            const a = tb.querySelector('a[href*="mod=viewthread"]');
            const m = a && (a.href || '').match(/tid=(\d+)/);
            return m ? m[1] : '';
        },
        // 把容器根上已经游离的帖子行归位：修历史遗留，用户不必刷新重开
        _reparentNakedRows() {
            const tableEl = this._forumTable();
            if (!tableEl) return 0;
            const roots = [tableEl, tableEl.parentElement, document.querySelector('.tl')].filter(Boolean);
            const seen = new Set();
            let moved = 0;
            roots.forEach(root => {
                if (!root || !root.children) return;
                Array.from(root.children).forEach(c => {
                    if (c.tagName !== 'TR' || seen.has(c)) return;
                    seen.add(c);
                    // 只归位帖子主行；预览行交给 kantu 自己的清理逻辑
                    if (!c.querySelector('td.icn')) return;
                    const a = c.querySelector('a[href*="mod=viewthread"]');
                    const m = a && (a.href || '').match(/tid=(\d+)/);
                    const tb = document.createElement('tbody');
                    if (m) tb.id = 'normalthread_' + m[1];
                    tb.appendChild(c);
                    tableEl.appendChild(tb);
                    moved++;
                });
            });
            return moved;
        },
        _appendForumRows(doc) {
            const liveTable = this._forumTable();
            if (!liveTable) return 0;
            const docTable = this._forumTable(doc) || doc.querySelector('.tl');
            if (!docTable) return 0;

            const existing = new Set();
            liveTable.querySelectorAll('tbody[id^="normalthread_"]').forEach(tb => {
                const t = (tb.id.match(/normalthread_(\d+)/) || [])[1];
                if (t) existing.add(t);
            });

            const groups = this._postGroups(docTable);
            if (!groups.length) return 0;

            // 锚点取「最后一个帖子行组」，避免新帖插到表格末尾那个匿名尾巴行之后
            const liveGroups = Array.from(liveTable.querySelectorAll('tbody')).filter(tb => tb.querySelector('td.icn'));
            let anchor = liveGroups.length ? liveGroups[liveGroups.length - 1] : null;

            let added = 0;
            groups.forEach(tb => {
                const tid = this._tidOfGroup(tb);
                if (!tid || existing.has(tid)) return;
                existing.add(tid);
                if (!tb.id) tb.id = 'normalthread_' + tid;
                if (anchor) anchor.after(tb); else liveTable.insertBefore(tb, liveTable.firstChild);
                anchor = tb;
                added++;
            });
            return added;
        },
        // space 主题/回复页：真实结构为 form#delform table，主行 <tr class="bw0_all"> 后跟
        //   <tr><td colspan=5 class="xg1">回复引用</td></tr>——引用行无 tid 链接，不能按 tid 过滤，
        //   否则回复内容全丢。整段搬 tr:not(.th)，页 2 的行本就全新，无需按 tid 去重。
        _appendSpaceRows(doc) {
            const liveTable = document.querySelector('form#delform table, form[name="delform"] table, .bm_c table');
            if (!liveTable) return 0;
            const host = liveTable.querySelector('tbody') || liveTable.createTBody();
            const docTable = doc.querySelector('form#delform table, form[name="delform"] table, .bm_c table');
            if (!docTable) return 0;
            const seen = new Set();
            host.querySelectorAll('a[href*="tid="]').forEach(a => {
                const m = (a.href || '').match(/[?&]tid=(\d+)/) || (a.href || '').match(/thread-(\d+)/);
                if (m) seen.add(m[1]);
            });
            // 以"主行"为单位：主行内含 <th>（标题）；其后续只有 <td colspan> 的引用行跟随
            const rows = Array.from(docTable.querySelectorAll('tr')).filter(r => !r.classList.contains('th'));
            let added = 0, skipBlock = false;
            rows.forEach(row => {
                const isMain = !!row.querySelector('th');
                if (isMain) {
                    const a = row.querySelector('a[href*="tid="]');
                    const m = a && ((a.href || '').match(/[?&]tid=(\d+)/) || (a.href || '').match(/thread-(\d+)/));
                    const tid = m ? m[1] : null;
                    skipBlock = !tid || seen.has(tid);
                    if (tid && !skipBlock) seen.add(tid);
                }
                if (skipBlock) return;
                host.appendChild(row);
                added++;
            });
            return added;
        },
        // 搜索结果页：追加 #threadlist 里的 .pbw 行，按 tid 去重
        _appendSearchRows(doc) {
            const list = document.querySelector('#threadlist');
            if (!list) return 0;
            const host = list.querySelector('ul') || list;
            const existing = new Set();
            host.querySelectorAll('a[href*="tid="]').forEach(a => {
                const m = (a.href || '').match(/[?&]tid=(\d+)/) || (a.href || '').match(/thread-(\d+)/); if (m) existing.add(m[1]);
            });
            const rows = doc.querySelectorAll('#threadlist .pbw, #threadlist > ul > li');
            let added = 0;
            rows.forEach(row => {
                const a = row.querySelector('a[href*="tid="]');
                const m = a && ((a.href || '').match(/[?&]tid=(\d+)/) || (a.href || '').match(/thread-(\d+)/));
                if (m) { if (existing.has(m[1])) return; existing.add(m[1]); }
                host.appendChild(row);
                added++;
            });
            return added;
        }
    };

    // ===================== 模块四：萌宝过滤 =====================
    const moduleGuolv = Mengbao.Guolv = {
        config: { hiddenSections: {}, keywordBlackList: '', kwScopeFid: null },
        fab: null, sectionMap: new Map(),
        _listWrap: null,
        _initialized: false,

        init() {
            if (this._initialized) return;
            this._initialized = true;
            this.config = Util.mergeConfig(this.config, Util.userStore.get('mengbao.guolv.config', null));
            Util.userStore.set('mengbao.guolv.config', this.config);
            this.fab = createFab({
                module: 'guolv', panelClass: 'mb-guolv-panel',
                storageKey: 'mengbao.guolv.fab_pos_v2',
                defaultPos: { left: 24, bottom: 720 },
                onClick: (fab) => { fab.togglePanel(); requestAnimationFrame(() => this.renderSectionButtons()); },
                onContextMenu: () => this.openSettingDialog(),
                panelBuilder: (panel) => this.buildPanel(panel)
            });
            if (this.fab && this.fab.el) {
                this.fab.el.classList.add('mb-fab--guolv');
                const gBtn = this.fab.el.querySelector('.mb-fab-btn');
                if (gBtn) gBtn.title = '🎯 左键：打开板块过滤面板 ｜ 右键：过滤与屏蔽设置 ｜ 拖拽：移动位置';
            }
            const tl = document.querySelector('#threadlist');
            if (tl && isSearchResultPage()) tl.classList.add('mb-search-card');
            
            this.scanThreads(); this.applyAllHidden(); this.renderSectionButtons();
            // 等待 AJAX 内容渲染后再补扫一次
            const tlProbe = document.querySelector('#threadlist');
            if (tlProbe) {
                const mo = new MutationObserver(() => {
                    this.scanThreads(); this.applyAllHidden(); this.renderSectionButtons();
                    mo.disconnect();
                });
                mo.observe(tlProbe, { childList: true, subtree: true, characterData: false });
                setTimeout(() => mo.disconnect(), 3000);
            }
            document.querySelectorAll('form').forEach(f => {
                if (!f.querySelector('input[name="keyword"], input[name="srchtxt"], input[type="search"]')) return;
                f.addEventListener('submit', () => {
                    this.sectionMap.clear();
                    if (this._listWrap) this._listWrap.innerHTML = '';
                    setTimeout(() => {
                        const tl2 = document.querySelector('#threadlist');
                        if (tl2 && isSearchResultPage()) tl2.classList.add('mb-search-card');
                        this.scanThreads(); this.applyAllHidden(); this.renderSectionButtons();
                    }, 300);
                });
            });
        },
        saveConfig() { Util.userStore.set('mengbao.guolv.config', this.config); },
        isTargetPage() {
            const url = location.href;
            if (/[?&]type=reply\b/.test(url)) return false;
            if (isDarkroomPage(url)) return false;
            return isSearchResultPage(url) || isGuidePage(url);
        },
        _makeGuolvItem(onClick) {
            const item = document.createElement('span');
            item.onclick = onClick;
            return item;
        },
        buildPanel(panel) {
            const tip = document.createElement('div');
            tip.className = 'mb-guolv-tip';
            tip.style.marginBottom = '8px';
            //          （球是左键开面板、右键开设置）。改为明确指向下面的板块条目
            tip.textContent = '左键过滤 · 右键只看';
            tip.title = '点击板块条目：隐藏该板块 ｜ 右键板块条目：只看该板块（其余全部隐藏）';
            this._tipEl = tip;
            panel.appendChild(tip);
            const grid = document.createElement('div');
            grid.className = 'mb-guolv-grid';
            panel.appendChild(grid);
            this._listWrap = grid;
        },
        querySection(thread) {
            const link = thread.querySelector('a.xi1[href*="fid="], p:last-child a[href*="fid="], a[href*="fid="], a[href^="forum-"]');
            if (!link) return null;
            let fid = null; const name = link.textContent.trim();
            try {
                const u = new URL(link.href, location.origin);
                fid = u.searchParams.get('fid');
                if (!fid) { const m = u.pathname.match(/forum-(\d+)-\d+\.html/); if (m) fid = m[1]; }
            } catch (e) { return null; }
            return fid ? { fid, name } : null;
        },
        _rows() {
            return document.querySelectorAll('#threadlist .pbw, #threadlisttableid tr, #threadlist .bm_c table tr');
        },
        scanThreads() {
            this.sectionMap.clear();
            if (isForumListPage()) return;
            this._rows().forEach(thread => {
                const r = this.querySection(thread);
                if (!r) return;
                if (!this.sectionMap.has(r.fid)) this.sectionMap.set(r.fid, { name: r.name, elements: [] });
                this.sectionMap.get(r.fid).elements.push(thread);
            });
        },
        _kwCacheRaw: null, _kwCache: [],
        _parseKwRules(raw) {
            return (raw || '').split(/[\n\r]+/).map(x => x.trim()).filter(Boolean).map(rule => {
                if (rule.startsWith('=')) {
                    const k = rule.slice(1).trim();
                    return { negate: false, match: t => t === k };
                }
                if (rule.startsWith('/') && rule.endsWith('/') && rule.length > 2) {
                    const p = rule.slice(1, -1);
                    try {
                        const re = new RegExp(p, 'i');
                        return { negate: false, match: t => re.test(t) };
                    //          改为用去掉斜杠的正文按字面匹配，并打 invalid 标记供保存时提示
                    } catch (e) { return { negate: false, invalid: true, match: t => t.includes(p) }; }
                }
                if (rule.startsWith('!')) {
                    const k = rule.slice(1).trim();
                    return { negate: true, match: t => t.includes(k) };
                }
                return { negate: false, match: t => t.includes(rule) };
            });
        },
        _ensureKwCache() {
            const raw = this.config.keywordBlackList || '';
            if (this._kwCacheRaw !== raw) {
                this._kwCacheRaw = raw;
                this._kwCache = this._parseKwRules(raw);
            }
        },
        _pageFid() {
            const m = location.href.match(/[?&]fid=(\d+)/) || location.href.match(/forum-(\d+)-\d+\.html/);
            return m ? m[1] : null;
        },
        _isKwHidden(item, fid) {
            this._ensureKwCache();
            if (!this._kwCache.length) return false;
            if (this.config.kwScopeFid != null && String(fid) !== String(this.config.kwScopeFid)) return false;
            const titleEl = item.querySelector('h3 a, .xs3 a, th a, a.xst');
            const title = (titleEl ? titleEl.textContent : item.textContent) || '';
            let hit = false;
            for (const r of this._kwCache) {
                const m = r.match(title);
                if (r.negate && m) return false;   // 标题含排除词 → 不隐藏
                if (!r.negate && m) hit = true;
            }
            return hit;
        },
        applyAllHidden() {
            this._ensureKwCache();
            this.hiddenTids = new Set();
            this._rows().forEach(item => {
                if (!item.querySelector('a[href*="tid="]')) return;
                const sec = this.querySection(item);
                const hideBySection = sec && this.config.hiddenSections[sec.fid];
                const hide = hideBySection || this._isKwHidden(item, sec ? sec.fid : this._pageFid());
                item.style.display = hide ? 'none' : '';
                if (hide) {
                    const tid = this._tidOf(item);
                    if (tid) this.hiddenTids.add(tid);
                }
            });
            this._syncAllPreviewHidden();
            Util.log('debug', '[萌宝过滤] applyAllHidden', { sections: this.sectionMap.size, hiddenTids: this.hiddenTids.size, previews: Mengbao.Preview.all().length });
        },
        hiddenTids: new Set(),
        _tidOf(el) {
            const a = el.querySelector('a[href*="tid="]');
            const m = a && ((a.href || '').match(/[?&]tid=(\d+)/) || (a.href || '').match(/thread-(\d+)/));
            return m ? m[1] : null;
        },
        _rebuildHiddenTids() {
            this.hiddenTids = new Set();
            this._rows().forEach(item => {
                if (!item.querySelector('a[href*="tid="]')) return;
                const sec = this.querySection(item);
                const hideBySection = sec && this.config.hiddenSections[sec.fid];
                if (hideBySection || this._isKwHidden(item, sec ? sec.fid : this._pageFid())) {
                    const tid = this._tidOf(item);
                    if (tid) this.hiddenTids.add(tid);
                }
            });
        },
        isTidHidden(tid) { return !!tid && this.hiddenTids.has(tid); },
        _syncAllPreviewHidden() {
            Mengbao.Preview.all().forEach(el => {
                const tid = Mengbao.Preview.tidOf(el.id);
                const prev = el.previousElementSibling;
                const prevHidden = prev && prev.classList && prev.classList.contains('pbw') && prev.style.display === 'none';
                // 过滤则隐藏，取消过滤则恢复显示
                if (this.hiddenTids.has(tid) || prevHidden) el.style.display = 'none';
                else el.style.display = '';
            });
        },
        _applySectionHidden(fid) {
            const hiddenSection = !!this.config.hiddenSections[fid];
            this._rows().forEach(item => {
                if (!item.querySelector('a[href*="tid="]')) return;
                const sec = this.querySection(item);
                if (!sec || sec.fid !== fid) return;
                const hide = hiddenSection || this._isKwHidden(item, sec.fid);
                item.style.display = hide ? 'none' : '';
            });
            this._rebuildHiddenTids();
            this._syncAllPreviewHidden();
        },

        //          过滤状态交给样式表达（灰底 + 灰字 + 删除线），数字始终代表真实规模。
        _sectionCount(fid) {
            const sec = this.sectionMap.get(fid);
            if (!sec) return 0;
            return sec.elements.length;
        },
        _toggleOnly(fid) {
            const keys = [...this.sectionMap.keys()];
            const sec = this.sectionMap.get(fid);
            const isOnly = !this.config.hiddenSections[fid] && keys.every(k => k === fid || this.config.hiddenSections[k]);
            if (isOnly) {
                //          与提示文案一致。快照会把进入前的手动过滤原样带回来，
                //          退出后仍有灰条，用户以为没生效。
                keys.forEach(k => { delete this.config.hiddenSections[k]; });
                Util.toast('已退出只看，恢复全部显示', 1500, 'success');
            } else {
                keys.forEach(k => { this.config.hiddenSections[k] = (k !== fid); });
                Util.toast(`只看「${sec ? sec.name : fid}」，其余板块已隐藏`, 1800, 'success');
            }
            this.saveConfig();
            this.applyAllHidden();
            this.renderSectionButtons();
        },
        renderSectionButtons() {
            if (!this._listWrap) return;
            this._listWrap.innerHTML = '';
            const fragment = document.createDocumentFragment();
            const keys = [...this.sectionMap.keys()];
            // 无板块分组（如搜索/导读之外的分组缺失）→ 面板留空即可，不显示提示
            if (keys.length === 0) return;
            for (const [fid, sec] of this.sectionMap) {
                const hidden = !!this.config.hiddenSections[fid];
                const isOnly = !hidden && keys.every(k => k === fid || this.config.hiddenSections[k]);
                // 左键=过滤（切换隐藏）；右键=只看（其他全隐藏）/退出只看
                const item = this._makeGuolvItem(() => {
                    this.config.hiddenSections[fid] = !this.config.hiddenSections[fid];
                    this.saveConfig();
                    item.classList.toggle('mb-hidden', !!this.config.hiddenSections[fid]);
                    item.classList.toggle('mb-only', false);
                    this._applySectionHidden(fid);
                    const visible = this._sectionCount(fid);
                    const cntEl = item.querySelector('.mb-guolv-count');
                    if (cntEl) cntEl.textContent = visible <= 99 ? visible : '99+';
                });
                item.title = '左键：过滤该板块 · 右键：只看该板块';
                item.oncontextmenu = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    this._toggleOnly(fid);
                };
                item.className = 'mb-guolv-item' + (hidden ? ' mb-hidden' : '') + (isOnly ? ' mb-only' : '');
                const cnt = document.createElement('span');
                cnt.className = 'mb-guolv-count';
                const visible = this._sectionCount(fid);
                cnt.textContent = visible <= 99 ? visible : '99+';
                item.appendChild(cnt);
                item.appendChild(document.createTextNode(sec.name));
                fragment.appendChild(item);
            }
            this._listWrap.appendChild(fragment);
            const n = this.sectionMap.size;
            const two = n >= 9;
            //   单列（300px 内容区 268px）用精简句防折行；双列（460px 内容区 428px）放宽到完整句。
            //   .mb-guolv-tip 自带 max-width:200px（当初给小面板定的），完整句约 190px 正好卡边界，
            //   双列时解除该上限，保证一行。每条板块自己的悬停提示仍保留完整说明，未动。
            if (this._tipEl) {
                if (two) {
                    this._tipEl.textContent = '左键：过滤该板块 · 右键：只看该板块';
                    this._tipEl.style.maxWidth = 'none';
                } else {
                    this._tipEl.textContent = '左键过滤 · 右键只看';
                    this._tipEl.style.maxWidth = '';
                }
            }
            this._listWrap.style.gridTemplateColumns = two ? '1fr 1fr' : '1fr';
            const panel = this._listWrap.closest('.mb-guolv-panel');
            if (panel) {
                panel.classList.toggle('mb-guolv-panel--2col', two);
                panel.classList.toggle('mb-guolv-panel--1col', !two);
                if (this.fab && this.fab.recalcFlip) this.fab.recalcFlip();
            }
        },
        openSettingDialog() {
            let curFid = null;
            try {
                const u = new URL(location.href, location.origin);
                curFid = u.searchParams.get('fid');
                if (!curFid) { const m = u.pathname.match(/forum-(\d+)-\d+\.html/); if (m) curFid = m[1]; }
            } catch (e) { /* 忽略 */ }
            const scopeHtml = curFid
                ? `<label class="mb-guolv-scope"><input type="checkbox" class="inp-scope" ${this.config.kwScopeFid === curFid ? 'checked' : ''}> 仅过滤当前板块（板块 ID ${curFid}）</label>`
                : `<div class="mb-guolv-tip" style="max-width:none;">当前页面不支持限定板块，过滤词将全局生效（板块列表页可开启）</div>`;
            const modal = openModal({
                width: 'sm',
                closeOnMaskClick: false,
                body: `
                <div class="mb-guolv-head">
                    <span class="mb-guolv-title">🎯 ${Util.escapeHtml(Util.userStore.get('mengbao.panel.nickname', '萌宝'))}过滤</span>
                    <span class="mb-guolv-head-btns">
                        <button class="mb-guolv-cancel mb-btn mb-btn-secondary">取消</button>
                        <button class="btn-save mb-btn mb-btn-primary mb-guolv-save">确定</button>
                    </span>
                </div>
                <textarea class="inp-kw mb-modal-textarea mb-guolv-kw-input mb-input-base" placeholder="每行一条：广告 / =求资源 / /公告/ / !置顶">${Util.escapeTextarea(this.config.keywordBlackList || '')}</textarea>
                <div class="mb-guolv-tip" style="margin-top:8px;line-height:1.9;max-width:none;">
                    每行一条规则，示例：<br>
                    <code>广告</code> → 隐藏标题含「广告」的帖子<br>
                    <code>=求资源</code> → 隐藏标题正好是「求资源」的帖子<br>
                    <code>/公告/</code> → 标题匹配正则「公告」的帖子隐藏（可写复杂正则）<br>
                    <code>!置顶</code> → 标题含「置顶」的帖子不隐藏（排除词，抵消误杀）
                </div>
                ${scopeHtml}`
            });
            modal.query('.mb-guolv-cancel').onclick = () => modal.close();
            modal.query('.btn-save').onclick = () => {
                this.config.keywordBlackList = modal.query('.inp-kw').value;
                const scopeEl = modal.query('.inp-scope');
                if (scopeEl) this.config.kwScopeFid = scopeEl.checked ? curFid : null;
                this._kwCacheRaw = null;
                this.saveConfig(); this.applyAllHidden(); this.renderSectionButtons();
                const rules = this._parseKwRules(this.config.keywordBlackList);
                const bad = rules.filter(r => r.invalid).length;
                const good = rules.length - bad;
                Util.toast(bad
                    ? `设置已保存：${good} 条生效，${bad} 条正则写法有误已忽略`
                    : `设置已保存，即时生效（${good} 条规则）`, 2200, bad ? 'error' : 'success');
                modal.close();
            };
        }
    };

    // ===================== 模块五：萌宝增强 =====================
    // 功能：悬浮球快捷操作 + 收藏用户（按钮+帖子高亮）+ 评论侧边面板 + 头像自定义 + 浏览历史标记
    // 数据：本地缓存收藏帖与评分帖状态，减少重复请求；与收藏页双向同步
    const moduleZengqiang = Mengbao.Zengqiang = {
        config: { initFavorRecords: false },
        fab: null, myUserId: -1,
        favoriteThreads: {}, ratedThreads: {},
        _panel: null,
        _rateUnsubscribe: null, _rateResolved: false,
        _favoriteSyncing: false, // 正在同步收藏记录，同步期间禁用收藏按钮

        // 初始化：识别当前用户、加载本地缓存、构建悬浮球、等待公共脚本就绪
        init() {
            Util.safeRun('增强模块初始化', () => {
                this.myUserId = this.findMyUserId();
                this.config = Util.mergeConfig(this.config, Util.storage.get('mengbao.zengqiang.main', null));
                Util.storage.set('mengbao.zengqiang.main', this.config);
                this.favoriteThreads = (() => { const r = Util.userStore.get('mengbao.zengqiang.favorite', { time: 0, data: {} }); this._lastFavSync = (r && typeof r.time === 'number') ? r.time : 0; return r && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {}; })();
                this.ratedThreads = (() => { const r = Util.userStore.get('mengbao.zengqiang.rated', { time: 0, data: {} }); return r && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {}; })();

                this.waitCommonJs().then(() => {
                    //   原先它被放进 isThreadPage() 块里，而函数内部第一行又要求当前页是 do=favorite，
                    //   两个条件互斥 → 这个函数从未执行过：在收藏页删掉收藏后本地缓存不清理，
                    //   回到详情页「❤️ 收藏」按钮还亮着，再点会去删一个已不存在的 favoriteId。
                    this.initFavoritePageSync();
                    // 只有在详情页才创建悬浮球和显示 UI
                    if (isThreadPage()) {
                        if (Date.now() - this._lastFavSync > CONST.FAV_SYNC_THROTTLE_MS) {
                            this.readFavorRecords(true);
                        }
                        this.fab = createFab({
                            module: 'zengqiang', storageKey: 'mengbao.zengqiang.fab_pos', panelClass: 'mb-zengqiang-panel',
                            defaultPos: { left: 24, bottom: 360 },
                            onClick: (fab) => fab.togglePanel(),
                            onContextMenu: () => { if (window.MengbaoCommentPanel) window.MengbaoCommentPanel.toggle(); },
                            panelBuilder: (panel) => { this._panel = panel; this.refreshPanel(); }
                        });
                        if (this.fab && this.fab.el) this.fab.el.classList.add('mb-fab--zengqiang');
                        if (this.fab && this.fab.el) {
                            const zBtn = this.fab.el.querySelector('.mb-fab-btn');
                            if (zBtn) zBtn.title = '⚡ 左键：打开功能面板（画廊/收藏/评分…）｜ 右键：打开评论面板 ｜ 拖拽：移动位置';
                        }
                        //          这里再建一次内容完全相同，只是白白重排一遍
                        this.initGalleryActiveSync();
                        this.bindThreadImages();
                    }
                });
            });
        },
        saveFavoriteThreads() { Util.userStore.set('mengbao.zengqiang.favorite', { time: Date.now(), data: this.favoriteThreads }); },
        saveRatedThreads() { Util.userStore.set('mengbao.zengqiang.rated', { time: Date.now(), data: this.ratedThreads }); },
        // 任何白名单域名都初始化（用于同步收藏记录到本地缓存）
        // 详情页才显示收藏按钮等 UI
        isTargetPage() { return IS_HOST_ALLOWED; },

        waitCommonJs() {
            return new Promise((resolve) => {
                let tries = 0;
                const check = () => {
                    tries++;
                    try {
                        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.showloading) return resolve();
                        const scripts = document.querySelectorAll('script[src*="common.js"]');
                        if (scripts.length) return resolve();
                    } catch (e) {}
                    if (tries >= 15) { Util.log('warn', '公共脚本等待超时，降级继续初始化'); Util.toast('页面加载有点慢，已提前进入'); return resolve(); }
                    setTimeout(check, 200);
                };
                check();
            });
        },

        findMyUserId() {
            // 由服务器生成、每页反映当前登录账号，多账号自动正确
            try {
                const dv = window.discuz_uid;
                if (dv !== undefined && dv !== null && dv !== '') {
                    const n = Number(dv);
                    if (Number.isFinite(n) && n > 0) return n;
                }
            } catch (e) {}
            // ② 标准 Discuz 页头用户菜单
            const a = document.querySelector('#um .vwmy a')
                   || document.querySelector('#um_mypage a[href*="uid="]')
                   || document.querySelector('#um a[href*="uid="]');
            if (a && a.href) { const m = a.href.match(/uid=(\d+)/); if (m) return Number(m[1]); }
            // ③ 内联脚本 discuz_uid
            const scripts = document.querySelectorAll('script:not([src])');
            for (const s of scripts) { const m = s.textContent.match(/discuz_uid\s*=\s*"?(\d+)"?/); if (m) return Number(m[1]); }
            // ④ 页头/导航区域带 uid 链接（限定区域，避免误命中搜索结果作者）
            const navA = document.querySelector('.nv a[href*="uid="], #nv a[href*="uid="], .hd a[href*="uid="], #toptb a[href*="uid="]');
            if (navA) { const m = navA.href.match(/uid=(\d+)/); if (m) return Number(m[1]); }
            // ⑤ cookie 兜底：Discuz 会话 cookie 值以 {uid}|{时间戳}|{hash} 开头
            try {
                const cm = document.cookie.match(/lastcheckfeed=(\d+)/) || document.cookie.match(/st_t=(\d+)/) || document.cookie.match(/st_p=(\d+)/) || document.cookie.match(/ulastactivity=(\d+)/);
                if (cm) { const n = Number(cm[1]); if (Number.isFinite(n) && n > 0) return n; }
            } catch (e) {}
            return -1;
        },
        async readFavorRecords(fresh, done) {
            if (!fresh) return this.favoriteThreads;

            if (this._favorSyncPromise) {
                try { await this._favorSyncPromise; } catch (e) {}
                if (done) done();
                return this.favoriteThreads;
            }
            this._favorSyncPromise = (async () => {
                let nextHref = 'home.php?mod=space&do=favorite&view=me';
                let guard = 0;
                // 全量同步：先清空缓存，再从服务端重建完整列表
                const freshMap = {};
                while (nextHref && guard < CONST.FAV_USER_PAGE_GUARD) {
                    guard++;
                    const html = await Util.httpGet(nextHref);
                    const doc = Util.parseHtml(html);
                    doc.querySelectorAll('ul#favorite_ul li[id^=fav_]').forEach(li => {
                        const input = li.querySelector('input[name="favorite[]"]');
                        if (input) {
                            const favoriteId = Number(input.value);
                            const vidAttr = input.getAttribute('vid');
                            const vid = vidAttr ? Number(vidAttr) : null;
                            if (vid) freshMap[vid] = favoriteId;
                        }
                    });
                    const next = doc.querySelector('.pg a.nxt');
                    nextHref = next ? next.href : null;
                    // 页间留 80ms 间隔：全量同步最多 50 页，连发会给论坛服务端造成压力
                    if (nextHref) await Util.sleep(80);
                }
                // 全量替换：用服务端完整列表覆盖本地缓存
                this.favoriteThreads = freshMap;
                this.saveFavoriteThreads();
            })().catch(e => {
                Util.log('error', '收藏记录加载失败', e);
            }).finally(() => {
                this._favorSyncPromise = null;
            });
            try { await this._favorSyncPromise; } finally { if (done) done(); }
            return this.favoriteThreads;
        },
        getTid() {
            const u = new URL(location.href);
            const t = u.searchParams.get('tid');
            if (t) return t;
            const m = location.pathname.match(/thread-(\d+)-/);
            return m ? m[1] : null;
        },
        getVerifyHash() {
            const input = document.querySelector('input[type=hidden][name=formhash][value]');
            if (input && input.value) return input.value;
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                const text = s.textContent || '';
                const m = text.match(/formhash\s*=\s*["']([A-Za-z0-9]{6,32})["']/) || text.match(/hash=([A-Za-z0-9]{6,32})/);
                if (m) return m[1];
            }
            return '';
        },
        refreshPanel() {
            if (!this._panel) return;
            const tid = this.getTid();
            const panel = this._panel;
            panel.innerHTML = '';
            const addBtn = (text, onClick, title) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mb-quick-btn'; btn.textContent = text; btn.onclick = onClick;
                if (title) btn.title = title;
                panel.appendChild(btn); return btn;
            };
            const galleryBtn = addBtn('🖼️ 画廊', () => this.toggleGallery(), '点击打开画廊网格');
            galleryBtn.dataset.mbAction = 'gallery';
            const favoriteBtn = addBtn('❤️ 收藏', () => {
                this.toggleFavorite(tid, favoriteBtn);
            }, '收藏本帖（已收藏时点击取消）——作者名旁的 ☆ 是收藏"该用户"，两者不同');
            if (tid && this.favoriteThreads[tid]) {
                favoriteBtn.classList.add('mb-active');
            }
            const rateBtn = addBtn('👍 评分', () => this.toggleRate(rateBtn), '给本帖评分（已评过会提示）');
            if (tid && this.ratedThreads[tid]) rateBtn.classList.add('mb-active');
            const payLink = document.querySelector('.locked a[href*="action=pay"]');
            if (payLink) addBtn('💰 购买', () => payLink.click(), '跳转到购买/付费内容');
            const replyLink = document.querySelector('.locked a[href*="action=reply"]');
            if (replyLink) addBtn('🔒 回复', () => replyLink.click(), '跳转到回复（需先解锁主题）');
            // 滚动定位：点击时才实时查目标（页面重排后旧引用会悬空），并手动算居中位置（不依赖 scrollIntoView 的容器判定）
            const scrollToTarget = (target) => {
                if (!target || typeof target.getBoundingClientRect !== 'function') return;
                const r = target.getBoundingClientRect();
                if (!r.height && !r.width) return;
                const top = r.top + window.scrollY - Math.max(0, (window.innerHeight - r.height) / 2);
                try { window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); }
                catch (e) { window.scrollTo(0, Math.max(0, top)); }
            };
            const findLinkBlock = () => document.querySelector('.blockcode') || document.querySelector('.hidecontent');
            if (findLinkBlock()) addBtn('🧲 链接', () => scrollToTarget(findLinkBlock()), '滚动到本帖的链接/隐藏内容区');
            document.querySelectorAll('[id^=attach_]').forEach(el => {
                if (!/^attach_\d+$/.test(el.id)) return;              // 排除 attach_xxx_menu / attach_tblheader 这类辅助节点
                if (!el.offsetHeight && !el.offsetWidth) return;      // 排除隐藏节点，避免生成点了没反应的按钮
                const aid = el.id;
                addBtn('📎 附件', () => scrollToTarget(document.getElementById(aid)), '滚动到本帖的附件区');
            });
            this.syncGalleryFabActive();
        },
        syncGalleryFabActive() {
            if (!this._panel) return;
            const btn = this._panel.querySelector('[data-mb-action="gallery"]');
            if (!btn) return;
            btn.classList.toggle('mb-active', !!document.querySelector('.mb-gallery-mask'));
        },
        initGalleryActiveSync() {
            if (this._galleryObserver) return;
            this._galleryObserver = new MutationObserver(() => this.syncGalleryFabActive());
            this._galleryObserver.observe(document.body, { childList: true });
        },
        // 收藏/取消收藏：简化逻辑，避免占位 true 导致的循环问题
        // 收藏成功后存 1（占位），取消时如果没有 favoriteId 就先同步一次
        async toggleFavorite(tid, btn) {
            if (!tid) return;
            if (this._favoriteBusy) return; // 防重入：同步中忽略重复点击
            this._favoriteBusy = true;
            // 按钮进入 loading 状态，防止重复点击
            btn.classList.add('mb-fab-loading');
            btn.style.pointerEvents = 'none';
            const formhash = this.getVerifyHash();
            const cached = this.favoriteThreads[tid];
            const isFavorited = cached !== undefined;

            // ---- 已收藏 → 取消 ----
            if (isFavorited) {
                let favoriteId = cached;
                // 如果缓存是占位 1（不是真实 favoriteId），先同步一次拿到真实 ID
                if (typeof favoriteId !== 'number' || favoriteId < 100) {
                    await this.readFavorRecords(true);
                    favoriteId = this.favoriteThreads[tid];
                    // 同步后还是没有真实 favoriteId，就直接删除本地缓存
                    if (typeof favoriteId !== 'number' || favoriteId < 100) {
                        delete this.favoriteThreads[tid]; this.saveFavoriteThreads();
                        btn.classList.remove('mb-active');
                        this._favoriteBusy = false;
                        btn.classList.remove('mb-fab-loading');
                        btn.style.pointerEvents = '';
                        return;
                    }
                }
                // 取消收藏请求
                const postData = new URLSearchParams();
                postData.set('formhash', formhash);
                postData.set('handlekey', 'a_delete_' + favoriteId);
                postData.set('deletesubmit', true);
                Util.httpPost(`home.php?mod=spacecp&ac=favorite&op=delete&favid=${favoriteId}&type=all&inajax=1`, postData).then(() => {
                    delete this.favoriteThreads[tid]; this.saveFavoriteThreads();
                    btn.classList.remove('mb-active');
                    Util.toast('已取消收藏', 1500, 'favorite');
                }).catch(() => Util.toast('取消收藏失败，请稍后再试', 1500, 'error')).finally(() => {
                    this._favoriteBusy = false;
                    btn.classList.remove('mb-fab-loading');
                    btn.style.pointerEvents = '';
                });
                return;
            }

            // ---- 未收藏 → 收藏 ----
            Util.httpGet(`home.php?mod=spacecp&ac=favorite&type=thread&id=${tid}&formhash=${formhash}&infloat=yes&handlekey=k_favorite&inajax=1&ajaxtarget=fwin_content_k_favorite`).then(text => {
                // 收藏成功，标记为已收藏（存 1 占位，真实 favoriteId 由后台同步补齐）
                this.favoriteThreads[tid] = 1; this.saveFavoriteThreads();
                btn.classList.add('mb-active');
                Util.toast('收藏成功', 1500, 'favorite');
                //（同步与取消共用同一个防重入 Promise，取消时若同步未完成会等待其完成）
                this.readFavorRecords(true);
            }).catch(() => Util.toast('收藏失败，请稍后再试', 1500, 'error')).finally(() => {
                this._favoriteBusy = false;
                btn.classList.remove('mb-fab-loading');
                btn.style.pointerEvents = '';
            });
        },
        // 评分：点击评分按钮后 hook 论坛原生回调（succeedhandle_rate / errorhandle_rate）
        // 窗口 HTML 注入后（检测到 #rateform）再覆盖，避免被窗口 HTML 重新定义覆盖
        //   弹窗一开就顶着最高分，用户想评低分得先跟预填值较劲；且 li 文本带加号，填进去也不是纯数字。
        //   现在保持论坛原生：score8 初始 0，用户点 ^ 自行展开选择。
        toggleRate(btn) {
            const el = document.querySelector('#ak_rate');
            if (el) el.click();
            const tid = this.getTid();
            // 清理之前的观察器
            if (this._rateObserver) { this._rateObserver.disconnect(); this._rateObserver = null; }
            this._rateResolved = false;
            const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const self = this;
            const resolve = (success, type = 'success') => {
                if (self._rateResolved) return;
                self._rateResolved = true;
                if (self._rateObserver) { self._rateObserver.disconnect(); self._rateObserver = null; }
                if (tid) { self.ratedThreads[tid] = true; self.saveRatedThreads(); btn.classList.add('mb-active'); }
                // 显示对应的 toast
                if (success) {
                    if (type === 'info') {
                        Util.toast('已经评分过了', 2000, 'info');
                    } else {
                        Util.toast('评分成功', 2000, 'success');
                    }
                }
            };
            // 重复评分只做状态标记，不弹提示：论坛原生弹窗已经把原因说清楚了
            const markRatedQuiet = () => {
                if (self._rateResolved) return;
                self._rateResolved = true;
                if (self._rateObserver) { self._rateObserver.disconnect(); self._rateObserver = null; }
                if (tid) { self.ratedThreads[tid] = true; self.saveRatedThreads(); btn.classList.add('mb-active'); }
            };
            // 观察评分窗口出现，窗口 HTML 注入后 hook 原生回调
            this._rateObserver = new MutationObserver(() => {
                if (self._rateResolved) return;
                const alertErr = document.querySelector('.alert_error');
                if (alertErr && (alertErr.innerText || '').includes('重复评分')) {
                    markRatedQuiet();
                    return;
                }
                const rateForm = document.querySelector('#rateform');
                if (rateForm && !rateForm._mbRateHooked) {
                    rateForm._mbRateHooked = true;
                    // ===== 评分自动填最高分 =====
                    //   上限：优先 #scoreoption{后缀} 的 li（文本形如 “+2”，剥掉非数字后取最大），
                    //   没有选项列表则退回同一行“评分区间”单元格里的 “~ N”。
                    //   论坛评分窗口是 ajax 注入，个别模板注入后会把输入框再重置一次，
                    //   所以填完再校验两轮；用户一旦手动改过分（键盘输入或点 ^ 下拉选择），立即停手。
                    if (!rateForm._mbScoreFilled) {
                        rateForm._mbScoreFilled = true;
                        // 读某个评分字段的上限
                        const readMax = (inp) => {
                            const suffix = inp.name.replace(/^score/, '');
                            let maxVal = null;
                            const optList = rateForm.querySelector('#scoreoption' + suffix);
                            if (optList) {
                                optList.querySelectorAll('li').forEach(li => {
                                    const n = parseInt((li.textContent || '').replace(/[^0-9]/g, ''), 10);
                                    if (Number.isFinite(n) && n > 0) maxVal = (maxVal === null || n > maxVal) ? n : maxVal;
                                });
                            }
                            if (maxVal === null) {
                                const cell = inp.closest('td');
                                const row = cell ? cell.parentElement : null;
                                if (row) {
                                    row.querySelectorAll('td').forEach(td => {
                                        const m = (td.textContent || '').match(/[~～]\s*(\d+)/);
                                        if (m) {
                                            const n = parseInt(m[1], 10);
                                            if (Number.isFinite(n) && n > 0) maxVal = (maxVal === null || n > maxVal) ? n : maxVal;
                                        }
                                    });
                                }
                            }
                            return maxVal;
                        };
                        const applyMax = () => {
                            if (rateForm._mbScoreUserEdited) return;
                            rateForm.querySelectorAll('input[name^="score"]').forEach(inp => {
                                const maxVal = readMax(inp);
                                if (maxVal !== null && maxVal > 0 && String(maxVal) !== inp.value) {
                                    inp.value = String(maxVal);
                                }
                            });
                        };
                        // 用户改分后永久停手：键盘输入走 input 事件，点 ^ 展开/点选项走 click
                        const stopAutoFill = () => { rateForm._mbScoreUserEdited = true; };
                        rateForm.addEventListener('input', stopAutoFill, true);
                        rateForm.addEventListener('click', (e) => {
                            const t = e.target;
                            if (t && t.closest && (t.closest('.dpbtn') || t.closest('ul[id^="scoreoption"]'))) stopAutoFill();
                        }, true);
                        applyMax();
                        // 注入后再校验两轮，压住论坛脚本的重置（表格移除后不再补写）
                        [250, 900].forEach(ms => setTimeout(() => {
                            if (document.body.contains(rateForm)) applyMax();
                        }, ms));
                    }
                    // ---- 保存论坛原版 succeedhandle_rate（此时窗口 HTML 已注入，论坛版已定义） ----
                    // pageWin 上的原版函数是共享的，不认标记的话第 N 次点开就套了 N 层包装
                    const prevSucceed = pageWin.succeedhandle_rate;
                    const origSucceed = (typeof prevSucceed === 'function' && prevSucceed.__mbWrapped)
                        ? (prevSucceed.__mbOrig || prevSucceed) : prevSucceed;
                    // ---- 覆盖为我们的版本：成功 toast + 按钮变色 + 调原版关闭窗口 ----
                    pageWin.succeedhandle_rate = function (locationhref, message) {
                        // 判断首次评分还是重复评分（本地缓存已标记 → 重复）
                        const already = !!self.ratedThreads[tid];
                        resolve(true, already ? 'info' : 'success');
                        // 调用论坛原版（刷新楼层 + 关闭评分窗口）
                        if (typeof origSucceed === 'function') {
                            origSucceed.apply(this, arguments);
                        }
                    };
                    pageWin.succeedhandle_rate.__mbWrapped = true;
                    pageWin.succeedhandle_rate.__mbOrig = origSucceed;
                    // ---- 定义 errorhandle_rate（初始 undefined，我们定义后服务器错误返回会调用） ----
                    pageWin.errorhandle_rate = function (msg) {
                        const text = msg || '';
                        // 重复评分：原生弹窗负责提示，脚本只标按钮，不再叠一条 toast
                        if (text.includes('重复评分') || text.includes('不能对同一个帖子')) {
                            markRatedQuiet();
                            return;
                        }
                        Util.toast('评分失败：' + (text || '未知错误'), 2000, 'error');
                    };
                }
            });
            this._rateObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
            // 兜底：2 分钟后断开观察器（防止内存泄漏）
            setTimeout(() => {
                if (self._rateObserver) { self._rateObserver.disconnect(); self._rateObserver = null; }
            }, CONST.RATE_OBSERVE_TIMEOUT_MS);
        },
        //   原实现用 mainImgs/allImgs 做 URL 差集，同一张图既贴在主楼又贴在回复时，
        //   回复里那张会被当成重复而丢掉，画廊里只剩一张。
        //   改成节点级收集后，两次出现各自成项，且 imgRefs 与 srcList 天然一一对应——
        //   顺带解决了原先靠 URL 反查元素在懒加载状态下可能匹配错的问题。
        collectThreadImages() {
            const postListRoot = document.querySelector('#postlist') || document;
            const mainPost = document.querySelector('#post_1') || document.querySelector('#postlist > div[id^=post_]');
            const srcOf = (el) => el.getAttribute('zoomfile') || el.getAttribute('file') || el.getAttribute('src') || null;
            const nodes = Util.extractImageNodes(postListRoot);
            const mainNodes = mainPost ? nodes.filter(el => mainPost.contains(el)) : [];
            const replyNodes = mainPost ? nodes.filter(el => !mainPost.contains(el)) : nodes;
            const ordered = [...mainNodes, ...replyNodes];
            const srcList = [];
            const imgRefs = [];
            ordered.forEach(el => {
                const url = srcOf(el);
                if (!url) return;
                srcList.push(url);
                imgRefs.push(el);
            });
            return { srcList, imgRefs, mainCount: mainNodes.length };
        },
        toggleGallery() {
            if (document.querySelector('.mb-gallery-mask')) {
                Gallery._closeExisting();
                return;
            }
            const { srcList, imgRefs, mainCount } = this.collectThreadImages();
            if (srcList.length === 0) { Util.toast('本帖未识别到图片', 1500, 'kantu'); return; }
            const title = document.title || '帖子图片画廊';
            Gallery.open(srcList, 0, title, imgRefs, mainCount);
        },
        
        // 绑定详情页图片点击事件（事件委托，强行接管看图）
        bindThreadImages() {
            if (!isThreadPage()) return;
            
            // 用事件委托，在document上监听点击事件
            document.addEventListener('click', (e) => {
                const imgEl = e.target.closest('img');
                if (!imgEl) return;
                
                // 检查是不是帖子内容里的图片
                const postListRoot = document.querySelector('#postlist') || document;
                const mainPost = document.querySelector('#post_1') || document.querySelector('#postlist > div[id^=post_]');
                
                // 检查图片是不是在帖子内容里
                if (!postListRoot.contains(imgEl)) return;
                
                // 排除头像、表情等小图标
                if (imgEl.closest('.avatar') || imgEl.closest('.pattl') || imgEl.closest('.paml')) return;
                
                e.preventDefault();
                e.stopPropagation();
                
                // 动态收集所有图片
                const { srcList, imgRefs, mainCount } = this.collectThreadImages();
                if (srcList.length === 0) return;
                
                // 找到当前点击的图片在 srcList 中的索引
                //          按 URL 反查只会命中第一个（点回复里那张会跳回主楼那张）
                let idx = imgRefs.indexOf(imgEl);
                if (idx === -1) idx = srcList.indexOf(imgEl.src);
                if (idx === -1) idx = srcList.indexOf(imgEl.getAttribute('zoomfile'));
                if (idx === -1) idx = srcList.indexOf(imgEl.getAttribute('file'));
                if (idx === -1) idx = 0;
                
                const title = document.title || '帖子图片画廊';
                Gallery.open(srcList, idx, title, imgRefs, mainCount, true, imgEl, true);
            }, true);
        },
        
        initFavoritePageSync() {
            if (!location.href.includes('do=favorite')) return;
            const bindForm = (form) => {
                if (form.dataset.mbBound) return;
                form.dataset.mbBound = '1';
                form.addEventListener('submit', () => {
                    const m = form.id.match(/favoriteform_(\d+)/);
                    if (m) {
                        const favoriteId = m[1];
                        Object.entries(this.favoriteThreads).forEach(([tid, fid]) => {
                            if (Number(favoriteId) === Number(fid)) delete this.favoriteThreads[tid];
                        });
                        this.saveFavoriteThreads();
                    }
                });
            };
            const bindBatch = () => {
                const batchForm = document.querySelector('#delform');
                if (batchForm && !batchForm.dataset.mbBound) {
                    batchForm.dataset.mbBound = '1';
                    batchForm.addEventListener('submit', () => {
                        batchForm.querySelectorAll('li input').forEach(o => {
                            if (o.checked) { const vid = o.getAttribute('vid'); if (vid) delete this.favoriteThreads[vid]; }
                        });
                        this.saveFavoriteThreads();
                    });
                }
            };
            registerDomObserver((mutations) => {
                mutations.forEach(m => {
                    m.addedNodes.forEach(node => {
                        if (!(node instanceof Element)) return;
                        if (node.matches && node.matches('form[id^=favoriteform_]')) bindForm(node);
                        node.querySelectorAll && node.querySelectorAll('form[id^=favoriteform_]').forEach(bindForm);
                    });
                });
                bindBatch();
            });
        }
    };

    // ===================== 默认配置 =====================
    // 默认值统一来自 schema，避免两处维护
    const DEFAULTS = {
        sort: Cfg.def('mengbao.sort.config'),
        kantu: Cfg.def('mengbao.kantu.config'),
        guolv: Cfg.def('mengbao.guolv.config'),
        zqMain: Cfg.def('mengbao.zengqiang.main')
    };

    // ===================== 设置内容构建 =====================
    function buildSettingContent(showConfig, showFavUsers) {
        const kantuCfg = Util.storage.get('mengbao.kantu.config', DEFAULTS.kantu);
        const guolvCfg = Util.userStore.get('mengbao.guolv.config', DEFAULTS.guolv);
        const sortCfg = Util.storage.get('mengbao.sort.config', DEFAULTS.sort);
        const favoriteUsers = Util.userStore.get('mengbao.zengqiang.favorite_users', {});
        const favUserCount = Object.keys(favoriteUsers).length;
        const favGroupCount = (Util.userStore.get('mengbao.zengqiang.favorite_groups', []) || []).length;
        let html = '';
        // 收藏用户已搬进独立的收藏馆弹窗，设置里只留一张入口卡片
        const favoriteSection = showFavUsers ? `
            <div class="mb-setting-section">
                <h4><span class="icon">⭐</span>${Util.escapeHtml(Util.userStore.get('mengbao.panel.nickname', '萌宝'))}收藏</h4>
                <div class="mb-fav-entry-card">
                    <div class="mb-fav-entry-info">
                        <div class="mb-fav-entry-title">收藏馆</div>
                        <div class="mb-fav-entry-sub">${favUserCount} 位用户${favGroupCount ? ' · ' + favGroupCount + ' 个分组' : ''}</div>
                    </div>
                    <button class="btn-open-fav-gallery mb-btn mb-btn-primary">打开</button>
                </div>
            </div>` : '';
        if (showConfig) {
            html += `
            <div class="mb-setting-section">
                <h4 class="mb-setting-h4">
                    <span><span class="icon">⚙️</span>通用设置</span>
                    <span class="mb-setting-h4-right btn-help" title="重新查看新手上手引导卡片（四个球的职责与手势说明）">📖 使用帮助</span>
                </h4>
                <div class="mb-setting-grid">
                    <div class="mb-setting-row">
                        <label title="开启后，浏览过的帖子自动变灰划线（已读标记）">已读帖子标记：</label>
                        <input type="checkbox" class="set-browse-enabled mb-setting-checkbox" ${Util.storage.get('mengbao.browse.enabled', true) ? 'checked' : ''} style="cursor:pointer;" title="开启后，浏览过的帖子自动变灰划线（已读标记）">
                    </div>
                    <div class="mb-setting-row">
                        <label title="开启后自动按发帖时间倒序排列所有板块的帖子">按发帖时间排序：</label>
                        <input type="checkbox" class="set-sort-enabled mb-setting-checkbox" ${sortCfg.enabled ? 'checked' : ''} style="cursor:pointer;" title="开启后自动按发帖时间倒序排列所有板块的帖子">
                    </div>
                    <div class="mb-setting-row">
                        <label title="关闭后已读帖子标题不再加删除线，只保留底色与灰字（更轻）">已读加删除线：</label>
                        <input type="checkbox" class="set-browse-strike mb-setting-checkbox" ${Util.storage.get('mengbao.browse.strike', true) ? 'checked' : ''} style="cursor:pointer;">
                    </div>
                    <div class="mb-setting-row"><label title="已读帖子的整行底色，只对未收藏的帖子生效（收藏行仍是蓝色高亮）">已读标记底色：</label><input type="color" class="set-browse-color mb-input-base" value="${Util.escapeHtml(Util.storage.get('mengbao.browse.color', '#f0f0f0'))}"></div>
                    <div class="mb-setting-row"><label title="自动翻页时的等待间隔（秒），防止请求过快被封">翻页延时（秒）：</label><input type="number" class="set-fanye-delay mb-input-base" value="${Util.storage.get('mengbao.fanye.delaySec', 5)}" min="0" max="10"></div>
                    <div class="mb-setting-row"><label title="右键点击帖子列表、搜索结果、帖子楼层、评论面板里的用户名时，按这里选的方式跳转；选「关闭」则不接管右键，保留浏览器原生菜单">右键点击用户名：</label>
                        <select class="set-jump-target mb-input-base">
                            <option value="home" ${Util.storage.get('mengbao.jump_target','home')==='home'?'selected':''}>个人资料</option>
                            <option value="thread" ${Util.storage.get('mengbao.jump_target','home')==='thread'?'selected':''}>个人主题</option>
                            <option value="reply" ${Util.storage.get('mengbao.jump_target','home')==='reply'?'selected':''}>个人回复</option>
                            <option value="off" ${Util.storage.get('mengbao.jump_target','home')==='off'?'selected':''}>关闭</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="mb-setting-sep"></div>
            <div class="mb-setting-section">
                <h4><span class="icon">🖼️</span>${Util.escapeHtml(Util.userStore.get('mengbao.panel.nickname', '萌宝'))}看图</h4>
                <div class="mb-setting-grid">
                    <div class="mb-setting-row"><label>画廊背景色：</label><input type="color" class="set-kantu-gbg mb-input-base" value="${Util.escapeHtml(kantuCfg.GALLERY_BG_COLOR || '#faf8f5')}"></div>
                    <div class="mb-setting-row"><label>画廊卡片色：</label><input type="color" class="set-kantu-gcell mb-input-base" value="${Util.escapeHtml(kantuCfg.GALLERY_CELL_COLOR || '#f8fafc')}"></div>
                    <div class="mb-setting-row"><label>收藏高亮背景：</label><input type="color" class="set-fav-hl-bg mb-input-base" value="${Util.escapeHtml(Util.storage.get('mengbao.favorite_highlight_bg','#dbeafe'))}"></div>
                    <div class="mb-setting-row"><label>收藏高亮标题：</label><input type="color" class="set-fav-hl-title mb-input-base" value="${Util.escapeHtml(Util.storage.get('mengbao.favorite_highlight_title','#d97706'))}"></div>
                    <div class="mb-setting-row"><label title="每帖预览先摆几张图，多的横向滚动，点「+」进画廊看全部">预览图数量：</label><input type="number" class="set-kantu-preload mb-input-base" value="${Util.storage.get('mengbao.kantu.preload', 3)}" min="1" max="12"></div>
                    <div class="mb-setting-row"><label title="看图面板底部缩略图条的单张高度，过大时会挤占正文可视区">预览图高度：</label><input type="number" class="set-kantu-thumbh mb-input-base" value="${Util.escapeHtml(String(Util.storage.get('mengbao.kantu.thumbH', 200)))}" min="120" max="320"></div>
                </div>
            </div>
            <div class="mb-setting-sep"></div>
            ${favoriteSection}
            ${favoriteSection ? '<div class="mb-setting-sep"></div>' : ''}
        `;
        } else if (showFavUsers) {
            html += favoriteSection;
        }
        return html;
    }

    // ===================== 设置保存 =====================
    function saveSettings(container) {
        const sortBefore = !!(Util.storage.get('mengbao.sort.config', Cfg.def('mengbao.sort.config')) || {}).enabled;
        const sortEnabled = container.querySelector('.set-sort-enabled');
        if (sortEnabled) Util.storage.set('mengbao.sort.config', { enabled: sortEnabled.checked });

        const browseEnabled = container.querySelector('.set-browse-enabled');
        if (browseEnabled) Util.storage.set('mengbao.browse.enabled', browseEnabled.checked);
        const browseColor = container.querySelector('.set-browse-color');
        if (browseColor) Util.storage.set('mengbao.browse.color', Util.isValidColor(browseColor.value.trim()) ? browseColor.value.trim() : '#f0f0f0');
        const browseStrike = container.querySelector('.set-browse-strike');
        if (browseStrike) Util.storage.set('mengbao.browse.strike', browseStrike.checked);

        const oldKantu = Util.storage.get('mengbao.kantu.config', DEFAULTS.kantu);
        const kantuNew = {};
        const gbg = container.querySelector('.set-kantu-gbg');
        if (gbg) kantuNew.GALLERY_BG_COLOR = Util.isValidColor(gbg.value.trim()) ? gbg.value.trim() : DEFAULTS.kantu.GALLERY_BG_COLOR;
        const gcell = container.querySelector('.set-kantu-gcell');
        if (gcell) kantuNew.GALLERY_CELL_COLOR = Util.isValidColor(gcell.value.trim()) ? gcell.value.trim() : DEFAULTS.kantu.GALLERY_CELL_COLOR;
        if (Object.keys(kantuNew).length > 0) { Util.storage.set('mengbao.kantu.config', Object.assign({}, oldKantu, kantuNew)); }

        const fanyeDelay = container.querySelector('.set-fanye-delay');
        if (fanyeDelay) Util.storage.set('mengbao.fanye.delaySec', Util.clampNum(fanyeDelay.value, 0, 10, 5));
        const jumpTarget = container.querySelector('.set-jump-target');
        if (jumpTarget) Util.storage.set('mengbao.jump_target', jumpTarget.value);
        const favoriteHlBg = container.querySelector('.set-fav-hl-bg');
        if (favoriteHlBg) Util.storage.set('mengbao.favorite_highlight_bg', favoriteHlBg.value);
        const favoriteHlTitle = container.querySelector('.set-fav-hl-title');
        if (favoriteHlTitle) Util.storage.set('mengbao.favorite_highlight_title', favoriteHlTitle.value);
        const preloadInput = container.querySelector('.set-kantu-preload');
        if (preloadInput) Util.storage.set('mengbao.kantu.preload', Util.clampNum(preloadInput.value, 1, 12, 3));
        const thumbHInput = container.querySelector('.set-kantu-thumbh');
        if (thumbHInput) Util.storage.set('mengbao.kantu.thumbH', Util.clampNum(thumbHInput.value, 120, 320, 200));
        applyRuntimeSettings();
        // 排序靠 URL 参数（filter=author&orderby=dateline）实现，前端改不了现有页面，只能刷新后重走
        const sortChanged = !!sortEnabled && sortEnabled.checked !== sortBefore;
        Util.toast(sortChanged ? '设置已保存，按发帖时间排序会在刷新后生效' : '设置已保存', 2000, 'success');
    }

    // 依赖 CSS 变量 / 行 class 的设置当场应用，不必等刷新
    function applyRuntimeSettings() {
        const d = document.documentElement;
        try {
            const bg = Util.storage.get('mengbao.browse.color', '#f0f0f0');
            const strike = Util.storage.get('mengbao.browse.strike', true);
            d.style.setProperty('--mb-browsed-bg', Util.isValidColor(String(bg)) ? bg : '#f0f0f0');
            d.style.setProperty('--mb-browsed-strike', strike ? 'line-through' : 'none');
            const kantuCfg = Util.storage.get('mengbao.kantu.config', DEFAULTS.kantu) || {};
            const galleryBg = Util.isValidColor(kantuCfg.GALLERY_BG_COLOR) ? kantuCfg.GALLERY_BG_COLOR : DEFAULTS.kantu.GALLERY_BG_COLOR;
            const galleryCell = Util.isValidColor(kantuCfg.GALLERY_CELL_COLOR) ? kantuCfg.GALLERY_CELL_COLOR : DEFAULTS.kantu.GALLERY_CELL_COLOR;
            d.style.setProperty('--mb-gallery-bg', galleryBg);
            d.style.setProperty('--mb-gallery-cell', galleryCell);
            const favBg = Util.storage.get('mengbao.favorite_highlight_bg', '');
            const favTitle = Util.storage.get('mengbao.favorite_highlight_title', '');
            d.style.setProperty('--mb-favorite-highlight-bg', Util.isValidColor(favBg) ? favBg : '#dbeafe');
            d.style.setProperty('--mb-favorite-highlight-title', Util.isValidColor(favTitle) ? favTitle : '#d97706');
        } catch (e) {}
        // 已读标记总开关管的是行上的 .mb-browsed class，不是颜色：关掉要摘掉，重开要补标
        try {
            if (Util.storage.get('mengbao.browse.enabled', true)) BrowseHistory.markList();
            else document.querySelectorAll('.mb-browsed').forEach(el => el.classList.remove('mb-browsed'));
        } catch (e) {}
    }

    // ===================== 收藏用户：取消 / 导出 / 导入 / 分组 =====================
    function bindFavUserRemove(container) {
        const listEl = container.querySelector('.mb-favorite-users-list');
        const tabsEl = container.querySelector('.mb-favorite-tabs');
        let activeGuolv = '全部';
        let dragUid = null;           // 正在拖动的胶囊 uid（拖到上方分组 tab 上即归组）
        let editing = false;          // 勾选删除编辑态
        const selected = new Set();   // 编辑态已选中的 uid

        // 批量把若干用户移入目标分组（「全部」是视图不是容器，不接受落点）
        // 原 assignGroup 只支持单个 uid，这里抽成批量版，拖拽归组与编辑态批量移动共用
        function moveUsersToGroup(uids, targetName) {
            const list = Array.from(uids || []).map(String);
            if (!list.length || targetName === '全部') return 0;
            const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            let moved = 0;
            list.forEach(uid => {
                if (!all[uid]) return;
                all[uid].group = (targetName === '未分组') ? '' : targetName;
                moved++;
            });
            if (!moved) return 0;
            Util.userStore.set('mengbao.zengqiang.favorite_users', all);
            window.dispatchEvent(new CustomEvent('mengbao:favusers-changed'));
            // 「未分组」不是一个分组名，文案按语义说「移出分组」
            Util.toast(targetName === '未分组'
                ? ('已把 ' + moved + ' 位用户移出分组')
                : ('已把 ' + moved + ' 位用户移入「' + targetName + '」'), 1600, 'favorite');
            renderTabs(); renderList();
            return moved;
        }

        // 单个用户归组（拖到分组 tab 上触发）
        function assignGroup(uid, targetName) {
            dragUid = null;
            return moveUsersToGroup([uid], targetName);
        }

        // 编辑态工具条：非编辑态整条隐藏；编辑入口已移到弹窗头部标题行右侧
        const hostEl = listEl ? listEl.parentElement : null;
        if (hostEl) hostEl.classList.add('mb-fav-host');
        // 拖胶囊期间临时关掉分组 tab 自身的 draggable。
        // tab 本身可拖（用于分组排序），而 Chrome 在源与目标都可拖时会把 dropEffect 锁成 none，
        // 表现就是光标显示禁止符号 ⊗、但 tab 高亮（说明 preventDefault 其实已生效）的怪状态。
        const lockTabDraggable = (lock) => {
            if (!tabsEl) return;
            tabsEl.querySelectorAll('.mb-favorite-tab').forEach(t => {
                const n = t.dataset.name;
                t.draggable = !lock && n !== '全部' && n !== '未分组';
            });
        };
        // 兜底——拖胶囊经过收藏馆内空白区不再显示 ⊗；
        // tab 自己已处理的事件不覆盖，保留「全部」tab 明确拒绝的行为
        if (hostEl) {
            hostEl.addEventListener('dragover', (e) => {
                if (!dragUid || e.defaultPrevented) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            hostEl.addEventListener('drop', (e) => { if (dragUid) e.preventDefault(); });
        }
        const barEl = document.createElement('div');
        barEl.className = 'mb-fav-edit-bar';
        barEl.innerHTML = '<button class="mb-btn mb-btn-secondary mb-fav-select-all">全选</button>'
            + '<button class="mb-btn mb-btn-secondary mb-fav-move-selected" disabled>移入分组</button>'
            + '<button class="mb-btn mb-btn-danger mb-fav-del-selected" disabled>删除选中 (0)</button>'
            + '<button class="mb-btn mb-btn-secondary mb-fav-edit-cancel">取消</button>';
        if (hostEl) hostEl.insertBefore(barEl, listEl);
        // 头部「编辑」入口（容器内查找，找不到时保持无入口也不报错）
        const editToggleEl = container.querySelector('.mb-fav-edit-toggle');

        const syncDelBtn = () => {
            const b = barEl.querySelector('.mb-fav-del-selected');
            b.textContent = '删除选中 (' + selected.size + ')';
            b.disabled = selected.size === 0;
            const mv = barEl.querySelector('.mb-fav-move-selected');
            if (mv) mv.disabled = selected.size === 0;
        };
        const visibleUids = () => Array.from(listEl ? listEl.querySelectorAll('.mb-user-tag') : []).map(t => String(t.dataset.uid));
        const toggleSelected = (uid, on) => {
            if (on) selected.add(uid); else selected.delete(uid);
            const tag = listEl && listEl.querySelector('.mb-user-tag[data-uid="' + uid + '"]');
            if (tag) tag.classList.toggle('mb-tag-selected', !!on);
            syncDelBtn();
        };
        const setEditing = (on) => {
            editing = !!on;
            selected.clear();
            if (hostEl) hostEl.classList.toggle('mb-editing', editing);
            if (editToggleEl) editToggleEl.style.display = editing ? 'none' : '';
            renderList();
            syncDelBtn();
        };
        if (editToggleEl) editToggleEl.onclick = () => setEditing(true);
        barEl.querySelector('.mb-fav-edit-cancel').onclick = () => setEditing(false);
        // 编辑态直接指定分组，免去逐个拖拽
        barEl.querySelector('.mb-fav-move-selected').onclick = () => {
            if (!selected.size) return;
            const targets = ['未分组', ...getGroups()];
            const picker = openModal({
                width: 'sm',
                body: `
                    <div class="mb-dialog-title">移入分组</div>
                    <div class="mb-dialog-sub">已选中 ${selected.size} 位用户，点选目标分组：</div>
                    <div class="mb-fav-group-picker">${targets.map(g => `<button class="mb-btn mb-btn-secondary mb-fav-pick-group" data-g="${Util.escapeHtml(g)}">${Util.escapeHtml(g)}</button>`).join('')}</div>
                    <div class="mb-dialog-actions">
                        <button class="mb-btn mb-btn-secondary mb-fav-pick-cancel">取消</button>
                    </div>`
            });
            picker.query('.mb-fav-pick-cancel').onclick = () => picker.close();
            picker.box.querySelectorAll('.mb-fav-pick-group').forEach(btn => {
                btn.onclick = () => {
                    const target = btn.dataset.g;
                    picker.close();
                    moveUsersToGroup(selected, target);
                    setEditing(false);   // 移组后退出编辑态：当前 tab 可能已筛掉这批人，保留选中会与实际视图不一致
                };
            });
        };
        barEl.querySelector('.mb-fav-select-all').onclick = () => {
            const vis = visibleUids();
            const allSel = vis.length && vis.every(u => selected.has(u));
            vis.forEach(u => { if (allSel) selected.delete(u); else selected.add(u); });
            renderList(); syncDelBtn();
        };
        barEl.querySelector('.mb-fav-del-selected').onclick = () => {
            if (!selected.size) return;
            const n = selected.size;
            const confirmModal = openModal({
                width: 'sm',
                body: `
                    <div class="mb-dialog-title">删除选中用户</div>
                    <p style="margin:12px 0;color:var(--mb-text-muted);font-size:var(--mb-font-md);">确定取消收藏这 ${n} 位用户？此操作无法撤销。</p>
                    <div class="mb-dialog-actions">
                        <button class="mb-btn-cancel mb-btn mb-btn-secondary">取消</button>
                        <button class="mb-btn-ok mb-btn mb-btn-danger">删除</button>
                    </div>`
            });
            confirmModal.query('.mb-btn-cancel').onclick = () => confirmModal.close();
            confirmModal.query('.mb-btn-ok').onclick = () => {
                const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
                selected.forEach(uid => { delete all[uid]; });
                Util.userStore.set('mengbao.zengqiang.favorite_users', all);
                window.dispatchEvent(new CustomEvent('mengbao:favusers-changed'));
                Util.toast('已取消收藏 ' + n + ' 位用户', 2000, 'favorite');
                confirmModal.close();
                setEditing(false);
                renderTabs();
            };
        };

        const getGroups = () => Util.userStore.get('mengbao.zengqiang.favorite_groups', []) || [];
        const setGroups = (g) => Util.userStore.set('mengbao.zengqiang.favorite_groups', g);

        // 渲染 tab 栏：全部 / 未分组 / 每个分组
        function renderTabs() {
            if (!tabsEl) return;
            // tab 行改单行横向滚动后，重绘要保持原滚动位置，否则选中靠右分组会跳回开头
            const keepScroll = tabsEl.scrollLeft;
            const groups = getGroups();
            const favoriteUsers = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            const allKeys = Object.keys(favoriteUsers);
            const counts = { '全部': allKeys.length, '未分组': allKeys.filter(k => !favoriteUsers[k].group).length };
            groups.forEach(g => { counts[g] = allKeys.filter(k => favoriteUsers[k].group === g).length; });
            const tabs = ['全部', '未分组', ...groups];
            tabsEl.innerHTML = tabs.map(t => {
                const draggable = (t !== '全部' && t !== '未分组') ? 'draggable="true"' : '';
                const tip = t === '全部' ? '显示全部收藏用户' : (t === '未分组' ? '把胶囊拖到这里可移出分组' : '把胶囊拖到这里可归入该组；右键重命名或删除');
                return `<span class="mb-favorite-tab ${t === activeGuolv ? 'active' : ''}" data-guolv="${Util.escapeHtml(t)}" data-name="${Util.escapeHtml(t)}" title="${tip}" ${draggable}><i>${counts[t] || 0}</i>${Util.escapeHtml(t)}</span>`;
            }).join('');
            tabsEl.scrollLeft = keepScroll;

            let dragTab = null;
            tabsEl.querySelectorAll('.mb-favorite-tab').forEach(tab => {
                tab.onclick = () => { activeGuolv = tab.dataset.guolv; renderTabs(); renderList(); };
                const tabName = tab.dataset.name;
                // 分组自身排序（仅自定义分组可拖）
                if (tabName !== '全部' && tabName !== '未分组') {
                    tab.draggable = true;
                    tab.ondragstart = (e) => {
                        if (dragUid) return;            // 胶囊拖动时不抢
                        dragTab = tab;
                        e.dataTransfer.effectAllowed = 'move';
                        tab.style.opacity = '0.5';
                    };
                    tab.ondragend = () => {
                        dragTab = null;
                        tab.style.opacity = '';
                    };
                }
                // 所有分组都能接胶囊（「全部」是视图不是容器，不接受）
                tab.ondragover = (e) => {
                    if (dragUid) {
                        e.preventDefault();
                        if (tabName === '全部') { e.dataTransfer.dropEffect = 'none'; return; }
                        e.dataTransfer.dropEffect = 'move';
                        tab.classList.add('mb-tab-drop');
                        return;
                    }
                    if (!dragTab) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                };
                tab.ondragleave = () => tab.classList.remove('mb-tab-drop');
                tab.ondrop = (e) => {
                    e.preventDefault();
                    tab.classList.remove('mb-tab-drop');
                    // 胶囊拖进来 → 归入该组
                    if (dragUid) { assignGroup(dragUid, tabName); return; }
                    // 分组拖分组 → 排序
                    if (!dragTab || dragTab === tab) return;
                    const fromName = dragTab.dataset.name;
                    const toName = tabName;
                    let g = getGroups();
                    const fromIdx = g.indexOf(fromName);
                    const toIdx = g.indexOf(toName);
                    if (fromIdx === -1 || toIdx === -1) return;
                    g.splice(fromIdx, 1);
                    g.splice(fromIdx < toIdx ? toIdx - 1 : toIdx, 0, fromName);
                    setGroups(g);
                    renderTabs();
                };
                // 右键弹分组操作弹窗（仅自定义分组可重命名/删除；全部/未分组禁用）
                tab.oncontextmenu = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const name = tab.dataset.name;
                    if (name === '全部' || name === '未分组') { Util.toast('内置分组不可重命名或删除'); return; }
                    const modal = openModal({
                        width: 'sm',
                        closeOnMaskClick: false,
                        body: `
                        <div class="mb-dialog-title">重命名分组</div>
                        <input type="text" class="mb-prompt-input mb-modal-textarea mb-input-base" value="${Util.escapeHtml(name)}">
                        <div class="mb-dialog-actions">
                            <button class="mb-btn-cancel mb-btn mb-btn-secondary">取消</button>
                            <button class="mb-btn-delete mb-btn mb-btn-danger">删除此分组</button>
                            <button class="mb-btn-ok mb-btn mb-btn-primary">确定</button>
                        </div>`
                    });
                    const input = modal.query('.mb-prompt-input');
                    input.focus(); input.select();
                    modal.query('.mb-btn-cancel').onclick = () => modal.close();
                    modal.query('.mb-btn-ok').onclick = () => {
                        const newName = input.value.trim();
                        if (!newName || newName === name) { modal.close(); return; }
                        const g = getGroups();
                        if (g.includes(newName)) { Util.toast('分组名已存在'); return; }
                        setGroups(g.map(x => x === name ? newName : x));
                        const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {});
                        Object.keys(all).forEach(uid => { if (all[uid].group === name) all[uid].group = newName; });
                        Util.userStore.set('mengbao.zengqiang.favorite_users', all);
                        activeGuolv = newName;
                        modal.close();
                        renderTabs(); renderList();
                    };
                    modal.query('.mb-btn-delete').onclick = () => {
                        const confirmModal = openModal({
                            width: 'sm',
                            body: `
                            <div class="mb-dialog-title">删除分组</div>
                            <p style="margin:12px 0;color:var(--mb-text-muted);font-size:var(--mb-font-md);">删除分组「${Util.escapeHtml(name)}」？组内用户将移到未分组</p>
                            <div class="mb-dialog-actions">
                                <button class="mb-btn-ok mb-btn mb-btn-danger">删除</button>
                            </div>`
                        });
                        confirmModal.query('.mb-btn-ok').onclick = () => {
                            setGroups(getGroups().filter(x => x !== name));
                            const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {});
                            Object.keys(all).forEach(uid => { if (all[uid].group === name) all[uid].group = ''; });
                            Util.userStore.set('mengbao.zengqiang.favorite_users', all);
                            activeGuolv = '全部';
                            confirmModal.close();
                            modal.close();
                            renderTabs(); renderList();
                        };
                    };
                    input.addEventListener('keydown', e => { if (e.key === 'Enter') modal.query('.mb-btn-ok').click(); });
                };
            });
        }

        // 渲染标签列表（按当前 guolv）
        function renderList() {
            if (!listEl) return;
            const favoriteUsers = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            const favOrder = Util.favUserOrder.get(favoriteUsers);
            const entries = Object.entries(favoriteUsers).filter(([uid, info]) => {
                if (activeGuolv === '全部') return true;
                if (activeGuolv === '未分组') return !info.group;
                return info.group === activeGuolv;
            }).sort((a, b) => {
                const ia = favOrder.indexOf(String(a[0]));
                const ib = favOrder.indexOf(String(b[0]));
                if (ia === -1 && ib === -1) return 0;
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
            listEl.classList.remove('mb-dragging');
            if (entries.length === 0) {
                listEl.innerHTML = '<div class="mb-favorite-users-empty" style="text-align:center;color:var(--mb-text-hint);font-size:var(--mb-font-sm);line-height:1.8;padding:20px 0;">点击帖子楼层的 ☆ 星星收藏用户</div>';
                return;
            }
            listEl.innerHTML = entries.map(([uid, info]) => {
                const u = Util.escapeHtml(uid);
                const on = selected.has(String(uid));
                const tip = editing ? '点击勾选要删除的用户' : '拖到上方分组可归入该组；右键点击用户名跳转';
                return `<span class="mb-user-tag${on ? ' mb-tag-selected' : ''}" draggable="${editing ? 'false' : 'true'}" data-uid="${u}" data-home="home.php?mod=space&uid=${u}" title="${tip}">`
                    + `<input type="checkbox" class="mb-tag-check" data-uid="${u}"${on ? ' checked' : ''}>`
                    + `<span class="mb-tag-name">${Util.escapeHtml(info.username || uid)}</span>`
                    + `</span>`;
            }).join('');

            // 胶囊交互：拖拽排序 / 拖到上方分组 tab 归组 / 编辑态勾选
            listEl.querySelectorAll('.mb-user-tag').forEach(tag => {
                const uid = String(tag.dataset.uid);
                if (editing) {
                    const cb = tag.querySelector('.mb-tag-check');
                    tag.onclick = (e) => {
                        if (e.target === cb) return;
                        cb.checked = !cb.checked;
                        toggleSelected(uid, cb.checked);
                    };
                    cb.onclick = (e) => { e.stopPropagation(); toggleSelected(uid, cb.checked); };
                    return;
                }
                tag.ondragstart = (e) => {
                    dragUid = uid;
                    // effectAllowed 放宽到 all，避免与目标 dropEffect 的组合被浏览器判为不可放置
                    e.dataTransfer.effectAllowed = 'all';
                    lockTabDraggable(true);
                    // 原为 text/plain + 'uid:xxx'，松手在未接收区域时浏览器会把它当纯文本新开窗口搜索；
                    // 改自定义类型后浏览器不再按文本/URL 处理，只在本脚本的 drop 处理器里读 uid
                    try { e.dataTransfer.setData('application/x-mb-uid', uid); } catch (err) {}
                    tag.style.opacity = '0.5';
                    listEl.classList.add('mb-dragging');
                };
                tag.ondragend = () => {
                    dragUid = null;
                    lockTabDraggable(false);
                    tag.style.opacity = '';
                    listEl.classList.remove('mb-dragging');
                };
                tag.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
                tag.ondrop = (e) => {
                    e.preventDefault();
                    // 拖到另一个胶囊 = 排序；要换分组请拖到上方分组 tab
                    if (!dragUid || dragUid === uid) return;
                    const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
                    const order = Util.favUserOrder.get(all);
                    const fromIdx = order.indexOf(dragUid);
                    const toIdx = order.indexOf(uid);
                    if (fromIdx === -1 || toIdx === -1) return;
                    order.splice(fromIdx, 1);
                    order.splice(fromIdx < toIdx ? toIdx - 1 : toIdx, 0, dragUid);
                    Util.favUserOrder.save(order);
                    dragUid = null;
                    listEl.classList.remove('mb-dragging');
                    renderList();
                };
                bindUserJumpMenu(tag, uid);
            });
        }

        renderTabs(); renderList();

        // 左下「＋ 新建分组」
        const newGroupBtn = container.querySelector('.btn-new-group');
        if (newGroupBtn) {
            newGroupBtn.onclick = () => {
                openPromptDialog({
                    title: '新分组名',
                    placeholder: '输入分组名',
                    onOk: (name) => {
                        if (!name) return;
                        const g = getGroups();
                        if (g.includes(name)) { Util.toast('分组名已存在'); return; }
                        g.push(name); setGroups(g);
                        activeGuolv = name;
                        renderTabs(); renderList();
                    }
                });
            };
        }

        // 导出收藏用户
        const exportBtn = container.querySelector('.btn-export-users');
        if (exportBtn) {
            exportBtn.onclick = () => {
                const all = Util.userStore.get('mengbao.zengqiang.favorite_users', {});
                const groups = getGroups();
                const payload = { users: all, groups: groups };
                const text = JSON.stringify(payload, null, 2);
                const modal = openModal({
                    width: 'sm',
                    body: `
                    <div class="mb-dialog-title">导出收藏用户</div>
                    <div class="mb-dialog-sub">复制以下内容备份你的收藏用户（含分组）：</div>
                    <textarea class="mb-modal-textarea mb-dialog-textarea h-180 mb-input-base" readonly>${Util.escapeTextarea(text)}</textarea>
                    <div class="mb-dialog-actions">
                        <button class="mb-btn-copy mb-btn mb-btn-primary">复制</button>
                    </div>`
                });
                modal.query('.mb-btn-copy').onclick = async () => {
                    const ok = await Util.copyText(text);
                    Util.toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择复制', 2000, ok ? 'success' : 'error');
                    if (ok) modal.close();
                };
            };
        }
        // 导入收藏用户
        const importBtn = container.querySelector('.btn-import-users');
        if (importBtn) {
            importBtn.onclick = () => {
                const modal = openModal({
                    width: 'sm',
                    closeOnMaskClick: false,
                    body: `
                    <div class="mb-dialog-title">导入收藏用户</div>
                    <div class="mb-dialog-sub">粘贴 JSON 格式的收藏用户数据（含分组）：</div>
                    <textarea class="mb-import-text mb-modal-textarea mb-dialog-textarea h-180 mb-input-base"></textarea>
                    <div class="mb-dialog-actions">
                        <button class="mb-btn-cancel mb-btn mb-btn-secondary">取消</button>
                        <button class="mb-btn-ok mb-btn mb-btn-primary">导入</button>
                    </div>`
                });
                modal.query('.mb-btn-cancel').onclick = () => modal.close();
                modal.query('.mb-btn-ok').onclick = () => {
                    const text = modal.query('.mb-import-text').value.trim();
                    if (!text) { Util.toast('请粘贴JSON格式的配置内容'); return; }
                    try {
                        const data = JSON.parse(text);
                        // 兼容两种格式：新格式 {users:{}, groups:[]}，旧格式纯 users 对象
                        let incomingUsers, incomingGroups;
                        if (data && typeof data === 'object' && !Array.isArray(data) && data.users) {
                            incomingUsers = data.users; incomingGroups = data.groups || [];
                        } else {
                            incomingUsers = data; incomingGroups = [];
                        }
                        if (!incomingUsers || typeof incomingUsers !== 'object' || Array.isArray(incomingUsers)) {
                            Util.toast('导入失败：JSON格式不正确', 2000, 'error'); return;
                        }
                        const old = Util.userStore.get('mengbao.zengqiang.favorite_users', {});
                        const merged = Object.assign({}, old);
                        let added = 0, existed = 0, skipped = 0;
                        Object.keys(incomingUsers).forEach(uid => {
                            const v = incomingUsers[uid];
                            if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.username === 'string' && typeof v.favorited === 'boolean') {
                                if (old[uid]) existed++; else added++;
                                merged[uid] = v;
                            } else { skipped++; }
                        });
                        Util.userStore.set('mengbao.zengqiang.favorite_users', merged);
                        window.dispatchEvent(new CustomEvent('mengbao:favusers-changed'));
                        // 合并分组名
                        if (Array.isArray(incomingGroups) && incomingGroups.length) {
                            const g = getGroups();
                            incomingGroups.forEach(gn => { if (!g.includes(gn)) g.push(gn); });
                            setGroups(g);
                        }
                        modal.close();
                        let msg = '新增 ' + added + ' 条';
                        if (existed) msg += '，已存在 ' + existed + ' 条跳过';
                        if (skipped) msg += '，非法 ' + skipped + ' 条';
                        Util.toast(msg + '，刷新后生效', 2000, 'success');
                        renderTabs(); renderList();
                    } catch (e) {
                        Util.toast('导入失败：JSON格式不正确', 2000, 'error');
                    }
                };
            };
        }
    }

    // ===================== 收藏馆弹窗 =====================
    function openFavGallery() {
        const users = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
        const groups = Util.userStore.get('mengbao.zengqiang.favorite_groups', []) || [];
        const userCount = Object.keys(users).length;
        // 头像合一后收藏馆弹窗直接复用 comment.* 这一套
        const favRaw = Util.userStore.get('mengbao.comment.avatar', '') || '';
        const favAvatarSrc = /^builtin:[12]$/.test(favRaw) ? '' : favRaw;
        const modal = openModal({
            width: 'md',
            extraClass: 'mb-fav-gallery-modal',
            body: `
            <div class="mb-fav-gallery-head">
                ${favAvatarSrc ? `<img class="mb-fav-gallery-avatar" src="${favAvatarSrc}" alt="">` : `<div class="mb-fav-gallery-avatar mb-fav-gallery-avatar--empty">❤</div>`}
                <div class="mb-fav-gallery-head-text">
                <div class="mb-fav-title-row">
                    <div class="mb-dialog-title">⭐ 收藏馆</div>
                    <div class="mb-fav-title-actions">
                        <button class="mb-btn mb-btn-secondary mb-fav-gallery-edit mb-fav-edit-toggle" title="批量取消收藏或移入分组">✏️ 编辑</button>
                        <button class="btn-fav-gallery-close mb-fav-gallery-x" title="关闭">×</button>
                    </div>
                </div>
                <div class="mb-dialog-sub">${userCount} 位用户${groups.length ? ' · ' + groups.length + ' 个分组' : ''}　拖到上方分组可归组，拖动胶囊可排序；点「编辑」可批量取消收藏或移入分组；右键进入用户主页</div>
            </div></div>
            <div class="mb-favorite-tabs mb-fav-gallery-tabs"></div>
            <div class="mb-favorite-users-list mb-fav-gallery-list"></div>
            <div class="mb-favorite-users-actions">
                <button class="btn-new-group mb-btn mb-btn-secondary" title="新建一个收藏用户分组">📁 新建分组</button>
                <button class="btn-export-users mb-btn mb-btn-secondary">导出</button>
                <button class="btn-import-users mb-btn mb-btn-secondary">导入</button>
            </div>
`
        });
        // 与设置面板共用同一份渲染/拖拽/导入导出逻辑，不另写一套
        bindFavUserRemove(modal.box);
        modal.query('.btn-fav-gallery-close').onclick = () => modal.close();
        return modal;
    }

    // ===================== 全量配置导出 / 导入 =====================
    // 备份集合由 schema 的 backup 标记生成，不再维护硬编码键列表
    const collectBackupKeys = () => Cfg.backupKeys();
    function bindFullBackup(container) {
        const exportBtn = container.querySelector('.btn-export-all');
        if (exportBtn) {
            exportBtn.onclick = () => {
                const payload = {};
                collectBackupKeys().forEach(k => { payload[k] = Util.storage.get(k, null); });
                const ver = (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : 'unknown';
                const text = JSON.stringify({ version: ver, exportedAt: Date.now(), data: payload }, null, 2);
                const modal = openModal({
                    width: 'sm',
                    body: `
                    <div class="mb-dialog-title">导出全量配置</div>
                    <div class="mb-dialog-sub">包含参数、收藏、评分、收藏用户与站点白名单（不含悬浮球位置与看图临时缓存）：</div>
                    <textarea class="mb-modal-textarea mb-dialog-textarea h-180 mb-input-base" readonly>${Util.escapeTextarea(text)}</textarea>
                    <div class="mb-dialog-actions">
                        <button class="mb-btn-copy mb-btn mb-btn-primary">复制</button>
                    </div>`
                });
                modal.query('.mb-btn-copy').onclick = async () => {
                    const ok = await Util.copyText(text);
                    Util.toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择复制', 2000, ok ? 'success' : 'error');
                    if (ok) modal.close();
                };
            };
        }
        const importBtn = container.querySelector('.btn-import-all');
        if (importBtn) {
            importBtn.onclick = () => {
                const modal = openModal({
                    width: 'sm',
                    closeOnMaskClick: false,
                    body: `
                    <div class="mb-dialog-title">导入全量配置</div>
                    <div class="mb-dialog-sub">粘贴之前导出的全量配置 JSON，将与当前配置合并覆盖（非法键自动跳过）：</div>
                    <textarea class="mb-import-all-text mb-modal-textarea mb-dialog-textarea h-180 mb-input-base"></textarea>
                    <div class="mb-dialog-actions">
                        <button class="mb-btn-cancel mb-btn mb-btn-secondary">取消</button>
                        <button class="mb-btn-ok mb-btn mb-btn-primary">导入</button>
                    </div>`
                });
                modal.query('.mb-btn-cancel').onclick = () => modal.close();
                modal.query('.mb-btn-ok').onclick = () => {
                    const text = modal.query('.mb-import-all-text').value.trim();
                    if (!text) { Util.toast('请粘贴JSON格式的配置内容'); return; }
                    try {
                        const parsed = JSON.parse(text);
                        const data = parsed && parsed.data ? parsed.data : parsed;
                        if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('格式不正确');
                        const allow = new Set(collectBackupKeys());
                        const backup = {};
                        allow.forEach(k => { backup[k] = Util.storage.get(k, null); });
                        // 只接受 schema 登记且校验通过的备份键，未知键一律拒绝
                        let applied = 0; const skipped = [];
                        Object.keys(data).forEach(k => {
                            if (!allow.has(k)) { skipped.push(k); return; }
                            if (data[k] === undefined) return;
                            if (!Cfg.validate(k, data[k])) { skipped.push(k); return; }
                            if (USER_STORE_KEYS.includes(k) && Util.userStore.isOldStyle(k, data[k])) {
                                Util.userStore.setFor(k, Util.userStore.curBucket(), data[k]);
                            } else {
                                Util.storage.set(k, data[k]);
                            }
                            applied++;
                        });
                        if (skipped.length) {
                            // 回滚：原本为空的键删除，其余恢复备份值，彻底回到导入前状态
                            Object.keys(backup).forEach(k => {
                                if (backup[k] === null) Util.storage.remove(k);
                                else Util.storage.set(k, backup[k]);
                            });
                            modal.close();
                            Util.toast('检测到不支持的配置项，已跳过：' + skipped.map(k => k.replace('mengbao.', '')).join(', '), 2000, 'error');
                            return;
                        }
                        modal.close();
                        Util.toast('导入成功 ' + applied + ' 项，刷新后生效', 2000, 'success');
                    } catch (e) {
                        Util.toast('导入失败：' + e.message, 2000, 'error');
                    }
                };
            };
        }
    }

    const AVATAR_MAX_SLOTS = 9;
    const AVATAR_USER_SLOTS = AVATAR_MAX_SLOTS;

    // 兼容两种格式：旧「紧凑数组」（无空位）与新「固定 9 槽」（含 null）。
    // 旧格式按老规则压到 9 个并备份超出部分，再补成 9 槽，位置不变。
    function getUserAvatars() {
        const arr = Util.userStore.get('mengbao.avatars.user', []);
        if (!Array.isArray(arr)) return new Array(AVATAR_USER_SLOTS).fill(null);
        const sparse = arr.some(a => !a);
        let list = arr;
        if (!sparse && arr.length > AVATAR_USER_SLOTS) {
            Util.storage.set('mengbao.avatars.backup.v132', arr);
            list = arr.slice(0, AVATAR_USER_SLOTS);
            if (typeof mbToast === 'function') {
                mbToast('头像槽位已缩到 ' + AVATAR_USER_SLOTS + ' 个，多出的 ' + (arr.length - AVATAR_USER_SLOTS) + ' 个已备份', 3200, 'success');
            }
        }
        const out = new Array(AVATAR_USER_SLOTS).fill(null);
        for (let i = 0; i < Math.min(list.length, AVATAR_USER_SLOTS); i++) {
            const a = list[i];
            if (a && typeof a === 'object' && typeof a.data === 'string') out[i] = a;
        }
        return out;
    }
    function setUserAvatars(arr) {
        const out = new Array(AVATAR_USER_SLOTS).fill(null);
        for (let i = 0; i < AVATAR_USER_SLOTS; i++) {
            const a = arr[i];
            if (a && typeof a === 'object' && typeof a.data === 'string') out[i] = a;
        }
        Util.userStore.set('mengbao.avatars.user', out);
    }

    function compressAvatar(dataUrl, maxSize) {
        return new Promise((resolve, reject) => {
            // 同时检测 MIME 类型和 base64 内容开头（抓取的头像可能 MIME 是 jpeg 但内容是 gif）
            const isGif = dataUrl.startsWith('data:image/gif') || dataUrl.includes('base64,R0lGOD');
            if (isGif) {
                resolve(dataUrl);
                return;
            }
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const w = img.width, h = img.height;
                const ratio = Math.min(1, maxSize / Math.max(w, h));
                canvas.width = Math.round(w * ratio);
                canvas.height = Math.round(h * ratio);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    function openAvatarDialog() {
        const userAvatars = getUserAvatars();
        let commentChoice = Util.userStore.get('mengbao.comment.avatarChoice', '');
        let commentCustom = Util.userStore.get('mengbao.comment.avatar', '');
        const cmtfavChoice = Util.userStore.get('mengbao.cmtfav.avatarChoice', '');
        const cmtfavCustom = Util.userStore.get('mengbao.cmtfav.avatar', '');
        // 两套头像合并成一套：旧「收藏馆头像」只在 comment 为空时回填一次，之后只认 comment.*
        if (!commentChoice && !commentCustom && (cmtfavChoice || cmtfavCustom)) {
            commentChoice = cmtfavChoice || (cmtfavCustom ? 'custom' : '');
            commentCustom = cmtfavCustom || '';
            Util.userStore.set('mengbao.comment.avatarChoice', commentChoice);
            Util.userStore.set('mengbao.comment.avatar', commentCustom);
        }
        const nickname = Util.userStore.get('mengbao.panel.nickname', '萌宝');

        let pendingUserAvatars = userAvatars.slice();
        let dragFrom = null;          // 正在拖的槽位索引
        // 拖拽兜底：拖到弹窗外面（页面空白、标签栏）时，浏览器会把 <img> 自带的图片 URL 当链接打开新窗口。
        // 这里在 document 捕获阶段拦掉，只在拖头像期间生效，不影响收藏用户胶囊的拖拽。
        if (!window.__mbAvatarDragGuardBound) {
            window.__mbAvatarDragGuardBound = true;
            document.addEventListener('dragover', (e) => { if (window.__mbAvatarDragActive) e.preventDefault(); }, true);
            // 只 preventDefault 阻止浏览器「打开图片」，不能 stopPropagation —— 捕获阶段掐断会让收藏胶囊的 drop 也收不到
            document.addEventListener('drop', (e) => { if (window.__mbAvatarDragActive) e.preventDefault(); }, true);
            // 拖到浏览器外释放时 dragend 可能不来，用 dragend + 超时双保险把标志清掉
            document.addEventListener('dragend', () => { window.__mbAvatarDragActive = false; }, true);
        }
        let suppressClick = false;    // 拖拽刚结束时忽略一次 click
        let pendingTargetIdx = -1;    // 点开空槽时记下的目标槽，上传/抓取后落到这里
        // 把已存自定义头像映射到对应 user 槽；找不到匹配槽则不高亮。评论区/收藏馆分别解析当前选中
        function resolveSlot(choice, custom, panel) {
            if (custom && !/^builtin:[12]$/.test(custom)) {
                const i = pendingUserAvatars.findIndex(a => a && a.data === custom);
                return i >= 0 ? 'user:' + i : '';
            }
            return '';
        }
        let selectedSlot = resolveSlot(commentChoice, commentCustom, 'comment');

        function buildSlots() {
            const slots = [];
            for (let i = 0; i < AVATAR_MAX_SLOTS; i++) {
                const a = pendingUserAvatars[i];
                if (a) {
                    slots.push({ id: 'user:' + i, type: 'user', idx: i, src: a.data, label: a.label || ('我的头像 ' + (i + 1)) });
                } else {
                    slots.push({ id: 'empty:' + i, empty: true, idx: i });
                }
            }
            return slots;
        }
        // 拖拽落位：落到空槽＝移过去，落到已占用格＝两者交换
        function dropAvatarTo(targetIdx, container) {
            if (dragFrom === null || targetIdx === null || dragFrom === targetIdx) { dragFrom = null; return; }
            const moved = pendingUserAvatars[dragFrom] || null;
            const target = pendingUserAvatars[targetIdx] || null;
            pendingUserAvatars[dragFrom] = target;
            pendingUserAvatars[targetIdx] = moved;
            if (selectedSlot.startsWith('user:')) {
                const si = parseInt(selectedSlot.split(':')[1]);
                const selData = (pendingUserAvatars[si] && pendingUserAvatars[si].data) || null;
                if (selData) {
                    const ni = pendingUserAvatars.findIndex(a => a && a.data === selData);
                    selectedSlot = ni >= 0 ? 'user:' + ni : '';
                } else {
                    selectedSlot = '';
                }
            }
            dragFrom = null;
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 250);
            renderSlots(container);
        }

        function renderSlots(container) {
            container.innerHTML = '';
            const slots = buildSlots();
            slots.forEach(slot => {
                const cell = document.createElement('div');
                cell.className = 'mb-avatar-cell' + (slot.id === selectedSlot ? ' active' : '') + (slot.empty ? ' empty' : '');
                if (slot.empty) {
                    cell.innerHTML = '<div class="mb-avatar-cell-plus">+</div>';
                } else {
                    // 同上：头像地址改属性赋值，标签文字用 textContent，全程不拼 HTML 字符串
                    const slotImg = document.createElement('img');
                    slotImg.src = slot.src;
                    slotImg.alt = '';
                    cell.appendChild(slotImg);
                    // 拖动换位：拖到空槽移过去，拖到已占用格交换
                    slotImg.draggable = true;
                    slotImg.ondragstart = (e) => {
                        dragFrom = slot.idx;
                        window.__mbAvatarDragActive = true;
                        try {
                            // 拖 <img> 时浏览器会自动塞 text/uri-list 与 text/html（内容是图片地址）。
                            // 只要 drop 落在没人 preventDefault 的地方，它就按「拖入图片」直接新开窗口。
                            // 先清空，只留自定义类型，浏览器就不再把它当链接/文件处理。
                            e.dataTransfer.clearData();
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('application/x-mb-avatar-index', String(slot.idx));
                        } catch (_) {}
                        // 拖出浏览器窗口再松开时 dragend 不一定触发，兜底 5 秒清标志
                        setTimeout(() => { window.__mbAvatarDragActive = false; }, 5000);
                        cell.classList.add('mb-avatar-cell--dragging');
                    };
                    slotImg.ondragend = () => { cell.classList.remove('mb-avatar-cell--dragging'); dragFrom = null; window.__mbAvatarDragActive = false; };
                    const slotLabel = document.createElement('div');
                    slotLabel.className = 'mb-avatar-cell-label';
                    slotLabel.title = '双击修改头像名称';
                    slotLabel.textContent = slot.label || '';
                    cell.appendChild(slotLabel);
                    const x = document.createElement('span');
                    x.className = 'mb-avatar-cell-x';
                    x.innerHTML = mbIconSvg('x', 12);
                    x.onclick = (e) => {
                        e.stopPropagation();
                        // 只把该槽置空，其他头像的位置保持不动
                        const wasSelected = selectedSlot === slot.id;
                        pendingUserAvatars[slot.idx] = null;
                        if (wasSelected) selectedSlot = '';
                        renderSlots(container);
                    };
                    cell.appendChild(x);
                    // 双击标签改名（内置默认头像不可改名）
                    if (slot.type !== 'builtin') {
                        const labelEl = cell.querySelector('.mb-avatar-cell-label');
                        labelEl.ondblclick = (e) => {
                            e.stopPropagation();
                            openPromptDialog({
                                title: '修改标签名称',
                                defaultValue: slot.label || '',
                                onOk: (t) => {
                                    t = (t || '').trim();
                                    pendingUserAvatars[slot.idx].label = t || ('我的头像 ' + (slot.idx + 1));
                                    renderSlots(container);
                                }
                            });
                        };
                    }
                }
                cell.onclick = () => {
                    if (suppressClick) return;
                    if (slot.empty) {
                        pendingTargetIdx = slot.idx;
                        const pickModal = openModal({
                            width: 'sm',
                            body: `
                                <div class="mb-dialog-title">添加头像</div>
                                <div class="mb-dialog-sub">选择来源，最多可保存 ${AVATAR_MAX_SLOTS} 个头像</div>
                                <div class="mb-dialog-actions" style="flex-direction:row;gap:10px;">
                                    <button class="btn-pick-upload mb-btn mb-btn-secondary" style="flex:1;">📤 从本地上传图片</button>
                                    <button class="btn-pick-capture mb-btn mb-btn-secondary" style="flex:1;">📷 抓取当前页面头像</button>
                                </div>`
                        });
                        pickModal.query('.btn-pick-upload').onclick = () => {
                            pickModal.close();
                            container.closest('.mb-modal-box').querySelector('#mb-avatar-file').click();
                        };
                        pickModal.query('.btn-pick-capture').onclick = () => {
                            pickModal.close();
                            container.closest('.mb-modal-box').querySelector('#mb-avatar-capture').click();
                        };
                        return;
                    }
                    selectedSlot = slot.id;
                    renderSlots(container);
                };
                // 空槽与已占用格都能接住拖拽
                cell.ondragover = (e) => {
                    // 先无条件拦掉默认行为：拖到自己格子、或 dragFrom 已清空时也要拦，否则会按「拖入图片」新开窗口
                    e.preventDefault();
                    if (dragFrom === null || dragFrom === slot.idx) return;
                    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
                    cell.classList.add('mb-avatar-cell--drop');
                };
                cell.ondragleave = () => cell.classList.remove('mb-avatar-cell--drop');
                cell.ondrop = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cell.classList.remove('mb-avatar-cell--drop');
                    window.__mbAvatarDragActive = false;
                    dropAvatarTo(slot.idx, container);
                };
                container.appendChild(cell);
            });
            const modalBox = container.closest('.mb-modal-box');
            // 宽度由 sm 类统一控制（420px）
        }

        // 点哪格填哪格：优先落到点击空槽时记下的目标槽，兜底取第一个空槽
        function pushAvatar(data) {
            let idx = pendingTargetIdx;
            if (!(idx >= 0 && idx < AVATAR_USER_SLOTS && !pendingUserAvatars[idx])) {
                idx = pendingUserAvatars.findIndex(a => !a);
            }
            if (idx < 0 || idx >= AVATAR_USER_SLOTS) {
                mbToast('头像已满 ' + AVATAR_USER_SLOTS + ' 个，请先删掉一个', 2000, 'error');
                return;
            }
            pendingUserAvatars[idx] = { data, label: '我的头像 ' + (idx + 1) };
            selectedSlot = 'user:' + idx;
            pendingTargetIdx = -1;
            setUserAvatars(pendingUserAvatars);
            mbToast('已放入第 ' + (idx + 1) + ' 格并选中，可点「设为面板头像」', 2200, 'success');
        }

        const body = `
        <div class="mb-avatar-head">
            <div class="mb-avatar-nickname-row">
                <label>昵称：</label>
                <input type="text" id="mb-avatar-nickname" class="mb-input-base" value="${Util.escapeHtml(nickname)}" placeholder="萌宝">
                <span class="mb-avatar-nickname-hint">昵称会用于面板标题与提示文案</span>
            </div>
        </div>
        <div class="mb-avatar-grid" id="mb-avatar-grid"></div>
        <div class="mb-avatar-actions-row" style="display:none;">
            <button class="mb-btn mb-btn-secondary" id="mb-avatar-upload" title="从本地图片上传自定义头像">📤 上传头像</button>
            <button class="mb-btn mb-btn-secondary" id="mb-avatar-capture" title="自动抓取当前页面该用户的原始头像">🔍 抓取头像</button>
            <input type="file" id="mb-avatar-file" accept="image/*" class="mb-avatar-file-input">
        </div>
        <div class="mb-avatar-actions-row">
            <button class="mb-btn mb-btn-primary" id="mb-avatar-apply-comment" title="设好后评论区面板使用这一张头像">💬 设为面板头像</button>
        </div>
        <p class="mb-avatar-hint-text" style="margin-top:8px;color:var(--mb-text-hint);font-size:var(--mb-font-sm);text-align:center;">点击 + 添加自定义头像，拖动头像可调整位置，最多保存 9 个</p>`;

        // 昵称框里已经是「萌宝」，自动聚焦+全选会让用户打第一个字就把整段替换掉，这里关掉
        const dlg = openModal({ body, width: 'sm', extraClass: 'mb-avatar-modal', autoFocusFirst: false });
        //          改为失焦即保存，并同步给已打开的评论面板，避免「看着改了其实没生效」
        const nickInput = dlg.box.querySelector('#mb-avatar-nickname');
        if (nickInput) {
            nickInput.addEventListener('blur', () => {
                const v = nickInput.value.trim() || '萌宝';
                nickInput.value = v;
                Util.userStore.set('mengbao.panel.nickname', v);
                if (window.MengbaoCommentPanel && window.MengbaoCommentPanel.setNickname) {
                    window.MengbaoCommentPanel.setNickname(v);
                }
            });
        }
        const grid = dlg.box.querySelector('#mb-avatar-grid');
        renderSlots(grid);

        // 上传：5MB 为拒绝上限，通过后由 canvas 压缩到 128px
        dlg.box.querySelector('#mb-avatar-upload').onclick = () => dlg.box.querySelector('#mb-avatar-file').click();
        dlg.box.querySelector('#mb-avatar-file').onchange = async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            if (f.size > CONST.AVATAR_MAX_SIZE) { mbToast('图片超过 5MB，请裁剪后再上传', 2000, 'error'); return; }
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const compressed = await compressAvatar(ev.target.result, 256);
                    pushAvatar(compressed);
                    renderSlots(grid);
                } catch (err) { mbToast('图片处理失败，请换一张试试', 2000, 'error'); }
            };
            reader.readAsDataURL(f);
            e.target.value = '';
        };

        // 抓取：按页面类型优先选内容区头像，避开顶部导航
        dlg.box.querySelector('#mb-avatar-capture').onclick = () => {
            let img = null;
            if (/mod=space/.test(location.href)) {
                img = document.querySelector('.pcb .avatar img, #uhd .avatar img, .pslm .avatar img');
            }
            if (!img) {
                const posts = document.querySelectorAll('table[id^=pid]');
                for (const post of posts) {
                    const av = post.querySelector('.avatar img');
                    if (av && av.src && !/noavatar|blank/.test(av.src)) { img = av; break; }
                }
            }
            if (!img) {
                const all = document.querySelectorAll('img[src*="avatar"], .avatar img, .u-avatar img');
                for (const el of all) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top > 100 && el.src && !/noavatar|blank/.test(el.src)) { img = el; break; }
                }
            }
            if (!img || !img.src) { mbToast('当前页面没找到可抓取的头像', 2000, 'error'); return; }
            const origUrl = img.src;
            const bigUrl = origUrl.replace(/_avatar_(small|middle)\./, '_avatar_big.');
            const middleUrl = origUrl.replace(/_avatar_(small|big)\./, '_avatar_middle.');
            const candidates = [];
            if (bigUrl !== origUrl) candidates.push(bigUrl);
            if (middleUrl !== origUrl && !candidates.includes(middleUrl)) candidates.push(middleUrl);
            candidates.push(origUrl);

            let candidateIdx = 0;
            const tryNextGrab = () => {
                if (candidateIdx >= candidates.length) {
                    mbToast('头像抓取失败，请换一张试试', 2000, 'error');
                    return;
                }
                const url = candidates[candidateIdx++];
                const xhr = new XMLHttpRequest();
                xhr.onload = async () => {
                    if (xhr.status < 200 || xhr.status >= 300) { tryNextGrab(); return; }
                    const blob = xhr.response;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const compressed = await compressAvatar(ev.target.result, 256);
                            pushAvatar(compressed);
                            renderSlots(grid);
                        } catch (err) { mbToast('图片处理失败，请换一张试试', 2000, 'error'); }
                    };
                    reader.readAsDataURL(blob);
                };
                xhr.onerror = () => tryNextGrab();
                // 候选地址被服务器挂住（不返回也不断开）时，没有超时会让整条抓取链静默停住
                xhr.timeout = CONST.AVATAR_FETCH_TIMEOUT_MS;
                xhr.ontimeout = () => tryNextGrab();
                xhr.open('GET', url);
                xhr.responseType = 'blob';
                xhr.send();
            };
            tryNextGrab();
        };

        function applyTo(prefix) {
            const parts = selectedSlot.split(':');
            const type = parts[0], idx = parts[1];
            if (type === 'user') {
                const i = parseInt(idx);
                if (pendingUserAvatars[i]) {
                    Util.userStore.set('mengbao.' + prefix + '.avatarChoice', 'custom');
                    Util.userStore.set('mengbao.' + prefix + '.avatar', pendingUserAvatars[i].data);
                } else { mbToast('请先选择一个头像'); return; }
            } else { mbToast('请先选择一个头像'); return; }
            mbToast('已设为面板头像，刷新后生效', 2000, 'success');
        }
        dlg.box.querySelector('#mb-avatar-apply-comment').onclick = () => applyTo('comment');

        const saveAvatarDialog = () => {
            const nick = dlg.box.querySelector('#mb-avatar-nickname').value.trim() || '萌宝';
            Util.userStore.set('mengbao.panel.nickname', nick);
            setUserAvatars(pendingUserAvatars);
        };
        const maskEl = dlg.box.parentElement;
        maskEl.addEventListener('mousedown', (e) => { if (e.target === maskEl) saveAvatarDialog(); });
    }

        function openGmSettingDialog() {
        const modal = openModal({
            width: 'md', extraClass: 'mb-modal-box--setting',
            closeOnMaskClick: false,
            body: `
            ${buildSettingContent(true, true)}
            <div class="mb-actions">
                <div class="mb-actions-row">
                    <button class="btn-avatar mb-btn mb-btn-secondary" title="设置评论区和收藏馆的头像、昵称">👤 头像设置</button>
                    <button class="btn-reset-pos mb-btn mb-btn-secondary" title="清空所有悬浮球的拖拽位置，恢复默认位置">📍 重置位置</button>
                    <button class="btn-clear-cache mb-btn mb-btn-secondary" title="清空看图模块的图片缓存">🧹 清除缓存</button>
                </div>
                <div class="mb-actions-row">
                    <button class="btn-export-all mb-btn mb-btn-secondary" title="导出所有配置到剪贴板（JSON格式）">📤 导出配置</button>
                    <button class="btn-import-all mb-btn mb-btn-secondary" title="从剪贴板导入配置（JSON格式）">📥 导入配置</button>
                    <button class="btn-reset mb-btn mb-btn-secondary mb-btn-danger" title="彻底恢复出厂设置，清空所有设置、收藏、位置、缓存等全部数据">↩️ 恢复默认</button>
                </div>
                <div class="mb-actions-row mb-actions-row--between">
                    <label class="mb-debug-label">
                        <input type="checkbox" class="btn-debug-toggle mb-debug-checkbox"> 调试日志
                    </label>
                    <span class="mb-actions-btns">
                        <button class="btn-cancel mb-btn mb-btn-secondary">取消</button>
                        <button class="btn-save mb-btn mb-btn-primary mb-btn-save">保存设置</button>
                    </span>
                </div>
            </div>`
        });
        const box = modal.box;
        modal.query('.btn-help').onclick = () => {
            Util.storage.remove('mengbao.guide.shown');
            modal.close();
            setTimeout(() => { try { showFirstRunGuideIfNeeded(true); } catch (e) {} }, 260);
        };
        const openFavBtn = modal.query('.btn-open-fav-gallery');
        if (openFavBtn) openFavBtn.onclick = () => openFavGallery();
        modal.query('.btn-reset-pos').onclick = () => {
            // 修复：加上 fanye 的 fab_pos，否则翻页球拖拽后无法重置
            ['mengbao.kantu.fab_pos', 'mengbao.fanye.fab_pos', 'mengbao.guolv.fab_pos_v2', 'mengbao.zengqiang.fab_pos'].forEach(k => {
                Util.userStore.remove(k); Util.userStore.remove(k + '_fold');
            });
            // 实时重置所有 FAB 的 DOM 位置（包括所有 inline style）
            document.querySelectorAll('.mb-fab').forEach(el => {
                el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; el.style.transform = '';
                el.style.margin = '';
            });
            Util.toast('所有悬浮球已回到默认位置', 2000, 'success');
            modal.close();
        };
        modal.query('.btn-clear-cache').onclick = () => {
            Util.storage.remove('mengbao.kantu.cache');
            Mengbao.Preview.clearAll();
            Util.toast('预览缓存已清空', 2000, 'success');
        };
        // 调试日志开关（checkbox）
        const debugToggle = modal.query('.btn-debug-toggle');
        debugToggle.checked = Util.storage.get('mengbao.debug', false);
        debugToggle.onchange = () => {
            Util.storage.set('mengbao.debug', debugToggle.checked);
            // 每条日志走 Util.log 现读这个开关，改完立刻生效，不需要刷新
            Util.toast(debugToggle.checked ? '调试日志已开启' : '调试日志已关闭', 2000, 'info');
        };
        // 设置头像
        modal.query('.btn-avatar').onclick = () => {
            modal.close();
            openAvatarDialog();
        };
        // 重置后弹窗里的控件还是旧值，任何一次保存都会把刚清掉的值装回去；置位后直接拒收
        let settingsResetting = false;
        modal.query('.btn-reset').onclick = () => {
            // GM_listValues 全量清扫 + schema 键兜底，删除条数按实际命中统计
            settingsResetting = true;
            const deletedCount = Cfg.resetAll();
            modal.close();
            Util.toast('已恢复出厂设置，清空 ' + deletedCount + ' 项记录，页面马上自动刷新', 700, 'success');
            setTimeout(() => location.reload(), 800);
        };
        modal.query('.btn-save').onclick = () => {
            if (settingsResetting) return;
            saveSettings(box);
            modal.close();
        };
        modal.query('.btn-cancel').onclick = () => modal.close();
        bindFullBackup(box);
    }

    // ===================== 全局收藏用户按钮 =====================
    function initFavUserButtons() {
        let favoriteUsers = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
        // 收藏馆或楼层增删后必须重读，否则高亮判断一直拿页面加载时的旧快照
        const refreshFavUsers = () => {
            favoriteUsers = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            return favoriteUsers;
        };
        Util.log('debug', '[收藏按钮] 当前页面=', location.pathname + location.search, 'uid=', currentUserId(), '桶=', userBucket(currentUserId()), '收藏用户数=', Object.keys(favoriteUsers).length);

        const STAR_PATH = 'M12 2l2.9 6.26 6.6.57-5 4.36 1.5 6.51L12 16.9 5.99 19.7l1.5-6.51-5-4.36 6.6-.57z';
        const starSvg = (on) => on
            ? `<svg class="mb-star-svg" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="${STAR_PATH}"/></svg>`
            : `<svg class="mb-star-svg" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="${STAR_PATH}"/></svg>`;

        const updateHighlight = (el, uid) => {
            if (!el) return;
            if (favoriteUsers[uid]) { el.classList.add('mb-favorite-user-author'); }
            else { el.classList.remove('mb-favorite-user-author'); }
        };
        const applyFavUserThreadHighlight = (row) => {
            let authorLink = row.querySelector('td.by cite a[href*="uid="]')
                          || row.querySelector('td.by a[href*="uid="]')
                          || row.querySelector('.by cite a[href*="uid="]')
                          || row.querySelector('.by a[href*="uid="]')
                          || row.querySelector('p span a[href*="space&uid="]')
                          || row.querySelector('a[href*="space.php?uid="]')
                          || row.querySelector('a[href*="space&uid="]');
            if (!authorLink) {
                Util.log('debug', '[收藏高亮] 行内未找到作者 uid 链接', row.className || '', (row.textContent || '').slice(0, 40));
                return;
            }
            const m = (authorLink.href || '').match(/uid=(\d+)/);
            if (!m) return;
            const uid = m[1];
            const isFav = !!favoriteUsers[uid];
            Util.log('debug', '[收藏高亮] 作者 uid=' + uid, '收藏=' + isFav, '收藏键存在=' + Object.prototype.hasOwnProperty.call(favoriteUsers, uid));
            const userInfo = authorLink.parentElement;
            if (userInfo) bindUserJumpMenu(userInfo, uid);
            // 注意：不能只在"首次挂按钮"时染色。按钮已在时 attachBtn 会提前返回，
            // 作者名颜色就会永远停在第一次的结果，之后收藏/取消都不跟着变。
            updateHighlight(authorLink, uid);
            if (userInfo && !userInfo.querySelector('[data-mb-favoriteuid]')) {
                attachBtn(userInfo, 'list');
            }
            let titleLink = row.querySelector('th.common a[href*="mod=viewthread"]')
                         || row.querySelector('th.common a[href*="thread-"]')
                         || row.querySelector('a.s.xst')
                         || row.querySelector('h3 a[href*="mod=viewthread"]')
                         || row.querySelector('h3 a[href*="thread-"]')
                         || row.querySelector('.xs3 a[href*="mod=viewthread"]')
                         || row.querySelector('.xs3 a[href*="thread-"]')
                         || row.querySelector('a[href*="mod=viewthread"]')
                         || row.querySelector('a[href*="tid="]')
                         || row.querySelector('a[href*="thread-"]');
            if (!titleLink) {
                Util.log('debug', '[收藏高亮] 行内未找到标题链接 uid=' + uid, (row.textContent || '').slice(0, 40));
                return;
            }
            titleLink.classList.toggle('mb-favorite-user-thread-title', isFav);
            row.classList.toggle('mb-favorite-user-thread-row', isFav);
        };
        const highlightAllFavUserThreads = () => {
            const tlRows = document.querySelectorAll('.tl tr:has(td.icn)');
            const pbwRows = document.querySelectorAll('#threadlist .pbw');
            Util.log('debug', '[收藏高亮] 扫描统计：列表行=' + tlRows.length, '搜索pbw行=' + pbwRows.length);
            tlRows.forEach(row => {
                applyFavUserThreadHighlight(row);
            });
            // 搜索页：li.pbw 就是行本身，直接处理
            pbwRows.forEach(row => {
                applyFavUserThreadHighlight(row);
            });
        };
        const buildBtn = (uid, username, mode) => {
            const btn = document.createElement('span');
            btn.className = 'mb-floor-plus' + (favoriteUsers[uid] ? ' mb-favorite-on' : ' mb-favorite-off');
            btn.dataset.mbFavoriteuid = uid;
            btn.dataset.mbUsername = username;
            btn.dataset.mbMode = mode;
            btn.innerHTML = starSvg(!!favoriteUsers[uid]);
            btn.title = favoriteUsers[uid] ? '取消收藏该用户' : '收藏该用户';
            return btn;
        };
        // 全页同步同一 uid 的所有按钮
        const syncAll = (uid, username, data) => {
            const all = data || Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            const on = !!all[uid];
            document.querySelectorAll(`[data-mb-favoriteuid="${uid}"]`).forEach(btn => {
                btn.innerHTML = starSvg(on);
                btn.classList.toggle('mb-favorite-on', on);
                btn.classList.toggle('mb-favorite-off', !on);
                btn.title = on ? '取消收藏该用户' : '收藏该用户';
            });
        };
        // 个人资料页判定：URL 可能只有 username（home.php?mod=space&username=xxx），没有 uid
        // 注意：home.php?mod=space 还复用于短消息(do=pm)、提醒(do=notice)等子页面，
        // 不能只凭 mod=space 就当成资料页，否则会把星标挂到右上角"当前登录用户"上。
        const isProfilePage = () => {
            if (/space-uid-\d+|space-username-/.test(location.href)) return true;
            if (!/mod=space\b/.test(location.href)) return false;
            const m = location.href.match(/[?&]do=([a-z]+)/i);
            if (!m) return true;                                  // home.php?mod=space&uid=x
            return /^(profile|thread)$/.test(m[1].toLowerCase());  // 资料页 / 个人主题页
        };
        // 取当前资料页用户的 uid：URL 有就用，没有就从 #uhd 里带 uid 的链接反查
        const getProfileUid = () => {
            const m = location.href.match(/uid=(\d+)/) || location.href.match(/space-uid-(\d+)/);
            if (m) return m[1];
            const scope = document.querySelector('#uhd') || document;
            const link = scope.querySelector('a[href*="mod=space&uid="], a[href*="space-uid-"]');
            if (link) {
                const href = link.getAttribute('href') || '';
                const mm = href.match(/uid=(\d+)/) || href.match(/space-uid-(\d+)/);
                if (mm) return mm[1];
            }
            return null;
        };
        // 用户名挂载点：只取正文里指向该 uid 的用户名链接，绝不再挂到顶部导航 #uhd
        // 找不到就返回 null —— 宁可不挂，也不挂错位置
        const findProfileNameEl = () => {
            const uid = getProfileUid();
            if (!uid) return null;
            const links = Array.from(document.querySelectorAll('a[href*="uid=' + uid + '"], a[href*="space-uid-' + uid + '"]'));
            const hit = links.find(a => !(a.closest && a.closest('#uhd')) && (a.textContent || '').trim() && !a.querySelector('img'));
            return hit ? (hit.parentElement || hit) : null;
        };
        // 给一个用户名容器挂按钮：mode=floor/list/profile
        const attachBtn = (userInfo, mode) => {
            if (!userInfo) return;
            let a = userInfo.tagName === 'A' ? userInfo : userInfo.querySelector('a');
            if (mode !== 'profile') {
                if (!a || !a.href) return;
                const m = a.href.match(/uid=(\d+)/);
                if (!m) return;
                const uid = m[1];
                const username = a.textContent.trim();
                updateHighlight(a, uid);
                if (mode === 'floor' || mode === 'list') bindUserJumpMenu(userInfo, uid);
                if (userInfo.querySelector('[data-mb-favoriteuid]')) return;
                userInfo.appendChild(buildBtn(uid, username, mode));
            } else {
                const uid = getProfileUid();
                if (!uid) return;
                // 自己的资料页不挂星标（取顶部导航里自己的 uid 做比对）
                const mine = (() => { const box = document.querySelector('#uhd'); if (!box) return null; const a = box.querySelector('a[href*="mod=space&uid="], a[href*="space-uid-"]'); if (!a) return null; const h = a.getAttribute('href') || ''; const mm = h.match(/uid=(\d+)/) || h.match(/space-uid-(\d+)/); return mm ? mm[1] : null; })();
                if (mine && uid === mine) return;
                const nameText = userInfo.textContent.split('\n').map(s => s.trim()).find(s => s && !/^https?:/.test(s) && !/加为好友|发送消息/.test(s));
                const username = nameText || uid;
                updateHighlight(userInfo, uid);
                if (userInfo.querySelector('[data-mb-favoriteuid]')) return;
                userInfo.appendChild(buildBtn(uid, username, mode));
            }
        };
        // 初始扫描
        document.querySelectorAll('table[id^=pid]').forEach(row => {
            const userInfo = row.querySelector('div[id^=favatar] .authi');
            if (userInfo) attachBtn(userInfo, 'floor');
        });
        if (isForumListPage()) {
            document.querySelectorAll('.tl tr:has(td.icn)').forEach(row => {
                const byTd = row.querySelector('td.by');
                if (!byTd) return;
                const citeA = byTd.querySelector('cite a, a');
                if (citeA && citeA.href && citeA.href.includes('uid=')) attachBtn(citeA.parentElement, 'list');
            });
        }
        highlightAllFavUserThreads();
        if (isProfilePage()) {
            const userNameEl = findProfileNameEl();
            if (userNameEl) attachBtn(userNameEl, 'profile');
        }

        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-mb-favoriteuid]');
            if (!btn) return;
            e.stopPropagation();
            const uid = btn.dataset.mbFavoriteuid;
            const username = btn.dataset.mbUsername || uid;
            const mode = btn.dataset.mbMode;
            let highlightTarget = null;
            if (mode === 'profile') {
                highlightTarget = btn.parentElement;
            } else {
                const wrap = btn.closest('.authi, td.by');
                highlightTarget = wrap ? wrap.querySelector('a[href*="uid="]') : null;
            }
            // 每次读写都取最新数据，避免用页面加载时的旧快照整份覆盖掉收藏馆里的改动
            const fu = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            if (fu[uid]) {
                delete fu[uid];
                Util.favUserOrder.remove(uid);
                Util.userStore.set('mengbao.zengqiang.favorite_users', fu);
                syncAll(uid, username, fu);
                Util.toast(`已取消收藏：用户 ${username}`, 2000, 'favorite');
            } else {
                Util.favUserOrder.add(uid);
                fu[uid] = { username: username, favorited: true };
                Util.userStore.set('mengbao.zengqiang.favorite_users', fu);
                syncAll(uid, username, fu);
                Util.toast(`已收藏：用户 ${username}`, 2000, 'favorite');
            }
            favoriteUsers = fu;
            if (highlightTarget) updateHighlight(highlightTarget, uid);
            // 否则个人资料页的「主题 / 个人资料」tab、发消息、加为好友等链接会被一起染色（刷新才恢复）
            [
                '#uhd .mt',                                                        // 个人资料页用户名
                `table[id^=pid] .authi cite a[href*="uid=${uid}"]`,                 // 帖子楼层作者
                `td.by cite a[href*="uid=${uid}"]`,                                 // 列表页作者
                `#threadlist .pbw .xs3 a[href*="uid=${uid}"]`,                      // 搜索页作者
                `#threadlist .pbw h3 a[href*="uid=${uid}"]`
            ].forEach(sel => {
                document.querySelectorAll(sel).forEach(el => updateHighlight(el, uid));
            });
            // 实时更新列表页的收藏用户高亮
            highlightAllFavUserThreads();
            window.dispatchEvent(new CustomEvent('mengbao:favorite-changed', { detail: { uid, username, on: !!fu[uid], from: 'floor' } }));
        });

        window.addEventListener('mengbao:favorite-changed', (ev) => {
            const d = ev.detail || {};
            if (d.from === 'floor' || !d.uid) return;
            const fu = Util.userStore.get('mengbao.zengqiang.favorite_users', {}) || {};
            if (d.on) { Util.favUserOrder.add(d.uid); fu[d.uid] = { username: d.username || d.uid, favorited: true }; }
            else { Util.favUserOrder.remove(d.uid); delete fu[d.uid]; }
            Util.userStore.set('mengbao.zengqiang.favorite_users', fu);
            favoriteUsers = fu;
            syncAll(d.uid, d.username || d.uid, fu);
        });

        // 收藏馆里增删用户后，重刷页面上所有星星（数据源只有一个，避免两边快照打架）
        window.addEventListener('mengbao:favusers-changed', () => {
            const all = refreshFavUsers();
            document.querySelectorAll('[data-mb-favoriteuid]').forEach(btn => {
                const u = btn.dataset.mbFavoriteuid;
                const on = !!all[u];
                btn.innerHTML = starSvg(on);
                btn.classList.toggle('mb-favorite-on', on);
                btn.classList.toggle('mb-favorite-off', !on);
                btn.title = on ? '取消收藏该用户' : '收藏该用户';
            });
            highlightAllFavUserThreads();
        });

        let _favoritePending = [];
        let _favoriteTimer = 0;
        registerDomObserver((mutations) => {
            _favoritePending.push(...mutations);
            if (_favoriteTimer) return;
            _favoriteTimer = setTimeout(() => {
                _favoriteTimer = 0;
                const batch = _favoritePending.splice(0, _favoritePending.length);
                batch.forEach(m => {
                    m.addedNodes.forEach(node => {
                        if (!(node instanceof Element)) return;
                        if (node.closest && node.closest('.mb-comment-app')) return;
                        
                        // 1. 帖子楼层里的用户名
                        const rows = node.matches && node.matches('table[id^=pid]') ? [node] : (node.querySelectorAll ? node.querySelectorAll('table[id^=pid]') : []);
                        rows.forEach(row => {
                            const userInfo = row.querySelector('div[id^=favatar] .authi');
                            if (userInfo && !userInfo.querySelector('[data-mb-favoriteuid]')) attachBtn(userInfo, 'floor');
                        });
                        
                        // 2. 列表页/搜索页：翻页加载的新行同步用户名按钮 + 收藏用户帖子高亮
                        if (isForumListPage() || isSearchResultPage()) {
                            const nRows = node.matches && node.matches('.tl tr:has(td.icn)') ? [node] : (node.querySelectorAll ? node.querySelectorAll('.tl tr:has(td.icn)') : []);
                            nRows.forEach(row => applyFavUserThreadHighlight(row));
                            if (isSearchResultPage()) {
                                const nPbw = node.matches && node.matches('#threadlist .pbw') ? [node] : (node.querySelectorAll ? node.querySelectorAll('#threadlist .pbw') : []);
                                nPbw.forEach(row => applyFavUserThreadHighlight(row));
                            }
                        }
                        
                        // 3. 用户个人资料页
                        if (isProfilePage()) {
                            const userNameEl = findProfileNameEl();
                            if (userNameEl && !userNameEl.querySelector('[data-mb-favoriteuid]')) attachBtn(userNameEl, 'profile');
                        }
                    });
                });
            }, CONST.OBSERVER_THROTTLE_MS);
        });
    }

    // ===================== 主入口 =====================
    function main() {
        injectStyle();
        moduleSortByDateline();
        GM_registerMenuCommand('设置', openGmSettingDialog);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startModules);
        else startModules();
    }
    // 浏览历史模块：详情页记录 tid，列表页标记已浏览
    const BrowseHistory = {
        KEY: 'mengbao.browse.history',
        MAX: 500,
        get() { return Util.userStore.get(this.KEY, { time: 0, data: {} }); },
        set(tid) {
            const h = this.get();
            h.data[tid] = Date.now();
            const keys = Object.keys(h.data);
            if (keys.length > this.MAX) {
                const sorted = keys.sort((a,b) => h.data[a] - h.data[b]);
                for (let i = 0; i < keys.length - this.MAX; i++) delete h.data[sorted[i]];
            }
            Util.userStore.set(this.KEY, { time: Date.now(), data: h.data });
        },
        _extractTid(a) {
            if (!a || !a.href) return null;
            const m1 = a.href.match(/[?&]tid=(\d+)/);
            if (m1) return m1[1];
            const m2 = a.href.match(/thread-(\d+)-/);
            if (m2) return m2[1];
            return null;
        },
        markList() {
            if (!Util.storage.get('mengbao.browse.enabled', true)) return;
            // 底色与划线按设置注入（自定义颜色只作用于非收藏行，收藏蓝底优先级不变）
            try {
                const bg = Util.storage.get('mengbao.browse.color', '#f0f0f0');
                const strike = Util.storage.get('mengbao.browse.strike', true);
                document.documentElement.style.setProperty('--mb-browsed-bg', Util.isValidColor(String(bg)) ? bg : '#f0f0f0');
                document.documentElement.style.setProperty('--mb-browsed-strike', strike ? 'line-through' : 'none');
            } catch (e) {}
            const h = this.get();
            Util.log('debug', '[已读标记] bucket=' + Util.userStore.curBucket() + ' 历史条数=' + Object.keys((h.data || {})).length);
            // 版块列表页（.tl 表格）/ 个人主题页（.tl 表格，无 td.icn）/ 搜索结果页（#threadlist .pbw）统一按行处理
            const markRows = (hist) => {
                document.querySelectorAll('.tl tr, #threadlist .pbw').forEach(row => {
                    if (row.classList.contains('mb-browsed')) return;
                    const a = row.querySelector('a[href*="mod=viewthread"], a[href*="tid="], a[href*="thread-"]');
                    const tid = this._extractTid(a);
                    if (tid && hist.data[tid]) row.classList.add('mb-browsed');
                });
            };
            markRows(h);
            // 论坛 ajax 注入 / 脚本追加行后补标
            [500, 1500].forEach(ms => setTimeout(() => {
                try {
                    if (!Util.storage.get('mengbao.browse.enabled', true)) return;
                    markRows(this.get());
                } catch (e) {}
            }, ms));
        }
    };

    function showFirstRunGuideIfNeeded(force) {
        try {
            if (!force && Util.storage.get('mengbao.guide.shown', false)) return;
            if (!force && !document.querySelector('.mb-fab')) return;
            Util.storage.set('mengbao.guide.shown', true);
            const card = document.createElement('div');
            card.className = 'mb-guide-card' + (force ? ' mb-guide-card--center' : '');
            card.innerHTML = ''
                + '<div class="mb-guide-title">📖 ' + Util.escapeHtml(Util.userStore.get('mengbao.panel.nickname', '萌宝')) + ' · 快速上手</div>'
                + '<div class="mb-guide-row">🎯 过滤球：左键打开板块过滤面板 ｜ 右键过滤/屏蔽设置</div>'
                + '<div class="mb-guide-row">📄 翻页球：左键加载一页 ｜ 右键切换持续加载</div>'
                + '<div class="mb-guide-row">🖼️ 看图球：左键开启图片预览 ｜ 右键停止加载并收起（缓存保留）</div>'
                + '<div class="mb-guide-row">⚡ 增强球：左键功能面板（画廊/收藏/评分…）｜ 右键评论面板</div>'
                + '<div class="mb-guide-row">🎨 蓝底行 = 你收藏的用户发帖 ｜ 变色行 = 你已读过的帖（底色与划线可在设置里调）</div>'
                + '<div class="mb-guide-hint">提示：所有球都可拖动，拖到屏幕边缘会自动校正位置</div>'
                + '<button type="button" class="mb-guide-ok">知道了</button>';
            const ok = card.querySelector('.mb-guide-ok');
            if (force) {
                const mask = document.createElement('div');
                mask.className = 'mb-guide-mask';
                mask.appendChild(card);
                document.body.appendChild(mask);
                if (ok) ok.onclick = () => mask.remove();
            } else {
                // 首次自动出现 → 右下角轻提示，不打断浏览
                document.body.appendChild(card);
                if (ok) ok.onclick = () => card.remove();
            }
        } catch (e) { /* 引导失败不影响主功能 */ }
    }

    function startModules() {
        // 解析失败被永久缓存为 guest 桶（导致 A/B 账号数据全部混写 guest 桶、串号/已读不显示）的问题
        _currentUserId = -1;
        _currentUserIdResolved = false;
        _currentUserIdTries = 0;
        window.addEventListener('error', (e) => {
            try { Util.log('error', '[全局] 未捕获错误：', e.message, '@', (e.filename || '') + ':' + (e.lineno || '?')); } catch (_) {}
        });
        window.addEventListener('unhandledrejection', (e) => {
            try { const r = e.reason; Util.log('error', '[全局] 未处理的 Promise 拒绝：', r && (r.message || r) || r); } catch (_) {}
        });
        // 依赖顺序：搜索 -> 看图（看图依赖搜索的 isTidHidden）-> 翻页 -> 增强 -> 设置页 -> 收藏按钮
        // 错误统一由外层 Util.safeRun 记录（含日志与提示），模块内不再各自 console.error
        try { Util.userStore.migrateAllOnce(); } catch (e) { Util.log('error', '用户数据迁移失败：', e); }
        const tasks = [
            ['过滤模块', () => { if (moduleGuolv.isTargetPage()) moduleGuolv.init(); }],
            ['看图模块', () => { if (moduleKantu.isTargetPage()) moduleKantu.init(); }],
            ['自动翻页', () => { if (modulePager.isTargetPage()) modulePager.init(); }],
            ['增强模块', () => { if (moduleZengqiang.isTargetPage()) moduleZengqiang.init(); }],
            ['收藏用户按钮', () => initFavUserButtons()],
            ['浏览历史', () => {
                if (isThreadPage()) {
                    const m = location.href.match(/tid=(\d+)/) || location.href.match(/thread-(\d+)-/);
                    if (m) BrowseHistory.set(m[1]);
                }
                if (isForumListPage() || isSearchResultPage() || isSpaceThreadPage()) {
                    BrowseHistory.markList();
                    // 监听帖子链接的点击事件，点击时立即标记为已读
                    document.addEventListener('click', (e) => {
                        const a = e.target.closest('a[href*="mod=viewthread"]') || e.target.closest('a[href*="tid="]');
                        if (!a) return;
                        const m = a.href.match(/tid=(\d+)/);
                        if (m) {
                            BrowseHistory.set(m[1]);
                            // 立即给这个帖子行添加已读标记
                            const row = a.closest('.tl tr') || a.closest('#threadlist .pbw');
                            if (row) row.classList.add('mb-browsed');
                        }
                    });
                }
            }]
        ];
        tasks.forEach(([label, fn]) => Util.safeRun(label + '初始化', fn));
        // 监听 pageshow 事件，当页面从 bfcache 恢复时，重新标记已读帖子
        window.addEventListener('pageshow', (e) => {
            if (e.persisted) {
                if (isForumListPage() || isSearchResultPage() || isSpaceThreadPage()) BrowseHistory.markList();
            }
        });
        setTimeout(showFirstRunGuideIfNeeded, 1500);
    }

    // 把 mbToast 挂到全局，供 Vue 面板 IIFE 降级使用
    // 跨闭包通信统一挂到 MB_BRIDGE，保留兼容别名
    try {
        const wd = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        wd.MB_BRIDGE = wd.MB_BRIDGE || {};
        wd.MB_BRIDGE.toast = mbToast;
        wd.mbToast = mbToast; // 兼容别名
    } catch (e) {}

    main();
})();

// ============================================================
// Vue 评论侧边面板
// 郑重感谢 【etai2019】明里小秘书对此脚本的帮助
// ============================================================
(function () {
    'use strict';
    // Vue 为独立闭包，自行读取站点白名单；非名单域名零副作用
    const MB = window.MB_BRIDGE || {};
    let vueHosts;
    try { vueHosts = JSON.parse(GM_getValue('mengbao.site.hosts', 'null')); } catch (e) { vueHosts = null; }
    if (!Array.isArray(vueHosts) || !vueHosts.length) vueHosts = MB.defaultHosts || ['www.sehuatang.net'];
    if (!vueHosts.includes(location.hostname)) return;
    // 只在帖子详情页运行
    if (!/mod=viewthread|thread-\d+(-\d+)*\.html/.test(location.href)) return; // 与主闭包 isThreadPage 保持一致

    // 评论加载超时（本闭包局部常量；主 IIFE CONST 不含此项）
    const COMMENT_LOAD_TIMEOUT = 15000;
    // 优先复用主闭包通过 MB_BRIDGE 暴露的配置门面 / 请求封装 / 日志；不可用时保留独立兜底
    const storage = MB.storage || {
        get(key, def) {
            const v = GM_getValue(key, null);
            if (v === null || v === undefined) return def;
            try { const p = JSON.parse(v); return (p === null || p === undefined) ? def : p; } catch (e) { return def; }
        },
        set(key, val) { try { GM_setValue(key, JSON.stringify(val)); } catch (e) {} },
        remove(key) { try { GM_deleteValue(key); } catch (e) {} }
    };
    const userStore = MB.userStore || {
        get(key, def) { return storage.get(key, def); },
        set(key, val) { storage.set(key, val); },
        getFor(key, uid, def) { return storage.get(key, def); },
        setFor(key, uid, val) { storage.set(key, val); }
    };
    const log = MB.log || function (level, ...args) {
        const fn = console[level] || console.log;
        fn.apply(console, ['[萌宝]'].concat(args));
    };
    // 局部转义（两个闭包相互独立，不依赖主脚本 Util）
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const httpGet = MB.httpGet || function (url, timeout = COMMENT_LOAD_TIMEOUT) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: url, timeout: timeout,
                headers: { 'Accept': 'text/html' },
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) resolve(resp.responseText);
                    else reject(new Error('HTTP ' + resp.status));
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    };

    function boot() {
    if (typeof Vue === 'undefined') {
        // 主 CDN（jsDelivr）未加载成功，fallback 到 unpkg
        log('warn', '主 CDN Vue 未加载，尝试 fallback 到 unpkg...');
        const fallback = document.createElement('script');
        fallback.src = 'https://unpkg.com/vue@3/dist/vue.global.js';
        fallback.onload = () => {
            log('debug', 'fallback Vue 加载成功');
            boot(); // 递归调用，此时 Vue 已加载
        };
        fallback.onerror = () => {
            log('warn', 'fallback Vue 也加载失败，评论面板降级为静态按钮');
            const fb = document.createElement('div');
            fb.textContent = '💬 评论区';
            fb.className = 'mb-comment-fallback-btn';
            fb.onclick = () => { if (MB.toast) MB.toast('Vue 未加载，请检查网络或 CDN 访问', 2000, 'error'); };
            document.body.appendChild(fb);
        };
        document.head.appendChild(fallback);
        return;
    }

    // 把 Vue 暴露到页面全局，否则模板编译的 new Function 在页面作用域找不到 Vue
    try {
        const wd = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : (window.unsafeWindow || document.defaultView || window);
        wd.Vue = Vue;
    } catch (e) {}

    function readStr(key, def) {
        return userStore.get(key, def);
    }

    GM_addStyle(`
        .mb-comment-app { padding:8px; font-size:var(--mb-font-md); line-height:1.6; font-family:Tahoma, Helvetica, "Microsoft Yahei", sans-serif; color:var(--mb-text-primary); position:fixed; top:4vh; right:2%; max-height:92vh; box-sizing:border-box; background:var(--mb-bg-page); border:1px solid rgba(0,0,0,0.08); border-radius:var(--mb-radius); overflow:hidden; opacity:.6; }
        .mb-comment-app:hover { opacity:1; border-color:var(--mb-accent); z-index:2; }
        .mb-comment-panel { height:calc(92vh - 80px); display:flex; flex-direction:column; }
        .mb-comment-scroll { flex:1; min-height:0; overflow:auto; }
        .mb-comment-head { display:flex; flex-direction:column; border-bottom:1px solid var(--mb-border); padding:6px 12px; }
        .mb-comment-title { font-size:var(--mb-font-title); font-weight:700; }
        .mb-comment-item { padding:10px 8px; display:flex; }
        .mb-comment-item:hover .mb-comment-action { display:inline; }
        .mb-comment-left { width:50px; height:50px; padding-top:8px; }
        .mb-comment-left>img { width:100%; height:100%; object-fit:contain; }
        .mb-comment-right { flex:1; padding:4px 8px; border-bottom:1px solid var(--mb-border); overflow:hidden; }
        .mb-comment-basic { display:flex; justify-content:space-between; color:var(--mb-text-muted); }
        .mb-comment-meta { justify-content:space-between; gap:8px; align-items:center; }
        .mb-comment-user a { color:var(--mb-text-muted); font-weight:normal; }
        .mb-comment-content { padding:6px 0; color:var(--mb-text-primary); font-size:var(--mb-font-md); max-height:390px; overflow:auto; }
        .mb-comment-content img { max-width:100%; height:auto; }
        .mb-comment-content img[smilieid] { max-width:20px; }
        .mb-comment-time { color:var(--mb-text-muted); }
        .mb-comment-foot { text-align:center; font-size:var(--mb-font-sm); padding:0 0 20px; }
        .mb-comment-action { color:var(--mb-text-muted); padding:0 6px; display:none; }
        .mb-comment-action:hover { text-decoration:none; }
        .mb-comment-app a:hover { text-decoration:none; }
        .mb-comment-head-row { display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px 12px; align-items:center; }
        .mb-comment-page-group { display:flex; align-items:center; flex-wrap:wrap; row-gap:4px; min-width:0; }
        .mb-comment-count { font-size:var(--mb-font-sm); color:var(--mb-text-muted); white-space:nowrap; flex-shrink:0; }
        .mb-comment-page-total { font-size:var(--mb-font-sm); color:var(--mb-text-muted); white-space:nowrap; flex-shrink:0; margin:0 8px 0 2px; }
        .mb-comment-head-row .mb-comment-page-input { width:38px; height:22px; padding:1px 6px; font-size:var(--mb-font-sm); text-align:center; vertical-align:middle; margin-right:6px; }
        .mb-comment-head-row .mb-comment-page-input:focus { border-color:var(--mb-accent); }
        .mb-comment-head-group { display:flex; align-items:center; }
        .mb-comment-header-avatar { width:50px; height:50px; object-fit:cover; border-radius:0; margin-right:6px; cursor:pointer; flex-shrink:0; }
        .mb-comment-header-avatar--empty { display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #fde2e2, #fbc7c7); color:#e05a5a; font-size:26px; cursor:pointer; flex-shrink:0; box-shadow:0 2px 8px rgba(245,158,11,0.2); }
        .mb-comment-page-link { display:inline-flex; align-items:center; height:22px; padding:0 5px; margin-left:3px; border-radius:var(--mb-radius); background:transparent; color:var(--mb-text-muted); font-size:var(--mb-font-sm); cursor:pointer; user-select:none; transition:background var(--mb-t-fast) ease, color var(--mb-t-fast) ease; }
        .mb-comment-page-link:hover { background:var(--mb-accent-soft); color:var(--mb-accent-deep); text-decoration:none; }
        .mb-comment-footer-actions { display:flex; gap:8px; align-items:center; flex-shrink:0; flex-wrap:nowrap; }
        .mb-comment-footer-actions > * { display:inline-flex; align-items:center; gap:4px; height:22px; line-height:1; font-size:var(--mb-font-sm); color:var(--mb-text-muted); text-decoration:none; cursor:pointer; user-select:none; transition:color var(--mb-t-fast) ease; }
        .mb-comment-footer-actions > *:hover { color:var(--mb-accent-deep); text-decoration:none; }
        .mb-comment-slider-row { display:flex; align-items:center; gap:8px; margin-top:6px; }
        .mb-comment-slider-row--divider { padding:10px 8px; }
        .mb-comment-slider-row input[type=range] { flex:1; -webkit-appearance:none; appearance:none; height:14px; background:transparent; cursor:pointer; opacity:.9; transition:opacity var(--mb-t-base) ease; }
        .mb-comment-slider-row input[type=range]:hover,
        .mb-comment-slider-row input[type=range]:active { opacity:1; }
        .mb-comment-slider-row input[type=range]::-webkit-slider-runnable-track { height:4px; border-radius:2px; background:rgba(0,0,0,0.10); }
        .mb-comment-slider-row input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; margin-top:-4px; border-radius:50%; background:var(--mb-accent); box-shadow:0 1px 2px rgba(0,0,0,.18); }
        .mb-comment-slider-row input[type=range]::-moz-range-track { height:4px; border-radius:2px; background:rgba(0,0,0,0.10); }
        .mb-comment-slider-row input[type=range]::-moz-range-thumb { width:12px; height:12px; border:none; border-radius:50%; background:var(--mb-accent); }
        /* 收藏馆 */
        @media (hover: none), (max-width: 768px) {
            .mb-comment-action { display:inline; }
        }
        .mb-comment-fallback-btn { position:fixed; top:4%; right:2%; background:var(--mb-bg-page); border:1px solid rgba(0,0,0,0.06); border-radius:var(--mb-radius); padding:8px 16px; z-index:var(--mb-z-fab); cursor:pointer; font-size:var(--mb-font-md); box-shadow:var(--mb-shadow-sm); color:var(--mb-accent); }
    `);

    const app$ = document.createElement('div');
    app$.id = 'mb-comment-app';
    document.body.appendChild(app$);

    // 面板内容不能再包 <template>——runtime 模板编译会把它当原生 template 元素，
    // 子节点进 content fragment 不进 DOM，导致分页行与评论列表整体白屏（历史回归）
    const template = `
    <div class="mb-comment-app" ref="app" :style="{ display: toggleOn ? '' : 'none' }">
        <div class="mb-comment-head">
            <div class="mb-comment-head-row">
                <div class="mb-comment-head-group">
                    <img v-if="headerAvatar" :src="headerAvatar" class="mb-comment-header-avatar" alt="" @click="onToggle" title="点击关闭面板">
                    <div v-else class="mb-comment-header-avatar mb-comment-header-avatar--empty" @click="onToggle" title="点击关闭面板">❤</div>
                    <div class="mb-comment-title">{{ nickname }}</div>
                </div>
                <div class="mb-comment-footer-actions">
                    <span class="mb-comment-backtop" @click="backToTop">⬆️ 回到顶部</span>
                    <a :href="replyThreadUrl">💬 回复帖子</a>
                </div>
            </div>
        </div>
        <div class="mb-comment-panel">
                <div class="mb-comment-head">
                    <div class="mb-comment-head-row">
                        <div class="mb-comment-page-group">
                            <input type="number" class="mb-comment-page-input mb-input-base" min="1" :max="totalPages" v-model.number="selectedPage" @change="onJumpToPage(selectedPage)" />
                            <span class="mb-comment-page-total">/{{ totalPages }}</span>
                            <span v-if="selectedPage > 1" class="mb-comment-page-link" @click="onJumpToPage(selectedPage - 1)">上一页</span>
                            <span v-if="selectedPage < totalPages" class="mb-comment-page-link" @click="onJumpToPage(selectedPage + 1)">下一页</span>
                            <span v-if="selectedPage < totalPages" class="mb-comment-page-link" @click="onJumpToPage(totalPages)">尾页</span>
                        </div>
                        <div class="mb-comment-count">{{ title }}</div>
                    </div>
                    <div class="mb-comment-slider-row">
                        <input type="range" min="1" max="30" v-model="minContentLength" @change="onMinContentLengthChange" />
                        <span>长度 ≥ {{ minContentLength }} 字</span>
                        <span title="当前共过滤掉 N 条不符合长度条件的评论">（已过滤：{{ comments.length - filteredComments.length }}）</span>
                    </div>
                </div>
                <div class="mb-comment-scroll" @scroll="onScroll">
                    <div class="mb-comment-item" v-for="(item, i) in filteredComments" :key="i">
                        <div class="mb-comment-left" v-html="item.avatar"></div>
                        <div class="mb-comment-right">
                            <div class="mb-comment-basic">
                                <div class="mb-comment-user" title="右键点击用户名跳转（设置里可配置）"><span v-html="item.user"></span></div>
                                <div class="mb-comment-num">{{ item.postNum }}</div>
                            </div>
                            <div class="mb-comment-content" v-html="item.content"></div>
                            <div class="mb-comment-basic mb-comment-meta">
                                <span class="mb-comment-time" v-html="item.time"></span>
                                <a class="mb-comment-action" :href="item.postUrl">跳转</a>
                            </div>
                        </div>
                    </div>
                    <div class="mb-comment-foot">{{ isLoading ? nickname + "正在努力加载下一页…" : nickname + "：没有更多评论啦~" }}</div>
                </div>
            <div class="mb-comment-slider-row mb-comment-slider-row--divider">
                <span>宽度: {{ appWidth }}%</span>
                <input type="range" min="15" max="50" v-model="appWidth" @change="onWidthSliderChange" />
            </div>
        </div>
    </div>
    `;

    Vue.createApp({
        template,
        data() {
            return {
                toggleOn: false,
                commentsPerPage: 9,
                appWidth: 22,
                comments: [],
                isLoading: false,
                nextPageUrl: '',
                totalComments: 0,
                totalPages: 1,
                selectedPage: 1,
                replyThreadUrl: '',
                minContentLength: 1,
                hasInit: false,
                headerAvatar: '',
                nickname: '萌宝',

            };
        },
        computed: {
            title() {
                return `${this.totalComments} 条评论`;
            },
            filteredComments() { return this.comments.filter(x => x.contentText.length >= this.minContentLength); },
        },
        methods: {
            onWidthSliderChange() {
                userStore.set('mengbao.comment.width', this.appWidth);
                this.$refs.app.style.width = this.appWidth + '%';
            },
            async checkAndLoadMore() {
                if (this.filteredComments.length < this.commentsPerPage) await this.loadNextPage();
            },
            async onMinContentLengthChange() {
                await this.checkAndLoadMore();
                userStore.set('mengbao.comment.minLen', this.minContentLength);
            },
            addComments(comments$, pageUrl) {
                const favoriteUsers = userStore.get('mengbao.zengqiang.favorite_users', {});
                // 字段独立兜底，单一选择器缺失不再整楼跳过；仅内容与用户均缺失的无效楼层才忽略
                const placeholderAvatar = '<img src="data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><circle cx="25" cy="25" r="22" fill="#e5e7eb"/></svg>') + '" alt="">';
                const newComments = [];
                for (const c of comments$) {
                    const avatarImg = c.querySelector('.avatar img')
                        || c.querySelector('div[id^="favatar"] a img')
                        || c.querySelector('div[id^="favatar"] img')
                        || c.querySelector('a > img');
                    let avatar = placeholderAvatar;
                    if (avatarImg && avatarImg.src) {
                        let src = avatarImg.src;
                        if (src && !/^https?:/i.test(src)) src = location.origin + (src.startsWith('/') ? src : '/' + src);
                        const origSrc = src;
                        // 防御：URL 要分别进入 HTML 属性值和内联 onerror 的 JS 字符串，两处各转义一次
                        const escAttr = u => String(u).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        const escJs = u => String(u).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const bigSrc = src.replace(/avatar(_small|_middle)?\.jpg/, 'avatar_big.jpg');
                        const midSrc = src.replace(/avatar(_small|_big)?\.jpg/, 'avatar_middle.jpg');
                        let onErr = '';
                        if (bigSrc !== origSrc) {
                            if (midSrc !== origSrc && midSrc !== bigSrc) {
                                onErr = 'this.onerror=function(){this.onerror=null;this.src=\'' + escJs(midSrc) + '\';this.onerror=function(){this.onerror=null;this.src=\'' + escJs(origSrc) + '\';};};';
                            } else {
                                onErr = 'this.onerror=null;this.src=\'' + escJs(origSrc) + '\';';
                            }
                        }
                        avatar = `<img src="${escAttr(bigSrc)}" alt=""${onErr ? ' onerror="' + onErr + '"' : ''}>`;
                    }
                    const authi = c.querySelector('.authi');
                    let user = authi ? authi.innerHTML : '<span>匿名</span>';
                    let uid = '', username = '';
                    if (authi) {
                        const ua = authi.querySelector('a[href*="uid="]');
                        if (ua) { const m = ua.href.match(/uid=(\d+)/); if (m) uid = m[1]; username = ua.textContent.trim(); }
                    }
                    if (uid && !user.includes('data-mb-favoriteuid')) {
                        const isOn = !!favoriteUsers[uid];
                        const starPath = 'M12 2l2.9 6.26 6.6.57-5 4.36 1.5 6.51L12 16.9 5.99 19.7l1.5-6.51-5-4.36 6.6-.57z';
                        const starSvg = isOn
                            ? `<svg class="mb-star-svg" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="${starPath}"/></svg>`
                            : `<svg class="mb-star-svg" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="${starPath}"/></svg>`;
                        const safeUsername = username.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                        user += `<span class="mb-floor-plus ${isOn ? 'mb-favorite-on' : 'mb-favorite-off'}" data-mb-favoriteuid="${uid}" data-mb-username="${safeUsername}" data-mb-mode="floor" title="${isOn ? '取消收藏该用户' : '收藏该用户'}">${starSvg}</span>`;
                    }
                    const tf = c.querySelector('.t_f');
                    let content = tf ? tf.innerHTML : '';
                    // 追加 .t_f 外的附件缩略图
                    const tfSrc = new Set(tf ? Array.from(tf.querySelectorAll('img')).map(i => i.getAttribute('zoomfile') || i.getAttribute('file') || i.src) : []);
                    c.querySelectorAll('.pcb .attach-thumb img.zoom, .pcb dl.attl img, .pcb p.attnm img, .t_fsz .pattl img.zoom').forEach(img => {
                        const origSrc = img.getAttribute('zoomfile') || img.getAttribute('file') || img.src;
                        if (!origSrc || tfSrc.has(origSrc)) return;
                        tfSrc.add(origSrc);
                        const newImg = document.createElement('img');
                        newImg.src = origSrc;
                        content += newImg.outerHTML;
                    });
                    const contentText = tf ? tf.innerText.trim() : '';
                    const timeEl = c.querySelector('[id^="authorpost"]');
                    const time = timeEl ? timeEl.innerHTML : '';
                    const postUrl = pageUrl.split('#')[0] + '#' + c.id;
                    const replyUrl = c.querySelector('.fastre');
                    const numEl = c.querySelector('.pi strong');
                    const postNum = numEl ? numEl.textContent.trim() : '';
                    if (postNum === '楼主') continue;
                    if (!contentText && !authi) continue;
                    newComments.push({ avatar, user, uid, username, content, contentText, time, postUrl, replyUrl, postNum });
                }
                this.comments.push(...newComments);
            },
            async loadNextPage(minCount) {
                if (minCount == null) minCount = this.commentsPerPage;
                if (minCount <= 0 || !this.nextPageUrl) return;
                if (!this.nextPageUrl.startsWith('http')) {
                    this.nextPageUrl = location.protocol + '//' + location.host + '/' + this.nextPageUrl;
                }
                this.isLoading = true;
                let text;
                try {
                    text = await httpGet(this.nextPageUrl, COMMENT_LOAD_TIMEOUT);
                } catch (e) {
                    this.isLoading = false;
                    if (MB.toast) MB.toast('评论加载失败，请刷新重试', 2000, 'error');
                    return;
                }
                // 用 DOMParser 解析，避免脱离文档的 innerHTML 仍触发图片等资源请求
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const comments$ = Array.from(doc.querySelectorAll('div[id^="post_"]:not([id^="post_ra"], [id^="post_new"])'));
                const prevCount = this.filteredComments.length;
                this.addComments(comments$, this.nextPageUrl);
                try {
                    const u = new URL(this.nextPageUrl);
                    const p = u.searchParams.get('page');
                    if (p) this.selectedPage = parseInt(p);
                    else this.selectedPage = parseInt(u.pathname.split('-').at(-2)) || this.selectedPage;
                } catch (e) {}
                const nxt = doc.querySelector('.nxt');
                this.nextPageUrl = nxt ? nxt.getAttribute('href') : '';
                this.isLoading = false;
                const remain = minCount - (this.filteredComments.length - prevCount);
                if (remain > 0) await this.loadNextPage(remain);
            },
            async onJumpToPage(pageNum) {
                let n = Math.floor(Number(pageNum));
                if (!Number.isFinite(n) || n < 1) n = 1;
                if (n > this.totalPages) n = this.totalPages;
                this.selectedPage = n;
                if (this.isLoading) return;
                const url = new URL(location.href);
                url.searchParams.set('page', n);
                url.hash = '';
                this.nextPageUrl = url.href;
                this.comments = [];
                await this.loadNextPage();
            },
            async onScroll(e) {
                const el = e.currentTarget;
                if (!el) return;
                if (el.clientHeight + el.scrollTop >= el.scrollHeight - 100 && !this.isLoading) {
                    await this.loadNextPage();
                }
            },
            backToTop() {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            },
            onToggle() {
                this.toggleOn = !this.toggleOn;
                if (this.$refs.app) {
                    if (this.toggleOn) this.$refs.app.style.width = this.appWidth + '%';
                    else this.$refs.app.style.width = '';
                }
                if (this.toggleOn && !this.hasInit) {
                    this.hasInit = true;
                    const comments$ = Array.from(document.querySelectorAll('div[id^="post_"]:not([id^="post_ra"], [id^="post_new"])'));
                    this.addComments(comments$, location.href);
                    this.checkAndLoadMore();
                }
            },
        },
        mounted() {
            this.appWidth = parseInt(userStore.get('mengbao.comment.width', 24)) || 24;
            this.$refs.app.style.width = this.appWidth + '%';
            this.minContentLength = parseInt(userStore.get('mengbao.comment.minLen', 1)) || 1;
            this.nickname = readStr('mengbao.panel.nickname', '萌宝');
            this.toggleOn = false; // 不再自动展开，由右键 FAB 控制
            // 评论区用户名右键接管：事件委托一次挂载，动态新增评论自动覆盖；设置里选「关闭」时放行原生菜单
            const jumpHost = this.$refs.app;
            if (jumpHost && !jumpHost.dataset.mbCmtJumpBound) {
                jumpHost.dataset.mbCmtJumpBound = '1';
                jumpHost.addEventListener('contextmenu', (e) => {
                    if (e.target.closest('.mb-floor-plus')) return;      // 点在收藏星标上，交给星标自己
                    const box = e.target.closest('.mb-comment-user');
                    if (!box) return;
                    const a = box.querySelector('a[href*="uid="]');
                    if (!a) return;
                    const m = (a.href || '').match(/uid=(\d+)/);
                    if (!m) return;
                    const url = typeof MB.resolveUserJump === 'function' ? MB.resolveUserJump(m[1]) : '';
                    if (!url) return;
                    e.preventDefault();
                    window.open(url, '_blank');
                });
            }
            // 自定义头像：用户可在设置里设 mengbao.comment.avatar 为图片 URL；未设置或仍是旧内置值时显示空态
            const commentRaw = readStr('mengbao.comment.avatar', '') || '';
            this.headerAvatar = /^builtin:[12]$/.test(commentRaw) ? '' : commentRaw;
            this.nextPageUrl = document.querySelector('.nxt') ? document.querySelector('.nxt').getAttribute('href') : '';
            this.replyThreadUrl = location.href.split('#')[0] + '#f_pst';
            try {
                this.selectedPage = parseInt(new URL(location.href).searchParams.get('page')) || 1;
            } catch (e) { this.selectedPage = 1; }
            const pgLabel = document.querySelector('.pg label span');
            if (pgLabel) {
                const m = pgLabel.textContent.match(/\d+/g);
                if (m) this.totalPages = parseInt(m[m.length - 1]) || 1;
            }
            // 总评论数
            const replyEl = Array.from(document.querySelectorAll('.hm .xi1'))[1];
            const replyText = replyEl ? replyEl.innerText : null;
            let parsed = replyText != null ? parseInt(replyText) : NaN;
            this.totalComments = !isNaN(parsed) ? parsed : this.totalPages * 10;
            // 暴露全局接口给左侧增强球右键调用
            const self = this;
            window.MengbaoCommentPanel = {
                toggle() {
                    self.onToggle();
                },
                open() { if (!self.toggleOn) window.MengbaoCommentPanel.toggle(); },
                close() { if (self.toggleOn) window.MengbaoCommentPanel.toggle(); },
                setNickname(v) {
                    if (!v) return;
                    self.nickname = v;
                },
            };
        },
        updated() {
            // v-html 插入的图片不带 loading 属性，长帖翻几页会同时发几百个请求
            this.$el.querySelectorAll('.mb-comment-content img').forEach(img => {
                if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
                if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'async');
            });
            // 给评论里的代码块绑定复制按钮
            this.$el.querySelectorAll('.mb-comment-content .blockcode').forEach(blk => {
                if (blk.dataset.mbBound) return;
                blk.dataset.mbBound = '1';
                blk.style.pointerEvents = 'auto';
                // 优先匹配.copytxt，没有再降级匹配javascript:链接
                const copyBtn = blk.querySelector('.copytxt') || blk.querySelector('a[href*="javascript:"]');
                if (copyBtn) {
                    copyBtn.style.pointerEvents = 'auto';
                    copyBtn.style.cursor = 'pointer';
                    copyBtn.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const text = blk.innerText.replace(/复制代码.*$/s, '').trim();
                        navigator.clipboard.writeText(text).then(() => {
                            if (MB.toast) MB.toast('链接已复制到剪贴板', 2000, 'success');
                        });
                    });
                }
            });
        },
    }).mount('#mb-comment-app');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
//（注：内容由AI生成）

