// Fullscreen lightbox for the showcase model photos (vanilla JS, no libraries).
// Opens on click/Enter on a [data-lightbox-open] button, closes on click
// anywhere in the overlay, Esc, or the visible close control. Body scroll is
// locked while open; focus moves to the close control on open and returns to
// the triggering card on close.

(function () {
	var overlay = document.getElementById('lightbox');
	var img = document.getElementById('lightboxImg');
	var closeBtn = document.getElementById('lightboxClose');
	if (!overlay || !img || !closeBtn) return;

	var photos = window.__amModelPhotos || [];
	var lastTrigger = null;
	var TRANSITION_MS = 450; // matches --t (.45s)

	function reducedMotion() {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	function open(trigger, index) {
		var photo = photos[index];
		if (!photo) return;
		img.src = photo.src;
		img.alt = photo.alt;
		lastTrigger = trigger;
		overlay.hidden = false;
		document.body.style.overflow = 'hidden';
		// Force a layout flush so the browser commits the un-hidden state
		// before the opacity transition starts — rAF-based deferral was
		// unreliable in the first moment after page load (observed via test).
		void overlay.offsetHeight;
		overlay.classList.add('on');
		closeBtn.focus();
	}

	function close() {
		if (overlay.hidden) return;
		overlay.classList.remove('on');
		document.body.style.overflow = '';
		var delay = reducedMotion() ? 0 : TRANSITION_MS;
		window.setTimeout(function () {
			overlay.hidden = true;
			img.src = '';
		}, delay);
		if (lastTrigger) { lastTrigger.focus(); }
	}

	document.querySelectorAll('[data-lightbox-open]').forEach(function (btn) {
		btn.addEventListener('click', function () {
			open(btn, Number(btn.dataset.index));
		});
	});

	overlay.addEventListener('click', close);

	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && !overlay.hidden) { close(); }
	});
})();
