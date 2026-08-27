// Assembly quiz (hero block 01) — ported from am-site-preview.html's .demo script.
// Adaptations vs. the preview: capture each step's answer into `answers`, replace
// step-counter increments with setStep() so every transition reports window.amGoal,
// and dispatch am:lead with the collected fields instead of showing a static stub.
// The stage went through two replacements after the plan's original SVG
// assembly scene: a brightness-ramp photo scene, then the current texture
// zoom-out ("от ткани к дивану", user's pick 27.08) — the step machine itself
// is unchanged throughout, only the CSS driven by data-lit="1".."4" on
// #qzScene (and this file's caption/lexicon strings) changed.

if (typeof window.amGoal !== 'function') {
	window.amGoal = function (name) {
		console.debug('[goal]', name);
	};
}

(function () {
	var s = 1, total = 4;
	var caps = ['фактура', 'фактура', 'форма', 'форма'];
	var answers = { business: '', scale: '', city: '', name: '', phone: '' };
	var steps = document.querySelectorAll('.step');
	var bars = document.querySelectorAll('.prg i');
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

	// Consent only gates the finish action (last step) — earlier steps advance
	// via the same shared button without needing it checked.
	function syncNextState() {
		next.disabled = (s === total) && !(consentInput && consentInput.checked);
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

	function setStep(n) {
		s = n;
		paint();
		window.amGoal('quiz_step_' + s);
	}

	function digitsCount(value) {
		var match = value.match(/\d/g);
		return match ? match.length : 0;
	}

	function finish() {
		var name = nameInput ? nameInput.value.trim() : '';
		var phone = phoneInput ? phoneInput.value.trim() : '';

		if (!name) {
			setError('Укажите имя.');
			return;
		}
		if (digitsCount(phone) < 10) {
			setError('Проверьте номер телефона — нужно не меньше 10 цифр.');
			return;
		}
		if (!consentInput || !consentInput.checked) {
			setError('Отметьте согласие на обработку персональных данных.');
			return;
		}
		setError(null);

		answers.city = cityInput ? cityInput.value.trim() : '';
		answers.name = name;
		answers.phone = phone;
		body.style.display = 'none';
		res.classList.add('on');
		cap.textContent = 'Финал · свет';
		bars.forEach(function (b) { b.classList.add('on'); });
		window.amGoal('quiz_submit');
		document.dispatchEvent(new CustomEvent('am:lead', {
			detail: {
				type: 'quiz',
				fields: answers,
				consent: { version: '2026-08-25' },
			},
		}));
	}

	document.querySelectorAll('.opt').forEach(function (o) {
		o.addEventListener('click', function () {
			o.parentNode.querySelectorAll('.opt').forEach(function (x) { x.classList.remove('sel'); });
			o.classList.add('sel');
			var stepEl = o.closest('.step');
			var stepNum = stepEl ? Number(stepEl.dataset.s) : s;
			if (stepNum === 1) { answers.business = o.textContent.trim(); }
			else if (stepNum === 2) { answers.scale = o.textContent.trim(); }
			if (s < total) { setStep(s + 1); }
		});
	});

	next.addEventListener('click', function () {
		if (s < total) { setStep(s + 1); }
		else { finish(); }
	});
	back.addEventListener('click', function () { if (s > 1) { setStep(s - 1); } });
	if (consentInput) { consentInput.addEventListener('change', syncNextState); }

	setStep(1);
})();
