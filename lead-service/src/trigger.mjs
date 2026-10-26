// Messenger notification about a new lead, sent to a MAX chat. The message
// carries only the lead number and a button to its card in the admin panel,
// and for a VK lead the title and picture of the ad it answered: no personal
// data leaves the server this way.
//
// MAX Bot API, checked 13.09.2026 at https://dev.max.ru/docs-api/methods/POST/messages:
//   POST https://platform-api2.max.ru/messages?chat_id=<chat id>
//   Authorization: <bot token>          (the token is no longer accepted in the query)
//   Content-Type: application/json
//   {"text": "...", "attachments": [...]}  (text up to 4000 characters)
// Plain URLs in text are not documented as clickable, so the link goes as an
// inline_keyboard button of type "link" (checked 14.09.2026). A picture goes as
// {"type": "image", "payload": {"url": ...}}: MAX takes external image links
// and allows one keyboard next to an image (checked 26.10.2026 at
// https://dev.max.ru/docs-api/use-cases/sending-messages/media).
// The old host platform-api.max.ru was switched off on 19.07.2026. The new host
// uses a certificate chained to the Russian Trusted Root CA (Минцифры), which
// Node does not trust by default: point NODE_EXTRA_CA_CERTS at that root
// certificate (see README). MAX_API_URL overrides the host (tests, a relay).

export const MAX_API_URL = 'https://platform-api2.max.ru';

// ad is {title, image} of the VK banner the lead answered, or null.
export function leadMessage(id, source = 'site', ad = null) {
	if (source !== 'vk') return `Новая заявка №${id} с сайта`;
	return ad?.title ? `Новая заявка №${id} из VK\nОбъявление «${ad.title}»` : `Новая заявка №${id} из VK`;
}

// Card of the lead in the Directus admin panel.
export function leadLink(adminUrl, id) {
	return new URL(`/admin/content/leads/${id}`, adminUrl).toString();
}

// The only place that knows the shape of the MAX request.
export function buildMaxRequest({ apiUrl = MAX_API_URL, token, chatId, text, link, image }) {
	const url = new URL('/messages', apiUrl);
	url.searchParams.set('chat_id', chatId);
	const body = { text };
	const attachments = [];
	if (image) attachments.push({ type: 'image', payload: { url: image } });
	if (link) {
		attachments.push({
			type: 'inline_keyboard',
			payload: { buttons: [[{ type: 'link', text: 'Открыть заявку', url: link }]] },
		});
	}
	if (attachments.length > 0) body.attachments = attachments;
	return {
		url: url.toString(),
		init: {
			method: 'POST',
			headers: { authorization: token, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
	};
}

// Returns notify(id, source?, ad?) -> Promise<boolean>, or null when MAX is not
// configured. source is 'site' (default) or 'vk'; ad is {title, image} or null.
// Failures are logged and swallowed: e-mail and the database are the primary
// channels (spec §8).
export function createMaxNotifier({ env, log, fetchImpl = fetch, timeoutMs = 5_000 }) {
	const token = env.MAX_BOT_TOKEN;
	const chatId = env.MAX_CHAT_ID;
	if (!token || !chatId) {
		log('messenger notification disabled: MAX_BOT_TOKEN or MAX_CHAT_ID is not set');
		return null;
	}
	if (!/^-?\d+$/.test(chatId)) {
		log('messenger notification disabled: MAX_CHAT_ID must be a number');
		return null;
	}
	const apiUrl = env.MAX_API_URL || MAX_API_URL;
	const adminUrl = env.ADMIN_URL && URL.canParse(env.ADMIN_URL) ? env.ADMIN_URL : null;
	if (env.ADMIN_URL && !adminUrl) {
		log('messenger notification: ADMIN_URL is not a valid URL, messages go without the button');
	}

	async function post(text, link, image) {
		const { url, init } = buildMaxRequest({ apiUrl, token, chatId, text, link, image });
		const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		await response.arrayBuffer().catch(() => {});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
	}

	return async function notify(id, source, ad) {
		const link = adminUrl ? leadLink(adminUrl, id) : undefined;
		const text = leadMessage(id, source, ad);
		const image = ad?.image || undefined;
		try {
			try {
				await post(text, link, image);
			} catch (error) {
				// MAX downloads the picture itself; if it refuses the message,
				// the lead number still has to get through.
				if (!image || !error.message.startsWith('HTTP ')) throw error;
				log(`lead ${id} messenger notification with the ad picture failed: ${error.message}, sending without it`);
				await post(text, link);
			}
			log(`lead ${id} messenger notification sent`);
			return true;
		} catch (error) {
			const reason =
				error.name === 'TimeoutError' || error.name === 'AbortError'
					? 'timeout'
					: error.cause?.code || error.message;
			log(`lead ${id} messenger notification failed: ${reason}`);
			return false;
		}
	};
}
