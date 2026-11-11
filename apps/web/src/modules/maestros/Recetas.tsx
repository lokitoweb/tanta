import { useState } from 'react';
import { useApp } from '@/core/app-state';
import { cant, cantidad, money, num2, partesQueSuman, pct, semaforo } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta, TarjetaTitulo } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import type { Receta } from '@/core/types';
import { EditorReceta } from './EditorReceta';

export function Recetas() {
  const { dataset, puede } = useApp();
  const [sel, setSel] = useState(dataset.recetas[1]?.id ?? dataset.recetas[0]?.id);
  const receta = dataset.recetas.find((r) => r.id === sel) ?? dataset.recetas[0];
  const verCosto = puede('costos.ver');
  const [editando, setEditando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Primera receta de un producto: se elige el producto y se abre el mismo editor (versión 1).
  const [eligiendo, setEligiendo] = useState(false);
  const [nueva, setNueva] = useState<Receta | null>(null);
  const sinReceta = dataset.productos.filter((p) => p.estado === 'ACTIVO' && !dataset.recetas.some((r) => r.productoId === p.id));
  const editar = puede('recetas.editar');
  const cerrarEditor = (r?: string) => { setEditando(false); setNueva(null); if (r) setAviso(r); };

  const encabezado = (descripcion: string, conVersion: boolean) => (
    <>
      <Encabezado titulo="Recetas" descripcion={descripcion}
        acciones={editar && <>
          {sinReceta.length > 0 && <Boton variant={conVersion ? 'secondary' : 'primary'} icono="plus" onClick={() => { setAviso(null); setEligiendo(true); }}>Nueva receta</Boton>}
          {conVersion && <Boton variant="primary" icono="plus" onClick={() => { setAviso(null); setEditando(true); }}>Nueva versión</Boton>}
        </>} />
      {aviso && <div className="aviso aviso--ok" role="status"><span className="aviso__icono">✓</span><div><p>{aviso}</p></div></div>}
      <Dialogo abierto={eligiendo} titulo="Nueva receta" descripcion="Elige el producto que todavía no tiene receta." onCerrar={() => setEligiendo(false)}
        acciones={<Boton onClick={() => setEligiendo(false)}>Cancelar</Boton>}>
        <ul className="recetas">{sinReceta.map((p) => (
          <li key={p.id}><button className="recetas__item" onClick={() => {
            setEligiendo(false);
            setNueva({ id: p.id, productoId: p.id, producto: p.nombre, version: 0, estado: 'BORRADOR', rendimiento: 1, mermaEstandar: p.mermaPct ?? 0, lineas: [] });
          }}><span className="recetas__nom">{p.nombre}</span><span className="recetas__meta">{p.codigo}{p.insumoId ? ' · sub-receta' : ''}</span></button></li>))}</ul>
      </Dialogo>
      {nueva && <EditorReceta receta={nueva} onCerrar={cerrarEditor} />}
    </>
  );

  // Sin recetas (sistema nuevo o recién limpiado): se explica y se ofrece crear la primera.
  if (!receta) {
    return (
      <>
        {encabezado('Sin recetas registradas', false)}
        <Tarjeta><p className="t-muted">{editar && sinReceta.length ? 'Todavía no hay recetas: usa «Nueva receta» para registrar la primera.' : 'Todavía no hay recetas cargadas en el sistema.'}</p></Tarjeta>
      </>
    );
  }

  // Si el rol no ve costos, el API no los envía: aquí no hay nada que calcular.
  // RN-15: costo total = insumos por unidad esperada + mano de obra + CIF (redondeados para que sumen).
  const r2 = receta as typeof receta & { moUnit?: number; masaLoteKg?: number; unidadesEsperadas?: number };
  const [insumos, mo] = verCosto
    ? partesQueSuman([receta.costoConMerma ?? 0, r2.moUnit ?? 0, receta.cifUnit ?? 0], receta.costoUnitario ?? 0)
    : [0, 0];
  const cif = verCosto ? Math.round(((receta.costoUnitario ?? 0) - insumos - mo) * 100) / 100 : 0;

  return (
    <>
      {encabezado('Cada versión queda congelada: cambiar una receta crea una versión nueva, no reescribe la historia', true)}
      {editando && <EditorReceta receta={receta} onCerrar={cerrarEditor} />}

      <div className="split">
        <Tarjeta padding="none" className="split__lista">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Productos con receta</h3>
              <p className="card__sub">{dataset.recetas.length} recetas vigentes</p>
            </div>
          </div>
          <ul className="recetas">
            {dataset.recetas.map((r) => (
              <li key={r.id}>
                <button
                  className={`recetas__item ${r.id === receta.id ? 'is-active' : ''}`}
                  onClick={() => setSel(r.id)}
                >
                  <span className="recetas__nom">{r.producto}</span>
                  <span className="recetas__meta">
                    v{r.version} · {r.rendimiento} u
                    {verCosto && <> · <b>{pct(r.margen ?? 0)}</b></>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Tarjeta>

        <div className="split__detalle">
          <Tarjeta>
            <header className="receta-head">
              <div>
                <p className="receta-head__eyebrow">Receta vigente · versión {receta.version}</p>
                <h2 className="receta-head__title">{receta.producto}</h2>
                <p className="receta-head__sub">
                  Masa del lote {num2(r2.masaLoteKg ?? 0)} kg · {num2(r2.unidadesEsperadas ?? receta.rendimiento)} unidades esperadas · merma {pct(receta.mermaEstandar)} · estado{' '}
                  <Insignia tono="ok" punto>Vigente</Insignia>
                </p>
              </div>
              {verCosto && (
                <div className="receta-head__precio">
                  <span>Costo unitario</span>
                  <b>{money(receta.costoUnitario ?? 0)}</b>
                  <Insignia tono={semaforo(receta.margen ?? 0, 0.5) === 'ok' ? 'ok' : 'warn'}>
                    {pct(receta.margen ?? 0)} margen
                  </Insignia>
                </div>
              )}
            </header>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="t-right">Cantidad por lote</th>
                    <th className="t-right">Peso (kg)</th>
                    <th className="t-right">% panadero</th>
                    {verCosto && <th className="t-right">CPP</th>}
                    {verCosto && <th className="t-right">Costo</th>}
                  </tr>
                </thead>
                <tbody>
                  {receta.lineas.map((l) => (
                    <tr key={l.insumoId}>
                      <td><strong>{l.insumo}</strong></td>
                      <td className="t-right">{cantidad(l.cantidad, l.unidad)}</td>
                      <td className="t-right">{l.sumaPeso === false ? <span className="t-muted" title="Su tipo de insumo no suma al peso de la masa">no suma</span> : cant(l.pesoKg ?? 0)}</td>
                      <td className="t-right t-muted">{l.pctPanadero != null ? pct(l.pctPanadero) : '—'}</td>
                      {verCosto && <td className="t-right t-muted">{money(l.cpp ?? 0)}</td>}
                      {verCosto && <td className="t-right">{money(l.costo ?? 0)}</td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td><strong>Totales</strong></td>
                    <td />
                    <td className="t-right"><strong>{cant(receta.lineas.reduce((a, l) => a + (l.pesoKg ?? 0), 0))}</strong></td>
                    <td className="t-right"><strong>{pct(receta.lineas.reduce((a, l) => a + (l.pctPanadero ?? 0), 0))}</strong></td>
                    {verCosto && <td />}
                    {verCosto && <td className="t-right"><strong>{money(receta.lineas.reduce((a, l) => a + (l.costo ?? 0), 0))}</strong></td>}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Tarjeta>

          {verCosto ? (
            <Tarjeta>
              <TarjetaTitulo
                titulo="Cómo se forma el costo"
                subtitulo="Modelo del informe técnico: unidades esperadas = masa ÷ peso × (1 − merma)"
              />
              <ol className="cascada">
                <li>
                  <span>Insumos por unidad esperada <em>(lote ÷ unidades esperadas)</em></span>
                  <b>{money(insumos)}</b>
                </li>
                <li>
                  <span>+ Mano de obra <em>(horas hombre × costo hora ÷ unidades)</em></span>
                  <b>{money(mo)}</b>
                </li>
                <li>
                  <span>+ Costos indirectos <em>(costos del mes ÷ horas de horno del mes × horas de horno del lote ÷ unidades)</em></span>
                  <b>{money(cif)}</b>
                </li>
                <li className="cascada__total">
                  <span>Costo total unitario</span>
                  <b>{money(receta.costoUnitario ?? 0)}</b>
                </li>
              </ol>
            </Tarjeta>
          ) : (
            <Tarjeta>
              <TarjetaTitulo
                titulo="Costo protegido"
                subtitulo="Tu perfil puede ver la receta, pero no el costo ni el margen"
              />
              <p className="t-muted">
                La separación entre «receta» y «costo» es deliberada: Producción y Almacén necesitan las
                cantidades, no la estructura de precios de la panadería. El servidor no envía estos campos
                a tu rol.
              </p>
            </Tarjeta>
          )}
        </div>
      </div>
    </>
  );
}
