import { deflateRawSync } from 'node:zlib';

/**
 * Libro de Excel (.xlsx) con encabezado, filtros, panel fijo y columnas a medida. Un .xlsx es un ZIP de XML:
 * se arma aquí, sin dependencias. El texto va como cadena en línea, así que nunca se ejecuta como fórmula.
 */

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = TABLA_CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(archivos: Array<[string, string]>): Buffer {
  const partes: Buffer[] = [];
  const central: Buffer[] = [];
  let desplazamiento = 0;
  for (const [nombre, texto] of archivos) {
    const crudo = Buffer.from(texto, 'utf8'), datos = deflateRawSync(crudo), n = Buffer.from(nombre, 'utf8'), crc = crc32(crudo);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(datos.length, 18); local.writeUInt32LE(crudo.length, 22); local.writeUInt16LE(n.length, 26);
    const cab = Buffer.alloc(46);
    cab.writeUInt32LE(0x02014b50, 0); cab.writeUInt16LE(20, 4); cab.writeUInt16LE(20, 6); cab.writeUInt16LE(0x0800, 8); cab.writeUInt16LE(8, 10);
    cab.writeUInt32LE(crc, 16); cab.writeUInt32LE(datos.length, 20); cab.writeUInt32LE(crudo.length, 24); cab.writeUInt16LE(n.length, 28); cab.writeUInt32LE(desplazamiento, 42);
    partes.push(local, n, datos);
    central.push(cab, n);
    desplazamiento += local.length + n.length + datos.length;
  }
  const dir = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10); fin.writeUInt32LE(dir.length, 12); fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...partes, dir, fin]);
}

// Solo los caracteres que XML 1.0 admite.
const xml = (s: string) => s.replace(/[^\t\n\r -퟿-�]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const columna = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const celda = (ref: string, v: unknown, estilo: number) => {
  if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${estilo}"/>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${estilo || 2}"><v>${v}</v></c>`;
  return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${xml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</t></is></c>`;
};

export function libroExcel(titulo: string, filas: Array<Record<string, unknown>>): Buffer {
  const cols = [...new Set(filas.flatMap((f) => Object.keys(f)))];
  const hoja = xml(titulo.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31)) || 'Datos';
  const ancho = cols.map((c) => Math.min(48, Math.max(c.length, ...filas.slice(0, 1000).map((f) => String(f[c] ?? '').length)) + 3));
  const ultima = `${columna(Math.max(cols.length - 1, 0))}${filas.length + 1}`;
  const filasXml = [
    `<row r="1">${cols.map((c, i) => celda(`${columna(i)}1`, c, 1)).join('')}</row>`,
    ...filas.map((f, k) => `<row r="${k + 2}">${cols.map((c, i) => celda(`${columna(i)}${k + 2}`, f[c], 0)).join('')}</row>`),
  ].join('');
  const cabecera = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zip([
    ['[Content_Types].xml', `${cabecera}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `${cabecera}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${cabecera}<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${hoja}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${cabecera}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    // Estilos: 0 texto · 1 encabezado (negrita blanca sobre café) · 2 número con separador de miles.
    ['xl/styles.xml', `${cabecera}<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2E1F18"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml', `${cabecera}<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols.length ? `<cols>${ancho.map((a, i) => `<col min="${i + 1}" max="${i + 1}" width="${a}" customWidth="1"/>`).join('')}</cols>` : ''}<sheetData>${filasXml}</sheetData>${cols.length ? `<autoFilter ref="A1:${ultima}"/>` : ''}</worksheet>`],
  ]);
}
