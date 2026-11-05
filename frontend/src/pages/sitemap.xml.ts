import type { APIRoute } from 'astro';
import { getContent } from '../lib/content';
import { getModelGroups, modelPath } from '../lib/models';
import * as politika from '../legal/politika.md';
import * as soglasie from '../legal/soglasie.md';
import * as cookie from '../legal/soglasie-cookie.md';

const origin = 'https://am-fabrika.ru/';
const legalPages = [
	{ path: '/politika/', doc: politika },
	{ path: '/soglasie/', doc: soglasie },
	{ path: '/soglasie-cookie/', doc: cookie },
];

function escapeXml(value: string): string {
	return value.replace(/[<>&"']/g, (character) => ({
		'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
	})[character]!);
}

// The endpoint is generated at build time from the same CMS snapshot as the
// model routes. Legal texts with placeholders keep LegalDoc's noindex guard
// and stay out of the sitemap even in a local LEGAL_PREVIEW build.
export const GET: APIRoute = () => {
	const paths = [
		'/',
		...legalPages
			.filter(({ doc }) => !`${doc.frontmatter.title ?? ''}\n${doc.rawContent()}`.includes('[['))
			.map(({ path }) => path),
		...getModelGroups(getContent().models).map((group) => modelPath(group.title)),
	];
	const urls = [...new Set(paths.map((path) => new URL(path, origin).href))];
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `\t<url><loc>${escapeXml(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
	return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
