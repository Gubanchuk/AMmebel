import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { buildMaxRequest, createMaxNotifier, leadMessage } from '../src/trigger.mjs';

async function stubServer(t, respond) {
	const requests = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			requests.push({
				method: req.method,
				url: req.url,
				headers: req.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			});
			respond(req, res);
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	);
	return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function collectLogs() {
	const logs = [];
	return { logs, log: (message) => logs.push(message) };
}

test('not configured: no notifier, one log line', () => {
	const { logs, log } = collectLogs();
	assert.equal(createMaxNotifier({ env: {}, log }), null);
	assert.equal(createMaxNotifier({ env: { MAX_BOT_TOKEN: 'token' }, log }), null);
	assert.equal(createMaxNotifier({ env: { MAX_BOT_TOKEN: 'token', MAX_CHAT_ID: '@chat' }, log }), null);
	assert.equal(logs.length, 3);
	assert.ok(!logs.join('\n').includes('token'));
});

test('sends the lead number and a button to its admin card, nothing else', async (t) => {
	const stub = await stubServer(t, (req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"message":{"body":{"mid":"1"}}}');
	});
	const { logs, log } = collectLogs();
	const notify = createMaxNotifier({
		env: {
			MAX_BOT_TOKEN: 'bot-token-123',
			MAX_CHAT_ID: '-100500',
			MAX_API_URL: stub.url,
			ADMIN_URL: 'https://admin.example.ru',
		},
		log,
	});

	assert.equal(await notify(42), true);
	assert.equal(stub.requests.length, 1);
	const [request] = stub.requests;
	assert.equal(request.method, 'POST');
	assert.equal(request.url, '/messages?chat_id=-100500');
	assert.equal(request.headers.authorization, 'bot-token-123');
	assert.match(request.headers['content-type'], /^application\/json/);
	assert.deepEqual(JSON.parse(request.body), {
		text: 'Новая заявка №42 с сайта',
		attachments: [
			{
				type: 'inline_keyboard',
				payload: {
					buttons: [
						[{ type: 'link', text: 'Открыть заявку', url: 'https://admin.example.ru/admin/content/leads/42' }],
					],
				},
			},
		],
	});
	assert.deepEqual(logs, ['lead 42 messenger notification sent']);
});

test('without a valid ADMIN_URL the message goes without the button', async (t) => {
	const stub = await stubServer(t, (req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"message":{"body":{"mid":"1"}}}');
	});
	for (const adminUrl of [undefined, 'admin.example.ru']) {
		const { log } = collectLogs();
		const notify = createMaxNotifier({
			env: { MAX_BOT_TOKEN: 'bot-token-123', MAX_CHAT_ID: '7', MAX_API_URL: stub.url, ADMIN_URL: adminUrl },
			log,
		});
		assert.equal(await notify(3), true);
	}
	assert.equal(stub.requests.length, 2);
	for (const request of stub.requests) {
		assert.deepEqual(JSON.parse(request.body), { text: 'Новая заявка №3 с сайта' });
	}
});

test('API error is logged by status and swallowed', async (t) => {
	const stub = await stubServer(t, (req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end('{"code":"verify.token","message":"Invalid access_token"}');
	});
	const { logs, log } = collectLogs();
	const notify = createMaxNotifier({
		env: { MAX_BOT_TOKEN: 'bot-token-123', MAX_CHAT_ID: '7', MAX_API_URL: stub.url },
		log,
	});
	assert.equal(await notify(5), false);
	assert.deepEqual(logs, ['lead 5 messenger notification failed: HTTP 401']);
});

test('hanging API is cut off by the timeout', async (t) => {
	const stub = await stubServer(t, () => {
		// never answers
	});
	const { logs, log } = collectLogs();
	const notify = createMaxNotifier({
		env: { MAX_BOT_TOKEN: 'bot-token-123', MAX_CHAT_ID: '7', MAX_API_URL: stub.url },
		log,
		timeoutMs: 200,
	});
	const started = Date.now();
	assert.equal(await notify(6), false);
	assert.ok(Date.now() - started < 3000, 'gave up in time');
	assert.deepEqual(logs, ['lead 6 messenger notification failed: timeout']);
	assert.equal(stub.requests.length, 1);
});

test('default request goes to platform-api2.max.ru with the token only in the header', () => {
	const { url, init } = buildMaxRequest({ token: 'secret', chatId: '123', text: leadMessage(9) });
	assert.equal(url, 'https://platform-api2.max.ru/messages?chat_id=123');
	assert.ok(!url.includes('secret'));
	assert.equal(init.method, 'POST');
	assert.equal(init.headers.authorization, 'secret');
	assert.deepEqual(JSON.parse(init.body), { text: 'Новая заявка №9 с сайта' });
});
