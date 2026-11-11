import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { InputNumero } from './InputNumero';
import { Boton, Buscador, Encabezado, Esqueleto, Tarjeta, TablaEsqueleto, Vacio } from './primitives';
import { Dialogo } from './Dialogo';
import { TablaReporte, type AccionFila, type ColRep } from './TablaReporte';
import { exportarExcel } from '@/core/exportar';
import { urlApi } from '@/core/api';
import { imagenABase64 } from '@/core/imagen';

export interface Campo {
  key: string; label: string;
  /** seccion = subtítulo que agrupa campos; calculado = valor de solo lectura que se recalcula al escribir. */
  tipo?: 'texto' | 'numero' | 'pct' | 'select' | 'bool' | 'email' | 'tel' | 'fecha' | 'imagen' | 'seccion' | 'calculado' | 'filas';
  /** Para tipo calculado: recibe el formulario actual y devuelve el texto a mostrar. */
  calcular?: (form: Record<string, unknown>) => string;
  placeholder?: string;
  opciones?: Array<{ valor: string; texto: string }>;
  requerido?: boolean; ayuda?: string; max?: number; ancho?: boolean;
  /** Solo se escribe al crear (p. ej. el código de un catálogo): al editar se muestra sin cambiarlo. */
  soloAlCrear?: boolean;
  /** Al cambiar este campo, devuelve otros valores a completar (p. ej. el contenido de la presentación elegida). */
  alCambiar?: (valor: unknown, form: Record<string, unknown>) => Record<string, unknown>;
  /** Para tipo filas: subtabla editable (presentaciones, cuentas bancarias…). El valor es un arreglo. */
  columnasFila?: Array<{ key: string; label: string; tipo?: 'texto' | 'numero' | 'select' | 'bool'; opciones?: Array<{ valor: string; texto: string }>; max?: number; placeholder?: string }>;
  nuevaFila?: Record<string, unknown>;
  /** Para tipo filas: texto del botón para agregar. */
  agregar?: string;
}
type Reg = Record<string, unknown> & { id?: string };

/**
 * Administración genérica de un maestro: lista con búsqueda, alta, edición y exportación.
 * La validación de verdad la hace el API; aquí solo se guía al usuario y se muestra el error.
 */
