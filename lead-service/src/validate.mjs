// Validation of the payload sent by the site: frontend/src/scripts/form.js
// (type "price") and frontend/src/scripts/quiz.js (type "quiz").
//
//   { type, fields: {...}, consent: { version }, source_page?, utm? }
//
// The rules mirror what each form requires on the client, so a visitor who
// passed the form's own checks is never rejected here.

export const LEAD_TYPES = ['quiz', 'price'];
export const NEEDS = ['salon', 'online', 'project', 'agent'];
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// Every text column of leads is varchar(255) (infra/directus-schema.yaml).
const MAX_TEXT = 255;
const MAX_CONSENT_VERSION = 64;

export function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Missing -> '', strings -> trimmed with control characters collapsed,
// anything else -> null (invalid).
function text(value) {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

function digitCount(value) {
	return (value.match(/\d/g) || []).length;
}

// The hidden "website" input of the price form. Humans never fill it.
export function isHoneypotFilled(body) {
	const candidates = [body.website, isObject(body.fields) ? body.fields.website : undefined];
	return candidates.some((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

export function consentVersion(body) {
	if (!isObject(body.consent)) return null;
	const version = text(body.consent.version);
	return version && version.length <= MAX_CONSENT_VERSION ? version : null;
}

export function pickUtm(value) {
	if (!isObject(value)) return null;
	const utm = {};
	for (const key of UTM_KEYS) {
		const item = text(value[key]);
		if (item) utm[key] = item.slice(0, MAX_TEXT);
	}
	return Object.keys(utm).length > 0 ? utm : null;
}

function sourcePage(value) {
	const page = text(value);
	return page && page.startsWith('/') && page.length <= MAX_TEXT ? page : null;
}

// Returns { lead } with the columns to store, or { errors: [field names] }.
export function validateLead(body) {
	const errors = new Set();
	const type = body.type;
	if (!LEAD_TYPES.includes(type)) errors.add('type');

	const fields = body.fields;
	if (!isObject(fields)) {
		errors.add('fields');
		return { errors: [...errors] };
	}

	function field(key, required = false) {
		const value = text(fields[key]);
		if (value === null || value.length > MAX_TEXT || (required && value === '')) {
			errors.add(key);
			return null;
		}
		return value === '' ? null : value;
	}

	// Since 08.10.2026 the price form asks for the phone only, the name is
	// optional there. The quiz still requires the name.
	const name = field('name', type !== 'price');
	const phone = field('phone', true);
	if (phone !== null && digitCount(phone) < 10) errors.add('phone');

	let lead = null;
	if (type === 'price') {
		// Company, city and task were dropped from the form on 08.10.2026. They are
		// still accepted when sent (an old page in a visitor's tab), with the old
		// checks: «Компания / ИНН» made of digits only is an INN of 10 or 12 digits.
		const companyInn = field('company_inn');
		if (companyInn !== null && /^[\d\s]+$/.test(companyInn) && ![10, 12].includes(digitCount(companyInn))) {
			errors.add('company_inn');
		}
		const city = field('city');
		const need = field('need');
		if (need !== null && !NEEDS.includes(need)) errors.add('need');
		const needExtra = field('need_extra');
		lead = { type, company_inn: companyInn, name, phone, city, need, need_extra: needExtra };
	} else if (type === 'quiz') {
		// Quiz answers: step 1 (what they sell) and step 2 (scale) are the texts of
		// the chosen options. The quiz lets a visitor skip both steps and the city.
		const city = field('city');
		const need = field('business');
		const needExtra = field('scale');
		lead = { type, company_inn: null, name, phone, city, need, need_extra: needExtra };
	}

	if (errors.size > 0) return { errors: [...errors] };
	return {
		lead: {
			...lead,
			source_page: sourcePage(body.source_page),
			utm: pickUtm(body.utm),
		},
	};
}
