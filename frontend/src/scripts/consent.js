// Cookie consent (page block 11, site-wide via CookieBar). Exposes
// window.amConsent.analyticsAllowed() for the Metrika loader (task 15) and
// dispatches am:consent-analytics when the visitor accepts. Choice persists in
// localStorage.amConsent; every localStorage call is guarded so a disabled or
// unavailable storage (private mode, browser setting) never throws.

var CONSENT_KEY = 'amConsent';

function readConsent() {
	try {
		var raw = window.localStorage.getItem(CONSENT_KEY);
		if (!raw) return null;
		var parsed = JSON.parse(raw);
		return parsed && typeof parsed.analytics === 'boolean' ? parsed : null;
	} catch (e) {
		return null;
	}
}

function writeConsent(analytics) {
	try {
		window.localStorage.setItem(
			CONSENT_KEY,
			JSON.stringify({ analytics: analytics, ts: new Date().toISOString() })
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

	if (!readConsent()) {
		bar.hidden = false;
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
	function scrollToPriceClear() {
		var target = document.getElementById('price');
		if (!target) return;
		var barHeight = bar.hidden ? 0 : bar.getBoundingClientRect().height;
		var availableHeight = window.innerHeight - barHeight;
		var rect = target.getBoundingClientRect();
		var delta = rect.height <= availableHeight ? rect.top : rect.bottom - availableHeight;
		// Global constraint: prefers-reduced-motion disables all animation, this
		// custom scroll included — the site's own html{scroll-behavior:smooth}
		// already respects it (base.css), this manual scrollBy has to match.
		var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		window.scrollBy({ top: delta, behavior: reduceMotion ? 'auto' : 'smooth' });
	}

	document.querySelectorAll('a[href="#price"]').forEach(function (link) {
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
	if (window.location.hash === '#price') {
		window.requestAnimationFrame(scrollToPriceClear);
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
