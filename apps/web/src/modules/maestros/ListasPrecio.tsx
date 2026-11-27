import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, TarjetaTitulo } from '@/ui/primitives';

interface Resumen { codigo: string; nombre: string; descripcion: string; activa: boolean; orden: number; productos: number; clientes: number }
interface Detalle { codigo: string; nombre: string; descripcion: string; activa: boolean; orden: number;
  precios: Array<{ productoId: string; precio: number }>; clientes: Array<{ id: string; nombre: string }> }
type Form = { codigo: string | null; nombre: string; descripcion: string; activa: boolean; orden: string; precios: Record<string, string>; clientes: Detalle['clientes'] };

const vacio: Form = { codigo: null, nombre: '', descripcion: '', activa: true, orden: '10', precios: {}, clientes: [] };

/**
 * Listas de precios (pedido del ingeniero): cada lista tiene su nombre y un precio propio por producto.
 * Los clientes se asignan en su ficha (Maestros → Clientes); varios pueden compartir una lista.
 * Un producto sin precio en la lista se cobra al del catálogo. La oferta vale para todos y manda sobre la lista.
 */
export function ListasPrecio() {
  const { dataset } = useApp();
  const productos = useMemo(() => dataset.productos.filter((p) => p.estado === 'ACTIVO' && !p.insumoId), [dataset.productos]);
  const [listas, setListas] = useState<Resumen[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [buscar, setBuscar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = () => api<Resumen[]>('/listas-precio').then(setListas).catch((e) => setError(e.message));
  useEffect(() => { void cargar(); }, []);

  const abrir = async (codigo: string) => {
    setError(null); setNota(null);
    try {
      const d = await api<Detalle>(`/listas-precio/${codigo}`);
      setForm({ codigo: d.codigo, nombre: d.nombre, descripcion: d.descripcion, activa: d.activa, orden: String(d.orden),
        precios: Object.fromEntries(d.precios.map((x) => [x.productoId, String(x.precio)])), clientes: d.clientes });
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo abrir la lista.'); }
  };

  const precios = form ? Object.entries(form.precios).filter(([, v]) => v.trim() !== '') : [];
  const invalidos = precios.filter(([, v]) => !(Number(v.replace(',', '.')) > 0));
  const guardar = async () => {
    if (!form) return;
    setGuardando(true); setError(null); setNota(null);
    const body = { nombre: form.nombre, descripcion: form.descripcion, activa: form.activa, orden: Number(form.orden) || 0,
      precios: precios.map(([productoId, v]) => ({ productoId, precio: Number(Number(v.replace(',', '.')).toFixed(2)) })) };
    try {
      const r = form.codigo
        ? await api<{ codigo: string }>(`/listas-precio/${form.codigo}`, { method: 'PUT', body })
        : await api<{ codigo: string }>('/listas-precio', { method: 'POST', body });
      await cargar();
      await abrir(r.codigo);
      setNota(`Lista «${form.nombre}» guardada: ${body.precios.length} productos con precio propio; el resto, al precio del catálogo.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar la lista.'); }
    finally { setGuardando(false); }
  };

  const filtrados = productos.filter((p) => !buscar || `${p.codigo} ${p.nombre}`.toLowerCase().includes(buscar.toLowerCase()));
  const ponerPrecio = (id: string, v: string) => form && setForm({ ...form, precios: { ...form.precios, [id]: v } });

  return (
    <>
      <Encabezado titulo="Listas de precios"
        descripcion="Cada lista con su precio por producto · el cliente se asigna en su ficha · sin precio propio se cobra el del catálogo · la oferta vale para todos"
        acciones={<Boton variant="primary" icono="plus" onClick={() => { setError(null); setNota(null); setForm({ ...vacio, precios: {} }); }}>Nueva lista</Boton>} />

      {error && <div className="aviso aviso--danger" role="alert"><span className="aviso__icono">!</span><div><p>{error}</p></div></div>}
      {nota && <div className="aviso aviso--ok" role="status"><span className="aviso__icono">✓</span><div><p>{nota}</p></div></div>}

      <div className="grid grid--12">
        <Tarjeta className="col-4">
          <TarjetaTitulo titulo="Listas" subtitulo={`${listas.length} listas · elige una para ver o cambiar sus precios`} />
          <ul className="roleslista">
            {listas.map((l) => (
              <li key={l.codigo}>
                <button type="button" className="acceso-card" style={{ width: '100%', textAlign: 'left', outline: form?.codigo === l.codigo ? '2px solid var(--tanta-primario)' : undefined }}
                  onClick={() => void abrir(l.codigo)}>
                  <div style={{ flex: 1 }}>
                    <p className="roleslista__nombre">{l.nombre} {!l.activa && <Insignia tono="danger">Inactiva</Insignia>}</p>
                    <p className="roleslista__desc">{l.productos} con precio propio · {l.clientes} {l.clientes === 1 ? 'cliente' : 'clientes'}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Tarjeta>

        <Tarjeta className="col-8">
          {!form ? <p className="t-muted">Elige una lista de la izquierda o crea una nueva.</p> : (
            <>
              <TarjetaTitulo titulo={form.codigo ? `Lista · ${form.nombre}` : 'Nueva lista'}
                subtitulo={form.codigo ? `Código ${form.codigo} · es lo que guarda la ficha del cliente` : 'El código se genera del nombre'} />
              <div className="form form--compacto">
                <label className="field"><span className="field__label">Nombre</span>
                  <input className="field__input" maxLength={60} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} placeholder="Mayorista, Cafeterías, Hoteles…" /></label>
                <label className="field"><span className="field__label">Orden</span>
                  <input className="field__input" type="number" min={0} value={form.orden} onChange={(e) => setForm({ ...form, orden: e.target.value })} /></label>
                <label className="field field--ancho"><span className="field__label">Descripción (opcional)</span>
                  <input className="field__input" maxLength={200} value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} /></label>
                <label className="field"><span className="field__label">Estado</span>
                  <select className="field__input" value={form.activa ? '1' : '0'} onChange={(e) => setForm({ ...form, activa: e.target.value === '1' })}>
                    <option value="1">Activa</option><option value="0">Inactiva (sus clientes pagan el precio del catálogo)</option></select></label>
              </div>

              {form.codigo && (
                <p className="t-muted" style={{ margin: '12px 0' }}>
                  <strong>Clientes en esta lista ({form.clientes.length}):</strong>{' '}
                  {form.clientes.length ? form.clientes.map((c) => c.nombre).join(', ') : 'ninguno todavía'} · se asignan en Maestros → Clientes.
                </p>
              )}

              <div style={{ margin: '12px 0' }}><Buscador valor={buscar} onChange={setBuscar} placeholder="Buscar producto…" /></div>
              <table className="table table--compacta">
                <thead><tr><th>Producto</th><th className="t-right">Precio catálogo</th><th className="t-right">Precio en esta lista</th><th className="t-right">Diferencia</th></tr></thead>
                <tbody>
                  {filtrados.map((p) => {
                    const v = form.precios[p.id] ?? '', n = Number(v.replace(',', '.'));
                    const dif = v.trim() && n > 0 && p.precioConIgv > 0 ? n / p.precioConIgv - 1 : null;
                    return (
                      <tr key={p.id}>
                        <td>{p.nombre}</td>
                        <td className="t-right">{money(p.precioConIgv)}</td>
                        <td className="t-right">
                          <input className="field__input field__input--corto" type="number" min="0" step="0.05" inputMode="decimal" aria-label={`Precio de ${p.nombre} en la lista`}
                            value={v} placeholder="catálogo" onChange={(e) => ponerPrecio(p.id, e.target.value)} />
                        </td>
                        <td className="t-right">{dif === null ? <span className="t-muted">—</span>
                          : <Insignia tono={dif < 0 ? 'ok' : dif > 0 ? 'warn' : 'neutral'}>{dif > 0 ? '+' : ''}{Math.round(dif * 1000) / 10} %</Insignia>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="t-muted" style={{ marginTop: 8 }}>Deja el precio vacío para cobrar el del catálogo. Los paquetes (docena, etc.) bajan o suben en la misma proporción que la unidad.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <Boton onClick={() => setForm(null)}>Cancelar</Boton>
                <Boton variant="primary" disabled={guardando || form.nombre.trim().length < 2 || invalidos.length > 0} onClick={() => void guardar()}>
                  {guardando ? 'Guardando…' : 'Guardar lista'}</Boton>
              </div>
              {invalidos.length > 0 && <p className="form__error">Hay {invalidos.length} precio(s) que no son mayores que cero.</p>}
            </>
          )}
        </Tarjeta>
      </div>
    </>
  );
}
