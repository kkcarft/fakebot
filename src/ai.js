// src/ai.js —— OpenAI Chat Completions 兼容客户端(智谱 GLM / OpenAI / DeepSeek)
// 依赖 Node 22 自带 fetch,无需 npm install 任何新包。
//
// 设计要点(对应需求):
//  1) 玩家公屏回复按 replyChance(默认 0.2 = 20%) 概率触发,不每条都回。
//  2) getAmbient() 定时闲话用于防踢保活,此功能保留、不可删。
//  3) minIntervalMs 节流 + 429 自动退避,贴合 GLM 免费档限速。
//  4) 历史上下文超过 maxHistory(轮数)或 maxHistoryTokens(估算 token)后,
//     自动清空 history 开启新对话,不再无限堆长上下文。
//  5) 每个 bot 按序号钉死专属 key(需 AI_API_KEYS 里的 key 数 >= bot 数)。

const DEFAULT_SYSTEM =
  '你是 Minecraft Java 版服务器里一个挂机的真实玩家。你偶尔在公屏随口说点闲话，' +
  '也会自然回复别人。语气像真人，简短，不要解释、不要括号动作、不要引号。';

class AIClient {
  constructor(config, log, keySlot = 0) {
    const ai = (config && config.ai) || {};
    this.log = log || console;

    this.enabled = ai.enabled !== false;
    this.baseUrl = (ai.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
    this.model = ai.model || 'glm-4.7-flash';
    this.replyToPlayers = ai.replyToPlayers !== false;
    this.replyChance = (typeof ai.replyChance === 'number') ? ai.replyChance : 0.2; // 20%
    this.maxHistory = ai.maxHistory || 6;            // 最多保留的对话轮数(超出开新对话)
    this.maxHistoryTokens = ai.maxHistoryTokens || 1500; // 估算 token 上限(超出开新对话)
    this.temperature = (ai.temperature != null) ? ai.temperature : 0.9;
    this.maxTokens = ai.maxTokens || 60;
    this.systemPrompt = ai.systemPrompt || DEFAULT_SYSTEM;

    // 速率合规:默认 5s 间隔。GLM-4-Flash 免费档约 5 并发、GLM-4.7-Flash 约 30,
    // 5s 节流对本项目(2 bot + 低频)非常安全。可调大(更快)或调小(更保守)。
    this.minIntervalMs = ai.minIntervalMs || 5000;

    // 密钥:优先 config.ai.apiKeys,否则读环境变量 AI_API_KEYS(推荐,不进仓库)
    const envKeys = (process.env.AI_API_KEYS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const cfgKeys = (ai.apiKeys || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    this.keys = cfgKeys.length ? cfgKeys : envKeys;

    // 按 bot 序号钉死专属 key(Steve=key0, Alex=key1 ...)
    const k = Math.max(this.keys.length, 1);
    this._keyIdx = ((keySlot % k) + k) % k;

    this.usable = this.enabled && this.keys.length > 0 && !!ai.baseUrl;

    // 速率控制状态
    this._lastCallAt = 0;
    this._last429At = 0;
    this._retryAfterMs = 0;

    // 每个 bot 独立的玩家对话历史
    this.history = [];

    if (!this.usable) {
      this.log.warn('[AI] 不可用(未配置 key 或 baseUrl),将走随机话术池兜底');
    }
  }

  _currentKey() {
    if (!this.keys.length) return null;
    return this.keys[this._keyIdx % this.keys.length];
  }

  _rotateKey() {
    if (this.keys.length) this._keyIdx = (this._keyIdx + 1) % this.keys.length;
  }

  // 历史超限 → 自动开启新对话
  _fitHistory() {
    let estTokens = 0;
    for (const m of this.history) estTokens += Math.ceil(m.content.length / 2) + 4;
    if (this.history.length > this.maxHistory || estTokens > this.maxHistoryTokens) {
      this.history = [];
      this.log.info('[AI] 历史上下文超限,已自动开启新对话');
    }
  }

  async _call(messages) {
    if (!this.usable) return null;

    // 节流 + 429 退避
    const now = Date.now();
    const wait = Math.max(0, this.minIntervalMs - (now - this._lastCallAt));
    const backoff = Math.max(0, this._retryAfterMs - (now - this._last429At));
    const delay = Math.max(wait, backoff);
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    const key = this._currentKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens
        }),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      this._rotateKey();
      this.log.warn(`[AI] 网络错误: ${e.message}`);
      return null;
    }
    clearTimeout(timer);
    this._lastCallAt = Date.now();

    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      this._retryAfterMs = (ra ? parseInt(ra, 10) * 1000 : 10000);
      this._last429At = Date.now();
      this._rotateKey();
      this.log.warn(`[AI] 触发限速 429,退避 ${this._retryAfterMs}ms`);
      return null;
    }
    if (!res.ok) {
      this._rotateKey();
      this.log.warn(`[AI] HTTP ${res.status}`);
      return null;
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      return null;
    }
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  }

  // 定时闲话 —— 防踢保活功能,必须保留、不可删
  async getAmbient() {
    if (!this.usable) return null;
    const msgs = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: '（场景）你在服务器里挂机，随口说一句简短的闲话，像真人一样，不要解释、不要括号动作。' }
    ];
    return await this._call(msgs); // 不进玩家对话 history(与防踢闲话分开)
  }

  // 玩家公屏回复 —— 仅按 replyChance 概率触发(默认 20%)
  async getReply(username, message) {
    if (!this.usable) return null;
    if (!this.replyToPlayers) return null;
    if (Math.random() > this.replyChance) return null; // 只有 20% 概率接话

    this._fitHistory(); // 超限自动开新对话
    const msgs = [
      { role: 'system', content: this.systemPrompt },
      ...this.history,
      { role: 'user', content: `${username} 说：${message}。简短自然地回一句。` }
    ];
    const text = await this._call(msgs);
    if (text) {
      this.history.push({ role: 'user', content: message });
      this.history.push({ role: 'assistant', content: text });
    }
    return text;
  }

  // 供外部显式开新对话
  resetConversation() {
    this.history = [];
  }
}

module.exports = AIClient;
