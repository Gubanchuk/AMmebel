import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
	INSERT_COLUMNS,
	INSERT_EXTERNAL_COLUMNS,
	INSERT_EXTERNAL_LEAD,
	INSERT_LEAD,
	OUTBOX_COLUMNS,
	PICK_KNOWN_EXTERNAL_IDS,
	PICK_OUTBOX,
	SET_EMAIL_STATUS,
	createRepository,
} from '../src/db.mjs';

function fakePool(result = { rows: [] }) {
	const queries = [];
	return {
		queries,
		async query(text, values) {
			queries.push({ text, values });
			return result;
		},
		async connect() {
			return {
				query: async (text, values) => {
					queries.push({ text, values });
					return text === INSERT_LEAD ? result : { rows: [] };
				},
				release() {},
			};
		},
	};
}

// PostgreSQL is external to the unit suite. This double only models the
// transaction/lock boundary; SQL matching and time windows are integration tests.
function sitePool({ existing = null, failInsert = null } = {}) {
	const queries = [];
	let row = existing;
	let lock = Promise.resolve();
	let releases = 0;
	const run = async (text, values, state = {}) => {
		queries.push({ text, values });
		if (/pg_advisory_xact_lock/.test(text)) {
			const before = lock;
			lock = new Promise((resolve) => { state.unlock = resolve; });
			await before;
		} else if (/^\s*SELECT id\s+FROM leads/.test(text)) {
			return { rows: row === null ? [] : [{ id: row }] };
		} else if (text === INSERT_LEAD) {
			if (failInsert) throw failInsert;
			row = row === null ? 17 : row + 1;
			return { rows: [{ id: row }] };
		} else if (/^(COMMIT|ROLLBACK)$/.test(text)) {
			state.unlock?.();
		}
		return { rows: [] };
	};
	return {
		queries,
		query: run,
		get releases() { return releases; },
		async connect() {
			const state = {};
			return {
				query: (text, values) => run(text, values, state),
				release: () => { releases += 1; },
			};
		},
	};
}

test('site retry returns the previous id without a second INSERT', async () => {
	const pool = sitePool({ existing: 12 });
	const result = await createRepository(pool).insertLead({ type: 'price', phone: '+7 (918) 000-00-00', need_extra: 'Модель: Lounge' });
	assert.deepEqual(result, { id: 12, created: false });
	assert.equal(pool.queries.filter(({ text }) => text === INSERT_LEAD).length, 0);
	assert.match(pool.queries[0].text, /^BEGIN ISOLATION LEVEL READ COMMITTED$/);
	assert.match(pool.queries[1].text, /pg_advisory_xact_lock/);
	assert.match(pool.queries[2].text, /^\s*SELECT id\s+FROM leads/);
	assert.equal(pool.queries.at(-1).text, 'COMMIT');
	assert.equal(pool.releases, 1);
});

test('simultaneous site retries serialize before reading and insert once', async () => {
	const pool = sitePool();
	const repo = createRepository(pool);
	const lead = { type: 'price', phone: '+7 918 000-00-00', need_extra: 'Модель: Lounge' };
	const results = await Promise.all([repo.insertLead(lead), repo.insertLead(lead)]);
	assert.deepEqual(results, [{ id: 17, created: true }, { id: 17, created: false }]);
	assert.equal(pool.queries.filter(({ text }) => text === INSERT_LEAD).length, 1);
	assert.equal(pool.releases, 2);
});

