import type { SVGProps } from 'react';

export type NombreIcono =
  | 'home' | 'oven' | 'box' | 'ledger' | 'clipboard' | 'wallet' | 'bread' | 'sack'
  | 'recipe' | 'shield' | 'chart' | 'report' | 'settings' | 'truck' | 'user'
  | 'search' | 'bell' | 'chevron' | 'plus' | 'up' | 'down' | 'check' | 'alert'
  | 'close' | 'filter' | 'download' | 'sync' | 'logout' | 'menu' | 'eye' | 'clock' | 'spark' | 'panel';

const D: Record<NombreIcono, string> = {
  home: 'M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  oven: 'M4 4h16v13H4zM8 20h8M8 9h8M8 12.5h3M13.5 12.5h3',
  box: 'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9',
  ledger: 'M5 3.5h11a3 3 0 0 1 3 3V21H8a3 3 0 0 1-3-3zM5 18.5h14M9 8h6M9 12h6',
  clipboard: 'M9 4h6v3H9zM8 5.5H6.5A1.5 1.5 0 0 0 5 7v13a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 20V7a1.5 1.5 0 0 0-1.5-1.5H16',
  wallet: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h13v3M3.5 7.5v11A2 2 0 0 0 5.5 20.5h13a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-15M16.5 14.5h.01',
  bread: 'M4 10.5C4 7 7.5 4.5 12 4.5s8 2.5 8 6c0 1.6-.9 2.6-2.2 3.1V18a1.5 1.5 0 0 1-1.5 1.5H7.7A1.5 1.5 0 0 1 6.2 18v-4.4C4.9 13.1 4 12.1 4 10.5zM9 9.5c.6-1.2 1.7-1.8 3-1.8',
  sack: 'M9 3.5h6l-.8 3.2c2 1.4 3.3 3.6 3.3 6.1 0 4.1-3.1 7.2-6.5 7.2S4.5 16.9 4.5 12.8c0-2.5 1.3-4.7 3.3-6.1zM9.5 10.5h5',
  recipe: 'M6 3.5h9l3.5 3.5v13.5H6zM15 3.5V7h3.5M9 12h7M9 15.5h7M9 8.5h3',
  shield: 'M12 3.2 19.5 6v6c0 4.4-3.1 7.6-7.5 9-4.4-1.4-7.5-4.6-7.5-9V6zM9.2 12.2l2 2 3.6-3.9',
  chart: 'M4 20V4M4 20h16M8.5 20v-5.5M13 20V9M17.5 20v-8.5',
  report: 'M6 3.5h8.5L19 8v12.5H6zM14.5 3.5V8H19M9.5 12.5h6M9.5 16h6',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13.5a7.7 7.7 0 0 0 0-3l1.8-1.3-1.9-3.3-2.1.9a7.6 7.6 0 0 0-2.6-1.5L14.2 3h-3.8l-.4 2.3a7.6 7.6 0 0 0-2.6 1.5l-2.1-.9L3.4 9.2l1.8 1.3a7.7 7.7 0 0 0 0 3l-1.8 1.3 1.9 3.3 2.1-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.3h3.8l.4-2.3a7.6 7.6 0 0 0 2.6-1.5l2.1.9 1.9-3.3z',
  truck: 'M3.5 6.5h10v9h-10zM13.5 9.5h3.6l3.4 3.2v2.8h-7zM7 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM17.6 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
  user: 'M12 11.5a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6zM4.8 20.5c.6-3.6 3.6-5.6 7.2-5.6s6.6 2 7.2 5.6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16.2 16.2 20.5 20.5',
  bell: 'M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15zM9.8 21a2.3 2.3 0 0 0 4.4 0',
  chevron: 'M9 5.5 15.5 12 9 18.5',
  plus: 'M12 5v14M5 12h14',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  alert: 'M12 4 21 19.5H3zM12 9.5v4.5M12 17h.01',
  close: 'M6 6l12 12M18 6 6 18',
  filter: 'M3.5 5.5h17l-6.5 7.5V20l-4-2v-5z',
  download: 'M12 4v11M7.5 11 12 15.5 16.5 11M4.5 19.5h15',
  sync: 'M20 12a8 8 0 0 1-13.6 5.7M4 12a8 8 0 0 1 13.6-5.7M4 4.5V9h4.5M20 19.5V15h-4.5',
  logout: 'M14.5 4.5H19v15h-4.5M10 8l-4 4 4 4M6 12h9',
  menu: 'M4 7h16M4 12h16M4 17h16',
  panel: 'M4 4.5h16v15H4zM9.5 4.5v15',
  eye: 'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12zM12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5.2l3.4 2',
  spark: 'M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6L4.5 10.8 10.2 9z',
};

interface Props extends SVGProps<SVGSVGElement> { name: NombreIcono; size?: number }

export function Icon({ name, size = 20, ...rest }: Props) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" {...rest}
    >
      <path d={D[name]} />
    </svg>
  );
}
