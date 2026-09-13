// Runs only when DATABASE_URL points at a database where Directus created the
// leads table (infra/setup-collections.py). Uses test data only.
//
// As the table owner the test also checks the consent log columns and deletes
// its row. As lead_service (sql/grant.sql) it checks the privileges instead and
// cannot delete the row: the id is printed for the owner to remove.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool, createRepository } from '../src/db.mjs';
import { postJson, priceFields, priceLead, startApp } from './helpers.mjs';

const url = process.env.DATABASE_URL;

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
