import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createOutbox, createSmtpTransport, formatLeadEmail, mailSettings, setupOutbox } from '../src/mail.mjs';
import { spyRepo } from './helpers.mjs';

const SMTP_ENV = {
	SMTP_HOST: 'postbox.cloud.yandex.net',
	SMTP_PORT: '465',
	SMTP_USER: 'key-id',
	SMTP_PASS: 'secret-key',
	MAIL_FROM: 'site@am-fabrika.ru',
	MAIL_TO: 'manager@example.ru',
};

const PRICE_LEAD = {
	id: 1,
	created_at: new Date('2026-09-13T09:30:00Z'),
	type: 'price',
	company_inn: 'ООО «Ромашка»',
	name: 'Иван Тестов',
	phone: '+7 918 000-00-00',
	city: 'Краснодар',
	need: 'salon',
	need_extra: '2 точки',
	source_page: '/',
	utm: { utm_source: 'yandex', utm_campaign: 'opt' },
};

const QUIZ_LEAD = {
	id: 2,
	created_at: new Date('2026-09-13T09:31:00Z'),
	type: 'quiz',
	company_inn: null,
	name: 'Мария',
	phone: '89180000001',
	city: null,
	need: 'Мебель в своём салоне или шоуруме',
	need_extra: 'От двух до пяти',
	source_page: '/',
	utm: null,
};

// In-memory outbox table: pickOutbox returns leads still queued or failed.
function outboxRepo(leads) {
	const statuses = new Map(leads.map((lead) => [lead.id, 'queued']));
	const repo = {
		statuses,
		picks: 0,
		async pickOutbox(limit) {
			repo.picks += 1;
			return leads.filter((lead) => ['queued', 'failed'].includes(statuses.get(lead.id))).slice(0, limit);
		},
		async setEmailStatus(id, status) {
			statuses.set(id, status);
		},
	};
	return repo;
}

function fakeTransport(shouldFail = () => false) {
	const transport = {
		attempts: [],
		sent: [],
		async sendMail(message) {
			transport.attempts.push(message);
			if (shouldFail(message, transport.attempts.length)) {
				throw Object.assign(new Error('Connection refused, recipient manager@example.ru'), {
					code: 'ECONNECTION',
				});
			}
			transport.sent.push(message);
			return { messageId: `<${transport.sent.length}@test>` };
		},
	};
	return transport;
}

function collectLogs() {
	const logs = [];
	return { logs, log: (message) => logs.push(message) };
}

test('outbox marks a delivered lead sent and an undelivered one failed', async () => {
	const repo = outboxRepo([PRICE_LEAD, QUIZ_LEAD]);
	const transport = fakeTransport((message) => message.subject.includes('№2'));
	const { logs, log } = collectLogs();
	const outbox = createOutbox({ repo, transport, from: SMTP_ENV.MAIL_FROM, to: SMTP_ENV.MAIL_TO, log });

	assert.deepEqual(await outbox.tick(), { sent: 1, failed: 1 });
	assert.equal(repo.statuses.get(1), 'sent');
	assert.equal(repo.statuses.get(2), 'failed');

	const [message] = transport.sent;
	assert.equal(message.from, 'site@am-fabrika.ru');
	assert.equal(message.to, 'manager@example.ru');
	for (const value of ['ООО «Ромашка»', 'Иван Тестов', '+7 918 000-00-00', 'Краснодар', 'Выставить у себя', '2 точки']) {
		assert.ok(message.text.includes(value), `e-mail contains "${value}"`);
	}

	const joined = logs.join('\n');
	assert.match(joined, /lead 1 email sent/);
	assert.match(joined, /lead 2 email failed: ECONNECTION/);
	assert.ok(!joined.includes('manager@example.ru'), 'SMTP error text is not logged');
	assert.ok(!joined.includes('Мария'));
});

test('failed lead is retried on the next round and then marked sent', async () => {
	const repo = outboxRepo([QUIZ_LEAD]);
	const transport = fakeTransport((_, attempt) => attempt === 1);
	const outbox = createOutbox({ repo, transport, from: 'a@b', to: 'c@d', log: () => {} });

	assert.deepEqual(await outbox.tick(), { sent: 0, failed: 1 });
	assert.equal(repo.statuses.get(2), 'failed');
	assert.deepEqual(await outbox.tick(), { sent: 1, failed: 0 });
	assert.equal(repo.statuses.get(2), 'sent');
	assert.deepEqual(await outbox.tick(), { sent: 0, failed: 0 });
	assert.equal(transport.attempts.length, 2);
});

test('database error during a round is logged, not thrown', async () => {
	const { logs, log } = collectLogs();
	const repo = {
		async pickOutbox() {
			throw Object.assign(new Error('boom'), { code: '57P01' });
		},
	};
	const outbox = createOutbox({ repo, transport: fakeTransport(), from: 'a@b', to: 'c@d', log });
	assert.deepEqual(await outbox.tick(), { sent: 0, failed: 0 });
	assert.match(logs.join('\n'), /outbox: database error 57P01/);
});

test('calls during a running round join it: no lead is mailed twice', async () => {
	const repo = outboxRepo([PRICE_LEAD]);
	const transport = fakeTransport();
	const slow = {
		async sendMail(message) {
			await delay(30);
			return transport.sendMail(message);
		},
	};
	const outbox = createOutbox({ repo, transport: slow, from: 'a@b', to: 'c@d', log: () => {} });
	const first = outbox.tick();
	const second = outbox.tick();
	assert.equal(first, second);
	await first;
	assert.equal(transport.attempts.length, 1);
	assert.equal(repo.picks, 1);
});

