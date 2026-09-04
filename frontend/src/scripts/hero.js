// Hero photo carousel (vanilla JS). Slides are stacked and crossfade via the
// .on class; the caption, counter and progress bars follow the active index.
// Controls: prev/next buttons, horizontal swipe on the frame, left/right keys
// while focus is inside the carousel. Autoplay runs only while the user has
// not touched the controls, the tab is visible, the pointer is not over the
// frame, and prefers-reduced-motion is off. The first manual move stops it
// for good.

(function () {
	var root = document.getElementById('heroCar');
	if (!root) return;
	var frame = document.getElementById('heroFrame');
	var slides = Array.prototype.slice.call(root.querySelectorAll('.hc__slide'));
	var bars = Array.prototype.slice.call(root.querySelectorAll('.hc__prg i'));
	var num = document.getElementById('heroNum');
	var name = document.getElementById('heroName');
	var prev = document.getElementById('heroPrev');
	var next = document.getElementById('heroNext');
	if (slides.length < 2) {
		if (prev) prev.hidden = true;
		if (next) next.hidden = true;
		return;
	}

	var INTERVAL_MS = 5000;
	var SWIPE_PX = 40;
	var idx = 0;
	var timer = null;
	var userStopped = false;
	var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

	function pad(n) { return (n < 10 ? '0' : '') + n; }

	function go(n) {
		idx = (n + slides.length) % slides.length;
		slides.forEach(function (s, i) {
			var on = i === idx;
			s.classList.toggle('on', on);
			s.setAttribute('aria-hidden', on ? 'false' : 'true');
		});
		bars.forEach(function (b, i) { b.classList.toggle('on', i === idx); });
		if (num) num.textContent = pad(idx + 1) + ' / ' + pad(slides.length);
		if (name) {
			var img = slides[idx].querySelector('img');
			name.textContent = img ? img.alt : '';
		}
	}

	function stop() {
		if (timer !== null) { window.clearInterval(timer); timer = null; }
	}
	function start() {
		if (userStopped || reduced.matches || document.hidden || timer !== null) return;
		timer = window.setInterval(function () { go(idx + 1); }, INTERVAL_MS);
	}
	function manual(n) {
		userStopped = true;
		stop();
		go(n);
	}

	if (prev) prev.addEventListener('click', function () { manual(idx - 1); });
	if (next) next.addEventListener('click', function () { manual(idx + 1); });

	root.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowLeft') { e.preventDefault(); manual(idx - 1); }
		if (e.key === 'ArrowRight') { e.preventDefault(); manual(idx + 1); }
	});

	if (frame) {
		var down = null;
		frame.addEventListener('pointerdown', function (e) {
			down = { x: e.clientX, y: e.clientY };
		});
		frame.addEventListener('pointerup', function (e) {
			if (!down) return;
			var dx = e.clientX - down.x;
			var dy = e.clientY - down.y;
			down = null;
			if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return;
			manual(dx < 0 ? idx + 1 : idx - 1);
		});
		frame.addEventListener('pointercancel', function () { down = null; });
		frame.addEventListener('pointerenter', stop);
		frame.addEventListener('pointerleave', start);
	}
	root.addEventListener('focusin', stop);
	root.addEventListener('focusout', function (e) {
		if (!root.contains(e.relatedTarget)) start();
	});
	document.addEventListener('visibilitychange', function () {
		if (document.hidden) stop(); else start();
	});
	if (typeof reduced.addEventListener === 'function') {
		reduced.addEventListener('change', function () { stop(); start(); });
	}

	start();
})();
