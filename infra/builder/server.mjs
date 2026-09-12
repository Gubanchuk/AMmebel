// Rebuild service for the static site. Runs in the builder container next to
// Directus and nginx (infra/docker-compose.yml).
//
// POST /rebuild  header X-Rebuild-Token. A Directus flow calls it after every
//                content change; the build starts DEBOUNCE_MS after the last
//                call, so a burst of saves produces one build. `?now=1` skips
//                the wait (used when deploying new site code).
// GET  /status   whether a build is running or scheduled and how the last
//                one ended.
//
// A build checks that node_modules matches package-lock.json, runs
// `npm run build` with CONTENT_REQUIRED=1 (the live site is never rebuilt from
// the fallback file), copies dist/ into /site/releases/<time> and swaps the
// /site/current symlink that nginx serves. A failed build leaves the previous
// release online. The newest KEEP_RELEASES releases are kept.
//
// This container has no internet access: packages are installed at deploy
// time by the separate builder-deps container, which in turn cannot reach
// Directus or the database.

import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const APP_DIR = '/app/frontend';
const SITE_DIR = '/site';
const PORT = 8090;
const DEBOUNCE_MS = Number(process.env.REBUILD_DEBOUNCE_MS) || 60_000;
const KEEP_RELEASES = 3;

const { REBUILD_TOKEN: TOKEN = '', ...childEnv } = process.env;
if (!TOKEN) {
	console.error('REBUILD_TOKEN is not set');
	process.exit(1);
}

let timer = null;
let running = false;
let rerun = false;
let last = null;

function log(message) {
	console.log(`${new Date().toISOString()} ${message}`);
}

function run(command, args, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: APP_DIR,
			env: { ...childEnv, ...extraEnv },
			stdio: 'inherit',
		});
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)),
		);
	});
}

// builder-deps writes the lock file's sha256 next to the packages it
// installed. Building against packages from another lock would publish
// whatever those packages produce, so a mismatch stops the build.
async function checkDependencies() {
	const lock = await readFile(path.join(APP_DIR, 'package-lock.json'));
	const hash = createHash('sha256').update(lock).digest('hex');
	const marker = path.join(APP_DIR, 'node_modules', '.package-lock-hash');
	if ((await readFile(marker, 'utf8').catch(() => '')).trim() !== hash) {
		throw new Error('node_modules does not match package-lock.json, run infra/deploy-site.sh');
	}
}

async function publish() {
	const name = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const releases = path.join(SITE_DIR, 'releases');
	await mkdir(releases, { recursive: true });
	await cp(path.join(APP_DIR, 'dist'), path.join(releases, name), { recursive: true });
	// rename() over an existing symlink replaces it in one step, so nginx never
	// sees a moment without a site.
	const tmp = path.join(SITE_DIR, `.current-${name}`);
	await symlink(path.join('releases', name), tmp);
	await rename(tmp, path.join(SITE_DIR, 'current'));
	const outdated = (await readdir(releases)).sort().slice(0, -KEEP_RELEASES);
	for (const dir of outdated) {
		await rm(path.join(releases, dir), { recursive: true, force: true });
	}
	return name;
}

async function build(reason) {
	if (running) {
		rerun = true;
		return;
	}
	running = true;
	const started = Date.now();
	log(`build started: ${reason}`);
	try {
		await checkDependencies();
		await run('npm', ['run', 'build'], { CONTENT_REQUIRED: '1' });
		const release = await publish();
		const seconds = Math.round((Date.now() - started) / 1000);
		last = { ok: true, release, seconds, finishedAt: new Date().toISOString() };
		log(`published release ${release} in ${seconds}s`);
	} catch (error) {
		last = { ok: false, error: error.message, finishedAt: new Date().toISOString() };
		log(`build failed, the previous release stays online: ${error.message}`);
	} finally {
		running = false;
		if (rerun) {
			rerun = false;
			schedule('content changed during the previous build');
		}
	}
}

function schedule(reason, delay = DEBOUNCE_MS) {
	clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		build(reason);
	}, delay);
}

function authorized(req) {
	const given = Buffer.from(String(req.headers['x-rebuild-token'] || ''));
	const expected = Buffer.from(TOKEN);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

http
	.createServer((req, res) => {
		req.resume();
		const url = new URL(req.url, 'http://builder');
		const reply = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.method === 'GET' && url.pathname === '/status') {
			return reply(200, { running, scheduled: timer !== null, last });
		}
		if (req.method === 'POST' && url.pathname === '/rebuild') {
			if (!authorized(req)) return reply(403, { error: 'forbidden' });
			const now = url.searchParams.get('now') === '1';
			schedule(now ? 'requested without delay' : 'content changed', now ? 0 : DEBOUNCE_MS);
			return reply(202, { scheduledInSeconds: now ? 0 : DEBOUNCE_MS / 1000 });
		}
		return reply(404, { error: 'not found' });
	})
	.listen(PORT, () => log(`listening on ${PORT}, debounce ${DEBOUNCE_MS / 1000}s`));

// On a server with nothing published yet, build right away instead of
// waiting for the first content change.
stat(path.join(SITE_DIR, 'current')).catch(() => schedule('no published release yet', 0));
