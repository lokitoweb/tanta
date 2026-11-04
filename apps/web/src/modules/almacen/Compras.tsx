import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money, num2 as num } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Tarjeta, Vacio } from '@/ui/primitives';

interface Proveedor { id: string; razonSocial: string; ruc: string; estado: string }
interface Compra { codigo: string; fecha: string; proveedor: string; documento: string; total: number; registradoPor: string;
  items: Array<{ insumo: string; unidad: string; cantidad: number; precio: number; cppAnterior: number; cppNuevo: number }> }
interface Linea { insumoId: string; cantidad: string; precio: string; lote: string; venceEn: string }

/** Registro de compras (M05): proveedor, documento y varias líneas; muestra el nuevo costo promedio antes de guardar. */
export function Compras() {
  const { dataset, refrescarDatos } = useApp();
  const [compras, setCompras] = useState<Compra[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [form, setForm] = useState<{ proveedorId: string; docTipo: string; docNumero: string; lineas: Linea[] } | null>(null);
  const [ver, setVer] = useState<Compra | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = () => Promise.all([api<Compra[]>('/compras').then(setCompras), api<Proveedor[]>('/proveedores').then((p) => setProveedores(p.filter((x) => x.estado === 'ACTIVO')))])
    .catch((e) => setAviso({ tono: 'danger', texto: e.message }));
  useEffect(() => { void cargar(); }, []);

  const insumos = dataset.insumos;
  const nueva = () => setForm({ proveedorId: proveedores[0]?.id ?? '', docTipo: 'FACTURA', docNumero: '', lineas: [{ insumoId: insumos[0]?.id ?? '', cantidad: '', precio: '', lote: '', venceEn: '' }] });
  const linea = (i: number, cambio: Partial<Linea>) => form && setForm({ ...form, lineas: form.lineas.map((l, j) => (j === i ? { ...l, ...cambio } : l)) });
  const total = form?.lineas.reduce((s, l) => s + Number(l.cantidad) * Number(l.precio), 0) ?? 0;
  const validas = form ? form.lineas.every((l) => l.insumoId && Number(l.cantidad) > 0 && Number(l.precio) > 0)
    && new Set(form.lineas.map((l) => l.insumoId)).size === form.lineas.length : false;
  const valido = !!form && !!form.proveedorId && /^[A-Za-z0-9-]{3,20}$/.test(form.docNumero.trim()) && validas;

  const guardar = async () => {
    if (!form) return;
    setGuardando(true);
    try {
      const r = await api<{ codigo: string; total: number }>('/compras', { method: 'POST', conIdempotencia: true, body: {
        proveedorId: form.proveedorId, docTipo: form.docTipo, docNumero: form.docNumero.trim(),
        items: form.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: Number(l.cantidad), precio: Number(l.precio), lote: l.lote.trim(), venceEn: l.venceEn })) } });
      setForm(null);
      await Promise.all([cargar(), refrescarDatos()]);
      setAviso({ tono: 'ok', texto: `Compra ${r.codigo} registrada por ${money(r.total)}: stock y costo promedio actualizados.` });
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setGuardando(false); }
  };

  return (
    <>
      <Encabezado titulo="Compras" descripcion="Ingreso de insumos con proveedor y documento · actualiza stock y costo promedio ponderado"
        acciones={<Boton variant="primary" icono="plus" disabled={!proveedores.length} onClick={nueva}>Registrar compra</Boton>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <Dialogo abierto={form !== null} titulo="Registrar compra" descripcion="El costo promedio nuevo se calcula con el stock actual."
        onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" disabled={!valido || guardando} onClick={() => void guardar()}>{guardando ? 'Guardando…' : `Guardar ${money(total)}`}</Boton></>}>
        {form && (<>
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Proveedor</span>
              <select className="field__input" value={form.proveedorId} onChange={(e) => setForm({ ...form, proveedorId: e.target.value })}>
                {proveedores.map((p) => <option key={p.id} value={p.id}>{p.razonSocial}{p.ruc ? ` · ${p.ruc}` : ''}</option>)}</select></label>
            <label className="field"><span className="field__label">Documento</span>
              <select className="field__input" value={form.docTipo} onChange={(e) => setForm({ ...form, docTipo: e.target.value })}>
                <option value="FACTURA">Factura</option><option value="BOLETA">Boleta</option><option value="GUIA">Guía de remisión</option></select></label>
            <label className="field"><span className="field__label">Número</span>
              <input className="field__input" maxLength={20} placeholder="F001-123" value={form.docNumero} onChange={(e) => setForm({ ...form, docNumero: e.target.value.toUpperCase() })} /></label>
          </div>
          <table className="table table--compacta">
            <thead><tr><th>Insumo</th><th className="t-right">Cantidad</th><th className="t-right">Precio unit.</th><th>Lote</th><th>Vence</th><th className="t-right">Costo prom. actual → nuevo</th><th /></tr></thead>
            <tbody>{form.lineas.map((l, i) => {
              const ins = insumos.find((x) => x.id === l.insumoId);
              const c = Number(l.cantidad), p = Number(l.precio), s = Math.max(ins?.stock ?? 0, 0);
              const nuevoCpp = ins && c > 0 && p > 0 ? (s * ins.cpp + c * p) / (s + c) : null;
              return (
                <tr key={i}>
                  <td><select className="field__input" value={l.insumoId} onChange={(e) => linea(i, { insumoId: e.target.value })}>
                    {insumos.map((x) => <option key={x.id} value={x.id}>{x.nombre} ({x.unidad})</option>)}</select></td>
                  <td><input className="field__input t-right" type="number" min="0" step="0.001" value={l.cantidad} onChange={(e) => linea(i, { cantidad: e.target.value })} /></td>
                  <td><input className="field__input t-right" type="number" min="0" step="0.01" value={l.precio} onChange={(e) => linea(i, { precio: e.target.value })} /></td>
                  <td><input className="field__input" maxLength={40} placeholder="Opcional" value={l.lote} onChange={(e) => linea(i, { lote: e.target.value.toUpperCase() })} /></td>
                  <td><input className="field__input" type="date" min={new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10)} value={l.venceEn} onChange={(e) => linea(i, { venceEn: e.target.value })} /></td>
                  <td className="t-right">{ins ? money(ins.cpp) : '—'}{nuevoCpp !== null && <> → <strong>{money(nuevoCpp)}</strong></>}</td>
                  <td>{form.lineas.length > 1 && <Boton onClick={() => setForm({ ...form, lineas: form.lineas.filter((_, j) => j !== i) })}>Quitar</Boton>}</td>
                </tr>
              );
            })}</tbody>
          </table>
          <div className="form__acciones">
            {!validas && <span className="field__aviso">Cantidad y precio mayores a cero, sin insumos repetidos</span>}
            <Boton icono="plus" onClick={() => setForm({ ...form, lineas: [...form.lineas, { insumoId: insumos.find((x) => !form.lineas.some((l) => l.insumoId === x.id))?.id ?? '', cantidad: '', precio: '', lote: '', venceEn: '' }] })}>Agregar insumo</Boton>
          </div>
        </>)}
      </Dialogo>

      <Dialogo abierto={ver !== null} titulo={`Compra ${ver?.codigo ?? ''}`} descripcion={ver ? `${ver.proveedor} · ${ver.documento} · ${ver.fecha} · ${ver.registradoPor}` : ''}
        onCerrar={() => setVer(null)} acciones={<Boton onClick={() => setVer(null)}>Cerrar</Boton>}>
        {ver && <table className="table table--compacta"><thead><tr><th>Insumo</th><th className="t-right">Cantidad</th><th className="t-right">Precio</th><th className="t-right">Costo prom. antes → después</th></tr></thead>
          <tbody>{ver.items.map((i) => <tr key={i.insumo}><td>{i.insumo}</td><td className="t-right">{num(i.cantidad)} {i.unidad.toLowerCase()}</td><td className="t-right">{money(i.precio)}</td><td className="t-right">{money(i.cppAnterior)} → {money(i.cppNuevo)}</td></tr>)}</tbody></table>}
      </Dialogo>

      <Tarjeta padding="none">
        {!compras.length ? <Vacio titulo="Sin compras registradas" icono="sack" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Código</th><th>Fecha</th><th>Proveedor</th><th>Documento</th><th className="t-right">Insumos</th><th className="t-right">Total</th></tr></thead>
            <tbody>{compras.map((c) => (
              <tr key={c.codigo} className="is-clickable" onClick={() => setVer(c)}>
                <td><strong>{c.codigo}</strong></td><td>{c.fecha}</td><td>{c.proveedor}</td><td>{c.documento}</td>
                <td className="t-right">{c.items.length}</td><td className="t-right">{money(c.total)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
