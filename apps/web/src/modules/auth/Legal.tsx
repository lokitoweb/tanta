import { useEffect, useState } from 'react';
import { urlApi } from '@/core/api';

/** Página pública (sin sesión) de privacidad o términos: el enlace que piden Google Play y App Store. */
export function Legal({ doc }: { doc: 'privacidad' | 'terminos' }) {
  const [d, setD] = useState<{ titulo: string; texto: string; negocio: string } | null>(null);
  useEffect(() => {
    fetch(urlApi(`/legal/${doc}`)).then((r) => r.json()).then((x) => { setD(x); document.title = `${x.titulo} · ${x.negocio}`; }).catch(() => {});
  }, [doc]);
  if (!d) return <div className="tabla-cargando">Cargando…</div>;
  return (
    <main className="legal">
      <p className="legal__marca">{d.negocio}</p>
      <h1>{d.titulo}</h1>
      {d.texto.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
    </main>
  );
}
