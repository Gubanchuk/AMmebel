// Page content for the build. scripts/fetch-content.mjs runs before both
// `astro build` and `astro dev` and writes src/generated/content.json from
// Directus (photos go to public/cms/); every run starts by deleting the
// previous output, so a stale snapshot never outlives its source. When the
// file is absent — Directus unreachable or no credentials (the Vercel preview
// build) — the committed content-fallback.json is used, so the site always
// builds.
// Field names follow the fallback's camelCase shape; the fetch script maps
// Directus snake_case onto it (Ruling R4).
import fallback from '../../../content-fallback.json';

export interface Settings {
	phone: string;
	email: string;
	address: string;
	priceNote: string;
	heroModels: number[];
}

export interface Condition {
	name: string;
	value: string;
}

export interface Model {
	title: string;
	size: string;
	priceFrom: number | null;
	priceTo: number | null;
	photo: string;
	visible: boolean;
	sort: number;
}

export interface FaqItem {
	q: string;
	a: string;
	sort: number;
}

export interface Content {
	settings: Settings;
	conditions: Condition[];
	models: Model[];
	faq: FaqItem[];
}

// A glob instead of a plain import: a missing generated file is a normal
// state here, and a glob that matches nothing resolves to an empty object
// rather than failing the build.
const generated = Object.values(
	import.meta.glob<Content>('../generated/content.json', { eager: true, import: 'default' }),
)[0];

export function getContent(): Content {
	return generated ?? (fallback as Content);
}
