// Anonymous page statistics, site-wide via CookieBar. Yandex Metrika runs only
// for visitors who pressed «Разрешить», so it misses most ad clicks; this
// counts every page view without cookies, storage writes or identifiers.
//
// What is sent: a random id for this page view only (kept in memory, a new
// one on every load, so two views of the same person cannot be linked), the
// path, device class by viewport width, UTM labels, whether the landing URL
// had yclid (the value itself is not sent), seconds on the page, scroll depth,
// which page blocks were on screen and for how long, form activity (names of
// the fields touched and of the fields the form rejected, never their values),
// goals from window.amGoal, phone/mail/CTA clicks and the cookie bar outcome.
//
// nginx answers GET /s with an empty gif and writes only the query string and
// the time rounded to the minute to its own log (infra/nginx/site.conf): no IP,
// no user agent. Report: infra/stats-report.py.

var ENDPOINT = '/s';
var SCHEMA = '1';
var TICK_MS = 500;
var MAX_TRACK_MS = 30 * 60 * 1000;
var MAX_BEACONS = 40;

// Page blocks in page order. A block is "on screen" while it covers at least
// a third of the viewport, or while 60% of it is visible (short blocks).
var BLOCKS = [
	['h', '.demo'],
	['c', '#conditions'],
	['m', '#models'],
	['n', '#needs'],
	['r', '#production'],
	['f', '#price'],
	['z', '.foot'],
];

var FIELD_KEYS = {
	company_inn: 'inn',
	name: 'name',
	phone: 'phone',
	city: 'city',
	need: 'need',
	need_extra: 'extra',
	pfConsent: 'consent',
	pfNeed: 'need',
};

var UTM_PARAMS = [
	['utm_source', 'us'],
	['utm_medium', 'um'],
	['utm_campaign', 'uc'],
	['utm_content', 'ux'],
	['utm_term', 'ut'],
];

var startedAt = Date.now();
var viewId = randomId();
var seq = 0;
var visibleMs = 0;
var maxScroll = 0;
var blockState = {};
var formFirstFocus = null;
var fieldsTouched = [];
var fieldsRejected = [];
var submitAttempts = 0;
var leadType = null;
var goals = [];
var clicks = [];
var cookieOutcome = null;
var cookieBarShown = false;

function randomId() {
	try {
		var bytes = new Uint8Array(6);
		window.crypto.getRandomValues(bytes);
		return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
	} catch (e) {
		return Math.random().toString(16).slice(2, 14);
	}
}

function secondsSinceStart() {
	return Math.round((Date.now() - startedAt) / 1000);
}

function addOnce(list, value) {
	if (list.indexOf(value) === -1 && list.length < 30) list.push(value);
}

function deviceClass() {
	var width = window.innerWidth || document.documentElement.clientWidth || 0;
	if (width < 741) return 'm';
	if (width < 1100) return 't';
	return 'd';
}

function landingUtm() {
	var found = {};
	try {
		var params = new URLSearchParams(window.location.search);
		UTM_PARAMS.forEach(function (pair) {
			var value = params.get(pair[0]);
			if (value) found[pair[1]] = value.slice(0, 120);
		});
		if (Object.keys(found).length) return found;
		// Labels form.js keeps from the landing page for this tab (read only).
		var stored = JSON.parse(window.sessionStorage.getItem('amUtm'));
		if (stored && typeof stored === 'object') {
			UTM_PARAMS.forEach(function (pair) {
				if (typeof stored[pair[0]] === 'string' && stored[pair[0]]) found[pair[1]] = stored[pair[0]].slice(0, 120);
			});
		}
	} catch (e) {
		// No labels.
	}
	return found;
}

var utm = landingUtm();
var fromAdClick = /[?&]yclid=/.test(window.location.search);

function priorCookieChoice() {
	try {
		var stored = JSON.parse(window.localStorage.getItem('amConsent'));
		if (stored && typeof stored.analytics === 'boolean') return stored.analytics ? 'y' : 'n';
	} catch (e) {
		// Unreadable — treat as no choice.
	}
	return null;
}

var priorChoice = priorCookieChoice();

function measure() {
	if (document.visibilityState === 'hidden') return;
	if (Date.now() - startedAt > MAX_TRACK_MS) return;
	visibleMs += TICK_MS;

	var viewport = window.innerHeight || document.documentElement.clientHeight;
	var docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
	if (docHeight > 0) {
		var depth = Math.min(100, Math.round(((window.scrollY + viewport) / docHeight) * 100));
		if (depth > maxScroll) maxScroll = depth;
	}

	BLOCKS.forEach(function (pair) {
		var el = document.querySelector(pair[1]);
		if (!el) return;
		var rect = el.getBoundingClientRect();
		var visible = Math.min(rect.bottom, viewport) - Math.max(rect.top, 0);
		if (visible <= 0) return;
		var onScreen = visible >= viewport / 3 || (rect.height > 0 && visible / rect.height >= 0.6);
		if (!onScreen) return;
		var state = blockState[pair[0]];
		if (!state) {
			state = blockState[pair[0]] = { first: secondsSinceStart(), ms: 0 };
		}
		state.ms += TICK_MS;
	});
}

