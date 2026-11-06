import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  valor: number | '';
  onValor: (n: number | '') => void;
};

/**
 * Campo numérico que respeta lo que se escribe. Si el estado guarda un número y el campo muestra
 * String(número), al escribir «0.0» (camino a «0.03») o «12.» el número es 0 o 12 y el campo se
 * reescribe: el cero o el punto desaparecen. Aquí el texto es local y solo se reemplaza cuando el
 * número cambia desde afuera (un cálculo, otro campo, abrir otro registro).
 */
export function InputNumero({ valor, onValor, ...resto }: Props) {
  const [texto, setTexto] = useState(valor === '' ? '' : String(valor));
  useEffect(() => {
    const actual = texto === '' ? '' : Number(texto);
    if (actual !== valor) setTexto(valor === '' ? '' : String(valor));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando cambia el número de afuera
  }, [valor]);
  return (
    <input {...resto} type="number" inputMode="decimal" value={texto}
      onChange={(e) => { setTexto(e.target.value); onValor(e.target.value === '' ? '' : Number(e.target.value)); }} />
  );
}
