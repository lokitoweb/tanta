import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/layout/AppShell';
import { Gate } from '@/core/app-state';
import { Panel } from '@/modules/panel/Panel';
import { Dashboard } from '@/modules/gerencia/Dashboard';
import { Reportes } from '@/modules/gerencia/Reportes';
import { AnalisisPrecios, Almacenes, Categorias, Clientes, CostosIndirectos, Insumos, Productos, Proveedores } from '@/modules/maestros/Maestros';
import { Compras } from '@/modules/almacen/Compras';
import { Conteos } from '@/modules/almacen/Conteos';
import { Deudas } from '@/modules/almacen/Deudas';
import { PagosCostos } from '@/modules/almacen/PagosCostos';
import { Catalogos } from '@/modules/maestros/Catalogos';
import { CajaChica } from '@/modules/ventas/CajaChica';
import { CajaGrande } from '@/modules/ventas/CajaGrande';
import { Auditoria } from '@/modules/sistema/Auditoria';
import { Recetas } from '@/modules/maestros/Recetas';
import { Produccion } from '@/modules/produccion/Produccion';
import { Almacen } from '@/modules/almacen/Almacen';
import { Kardex } from '@/modules/almacen/Kardex';
import { Requisiciones } from '@/modules/almacen/Requisiciones';
import { Pedidos } from '@/modules/ventas/Pedidos';
import { Cobranza } from '@/modules/ventas/Cobranza';
import { Aprobaciones } from '@/modules/ventas/Aprobaciones';
import { AvisosClientes } from '@/modules/ventas/AvisosClientes';
import { Despacho } from '@/modules/ventas/Despacho';
import { Gastos } from '@/modules/ventas/Gastos';
import { Promociones } from '@/modules/ventas/Promociones';
import { HojaProduccion } from '@/modules/produccion/HojaProduccion';
import { PuntoEquilibrio } from '@/modules/gerencia/PuntoEquilibrio';
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
        <Route path="/almacen/requisiciones" element={<Gate permiso="requisiciones.atender" siNo={<SinAcceso />}><Requisiciones /></Gate>} />
        <Route path="/almacen/kardex" element={<Gate permiso="inventario.ver" siNo={<SinAcceso />}><Kardex /></Gate>} />
        <Route path="/almacen/compras" element={<Gate permiso="compras.ver" siNo={<SinAcceso />}><Compras /></Gate>} />
        <Route path="/compras/deudas" element={<Gate permiso="deudas.ver" siNo={<SinAcceso />}><Deudas /></Gate>} />
        <Route path="/compras/pagos-costos" element={<Gate permiso="compras.pagar" siNo={<SinAcceso />}><PagosCostos /></Gate>} />
        <Route path="/caja" element={<Gate permiso="caja.abrir" siNo={<SinAcceso />}><CajaChica /></Gate>} />
        <Route path="/caja-grande" element={<Gate permiso="caja.grande.ver" siNo={<SinAcceso />}><CajaGrande /></Gate>} />
        <Route path="/almacen/conteos" element={<Gate permiso="inventario.ver" siNo={<SinAcceso />}><Conteos /></Gate>} />
        <Route path="/maestros/catalogos" element={<Gate permiso="maestros.editar" siNo={<SinAcceso />}><Catalogos /></Gate>} />
        <Route path="/maestros/almacenes" element={<Gate permiso="maestros.editar" siNo={<SinAcceso />}><Almacenes /></Gate>} />
        <Route path="/maestros/proveedores" element={<Gate permiso="proveedores.gestionar" siNo={<SinAcceso />}><Proveedores /></Gate>} />

        <Route path="/ventas/pedidos" element={<Gate permiso="pedidos.ver" siNo={<SinAcceso />}><Pedidos /></Gate>} />
        <Route path="/ventas/cobranza" element={<Gate permiso="cobranza.ver" siNo={<SinAcceso />}><Cobranza /></Gate>} />
        <Route path="/ventas/aprobaciones" element={<Gate permiso="descuentos.aprobar" siNo={<SinAcceso />}><Aprobaciones /></Gate>} />
        <Route path="/ventas/despacho" element={<Gate permiso="despacho.ver" siNo={<SinAcceso />}><Despacho /></Gate>} />
        <Route path="/ventas/gastos" element={<Gate permiso="gastos.registrar" siNo={<SinAcceso />}><Gastos /></Gate>} />
        <Route path="/ventas/promociones" element={<Gate permiso="promociones.gestionar" siNo={<SinAcceso />}><Promociones /></Gate>} />
        <Route path="/produccion/hoja" element={<Gate permiso="produccion.ver" siNo={<SinAcceso />}><HojaProduccion /></Gate>} />
        <Route path="/gerencia/punto-equilibrio" element={<Gate permiso="costos.ver" siNo={<SinAcceso />}><PuntoEquilibrio /></Gate>} />
        <Route path="/ventas/avisos" element={<Gate permiso="clientes.avisar" siNo={<SinAcceso />}><AvisosClientes /></Gate>} />
        <Route path="/catalogo" element={<Gate permiso="catalogo.ver" siNo={<SinAcceso />}><Catalogo /></Gate>} />
        <Route path="/seguridad/usuarios" element={<Gate permiso="usuarios.ver" siNo={<SinAcceso />}><Usuarios /></Gate>} />
        <Route path="/seguridad/parametros" element={<Gate permiso="parametros.gestionar" siNo={<SinAcceso />}><Parametros /></Gate>} />
        <Route path="/gerencia/periodos" element={<Gate permiso="periodos.cerrar" siNo={<SinAcceso />}><Periodos /></Gate>} />
        <Route path="/gerencia/analisis-precios" element={<Gate permiso="costos.ver" siNo={<SinAcceso />}><AnalisisPrecios /></Gate>} />

        <Route path="/maestros/categorias" element={<Gate permiso="maestros.editar" siNo={<SinAcceso />}><Categorias /></Gate>} />
        <Route path="/maestros/clientes" element={<Gate permiso="clientes.gestionar" siNo={<SinAcceso />}><Clientes /></Gate>} />
        <Route path="/maestros/cif" element={<Gate permiso="maestros.editar" siNo={<SinAcceso />}><CostosIndirectos /></Gate>} />
        <Route path="/sistema/auditoria" element={<Gate permiso="auditoria.ver" siNo={<SinAcceso />}><Auditoria /></Gate>} />
        <Route path="/perfil" element={<Perfil />} />
        <Route path="/sistema/roles" element={<Gate permiso="roles.gestionar" siNo={<SinAcceso />}><Roles /></Gate>} />
        <Route path="/sistema/configuracion" element={<Gate permiso="config.gestionar" siNo={<SinAcceso />}><Configuracion /></Gate>} />

        <Route path="*" element={<Navigate to="/panel" replace />} />
      </Route>
    </Routes>
  );
}
