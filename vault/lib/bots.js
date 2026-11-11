'use strict';
// Боты Telegram и ВКонтакте: вход по одноразовому коду и рассылка оповещений.
// Оба работают через long polling, поэтому вебхуки и HTTPS-сертификат для них не нужны.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CODE_RE = /^[A-Z0-9]{6}$/;

class Bots {
  /**
   * @param cfg  { tgToken, tgApiBase, vkToken, vkGroupId, baseUrl }
   * @param bind (code, provider, providerId, displayName) => boolean — привязать код входа
   */
  constructor(cfg, bind, log = console) {
    this.cfg = cfg;
    this.bind = bind;
    this.log = log;
  }

  start() {
    if (this.cfg.tgToken) this.tgLoop();
    if (this.cfg.vkToken && this.cfg.vkGroupId) this.vkLoop();
  }

  replyFor(text, provider, id, name) {
    const code = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (CODE_RE.test(code)) {
      return this.bind(code, provider, id, name)
        ? 'Готово! Возвращайся на сайт — вход выполнен. Сюда я буду присылать оповещения, когда откроется новый замок.'
        : 'Код не найден или устарел. Открой сайт, нажми «Войти» и пришли новый код.';
    }
    return `Это бот игры «Хранилище». Чтобы войти, открой сайт ${this.cfg.baseUrl}, нажми «Войти» и пришли мне код из 6 символов.`;
  }

  // ---------- Telegram ----------
  async tg(method, params) {
    const base = this.cfg.tgApiBase || 'https://api.telegram.org';
    const r = await fetch(`${base}/bot${this.cfg.tgToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(40000),
    });
    return r.json();
  }

  async tgLoop() {
    let offset = 0;
    for (;;) {
      try {
        const r = await this.tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        if (!r.ok) { this.log.error('telegram:', r.description); await sleep(5000); continue; }
        for (const u of r.result) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text || !m.chat || m.chat.type !== 'private') continue;
          const start = m.text.match(/^\/start(?:@\w+)?\s+(\S+)/);
          const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ');
          const reply = this.replyFor(start ? start[1] : m.text, 'tg', String(m.from.id), name);
          this.tg('sendMessage', { chat_id: m.chat.id, text: reply }).catch(() => {});
        }
      } catch (e) {
        this.log.error('telegram:', e.message);
        await sleep(5000);
      }
    }
  }

  // ---------- ВКонтакте ----------
  async vk(method, params) {
    const body = new URLSearchParams({ ...params, access_token: this.cfg.vkToken, v: '5.199' });
    const r = await fetch('https://api.vk.com/method/' + method, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.error_msg}`);
    return j.response;
  }

  async vkLoop() {
    let s = null;
    for (;;) {
      try {
        if (!s) s = await this.vk('groups.getLongPollServer', { group_id: this.cfg.vkGroupId });
        const r = await fetch(`${s.server}?act=a_check&key=${s.key}&ts=${s.ts}&wait=25`, { signal: AbortSignal.timeout(40000) });
        const j = await r.json();
        if (j.failed) { if (j.failed === 1) s.ts = j.ts; else s = null; continue; }
        s.ts = j.ts;
        for (const u of j.updates || []) {
          if (u.type !== 'message_new') continue;
          const m = u.object && (u.object.message || u.object);
          if (!m || !(m.from_id > 0)) continue;
          this.onVk(m).catch(e => this.log.error('vk:', e.message));
        }
      } catch (e) {
        this.log.error('vk:', e.message);
        s = null;
        await sleep(5000);
      }
    }
  }

  async onVk(m) {
    let name = '';
    try {
      const u = await this.vk('users.get', { user_ids: m.from_id });
      if (u && u[0]) name = `${u[0].first_name} ${u[0].last_name}`;
    } catch { /* имя не критично */ }
    const reply = this.replyFor(m.text, 'vk', String(m.from_id), name);
    await this.vk('messages.send', { user_id: m.from_id, random_id: Math.floor(Math.random() * 2 ** 31), message: reply });
  }

  // ---------- Отправка ----------
  async send(user, text) {
    if (user.provider === 'tg' && this.cfg.tgToken) {
      const r = await this.tg('sendMessage', { chat_id: user.provider_id, text });
      if (!r.ok) throw new Error(r.description);
    } else if (user.provider === 'vk' && this.cfg.vkToken) {
      await this.vk('messages.send', { user_id: user.provider_id, random_id: Math.floor(Math.random() * 2 ** 31), message: text });
    }
  }

  /** Рассылка всем: по очереди и с паузой, чтобы не упереться в лимиты мессенджеров. */
  async broadcast(users, text) {
    let ok = 0, fail = 0;
    for (const u of users) {
      try { await this.send(u, text); ok++; } catch { fail++; }
      await sleep(60);
    }
    this.log.log(`рассылка: доставлено ${ok}, ошибок ${fail}`);
    return { ok, fail };
  }
}

module.exports = { Bots };
