import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leadMessage } from '../src/trigger.mjs';
import { createVkPoller, createVkTokens, mapVkLead, parseFormIds, parseVkTime } from '../src/vk-leads.mjs';

const ENV = {
	VK_ADS_CLIENT_ID: 'client-1',
	VK_ADS_CLIENT_SECRET: 'secret-1',
	VK_LEAD_FORM_IDS: '1026922',
	VK_ADS_API_URL: 'https://vk.test',
};

function vkItem(overrides = {}) {
	return {
		id: '501',
		form_id: '1026922',
		form_name: 'SF розница — расчёт под размер',
		ad_plan_id: 36679778,
		ad_group_id: 161922214,
		banner_id: 245614120,
		created_at: '2026-10-23 13:05:42',
		contact_info: { first_name: ' Алексей ', phone: '+79180000000', email: null },
		answers: [
			{ block_id: 'b1', question_text: 'Когда нужен диван?', answer_options: [{ id: 'o1', text: 'В ближайший месяц' }] },
		],
		...overrides,
	};
}

function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fake VK API: answers token requests from `tokenReplies` in turn and lead
// requests with `items`, recording every call.
function fakeVk({ items = [], tokenReplies = [[200, { access_token: 'a1', refresh_token: 'r1', expires_in: 86400 }]], leadReplies = [] } = {}) {
	const calls = [];
	const tokens = [...tokenReplies];
	const leads = [...leadReplies];
	async function fetchImpl(url, init = {}) {
		const target = new URL(url);
		calls.push({
			path: target.pathname,
			search: target.search,
			method: init.method || 'GET',
			body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null,
			auth: init.headers?.authorization,
		});
		if (target.pathname === '/api/v2/oauth2/token.json') {
			const [status, body] = tokens.shift() || [200, { access_token: 'later', expires_in: 86400 }];
			return jsonResponse(status, body);
		}
		if (target.pathname === '/api/v2/oauth2/token/delete.json') return jsonResponse(200, {});
		if (target.pathname === '/api/v1/lead_ads/leads.json') {
			const [status, body] = leads.shift() || [200, { count: items.length, items }];
			return jsonResponse(status, body);
		}
		return jsonResponse(404, {});
	}
	return { calls, fetchImpl };
}

// Behaves like the leads table: every INSERT takes the next id from the
// sequence, even one that ends in ON CONFLICT DO NOTHING.
function dedupRepo() {
	const rows = [];
	let sequence = 100;
	return {
		rows,
		inserts: 0,
		async knownExternalIds(ids) {
			return new Set(rows.map((row) => row.external_id).filter((id) => ids.includes(id)));
		},
		async insertExternalLead(lead) {
			this.inserts += 1;
			sequence += 1;
			if (rows.some((row) => row.external_id === lead.external_id)) return null;
			rows.push(lead);
			return sequence;
		},
	};
}

function collect() {
	const logs = [];
	const stored = [];
	return { logs, stored, log: (message) => logs.push(message), onStored: (id, source) => stored.push([id, source]) };
}

test('parseVkTime reads Moscow time when VK gives no offset', () => {
	assert.equal(parseVkTime('2026-10-23 13:05:42'), '2026-10-23T10:05:42.000Z');
	assert.equal(parseVkTime('2026-10-23 20:26:26.286 +0300 MSK'), '2026-10-23T17:26:26.286Z');
	assert.equal(parseVkTime('2026-10-23T10:05:42Z'), '2026-10-23T10:05:42.000Z');
	assert.equal(parseVkTime('вчера'), null);
	assert.equal(parseVkTime(undefined), null);
});

test('parseFormIds accepts comma-separated numbers only', () => {
	assert.deepEqual(parseFormIds('1026922'), ['1026922']);
	assert.deepEqual(parseFormIds(' 1, 2 ,3 '), ['1', '2', '3']);
	assert.equal(parseFormIds('1026922,abc'), null);
	assert.equal(parseFormIds(''), null);
});

