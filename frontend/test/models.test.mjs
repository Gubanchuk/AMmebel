import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getModelGroups, modelPath } from '../src/lib/models.ts';

const fallback = JSON.parse(readFileSync(new URL('../../content-fallback.json', import.meta.url), 'utf8'));
const model = (title, sort, overrides = {}) => ({
	title, sort, size: '', priceFrom: null, priceTo: null,
	photo: `/models/${sort}.webp`, visible: true, ...overrides,
});

test('repeated Lounge and Mono photos share pages without dropping photographs', () => {
	const groups = getModelGroups(fallback.models);
	assert.equal(groups.length, 9);
	assert.deepEqual(groups.map((group) => group.slug), [
		'lounge', 'arte', 'luche', 'mono', 'di-marco', 'lago', 'gemma', 'mia', 'prima',
	]);
	assert.deepEqual(groups.find((group) => group.slug === 'lounge').models.map((item) => item.sort), [2, 7]);
	assert.deepEqual(groups.find((group) => group.slug === 'mono').models.map((item) => item.sort), [5, 9]);
	assert.equal(groups.flatMap((group) => group.models).length, fallback.models.length);
});

test('hidden records never create a page or appear in an existing group', () => {
	const groups = getModelGroups([
		model('Диван «Lounge»', 1),
		model('Диван «Lounge»', 2, { visible: false }),
		model('Кровать «Hidden»', 3, { visible: false }),
		model('', 4, { visible: false }),
	]);
	assert.deepEqual(groups.map((group) => [group.slug, group.models.length]), [['lounge', 1]]);
});

test('group and photograph order follow sort without mutating CMS records', () => {
	const input = [model('Диван «Mono»', 8), model('Диван «Lounge»', 2), model('Диван «Mono»', 4)];
	const before = structuredClone(input);
	const groups = getModelGroups(input);
	assert.deepEqual(groups.map((group) => group.slug), ['lounge', 'mono']);
	assert.deepEqual(groups[1].models.map((item) => item.sort), [4, 8]);
	assert.deepEqual(input, before);
});

test('cosmetic whitespace and quote differences do not duplicate a model page', () => {
	const groups = getModelGroups([
		model(' Диван  «Lounge» ', 1), model('Диван "Lounge"', 2),
	]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].title, 'Диван «Lounge»');
	assert.equal(groups[0].models.length, 2);
});

test('paths use the quoted Latin model name for both title strings and records', () => {
	assert.equal(modelPath('Прямой диван «Di Marco»'), '/modeli/di-marco/');
	assert.equal(modelPath(model('Модульный диван «Lounge»', 7)), '/modeli/lounge/');
	assert.equal(modelPath('Кровать “Gemma”'), '/modeli/gemma/');
});

test('unquoted Cyrillic names still produce stable nonempty URL segments', () => {
	assert.equal(modelPath('Диван Берег'), '/modeli/divan-bereg/');
	assert.equal(modelPath('Диван Берег'), modelPath(model('Диван Берег', 1)));
});

test('a conflicting slug fails explicitly instead of combining distinct model titles', () => {
	assert.throws(() => getModelGroups([
		model('Диван «Nova»', 1), model('Кровать «Nova»', 2),
	]), /slug.*nova/i);
});

test('visible models with empty or punctuation-only names fail before generating an empty route', () => {
	assert.throws(() => modelPath('  '), /название/i);
	assert.throws(() => getModelGroups([model('«…»', 1)]), /slug/i);
});
