// Cookie consent (page block 11, site-wide via CookieBar). Exposes
// window.amConsent.analyticsAllowed() for the Metrika loader (task 15) and
// dispatches am:consent-analytics when the visitor accepts. Choice persists in
// localStorage.amConsent as {analytics, v, ts}; every localStorage call is
// guarded so a disabled or unavailable storage (private mode, browser setting)
// never throws.
//
// A stored choice counts only while it was made for the current consent text
// version and is under a year old: cookie consent lasts one year
// (clients/sf-sofa/legal/07-teksty-dlya-sajta.md, section 5). Otherwise — no
// record, a record from before versioning, another version, an expired or
// unreadable ts — the bar is shown again and analytics stays off until the
// visitor answers anew.

import { CONSENT_VERSION } from './consent-version.js';

var CONSENT_KEY = 'amConsent';
var CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
// A ts further ahead of the device clock than this is not trusted: after the
// clock is corrected it would keep an old choice alive for years.
var CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function readConsent() {
	try {
		var raw = window.localStorage.getItem(CONSENT_KEY);
		if (!raw) return null;
		var parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.analytics !== 'boolean') return null;
		if (parsed.v !== CONSENT_VERSION) return null;
		var age = Date.now() - Date.parse(parsed.ts);
		if (!(age <= CONSENT_MAX_AGE_MS && age >= -CLOCK_SKEW_MS)) return null;
		return parsed;
	} catch (e) {
		return null;
	}
}

function writeConsent(analytics) {
	try {
		window.localStorage.setItem(
			CONSENT_KEY,
			JSON.stringify({ analytics: analytics, v: CONSENT_VERSION, ts: new Date().toISOString() })
		);
	} catch (e) {
		// Storage unavailable — consent stays session-only, bar will reappear next visit.
	}
}

window.amConsent = {
	analyticsAllowed: function () {
		var state = readConsent();
		return !!(state && state.analytics === true);
	},
};

