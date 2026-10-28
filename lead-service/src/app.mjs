// HTTP layer of lead-service.
//
// POST /api/lead   JSON lead from the site -> 201 {id}
// GET  /api/health 200 {ok:true}
//
// Order of checks on POST /api/lead: intake switched off (503, the body is not
// even read) -> rate limit (429) -> content type (415) -> body size (413) ->
// JSON (400) -> honeypot (422) -> consent (422) -> published consent version
// (422) -> fields (400) -> INSERT.

import http from 'node:http';
import { siteAd, withAd } from './ads.mjs';
import { CONSENT_VERSIONS } from './consent-versions.mjs';
import { log as defaultLog } from './log.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { consentVersion, isHoneypotFilled, isObject, validateLead } from './validate.mjs';

export const BODY_LIMIT = 10 * 1024;
// Bodies between BODY_LIMIT and DRAIN_LIMIT are read and discarded so the 413
// answer reaches the client; anything larger drops the connection.
const DRAIN_LIMIT = 1024 * 1024;

// Only the exact string "true" turns intake on.
export function leadsEnabled(env) {
	return env.LEADS_ENABLED === 'true';
}

function send(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
		...headers,
	});
	res.end(payload);
}

function readBody(req, limit) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const settle = (result) => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > DRAIN_LIMIT) {
				settle({ aborted: true });
				req.destroy();
				return;
			}
			if (size <= limit) chunks.push(chunk);
		});
		req.on('end', () => settle(size > limit ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
		req.on('error', () => settle({ aborted: true }));
		req.on('close', () => settle({ aborted: true }));
	});
}

// nginx sets X-Real-IP to the visitor's address; the service is reachable only
// through it. Without the header (local runs, tests) the socket address is used.
function clientIp(req) {
	const header = req.headers['x-real-ip'];
	if (typeof header === 'string' && header.trim() !== '') return header.trim().slice(0, 64);
	return req.socket.remoteAddress || 'unknown';
}

export function createHandler({
	enabled,
	repo,
	onStored = () => {},
	rateLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 }),
	consentVersions = CONSENT_VERSIONS,
	log = defaultLog,
}) {
	return async function handle(req, res) {
		const pathname = (req.url || '/').split('?')[0];

		if (pathname === '/api/health') {
			req.resume();
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
			}
			return send(res, 200, { ok: true });
		}

		if (pathname !== '/api/lead') {
			req.resume();
			return send(res, 404, { error: 'not_found' });
		}
		if (req.method !== 'POST') {
			req.resume();
			return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
		}

		// Until the company's notice to Roskomnadzor is filed, leads must not be
		// stored: nothing is read, validated or written.
		if (!enabled) {
			req.resume();
			return send(res, 503, { error: 'leads_disabled' });
		}

		if (!rateLimiter.allow(clientIp(req))) {
			req.resume();
			log('lead rejected: rate limit');
			return send(res, 429, { error: 'too_many_requests' }, { 'retry-after': String(rateLimiter.retryAfterSeconds) });
		}

		if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
			req.resume();
			return send(res, 415, { error: 'unsupported_media_type' });
		}

		if (Number(req.headers['content-length']) > DRAIN_LIMIT) {
			return send(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
		}
		const raw = await readBody(req, BODY_LIMIT);
		if (raw.aborted) return;
		if (raw.tooLarge) return send(res, 413, { error: 'payload_too_large' });

		let body;
		try {
			body = JSON.parse(raw.text);
		} catch {
			return send(res, 400, { error: 'bad_json' });
		}
		if (!isObject(body)) return send(res, 400, { error: 'bad_json' });

		if (isHoneypotFilled(body)) {
			log('lead rejected: honeypot');
			return send(res, 422, { error: 'rejected' });
		}

		const version = consentVersion(body);
		if (!version) {
			log('lead rejected: no consent');
			return send(res, 422, { error: 'consent_required' });
		}
		// Only a published version: the stored consent_version must lead back to
		// the exact text the visitor agreed to.
		if (!consentVersions.includes(version)) {
			log('lead rejected: unknown consent version');
			return send(res, 422, { error: 'consent_version_unknown' });
		}

		const result = validateLead(body);
		if (result.errors) {
			log(`lead rejected: invalid ${result.errors.join(',')}`);
			return send(res, 400, { error: 'invalid', fields: result.errors });
		}

		// A lead from one of the site's banners (utm_content from ad-banners.json)
		// carries that banner the same way a VK lead carries its ad.
		const ad = siteAd(result.lead.utm);

		let id;
		try {
			id = await repo.insertLead({ ...withAd(result.lead, ad), ip: clientIp(req), consent_version: version });
		} catch (error) {
			log(`lead not stored: database error ${error.code || error.name}`);
			return send(res, 500, { error: 'internal' });
		}

		log(`lead ${id} stored`);
		send(res, 201, { id });
		try {
			onStored(id, 'site', ad);
		} catch (error) {
			log(`lead ${id} follow-up failed: ${error.name}`);
		}
	};
}

export function createServer(options) {
	const handle = createHandler(options);
	const log = options.log || defaultLog;
	const server = http.createServer((req, res) => {
		handle(req, res).catch((error) => {
			log(`request failed: ${error.name}`);
			if (!res.headersSent) send(res, 500, { error: 'internal' });
			else res.destroy();
		});
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;
	server.keepAliveTimeout = 5_000;
	return server;
}
