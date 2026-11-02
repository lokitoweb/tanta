/**
 * Exportación a Excel (CSV) y a PDF (impresión del navegador).
 *
 * ponytail: CSV con BOM y ';' abre directo en Excel en español sin dependencias; si el cliente
 * necesita formato (colores, varias hojas), recién ahí vale la pena una librería .xlsx.
 */

// Una celda que empieza con = + - @ se ejecuta como fórmula en Excel (inyección CSV).
const PELIGROSO = /^[=+\-@\t\r]/;

function celda(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  if (typeof v !== 'number' && PELIGROSO.test(s)) s = "'" + s;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function aCsv(filas: Array<Record<string, unknown>>): string {
  if (!filas.length) return '';
  const cols = Object.keys(filas[0]);
  return [cols.map(celda).join(';'), ...filas.map((f) => cols.map((c) => celda(f[c])).join(';'))].join('\r\n');
}

export function exportarExcel(nombre: string, filas: Array<Record<string, unknown>>): void {
  const blob = new Blob(['﻿' + aCsv(filas)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nombre}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** PDF: el navegador imprime la pantalla actual sin menú ni botones (ver @media print). */
export const exportarPdf = () => window.print();
