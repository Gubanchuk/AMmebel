import assert from 'node:assert/strict';
import test from 'node:test';

// The browser is the integration boundary. These small elements let the real
// scripts run; only HTTP is replaced so no test can create an actual lead.
class Element {
	constructor(id = '') {
		this.id = id;
		this.hidden = false;
		this.value = '';
		this.textContent = '';
		this.dataset = {};
		this.style = {};
		this.attributes = new Map();
		this.listeners = new Map();
		this.children = [];
		const classes = new Set();
		this.classList = {
			add: (...names) => names.forEach((name) => classes.add(name)),
			remove: (...names) => names.forEach((name) => classes.delete(name)),
			contains: (name) => classes.has(name),
			toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
		};
	}
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(listener);
	}
	dispatchEvent(event) {
		if (!event.target) event.target = this;
		for (const listener of this.listeners.get(event.type) || []) listener(event);
		return true;
	}
	setAttribute(name, value) { this.attributes.set(name, String(value)); }
	getAttribute(name) { return this.attributes.get(name) ?? null; }
	removeAttribute(name) { this.attributes.delete(name); }
	appendChild(child) { this.children.push(child); return child; }
	querySelector(selector) { return this.queries?.[selector] ?? null; }
	querySelectorAll(selector) { return this.queries?.[selector] ?? []; }
	closest(selector) { return selector === '[data-model-request]' && this.dataset.modelRequest ? this : null; }
	focus() { document.activeElement = this; }
	scrollIntoView() {}
	getBoundingClientRect() { return { top: 120, bottom: 164 }; }
}

let serial = 0;
function setup({ model = '' } = {}) {
	const ids = Object.fromEntries([
		'price', 'pfForm', 'pf-phone', 'pf-name', 'pf-model', 'pfConsent', 'pfSubmit',
		'pfError', 'pfDone', 'pfConsentHint', 'pfTitle', 'pfLead', 'pfModel', 'pfDoneMessage',
		'adCard', 'lightbox', 'lightboxImg', 'lightboxClose', 'lightboxRequest',
	].map((id) => [id, new Element(id)]));
	const doc = new Element();
	doc.body = new Element();
	doc.activeElement = doc.body;
	doc.getElementById = (id) => ids[id] ?? null;
	doc.createElement = () => new Element();
	doc.createTextNode = (text) => ({ textContent: text });
	doc.querySelector = () => null;
	doc.querySelectorAll = () => [];
	globalThis.document = doc;
	globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
	globalThis.window = {
		location: { search: '', pathname: '/' },
		sessionStorage: { getItem: () => null },
		innerHeight: 844,
		matchMedia: () => ({ matches: true }),
		setTimeout,
		clearTimeout,
		scrollBy: () => {},
		amGoal: () => {},
	};
	ids.pfForm.elements = { phone: ids['pf-phone'], name: ids['pf-name'], model: ids['pf-model'], website: new Element() };
	ids['pf-model'].value = model;
	ids.pfForm.dataset.requestMode = model ? 'model' : 'price';
	ids.pfConsent.checked = true;
	ids.pfSubmit.textContent = model ? 'Уточнить цену' : 'Получить прайс';
	ids.pfTitle.textContent = model ? 'Уточнить цену модели' : 'Получить прайс';
	ids.pfLead.textContent = 'Оставьте номер телефона — менеджер пришлёт прайс.';
	ids.pfDoneMessage.textContent = 'Менеджер пришлёт прайс на ваш номер.';
	ids.pfDone.queries = { p: ids.pfDoneMessage };
	ids.pfDone.hidden = true;
	ids.pfError.hidden = true;
	ids.pfModel.hidden = !model;
	ids.adCard.hidden = true;
	ids.lightbox.hidden = true;
	ids.lightboxRequest.hidden = true;
	ids.lightbox.queries = { 'button:not([hidden]), a[href]:not([hidden])': [ids.lightboxClose, ids.lightboxRequest] };
	const requests = [];
	const statuses = [];
	globalThis.fetch = async (_url, options) => {
		requests.push(JSON.parse(options.body));
		return { status: statuses.shift() ?? 201 };
	};
	return { ids, doc, requests, statuses };
}