(function () {
	var bar = document.getElementById('cookieBar');
	if (!bar) return;

	var acceptBtn = document.getElementById('cookieAccept');
	var declineBtn = document.getElementById('cookieDecline');

	// The bar is position:fixed and reserves no layout space on its own, so a
	// visitor landing straight on #price (Hero/Needs CTAs both anchor there)
	// can have the consent checkbox sitting right under it. Reserve real
	// clearance while the bar is visible: scroll-padding-bottom makes any
	// anchor jump / scrollIntoView land above the bar, and body padding-bottom
	// keeps the last content clear when the user scrolls to the page end.
	// Measured live (not hardcoded) because the bar's height differs between
	// the single-row desktop layout and the stacked mobile one.
	function updateBarSpacing() {
		if (bar.hidden) {
			document.documentElement.style.scrollPaddingBottom = '';
			document.body.style.paddingBottom = '';
			return;
		}
		var height = bar.getBoundingClientRect().height + 'px';
		document.documentElement.style.scrollPaddingBottom = height;
		document.body.style.paddingBottom = height;
	}

	// On phones the stacked bar is ~110px tall and landed right on the first
	// screen's «Получить прайс» button, so there it waits for the first scroll
	// (or a jump to #price) before appearing. Nothing is collected in the
	// meantime: Metrika loads only after «Разрешить».
	var barPending = false;
	function showPendingBar() {
		if (!barPending) return;
		barPending = false;
		bar.hidden = false;
		updateBarSpacing();
	}
	if (!readConsent()) {
		var narrow = window.matchMedia('(max-width: 740px)').matches;
		if (narrow && window.scrollY < 80 && window.location.hash !== '#price') {
			barPending = true;
			var onFirstScroll = function () {
				if (window.scrollY < 80) return;
				window.removeEventListener('scroll', onFirstScroll);
				showPendingBar();
			};
			window.addEventListener('scroll', onFirstScroll, { passive: true });
		} else {
			bar.hidden = false;
		}
	}
	updateBarSpacing();
	window.addEventListener('resize', updateBarSpacing);

	// scroll-padding-bottom only affects browsers' native block:'nearest'/'end'
	// scroll math — a plain #price fragment jump aligns the SECTION's top with
	// the viewport top regardless of it, so on narrow viewports where the whole
	// section (title + fields + consent row + CTA) is taller than the space
	// left above the bar, the trailing consent row/button still lands under it.
	// Fix that case directly: if #price doesn't fit above the bar, align the
	// section's bottom with the bar's top instead of the section's top with the
	// viewport's top, so the actionable controls are the part guaranteed visible.
	//
	// The sticky header (#siteHeader) sits on top of the viewport too, so the
	// "fits" branch also needs the section's top pushed down below it — the
	// "too tall" branch's target is the bar's top, which the header doesn't
	// touch, so its formula is unchanged.
	function scrollToPriceClear() {
		var target = document.getElementById('price');
		if (!target) return;
		showPendingBar(); // the scroll below must leave room for the bar
		var header = document.getElementById('siteHeader');
		var headerHeight = header ? header.getBoundingClientRect().height : 0;
		var barHeight = bar.hidden ? 0 : bar.getBoundingClientRect().height;
		var availableHeight = window.innerHeight - headerHeight - barHeight;
		var rect = target.getBoundingClientRect();
		var delta;
		if (rect.height <= availableHeight) {
			delta = rect.top - headerHeight;
		} else {
			// Too tall for the gap (phones): aim at the form card itself, not the
			// whole section — bottom-aligning the section pushed the heading and
			// lead under the header, the reader landed mid-sentence. Card top
			// under the header when the card fits above the bar (the consent row
			// and the button stay visible), else the card's bottom to the bar.
			var card = target.querySelector('.pf');
			var box = card ? card.getBoundingClientRect() : rect;
			delta = box.height <= availableHeight
				? box.top - headerHeight
				: box.bottom - (window.innerHeight - barHeight);
		}
		// Global constraint: prefers-reduced-motion disables all animation, this
		// custom scroll included — the site's own html{scroll-behavior:smooth}
		// already respects it (base.css), this manual scrollBy has to match.
		var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		window.scrollBy({ top: delta, behavior: reduceMotion ? 'auto' : 'smooth' });
	}

	document.querySelectorAll('a[href="#price"], a[href="/#price"]').forEach(function (link) {
		link.addEventListener('click', function (e) {
			e.preventDefault();
			scrollToPriceClear();
			// Repeated clicks on the CTA shouldn't each push a new history entry
			// for the same #price hash.
			if (window.history && history.pushState && window.location.hash !== '#price') {
				history.pushState(null, '', '#price');
			}
		});
	});

	// Cold load / direct link with #price already in the URL: the browser's own
	// top-aligned jump happens before this script runs — correct it the same way.
	// Chrome can also perform a SECOND, later fragment-scroll of its own (after
	// paint, sometimes after 'load') that undoes the rAF correction below — so
	// re-run the same idempotent correction after 'load' settles and once more
	// on a short timeout as a safety net for slower cold loads. Redundant calls
	// are harmless: if the section is already clear, the computed delta is ~0.
	if (window.location.hash === '#price') {
		var correctPriceScroll = function () {
			if (window.location.hash === '#price') { scrollToPriceClear(); }
		};
		window.requestAnimationFrame(correctPriceScroll);
		window.addEventListener('load', function () {
			window.requestAnimationFrame(function () {
				window.requestAnimationFrame(correctPriceScroll);
			});
		});
		setTimeout(correctPriceScroll, 600);
	}

	if (acceptBtn) {
		acceptBtn.addEventListener('click', function () {
			writeConsent(true);
			bar.hidden = true;
			updateBarSpacing();
			document.dispatchEvent(new CustomEvent('am:consent-analytics', { detail: { allowed: true } }));
		});
	}
	if (declineBtn) {
		declineBtn.addEventListener('click', function () {
			writeConsent(false);
			bar.hidden = true;
			updateBarSpacing();
		});
	}
})();
