'use strict';
// Liest die versionierten Prompts aus prompts/<version>/<name>.md (Abschnitte "# System" und "# User-Vorlage").
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function promptLesen(datei) {
	const roh = fs.readFileSync(datei, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
	const m = roh.match(/^# System\s*\n([\s\S]*?)\n# User-Vorlage\s*\n([\s\S]*)$/m);
	if (!m) throw new Error(`${datei}: Abschnitte "# System" und "# User-Vorlage" fehlen`);
	const system = m[1].trim();
	const userVorlage = m[2].trim();
	if (!userVorlage.includes('{{MAIL}}')) throw new Error(`${datei}: User-Vorlage enthält {{MAIL}} nicht`);
	return {
		name: path.basename(datei, '.md'),
		version: path.basename(path.dirname(datei)),
		system,
		user_vorlage: userVorlage,
		pruefsumme: crypto.createHash('sha256').update(system + '\n---\n' + userVorlage).digest('hex').slice(0, 16),
		aktiv: true,
	};
}

function allePrompts() {
	const basis = path.join(ROOT, 'prompts');
	const out = [];
	for (const version of fs.readdirSync(basis).filter((v) => /^v\d+$/.test(v)).sort()) {
		for (const datei of fs.readdirSync(path.join(basis, version)).filter((d) => d.endsWith('.md')).sort()) {
			out.push(promptLesen(path.join(basis, version, datei)));
		}
	}
	return out;
}

module.exports = { promptLesen, allePrompts };