async function load(script) {
	return import(new URL(`../src/scripts/${script}.js?test=${serial++}`, import.meta.url));
}
function fire(el, type, extra = {}) {
	el.dispatchEvent({ type, preventDefault() { this.defaultPrevented = true; }, ...extra });
}
async function send(ids) {
	fire(ids.pfForm, 'submit');
	await new Promise((resolve) => setImmediate(resolve));
}

test('an initial model survives a failed request and is included in the retry', async () => {
	const { ids, requests, statuses } = setup({ model: 'Модульный диван «Lounge»' });
	statuses.push(503, 201);
	await load('form');
	ids['pf-phone'].value = '+7 999 123-45-67';
	await send(ids);
	assert.equal(requests[0].fields.need_extra, 'Модель: Модульный диван «Lounge»');
	assert.equal(ids.pfError.hidden, false);
	assert.equal(ids.pfForm.hidden, false);
	assert.equal(ids['pf-model'].value, 'Модульный диван «Lounge»');
	await send(ids);
	assert.equal(requests[1].fields.need_extra, 'Модель: Модульный диван «Lounge»');
	assert.equal(ids.pfDone.hidden, false);
	assert.match(ids.pfDoneMessage.textContent, /перезвонит/);
});

test('a model action replaces a retail offer and keeps the selected title after validation', async () => {
	const { ids, doc, requests } = setup();
	await load('form');
	doc.dispatchEvent(new CustomEvent('am:retail-offer', { detail: { product: 'Парящая кровать «Mia»' } }));
	ids.adCard.hidden = false;
	const action = new Element();
	action.dataset.modelRequest = 'Кровать «Gemma»';
	fire(doc, 'click', { target: action });
	await send(ids);
	assert.equal(ids['pf-model'].value, 'Кровать «Gemma»');
	assert.equal(ids.pfModel.hidden, false);
	assert.match(ids.pfModel.textContent, /Кровать «Gemma»/);
	assert.equal(ids.adCard.hidden, true);
	assert.equal(document.activeElement, ids['pf-phone']);
	assert.equal(requests.length, 0);
	assert.match(ids.pfError.textContent, /перезвоним/);
});

test('a retail offer keeps the callback promise through validation, failure and success', async () => {
	const { ids, doc, statuses } = setup();
	statuses.push(503, 201);
	await load('form');
	doc.dispatchEvent(new CustomEvent('am:retail-offer', { detail: { product: 'Парящая кровать «Mia»' } }));
	await send(ids);
	assert.match(ids.pfTitle.textContent, /цену/);
	assert.match(ids.pfLead.textContent, /перезвоним/);
	assert.match(ids.pfError.textContent, /перезвоним/);
	ids['pf-phone'].value = '89991234567';
	await send(ids);
	assert.match(ids.pfSubmit.textContent, /цену/);
	assert.match(ids.pfError.textContent, /повторите|ещё раз/);
	await send(ids);
	assert.match(ids.pfDoneMessage.textContent, /перезвонит/);
	assert.doesNotMatch(ids.pfDoneMessage.textContent, /прайс/);
});

test('an ordinary request keeps manual price delivery and sends no model field', async () => {
	const { ids, requests } = setup();
	await load('form');
	ids['pf-phone'].value = '89991234567';
	await send(ids);
	assert.deepEqual(requests[0].fields, { name: '', phone: '89991234567' });
	assert.match(ids.pfDoneMessage.textContent, /Менеджер пришлёт прайс/);
});

