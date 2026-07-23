# FakeBot Client — 外部挂置式 Minecraft 假人客户端

> **外部、独立、一键启动**的假人程序。对服务端**零侵入**——不装插件、不改服务端代码，假人作为真实客户端连接服务器。

---

## 这是什么？

不是服务端插件，而是一个**独立运行的客户端程序**，通过标准 Minecraft 协议连入 Paper 服务器。服务器收到的就是一个普通玩家（走完握手 / 登录 / Mojang 签名聊天），所以：

- 进服广播、Tab 列表、玩家数据存档、聊天事件全部正常
- 服务端不需要安装任何东西，**无痕**
- 关闭程序假人就退出

参考了你提供的截图里 ViaVersion/ViaBackwards/ViaRewind 的思路 —— 那些是"协议翻译"型外挂，本工具是"假玩家"型外挂，走的是同一类思路：**完全外挂，不污染服务端**。

---

## 一键启动

### Windows

双击 `start.bat`。首次运行会自动 `npm install` 安装依赖，之后秒启。

### Linux / macOS

```bash
chmod +x start.sh
./start.sh
```

### 命令行

```bash
npm install           # 只在首次需要
npm start             # 默认读 config.json
node src/index.js my-config.json   # 指定其他配置
```

启动后进入交互式控制台，可输入：

| 指令 | 作用 |
|------|------|
| `spawn <名称>` | 手动加一个假人 |
| `remove <名称>` | 断开指定假人 |
| `list` | 查看当前在线假人 |
| `removeall` | 断开所有假人 |
| `quit` / `exit` | 退出程序 |

---

## 配置文件 `config.json`

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 25565 },  // 服务器地址
  "version": "1.21.11",                              // 协议版本(关键!)

  "bots": {
    "count": 3,                                      // 自动生成数量
    "names": ["Steve_2077", "Alex_Miner"],           // 名称列表(优先)
    "namePrefix": "Bot_",                            // 列表不够时用前缀+编号补
    "joinIntervalSeconds": 10                        // 每个间隔多少秒加入
  },

  "schedule": {
    "enabled": false,                                // 是否启用在线时间段
    "onlinePeriods": ["09:00-12:00", "18:00-23:59"]  // 支持跨天,如 "22:00-02:00"
  },

  "movement": {
    "enabled": true,
    "radius": 12.0,                                  // 活动半径(格)
    "intervalMinSeconds": 3,                         // 走动间隔下限
    "intervalMaxSeconds": 10,                        // 走动间隔上限
    "jumpChance": 0.15                               // 随机跳跃概率(0~1)
  },

  "chat": {
    "enabled": true,
    "intervalMinSeconds": 45,
    "intervalMaxSeconds": 180,
    "messages": ["今天挖到钻石了!", "233333"]        // 随机抽取的消息池
  }
}
```

---

## 服务端需要做什么？

**几乎不用。** 只需要在 `server.properties` 中确保：

```properties
online-mode=false   # 假人用离线登录(无需正版账号)
```

`true` 的话需要给每个假人配正版账号 —— 太麻烦，本工具默认走离线模式。如果你的服务器是 `online-mode=true` 但又不想改配置，请告诉我，我加一个 Mojang 正版账号批量登录的扩展。

---

## 关于协议版本 1.21.11

**重要提示**：`1.21.11` 是较新的版本，底层依赖 `mineflayer` 库需要相应更新才能识别。如果启动时报 `Unsupported protocol version`：

1. 临时方案：把 `config.json` 的 `version` 改成你实际能连的版本（如 `"1.21.4"`）
2. 长期方案：`npm update mineflayer minecraft-data` 拉到最新版

---

## 技术细节

- **依赖**：[`mineflayer`](https://github.com/PrismarineJS/mineflayer) — Minecraft 客户端协议库
- **连接流程**：完整 `Handshake → Login → Spawn`，1.19+ 自动处理 Mojang 聊天签名
- **行为模拟**：`setControlState('forward')` 持续走、`look()` 转 `yaw`、`jump` 随机跳；聊天通过 `bot.chat()` 走真实管道
- **反作弊友好**：所有移动都是真实协议包，服主端一般难以区分；但请遵守服务器规则使用

---

## 适用场景

- 压测服在线人数 / TPS
- 给小服"撑场面"提升活跃度
- 自动化测试（探索地图、聊天机器人）
- 服务器演示时显示有玩家

---

## 文件结构

```
FakeBotClient/
├── README.md              # 本文件
├── package.json           # 依赖声明
├── config.json            # 配置(可复制多份)
├── start.bat              # Windows 一键启动
├── start.sh               # Linux/macOS 一键启动
└── src/
    ├── index.js           # 主入口 + 交互控制台
    ├── manager.js         # 集群调度 + 时间段
    └── bot.js             # 单个假人(连接/移动/聊天)
```

---

## License

MIT — 工具责任自负，请勿用于违反服务器条款的场景。