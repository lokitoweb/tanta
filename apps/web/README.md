# Tanta App Web

Interfaz de administración del Sistema Integral de Gestión. React 19 + Vite 6 + TypeScript.
Diseño derivado de la tarjeta de presentación de la panadería (crema + marrón tinta).

## Cómo se ejecuta

```bash
# desde la raíz del repositorio
pnpm install
pnpm dev          # compila tokens y arranca la web en http://127.0.0.1:5180
```

Primer arranque (instalación completa):

```bash
pnpm install      # dependencias
pnpm tokens       # genera packages/tokens/dist/{tokens.css,tokens.dart}
pnpm dev
```

> **Nota sobre pnpm:** este proyecto usa `nodeLinker: hoisted` (ver `pnpm-workspace.yaml`).
> Con enlaces simbólicos, OneDrive rompe parte del árbol de dependencias en Windows.

## Perfiles de prueba

En desarrollo se puede abrir una sesión con cualquier rol agregando `?perfil=` a la URL.
En producción el rol **siempre** lo determina el servidor.

| Perfil | URL | Ve |
|---|---|---|
| Gerente | `/gerencia/dashboard?perfil=GERENTE` | Costos, márgenes, dashboard, reportes |
| Administrador | `/maestros/productos?perfil=ADMINISTRADOR` | Maestros, recetas, usuarios |
| Producción | `/produccion?perfil=PRODUCCION` | Tablero de órdenes, kárdex (sin costos) |
| Almacén | `/almacen?perfil=ALMACEN` | Stock, movimientos (sin costos) |
| Vendedor | `/ventas/cobranza?perfil=VENDEDOR` | Pedidos, cartera, cobranza |
| Cliente | `/catalogo?perfil=CLIENTE` | Catálogo y pedido |
| Soporte | `/panel?perfil=SOPORTE` | Nada de negocio (break-glass) |

## Principio: nada duro en el código

| Qué | Dónde vive | Se reemplaza por |
|---|---|---|
| Roles y permisos | `src/config/roles.json` | `GET /api/v1/config/sesion` |
| Menú y rutas | `src/config/navegacion.json` | `GET /api/v1/config/menu` |
| Catálogo de reportes | `src/config/reportes.json` | `GET /api/v1/reportes` |
| Parámetros de negocio | `src/data/dataset.json` → `negocio` | `GET /api/v1/parametros` |
| Colores, tipografía, radios | `packages/tokens/tokens.json` | — (fuente única, se compila a CSS y a Dart) |

El menú **no** se escribe en los componentes: se genera filtrando `navegacion.json` por los permisos
del rol activo. Si un permiso no está, la sección no existe para ese perfil.

## Seguridad de campo (field-level)

Las columnas de costo y margen declaran `permiso: 'costos.ver'`. Si el rol no lo tiene, la columna
**no se renderiza** — no se oculta con CSS, no se envía al cliente. Así el vendedor nunca ve el margen.

## Estructura

```
src/
├─ config/      roles · navegación · reportes  (datos, no código)
├─ core/        estado de sesión · formato de dinero y fechas · tipos
├─ ui/          botones, tarjetas, tablas, gráficos SVG propios, iconos
├─ layout/      AppShell (sidebar + topbar)
├─ modules/     una carpeta por área de negocio
└─ styles/      app.css (sistema de diseño completo)
```

Los gráficos son SVG propios (sin librería): control total del trazo, del color y del número de
decimales. Un gráfico de dinero mal formateado cuesta más credibilidad que un gráfico ausente.
