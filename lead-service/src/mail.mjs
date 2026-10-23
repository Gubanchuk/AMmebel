// Manager e-mail with a retry outbox (plan task 12).
//
// Every OUTBOX_INTERVAL_MS the outbox picks leads with email_status 'queued' or
// 'failed' younger than 24 hours and sends one plain-text e-mail per lead to
// MAIL_TO. Success -> 'sent', failure -> 'failed' (retried on the next round).
// Without SMTP settings the outbox is not created at all.
//
// The forms have no buyer e-mail field, so there is no confirmation e-mail to
// the buyer. The consent log (ip, consent_version, consent_at) stays in the
// database and is not mailed.

import nodemailer from 'nodemailer';

export const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_TO'];
export const OUTBOX_INTERVAL_MS = 60_000;
const BATCH_SIZE = 20;

export function mailSettings(env) {
	const missing = SMTP_KEYS.filter((key) => !env[key]);
	const port = Number(env.SMTP_PORT);
	if (env.SMTP_PORT && !(Number.isInteger(port) && port > 0)) missing.push('SMTP_PORT');
	if (missing.length > 0) return { settings: null, missing };
	return {
		settings: {
			host: env.SMTP_HOST,
			port,
			secure: port === 465,
			user: env.SMTP_USER,
			pass: env.SMTP_PASS,
			from: env.MAIL_FROM,
			to: env.MAIL_TO,
		},
		missing: [],
	};
}

export function createSmtpTransport(settings) {
	return nodemailer.createTransport({
		host: settings.host,
		port: settings.port,
		secure: settings.secure,
		// On a non-465 port refuse to send personal data without STARTTLS.
		requireTLS: !settings.secure,
		auth: { user: settings.user, pass: settings.pass },
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 30_000,
	});
}

const NEED_LABELS = {
	salon: 'Выставить у себя',
	online: 'Продать онлайн без склада',
	project: 'Закрыть объект',
	agent: 'Привести клиента',
};

function clean(value) {
	if (value === null || value === undefined) return '—';
	return String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || '—';
}

function moscowTime(value) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	try {
		const formatted = new Intl.DateTimeFormat('ru-RU', {
			timeZone: 'Europe/Moscow',
			dateStyle: 'short',
			timeStyle: 'short',
		}).format(date);
		return `${formatted} МСК`;
	} catch {
		return date.toISOString();
	}
}

function utmEntries(utm) {
	let value = utm;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	return value && typeof value === 'object' ? Object.entries(value) : [];
}

export function formatLeadEmail(lead) {
	const rows = [
		['Заявка', `№${lead.id}`],
		['Время', moscowTime(lead.created_at)],
	];
	if (lead.type === 'price') {
		rows.push(
			['Откуда', 'форма «Получить оптовый прайс»'],
			['Компания / ИНН', lead.company_inn],
			['Имя', lead.name],
			['Телефон', lead.phone],
			['Город', lead.city],
			['Что нужно', NEED_LABELS[lead.need] || lead.need],
			['Уточнение', lead.need_extra],
		);
	} else if (lead.type === 'vk') {
		rows.push(
			['Откуда', 'лид-форма VK'],
			['Имя', lead.name],
			['Телефон', lead.phone],
			['Город', lead.city],
			['Ответы', lead.need],
		);
	} else {
		rows.push(
			['Откуда', 'квиз на первом экране'],
			['Имя', lead.name],
			['Телефон', lead.phone],
			['Город', lead.city],
			['Что продаёт', lead.need],
			['Масштаб', lead.need_extra],
		);
	}
	rows.push(['Страница', lead.source_page]);
	for (const [key, value] of utmEntries(lead.utm)) rows.push([key, value]);

	const text = `${rows.map(([label, value]) => `${label}: ${clean(value)}`).join('\n')}\n\nЗаявка сохранена в админке, раздел «Заявки».\n`;
	// The subject carries no personal data: mail providers log subjects widely.
	if (lead.type === 'vk') return { subject: `Заявка №${lead.id} из лид-формы VK`, text };
	const source = lead.type === 'price' ? 'форма прайса' : 'квиз';
	return { subject: `Заявка №${lead.id} с сайта am-fabrika.ru (${source})`, text };
}

// Error codes only: SMTP error messages can echo addresses.
function describe(error) {
	return [error.code, error.responseCode].filter(Boolean).join(' ') || error.name;
}

export function createOutbox({ repo, transport, from, to, log, intervalMs = OUTBOX_INTERVAL_MS, batchSize = BATCH_SIZE }) {
	let timer = null;
	let current = null;

	async function run() {
		let leads;
		try {
			leads = await repo.pickOutbox(batchSize);
		} catch (error) {
			log(`outbox: database error ${error.code || error.name}`);
			return { sent: 0, failed: 0 };
		}
		let sent = 0;
		let failed = 0;
		for (const lead of leads) {
			const { subject, text } = formatLeadEmail(lead);
			let status = 'sent';
			try {
				await transport.sendMail({ from, to, subject, text });
			} catch (error) {
				status = 'failed';
				log(`lead ${lead.id} email failed: ${describe(error)}`);
			}
			try {
				await repo.setEmailStatus(lead.id, status);
			} catch (error) {
				log(`lead ${lead.id} email status "${status}" not saved: ${error.code || error.name}`);
			}
			if (status === 'sent') {
				sent += 1;
				log(`lead ${lead.id} email sent`);
			} else {
				failed += 1;
			}
		}
		return { sent, failed };
	}

	// One round at a time: a call during a running round joins it, so a lead is
	// never mailed twice in parallel.
	function tick() {
		if (!current) {
			current = run().finally(() => {
				current = null;
			});
		}
		return current;
	}

	return {
		tick,
		start() {
			if (timer) return;
			timer = setInterval(tick, intervalMs);
			tick();
		},
		async stop() {
			clearInterval(timer);
			timer = null;
			if (current) await current;
		},
	};
}

// Returns the outbox, or null (logged once) when SMTP is not configured.
export function setupOutbox({ env, repo, log, makeTransport = createSmtpTransport, intervalMs }) {
	const { settings, missing } = mailSettings(env);
	if (!settings) {
		const nothingSet = SMTP_KEYS.every((key) => !env[key]);
		log(nothingSet ? 'mail disabled: SMTP is not configured' : `mail disabled: not set or invalid ${missing.join(', ')}`);
		return null;
	}
	return createOutbox({
		repo,
		transport: makeTransport(settings),
		from: settings.from,
		to: settings.to,
		log,
		intervalMs,
	});
}
