'use strict';

const mineflayer = require('mineflayer');

/**
 * 单个外部假人。
 * 通过真实 Minecraft 协议连接服务器,服务器看到的与真玩家完全一致:
 *   - 完整握手 (握手包 + 登录包 + Mojang 签名聊天)
 *   - 触发 PlayerJoinEvent / PlayerQuitEvent
 *   - 出现在 TAB 列表、计入在线人数
 *   - 服务器无任何代码修改,纯外挂
 */
class Bot {
    constructor(config, name, logger) {
        this.config = config;
        this.name = name;
        this.log = logger;

        this.bot = null;
        this.spawned = false;
        this.createdAt = Date.now();   // 供掉线自动重连检测使用
        this.lastActivity = Date.now(); // 最近一次收到服务器通信(含 keepalive)的时间,用于僵尸连接检测

        // 行为状态
        this.home = null;              // Vec3,出生点(用于随机移动的圆心)
        this.moveTarget = null;        // Vec3,当前移动目标
        this.moveCooldownTicks = 0;    // 距下一次选目标的剩余 tick
        this.chatCooldownTicks = 0;    // 距下一次聊天的剩余 tick
    }

    async connect() {
        this.log.info(`[${this.name}] 正在连接 ${this.config.server.host}:${this.config.server.port} ...`);

        this.bot = mineflayer.createBot({
            host: this.config.server.host,
            port: this.config.server.port,
            username: this.name,
            version: this.config.version,
            auth: 'offline',           // 离线模式(需服务端 online-mode=false)
            skipValidation: true,
            hideErrors: false
        });

        // 开启 TCP 保活:服务器单方面断开(无 FIN/RST)时,操作系统能更快发现断线
        if (this.bot.socket && typeof this.bot.socket.setKeepAlive === 'function') {
            this.bot.socket.setKeepAlive(true, 10000);
        }
        // 监听底层 keepalive 包 —— 这是“服务器还活着”的最可靠证据
        if (this.bot._client && typeof this.bot._client.on === 'function') {
            this.bot._client.on('keep_alive', () => { this.lastActivity = Date.now(); });
        }

        this.bot.on('login', () => {
            this.lastActivity = Date.now();
            this.log.info(`[${this.name}] 握手通过,等待生成...`);
        });

        this.bot.on('spawn', () => {
            this.spawned = true;
            this.home = this.bot.entity.position.clone();
            this.lastActivity = Date.now();
            this.log.info(`[${this.name}] 已生成于 ${this.home.toString()}`);
            this._initCooldowns();
            this._startTickLoop();
        });

        this.bot.on('kicked', (reason) => {
            this.log.warn(`[${this.name}] 被服务端踢出: ${this._stripJson(reason)}`);
            this._cleanup();
        });

        this.bot.on('error', (err) => {
            this.log.error(`[${this.name}] 连接错误: ${err.message}`);
        });

        this.bot.on('end', () => {
            this.log.info(`[${this.name}] 连接已断开`);
            this._cleanup();
        });

        // 任何常规通信也算活跃(兜底,防止 keepalive 钩子失效时误判为僵尸)
        for (const ev of ['chat', 'healthChanged', 'playerJoined', 'playerLeft', 'blockUpdate']) {
            this.bot.on(ev, () => { this.lastActivity = Date.now(); });
        }
    }

    /* ======================== 行为模拟 ======================== */

    _initCooldowns() {
        this.moveCooldownTicks = this._randTicks(this.config.movement.intervalMinSeconds,
                                                  this.config.movement.intervalMaxSeconds);
        this.chatCooldownTicks = this._randTicks(this.config.chat.intervalMinSeconds,
                                                  this.config.chat.intervalMaxSeconds);
    }

    _startTickLoop() {
        // 50ms ≈ 20 TPS,与服务器同步
        this._tickHandle = setInterval(() => this._tick(), 50);
    }

