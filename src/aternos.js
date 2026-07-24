'use strict';

const https = require('https');
const { URL } = require('url');

/**
 * Aternos 自动唤醒(可选 / 默认关闭)
 * --------------------------------------------------
 * 免费 Aternos 在无人时会自动停服;而假人直连 IP:端口无法唤醒一个
 * "已停止"的服 —— 只有 Aternos 面板/App 的 Start 能拉起它。
 * 本模块在检测到服务器确实离线时,用账号会话代你点一次 Start。
 *
 * ⚠️ 重要前提与风险:
 *   1. 需要你的 Aternos 账号(邮箱 + 密码)。请务必走环境变量
 *      ATERNOS_EMAIL / ATERNOS_PASSWORD,切勿把密码写进公开的 config.json。
 *   2. 这属于对 Aternos 非官方接口的"灰区"用法,可能违反其服务条款,
 *      且接口随时可能变动导致失效。请自行评估风险。
 *   3. 仅在你明确开启 config.aternos.enabled 时才生效;默认不启用,
 *      不影响原有保活行为。
 *   4. 接口形态(登录/启动路径、CSRF 令牌)按社区公开资料实现,未经真机验证,
 *      若失效需按 Aternos 最新接口微调。本模块所有异常都会记录并吞掉,
 *      绝不会拖垮保活主流程。
 */
class AternosWaker {
    constructor(config, logger) {
        this.log = logger;
        const a = (config && config.aternos) || {};
        this.enabled = !!a.enabled;
        this.email = process.env.ATERNOS_EMAIL || a.email || '';
        this.password = process.env.ATERNOS_PASSWORD || a.password || '';
        this.serverId = a.serverId || '';                 // 形如 soft-Qo7B
        this.minIntervalMs = (a.minIntervalSeconds || 300) * 1000;
        this._lastWake = 0;
        this._cookie = '';
        this._token = '';        // SEC_TOKEN / 登录令牌
        this._busy = false;
    }

    /**
     * 尝试唤醒服务器。返回 true 表示已发起一次启动请求(或仍在冷却)。
     * 任何异常都被吞掉并记录,绝不让唤醒逻辑拖垮保活主流程。
     */
    async wake() {
        if (!this.enabled) return false;
        if (!this.email || !this.password || !this.serverId) {
            this.log.warn('[Aternos] 唤醒已启用但缺少 email/password/serverId,跳过');
            return false;
        }
        const now = Date.now();
        if (now - this._lastWake < this.minIntervalMs) return false; // 冷却中
        if (this._busy) return false;
        this._busy = true;
        this._lastWake = now;
        try {
            await this._doWake();
            return true;
        } catch (e) {
            this.log.error(`[Aternos] 唤醒失败: ${e.message}`);
            return false;
        } finally {
            this._busy = false;
        }
    }

    async _doWake() {
        // 1) 登录拿会话
        const login = await this._postJson('https://account.aternos.org/api/user/login', {
            email: this.email,
            password: this.password
        });
        if (!login || !login.success) {
            throw new Error('登录失败: ' + JSON.stringify(login));
        }
        this.log.info('[Aternos] 登录成功,尝试启动服务器 ' + this.serverId);
        if (login.secToken) this._token = login.secToken;
        if (login.token) this._token = login.token;

        // 2) 启动服务器(社区公开接口形态;若失效需按最新接口微调)
        const startUrl = `https://${this.serverId}.aternos.org/api/server/start`;
        const res = await this._getJson(startUrl);
        this.log.info('[Aternos] 启动请求响应: ' + JSON.stringify(res));
    }

    /* ---------- 极简 HTTP 助手(内置 https,无外部依赖) ---------- */

    _req(method, urlStr, body) {
        return new Promise((resolve, reject) => {
            const u = new URL(urlStr);
            const data = body ? JSON.stringify(body) : null;
            const headers = {
                'User-Agent': 'Mozilla/5.0 (FakeBot-Waker)',
                'Accept': 'application/json',
                'Cookie': this._cookie || ''
            };
            if (data) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(data);
            }
            if (this._token) headers['SEC_TOKEN'] = this._token;

            const req = https.request({
                method,
                hostname: u.hostname,
                path: u.pathname + u.search,
                headers
            }, (res) => {
                const sc = res.headers['set-cookie'];
                if (sc) this._cookie = sc.map(c => c.split(';')[0]).join('; ');
                let buf = '';
                res.on('data', d => { buf += d; });
                res.on('end', () => {
                    let json = null;
                    try { json = buf ? JSON.parse(buf) : null; } catch (_) {}
                    resolve({ status: res.statusCode, body: buf, json });
                });
            });
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    async _postJson(url, body) {
        const r = await this._req('POST', url, body);
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`POST ${url} -> ${r.status}: ${r.body}`);
        }
        return r.json;
    }

    async _getJson(url) {
        const r = await this._req('GET', url, null);
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`GET ${url} -> ${r.status}: ${r.body}`);
        }
        return r.json;
    }
}

module.exports = AternosWaker;
