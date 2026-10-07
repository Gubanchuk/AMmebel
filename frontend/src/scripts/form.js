// PriceForm behavior (page block 11) and the lead sending it shares with the
// quiz (quiz.js imports postLead/showSendFailure/restoreFocus from here).
// window.amGoal comes from metrika.js; this file and quiz.js install the same
// console.debug placeholder only when it is missing.
//
// Sending: a valid form is POSTed to /api/lead (lead-service). Only a 201 shows
// the thank-you state and fires am:lead and the goal; any other answer, a
// network error or a timeout keeps the entered data and offers the manager's
// phone instead.

import { CONSENT_VERSION } from './consent-version.js';

if (typeof window.amGoal !== 'function') {
	window.amGoal = function (name) {
		console.debug('[goal]', name);
	};
}

var LEAD_URL = '/api/lead';
var LEAD_TIMEOUT_MS = 15000;
var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
var UTM_STORE_KEY = 'amUtm';

// Keeps only known UTM keys with non-empty string values.
function pickUtm(get) {
	var utm = {};
	var found = false;
	UTM_KEYS.forEach(function (key) {
		var value = get(key);
		if (typeof value === 'string' && value) {
			utm[key] = value.slice(0, 255);
			found = true;
		}
	});
	return found ? utm : null;
}

function utmFromUrl() {
	try {
		var params = new URLSearchParams(window.location.search);
		return pickUtm(function (key) { return params.get(key); });
	} catch (e) {
		return null;
	}
}

// An ad click lands on the home page with UTM in the address. A visitor who
// then opens /politika or /soglasie and comes back has none in the address,
// so the landing labels are kept in sessionStorage (this tab only) and sent
// with the lead. Labels in the current address win; a new ad click replaces
// the stored ones.
function rememberUtm() {
	var utm = utmFromUrl();
	if (!utm) return;
	try {
		window.sessionStorage.setItem(UTM_STORE_KEY, JSON.stringify(utm));
	} catch (e) {
		// Storage unavailable — the lead goes without labels after a detour.
	}
}

function readUtm() {
	var utm = utmFromUrl();
	if (utm) return utm;
	try {
		var stored = JSON.parse(window.sessionStorage.getItem(UTM_STORE_KEY));
		if (!stored || typeof stored !== 'object') return null;
		return pickUtm(function (key) { return stored[key]; });
	} catch (e) {
		return null;
	}
}

rememberUtm();

// detail is the am:lead detail {type, fields, consent}. Resolves true only when
// the service stored the lead (201); never rejects.
export function postLead(detail) {
	var payload = {
		type: detail.type,
		fields: detail.fields,
		consent: detail.consent,
		source_page: window.location.pathname,
	};
	var utm = readUtm();
	if (utm) payload.utm = utm;

	var controller = typeof AbortController === 'function' ? new AbortController() : null;
	var timer = controller ? setTimeout(function () { controller.abort(); }, LEAD_TIMEOUT_MS) : null;
	try {
		return fetch(LEAD_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller ? controller.signal : undefined,
		})
			.then(function (response) { return response.status === 201; }, function () { return false; })
			.then(function (stored) {
				if (timer) clearTimeout(timer);
				return stored;
			});
	} catch (e) {
		if (timer) clearTimeout(timer);
		return Promise.resolve(false);
	}
}

// Consent gate for a lead button. The button stays visibly inactive
// (aria-disabled, so a press still reaches our handler) until the consent box
// is ticked, and the hint next to it says what to do. A press on the inactive
// button lights the hint up and draws the box in with its dashed outline.
// setApplies(false) lifts the gate (quiz steps before the contact step).
export function consentGate(box, button, hint) {
	var applies = true;
	function update() {
		var blocked = applies && !box.checked;
		if (blocked) { button.setAttribute('aria-disabled', 'true'); }
		else { button.removeAttribute('aria-disabled'); }
		hint.hidden = !blocked;
		if (!blocked) {
			hint.classList.remove('is-nudged');
			box.removeAttribute('aria-invalid');
		}
	}
	box.addEventListener('change', update);
	update();
	return {
		setApplies: function (on) { applies = on; update(); },
		blocked: function () { return applies && !box.checked; },
		nudge: function () {
			hint.classList.add('is-nudged');
			box.removeAttribute('aria-invalid');
			void box.offsetWidth; // restart the outline animation on every press
			box.setAttribute('aria-invalid', 'true');
			box.focus({ preventScroll: true });
			var r = box.getBoundingClientRect();
			if (r.top < 80 || r.bottom > window.innerHeight - 20) {
				box.scrollIntoView({ block: 'center', behavior: 'smooth' });
			}
		},
	};
}