test('start runs a round at once and on every interval; stop ends it', async () => {
	const repo = outboxRepo([]);
	const outbox = createOutbox({ repo, transport: fakeTransport(), from: 'a@b', to: 'c@d', log: () => {}, intervalMs: 20 });
	outbox.start();
	assert.equal(repo.picks, 1);
	await delay(90);
	await outbox.stop();
	const picks = repo.picks;
	assert.ok(picks >= 3, `expected several rounds, got ${picks}`);
	await delay(60);
	assert.equal(repo.picks, picks);
});

test('without SMTP settings the outbox is not created and the database is untouched', async () => {
	const repo = spyRepo();
	const { logs, log } = collectLogs();
	const makeTransport = () => assert.fail('transport must not be created');

	assert.equal(setupOutbox({ env: {}, repo, log, makeTransport }), null);
	assert.deepEqual(logs, ['mail disabled: SMTP is not configured']);

	const partial = { ...SMTP_ENV, MAIL_TO: '' };
	assert.equal(setupOutbox({ env: partial, repo, log, makeTransport }), null);
	assert.equal(logs[1], 'mail disabled: not set or invalid MAIL_TO');
	assert.ok(!logs.join('\n').includes('secret-key'));

	await delay(20);
	assert.deepEqual(repo.calls, []);
});

test('SMTP settings: 465 is implicit TLS, other ports are not, bad port is rejected', () => {
	assert.equal(mailSettings(SMTP_ENV).settings.secure, true);
	assert.equal(mailSettings({ ...SMTP_ENV, SMTP_PORT: '587' }).settings.secure, false);
	const bad = mailSettings({ ...SMTP_ENV, SMTP_PORT: 'smtp' });
	assert.equal(bad.settings, null);
	assert.deepEqual(bad.missing, ['SMTP_PORT']);

	let created = null;
	const outbox = setupOutbox({
		env: SMTP_ENV,
		repo: outboxRepo([]),
		log: () => {},
		makeTransport: (settings) => {
			created = settings;
			return fakeTransport();
		},
	});
	assert.ok(outbox);
	assert.equal(created.host, 'postbox.cloud.yandex.net');
	assert.equal(created.port, 465);
});

test('manager e-mail: subject without personal data, all fields in the text', () => {
	const price = formatLeadEmail(PRICE_LEAD);
	assert.equal(price.subject, 'Заявка №1 с сайта am-fabrika.ru (форма прайса)');
	assert.match(price.text, /^Заявка: №1$/m);
	assert.match(price.text, /^Время: .*МСК$/m);
	assert.match(price.text, /^Компания \/ ИНН: ООО «Ромашка»$/m);
	assert.match(price.text, /^Что нужно: Выставить у себя$/m);
	assert.match(price.text, /^Уточнение: 2 точки$/m);
	assert.match(price.text, /^utm_source: yandex$/m);
	assert.match(price.text, /^Страница: \/$/m);

	const quiz = formatLeadEmail(QUIZ_LEAD);
	assert.equal(quiz.subject, 'Заявка №2 с сайта am-fabrika.ru (квиз)');
	assert.match(quiz.text, /^Телефон: 89180000001$/m);
	assert.match(quiz.text, /^Город: —$/m);
	assert.match(quiz.text, /^Что продаёт: Мебель в своём салоне или шоуруме$/m);
	assert.match(quiz.text, /^Масштаб: От двух до пяти$/m);

	const forged = formatLeadEmail({ ...QUIZ_LEAD, name: 'Мария\nТелефон: 000' });
	assert.doesNotMatch(forged.text, /^Телефон: 000$/m);
});

test('real SMTP transport on a non-465 port refuses to log in or send without TLS', async (t) => {
	const commands = [];
	const sockets = new Set();
	// Plain SMTP server that neither offers nor accepts STARTTLS.
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding('utf8');
		socket.on('error', () => {});
		socket.write('220 stub ESMTP\r\n');
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk;
			let end;
			while ((end = buffer.indexOf('\r\n')) !== -1) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				commands.push(line);
				const verb = line.split(/[ :]/)[0].toUpperCase();
				if (verb === 'EHLO') socket.write('250-stub\r\n250 AUTH PLAIN LOGIN\r\n');
				else if (verb === 'QUIT') socket.end('221 bye\r\n');
				else socket.write('502 5.5.1 Command not implemented\r\n');
			}
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(
		() =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(resolve);
			}),
	);

	const transport = createSmtpTransport({
		host: '127.0.0.1',
		port: server.address().port,
		secure: false,
		user: 'key-id',
		pass: 'secret-key',
	});
	const started = Date.now();
	await assert.rejects(
		transport.sendMail({ from: 'site@am-fabrika.ru', to: 'manager@example.ru', subject: 'Заявка №1', text: 'Имя: Иван' }),
	);
	transport.close();
	assert.ok(Date.now() - started < 5000, 'fails right away, not by a socket timeout');

	assert.ok(commands.some((line) => /^EHLO/i.test(line)), 'the transport reached the server');
	assert.ok(
		!commands.some((line) => /^(AUTH|MAIL FROM|RCPT TO|DATA)/i.test(line)),
		`nothing sent in plain text: ${commands.join(' | ')}`,
	);
});
