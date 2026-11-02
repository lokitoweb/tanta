// Genera dist/tokens.css y dist/tokens.dart desde tokens.json.
// Un solo origen de verdad para web y móvil: si un color no está aquí, no existe.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(await readFile(join(here, 'tokens.json'), 'utf8'));
await mkdir(join(here, 'dist'), { recursive: true });

const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/_/g, '-');

/** Aplana el árbol a pares nombre -> valor, prefijando con el grupo raíz. */
function flatten(obj, prefix = [], out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$')) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => out.push([[...prefix, k, String(i + 1)].map(kebab).join('-'), item]));
    } else if (v && typeof v === 'object') {
      flatten(v, [...prefix, k], out);
    } else {
      out.push([[...prefix, k].map(kebab).join('-'), v]);
    }
  }
  return out;
}

const flat = flatten(tokens).filter(([, v]) => typeof v === 'string' && /^[#0-9]|^'|^0|^rgba|^\d/.test(String(v)));

// ---------- CSS ----------
const groups = {
  color: '--tanta-',
  surface: '--tanta-',
  border: '--tanta-',
  text: '--tanta-text-',
  font: '--tanta-',
  space: '--tanta-space-',
  radius: '--tanta-radius-',
  shadow: '--tanta-shadow-',
  chart: '--tanta-chart-'
};

let css = `/* GENERADO por packages/tokens/build.mjs - no editar a mano. */\n:root {\n`;
for (const [name, value] of flat) {
  let varName;
  if (name.startsWith('color-')) {
    varName = '--tanta-' + name.slice(6);
  } else if (name.startsWith('surface-')) {
    varName = '--tanta-surface-' + name.slice(8);
  } else if (name.startsWith('border-')) {
    varName = '--tanta-border-' + name.slice(7);
  } else if (name.startsWith('text-')) {
    varName = '--tanta-text-' + name.slice(5);
  } else if (name.startsWith('state-')) {
    varName = '--tanta-state-' + name.slice(6);
  } else if (name.startsWith('brand-')) {
    varName = '--tanta-brand-' + name.slice(6);
  } else if (name.startsWith('font-')) {
    varName = '--tanta-' + name;
  } else if (name.startsWith('space-')) {
    varName = '--tanta-space-' + name.slice(6);
  } else if (name.startsWith('radius-')) {
    varName = '--tanta-radius-' + name.slice(7);
  } else if (name.startsWith('shadow-')) {
    varName = '--tanta-shadow-' + name.slice(7);
  } else if (name.startsWith('chart-')) {
    varName = '--tanta-chart-' + name.slice(6);
  } else {
    varName = '--tanta-' + name;
  }
  css += `  ${varName}: ${value};\n`;
}
css += `}\n`;

// ---------- Dart ----------
const dartColor = (hex) => {
  const h = hex.replace('#', '').toUpperCase();
  if (h.length === 6) return `Color(0xFF${h})`;
  return null;
};
const colorEntries = flat.filter(([, v]) => /^#[0-9A-Fa-f]{6}$/.test(v));
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
let dart = `// GENERADO por packages/tokens/build.mjs — no editar a mano.
import 'package:flutter/material.dart';

class TantaColors {
  const TantaColors._();
${colorEntries.map(([n, v]) => `  static const ${camel(n)} = ${dartColor(v)};`).join('\n')}
}

class TantaChartSeries {
  const TantaChartSeries._();
  static const List<Color> all = <Color>[
${(tokens.chart?.series ?? []).map((c) => `    ${dartColor(c)},`).join('\n')}
  ];
}
`;

await writeFile(join(here, 'dist', 'tokens.css'), css, 'utf8');
await writeFile(join(here, 'dist', 'tokens.dart'), dart, 'utf8');
console.log(`tokens.css: ${flat.length} variables · tokens.dart: ${colorEntries.length} colores`);