// Failure notice inside a role="alert" element. The phone is taken from the
// page's own tel: link (header and footer render it from the CMS settings), so
// the number lives in one place.
export function showSendFailure(el) {
	el.textContent = 'Не отправилось — позвоните, ответим сразу';
	var tel = document.querySelector('a[href^="tel:"]');
	if (tel) {
		var href = tel.getAttribute('href');
		var link = document.createElement('a');
		link.href = href;
		link.textContent = (tel.textContent || '').trim() || href.slice(4);
		link.style.whiteSpace = 'nowrap';
		el.appendChild(document.createTextNode(': '));
		el.appendChild(link);
	}
	el.hidden = false;
}

// A button disabled while focused can drop focus to <body>; put keyboard users
// back on the button once it is usable again.
export function restoreFocus(button) {
	var active = document.activeElement;
	if (!active || active === document.body) {
		button.focus({ preventScroll: true });
	}
}

(function () {
	var form = document.getElementById('pfForm');
	if (!form) return;

	var phoneInput = form.elements.phone;
	var nameInput = form.elements.name;
	var consent = document.getElementById('pfConsent');
	var submit = document.getElementById('pfSubmit');
	var errorEl = document.getElementById('pfError');
	var doneEl = document.getElementById('pfDone');
	var submitLabel = submit.textContent;
	var sending = false;

	function setError(message) {
		if (!message) {
			errorEl.hidden = true;
			errorEl.textContent = '';
			return;
		}
		errorEl.hidden = false;
		errorEl.textContent = message;
	}

	// Screen readers get the error text via role=alert; the phone field also
	// gets aria-invalid/aria-describedby. The phone is the only required field.
	function markPhone(invalid) {
		if (invalid) {
			phoneInput.setAttribute('aria-invalid', 'true');
			phoneInput.setAttribute('aria-describedby', 'pfError');
		} else {
			phoneInput.removeAttribute('aria-invalid');
			phoneInput.removeAttribute('aria-describedby');
		}
	}

	// The phone message comes first, before the consent hint, and asks for the
	// number with the reason to give it — the client's wording of 08.10.2026.
	function askForPhone(message) {
		setError(message);
		markPhone(true);
		phoneInput.focus({ preventScroll: true });
		var r = phoneInput.getBoundingClientRect();
		if (r.top < 80 || r.bottom > window.innerHeight - 20) {
			phoneInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
	}

	phoneInput.addEventListener('input', function () {
		if (phoneInput.getAttribute('aria-invalid') === 'true') {
			markPhone(false);
			setError(null);
		}
	});

	// disabled only while a lead is being sent; the consent gate is separate
	var gate = consentGate(consent, submit, document.getElementById('pfConsentHint'));
	function syncSubmitState() {
		submit.disabled = sending;
	}

	function setSending(on) {
		sending = on;
		if (on) {
			submit.setAttribute('aria-busy', 'true');
			submit.textContent = 'Отправляем…';
		} else {
			submit.removeAttribute('aria-busy');
			submit.textContent = submitLabel;
		}
		syncSubmitState();
	}

	function digitsCount(value) {
		var match = value.match(/\d/g);
		return match ? match.length : 0;
	}

	syncSubmitState();

	form.addEventListener('submit', function (event) {
		event.preventDefault();
		if (sending) return;

		var honeypot = form.elements.website;
		if (honeypot && honeypot.value.trim() !== '') {
			// Bot filled the hidden field — fail silently, no error, no dispatch.
			return;
		}

		var fields = {
			name: nameInput.value.trim(),
			phone: phoneInput.value.trim(),
		};

		if (!fields.phone) {
			askForPhone('Напишите номер телефона — пришлём на него оптовый прайс.');
			return;
		}
		if (digitsCount(fields.phone) < 10) {
			askForPhone('В номере не хватает цифр — проверьте, пожалуйста.');
			return;
		}
		setError(null);
		markPhone(false);
		// Enter in a field submits too: without consent, point at the box
		if (gate.blocked()) {
			gate.nudge();
			return;
		}

		var detail = {
			type: 'price',
			fields: fields,
			consent: { version: CONSENT_VERSION },
		};

		setSending(true);
		postLead(detail).then(function (stored) {
			setSending(false);
			if (!stored) {
				showSendFailure(errorEl);
				restoreFocus(submit);
				return;
			}
			document.dispatchEvent(new CustomEvent('am:lead', { detail: detail }));
			window.amGoal('form_submit');

			form.hidden = true;
			doneEl.hidden = false;
			doneEl.focus({ preventScroll: true }); // announce the result and land focus somewhere sensible
		});
	});
})();
