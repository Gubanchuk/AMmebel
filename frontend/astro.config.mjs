// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	security: {
		// Content-Security-Policy as a <meta> tag on every page. Astro hashes the
		// inline scripts and styles it renders at build time, so the policy stays
		// valid after every rebuild triggered from the admin panel. Yandex
		// Metrika (plan task 15) will need its hosts added to scriptDirective,
		// connect-src and img-src. frame-ancestors cannot be set from a meta tag;
		// nginx sends X-Frame-Options instead.
		csp: {
			directives: [
				"default-src 'self'",
				"img-src 'self' data:",
				"font-src 'self'",
				"connect-src 'self'",
				"form-action 'self'",
				"base-uri 'self'",
				"object-src 'none'",
				"frame-src 'none'",
				"worker-src 'none'",
				"manifest-src 'self'",
			],
			scriptDirective: {
				resources: ["'self'"],
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
