'use strict';

const fs = require('fs');
const path = require('path');
const BotManager = require('./manager');

/* ========== 健康检查 HTTP 端口(防云平台休眠) ==========
 * Koyeb / Render 等免费容器在长时间无 HTTP 流量时会休眠,
 * 这里启动一个最小 HTTP 服务供 cron-job.org 定期 ping,
 * 既防止容器休眠,又顺便当状态页。
 */
const HEALTH_PORT = Number(process.env.PORT || process.env.HEALTH_PORT || 3000);
const http = require('http');
const healthServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        const rows = manager.list();
        const online = rows.filter(r => r.online).length;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`FakeBot 运行中 | 在线假人: ${online}/${rows.length} | 上次心跳: ${new Date().toISOString()}`);
    } else {
        res.writeHead(404); res.end('not found');
    }
});
healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info(`健康检查端口已开放: http://0.0.0.0:${HEALTH_PORT}/`);
});

/* ========== 简易日志器(彩色) ========== */
const c = {
    reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m',
    yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m'
};
const ts = () => new Date().toTimeString().slice(0, 8);
const logger = {
    info:  (m) => console.log(`${c.gray}${ts()}${c.reset} ${c.green}[INFO]${c.reset}  ${m}`),
    warn:  (m) => console.log(`${c.gray}${ts()}${c.reset} ${c.yellow}[WARN]${c.reset}  ${m}`),
    error: (m) => console.log(`${c.gray}${ts()}${c.reset} ${c.red}[ERROR]${c.reset} ${m}`),
    debug: (m) => process.env.DEBUG && console.log(`${c.gray}${ts()}${c.reset} ${c.cyan}[DBG]${c.reset}   ${m}`)
};

/* ========== 加载配置 ==========
 * 查找顺序:
 *   1. 命令行参数指定的路径
 *   2. exe / 项目 同目录下的 config.json
 *   3. (打包成 exe 时) 内置默认配置,并自动在 exe 旁生成一份供修改
 */
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
let configPath = process.argv[2] || path.join(baseDir, 'config.json');

if (!fs.existsSync(configPath)) {
    const embedded = path.join(__dirname, '..', 'config.json'); // pkg 快照内的默认配置
    if (isPkg && fs.existsSync(embedded)) {
        const defaults = fs.readFileSync(embedded, 'utf8');
        configPath = path.join(baseDir, 'config.json');
        fs.writeFileSync(configPath, defaults);
        logger.warn(`未找到配置文件,已在 exe 同目录生成默认配置: ${configPath}`);
        logger.warn('请修改其中的服务器地址后重新启动。');
    } else {
        logger.error(`未找到配置文件: ${configPath}`);
        process.exit(1);
    }
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
logger.info(`已加载配置: ${configPath}`);

/* ========== 校验 ========== */
function validate(cfg) {
    if (!cfg.server?.host || !cfg.server?.port) throw new Error('config.server.host/port 必填');
    if (!cfg.version) throw new Error('config.version 必填 (例如 "1.21.11")');
    if (!cfg.bots?.count || cfg.bots.count < 1) throw new Error('config.bots.count 必须 >= 1');
    if ((cfg.schedule?.onlinePeriods || []).length === 0) cfg.schedule.enabled = false;
}
try { validate(config); } catch (e) { logger.error(e.message); process.exit(1); }

/* ========== 启动 ========== */
const manager = new BotManager(config, logger);
manager.start();

/* ========== 简易交互式指令(避免引入额外依赖) ========== */
const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
console.log('控制台指令: spawn <名称> | remove <名称> | list | removeall | quit');
function prompt() { readline.question('> ', handleLine); }
function handleLine(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
        case 'list':
            const rows = manager.list();
            if (rows.length === 0) console.log('  (无)');
            else rows.forEach(r => console.log(`  - ${r.name} [${r.online ? '在线' : '连接中'}] @ ${r.position || '?'}`));
            break;
        case 'spawn':
            if (!arg) { console.log('用法: spawn <名称>'); break; }
            manager.spawn(arg).catch(e => console.log(`失败: ${e.message}`));
            break;
        case 'remove':
            if (!arg) { console.log('用法: remove <名称>'); break; }
            console.log(manager.remove(arg) ? '已断开' : '未找到');
            break;
        case 'removeall':
            manager.removeAll(); console.log('全部断开');
            break;
        case 'quit':
        case 'exit':
            manager.shutdown(); readline.close(); return;
        case 'help':
        case '?':
            console.log('  spawn <名称> / remove <名称> / list / removeall / quit');
            break;
        case '':
            break;
        default:
            console.log('未知指令,输入 help 查看');
    }
    prompt();
}
prompt();

/* ========== 优雅退出 ========== */
process.on('SIGINT', () => { manager.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { manager.shutdown(); process.exit(0); });