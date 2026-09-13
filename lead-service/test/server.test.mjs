import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SMTP_KEYS } from '../src/mail.mjs';

test('server.mjs starts switched off with no database, answers 503, stops on SIGTERM', async (t) => {
	const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
	const env = { ...process.env, PORT: '0' };
	for (const key of ['LEADS_ENABLED', 'DATABASE_URL', 'MAX_BOT_TOKEN', 'MAX_CHAT_ID', ...SMTP_KEYS]) {
		delete env[key];
	}
	const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	});

	let output = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => {
		output += chunk;
	});
	const port = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no "listening" line:\n${output}`)), 5000);
		child.stdout.on('data', (chunk) => {
			output += chunk;
			const match = output.match(/listening on (\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve(Number(match[1]));
			}
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`exited with ${code}:\n${output}`));
		});
	});

	assert.match(output, /lead intake is off/);
	const base = `http://127.0.0.1:${port}`;
	const health = await fetch(`${base}/api/health`);
	assert.equal(health.status, 200);
	await health.text();
	const lead = await fetch(`${base}/api/lead`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	});
	assert.equal(lead.status, 503);
	assert.deepEqual(await lead.json(), { error: 'leads_disabled' });

	const closed = once(child, 'close');
	if (process.platform === 'win32') {
		// Windows cannot deliver SIGTERM to a handler; the graceful path is
		// checked on Linux (the container platform).
		child.kill();
		await closed;
		return;
	}
	child.kill('SIGTERM');
	const [code] = await closed;
	assert.equal(code, 0, output);
	assert.match(output, /SIGTERM received, shutting down/);
	assert.match(output, /stopped/);
});