function blocksParam() {
	return BLOCKS
		.filter(function (pair) { return blockState[pair[0]]; })
		.map(function (pair) {
			var state = blockState[pair[0]];
			return pair[0] + '.' + state.first + '.' + Math.round(state.ms / 1000);
		})
		.join(',');
}

function sendFailed() {
	var errorEl = document.getElementById('pfError');
	return !!(errorEl && !errorEl.hidden && errorEl.querySelector('a[href^="tel:"]'));
}

function currentCookieOutcome() {
	if (cookieOutcome) return cookieOutcome;
	if (cookieBarShown) return 's';
	if (priorChoice) return 'p' + priorChoice;
	return 'h';
}

function send(kind) {
	if (seq >= MAX_BEACONS) return;
	seq += 1;
	var q = new URLSearchParams();
	q.set('v', SCHEMA);
	q.set('id', viewId);
	q.set('n', String(seq));
	q.set('e', kind);
	q.set('p', window.location.pathname.slice(0, 80));
	q.set('d', deviceClass());
	Object.keys(utm).forEach(function (key) { q.set(key, utm[key]); });
	if (fromAdClick) q.set('y', '1');
	if (navigator.webdriver) q.set('wd', '1');
	q.set('t', String(Math.round(visibleMs / 1000)));
	q.set('sc', String(maxScroll));
	var blocks = blocksParam();
	if (blocks) q.set('b', blocks);
	if (formFirstFocus !== null) q.set('ff', String(formFirstFocus));
	if (fieldsTouched.length) q.set('fl', fieldsTouched.join(','));
	if (submitAttempts) q.set('fa', String(submitAttempts));
	if (fieldsRejected.length) q.set('fe', fieldsRejected.join(','));
	if (sendFailed()) q.set('fx', '1');
	if (leadType) q.set('l', leadType);
	if (goals.length) q.set('g', goals.join(','));
	if (clicks.length) q.set('k', clicks.join(','));
	q.set('cb', currentCookieOutcome());

	var url = ENDPOINT + '?' + q.toString();
	try {
		fetch(url, { method: 'GET', keepalive: true, credentials: 'omit', cache: 'no-store' }).catch(function () {});
	} catch (e) {
		try {
			new Image().src = url;
		} catch (ignored) {
			// Nothing else to try.
		}
	}
}

// Goals (quiz steps, form_submit, phone_click, lead) arrive through amGoal in
// metrika.js, which calls this hook whether or not Metrika is loaded.
window.amStatGoal = function (name) {
	if (typeof name === 'string') addOnce(goals, name.slice(0, 40));
};

document.addEventListener('am:lead', function (event) {
	var type = event && event.detail && event.detail.type;
	leadType = typeof type === 'string' ? type.slice(0, 20) : 'lead';
	// Next tick: form.js and quiz.js report their own goal right after am:lead.
	setTimeout(function () { send('l'); }, 0);
});

document.addEventListener('click', function (event) {
	var link = event.target && event.target.closest ? event.target.closest('a') : null;
	if (!link) return;
	var href = link.getAttribute('href') || '';
	if (href.indexOf('tel:') === 0) addOnce(clicks, 'tel');
	else if (href.indexOf('mailto:') === 0) addOnce(clicks, 'mail');
	else if (href === '#price' || href === '/#price') addOnce(clicks, 'cta');
}, true);

(function trackForm() {
	var form = document.getElementById('pfForm');
	if (!form) return;
	form.addEventListener('focusin', function (event) {
		var target = event.target;
		var key = target && (FIELD_KEYS[target.name] || FIELD_KEYS[target.id]);
		if (!key) return; // the honeypot and anything unnamed stay out
		if (formFirstFocus === null) formFirstFocus = secondsSinceStart();
		addOnce(fieldsTouched, key);
	});
	// Capture phase: runs before form.js validates. The verdict is read on the
	// next tick from the aria-invalid marks form.js leaves on rejected fields
	// (the consent box gets one too when the form stops at the consent gate).
	form.addEventListener('submit', function () {
		submitAttempts += 1;
		setTimeout(function () {
			form.querySelectorAll('[aria-invalid="true"]').forEach(function (el) {
				var key = FIELD_KEYS[el.name] || FIELD_KEYS[el.id];
				if (key) addOnce(fieldsRejected, key);
			});
		}, 0);
	}, true);
})();

(function trackCookieBar() {
	var bar = document.getElementById('cookieBar');
	if (!bar) return;
	function check() {
		if (!bar.hidden) cookieBarShown = true;
	}
	check();
	if (typeof MutationObserver === 'function') {
		new MutationObserver(check).observe(bar, { attributes: true, attributeFilter: ['hidden'] });
	}
	var accept = document.getElementById('cookieAccept');
	var decline = document.getElementById('cookieDecline');
	if (accept) accept.addEventListener('click', function () { cookieOutcome = 'a'; });
	if (decline) decline.addEventListener('click', function () { cookieOutcome = 'd'; });
})();

measure();
send('s');
setInterval(measure, TICK_MS);

document.addEventListener('visibilitychange', function () {
	if (document.visibilityState === 'hidden') send('h');
});
window.addEventListener('pagehide', function () {
	send('h');
});
