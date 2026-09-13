// Smaller copies of the photos that live in the repo (public/ceh — workshop
// photos, public/models — photos of the fallback content), so the page can
// offer the browser a srcset instead of the full 960–1280px file.
//
// Run by hand after adding or replacing a photo there, and commit the output:
//
//   node scripts/make-image-variants.mjs
//
// For public/<dir>/<name>.webp it writes <name>-480.webp, <name>-800.webp and
// <name>-1024.webp (widths not smaller than 90% of the original are skipped,
// the original itself is the largest candidate) and records the srcset per
// photo in scripts/image-variants.json, which src/lib/content.ts reads.
// Encoding matches the Directus transform fetch-content.mjs requests for
// admin photos: WebP quality 80, Lanczos downscale.
//
// sharp is not a dependency of the site: it arrives with astro. The server
// build never runs this script.

import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let sharp;
try {
	sharp = (await import('sharp')).default;
} catch {
	console.error('sharp is not installed (it normally comes with astro): run npm ci first');
	process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['ceh', 'models'];
const WIDTHS = [480, 800, 1024];
const QUALITY = 80;
const MANIFEST = path.join(root, 'scripts/image-variants.json');
const VARIANT_NAME = new RegExp(`-(?:${WIDTHS.join('|')})\\.webp$`);

async function newerThan(target, source) {
	const [t, s] = await Promise.all([stat(target).catch(() => null), stat(source)]);
	return Boolean(t && t.mtimeMs >= s.mtimeMs);
}

const manifest = {};
let written = 0;
for (const dir of DIRS) {
	const full = path.join(root, 'public', dir);
	const files = (await readdir(full)).filter((f) => f.endsWith('.webp') && !VARIANT_NAME.test(f)).sort();
	for (const file of files) {
		const source = path.join(full, file);
		const { width } = await sharp(source).metadata();
		const base = file.replace(/\.webp$/, '');
		const candidates = [];
		for (const w of WIDTHS.filter((x) => x < width * 0.9)) {
			const target = path.join(full, `${base}-${w}.webp`);
			if (!(await newerThan(target, source))) {
				await sharp(source).resize({ width: w }).webp({ quality: QUALITY }).toFile(target);
				written++;
			}
			candidates.push(`/${dir}/${base}-${w}.webp ${w}w`);
		}
		candidates.push(`/${dir}/${file} ${width}w`);
		manifest[`/${dir}/${file}`] = candidates.join(', ');
	}
}
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, '\t')}\n`);
console.log(`[variants] ${Object.keys(manifest).length} photos, ${written} files written`);