test('mapVkLead keeps contacts, answers and the ad it came from', () => {
	assert.deepEqual(mapVkLead(vkItem()), {
		type: 'vk',
		received_at: '2026-10-23T10:05:42.000Z',
		name: 'Алексей',
		phone: '+79180000000',
		city: null,
		need: 'Когда нужен диван: В ближайший месяц',
		utm: { utm_source: 'vk', utm_medium: 'leadform', utm_campaign: '36679778', utm_content: '245614120' },
		consent_version: 'vk-form-1026922',
		external_id: 'vk:501',
	});
});

test('mapVkLead copes with missing parts and long text', () => {
	const lead = mapVkLead(
		vkItem({
			contact_info: null,
			answers: [
				{ question_text: 'Размер', answer_text: 'х'.repeat(400) },
				{ question_text: 'Пусто', answer_options: [] },
				'not an object',
			],
			banner_id: undefined,
		}),
	);
	assert.equal(lead.name, null);
	assert.equal(lead.phone, null);
	assert.equal(lead.need.length, 255);
	assert.ok(lead.need.startsWith('Размер: ххх'));
	assert.equal(lead.utm.utm_content, undefined);
	assert.equal(mapVkLead({ form_id: '1' }), null);
	assert.equal(mapVkLead(null), null);
});

test('not configured: no poller, one log line without secrets', () => {
	const { logs, log } = collect();
	assert.equal(createVkPoller({ env: {}, repo: dedupRepo(), onStored() {}, log }), null);
	assert.equal(createVkPoller({ env: { ...ENV, VK_LEAD_FORM_IDS: 'abc' }, repo: dedupRepo(), onStored() {}, log }), null);
	assert.equal(logs.length, 2);
	assert.ok(!logs.join('\n').includes('secret-1'));
});

test('stores new leads oldest first, once, and reports them as vk', async () => {
	const items = [vkItem({ id: '503' }), vkItem({ id: '502' }), vkItem({ id: '501' })];
	const vk = fakeVk({ items });
	const repo = dedupRepo();
	const { logs, stored, log, onStored } = collect();
	const poller = createVkPoller({ env: ENV, repo, onStored, log, fetchImpl: vk.fetchImpl });

	assert.equal(await poller.pollOnce(), 3);
	assert.deepEqual(
		repo.rows.map((row) => row.external_id),
		['vk:501', 'vk:502', 'vk:503'],
	);
	assert.deepEqual(stored, [
		[101, 'vk'],
		[102, 'vk'],
		[103, 'vk'],
	]);

	assert.equal(await poller.pollOnce(), 0, 'the same leads on the next poll are not stored again');
	assert.equal(stored.length, 3);
	assert.equal(repo.inserts, 3, 'known leads are not inserted again, so they take no ids');

	const tokenCalls = vk.calls.filter((call) => call.path === '/api/v2/oauth2/token.json');
	assert.equal(tokenCalls.length, 1, 'the token is reused between polls');
	assert.deepEqual(tokenCalls[0].body, { grant_type: 'client_credentials', client_id: 'client-1', client_secret: 'secret-1' });

	const leadCall = vk.calls.find((call) => call.path === '/api/v1/lead_ads/leads.json');
	assert.equal(leadCall.auth, 'Bearer a1');
	const query = new URLSearchParams(leadCall.search);
	assert.equal(query.get('_form_ids__in'), '1026922');
	assert.equal(query.get('sorting'), '-id');
	assert.equal(query.get('limit'), '50');

	const text = logs.join('\n');
	assert.ok(!text.includes('Алексей') && !text.includes('+7918'), 'no personal data in logs');
});

test('a new lead after many polls gets the next number', async () => {
	const items = [vkItem({ id: '502' }), vkItem({ id: '501' })];
	const vk = fakeVk({ items });
	const repo = dedupRepo();
	const { stored, log, onStored } = collect();
	const poller = createVkPoller({ env: ENV, repo, onStored, log, fetchImpl: vk.fetchImpl });

	for (let poll = 0; poll < 5; poll += 1) await poller.pollOnce();
	items.unshift(vkItem({ id: '503' }));
	assert.equal(await poller.pollOnce(), 1);
	assert.deepEqual(stored, [
		[101, 'vk'],
		[102, 'vk'],
		[103, 'vk'],
	]);
});

