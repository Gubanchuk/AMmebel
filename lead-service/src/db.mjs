// All SQL of the service.
//
// The leads table belongs to Directus (infra/setup-collections.py). The service
// connects as the lead_service role from sql/grant.sql: it may insert leads,
// read the columns listed in PICK_OUTBOX plus external_id, and change email_status —
// nothing else. test/db.test.mjs checks that grant.sql covers these queries.

import { createHash } from 'node:crypto';
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

// Serialize only callers for the same site contact/type, across processes.
// The subsequent SELECT must be a separate READ COMMITTED statement: after a
// waiter obtains the lock it sees the lead the previous transaction committed.
export const LOCK_SITE_LEAD = 'SELECT pg_advisory_xact_lock($1::bigint)';

export const PICK_RECENT_SITE_LEAD = `
SELECT id
FROM leads
CROSS JOIN LATERAL (SELECT regexp_replace(phone, '[^0-9]', '', 'g') AS digits) normalized
WHERE type = $1
  AND external_id IS NULL
  AND created_at > statement_timestamp() - interval '10 minutes'
  AND CASE
    WHEN phone ~ '^[[:space:]]*[+]' THEN digits
    WHEN length(digits) = 10 THEN '7' || digits
    WHEN digits ~ '^8[0-9]{10}$' THEN '7' || substring(digits FROM 2)
    ELSE digits
  END = $2
  AND company_inn IS NOT DISTINCT FROM $3
  AND name IS NOT DISTINCT FROM $4
  AND city IS NOT DISTINCT FROM $5
  AND need IS NOT DISTINCT FROM $6
  AND need_extra IS NOT DISTINCT FROM $7
ORDER BY created_at DESC, id DESC
LIMIT 1`;

function normalizedPhone(phone) {
	const digits = phone.replace(/[^0-9]/g, '');
	if (phone.trimStart().startsWith('+')) return digits;
	if (digits.length === 10) return `7${digits}`;
	return /^8[0-9]{10}$/.test(digits) ? `7${digits.slice(1)}` : digits;
}

function siteLockKey(type, phone) {
	return createHash('sha256').update(JSON.stringify(['am-site-lead', type, phone])).digest().readBigInt64BE().toString();
}

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
		// A retry has the original id but does not own a new notification.
		async insertLead(lead) {
			const values = INSERT_COLUMNS.map((column) => {
				const value = lead[column] ?? null;
				return column === 'utm' && value !== null ? JSON.stringify(value) : value;
			});
			const phone = normalizedPhone(lead.phone);
			const client = await pool.connect();
			let releaseError;
			try {
				await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
				await client.query(LOCK_SITE_LEAD, [siteLockKey(lead.type, phone)]);
				const { rows: recent } = await client.query(PICK_RECENT_SITE_LEAD, [
					lead.type, phone, ...['company_inn', 'name', 'city', 'need', 'need_extra'].map((column) => lead[column] ?? null),
				]);
				let result;
				if (recent.length > 0) {
					result = { id: recent[0].id, created: false };
				} else {
					const { rows } = await client.query(INSERT_LEAD, values);
					result = { id: rows[0].id, created: true };
				}
				await client.query('COMMIT');
				return result;
			} catch (error) {
				try {
					await client.query('ROLLBACK');
				} catch (rollbackError) {
					releaseError = rollbackError;
				}
				throw error;
			} finally {
				client.release(releaseError);
			}
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
