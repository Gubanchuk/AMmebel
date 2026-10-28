import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AD_BANNERS, formatPrice, siteAd, withAd } from '../src/ads.mjs';
import { createMaxNotifier, leadMessage } from '../src/trigger.mjs';
import { freshIp, postJson, priceLead, quizLead, startApp } from './helpers.mjs';

const FRONTEND = new URL('../../frontend/', import.meta.url);
const FRONTEND_CATALOG = new URL('src/lib/ad-banners.json', FRONTEND);
const besideFrontend = existsSync(fileURLToPath(FRONTEND_CATALOG)) ? false : 'frontend is not next to lead-service';

const SOFA_2 = 'Баннер «Кот одобрил, дети не сломали» — серый раскладной диван, от 128 000 ₽';
const SOFA_2_PICTURE = 'Картинка объявления: https://am-fabrika.ru/ads/sofa-2.jpg';
const AD_UTM = { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'am-retail' };

test('catalog: eleven banners, each a sofa or a bed with a title, a product and a price', () => {
	assert.equal(Object.keys(AD_BANNERS).length, 11);
	assert.ok(Object.isFrozen(AD_BANNERS));
	for (const [slug, banner] of Object.entries(AD_BANNERS)) {
		assert.match(slug, /^(sofa|bed)-\d+$/);
		assert.equal(banner.kind, slug.split('-')[0], slug);
		assert.ok(banner.title && banner.product, slug);
		assert.ok(Number.isInteger(banner.price) && banner.price > 0, slug);
		assert.ok(Object.isFrozen(banner), slug);
	}
});

test('formatPrice groups thousands', () => {
	assert.equal(formatPrice(128000), 'от 128 000 ₽');
	assert.equal(formatPrice(97650), 'от 97 650 ₽');
	assert.equal(formatPrice(191700), 'от 191 700 ₽');
});

test('siteAd names the banner of a known utm_content and nothing else', () => {
	assert.deepEqual(siteAd({ ...AD_UTM, utm_content: 'sofa-2' }), {
		title: 'Кот одобрил, дети не сломали',
		label: SOFA_2,
		image: 'https://am-fabrika.ru/ads/sofa-2.jpg',
	});
	assert.equal(
		siteAd({ utm_content: 'bed-9' }).label,
		'Баннер «Как в отеле. Без выезда в 12:00» — парящая кровать «Mia», бежевая, от 97 650 ₽',
	);
	for (const utm of [null, undefined, {}, AD_UTM, { utm_content: '' }, { utm_content: 'sofa-99' }, { utm_content: 'SOFA-2' }]) {
		assert.equal(siteAd(utm), null, JSON.stringify(utm));
	}
	for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
		assert.equal(siteAd({ utm_content: key }), null, key);
	}
});

test('withAd puts a site banner in front of the quiz answers and keeps them', () => {
	const ad = siteAd({ utm_content: 'sofa-2' });
	const quiz = { type: 'quiz', need: 'Мебель в своём салоне', need_extra: 'От двух до пяти' };
	assert.deepEqual(withAd(quiz, ad), {
		type: 'quiz',
		need: `${SOFA_2}; Мебель в своём салоне`,
		need_extra: `${SOFA_2_PICTURE}; От двух до пяти`,
	});
	const price = { type: 'price', need: null, need_extra: null };
	assert.deepEqual(withAd(price, ad), { type: 'price', need: SOFA_2, need_extra: SOFA_2_PICTURE });
	// a long answer is cut, the picture link in front of it is not
	const long = withAd({ need: null, need_extra: 'х'.repeat(300) }, ad);
	assert.equal(long.need_extra.length, 255);
	assert.ok(long.need_extra.startsWith(SOFA_2_PICTURE));
});

