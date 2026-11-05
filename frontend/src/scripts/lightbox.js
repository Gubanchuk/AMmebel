// Fullscreen lightbox for the showcase model photos and the production stage
// photos (vanilla JS, no libraries). Opens on click/Enter on any
// [data-lightbox-open] button and shows that button's own <img> (src/alt), so
// cloned carousel cards and other blocks need no shared index. Closes on click
// anywhere in the overlay, Esc, or the visible close control. Body scroll is
// locked while open; focus moves to the close control on open and returns to
// the triggering card on close.

(function () {
	var overlay = document.getElementById('lightbox');
	var img = document.getElementById('lightboxImg');
	var closeBtn = document.getElementById('lightboxClose');
	var requestBtn = document.getElementById('lightboxRequest');
	if (!overlay || !img || !closeBtn) return;

	var lastTrigger = null;
	var closeTimeoutId = null;
	var TRANSITION_MS = 450; // matches --t (.45s)

	function reducedMotion() {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	function open(trigger) {
		var pic = trigger.querySelector('img');
		if (!pic) return;
		// Cancel a pending close-cleanup from a previous session — without this,
		// close() -> reopen() within TRANSITION_MS lets the stale timeout fire
		// mid-new-session and blank img.src / re-hide the overlay it just opened.
		if (closeTimeoutId !== null) {
			window.clearTimeout(closeTimeoutId);
			closeTimeoutId = null;
		}
		img.src = pic.currentSrc || pic.src;
		img.alt = pic.alt;
		var model = trigger.dataset.modelTitle;
		if (requestBtn) {
			requestBtn.hidden = !model;
			requestBtn.dataset.modelRequest = model || '';
			if (model) overlay.classList.add('has-request');
			else overlay.classList.remove('has-request');
		}
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

	function close(restoreTrigger) {
		if (overlay.hidden) return;
		overlay.classList.remove('on');
		document.body.style.overflow = '';
		var delay = reducedMotion() ? 0 : TRANSITION_MS;
		closeTimeoutId = window.setTimeout(function () {
			overlay.hidden = true;
			img.src = '';
			closeTimeoutId = null;
		}, delay);
		if (restoreTrigger !== false && lastTrigger) { lastTrigger.focus(); }
	}

	document.querySelectorAll('[data-lightbox-open]').forEach(function (btn) {
		btn.addEventListener('click', function () {
			open(btn);
		});
	});

	// The model action bubbles on to form.js, which selects the model and
	// focuses the phone. Every other overlay click keeps the original close
	// behavior and returns focus to the photo that opened the dialog.
	overlay.addEventListener('click', function (event) {
		var requesting = requestBtn && (event.target === requestBtn || requestBtn.contains(event.target));
		close(!requesting);
	});

	document.addEventListener('keydown', function (e) {
		if (overlay.hidden || !overlay.classList.contains('on')) return;
		if (e.key === 'Escape') { close(); return; }
		if (e.key === 'Tab') {
			e.preventDefault();
			var controls = requestBtn && !requestBtn.hidden ? [closeBtn, requestBtn] : [closeBtn];
			var current = controls.indexOf(document.activeElement);
			var next = current < 0 ? (e.shiftKey ? controls.length - 1 : 0)
				: (current + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
			controls[next].focus();
		}
	});
})();
