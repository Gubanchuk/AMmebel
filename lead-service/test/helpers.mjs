import { once } from 'node:events';
import { createServer } from '../src/app.mjs';

export function memoryRepo() {
	const rows = [];
	return {
		rows,
		async insertLead(lead) {
			const id = rows.length + 1;
			rows.push({ id, ...lead, email_status: 'queued' });
			return { id, created: true };
		},
	};
}

// Records every call; any call is a test failure for the caller to assert on.
export function spyRepo() {
	const calls = [];
	const record = (name) => async () => {
		calls.push(name);
		throw new Error(`${name} must not be called`);
	};
	return {
		calls,
		insertLead: record('insertLead'),
		pickOutbox: record('pickOutbox'),
		setEmailStatus: record('setEmailStatus'),
	};
}

export async function startApp(t, options = {}) {
	const repo = options.repo || memoryRepo();
	const logs = [];
	const stored = [];
	const server = createServer({
		enabled: true,
		onStored: (id) => stored.push(id),
		log: (message) => logs.push(message),
		...options,
		repo,
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	);
	return { base: `http://127.0.0.1:${server.address().port}`, repo, logs, stored };
}

export function priceFields(overrides = {}) {
	return {
		company_inn: '2310123456',
		name: 'Иван Тестов',
		phone: '+7 918 000-00-00',
		city: 'Краснодар',
		need: 'salon',
		need_extra: '2 точки',
		...overrides,
	};
}

export function priceLead(overrides = {}) {
	return {
		type: 'price',
		fields: priceFields(),
		consent: { version: '2026-09-13' },
		source_page: '/',
		...overrides,
	};
}

export function quizLead(overrides = {}) {
	return {
		type: 'quiz',
		fields: {
			business: 'Мебель в своём салоне или шоуруме',
			scale: 'От двух до пяти',
			city: '',
			name: 'Мария',
			phone: '89180000001',
		},
		consent: { version: '2026-09-13' },
		source_page: '/',
		...overrides,
	};
}

export function postJson(base, body, headers = {}) {
	return fetch(`${base}/api/lead`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

let nextAddress = 1;
// A fresh client address per request, so tests with many requests stay under
// the per-address rate limit unless they test it.
export function freshIp() {
	nextAddress += 1;
	return { 'x-real-ip': `10.1.${Math.floor(nextAddress / 250)}.${nextAddress % 250}` };
}
