'use strict';

const Bot = require('./bot');

/**
 * 假人集群管理器:
 *   - 自动按配置批量加入(带间隔)
 *   - 在线时间段调度
 *   - 优雅全量退出
 */
class BotManager {
    constructor(config, logger) {
        this.config = config;
        this.log = logger;
        this.bots = new Map();         // name -> Bot
        this._autoOnline = false;
        this._scheduleTimer = null;
        this._spawnTimers = new Set();
    }

    start() {
        this.log.info(`FakeBot 已启动,目标服务器 ${this.config.server.host}:${this.config.server.port} 协议 ${this.config.version}`);
        this._scheduleTick();
        this._scheduleTimer = setInterval(() => this._scheduleTick(), 30 * 1000);
        // 断线自动重连:每 90 秒检查一次,掉线的假人自动重新连接
        // (云端 24/7 场景必备:目标服务器重启后假人自动回归)
        this._reconnectTimer = setInterval(() => this._checkReconnect(), 90 * 1000);
    }

    shutdown() {
        if (this._scheduleTimer) clearInterval(this._scheduleTimer);
        if (this._reconnectTimer) clearInterval(this._reconnectTimer);
        for (const t of this._spawnTimers) clearTimeout(t);
        this._spawnTimers.clear();
        this.removeAll();
    }

    _checkReconnect() {
        if (!this._autoOnline) return;
        for (const [name, bot] of [...this.bots.entries()]) {
            // 创建至少 2 分钟后仍不在线才视为掉线(避开正常连接过程)
            if (!bot.isOnline() && Date.now() - bot.createdAt > 120 * 1000) {
                this.log.warn(`检测到假人 ${name} 掉线,尝试重连...`);
                this.remove(name);
                this.spawn(name).catch(e =>
                    this.log.error(`重连 ${name} 失败(下轮再试): ${e.message}`));
            }
        }
    }

    /* ======================== 调度 ======================== */

    _scheduleTick() {
        const shouldOnline = !this.config.schedule.enabled
            || this._withinAnyPeriod(new Date());

        if (shouldOnline && !this._autoOnline) {
            this._autoOnline = true;
            this._enqueueAutoSpawn();
        } else if (!shouldOnline && this._autoOnline) {
            this._autoOnline = false;
            this._removeAuto();
        }
    }

    _withinAnyPeriod(now) {
        const minutes = now.getHours() * 60 + now.getMinutes();
        for (const period of this.config.schedule.onlinePeriods || []) {
            const [s, e] = period.split('-').map(p => {
                const [h, m] = p.trim().split(':').map(Number);
                return h * 60 + m;
            });
            if (s === e) return true; // 全天
            if (s < e) return minutes >= s && minutes < e;
            return minutes >= s || minutes < e; // 跨天
        }
        return true;
    }

    /* ======================== 生成 / 移除 ======================== */

    _enqueueAutoSpawn() {
        const count = this.config.bots.count;
        const intervalSec = this.config.bots.joinIntervalSeconds;
        for (let i = 0; i < count; i++) {
            const name = this._resolveName(i);
            if (this.bots.has(name)) continue;
            const delay = i * intervalSec * 1000;
            const t = setTimeout(() => {
                this._spawnTimers.delete(t);
                this.spawn(name).catch(e => this.log.error(`自动生成 ${name} 失败: ${e.message}`));
            }, delay);
            this._spawnTimers.add(t);
        }
    }

    _resolveName(index) {
        const list = this.config.bots.names || [];
        if (index < list.length && list[index]) return String(list[index]).trim();
        return (this.config.bots.namePrefix || 'Bot_') + (index + 1);
    }

    async spawn(name) {
        if (this.bots.has(name)) throw new Error(`假人 ${name} 已在集群中`);
        const bot = new Bot(this.config, name, this.log);
        this.bots.set(name, bot);
        await bot.connect();
        return bot;
    }

    remove(name) {
        const bot = this.bots.get(name);
        if (!bot) return false;
        bot.disconnect();
        this.bots.delete(name);
        this.log.info(`已断开假人 ${name}`);
        return true;
    }

    removeAll() {
        for (const name of [...this.bots.keys()]) this.remove(name);
    }

    _removeAuto() {
        // 自动调度的假人通过 Bot.isOnline() 无法区分,这里以"非手动"为策略:
        // 当前简化:调度下线 = 全部断开。需要精细化时可加 manual 标记。
        for (const name of [...this.bots.keys()]) this.remove(name);
        this.log.info('调度器触发下线,所有假人已断开');
    }

    list() {
        return [...this.bots.entries()].map(([name, bot]) => ({
            name,
            online: bot.isOnline(),
            position: bot.getPosition()
        }));
    }
}

module.exports = BotManager;