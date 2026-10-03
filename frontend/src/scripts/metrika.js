// Yandex Metrika loader, site-wide via CookieBar. The counter loads only after
// the visitor allowed analytics cookies (consent.js): at once when the choice
// is already stored, otherwise on am:consent-analytics. Session recording
// (Webvisor, also the scroll map and form analytics) is on since consent
// version 2026-10-03, which names it (clients/sf-sofa/legal/03-soglasie.md,
// document 2, §4); form fields carry ym-disable-keys so their contents are
// recorded as asterisks. No <noscript> pixel: it would count a visit before
// any consent.
//
// window.amGoal(name) is defined here for every page and sends a goal to the
// counter; until the counter is loaded it only logs to console.debug. Goals the
// site reports: form_submit, quiz_submit, quiz_step_N, phone_click, and lead —
// any lead the service stored (am:lead from form.js and quiz.js). Direct is
// pointed at the lead goal.
//
// Counter 113250938 belongs to the am.sofa.ru Yandex login (the Direct
// account). The tag URL and init options follow the snippet Metrika issued for
// it, minus ecommerce (no shop on the site). COUNTER_ID 0 keeps Metrika off.

var COUNTER_ID = 113250938;
var TAG_URL = 'https://mc.yandex.ru/metrika/tag.js?id=' + COUNTER_ID;

var loaded = false;

function load() {
	if (loaded || !COUNTER_ID) return;
	loaded = true;
	// Yandex's own snippet: ym() queues calls until tag.js arrives.
	(function (m, e, t, r, i, k, a) {
		m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
		m[i].l = 1 * new Date();
		for (var j = 0; j < document.scripts.length; j++) {
			if (document.scripts[j].src === r) return;
		}
		k = e.createElement(t);
		a = e.getElementsByTagName(t)[0];
		k.async = 1;
		k.src = r;
		a.parentNode.insertBefore(k, a);
	})(window, document, 'script', TAG_URL, 'ym');
	window.ym(COUNTER_ID, 'init', {
		ssr: true,
		clickmap: true,
		trackLinks: true,
		accurateTrackBounce: true,
		webvisor: true,
	});
}

window.amGoal = function (name) {
	// Cookie-free page statistics (stats.js) count goals for every visitor.
	if (typeof window.amStatGoal === 'function') window.amStatGoal(name);
	if (loaded) {
		window.ym(COUNTER_ID, 'reachGoal', name);
	} else {
		console.debug('[goal]', name);
	}
};

document.addEventListener('am:lead', function () {
	window.amGoal('lead');
});

if (window.amConsent && window.amConsent.analyticsAllowed()) {
	load();
} else {
	document.addEventListener('am:consent-analytics', load);
}
