import { useState } from 'react';
import { useApp } from '@/core/app-state';
import { cantidad, money, num2, partesQueSuman, pct, semaforo } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta, TarjetaTitulo } from '@/ui/primitives';

export function Recetas() {
  const { dataset, puede } = useApp();
  const [sel, setSel] = useState(dataset.recetas[1]?.id ?? dataset.recetas[0]?.id);
  const receta = dataset.recetas.find((r) => r.id === sel) ?? dataset.recetas[0];
  const verCosto = puede('costos.ver');

  // Si el rol no ve costos, el API no los envía: aquí no hay nada que calcular.
  const [insumos, merma] = verCosto
    ? partesQueSuman(
        [
          receta.costoInsumos ?? 0,
          (receta.costoConMerma ?? 0) - (receta.costoInsumos ?? 0),
          receta.cifUnit ?? 0,
        ],
        receta.costoUnitario ?? 0,
      )
    : [0, 0];
  const cif = verCosto ? Math.round(((receta.costoUnitario ?? 0) - insumos - merma) * 100) / 100 : 0;

  if (!receta) {
    return (
      <>
        <Encabezado titulo="Recetas" descripcion="Sin recetas registradas" />
        <Tarjeta><p className="t-muted">Todavía no hay recetas cargadas en el sistema.</p></Tarjeta>
      </>
    );
  }

  return (
    <>
      <Encabezado
        titulo="Recetas"
        descripcion="Cada versión queda congelada: cambiar una receta crea una versión nueva, no reescribe la historia"
        acciones={<Boton variant="primary" icono="plus">Nueva versión</Boton>}
      />

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
                  Rinde {receta.rendimiento} unidades · merma estándar {pct(receta.mermaEstandar)} · estado{' '}
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
                    <th className="t-right">Cantidad por unidad</th>
                    {verCosto && <th className="t-right">CPP</th>}
                    {verCosto && <th className="t-right">Costo</th>}
                  </tr>
                </thead>
                <tbody>
                  {receta.lineas.map((l) => (
                    <tr key={l.insumoId}>
                      <td><strong>{l.insumo}</strong></td>
                      <td className="t-right">{cantidad(l.cantidad, l.unidad)}</td>
                      {verCosto && <td className="t-right t-muted">{money(l.cpp ?? 0)}</td>}
                      {verCosto && <td className="t-right">{money(l.costo ?? 0)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Tarjeta>

          {verCosto ? (
            <Tarjeta>
              <TarjetaTitulo
                titulo="Cómo se forma el costo"
                subtitulo="La merma se divide, no se suma: el rendimiento se pierde, no se recarga"
              />
              <ol className="cascada">
                <li>
                  <span>Insumos directos</span>
                  <b>{money(insumos)}</b>
                </li>
                <li>
                  <span>
                    + Merma estándar {pct(receta.mermaEstandar)}{' '}
                    <em>(÷ {num2(1 - receta.mermaEstandar)})</em>
                  </span>
                  <b>{money(merma)}</b>
                </li>
                <li>
                  <span>+ Costos indirectos prorrateados</span>
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
