// Pulls page content from Directus before `astro build` (plan task 10).
//
// Writes src/generated/content.json in the shape of content-fallback.json and
// downloads model photos into public/cms/. This runs as a separate step rather
// than inside a page's frontmatter because Vite copies public/ during the
// client build, before pages are rendered — photos fetched at render time
// would never reach dist/.
//
// Any failure (no credentials, Directus down, a photo that will not download)
// removes both outputs, and src/lib/content.ts falls back to
// content-fallback.json. The script prints a warning and does not fail the
// build — unless CONTENT_REQUIRED=1, set by the server build: a live site must
// never be republished from the fallback file over the client's edits, so
// there a failure exits non-zero and the previous release stays online.
//
//   DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=... node scripts/fetch-content.mjs

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_JSON = path.join(root, 'src/generated/content.json');
const PHOTO_DIR = path.join(root, 'public/cms');
const FALLBACK = path.join(root, '../content-fallback.json');

const REQUEST_TIMEOUT_MS = 5000;
const PHOTO_TIMEOUT_MS = 30000;
// Directus resizes and re-encodes on its side, so a phone JPEG uploaded in the
// admin panel still lands on the site as a web-sized WebP. The 1600px copy
// (smaller originals are not upscaled) is the <img src> and what the
// fullscreen lightbox shows. Narrower copies go into srcset, so a phone
// downloads a photo sized for its card, not the full file. Widths within 10%
// of the full copy are skipped: they would save almost nothing.
const PHOTO_TRANSFORM = 'format=webp&quality=80&withoutEnlargement=true';
const FULL_WIDTH = 1600;
const VARIANT_WIDTHS = [480, 800, 1024];

const baseUrl = (process.env.DIRECTUS_URL || '').replace(/\/+$/, '');
const token = process.env.DIRECTUS_TOKEN || '';
const required = process.env.CONTENT_REQUIRED === '1';

function request(pathAndQuery, timeoutMs) {
	return fetch(`${baseUrl}${pathAndQuery}`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
}

async function api(pathAndQuery) {
	const r = await request(pathAndQuery, REQUEST_TIMEOUT_MS);
	if (!r.ok) throw new Error(`${pathAndQuery.split('?')[0]} -> HTTP ${r.status}`);
	return (await r.json()).data;
}

const photoStats = { files: 0, bytes: 0 };

async function downloadCopy(file, width, name) {
	const r = await request(`/assets/${file.id}?${PHOTO_TRANSFORM}&width=${width}`, PHOTO_TIMEOUT_MS);
	if (!r.ok) throw new Error(`photo ${file.id} (${width}px) -> HTTP ${r.status}`);
	const body = Buffer.from(await r.arrayBuffer());
	await writeFile(path.join(PHOTO_DIR, name), body);
	photoStats.files++;
	photoStats.bytes += body.length;
}

// File name carries the file's last change time: replacing a photo in the
// admin panel keeps its id, and a new name keeps browsers from showing the
// cached old image. Without a known width (Directus did not read the image)
// the photo gets the full copy only and no srcset.
async function downloadPhoto(file) {
	const changed = Date.parse(file.modified_on || file.uploaded_on) || 0;
	const base = `${file.id}-${changed.toString(36)}`;
	const full = file.width ? Math.min(file.width, FULL_WIDTH) : 0;
	const widths = VARIANT_WIDTHS.filter((w) => w < full * 0.9);
	await Promise.all([
		downloadCopy(file, FULL_WIDTH, `${base}.webp`),
		...widths.map((w) => downloadCopy(file, w, `${base}-${w}.webp`)),
	]);
	const photo = `/cms/${base}.webp`;
	const photoSrcset = full
		? [...widths.map((w) => `/cms/${base}-${w}.webp ${w}w`), `${photo} ${full}w`].join(', ')
		: undefined;
	return { photo, photoSrcset };
}

async function fromDirectus() {
	const [settings, conditions, models, faq] = await Promise.all([
		api('/items/settings?fields=phone,email,address,price_note'),
		api('/items/conditions?fields=name,value,sort&sort=sort&limit=-1'),
		api(
			'/items/models?fields=title,size,price_from,price_to,visible,sort,photo.id,photo.modified_on,photo.uploaded_on,photo.width' +
				'&filter[visible][_eq]=true&sort=sort&limit=-1',
		),
		api('/items/faq?fields=q,a,sort&sort=sort&limit=-1'),
	]);

	// Empty collections mean a broken or wiped database rather than an
	// intended empty page — the hero and the conditions table cannot render
	// without rows, so treat it as unavailable.
	if (!settings || !settings.phone) throw new Error('settings are empty');
	if (!conditions.length) throw new Error('conditions are empty');
	if (!models.length) throw new Error('no visible models');

	const fallback = JSON.parse(await readFile(FALLBACK, 'utf8'));

	await mkdir(PHOTO_DIR, { recursive: true });
	const mapped = [];
	for (const m of models) {
		if (!m.photo) {
			console.warn(`[content] model "${m.title}" (sort ${m.sort}) has no photo, skipped`);
			continue;
		}
		const { photo, photoSrcset } = await downloadPhoto(m.photo);
		mapped.push({
			title: m.title,
			size: m.size || '',
			priceFrom: m.price_from ?? null,
			priceTo: m.price_to ?? null,
			photo,
			photoSrcset,
			visible: true,
			sort: m.sort,
		});
	}
	if (!mapped.length) throw new Error('no visible models with photos');

	return {
		settings: {
			phone: settings.phone,
			email: settings.email,
			address: settings.address,
			priceNote: settings.price_note || '',
			// Which models go to the hero carousel is not editable in Directus
			// yet, so the picks (by sort) stay those of the fallback file.
			heroModels: fallback.settings.heroModels,
		},
		conditions: conditions.map(({ name, value }) => ({ name, value })),
		models: mapped,
		faq: faq.map(({ q, a, sort }) => ({ q, a, sort })),
	};
}

async function clean() {
	await rm(OUT_JSON, { force: true });
	await rm(PHOTO_DIR, { recursive: true, force: true });
}

function describe(error) {
	const cause = error.cause ? ` (${error.cause.code || error.cause.message})` : '';
	return `${error.message}${cause}`;
}

function unavailable(reason) {
	if (required) {
		console.error(`[content] ${reason}; CONTENT_REQUIRED=1, stopping the build`);
		process.exitCode = 1;
	} else {
		console.warn(`[content] ${reason}; building from content-fallback.json`);
	}
}

await clean();
if (!baseUrl || !token) {
	unavailable('DIRECTUS_URL or DIRECTUS_TOKEN is not set');
} else {
	try {
		const content = await fromDirectus();
		await mkdir(path.dirname(OUT_JSON), { recursive: true });
		await writeFile(OUT_JSON, `${JSON.stringify(content, null, '\t')}\n`);
		console.log(
			`[content] from Directus: ${content.conditions.length} conditions, ` +
				`${content.models.length} models, ${content.faq.length} faq; ` +
				`${photoStats.files} photo files, ${Math.round(photoStats.bytes / 1024)} KB`,
		);
	} catch (error) {
		await clean();
		unavailable(`Directus unavailable: ${describe(error)}`);
	}
}
