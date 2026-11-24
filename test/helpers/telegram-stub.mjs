/**
 * test/helpers/telegram-stub.mjs
 *
 * Telegraf builds a fresh `ctx.telegram` client per update from the bot token, so
 * replacing `bot.telegram` does NOT intercept what handlers actually call. The
 * network boundary is `Telegram.prototype.callApi`, so that is what we replace.
 *
 * Verified: without this, a handler under test throws "401: Bot Token is required"
 * from the real client and the test sees no output at all — which is exactly how
 * the routing bug went unnoticed.
 */
import { Telegram } from 'telegraf';

/**
 * Install a recording stub on the Telegram client.
 * @returns {{sent: Array<{method: string, payload: object}>, restore: () => void}}
 */
export function installTelegramStub() {
  const sent = [];
  const original = Telegram.prototype.callApi;

  Telegram.prototype.callApi = async function callApi(method, payload = {}) {
    sent.push({ method, payload });
    if (method === 'getMe') {
      return { id: 1, is_bot: true, first_name: 'MemeChecker', username: 'MemeCheckerStagingBot' };
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { message_id: sent.length, chat: { id: payload.chat_id }, text: payload.text };
    }
    if (method === 'sendPhoto') {
      return { message_id: sent.length, chat: { id: payload.chat_id }, photo: [{ file_id: 'x' }] };
    }
    if (method === 'getChat') {
      return { id: payload.chat_id, type: 'supergroup', title: 'sissooo1' };
    }
    return true;
  };

  return {
    sent,
    restore() { Telegram.prototype.callApi = original; },
  };
}

/** A group text update, with the bot_command entity Telegram would attach. */
export function textUpdate(text, { chatId = -5333984336, chatType = 'group', userId = 1307106746, title = 'sissooo1' } = {}) {
  const entities = [];
  const m = /^\/\w+(@\w+)?/.exec(text);
  if (m) entities.push({ type: 'bot_command', offset: 0, length: m[0].length });
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatType, ...(chatType === 'private' ? {} : { title }) },
      from: { id: userId, is_bot: false, first_name: 'Foxy', username: 'Foxydegenzu' },
      text,
      entities,
    },
  };
}

/** A callback-query update for an inline button. */
export function callbackUpdate(data, { chatId = -5333984336, userId = 1307106746, messageId = 99 } = {}) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: String(Math.floor(Math.random() * 1e9)),
      from: { id: userId, is_bot: false, first_name: 'Foxy', username: 'Foxydegenzu' },
      chat_instance: '1',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'group', title: 'sissooo1' },
        text: 'previous profile',
        entities: [],
      },
    },
  };
}
