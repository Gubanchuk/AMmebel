// @ts-check
import { defineConfig } from 'astro/config';

// Yandex Metrika hosts (src/scripts/metrika.js), from Yandex's CSP list:
// yandex.ru/support/metrica/ru/code/install-counter-csp. The webvisor hosts
// are left out (session recording is off). tag.js opens wss://mc.yandex.ru
// even with Webvisor off, so the socket hosts go into connect-src.
const METRIKA_HOSTS = [
	'https://mc.yandex.ru', 'https://mc.yandex.az', 'https://mc.yandex.by',
	'https://mc.yandex.co.il', 'https://mc.yandex.com', 'https://mc.yandex.com.am',
	'https://mc.yandex.com.ge', 'https://mc.yandex.com.tr', 'https://mc.yandex.ee',
	'https://mc.yandex.fr', 'https://mc.yandex.kg', 'https://mc.yandex.kz',
	'https://mc.yandex.lt', 'https://mc.yandex.lv', 'https://mc.yandex.md',
	'https://mc.yandex.tj', 'https://mc.yandex.tm', 'https://mc.yandex.uz',
	'https://yastatic.net',
];
const METRIKA_SOCKETS = METRIKA_HOSTS
	.filter((host) => host.startsWith('https://mc.'))
	.map((host) => host.replace('https://', 'wss://'));

// https://astro.build/config
export default defineConfig({
	security: {
		// Content-Security-Policy as a <meta> tag on every page. Astro hashes the
		// inline scripts and styles it renders at build time, so the policy stays
		// valid after every rebuild triggered from the admin panel. Yandex
		// Metrika's hosts are allowed in script-src, connect-src and img-src.
		// frame-ancestors cannot be set from a meta tag; nginx sends
		// X-Frame-Options instead.
		csp: {
			directives: [
				"default-src 'self'",
				`img-src 'self' data: ${METRIKA_HOSTS.join(' ')}`,
				"font-src 'self'",
				`connect-src 'self' ${[...METRIKA_HOSTS, ...METRIKA_SOCKETS].join(' ')}`,
				"form-action 'self'",
				"base-uri 'self'",
				"object-src 'none'",
				"frame-src 'none'",
				"worker-src 'none'",
				"manifest-src 'self'",
			],
			scriptDirective: {
				resources: ["'self'", ...METRIKA_HOSTS],
				// Astro does not hash is:inline scripts. This is the one in
				// src/components/Showcase.astro that parks the models carousel
				// before first paint; it has no injected values, so the hash is
				// stable across rebuilds. Recompute it whenever that script's text
				// changes, or the browser will refuse to run it.
				hashes: ['sha256-j6gaEY0+YpoAJ4R0LvxUDI8TLVr8lQzpO5jeNNFsvcg='],
			},
			styleDirective: { resources: ["'self'"] },
		},
	},
});