test('site identity normalizes Russian phone formatting and binds the full request content', async () => {
	const pool = sitePool({ existing: 12 });
	const repo = createRepository(pool);
	for (const phone of ['+7 (918) 000-00-00', '8 918 000 00 00', '9180000000']) {
		await repo.insertLead({ type: 'price', phone, name: 'Иван', company_inn: 'Компания', city: 'Краснодар', need: 'salon', need_extra: 'Модель: Lounge' });
	}
	const locks = pool.queries.filter(({ text }) => /pg_advisory_xact_lock/.test(text));
	assert.equal(locks.length, 3);
	assert.deepEqual(locks[0].values, locks[1].values);
	assert.deepEqual(locks[1].values, locks[2].values);
	const checks = pool.queries.filter(({ text }) => /^\s*SELECT id\s+FROM leads/.test(text));
	assert.deepEqual(checks.map(({ values }) => values), [
		['price', '79180000000', 'Компания', 'Иван', 'Краснодар', 'salon', 'Модель: Lounge'],
		['price', '79180000000', 'Компания', 'Иван', 'Краснодар', 'salon', 'Модель: Lounge'],
		['price', '79180000000', 'Компания', 'Иван', 'Краснодар', 'salon', 'Модель: Lounge'],
	]);
	await repo.insertLead({ type: 'price', phone: '79180000000', need_extra: 'Модель: Mono' });
	assert.deepEqual(pool.queries.findLast(({ text }) => /^\s*SELECT id\s+FROM leads/.test(text)).values,
		['price', '79180000000', null, null, null, null, 'Модель: Mono']);
});

test('site insert failure rolls back and releases the checked-out connection', async () => {
	const failure = Object.assign(new Error('insert failed'), { code: '42501' });
	const pool = sitePool({ failInsert: failure });
	await assert.rejects(createRepository(pool).insertLead({ type: 'price', phone: '89180000000' }), failure);
	assert.equal(pool.queries.at(-1).text, 'ROLLBACK');
	assert.equal(pool.releases, 1);
});

test('explicit international phone prefixes are preserved in the site identity', async () => {
	const pool = sitePool({ existing: 12 });
	const repo = createRepository(pool);
	for (const phone of ['+82 (2) 1234-5678', '+49 (30) 123456']) {
		await repo.insertLead({ type: 'price', phone });
	}
	const checks = pool.queries.filter(({ text }) => /^\s*SELECT id\s+FROM leads/.test(text));
	assert.deepEqual(checks.map(({ values }) => values[1]), ['82212345678', '4930123456']);
});

test('insertLead passes every value as a parameter, in column order', async () => {
	const pool = fakePool({ rows: [{ id: 17 }] });
	const repo = createRepository(pool);
	const result = await repo.insertLead({
		type: 'price',
		company_inn: '2310123456',
		name: "O'Brien'); DROP TABLE leads; --",
		phone: '+79180000000',
		city: 'Краснодар',
		need: 'salon',
		need_extra: null,
		source_page: '/',
		utm: { utm_source: 'yandex' },
		ip: '203.0.113.7',
		consent_version: '2026-08-25',
	});

	assert.deepEqual(result, { id: 17, created: true });
	const insert = pool.queries.find(({ text }) => text === INSERT_LEAD);
	assert.deepEqual(insert.values, [
		'price',
		'2310123456',
		"O'Brien'); DROP TABLE leads; --",
		'+79180000000',
		'Краснодар',
		'salon',
		null,
		'/',
		'{"utm_source":"yandex"}',
		'203.0.113.7',
		'2026-08-25',
	]);
	assert.match(INSERT_LEAD, /VALUES \(now\(\), now\(\), 'queued', \$1, .*\$11\)\s+RETURNING id/);
});

test('missing optional values are sent as NULL', async () => {
	const pool = fakePool({ rows: [{ id: 1 }] });
	await createRepository(pool).insertLead({ type: 'quiz', name: 'Мария', phone: '89180000001' });
	const insert = pool.queries.find(({ text }) => text === INSERT_LEAD);
	assert.equal(insert.values.length, INSERT_COLUMNS.length);
	assert.equal(insert.values.filter((value) => value === null).length, INSERT_COLUMNS.length - 3);
});

