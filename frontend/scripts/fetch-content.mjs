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
// content-fallback.json. The script prints a warning and never fails the build.
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
// admin panel still lands on the site as a web-sized WebP. 1600px covers the
// fullscreen lightbox; smaller originals are not upscaled.
const PHOTO_TRANSFORM = 'format=webp&quality=80&width=1600&withoutEnlargement=true';

const baseUrl = (process.env.DIRECTUS_URL || '').replace(/\/+$/, '');
const token = process.env.DIRECTUS_TOKEN || '';

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

// File name carries the file's last change time: replacing a photo in the
// admin panel keeps its id, and a new name keeps browsers from showing the
// cached old image.
async function downloadPhoto(file) {
	const changed = Date.parse(file.modified_on || file.uploaded_on) || 0;
	const name = `${file.id}-${changed.toString(36)}.webp`;
	const r = await request(`/assets/${file.id}?${PHOTO_TRANSFORM}`, PHOTO_TIMEOUT_MS);
	if (!r.ok) throw new Error(`photo ${file.id} -> HTTP ${r.status}`);
	await writeFile(path.join(PHOTO_DIR, name), Buffer.from(await r.arrayBuffer()));
	return `/cms/${name}`;
}

async function fromDirectus() {
	const [settings, conditions, models, faq] = await Promise.all([
		api('/items/settings?fields=phone,email,address,price_note'),
		api('/items/conditions?fields=name,value,sort&sort=sort&limit=-1'),
		api(
			'/items/models?fields=title,size,price_from,price_to,visible,sort,photo.id,photo.modified_on,photo.uploaded_on' +
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
		mapped.push({
			title: m.title,
			size: m.size || '',
			priceFrom: m.price_from ?? null,
			priceTo: m.price_to ?? null,
			photo: await downloadPhoto(m.photo),
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

await clean();
if (!baseUrl || !token) {
	console.warn('[content] DIRECTUS_URL or DIRECTUS_TOKEN is not set, building from content-fallback.json');
} else {
	try {
		const content = await fromDirectus();
		await mkdir(path.dirname(OUT_JSON), { recursive: true });
		await writeFile(OUT_JSON, `${JSON.stringify(content, null, '\t')}\n`);
		console.log(
			`[content] from Directus: ${content.conditions.length} conditions, ` +
				`${content.models.length} models, ${content.faq.length} faq`,
		);
	} catch (error) {
		await clean();
		console.warn(`[content] Directus unavailable, building from content-fallback.json: ${describe(error)}`);
	}
}
