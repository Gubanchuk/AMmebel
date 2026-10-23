// lead-service entry point: reads the environment, wires the database, the mail
// outbox, the messenger trigger and the VK lead form poller, and shuts down
// cleanly on SIGTERM.
//
// Intake ships switched off. Unless LEADS_ENABLED is exactly "true" the service
// opens no database connection, sends nothing and answers POST /api/lead with
// 503: under 152-FZ the company may store leads only after its notice to
// Roskomnadzor is filed.

import { createServer, leadsEnabled } from './app.mjs';
import { createPool, createRepository } from './db.mjs';
import { log } from './log.mjs';
import { setupOutbox } from './mail.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createMaxNotifier } from './trigger.mjs';
import { createVkPoller } from './vk-leads.mjs';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = process.env;
const port = env.PORT === undefined || env.PORT === '' ? 8080 : Number(env.PORT);
const enabled = leadsEnabled(env);

let pool = null;
let repo = null;
let outbox = null;
let notify = null;
let vkPoller = null;
const pending = new Set();

if (enabled) {
	if (!env.DATABASE_URL) {
		log('LEADS_ENABLED is "true" but DATABASE_URL is not set');
		process.exit(1);
	}
	pool = createPool(env.DATABASE_URL, log);
	repo = createRepository(pool);
	outbox = setupOutbox({ env, repo, log });
	notify = createMaxNotifier({ env, log });
	vkPoller = createVkPoller({ env, repo, onStored, log });
	log('lead intake is on');
} else {
	log('lead intake is off (LEADS_ENABLED is not "true"): POST /api/lead answers 503, database, mail, messenger and VK are not used');
}

function onStored(id, source) {
	if (outbox) outbox.tick();
	if (notify) {
		const task = notify(id, source).finally(() => pending.delete(task));
		pending.add(task);
	}
}

const server = createServer({
	enabled,
	repo,
	onStored,
	log,
	rateLimiter: createRateLimiter({
		limit: Number(env.RATE_LIMIT_MAX) || 5,
		windowMs: (Number(env.RATE_LIMIT_WINDOW_SECONDS) || 600) * 1000,
	}),
});

server.listen(port, () => {
	log(`listening on ${server.address().port}`);
	if (outbox) outbox.start();
	if (vkPoller) vkPoller.start();
});

let stopping = false;

async function shutdown(signal) {
	if (stopping) return;
	stopping = true;
	log(`${signal} received, shutting down`);
	setTimeout(() => {
		log('shutdown timed out');
		process.exit(1);
	}, SHUTDOWN_TIMEOUT_MS).unref();

	// Stop accepting requests and let the ones in flight finish first: a request
	// that stores a lead can still kick the outbox and the messenger.
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeIdleConnections();
	});
	if (vkPoller) await vkPoller.stop();
	if (outbox) await outbox.stop();
	await Promise.allSettled(pending);
	if (pool) await pool.end();
	log('stopped');
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
