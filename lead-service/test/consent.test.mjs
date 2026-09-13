import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONSENT_VERSIONS } from '../src/consent-versions.mjs';
import { freshIp, postJson, priceLead, quizLead, startApp } from './helpers.mjs';

const SITE_VERSION_FILE = new URL('../../frontend/src/scripts/consent-version.js', import.meta.url);

test('published consent versions: a frozen list of dates with the current text', () => {
	assert.ok(Object.isFrozen(CONSENT_VERSIONS));
	assert.ok(CONSENT_VERSIONS.includes('2026-09-13'));
	for (const version of CONSENT_VERSIONS) assert.match(version, /^\d{4}-\d{2}-\d{2}$/);
});

test('unknown consent version gets 422 consent_version_unknown and is not stored', async (t) => {
	const app = await startApp(t);
	for (const version of ['2026-08-25', '2099-01-01', 'latest', '2026-9-13']) {
		for (const body of [priceLead({ consent: { version } }), quizLead({ consent: { version } })]) {
			const response = await postJson(app.base, body, freshIp());
			assert.equal(response.status, 422, `${body.type} ${version}`);
			assert.deepEqual(await response.json(), { error: 'consent_version_unknown' });
		}
	}
	assert.equal(app.repo.rows.length, 0);
	assert.deepEqual(app.stored, []);
	const logs = app.logs.join('\n');
	assert.match(logs, /lead rejected: unknown consent version/);
	assert.ok(!logs.includes('2099'), 'the rejected value is not logged');
});

test('every listed version is accepted, including a newly added one', async (t) => {
	const versions = [...CONSENT_VERSIONS, '2026-12-01'];
	const app = await startApp(t, { consentVersions: versions });
	for (const version of versions) {
		const response = await postJson(app.base, priceLead({ consent: { version } }), freshIp());
		assert.equal(response.status, 201, version);
	}
	assert.deepEqual(
		app.repo.rows.map((row) => row.consent_version),
		versions,
	);
});

test(
	'the version the site sends is in the published list',
	{ skip: existsSync(fileURLToPath(SITE_VERSION_FILE)) ? false : 'frontend is not next to lead-service' },
	async () => {
		const source = await readFile(SITE_VERSION_FILE, 'utf8');
		const match = source.match(/export const CONSENT_VERSION = '([^']+)'/);
		assert.ok(match, 'consent-version.js exports CONSENT_VERSION');
		assert.ok(
			CONSENT_VERSIONS.includes(match[1]),
			`site sends ${match[1]}, service accepts ${CONSENT_VERSIONS.join(', ')}`,
		);
	},
);