    _tick() {
        if (!this.spawned || !this.bot || !this.bot.entity) return;
        try {
            if (this.config.movement.enabled) this._tickMovement();
            if (this.config.chat.enabled) this._tickChat();
        } catch (e) {
            this.log.error(`[${this.name}] tick 异常: ${e.message}`);
        }
    }

    _tickMovement() {
        if (this.moveCooldownTicks > 0) {
            this.moveCooldownTicks--;
            this.bot.clearControlStates();
            return;
        }
        if (!this.moveTarget) {
            this._pickNewTarget();
            this.moveCooldownTicks = 20 + Math.floor(Math.random() * 40);
            return;
        }

        const pos = this.bot.entity.position;
        const dx = this.moveTarget.x - pos.x;
        const dz = this.moveTarget.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.5) {
            this.moveTarget = null;
            this.bot.clearControlStates();
            this.moveCooldownTicks = this._randTicks(this.config.movement.intervalMinSeconds,
                                                    this.config.movement.intervalMaxSeconds);
            return;
        }

        // 朝向目标(mineflayer 使用度数,且 -180~180)
        const yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
        this.bot.look(yaw, 0, true);

        // 持续前进来"模拟走"
        this.bot.setControlState('forward', true);

        // 随机跳跃
        if (Math.random() < this.config.movement.jumpChance / 20) {
            this.bot.setControlState('jump', true);
            setTimeout(() => this.bot.setControlState('jump', false), 100);
        }
    }

    _pickNewTarget() {
        const angle = Math.random() * Math.PI * 2;
        const r = (0.3 + Math.random() * 0.7) * this.config.movement.radius;
        this.moveTarget = this.home.offset(
            Math.cos(angle) * r,
            0,
            Math.sin(angle) * r
        );
    }

    _tickChat() {
        if (this.chatCooldownTicks > 0) {
            this.chatCooldownTicks--;
            return;
        }
        const pool = this.config.chat.messages;
        if (!pool || pool.length === 0) return;
        const msg = pool[Math.floor(Math.random() * pool.length)];
        try {
            this.bot.chat(msg);
            this.log.debug(`[${this.name}] 聊天: ${msg}`);
        } catch (e) {
            this.log.warn(`[${this.name}] 聊天失败(可能被聊天签名拦截): ${e.message}`);
        }
        this.chatCooldownTicks = this._randTicks(this.config.chat.intervalMinSeconds,
                                                  this.config.chat.intervalMaxSeconds);
    }

    /* ======================== 生命周期 ======================== */

    disconnect() {
        if (this.bot) {
            try { this.bot.quit(); } catch (_) {}
        }
        this._cleanup();
    }

    isOnline() {
        if (!this.spawned || !this.bot || !this.bot.socket) return false;
        const sock = this.bot.socket;
        if (sock.destroyed || sock.connected === false) return false;
        // 僵尸连接检测: 90 秒内未收到服务器任何包(含 keepalive),
        // 说明连接已被服务器单方面断开但本端未收到 FIN/RST,强制判定掉线以便重连。
        if (this.lastActivity && Date.now() - this.lastActivity > 90 * 1000) return false;
        return true;
    }

    getPosition() {
        if (!this.bot || !this.bot.entity) return null;
        const p = this.bot.entity.position;
        return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    }

    _cleanup() {
        this.spawned = false;
        this.lastActivity = 0;
        if (this._tickHandle) {
            clearInterval(this._tickHandle);
            this._tickHandle = null;
        }
        if (this.bot) {
            try { this.bot.clearControlStates(); } catch (_) {}
        }
    }

    /* ======================== 工具 ======================== */

    _randTicks(minSec, maxSec) {
        const min = Math.max(1, Math.floor(minSec * 20));
        const max = Math.max(min, Math.floor(maxSec * 20));
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    _stripJson(reason) {
        if (typeof reason === 'string') return reason;
        try { return JSON.stringify(reason); } catch (_) { return String(reason); }
    }
}

module.exports = Bot;
