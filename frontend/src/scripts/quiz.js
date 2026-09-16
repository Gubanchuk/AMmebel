// Assembly quiz (hero block 01) — ported from am-site-preview.html's .demo script.
// Adaptations vs. the preview: capture each step's answer into `answers`, replace
// step-counter increments with setStep() so every transition reports window.amGoal,
// and send the collected fields to /api/lead instead of showing a static stub
// (sending helpers live in form.js; the final state appears only after a 201).
// The stage went through three replacements after the plan's original SVG
// assembly scene: a brightness-ramp photo scene, a texture zoom-out ("от
// ткани к дивану", 27.08), and since 08.09 four workshop photos crossfading
// frame → filling → upholstery → finished sofa (the client's idea) — the step
// machine itself is unchanged throughout, only the CSS driven by
// data-lit="1".."4" on #qzScene (and this file's caption strings) changed.

import { CONSENT_VERSION } from './consent-version.js';
import { postLead, restoreFocus, showSendFailure } from './form.js';

if (typeof window.amGoal !== 'function') {
	window.amGoal = function (name) {
		console.debug('[goal]', name);
	};
}

(function () {
	var s = 1, total = 4;
	var caps = ['каркас', 'наполнение', 'обивка', 'готовый диван'];
	var answers = { business: '', scale: '', city: '', name: '', phone: '' };
	var steps = document.querySelectorAll('.step');
	// Scoped to the quiz: the hero carousel uses the same .prg bars, and a
	// page-wide query painted its five bars with the quiz step (bug 09.09).
	var bars = document.querySelectorAll('#qz .prg i');
	var scene = document.getElementById('qzScene');
	var back = document.getElementById('qback');
	var next = document.getElementById('qnext');
	var cap = document.getElementById('qcap');
	var body = document.getElementById('qbody');
	var res = document.getElementById('qres');
	var cityInput = document.getElementById('q3');
	var nameInput = document.getElementById('q4a');
	var phoneInput = document.getElementById('q4b');
	var consentInput = document.getElementById('qzConsent');
	var errorEl = document.getElementById('qzError');
	var sending = false;

	function setError(message) {
		if (!errorEl) return;
		if (!message) {
			errorEl.hidden = true;
			errorEl.textContent = '';
			return;
		}
		errorEl.hidden = false;
		errorEl.textContent = message;
	}

	// The button is disabled only while the lead is being sent. On the last
	// step a press without consent shows the consent message from finish()
	// instead of a disabled button that still looks active.
	function syncNextState() {
		next.disabled = sending;
	}

	function paint() {
		steps.forEach(function (el) { el.hidden = Number(el.dataset.s) !== s; });
		bars.forEach(function (b, i) { b.classList.toggle('on', i < s); });
		if (scene) { scene.setAttribute('data-lit', String(s)); }
		cap.textContent = 'Шаг ' + s + ' из ' + total + ' · ' + caps[s - 1];
		back.disabled = (s === 1);
		next.textContent = (s === total) ? 'Получить прайс' : 'Дальше';
		setError(null);
		syncNextState();
	}

	// moveFocus: after a user-driven step change, put focus on the new question
	// so screen readers announce it (never on the initial paint at load).
	function setStep(n, moveFocus) {
		s = n;
		paint();
		if (moveFocus) {
			var q = steps[s - 1] && steps[s - 1].querySelector('.qz__q');
			if (q) { q.focus({ preventScroll: true }); }
		}
		window.amGoal('quiz_step_' + s);
	}

	function digitsCount(value) {
		var match = value.match(/\d/g);
		return match ? match.length : 0;
	}

	function markInvalid(el) {
		[nameInput, phoneInput, consentInput].forEach(function (x) {
			if (!x) return;
			x.removeAttribute('aria-invalid');
			x.removeAttribute('aria-describedby');
		});
		if (el) {
			el.setAttribute('aria-invalid', 'true');
			el.setAttribute('aria-describedby', 'qzError');
		}
	}

	function setSending(on) {
		sending = on;
		if (on) {
			next.setAttribute('aria-busy', 'true');
			next.textContent = 'Отправляем…';
			back.disabled = true;
		} else {
			next.removeAttribute('aria-busy');
			next.textContent = 'Получить прайс';
			back.disabled = (s === 1);
		}
		syncNextState();
	}

	function finish() {
		if (sending) return;
		var name = nameInput ? nameInput.value.trim() : '';
		var phone = phoneInput ? phoneInput.value.trim() : '';

		if (!name) {
			setError('Укажите имя.');
			markInvalid(nameInput);
			return;
		}
		if (digitsCount(phone) < 10) {
			setError('Проверьте номер телефона — нужно не меньше 10 цифр.');
			markInvalid(phoneInput);
			return;
		}
		if (!consentInput || !consentInput.checked) {
			setError('Отметьте согласие на обработку персональных данных.');
			markInvalid(consentInput);
			return;
		}
		setError(null);
		markInvalid(null);

		answers.city = cityInput ? cityInput.value.trim() : '';
		answers.name = name;
		answers.phone = phone;
		var detail = {
			type: 'quiz',
			fields: answers,
			consent: { version: CONSENT_VERSION },
		};

		setSending(true);
		postLead(detail).then(function (stored) {
			setSending(false);
			if (!stored) {
				// Entered answers stay in place; the visitor can call or retry.
				if (errorEl) { showSendFailure(errorEl); }
				restoreFocus(next);
				return;
			}
			body.style.display = 'none';
			res.classList.add('on');
			cap.textContent = 'Финал · диван собран';
			bars.forEach(function (b) { b.classList.add('on'); });
			window.amGoal('quiz_submit');
			document.dispatchEvent(new CustomEvent('am:lead', { detail: detail }));
		});
	}

	document.querySelectorAll('.opt').forEach(function (o) {
		o.addEventListener('click', function () {
			o.parentNode.querySelectorAll('.opt').forEach(function (x) { x.classList.remove('sel'); });
			o.classList.add('sel');
			var stepEl = o.closest('.step');
			var stepNum = stepEl ? Number(stepEl.dataset.s) : s;
			if (stepNum === 1) { answers.business = o.textContent.trim(); }
			else if (stepNum === 2) { answers.scale = o.textContent.trim(); }
			if (s < total) { setStep(s + 1, true); }
		});
	});

	next.addEventListener('click', function () {
		if (s < total) { setStep(s + 1, true); }
		else { finish(); }
	});
	back.addEventListener('click', function () { if (s > 1) { setStep(s - 1, true); } });
	if (consentInput) {
		consentInput.addEventListener('change', function () {
			if (consentInput.checked && consentInput.getAttribute('aria-invalid') === 'true') {
				setError(null);
				markInvalid(null);
			}
		});
	}

	setStep(1);
})();
