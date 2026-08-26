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

	if (!readConsent()) {
		bar.hidden = false;
	}

	if (acceptBtn) {
		acceptBtn.addEventListener('click', function () {
			writeConsent(true);
			bar.hidden = true;
			document.dispatchEvent(new CustomEvent('am:consent-analytics', { detail: { allowed: true } }));
		});
	}
	if (declineBtn) {
		declineBtn.addEventListener('click', function () {
			writeConsent(false);
			bar.hidden = true;
		});
	}
})();
