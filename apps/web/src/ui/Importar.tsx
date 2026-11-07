import { useState } from 'react';
import { Boton } from './primitives';
import { Dialogo } from './Dialogo';
import { exportarCsv } from '@/core/exportar';

/**
 * Carga masiva desde la plantilla: Excel → «Guardar como CSV». El servidor valida cada fila y
 * devuelve las que fallaron con su motivo; las válidas se cargan igual (RN-40).
 * ponytail: CSV en vez de .xlsx para no sumar una librería; si piden .xlsx directo, ahí se agrega.
 */

/** CSV con ; o , (Excel en español usa ;), comillas dobles y saltos dentro de comillas. */
export function leerCsv(texto: string): Array<Record<string, string>> {
  const t = texto.replace(/^﻿/, '');
  const sep = (t.split(/\r?\n/)[0].match(/;/g)?.length ?? 0) >= (t.split(/\r?\n/)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const filas: string[][] = [];
  let fila: string[] = [], celda = '', comillas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (comillas) {
      if (ch === '"' && t[i + 1] === '"') { celda += '"'; i++; } else if (ch === '"') comillas = false; else celda += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) { fila.push(celda); celda = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      fila.push(celda); filas.push(fila); fila = []; celda = '';
    } else celda += ch;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  const [cab, ...resto] = filas.filter((f) => f.some((c) => c.trim() !== ''));
  if (!cab) return [];
  const claves = cab.map((c) => c.trim());
  return resto.map((f) => Object.fromEntries(claves.map((k, i) => [k, (f[i] ?? '').trim()])));
}

/** "1.234,5" o "1234.5" → número; vacío → undefined (el servidor aplica su valor por defecto). */
const numero = (v: string) => {
  if (v === '') return undefined;
  const limpio = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : v; // texto inválido: que el servidor diga qué fila falla
};

export interface ResultadoImportacion { ok: number; errores: Array<{ fila: number; nombre?: string; codigo?: string; motivo: string }> }

export function Importar({ titulo, descripcion, plantilla, numericas, enviar, onListo }: {
  titulo: string; descripcion: string;
  /** Fila de ejemplo: sus claves son los encabezados de la plantilla. */
  plantilla: Record<string, string | number>;
  numericas: string[];
  enviar: (filas: Array<Record<string, unknown>>) => Promise<ResultadoImportacion>;
  onListo?: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [res, setRes] = useState<ResultadoImportacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const subir = async (archivo: File) => {
    setError(null); setRes(null); setCargando(true);
    try {
      const filas = leerCsv(await archivo.text()).map((f) => Object.fromEntries(
        Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => [k, numericas.includes(k) ? numero(v) : v])));
      if (!filas.length) throw new Error('El archivo no tiene filas. Usa la plantilla y guárdala como CSV.');
      const r = await enviar(filas);
      setRes(r);
      if (r.ok) onListo?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo importar.'); }
    finally { setCargando(false); }
  };

  return (
    <>
      <Boton icono="up" onClick={() => { setAbierto(true); setRes(null); setError(null); }}>Importar</Boton>
      <Dialogo abierto={abierto} titulo={titulo} descripcion={descripcion} onCerrar={() => setAbierto(false)}
        acciones={<Boton onClick={() => setAbierto(false)}>Cerrar</Boton>}>
        <div className="form">
          <div className="campo-imagen">
            <Boton icono="download" onClick={() => exportarCsv('plantilla', [plantilla])}>Descargar plantilla</Boton>
            <label className="btn btn--primary btn--md">{cargando ? 'Importando…' : 'Elegir archivo CSV'}
              <input type="file" accept=".csv,text/csv" hidden disabled={cargando} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void subir(f); }} />
            </label>
          </div>
          <p className="field__ayuda">En Excel: Archivo → Guardar como → CSV (delimitado por comas o punto y coma). La primera fila son los encabezados de la plantilla.</p>
          {error && <p className="form__error" role="alert">{error}</p>}
          {res && (
            <div role="status">
              <p><b>{res.ok}</b> fila(s) cargadas · <b>{res.errores.length}</b> con error</p>
              {res.errores.length > 0 && (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Fila</th><th>Ítem</th><th>Motivo</th></tr></thead>
                  <tbody>{res.errores.map((e) => <tr key={e.fila}><td>{e.fila}</td><td>{e.nombre ?? e.codigo}</td><td>{e.motivo}</td></tr>)}</tbody>
                </table></div>
              )}
            </div>
          )}
        </div>
      </Dialogo>
    </>
  );
}
