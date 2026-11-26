/**
 * Colores de la marca en vivo: Configuración → Marca (color principal y de acento) pintan toda la web.
 * app.css deriva de ellos los tonos suaves, el hover y el texto; aquí solo se fija el par base
 * y el color del texto sobre el principal (blanco u oscuro, el que tenga más contraste).
 */
const HEX = /^#[0-9A-Fa-f]{6}$/;

function luminancia(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste WCAG entre dos colores (1 a 21). */
export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Texto legible sobre un fondo: blanco si alcanza AA (4.5), si no el oscuro de la interfaz. */
export function textoSobre(fondo: string): string {
  return contraste(fondo, '#FFFFFF') >= 4.5 ? '#FFFFFF' : '#2A2320';
}

export function aplicarMarca(marca: { colorPrimario?: string; colorAcento?: string; colorTarjeta?: string } | undefined): void {
  const raiz = document.documentElement.style;
  const p = marca?.colorPrimario;
  const a = marca?.colorAcento;
  // Un valor inválido no rompe la pantalla: se queda la paleta por defecto (tokens).
  if (p && HEX.test(p)) {
    raiz.setProperty('--tanta-primario', p);
    raiz.setProperty('--tanta-sobre-primario', textoSobre(p));
  } else {
    raiz.removeProperty('--tanta-primario');
    raiz.removeProperty('--tanta-sobre-primario');
  }
  if (a && HEX.test(a)) raiz.setProperty('--tanta-acento', a);
  else raiz.removeProperty('--tanta-acento');
  const t = marca?.colorTarjeta;
  if (t && HEX.test(t)) raiz.setProperty('--tanta-tarjeta', t);
  else raiz.removeProperty('--tanta-tarjeta');
}
