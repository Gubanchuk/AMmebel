// Messenger notification about a new lead, sent to a MAX chat. The message
// carries only the lead number: no personal data leaves the server this way.
//
// MAX Bot API, checked 13.09.2026 at https://dev.max.ru/docs-api/methods/POST/messages:
//   POST https://platform-api2.max.ru/messages?chat_id=<chat id>
//   Authorization: <bot token>          (the token is no longer accepted in the query)
//   Content-Type: application/json
//   {"text": "..."}                     (up to 4000 characters)
// The old host platform-api.max.ru was switched off on 19.07.2026. The new host
// uses a certificate chained to the Russian Trusted Root CA (Минцифры), which
// Node does not trust by default: point NODE_EXTRA_CA_CERTS at that root
// certificate (see README). MAX_API_URL overrides the host (tests, a relay).

export const MAX_API_URL = 'https://platform-api2.max.ru';

export function leadMessage(id) {
	return `Новая заявка №${id} с сайта — откройте админку`;
}

// The only place that knows the shape of the MAX request.
export function buildMaxRequest({ apiUrl = MAX_API_URL, token, chatId, text }) {
	const url = new URL('/messages', apiUrl);
	url.searchParams.set('chat_id', chatId);
	return {
		url: url.toString(),
		init: {
			method: 'POST',
			headers: { authorization: token, 'content-type': 'application/json' },
			body: JSON.stringify({ text }),
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

	return async function notify(id) {
		const { url, init } = buildMaxRequest({ apiUrl, token, chatId, text: leadMessage(id) });
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
