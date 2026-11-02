import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Boton, Buscador, Encabezado, Tarjeta, Vacio } from './primitives';
import { Dialogo } from './Dialogo';
import { TablaReporte, type ColRep } from './TablaReporte';
import { exportarExcel } from '@/core/exportar';

export interface Campo {
  key: string; label: string;
  tipo?: 'texto' | 'numero' | 'pct' | 'select' | 'bool' | 'email' | 'tel';
  opciones?: Array<{ valor: string; texto: string }>;
  requerido?: boolean; ayuda?: string; max?: number; ancho?: boolean;
}
type Reg = Record<string, unknown> & { id?: string };

/**
 * Administración genérica de un maestro: lista con búsqueda, alta, edición y exportación.
 * La validación de verdad la hace el API; aquí solo se guía al usuario y se muestra el error.
 */
export function Crud({ titulo, descripcion, cargar, columnas, campos, nuevo, crear, editar, extra, nombreExport, deps }: {
  titulo: string; descripcion: string; cargar: () => Promise<Reg[]>; columnas: ColRep[]; campos: Campo[];
  nuevo: Reg; crear?: (d: Reg) => Promise<unknown>; editar?: (id: string, d: Reg) => Promise<unknown>; extra?: ReactNode; nombreExport: string;
  /** Si cambia (p. ej. los datos globales tras guardar), la lista se vuelve a cargar. */
  deps?: unknown;
}) {
  const [filas, setFilas] = useState<Reg[]>([]);
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Reg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cargaError, setCargaError] = useState<string | null>(null);

  const refrescar = async () => { try { setFilas(await cargar()); setCargaError(null); } catch (e) { setCargaError(e instanceof Error ? e.message : 'No se pudo cargar.'); } };
  useEffect(() => { void refrescar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [deps]);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? filas.filter((f) => Object.values(f).some((v) => String(v ?? '').toLowerCase().includes(t))) : filas;
  }, [filas, q]);

  const guardar = async () => {
    if (!form) return;
    setGuardando(true);
    setError(null);
    try {
      const datos = Object.fromEntries(campos.map((c) => [c.key, form[c.key]]));
      if (form.id) await editar!(form.id, datos); else await crear!(datos);
      setForm(null);
      await refrescar();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); }
    finally { setGuardando(false); }
  };

  const set = (c: Campo, v: string | boolean) => setForm((f) => f && ({
    ...f, [c.key]: c.tipo === 'numero' ? (v === '' ? '' : Number(v)) : c.tipo === 'pct' ? (v === '' ? '' : Number(v) / 100) : v,
  }));
  const valor = (c: Campo) => {
    const v = form?.[c.key];
    if (c.tipo === 'pct') return v === '' || v === undefined ? '' : String(Math.round(Number(v) * 10000) / 100);
    return v === undefined || v === null ? '' : String(v);
  };

  return (
    <>
      <Encabezado titulo={titulo} descripcion={descripcion} acciones={<>
        <Boton icono="download" onClick={() => exportarExcel(nombreExport, visibles.map((f) => Object.fromEntries(columnas.map((c) => [c.label, f[c.key]]))))}>Excel</Boton>
        {crear && <Boton variant="primary" icono="plus" onClick={() => { setError(null); setForm({ ...nuevo }); }}>Nuevo</Boton>}
      </>} />
      {extra}
      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div><h3 className="card__title">{visibles.length} registros</h3><p className="card__sub">Clic en una fila para editarla. Cada cambio queda auditado.</p></div>
          <Buscador valor={q} onChange={setQ} placeholder="Buscar…" />
        </div>
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} />
          : visibles.length === 0 ? <Vacio titulo="Sin registros" detalle={q ? 'Prueba con otra búsqueda.' : 'Crea el primero con «Nuevo».'} />
            : <TablaReporte columnas={columnas} filas={visibles} onFila={editar ? (f) => { setError(null); setForm({ ...f }); } : undefined} />}
      </Tarjeta>

      <Dialogo abierto={form !== null} titulo={form?.id ? `Editar · ${String(form?.[campos[0].key] ?? '')}` : `Nuevo · ${titulo.toLowerCase()}`}
        onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" onClick={() => void guardar()} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Boton></>}>
        <form className="form form--2col form--dialogo" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
          {campos.map((c) => c.tipo === 'bool' ? (
            <label key={c.key} className="check field--ancho"><input type="checkbox" checked={Boolean(form?.[c.key])} onChange={(e) => set(c, e.target.checked)} /> {c.label}</label>
          ) : (
            <label key={c.key} className={`field ${c.ancho ? 'field--ancho' : ''}`}>
              <span className="field__label">{c.label}{c.requerido ? ' *' : ''}</span>
              {c.tipo === 'select' ? (
                <select className="field__input" value={valor(c)} onChange={(e) => set(c, e.target.value)}>
                  {c.opciones?.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                </select>
              ) : (
                <input className="field__input" required={c.requerido} maxLength={c.max ?? 160}
                  type={c.tipo === 'numero' || c.tipo === 'pct' ? 'number' : c.tipo === 'email' ? 'email' : c.tipo === 'tel' ? 'tel' : 'text'}
                  step={c.tipo === 'pct' ? '0.1' : c.tipo === 'numero' ? 'any' : undefined} min={c.tipo === 'numero' || c.tipo === 'pct' ? 0 : undefined}
                  value={valor(c)} onChange={(e) => set(c, e.target.value)} />
              )}
              {c.ayuda && <span className="field__ayuda">{c.ayuda}</span>}
            </label>
          ))}
          {error && <p className="form__error field--ancho" role="alert">{error}</p>}
          <button type="submit" hidden />
        </form>
      </Dialogo>
    </>
  );
}
