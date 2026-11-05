// Banner card above the price form (block 11). The site's own ads (Yandex
// Direct and others) link to the home page with utm_content=<slug> from
// ../lib/ad-banners.json. A visitor from such an ad sees the product of that
// banner with its price next to the form: Direct requires the price in the ad
// to be on the landing page, and the visitor sees what the call will be about.
// Without a known slug the card stays hidden and the page is unchanged.
//
// The slug comes from readUtm() in form.js, the same labels the lead carries,
// so the card and the lead name the same banner after a reload or a detour to
// another page of the site. lead-service has a copy of the catalog
// (lead-service/src/ad-banners.json) and names the banner in the lead and the
// MAX message; its tests check that the copies match.

import BANNERS from '../lib/ad-banners.json';
import { readUtm } from './form.js';

var NOTES = {
	sofa: 'Сделаем в вашем размере и ткани, доставим по России. Оставьте телефон — перезвоним и уточним цену.',
	bed: 'Оставьте телефон — перезвоним и уточним цену.',
};

// 128000 -> "от 128 000 ₽" with non-breaking spaces
function formatPrice(price) {
	return 'от ' + String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
}

(function () {
	var card = document.getElementById('adCard');
	if (!card) return;
	var form = document.getElementById('pfForm');
	if (form && form.dataset.requestMode === 'model') return;
	var utm = readUtm();
	var slug = utm && utm.utm_content;
	if (!slug || !Object.prototype.hasOwnProperty.call(BANNERS, slug)) return;
	var banner = BANNERS[slug];
	var note = NOTES[banner.kind];
	if (!note) return;

	var name = banner.product.charAt(0).toUpperCase() + banner.product.slice(1);
	var img = document.createElement('img');
	img.src = '/ads/foto/' + slug + '.webp';
	img.alt = name;
	img.width = 800;
	img.height = 600;
	img.decoding = 'async';
	card.querySelector('.adcard__photo').appendChild(img);

	card.querySelector('.adcard__name').textContent = name;
	card.querySelector('.adcard__price').textContent =
		formatPrice(banner.price) + (banner.priceNote ? ' ' + banner.priceNote : '');
	card.querySelector('.adcard__note').textContent = note;
	card.hidden = false;
	document.dispatchEvent(new CustomEvent('am:retail-offer', { detail: { product: name } }));
	// The same action keeps the same promise at the entry points to this form.
	document.querySelectorAll('.hdr__price-full, .hdr-menu__price, .demo__nav .cta').forEach(function (link) {
		link.textContent = 'Уточнить цену';
	});
	document.querySelectorAll('.hdr__price-short').forEach(function (link) {
		link.textContent = 'Цена';
	});
})();
