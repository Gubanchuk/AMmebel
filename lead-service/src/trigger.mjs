// Messenger notification about a new lead, sent to a MAX chat. The message
// carries only the lead number and a button to its card in the admin panel:
// no personal data leaves the server this way.
//
// MAX Bot API, checked 13.09.2026 at https://dev.max.ru/docs-api/methods/POST/messages:
//   POST https://platform-api2.max.ru/messages?chat_id=<chat id>
//   Authorization: <bot token>          (the token is no longer accepted in the query)
//   Content-Type: application/json
//   {"text": "...", "attachments": [...]}  (text up to 4000 characters)
// Plain URLs in text are not documented as clickable, so the link goes as an
// inline_keyboard button of type "link" (checked 14.09.2026).
// The old host platform-api.max.ru was switched off on 19.07.2026. The new host
// uses a certificate chained to the Russian Trusted Root CA (Минцифры), which
// Node does not trust by default: point NODE_EXTRA_CA_CERTS at that root
// certificate (see README). MAX_API_URL overrides the host (tests, a relay).

export const MAX_API_URL = 'https://platform-api2.max.ru';

export function leadMessage(id) {
	return `Новая заявка №${id} с сайта`;
}

// Card of the lead in the Directus admin panel.
export function leadLink(adminUrl, id) {
	return new URL(`/admin/content/leads/${id}`, adminUrl).toString();
}

// The only place that knows the shape of the MAX request.
export function buildMaxRequest({ apiUrl = MAX_API_URL, token, chatId, text, link }) {
	const url = new URL('/messages', apiUrl);
	url.searchParams.set('chat_id', chatId);
	const body = { text };
	if (link) {
		body.attachments = [
			{
				type: 'inline_keyboard',
				payload: { buttons: [[{ type: 'link', text: 'Открыть заявку', url: link }]] },
			},
		];
	}
	return {
		url: url.toString(),
		init: {
			method: 'POST',
			headers: { authorization: token, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
	};
}

// Returns notify(id) -> Promise<boolean>, or null when MAX is not configured.
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

	return async function notify(id) {
		const link = adminUrl ? leadLink(adminUrl, id) : undefined;
		const { url, init } = buildMaxRequest({ apiUrl, token, chatId, text: leadMessage(id), link });
		try {
			const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
			await response.arrayBuffer().catch(() => {});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