test('price lead from a site banner: the banner in need, the picture in need_extra, the ad to MAX', async (t) => {
	const announced = [];
	const app = await startApp(t, { onStored: (...args) => announced.push(args) });
	const response = await postJson(
		app.base,
		priceLead({ fields: { phone: '+7 918 000-00-00' }, utm: { ...AD_UTM, utm_content: 'sofa-2' } }),
		freshIp(),
	);
	assert.equal(response.status, 201);
	const row = app.repo.rows[0];
	assert.equal(row.need, SOFA_2);
	assert.equal(row.need_extra, SOFA_2_PICTURE);
	assert.deepEqual(row.utm, { ...AD_UTM, utm_content: 'sofa-2' });
	assert.deepEqual(announced, [[1, 'site', siteAd({ utm_content: 'sofa-2' })]]);
});

test('quiz lead from a site banner keeps its answers after the banner', async (t) => {
	const app = await startApp(t);
	const response = await postJson(app.base, quizLead({ utm: { utm_content: 'bed-10' } }), freshIp());
	assert.equal(response.status, 201);
	const row = app.repo.rows[0];
	assert.equal(row.need, 'Баннер «Мизинец спасён: углы мягкие» — серая стёганая кровать, от 117 300 ₽; Мебель в своём салоне или шоуруме');
	assert.equal(row.need_extra, 'Картинка объявления: https://am-fabrika.ru/ads/bed-10.jpg; От двух до пяти');
});

test('unknown or missing utm_content changes nothing', async (t) => {
	const announced = [];
	const app = await startApp(t, { onStored: (...args) => announced.push(args) });
	for (const utm of [{ ...AD_UTM, utm_content: 'sofa-99' }, AD_UTM, undefined]) {
		const response = await postJson(app.base, quizLead({ utm }), freshIp());
		assert.equal(response.status, 201);
	}
	for (const row of app.repo.rows) {
		assert.equal(row.need, 'Мебель в своём салоне или шоуруме');
		assert.equal(row.need_extra, 'От двух до пяти');
	}
	assert.deepEqual(announced, [
		[1, 'site', null],
		[2, 'site', null],
		[3, 'site', null],
	]);
});

test('MAX message for a site banner: the banner line in the text, its picture attached', async () => {
	const ad = siteAd({ utm_content: 'sofa-2' });
	assert.equal(leadMessage(12, 'site', ad), `Новая заявка №12 с сайта\n${SOFA_2}`);
	assert.equal(leadMessage(12, 'site', null), 'Новая заявка №12 с сайта');

	const requests = [];
	const notify = createMaxNotifier({
		env: { MAX_BOT_TOKEN: 'token', MAX_CHAT_ID: '-1', MAX_API_URL: 'https://max.test', ADMIN_URL: 'https://admin.example.ru' },
		log() {},
		fetchImpl: async (url, init) => {
			requests.push(JSON.parse(init.body));
			return new Response('{}', { status: 200 });
		},
	});
	assert.equal(await notify(12, 'site', ad), true);
	assert.equal(requests[0].text, `Новая заявка №12 с сайта\n${SOFA_2}`);
	assert.deepEqual(requests[0].attachments[0], { type: 'image', payload: { url: 'https://am-fabrika.ru/ads/sofa-2.jpg' } });
	assert.equal(requests[0].attachments[1].type, 'inline_keyboard');
});

test('the site has the same catalog', { skip: besideFrontend }, async () => {
	const site = JSON.parse(await readFile(FRONTEND_CATALOG, 'utf8'));
	assert.deepEqual(site, JSON.parse(JSON.stringify(AD_BANNERS)), 'copy src/ad-banners.json to frontend/src/lib/ad-banners.json');
});

test('the site has the banner picture and the product photo of every banner', { skip: besideFrontend }, () => {
	for (const slug of Object.keys(AD_BANNERS)) {
		assert.ok(existsSync(fileURLToPath(new URL(`public/ads/${slug}.jpg`, FRONTEND))), `public/ads/${slug}.jpg`);
		assert.ok(existsSync(fileURLToPath(new URL(`public/ads/foto/${slug}.webp`, FRONTEND))), `public/ads/foto/${slug}.webp`);
	}
});
