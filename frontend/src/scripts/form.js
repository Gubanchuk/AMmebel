// PriceForm behavior (page block 11). window.amGoal is defined by quiz.js,
// which mounts earlier in the page (Hero); the guard below only covers the
// case where this script runs in isolation (e.g. a future page without Hero).
// Same idiom as quiz.js — never overwrites an existing window.amGoal.

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

	// Consent checkbox gates the CTA — attribute in markup covers the initial
	// state, this listener enforces it live (both required per brief step 2).
	function syncSubmitState() {
		submit.disabled = !consent.checked;
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
			return;
		}
		if (digitsCount(fields.phone) < 10) {
			setError('Проверьте номер телефона — нужно не меньше 10 цифр.');
			return;
		}
		if (!consent.checked) {
			setError('Отметьте согласие на обработку персональных данных.');
			return;
		}

		setError(null);

		document.dispatchEvent(
			new CustomEvent('am:lead', {
				detail: {
					type: 'price',
					fields: fields,
					consent: { version: '2026-08-25' },
				},
			})
		);
		window.amGoal('form_submit');

		form.hidden = true;
		doneEl.hidden = false;
	});
})();