test('token limit: deletes the old tokens and asks again', async () => {
	const vk = fakeVk({
		tokenReplies: [
			[403, { code: 'token_limit_exceeded' }],
			[200, { access_token: 'a2', refresh_token: 'r2', expires_in: 86400 }],
		],
	});
	const { logs, log } = collect();
	const tokens = createVkTokens({
		apiUrl: 'https://vk.test',
		clientId: 'client-1',
		clientSecret: 'secret-1',
		fetchImpl: vk.fetchImpl,
		timeoutMs: 1000,
		log,
	});
	assert.equal(await tokens.get(), 'a2');
	assert.deepEqual(
		vk.calls.map((call) => call.path),
		['/api/v2/oauth2/token.json', '/api/v2/oauth2/token/delete.json', '/api/v2/oauth2/token.json'],
	);
	assert.match(logs.join('\n'), /token limit/);
});

test('an expiring token is refreshed, a failed refresh falls back to a new token', async () => {
	let clock = 0;
	const vk = fakeVk({
		tokenReplies: [
			[200, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }],
			[200, { access_token: 'a1b', refresh_token: 'r1', expires_in: 3600 }],
			[400, { code: 'invalid_grant' }],
			[200, { access_token: 'a3', refresh_token: 'r3', expires_in: 3600 }],
		],
	});
	const tokens = createVkTokens({
		apiUrl: 'https://vk.test',
		clientId: 'c',
		clientSecret: 's',
		fetchImpl: vk.fetchImpl,
		timeoutMs: 1000,
		log() {},
		now: () => clock,
	});
	assert.equal(await tokens.get(), 'a1');
	clock = 55 * 60 * 1000; // five minutes before expiry
	assert.equal(await tokens.get(), 'a1b');
	assert.equal(vk.calls[1].body.grant_type, 'refresh_token');
	assert.equal(vk.calls[1].body.refresh_token, 'r1');
	clock = 2 * 55 * 60 * 1000;
	assert.equal(await tokens.get(), 'a3');
	assert.equal(vk.calls[3].body.grant_type, 'client_credentials');
});

test('401 on the lead list: a new token and one retry', async () => {
	const vk = fakeVk({
		items: [vkItem()],
		tokenReplies: [
			[200, { access_token: 'old', refresh_token: 'r1', expires_in: 86400 }],
			[200, { access_token: 'new', refresh_token: 'r2', expires_in: 86400 }],
		],
		leadReplies: [[401, { code: 'invalid_token' }]],
	});
	const repo = dedupRepo();
	const { log, onStored } = collect();
	const poller = createVkPoller({ env: ENV, repo, onStored, log, fetchImpl: vk.fetchImpl });
	assert.equal(await poller.pollOnce(), 1);
	const auths = vk.calls.filter((call) => call.path === '/api/v1/lead_ads/leads.json').map((call) => call.auth);
	assert.deepEqual(auths, ['Bearer old', 'Bearer new']);
});

test('a failed poll is logged and the next one runs', async () => {
	const vk = fakeVk({ items: [vkItem()], leadReplies: [[500, {}]] });
	const repo = dedupRepo();
	const { logs, stored, log, onStored } = collect();
	const poller = createVkPoller({
		env: { ...ENV, VK_POLL_SECONDS: '0.05' },
		repo,
		onStored,
		log,
		fetchImpl: vk.fetchImpl,
	});
	poller.start();
	await new Promise((resolve) => setTimeout(resolve, 200));
	await poller.stop();
	assert.match(logs.join('\n'), /vk: poll failed: leads HTTP 500/);
	assert.deepEqual(stored, [[101, 'vk']]);
});

test('MAX message names VK as the source', () => {
	assert.equal(leadMessage(7, 'vk'), 'Новая заявка №7 из VK');
	assert.equal(leadMessage(7), 'Новая заявка №7 с сайта');
});
