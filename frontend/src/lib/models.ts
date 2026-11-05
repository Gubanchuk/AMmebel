import type { Model } from './content';

export interface ModelGroup {
	slug: string;
	title: string;
	models: Model[];
}

const cyrillic: Record<string, string> = {
	а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
	и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
	с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
	ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function cleanTitle(title: string): string {
	const cleaned = title.normalize('NFKC').trim().replace(/\s+/g, ' ');
	if (!cleaned) throw new Error('У модели отсутствует название');
	return cleaned;
}

function titleKey(title: string): string {
	return cleanTitle(title).toLowerCase().replace(/[«»“”"]/g, '"');
}

function modelSlug(title: string): string {
	const cleaned = cleanTitle(title);
	// The quoted model name survives editorial changes to the furniture type.
	const name = cleaned.match(/[«"“]([^»"”]+)[»"”]/)?.[1] ?? cleaned;
	const slug = Array.from(name.toLowerCase(), (letter) => cyrillic[letter] ?? letter)
		.join('')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug) throw new Error(`Невозможно получить slug модели: ${cleaned}`);
	return slug;
}

export function getModelGroups(models: Model[]): ModelGroup[] {
	const groups = new Map<string, ModelGroup>();
	const slugs = new Map<string, string>();
	const visible = models.filter((model) => model.visible).sort((a, b) => a.sort - b.sort);
	for (const model of visible) {
		const key = titleKey(model.title);
		const existing = groups.get(key);
		if (existing) {
			existing.models.push(model);
			continue;
		}
		const slug = modelSlug(model.title);
		const previousTitle = slugs.get(slug);
		// Fail the build rather than silently merge different CMS model names or
		// create links that resolve to a different item. modelPath stays stateless.
		if (previousTitle) {
			throw new Error(`Конфликт slug "${slug}": ${previousTitle} / ${model.title}`);
		}
		const group = { slug, title: cleanTitle(model.title), models: [model] };
		groups.set(key, group);
		slugs.set(slug, group.title);
	}
	return [...groups.values()];
}

export function modelPath(model: Model | string): string {
	return `/modeli/${modelSlug(typeof model === 'string' ? model : model.title)}/`;
}
