import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leadsEnabled } from '../src/app.mjs';
import { createRateLimiter } from '../src/rate-limit.mjs';
import { freshIp, postJson, priceFields, priceLead, quizLead, spyRepo, startApp } from './helpers.mjs';

test('valid price lead is stored with ip and consent version, 201 {id}', async (t) => {
	const app = await startApp(t);
	const body = priceLead({ utm: { utm_source: 'yandex', utm_campaign: 'opt', gclid: 'dropped' } });
	const response = await postJson(app.base, body, { 'x-real-ip': '203.0.113.7' });

	assert.equal(response.status, 201);
	assert.deepEqual(await response.json(), { id: 1 });
	assert.equal(app.repo.rows.length, 1);
	assert.deepEqual(app.repo.rows[0], {
		id: 1,
		type: 'price',
		company_inn: '2310123456',
		name: 'Иван Тестов',
		phone: '+7 918 000-00-00',
		city: 'Краснодар',
		need: 'salon',
		need_extra: '2 точки',
		source_page: '/',
		utm: { utm_source: 'yandex', utm_campaign: 'opt' },
		ip: '203.0.113.7',
		consent_version: '2026-09-13',
		email_status: 'queued',
	});
	assert.deepEqual(app.stored, [1]);

	const logs = app.logs.join('\n');
	assert.match(logs, /lead 1 stored/);
	for (const personal of ['Иван', '918', 'Краснодар', '2310123456', '203.0.113.7']) {
		assert.ok(!logs.includes(personal), `log must not contain "${personal}"`);
	}
});

test('quiz lead: answers go to need/need_extra, skipped steps allowed, socket ip without X-Real-IP', async (t) => {
	const app = await startApp(t);
	const response = await postJson(app.base, quizLead());
	assert.equal(response.status, 201);
	const row = app.repo.rows[0];
	assert.equal(row.type, 'quiz');
	assert.equal(row.need, 'Мебель в своём салоне или шоуруме');
	assert.equal(row.need_extra, 'От двух до пяти');
	assert.equal(row.city, null);
	assert.equal(row.company_inn, null);
	assert.equal(row.utm, null);
	assert.match(row.ip, /127\.0\.0\.1/);

	const minimal = await postJson(app.base, quizLead({ fields: { name: 'Мария', phone: '+7 900 000 00 01' } }));
	assert.equal(minimal.status, 201);
});

test('price lead from the two-field form: phone alone or phone and name', async (t) => {
	const app = await startApp(t);
	const phoneOnly = await postJson(app.base, priceLead({ fields: { phone: '+7 918 000-00-00' } }), freshIp());
	assert.equal(phoneOnly.status, 201);
	const blankName = await postJson(app.base, priceLead({ fields: { name: '   ', phone: '+7 918 000-00-01' } }), freshIp());
	assert.equal(blankName.status, 201);
	const withName = await postJson(app.base, priceLead({ fields: { name: 'Иван', phone: '+7 918 000-00-02' } }), freshIp());
	assert.equal(withName.status, 201);
	const [first, second, third] = app.repo.rows;
	for (const row of [first, second]) {
		assert.equal(row.name, null);
		assert.equal(row.company_inn, null);
		assert.equal(row.city, null);
		assert.equal(row.need, null);
		assert.equal(row.need_extra, null);
	}
	assert.equal(third.name, 'Иван');
	assert.equal(third.phone, '+7 918 000-00-02');
});

test('company field accepts a company name or an INN of 10 or 12 digits', async (t) => {
	const app = await startApp(t);
	for (const value of ['ООО «Ромашка»', '2310123456', '231012345678', '2310 123456']) {
		const response = await postJson(app.base, priceLead({ fields: priceFields({ company_inn: value }) }), freshIp());
		assert.equal(response.status, 201, value);
	}
	for (const value of ['12345', '23101234567', '2310123456789']) {
		const response = await postJson(app.base, priceLead({ fields: priceFields({ company_inn: value }) }), freshIp());
		assert.equal(response.status, 400, value);
		assert.deepEqual(await response.json(), { error: 'invalid', fields: ['company_inn'] });
	}
	assert.equal(app.repo.rows.length, 4);
});

test('lead without consent version gets 422 and is not stored', async (t) => {
	const app = await startApp(t);
	for (const consent of [undefined, {}, { version: '' }, { version: '   ' }, { version: 20260825 }, 'yes']) {
		const body = priceLead();
		if (consent === undefined) delete body.consent;
		else body.consent = consent;
		const response = await postJson(app.base, body, freshIp());
		assert.equal(response.status, 422, JSON.stringify(consent));
		assert.deepEqual(await response.json(), { error: 'consent_required' });
	}
	assert.equal(app.repo.rows.length, 0);
	assert.deepEqual(app.stored, []);
});

test('filled honeypot gets 422 and is not stored', async (t) => {
	const app = await startApp(t);
	for (const body of [priceLead({ website: 'http://spam.example' }), priceLead({ fields: priceFields({ website: 'x' }) })]) {
		const response = await postJson(app.base, body, freshIp());
		assert.equal(response.status, 422);
		assert.deepEqual(await response.json(), { error: 'rejected' });
	}
	assert.equal(app.repo.rows.length, 0);

	const empty = await postJson(app.base, priceLead({ website: '' }), freshIp());
	assert.equal(empty.status, 201);
});

