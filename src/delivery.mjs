/**
 * src/delivery.mjs
 * Deliver one scan result to Telegram exactly once.
 *
 * RULES
 *   1. If a VERIFIED image exists → sendPhoto with the standard card as caption.
 *   2. Otherwise                  → sendMessage with the same card.
 *   3. If sendPhoto is rejected (bad media URL, unparseable caption, too long)
 *      → fall back to sendMessage ONCE. Never emit both for one scan.
 *   4. Caption limit is 1024 characters of VISIBLE text after entity parsing.
 *      The card is measured on its visible characters, not its HTML source. If it
 *      cannot fit, the text card is used rather than truncating the CA or a risk
 *      warning.
 *
 * The caller supplies the already-rendered text and keyboard so this module has
 * no opinion about design.
 */

/** Telegram's photo-caption ceiling, measured on rendered characters. */
export const CAPTION_LIMIT = 1024;

/**
 * Visible length of a Telegram HTML string: tags are not counted, and HTML
 * entities collapse to the single character they represent.
 */
export function visibleLength(html) {
  if (typeof html !== 'string') return 0;
  const stripped = html.replace(/<[^>]*>/g, '');
  // Entities: &amp; &lt; &gt; &quot; &#8203; etc. each render as ONE character
  // (or zero for zero-width), so collapse any entity to a single unit.
  const collapsed = stripped.replace(/&#\d+;|&#x[0-9a-fA-F]+;|&[a-zA-Z]+;/g, 'x');
  return collapsed.length;
}

/** True when the card can be used as a photo caption. */
export function captionFits(text, limit = CAPTION_LIMIT) {
  return visibleLength(text) <= limit;
}

function buildKeyboard(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) return undefined;
  return { inline_keyboard: buttons };
}

/**
 * Send one card to a chat.
 *
 * @returns {{
 *   ok: boolean, kind: 'photo'|'text', messageId: number|null,
 *   text: string|null, entities: string[], customEmoji: number,
 *   buttons: number, fellBack: boolean, fallbackReason: string|null,
 *   captionLength: number|null, detail: string|null
 * }}
 */
export async function deliverCard({
  telegram,
  chatId,
  text,
  buttons = [],
  imageUrl = null,
  replyToMessageId = null,
}) {
  const keyboard = buildKeyboard(buttons);
  const visLen = visibleLength(text);

  const fail = (detail, kind = 'text') => ({
    ok: false, kind, messageId: null, text: null, entities: [], customEmoji: 0,
    buttons: 0, fellBack: false, fallbackReason: null, captionLength: null, detail,
  });

  // ---- 1. Try the photo path ------------------------------------------
  if (imageUrl) {
    if (captionFits(text)) {
      try {
        const msg = await telegram.sendPhoto(chatId, imageUrl, {
          caption: text,
          parse_mode: 'HTML',
          ...(keyboard ? { reply_markup: keyboard } : {}),
          ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
        });
        const caption = msg?.caption ?? '';
        return {
          ok: true, kind: 'photo', messageId: msg?.message_id ?? null,
          text: caption, entities: (msg?.caption_entities ?? []).map((e) => e.type),
          customEmoji: (msg?.caption_entities ?? []).filter((e) => e.type === 'custom_emoji').length,
          buttons: (msg?.reply_markup?.inline_keyboard ?? []).flat().length,
          fellBack: false, fallbackReason: null, captionLength: visibleLength(caption), detail: null,
        };
      } catch (err) {
        // Fall through to the text card. The reason is reported, not swallowed.
        const reason = err?.description ?? err?.message ?? 'photo send failed';
        return sendTextFallback({ telegram, chatId, text, keyboard, replyToMessageId, visLen, reason });
      }
    }
    // Caption too long: do not truncate the CA or a risk warning.
    return sendTextFallback({
      telegram, chatId, text, keyboard, replyToMessageId, visLen,
      reason: `caption too long (${visLen} > ${CAPTION_LIMIT} visible chars)`,
    });
  }

  // ---- 2. No image → plain text card ----------------------------------
  return sendTextFallback({ telegram, chatId, text, keyboard, replyToMessageId, visLen, reason: null });
}

/** The single text send. Used directly and as the photo fallback. */
async function sendTextFallback({ telegram, chatId, text, keyboard, replyToMessageId, visLen, reason }) {
  try {
    const msg = await telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    });
    return {
      ok: true, kind: 'text', messageId: msg?.message_id ?? null,
      text: msg?.text ?? '', entities: (msg?.entities ?? []).map((e) => e.type),
      customEmoji: (msg?.entities ?? []).filter((e) => e.type === 'custom_emoji').length,
      buttons: (msg?.reply_markup?.inline_keyboard ?? []).flat().length,
      fellBack: Boolean(reason), fallbackReason: reason, captionLength: null, detail: null,
    };
  } catch (err) {
    return {
      ok: false, kind: 'text', messageId: null, text: null, entities: [], customEmoji: 0,
      buttons: 0, fellBack: Boolean(reason), fallbackReason: reason,
      captionLength: visLen, detail: err?.description ?? err?.message ?? 'text send failed',
    };
  }
}