test('the model photo dialog offers the model action and cycles keyboard focus', async () => {
	const { ids, doc } = setup();
	const trigger = new Element();
	trigger.dataset.modelTitle = 'Кровать «Gemma»';
	trigger.queries = { img: { src: '/gemma.webp', alt: 'Кровать «Gemma»' } };
	doc.querySelectorAll = (selector) => selector === '[data-lightbox-open]' ? [trigger] : [];
	await load('lightbox');
	fire(trigger, 'click');
	assert.equal(ids.lightboxRequest.hidden, false);
	assert.equal(ids.lightboxRequest.dataset.modelRequest, 'Кровать «Gemma»');
	assert.equal(document.activeElement, ids.lightboxClose);
	fire(doc, 'keydown', { key: 'Tab' });
	assert.equal(document.activeElement, ids.lightboxRequest);
	fire(doc, 'keydown', { key: 'Tab' });
	assert.equal(document.activeElement, ids.lightboxClose);
	fire(doc, 'keydown', { key: 'Tab', shiftKey: true });
	assert.equal(document.activeElement, ids.lightboxRequest);
	fire(ids.lightbox, 'click', { target: ids.lightboxRequest });
	assert.equal(ids.lightbox.classList.contains('on'), false);
	assert.notEqual(document.activeElement, trigger);
});

test('workshop photos keep the single close control and Escape returns focus', async () => {
	const { ids, doc } = setup();
	const trigger = new Element();
	trigger.queries = { img: { src: '/ceh/packing.webp', alt: 'Упаковка' } };
	doc.querySelectorAll = (selector) => selector === '[data-lightbox-open]' ? [trigger] : [];
	await load('lightbox');
	fire(trigger, 'click');
	assert.equal(ids.lightboxRequest.hidden, true);
	fire(doc, 'keydown', { key: 'Tab' });
	assert.equal(document.activeElement, ids.lightboxClose);
	fire(doc, 'keydown', { key: 'Escape' });
	assert.equal(document.activeElement, trigger);
	assert.equal(document.body.style.overflow, '');
});

test('Hero model actions follow the active photograph after moving between slides', async () => {
	const { ids, doc, requests } = setup();
	for (const id of ['heroCar', 'heroFrame', 'heroPrev', 'heroNext', 'heroModelContext', 'heroName', 'heroNum']) ids[id] = new Element(id);
	const titles = ['Диван «Arte»', 'Диван «Luche»', 'Диван «Di Marco»'];
	const slides = titles.map((alt) => {
		const slide = new Element();
		slide.queries = { img: { alt } };
		return slide;
	});
	const contexts = titles.map((title, i) => {
		const context = new Element();
		context.hidden = i !== 0;
		const action = new Element();
		action.dataset.modelRequest = title;
		context.action = action;
		return context;
	});
	ids.heroCar.queries = { '.hc__slide': slides, '.hc__prg i': [] };
	ids.heroModelContext.queries = { '[data-hero-model]': contexts };
	await load('form');
	await load('hero');
	ids['pf-phone'].value = '89991234567';
	for (const title of titles) {
		const visible = contexts.filter((context) => !context.hidden);
		assert.equal(visible.length, 1);
		fire(doc, 'click', { target: visible[0].action });
		await send(ids);
		assert.equal(requests.at(-1).fields.need_extra, 'Модель: ' + title);
		fire(ids.heroNext, 'click');
	}
	assert.equal(contexts[0].hidden, false);
});

test('a model action aligns the form within the measured header and cookie gap', async () => {
	const { ids, doc } = setup();
	ids.siteHeader = new Element();
	ids.cookieBar = new Element();
	ids.siteHeader.getBoundingClientRect = () => ({ height: 72 });
	ids.cookieBar.getBoundingClientRect = () => ({ height: 116 });
	ids.price.getBoundingClientRect = () => ({ top: 1000, bottom: 1900, height: 900 });
	let formHeight = 600;
	ids.pfForm.getBoundingClientRect = () => ({ top: 1100, bottom: 1100 + formHeight, height: formHeight });
	const scrolls = [];
	window.scrollBy = (options) => scrolls.push(options);
	await load('form');
	const action = new Element();
	action.dataset.modelRequest = 'Кровать «Gemma»';
	fire(doc, 'click', { target: action });
	// Card fits in the 656 px gap: its top lands below the 72 px header.
	assert.equal(scrolls.at(-1)?.top, 1028);
	formHeight = 760;
	fire(doc, 'click', { target: action });
	// Taller card: its bottom lands at 728 px, immediately above cookie.
	assert.equal(scrolls.at(-1)?.top, 1132);
	assert.equal(scrolls.at(-1)?.behavior, 'auto');
});