export function Crud({ titulo, descripcion, cargar, columnas, campos, nuevo, crear, editar, eliminar, extra, acciones, accionesFila, nombreExport, deps, recargar }: {
  titulo: string; descripcion: string; cargar: () => Promise<Reg[]>; columnas: ColRep[]; campos: Campo[];
  nuevo: Reg; crear?: (d: Reg) => Promise<unknown>; editar?: (id: string, d: Reg) => Promise<unknown>; extra?: ReactNode; nombreExport: string;
  /** Botones extra en el encabezado (p. ej. Importar). */
  acciones?: ReactNode;
  /** Elimina un registro; el API rechaza si está en uso y el mensaje se muestra tal cual. */
  eliminar?: (id: string) => Promise<unknown>;
  /** Si cambia (p. ej. los datos globales tras guardar), la lista se vuelve a cargar. */
  deps?: unknown;
  /** Botones por fila (Anular, Ajustar precio…). */
  accionesFila?: AccionFila[];
  /** Cambia este número para recargar la lista desde fuera (tras una acción de fila). */
  recargar?: number;
}) {
  // null = cargando (esqueleto); [] = cargó y no hay registros.
  const [filas, setFilas] = useState<Reg[] | null>(null);
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Reg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  // Campo que nombra al registro en los títulos: "nombre" si existe; si no, el primer campo editable.
  const claveTitulo = (campos.find((c) => c.key === 'nombre') ?? campos.find((c) => !['imagen', 'seccion', 'calculado'].includes(c.tipo ?? '')) ?? campos[0]).key;
  const [aBorrar, setABorrar] = useState<Reg | null>(null);
  const [borrando, setBorrando] = useState(false);
  const [errorBorrar, setErrorBorrar] = useState<string | null>(null);
  const borrar = async () => {
    if (!aBorrar?.id || !eliminar) return;
    setBorrando(true); setErrorBorrar(null);
    try { await eliminar(String(aBorrar.id)); setABorrar(null); await refrescar(); }
    catch (e) { setErrorBorrar(e instanceof Error ? e.message : 'No se pudo eliminar.'); }
    finally { setBorrando(false); }
  };

  const refrescar = async () => { try { setFilas(await cargar()); setCargaError(null); } catch (e) { setCargaError(e instanceof Error ? e.message : 'No se pudo cargar.'); } };
  useEffect(() => { void refrescar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [deps, recargar]);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!filas) return [];
    return t ? filas.filter((f) => Object.values(f).some((v) => String(v ?? '').toLowerCase().includes(t))) : filas;
  }, [filas, q]);

  const guardar = async () => {
    if (!form) return;
    setGuardando(true);
    setError(null);
    try {
      const datos = Object.fromEntries(campos.filter((c) => c.tipo !== 'seccion' && c.tipo !== 'calculado').map((c) => [c.key,
        (c.tipo === 'numero' || c.tipo === 'pct') && form[c.key] === '' ? null
          // Subtabla: números como número; filas vacías fuera.
          : c.tipo === 'filas' ? ((form[c.key] as Reg[] | undefined) ?? []).map((fila) => Object.fromEntries(Object.entries(fila).map(([k, v]) =>
            [k, c.columnasFila?.find((x) => x.key === k)?.tipo === 'numero' ? (v === '' || v === null ? null : Number(v)) : v])))
          : form[c.key]]));
      if (form.id) await editar!(form.id, datos); else await crear!(datos);
      setForm(null);
      await refrescar();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); }
    finally { setGuardando(false); }
  };

  const set = (c: Campo, v: string | boolean) => setForm((f) => {
    if (!f) return f;
    const valor = c.tipo === 'numero' ? (v === '' ? '' : Number(v)) : c.tipo === 'pct' ? (v === '' ? '' : Number(v) / 100) : v;
    const nuevoForm = { ...f, [c.key]: valor };
    return c.alCambiar ? { ...nuevoForm, ...c.alCambiar(valor, nuevoForm) } : nuevoForm;
  });
  const filasDe = (c: Campo) => ((form?.[c.key] as Reg[] | undefined) ?? []);
  const setSub = (c: Campo, filas: Reg[]) => setForm((f) => f && ({ ...f, [c.key]: filas }));
  const valor = (c: Campo) => {
    const v = form?.[c.key];
    if (c.tipo === 'pct') return v === '' || v === undefined ? '' : String(Math.round(Number(v) * 10000) / 100);
    return v === undefined || v === null ? '' : String(v);
  };
  // Número que muestra el campo (porcentaje en %, el resto tal cual).
  const numero = (c: Campo): number | '' => {
    const v = form?.[c.key];
    if (v === '' || v === undefined || v === null) return '';
    return c.tipo === 'pct' ? Math.round(Number(v) * 10000) / 100 : Number(v);
  };

  return (
    <>
      <Encabezado titulo={titulo} descripcion={descripcion} acciones={<>
        <Boton icono="download" onClick={() => exportarExcel(nombreExport, visibles.map((f) => Object.fromEntries(columnas.map((c) => [c.label, f[c.key]]))))}>Excel</Boton>
        {acciones}
        {crear && <Boton variant="primary" icono="plus" onClick={() => { setError(null); setForm({ ...nuevo }); }}>Nuevo</Boton>}
      </>} />
      {extra}
      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div><h3 className="card__title">{filas === null ? <Esqueleto variante="titulo" ancho={120} /> : `${visibles.length} registros`}</h3><p className="card__sub">Clic en una fila para editarla. Cada cambio queda auditado.</p></div>
          <Buscador valor={q} onChange={setQ} placeholder="Buscar…" />
        </div>
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setFilas(null); void refrescar(); }} />
          : filas === null ? <TablaEsqueleto columnas={Math.min(columnas.length, 6)} />
          : visibles.length === 0 ? <Vacio titulo="Sin registros" detalle={q ? 'Prueba con otra búsqueda.' : 'Crea el primero con «Nuevo».'} />
            : <TablaReporte columnas={columnas} filas={visibles} // Excel: cada fila con «Modificar» visible (además del clic en la fila) y sus acciones propias.
              acciones={[...(editar ? [{ etiqueta: 'Modificar', icono: 'edit' as const, onClick: (f: Reg) => { setError(null); setForm({ ...f }); } }] : []), ...(accionesFila ?? [])]}
              onFila={editar ? (f) => { setError(null); setForm({ ...f }); } : undefined}
              onEliminar={eliminar ? (f) => { setErrorBorrar(null); setABorrar(f); } : undefined} />}
      </Tarjeta>

      <Dialogo abierto={aBorrar !== null} titulo={`Eliminar · ${String(aBorrar?.[claveTitulo] ?? '')}`}
        descripcion="Se borra de forma permanente y queda en la auditoría. Si está en uso, el sistema no lo permite."
        onCerrar={() => setABorrar(null)}
        acciones={<><Boton onClick={() => setABorrar(null)}>Cancelar</Boton><Boton variant="danger" onClick={() => void borrar()} disabled={borrando}>{borrando ? 'Eliminando…' : 'Eliminar'}</Boton></>}>
        {errorBorrar ? <p className="form__error" role="alert">{errorBorrar}</p> : <p>¿Seguro que quieres eliminarlo?</p>}
      </Dialogo>
      <Dialogo abierto={form !== null} titulo={form?.id ? `Editar · ${String(form?.[claveTitulo] ?? '')}` : `Nuevo · ${titulo.toLowerCase()}`}
        onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" onClick={() => formRef.current?.requestSubmit()} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Boton></>}>
        {/* El botón del pie envía este form: así rigen los «required» y Enter no duplica mientras guarda. */}
        <form ref={formRef} className="form form--2col form--dialogo" onSubmit={(e) => { e.preventDefault(); if (!guardando) void guardar(); }}>
          {campos.map((c) => c.tipo === 'seccion' ? (
            <div key={c.key} className="form__seccion field--ancho"><b>{c.label}</b>{c.ayuda && <span>{c.ayuda}</span>}</div>
          ) : c.tipo === 'calculado' ? (
            <div key={c.key} className={`field field--calculado ${c.ancho ? 'field--ancho' : ''}`}>
              <span className="field__label">{c.label}</span>
              <output className="field__valor">{form ? c.calcular?.(form) ?? '—' : '—'}</output>
              {c.ayuda && <span className="field__ayuda">{c.ayuda}</span>}
            </div>
          ) : c.tipo === 'filas' ? (
            <div key={c.key} className="field field--ancho subtabla">
              <span className="field__label">{c.label}</span>
              {filasDe(c).length > 0 && (
                <div className="table-wrap"><table className="table table--compacta">
                  <thead><tr>{c.columnasFila!.map((x) => <th key={x.key}>{x.label}</th>)}<th><span className="sr-only">Quitar</span></th></tr></thead>
                  <tbody>{filasDe(c).map((fila, i) => (
                    <tr key={i}>
                      {c.columnasFila!.map((x) => {
                        const cambiar = (v: unknown) => setSub(c, filasDe(c).map((y, j) => (j === i ? { ...y, [x.key]: v } : y)));
                        return (
                          <td key={x.key}>{x.tipo === 'select' ? (
                            <select className="field__input" aria-label={x.label} value={String(fila[x.key] ?? '')} onChange={(e) => cambiar(e.target.value)}>
                              {x.opciones?.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}</select>
                          ) : x.tipo === 'bool' ? (
                            <input type="checkbox" aria-label={x.label} checked={Boolean(fila[x.key])} onChange={(e) => cambiar(e.target.checked)} />
                          ) : (
                            <input className="field__input" aria-label={x.label} placeholder={x.placeholder} maxLength={x.max ?? 60}
                              type={x.tipo === 'numero' ? 'number' : 'text'} step={x.tipo === 'numero' ? 'any' : undefined} min={x.tipo === 'numero' ? 0 : undefined}
                              value={String(fila[x.key] ?? '')} onChange={(e) => cambiar(e.target.value)} />
                          )}</td>);
                      })}
                      <td><button type="button" className="btn-icono btn-icono--peligro" title="Quitar" aria-label="Quitar fila"
                        onClick={() => setSub(c, filasDe(c).filter((_, j) => j !== i))}>×</button></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              <div><Boton icono="plus" onClick={() => setSub(c, [...filasDe(c), { ...(c.nuevaFila ?? {}) }])}>{c.agregar ?? 'Agregar'}</Boton></div>
              {c.ayuda && <span className="field__ayuda">{c.ayuda}</span>}
            </div>
          ) : c.tipo === 'imagen' ? (
            <div key={c.key} className="field field--ancho">
              <span className="field__label">{c.label}</span>
              <div className="campo-imagen">
                {form?.[c.key] ? <img src={String(form[c.key]).startsWith('data:') ? String(form[c.key]) : urlApi(String(form[c.key]))} alt="" /> : <span className="campo-imagen__vacio">Sin imagen</span>}
                <label className="btn btn--secondary btn--md">{form?.[c.key] ? 'Cambiar imagen' : 'Subir imagen'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
                    const f = e.target.files?.[0]; e.target.value = '';
                    if (f) imagenABase64(f, 800).then((v) => set(c, v), (er: Error) => setError(er.message));
                  }} /></label>
                {!!form?.[c.key] && <Boton onClick={() => setForm((x) => x && ({ ...x, [c.key]: null }))}>Quitar</Boton>}
              </div>
              {c.ayuda && <span className="field__ayuda">{c.ayuda}</span>}
            </div>
          ) : c.tipo === 'bool' ? (
            <label key={c.key} className="check field--ancho"><input type="checkbox" checked={Boolean(form?.[c.key])} onChange={(e) => set(c, e.target.checked)} /> {c.label}</label>
          ) : (
            <label key={c.key} className={`field ${c.ancho ? 'field--ancho' : ''}`}>
              <span className="field__label">{c.label}{c.requerido ? ' *' : ''}</span>
              {c.tipo === 'select' ? (
                <select className="field__input" value={valor(c)} onChange={(e) => set(c, e.target.value)}>
                  {c.opciones?.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
                </select>
              ) : c.tipo === 'numero' || c.tipo === 'pct' ? (
                <InputNumero className="field__input" placeholder={c.placeholder} required={c.requerido} disabled={c.soloAlCrear && !!form?.id}
                  step={c.tipo === 'pct' ? '0.1' : 'any'} min={0}
                  valor={numero(c)} onValor={(n) => set(c, n === '' ? '' : String(n))} />
              ) : (
                <input className="field__input" placeholder={c.placeholder} required={c.requerido} maxLength={c.max ?? 160} disabled={c.soloAlCrear && !!form?.id}
                  type={c.tipo === 'email' ? 'email' : c.tipo === 'tel' ? 'tel' : c.tipo === 'fecha' ? 'date' : 'text'}
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
