// Runs only when DATABASE_URL points at an isolated test database with the
// Directus leads schema (infra/setup-collections.py). Never use the live DB.
//
// As the table owner the test also checks the consent log columns and deletes
// its row. As lead_service (sql/grant.sql) it checks the privileges instead and
// cannot delete the row: the id is printed for the owner to remove.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool, createRepository } from '../src/db.mjs';
import { postJson, priceFields, priceLead, startApp } from './helpers.mjs';

const url = process.env.DATABASE_URL;

test('site deduplication is atomic, normalizes phones, and preserves different requests and expired leads', { skip: url ? false : 'DATABASE_URL is not set' }, async (t) => {
	const pool = createPool(url, (message) => t.diagnostic(message));
	const ids = new Set();
	const marker = `integration-${Date.now()}-${process.pid}`;
	try {
		const repo = createRepository(pool);
		const base = { type: 'price', phone: '+7 (900) 000-00-01', name: marker, need_extra: 'Модель: Lounge' };
		const results = await Promise.all(['+7 (900) 000-00-01', '8 900 000 00 01', '9000000001'].map((phone) => repo.insertLead({ ...base, phone })));
		for (const { id } of results) ids.add(id);
		assert.equal(ids.size, 1, 'parallel formatting variants resolve to one row');
		assert.equal(results.filter(({ created }) => created).length, 1, 'only one caller owns the follow-up');
		const firstId = results[0].id;
		assert.ok(Number.isInteger(firstId));
		assert.deepEqual(await repo.insertLead({ ...base, phone: '79000000001', source_page: '/other/', utm: { utm_source: 'retry' } }),
			{ id: firstId, created: false }, 'attribution/page changes do not create another request');

		for (const change of [{ need_extra: 'Модель: Mono' }, { need: 'salon' }, { company_inn: marker }, { city: marker }, { name: `${marker}-other` }, { type: 'quiz' }]) {
			const result = await repo.insertLead({ ...base, ...change });
			ids.add(result.id);
			assert.equal(result.created, true, `different request survives: ${Object.keys(change)[0]}`);
			assert.notEqual(result.id, firstId);
		}

		const old = await pool.query(`
			INSERT INTO leads (created_at, consent_at, email_status, type, name, phone, need_extra)
			VALUES (now() - interval '11 minutes', now(), 'queued', 'price', $1, '8 (900) 000-00-02', 'Модель: Lounge')
			RETURNING id`, [marker]);
		ids.add(old.rows[0].id);
		const afterWindow = await repo.insertLead({ ...base, phone: '+7 900 000 00 02' });
		ids.add(afterWindow.id);
		assert.equal(afterWindow.created, true, 'a lead older than ten minutes does not block another request');
		assert.notEqual(afterWindow.id, old.rows[0].id);

		for (const [phone, retry] of [['+82 (2) 1234-5678', '+82 2 1234 5678'], ['+49 (30) 123456', '+49 30 123456']]) {
			const result = await repo.insertLead({ ...base, phone });
			ids.add(result.id);
			assert.equal(result.created, true);
			assert.deepEqual(await repo.insertLead({ ...base, phone: retry }), { id: result.id, created: false }, 'explicit international prefixes survive matching stored phones');
		}

		const stored = await pool.query('SELECT id FROM leads WHERE id = ANY($1::integer[])', [[...ids]]);
		assert.equal(stored.rows.length, 11);
	} finally {
		if (ids.size > 0) {
			try {
				await pool.query('DELETE FROM leads WHERE id = ANY($1::integer[])', [[...ids]]);
			} catch (error) {
				t.diagnostic(`isolated test rows ${[...ids].join(',')} remain (${error.code}): remove the test database as its owner`);
			}
		}
		await pool.end();
	}
});

test('lead is stored in PostgreSQL and passes through the outbox queries', { skip: url ? false : 'DATABASE_URL is not set' }, async (t) => {
	const pool = createPool(url, (message) => t.diagnostic(message));
	let id = null;
	try {
		const repo = createRepository(pool);
		const app = await startApp(t, { repo });

		const body = priceLead({
			source_page: '/__lead-service-integration-test__',
			utm: { utm_source: 'integration-test' },
			fields: priceFields({ name: 'integration test', company_inn: 'integration test' }),
		});
		const response = await postJson(app.base, body, { 'x-real-ip': '192.0.2.10' });
		assert.equal(response.status, 201);
		({ id } = await response.json());
		assert.ok(Number.isInteger(id));

		const queued = (await repo.pickOutbox(1000)).find((lead) => lead.id === id);
		assert.ok(queued, 'new lead is in the outbox');
		assert.equal(queued.type, 'price');
		assert.equal(queued.name, 'integration test');
		assert.equal(queued.phone, '+7 918 000-00-00');
		assert.deepEqual(queued.utm, { utm_source: 'integration-test' });
		assert.ok(Math.abs(Date.now() - new Date(queued.created_at).getTime()) < 5 * 60_000, 'created_at is now()');

		await repo.setEmailStatus(id, 'sent');
		assert.ok(!(await repo.pickOutbox(1000)).some((lead) => lead.id === id), 'sent lead leaves the outbox');

		const {
			rows: [who],
		} = await pool.query('SELECT current_user AS name');
		if (who.name === 'lead_service') {
			const denied = { code: /^(42501|42P01)$/ };
			await assert.rejects(pool.query('SELECT ip FROM leads WHERE id = $1', [id]), denied);
			await assert.rejects(pool.query('UPDATE leads SET name = $2 WHERE id = $1', [id, 'x']), denied);
			await assert.rejects(pool.query('DELETE FROM leads WHERE id = $1', [id]), denied);
			await assert.rejects(pool.query('SELECT 1 FROM directus_users LIMIT 1'), denied);
		} else {
			const {
				rows: [stored],
			} = await pool.query('SELECT ip, consent_version, consent_at, created_at, email_status FROM leads WHERE id = $1', [id]);
			assert.equal(stored.ip, '192.0.2.10');
			assert.equal(stored.consent_version, '2026-09-13');
			assert.ok(stored.consent_at instanceof Date);
			assert.equal(stored.consent_at.getTime(), stored.created_at.getTime());
			assert.equal(stored.email_status, 'sent');
		}
	} finally {
		if (id !== null) {
			try {
				await pool.query('DELETE FROM leads WHERE id = $1', [id]);
			} catch (error) {
				t.diagnostic(`test lead ${id} is left in leads (${error.code}): delete it as the table owner`);
			}
		}
		await pool.end();
	}
});