test('switched-off intake answers 503 without touching the database or the limiter', async (t) => {
	const repo = spyRepo();
	let limiterCalls = 0;
	const rateLimiter = {
		retryAfterSeconds: 600,
		allow() {
			limiterCalls += 1;
			return true;
		},
	};
	const app = await startApp(t, { enabled: false, repo, rateLimiter });

	const response = await postJson(app.base, priceLead());
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'leads_disabled' });
	assert.deepEqual(repo.calls, []);
	assert.equal(limiterCalls, 0);
	assert.deepEqual(app.stored, []);

	const health = await fetch(`${app.base}/api/health`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), { ok: true });
});

test('only the exact string "true" enables intake', () => {
	assert.equal(leadsEnabled({ LEADS_ENABLED: 'true' }), true);
	for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
		assert.equal(leadsEnabled({ LEADS_ENABLED: value }), false, String(value));
	}
});

test('body over 10 KB gets 413 and is not stored', async (t) => {
	const app = await startApp(t);
	const body = priceLead({ fields: priceFields({ need_extra: 'x'.repeat(11 * 1024) }) });
	const response = await postJson(app.base, body);
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { error: 'payload_too_large' });
	assert.equal(app.repo.rows.length, 0);
});

test('malformed JSON or a non-object body gets 400', async (t) => {
	const app = await startApp(t);
	for (const raw of ['{"type":', 'not json', '', '[1,2]', 'null', '"text"']) {
		const response = await postJson(app.base, raw, freshIp());
		assert.equal(response.status, 400, raw);
		assert.deepEqual(await response.json(), { error: 'bad_json' });
	}
	assert.equal(app.repo.rows.length, 0);
});

test('invalid fields get 400 with the field names and are not stored', async (t) => {
	const app = await startApp(t);
	const cases = [
		[priceLead({ type: 'order' }), ['type']],
		[priceLead({ fields: priceFields({ phone: '8 918 12' }) }), ['phone']],
		[priceLead({ fields: { name: 'Иван' } }), ['phone']],
		[priceLead({ fields: priceFields({ need: 'other' }) }), ['need']],
		[priceLead({ fields: priceFields({ name: 'x'.repeat(256) }) }), ['name']],
		[priceLead({ fields: priceFields({ phone: 79180000000 }) }), ['phone']],
		[priceLead({ fields: 'text' }), ['fields']],
		[quizLead({ fields: { city: 'Ростов-на-Дону' } }), ['name', 'phone']],
		[quizLead({ fields: { name: '   ', phone: '+7 900 000 00 01' } }), ['name']],
	];
	for (const [body, fields] of cases) {
		const response = await postJson(app.base, body, freshIp());
		assert.equal(response.status, 400, JSON.stringify(body).slice(0, 120));
		assert.deepEqual(await response.json(), { error: 'invalid', fields });
	}
	assert.equal(app.repo.rows.length, 0);
});

test('sixth request from one address within 10 minutes gets 429', async (t) => {
	const app = await startApp(t);
	const address = { 'x-real-ip': '198.51.100.1' };
	for (let i = 1; i <= 5; i += 1) {
		const response = await postJson(app.base, priceLead(), address);
		assert.equal(response.status, 201);
	}
	const blocked = await postJson(app.base, priceLead(), address);
	assert.equal(blocked.status, 429);
	assert.equal(blocked.headers.get('retry-after'), '600');
	assert.deepEqual(await blocked.json(), { error: 'too_many_requests' });

	const other = await postJson(app.base, priceLead(), { 'x-real-ip': '198.51.100.2' });
	assert.equal(other.status, 201);
	assert.equal(app.repo.rows.length, 6);
});

test('rate limiter window slides and memory stays bounded', () => {
	let now = 0;
	const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now, maxKeys: 3 });
	assert.equal(limiter.allow('a'), true);
	now = 500;
	assert.equal(limiter.allow('a'), true);
	assert.equal(limiter.allow('a'), false);
	now = 1001;
	assert.equal(limiter.allow('a'), true);
	assert.equal(limiter.allow('a'), false);

	for (const key of ['b', 'c', 'd', 'e']) limiter.allow(key);
	assert.ok(limiter.size <= 3);
});

test('wrong content type 415, unknown path 404, wrong method 405, health 200', async (t) => {
	const app = await startApp(t);
	const text = await fetch(`${app.base}/api/lead`, {
		method: 'POST',
		headers: { 'content-type': 'text/plain' },
		body: JSON.stringify(priceLead()),
	});
	assert.equal(text.status, 415);

	assert.equal((await fetch(`${app.base}/api/leads`, { method: 'POST' })).status, 404);

	const get = await fetch(`${app.base}/api/lead`);
	assert.equal(get.status, 405);
	assert.equal(get.headers.get('allow'), 'POST');

	const health = await fetch(`${app.base}/api/health?x=1`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), { ok: true });
	assert.equal(app.repo.rows.length, 0);
});

test('database failure gets 500 and logs only the error code', async (t) => {
	const repo = {
		async insertLead() {
			throw Object.assign(new Error('connect ECONNREFUSED Иван Тестов'), { code: 'ECONNREFUSED' });
		},
	};
	const app = await startApp(t, { repo });
	const response = await postJson(app.base, priceLead());
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'internal' });
	assert.deepEqual(app.stored, []);
	const logs = app.logs.join('\n');
	assert.match(logs, /database error ECONNREFUSED/);
	assert.ok(!logs.includes('Иван'));
});
