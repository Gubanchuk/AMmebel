// Assembly quiz (hero block 01) — ported from am-site-preview.html's .demo script.
// Adaptations vs. the preview: capture each step's answer into `answers`, replace
// step-counter increments with setStep() so every transition reports window.amGoal,
// and dispatch am:lead with the collected fields instead of showing a static stub.

if (typeof window.amGoal !== 'function') {
	window.amGoal = function (name) {
		console.debug('[goal]', name);
	};
}

(function () {
	var s = 1, total = 4;
	var caps = ['собираем каркас', 'кладём подушки', 'ставим спинку и подлокотники', 'включаем свет над обивкой'];
	var answers = { business: '', scale: '', city: '', name: '', phone: '' };
	var steps = document.querySelectorAll('.step');
	var bars = document.querySelectorAll('.prg i');
	var back = document.getElementById('qback');
	var next = document.getElementById('qnext');
	var cap = document.getElementById('qcap');
	var body = document.getElementById('qbody');
	var res = document.getElementById('qres');
	var cityInput = document.getElementById('q3');
	var nameInput = document.getElementById('q4a');
	var phoneInput = document.getElementById('q4b');

	function paint() {
		steps.forEach(function (el) { el.hidden = Number(el.dataset.s) !== s; });
		bars.forEach(function (b, i) { b.classList.toggle('on', i < s); });
		for (var i = 1; i <= 4; i++) { var g = document.getElementById('p' + i); if (g) g.setAttribute('opacity', i <= s ? '1' : '0'); }
		cap.textContent = 'Шаг ' + s + ' из ' + total + ' · ' + caps[s - 1];
		back.disabled = (s === 1);
		next.textContent = (s === total) ? 'Получить каталог' : 'Дальше';
	}

	function setStep(n) {
		s = n;
		paint();
		window.amGoal('quiz_step_' + s);
	}

	function finish() {
		answers.city = cityInput ? cityInput.value.trim() : '';
		answers.name = nameInput ? nameInput.value.trim() : '';
		answers.phone = phoneInput ? phoneInput.value.trim() : '';
		body.style.display = 'none';
		res.classList.add('on');
		cap.textContent = 'Диван собран · свет включён';
		bars.forEach(function (b) { b.classList.add('on'); });
		for (var i = 1; i <= 4; i++) { var g = document.getElementById('p' + i); if (g) g.setAttribute('opacity', '1'); }
		window.amGoal('quiz_submit');
		document.dispatchEvent(new CustomEvent('am:lead', { detail: { type: 'quiz', fields: answers } }));
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

	setStep(1);
})();
