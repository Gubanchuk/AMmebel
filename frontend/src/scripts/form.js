// PriceForm behavior (page block 11) and the lead sending it shares with the
// quiz (quiz.js imports postLead/showSendFailure/restoreFocus from here).
// window.amGoal: this file and quiz.js install the same console.debug
// placeholder when none exists; neither overwrites an existing one.
//
// Sending: a valid form is POSTed to /api/lead (lead-service). Only a 201 shows
// the thank-you state and fires am:lead and the goal; any other answer, a
// network error or a timeout keeps the entered data and offers the manager's
// phone instead.

if (typeof window.amGoal !== 'function') {
	window.amGoal = function (name) {
		console.debug('[goal]', name);
	};
}

// Follow-up field per "need" select value — labels are the client's own wording
// (task brief map): салон -> сколько точек, онлайн -> какие площадки,
// объект -> объём и срок, агент -> проектов в год.
var NEED_EXTRA = {
	salon: { label: 'Сколько точек', placeholder: 'Например, 2' },
	online: { label: 'Какие площадки', placeholder: 'Например, Wildberries, свой магазин' },
	project: { label: 'Объём и срок', placeholder: 'Например, 40 номеров, к сентябрю' },
	agent: { label: 'Проектов в год', placeholder: 'Например, 5–10' },
};

var LEAD_URL = '/api/lead';
var LEAD_TIMEOUT_MS = 15000;
var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function readUtm() {
	var utm = {};
	var found = false;
	try {
		var params = new URLSearchParams(window.location.search);
		UTM_KEYS.forEach(function (key) {
			var value = params.get(key);
			if (value) {
				utm[key] = value.slice(0, 255);
				found = true;
			}
		});
	} catch (e) {
		return null;
	}
	return found ? utm : null;
}

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

	var needSelect = document.getElementById('pf-need');
	var extraWrap = document.getElementById('pfNeedExtraWrap');
	var extraLabel = document.getElementById('pfNeedExtraLabel');
	var extraInput = document.getElementById('pf-need-extra');
	var consent = document.getElementById('pfConsent');
	var submit = document.getElementById('pfSubmit');
	var errorEl = document.getElementById('pfError');
	var doneEl = document.getElementById('pfDone');
	var submitLabel = submit.textContent;
	var sending = false;

	function updateExtraField() {
		var meta = NEED_EXTRA[needSelect.value];
		if (!meta) {
			extraWrap.hidden = true;
			return;
		}
		extraLabel.textContent = meta.label;
		extraInput.placeholder = meta.placeholder;
		extraWrap.hidden = false;
	}

	function setError(message) {
		if (!message) {
			errorEl.hidden = true;
			errorEl.textContent = '';
			return;
		}
		errorEl.hidden = false;
		errorEl.textContent = message;
	}

	// Screen readers get the error text via role=alert; sighted keyboard users
	// and AT users on the field itself get aria-invalid/aria-describedby too.
	var validated = ['company_inn', 'name', 'phone', 'city', 'need'];
	function markInvalid(list) {
		validated.map(function (k) { return form.elements[k]; }).concat([consent]).forEach(function (el) {
			if (!el) return;
			el.removeAttribute('aria-invalid');
			el.removeAttribute('aria-describedby');
		});
		list.forEach(function (el) {
			if (!el) return;
			el.setAttribute('aria-invalid', 'true');
			el.setAttribute('aria-describedby', 'pfError');
		});
	}

	// Consent checkbox gates the CTA — attribute in markup covers the initial
	// state, this listener enforces it live (both required per brief step 2).
	// While a lead is being sent the CTA stays disabled regardless.
	function syncSubmitState() {
		submit.disabled = sending || !consent.checked;
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

	needSelect.addEventListener('change', updateExtraField);
	consent.addEventListener('change', syncSubmitState);
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
			company_inn: form.elements.company_inn.value.trim(),
			name: form.elements.name.value.trim(),
			phone: form.elements.phone.value.trim(),
			city: form.elements.city.value.trim(),
			need: form.elements.need.value,
			need_extra: extraInput.value.trim(),
		};

		if (!fields.company_inn || !fields.name || !fields.phone || !fields.city || !fields.need) {
			setError('Заполните все обязательные поля.');
			markInvalid(validated.filter(function (k) { return !fields[k]; }).map(function (k) { return form.elements[k]; }));
			return;
		}
		// «Компания / ИНН» takes a name or an INN; digits only means an INN,
		// which has 10 (company) or 12 (sole trader) digits. Same rule on the server.
		var companyDigits = fields.company_inn.replace(/\s/g, '');
		if (/^\d+$/.test(companyDigits) && companyDigits.length !== 10 && companyDigits.length !== 12) {
			setError('Проверьте ИНН — в нём 10 или 12 цифр.');
			markInvalid([form.elements.company_inn]);
			return;
		}
		if (digitsCount(fields.phone) < 10) {
			setError('Проверьте номер телефона — нужно не меньше 10 цифр.');
			markInvalid([form.elements.phone]);
			return;
		}
		if (!consent.checked) {
			setError('Отметьте согласие на обработку персональных данных.');
			markInvalid([consent]);
			return;
		}

		setError(null);
		markInvalid([]);

		var detail = {
			type: 'price',
			fields: fields,
			consent: { version: '2026-08-25' },
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
