// All SQL of the service.
//
// The leads table belongs to Directus (infra/setup-collections.py). The service
// connects as the lead_service role from sql/grant.sql: it may insert leads,
// read the columns listed in PICK_OUTBOX plus external_id, and change email_status —
// nothing else. test/db.test.mjs checks that grant.sql covers these queries.

import pg from 'pg';

export const INSERT_COLUMNS = [
	'type',
	'company_inn',
	'name',
	'phone',
	'city',
	'need',
	'need_extra',
	'source_page',
	'utm',
	'ip',
	'consent_version',
];

export const INSERT_LEAD = `
INSERT INTO leads (created_at, consent_at, email_status, ${INSERT_COLUMNS.join(', ')})
VALUES (now(), now(), 'queued', ${INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
RETURNING id`;

// Leads pulled from VK Ads lead forms (src/vk-leads.mjs). external_id is the
// VK lead id and a unique column, so a lead seen on every poll is stored once:
// on a repeat the INSERT does nothing and returns no id. $1 is the time VK
// received the lead (consent was given then); NULL falls back to now().
export const INSERT_EXTERNAL_COLUMNS = [
	'type',
	'name',
	'phone',
	'city',
	'need',
	'need_extra',
	'utm',
	'consent_version',
	'external_id',
];

export const INSERT_EXTERNAL_LEAD = `
INSERT INTO leads (created_at, consent_at, email_status, ${INSERT_EXTERNAL_COLUMNS.join(', ')})
VALUES (COALESCE($1::timestamptz, now()), COALESCE($1::timestamptz, now()), 'queued', ${INSERT_EXTERNAL_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')})
ON CONFLICT (external_id) DO NOTHING
RETURNING id`;

// external_id values of the list that are already stored. The VK poller asks
// before inserting: an INSERT that ends in ON CONFLICT still takes a number
// from the id sequence, and polling the same leads every minute made lead
// numbers jump from 7 to 1484 overnight (24.10.2026).
export const PICK_KNOWN_EXTERNAL_IDS = `
SELECT external_id
FROM leads
WHERE external_id = ANY($1::text[])`;

export const OUTBOX_COLUMNS = [
	'id',
	'created_at',
	'type',
	'company_inn',
	'name',
	'phone',
	'city',
	'need',
	'need_extra',
	'source_page',
	'utm',
];

// Leads whose manager e-mail has not gone out yet, for at most a day.
export const PICK_OUTBOX = `
SELECT ${OUTBOX_COLUMNS.join(', ')}
FROM leads
WHERE email_status IN ('queued', 'failed')
  AND created_at > now() - interval '24 hours'
ORDER BY id
LIMIT $1`;

export const SET_EMAIL_STATUS = `
UPDATE leads SET email_status = $2 WHERE id = $1`;

export function createPool(connectionString, log) {
	const pool = new pg.Pool({
		connectionString,
		max: 5,
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 30_000,
	});
	pool.on('error', (error) => log(`database connection error: ${error.code || error.name}`));
	return pool;
}

export function createRepository(pool) {
	return {
		async insertLead(lead) {
			const values = INSERT_COLUMNS.map((column) => {
				const value = lead[column] ?? null;
				return column === 'utm' && value !== null ? JSON.stringify(value) : value;
			});
			const { rows } = await pool.query(INSERT_LEAD, values);
			return rows[0].id;
		},

		// Returns the new id, or null when the lead is already stored.
		async insertExternalLead(lead) {
			const values = [
				lead.received_at ?? null,
				...INSERT_EXTERNAL_COLUMNS.map((column) => {
					const value = lead[column] ?? null;
					return column === 'utm' && value !== null ? JSON.stringify(value) : value;
				}),
			];
			const { rows } = await pool.query(INSERT_EXTERNAL_LEAD, values);
			return rows.length > 0 ? rows[0].id : null;
		},

		async knownExternalIds(ids) {
			if (ids.length === 0) return new Set();
			const { rows } = await pool.query(PICK_KNOWN_EXTERNAL_IDS, [ids]);
			return new Set(rows.map((row) => row.external_id));
		},

		async pickOutbox(limit) {
			const { rows } = await pool.query(PICK_OUTBOX, [limit]);
			return rows;
		},

		async setEmailStatus(id, status) {
			await pool.query(SET_EMAIL_STATUS, [id, status]);
		},
	};
}
