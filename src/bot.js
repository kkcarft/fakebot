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

        // 行为状态
        this.home = null;              // Vec3,出生点(用于随机移动的圆心)
        this.moveTarget = null;        // Vec3,当前移动目标
        this.moveCooldownTicks = 0;    // 距下一次选目标的剩余 tick
        this.chatCooldownTicks = 0;    // 距下一次聊天的剩余 tick

        // 鉴权状态(AuthMe 等):未验证前冻结移动/聊天
        this.authed = !(this.config.authme && this.config.authme.enabled);
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

        this.bot.on('login', () => {
            this.log.info(`[${this.name}] 握手通过,等待生成...`);
        });

        this.bot.on('spawn', () => {
            this.spawned = true;
            this.home = this.bot.entity.position.clone();
            this.log.info(`[${this.name}] 已生成于 ${this.home.toString()}`);
            this._initCooldowns();
            this._startTickLoop();
            if (this._authEnabled()) this._startAuth();
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

        // AuthMe 等验证插件:监听系统消息驱动登录状态机
        if (this._authEnabled()) {
            this.bot.on('message', (jsonMsg) => this._onAuthMessage(jsonMsg));
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
        if (!this.authed) return;   // AuthMe 未验证前不移动/不聊天(会被冻/被踢)
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
            // 1.19+ 签名聊天在某些情况下会被拒;降级为单向广播不可行(客户端没广播权限),
            // 这里仅记录警告,定时器仍会重置。
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

    // 在线判定:仅看是否已完成生成、且 bot 对象还在。
    // (这是僵尸修复之前的稳定版本:run #7 用它两 bot 稳了 13 分钟。
    //  代价:若服务器"静默断线"(无 FIN/RST、'end' 不触发)会留下假在线,
    //  但正常重启/踢出会被 'end'/'kicked' 捕获并自动重连,日常使用稳定。)
    isOnline() {
        return this.spawned && this.bot !== null;
    }

    getPosition() {
        if (!this.bot || !this.bot.entity) return null;
        const p = this.bot.entity.position;
        return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    }

    _cleanup() {
        this.spawned = false;
        this.authed = !(this.config.authme && this.config.authme.enabled);
        if (this._tickHandle) {
            clearInterval(this._tickHandle);
            this._tickHandle = null;
        }
        if (this.bot) {
            try { this.bot.clearControlStates(); } catch (_) {}
        }
    }

    /* ======================== 鉴权(AuthMe 等) ======================== */

    _authEnabled() {
        return !!(this.config.authme && this.config.authme.enabled);
    }

    _authPassword() {
        // 优先用 GitHub Actions Secret(避免明文进公开仓库),本地调试可放 config
        return process.env.AUTHME_PASSWORD || (this.config.authme && this.config.authme.password) || '';
    }

    _startAuth() {
        this.authed = false;
        const pw = this._authPassword();
        if (!pw) {
            this.log.warn(`[${this.name}] AuthMe 已启用但未配置密码,跳过验证(假人将被冻结/踢出)`);
            return;
        }
        setTimeout(() => {
            if (!this.bot || !this.bot.chat) return;
            if (this.config.authme && this.config.authme.preRegistered) {
                // 已在服务端后台(/authme register)预注册,直接登录即可
                this.bot.chat(`/login ${pw}`);
                this.log.info(`[${this.name}] AuthMe: 发送 /login`);
            } else {
                // 先注册(若同名已存在,AuthMe 会提示,随后 /login 仍可用),再登录
                this.bot.chat(`/register ${pw} ${pw}`);
                this.log.info(`[${this.name}] AuthMe: 发送 /register`);
                setTimeout(() => {
                    if (this.bot && this.bot.chat) {
                        this.bot.chat(`/login ${pw}`);
                        this.log.info(`[${this.name}] AuthMe: 发送 /login`);
                    }
                }, 1200);
            }
            // 兜底:若服务器自动登录/提示成功,乐观标记已验证(消息监听也会纠正)
            setTimeout(() => { this.authed = true; }, 2600);
        }, 1500);
    }

    _onAuthMessage(jsonMsg) {
        const text = (jsonMsg && typeof jsonMsg.toString === 'function') ? jsonMsg.toString() : '';
        const t = text.toLowerCase();
        if (t.includes('logged in') || t.includes('successfully') ||
            t.includes('登录成功') || t.includes('已登录') || t.includes('welcome')) {
            if (!this.authed) this.log.info(`[${this.name}] AuthMe 验证通过`);
            this.authed = true;
        } else if (t.includes('wrong password') || t.includes('incorrect') ||
                   t.includes('密码错误') || t.includes('失败')) {
            this.log.warn(`[${this.name}] AuthMe 密码错误,可能被踢,等待管理器重连`);
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