test('insertExternalLead passes the VK time first and returns null on a repeat', async () => {
	const pool = fakePool({ rows: [{ id: 21 }] });
	const repo = createRepository(pool);
	const lead = {
		type: 'vk',
		received_at: '2026-10-23T10:05:42.251Z',
		name: 'Алексей',
		phone: '+79180000000',
		city: null,
		need: 'Объявление «Битва за диван отменяется»; Когда нужен диван: В ближайший месяц',
		need_extra: 'Картинка объявления: https://r.mradx.net/a.jpg',
		utm: { utm_source: 'vk', utm_medium: 'leadform' },
		consent_version: 'vk-form-1026922',
		external_id: 'vk:42',
	};
	assert.equal(await repo.insertExternalLead(lead), 21);
	assert.equal(pool.queries[0].text, INSERT_EXTERNAL_LEAD);
	assert.deepEqual(pool.queries[0].values, [
		'2026-10-23T10:05:42.251Z',
		'vk',
		'Алексей',
		'+79180000000',
		null,
		'Объявление «Битва за диван отменяется»; Когда нужен диван: В ближайший месяц',
		'Картинка объявления: https://r.mradx.net/a.jpg',
		'{"utm_source":"vk","utm_medium":"leadform"}',
		'vk-form-1026922',
		'vk:42',
	]);
	assert.equal(pool.queries[0].values.length, INSERT_EXTERNAL_COLUMNS.length + 1);
	assert.match(INSERT_EXTERNAL_LEAD, /ON CONFLICT \(external_id\) DO NOTHING\s+RETURNING id/);

	const repeat = createRepository(fakePool({ rows: [] }));
	assert.equal(await repeat.insertExternalLead(lead), null);
});

test('knownExternalIds asks for the whole list in one query and skips an empty one', async () => {
	const pool = fakePool({ rows: [{ external_id: 'vk:41' }] });
	const repo = createRepository(pool);
	assert.deepEqual(await repo.knownExternalIds(['vk:41', 'vk:42']), new Set(['vk:41']));
	assert.deepEqual(pool.queries, [{ text: PICK_KNOWN_EXTERNAL_IDS, values: [['vk:41', 'vk:42']] }]);
	assert.match(PICK_KNOWN_EXTERNAL_IDS, /SELECT external_id\s+FROM leads\s+WHERE external_id = ANY\(\$1::text\[\]\)/);

	assert.deepEqual(await repo.knownExternalIds([]), new Set());
	assert.equal(pool.queries.length, 1);
});

test('outbox queries take the limit, the id and the status as parameters', async () => {
	const rows = [{ id: 3 }];
	const pool = fakePool({ rows });
	const repo = createRepository(pool);
	assert.equal(await repo.pickOutbox(20), rows);
	await repo.setEmailStatus(3, 'sent');
	assert.deepEqual(pool.queries, [
		{ text: PICK_OUTBOX, values: [20] },
		{ text: SET_EMAIL_STATUS, values: [3, 'sent'] },
	]);
	assert.match(PICK_OUTBOX, /email_status IN \('queued', 'failed'\)/);
	assert.match(PICK_OUTBOX, /created_at > now\(\) - interval '24 hours'/);
});

function grantedColumns(sql, privilege) {
	const match = sql.match(new RegExp(`GRANT ${privilege} \\(([^)]*)\\)\\s+ON TABLE leads`, 'i'));
	assert.ok(match, `grant.sql has GRANT ${privilege} (...) ON TABLE leads`);
	return match[1]
		.split(',')
		.map((column) => column.trim())
		.filter(Boolean);
}

test('sql/grant.sql grants exactly the columns the queries use, and nothing broader', async () => {
	const sql = (await readFile(new URL('../sql/grant.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');

	assert.deepEqual(
		new Set(grantedColumns(sql, 'INSERT')),
		new Set(['created_at', 'consent_at', 'email_status', ...INSERT_COLUMNS, ...INSERT_EXTERNAL_COLUMNS]),
	);
	// SELECT: returned columns, email_status for the WHERE clause and
	// external_id, the ON CONFLICT target of INSERT_EXTERNAL_LEAD and the
	// column PICK_KNOWN_EXTERNAL_IDS reads.
	assert.deepEqual(new Set(grantedColumns(sql, 'SELECT')), new Set([...OUTBOX_COLUMNS, 'email_status', 'external_id']));
	assert.deepEqual(grantedColumns(sql, 'UPDATE'), ['email_status']);

	for (const consentLog of ['ip', 'consent_version', 'consent_at']) {
		assert.ok(!grantedColumns(sql, 'SELECT').includes(consentLog), `${consentLog} is write-only`);
	}
	assert.doesNotMatch(sql, /GRANT\s+(ALL|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/i);
	assert.doesNotMatch(sql, /GRANT\s+(INSERT|SELECT|UPDATE)\s+ON/i, 'table-wide grants are not used');
});
