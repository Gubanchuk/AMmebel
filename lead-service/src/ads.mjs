// Which ad a lead answered. The manager calls back and has to know which sofa
// or bed the person liked, so the ad goes in front of the lead's answers in
// need, its picture link into need_extra, and both into the MAX message.
//
// Two kinds of ads lead here:
// - VK lead forms (src/vk-leads.mjs): {title, image} of the VK banner, looked
//   up by banner id;
// - the site's own banners (Yandex Direct and others): the ad link carries
//   utm_content=<slug>, and the slug is looked up in ad-banners.json. The ad
//   is {title, label, image}, where label is the whole line for the manager.
//
// ad-banners.json has a copy in frontend/src/lib/ad-banners.json: the site
// shows the same product and price next to the price form (Direct wants the
// price in the ad to match the landing page). The two builds run apart on the
// server (lead-service is built from its own folder, the site from frontend
// only), so the file is copied; test/ads.test.mjs checks the copies match.

import { readFileSync } from 'node:fs';

// Banner pictures for MAX and the admin panel live on the site:
// frontend/public/ads/<slug>.jpg. MAX downloads them by this link.
export const SITE_URL = 'https://am-fabrika.ru';

// Every text column of leads is varchar(255).
const MAX_TEXT = 255;

export const AD_BANNERS = deepFreeze(JSON.parse(readFileSync(new URL('./ad-banners.json', import.meta.url), 'utf8')));

function deepFreeze(value) {
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

function clean(value) {
	if (value === undefined || value === null) return null;
	const text = String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
	return text === '' ? null : text.slice(0, MAX_TEXT);
}

// 128000 -> "от 128 000 ₽"
export function formatPrice(price) {
	return `от ${String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}

// The site banner named by utm_content, or null for a missing or unknown slug.
export function siteAd(utm) {
	const slug = utm?.utm_content;
	if (typeof slug !== 'string' || !Object.hasOwn(AD_BANNERS, slug)) return null;
	const banner = AD_BANNERS[slug];
	return {
		title: banner.title,
		label: `Баннер «${banner.title}» — ${banner.product}, ${formatPrice(banner.price)}`,
		image: `${SITE_URL}/ads/${slug}.jpg`,
	};
}

// The line about the ad for need and the MAX message, or null.
export function adLine(ad) {
	if (!ad) return null;
	if (ad.label) return ad.label;
	return ad.title ? `Объявление «${ad.title}»` : null;
}

// The lead with the ad it answered: the ad line in front of the answers in
// need, the picture link in front of need_extra (the quiz keeps its answer
// there). Ad first in both, so a cut at 255 characters never hits the link.
export function withAd(lead, ad) {
	if (!ad) return lead;
	const picture = ad.image ? `Картинка объявления: ${ad.image}` : null;
	return {
		...lead,
		need: clean([adLine(ad), lead.need].filter(Boolean).join('; ')),
		need_extra: clean([picture, lead.need_extra].filter(Boolean).join('; ')),
	};
}
