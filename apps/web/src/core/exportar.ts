/**
 * Exportación a Excel (.xlsx, lo arma el servidor) y a PDF (impresión del navegador).
 * El CSV queda para las plantillas de importación, que se leen como texto, y como respaldo sin conexión.
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

function descargar(blob: Blob, archivo: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = archivo;
  a.click();
  URL.revokeObjectURL(url);
}

const conFecha = (nombre: string, ext: string) => `${nombre}-${new Date().toISOString().slice(0, 10)}.${ext}`;

export function exportarCsv(nombre: string, filas: Array<Record<string, unknown>>): void {
  descargar(new Blob(['﻿' + aCsv(filas)], { type: 'text/csv;charset=utf-8' }), conFecha(nombre, 'csv'));
}

export async function exportarExcel(nombre: string, filas: Array<Record<string, unknown>>): Promise<void> {
  try {
    const { apiArchivo } = await import('./api');
    descargar(await apiArchivo('/exportar/excel', { nombre, filas }), conFecha(nombre, 'xlsx'));
  } catch { exportarCsv(nombre, filas); } // sin conexión el usuario igual se lleva sus datos
}

/** PDF: el navegador imprime la pantalla actual sin menú ni botones (ver @media print). */
export const exportarPdf = () => window.print();
