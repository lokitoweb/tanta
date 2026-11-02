import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/layout/AppShell';
import { Gate } from '@/core/app-state';
import { Panel } from '@/modules/panel/Panel';
import { Dashboard } from '@/modules/gerencia/Dashboard';
import { Reportes } from '@/modules/gerencia/Reportes';
import { Productos } from '@/modules/maestros/Productos';
import { Insumos } from '@/modules/maestros/Insumos';
import { Recetas } from '@/modules/maestros/Recetas';
import { Produccion } from '@/modules/produccion/Produccion';
import { Almacen } from '@/modules/almacen/Almacen';
import { Kardex } from '@/modules/almacen/Kardex';
import { Pedidos } from '@/modules/ventas/Pedidos';
import { Cobranza } from '@/modules/ventas/Cobranza';
import { Catalogo } from '@/modules/cliente/Catalogo';
import { Usuarios } from '@/modules/seguridad/Usuarios';
import { Parametros } from '@/modules/seguridad/Parametros';
import { Periodos } from '@/modules/gerencia/Periodos';
import { SinAcceso } from '@/modules/seguridad/SinAcceso';
import { Perfil } from '@/modules/perfil/Perfil';
import { Configuracion } from '@/modules/sistema/Configuracion';
import { Roles } from '@/modules/sistema/Roles';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/panel" replace />} />
        <Route path="/panel" element={<Panel />} />

        <Route path="/gerencia/dashboard" element={<Gate permiso="dashboard.ver" siNo={<SinAcceso />}><Dashboard /></Gate>} />
        <Route path="/gerencia/reportes" element={<Gate permiso="reportes.ver" siNo={<SinAcceso />}><Reportes /></Gate>} />

        <Route path="/maestros/productos" element={<Gate permiso="maestros.ver" siNo={<SinAcceso />}><Productos /></Gate>} />
        <Route path="/maestros/insumos" element={<Gate permiso="maestros.ver" siNo={<SinAcceso />}><Insumos /></Gate>} />
        <Route path="/maestros/recetas" element={<Gate permiso="recetas.ver" siNo={<SinAcceso />}><Recetas /></Gate>} />

        <Route path="/produccion" element={<Gate permiso="produccion.ver" siNo={<SinAcceso />}><Produccion /></Gate>} />
        <Route path="/almacen" element={<Gate permiso="inventario.ver" siNo={<SinAcceso />}><Almacen /></Gate>} />
        <Route path="/almacen/kardex" element={<Gate permiso="inventario.ver" siNo={<SinAcceso />}><Kardex /></Gate>} />

        <Route path="/ventas/pedidos" element={<Gate permiso="pedidos.ver" siNo={<SinAcceso />}><Pedidos /></Gate>} />
        <Route path="/ventas/cobranza" element={<Gate permiso="cobranza.ver" siNo={<SinAcceso />}><Cobranza /></Gate>} />
        <Route path="/catalogo" element={<Gate permiso="catalogo.ver" siNo={<SinAcceso />}><Catalogo /></Gate>} />
        <Route path="/seguridad/usuarios" element={<Gate permiso="usuarios.gestionar" siNo={<SinAcceso />}><Usuarios /></Gate>} />
        <Route path="/seguridad/parametros" element={<Gate permiso="parametros.gestionar" siNo={<SinAcceso />}><Parametros /></Gate>} />
        <Route path="/gerencia/periodos" element={<Gate permiso="periodos.cerrar" siNo={<SinAcceso />}><Periodos /></Gate>} />

        <Route path="/perfil" element={<Perfil />} />
        <Route path="/sistema/roles" element={<Gate permiso="roles.gestionar" siNo={<SinAcceso />}><Roles /></Gate>} />
        <Route path="/sistema/configuracion" element={<Gate permiso="config.gestionar" siNo={<SinAcceso />}><Configuracion /></Gate>} />

        <Route path="*" element={<Navigate to="/panel" replace />} />
      </Route>
    </Routes>
  );
}
