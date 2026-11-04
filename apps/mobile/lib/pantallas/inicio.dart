import 'dart:async';
import 'acciones.dart';
import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/arranque.dart';
import '../core/cola.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';
import 'operacion.dart';
import 'ventas.dart';
import 'catalogo.dart';
import 'perfil.dart';

/// Contenedor principal: el menú se construye a partir de los permisos que
/// devuelve el servidor. Si un permiso no está, la pestaña no existe.
class Inicio extends StatefulWidget {
  const Inicio({super.key, required this.datos, required this.onSalir, this.version = const EstadoVersion()});
  final Map<String, dynamic> datos;
  final VoidCallback onSalir;
  final EstadoVersion version;

  @override
  State<Inicio> createState() => _InicioState();
}

class _InicioState extends State<Inicio> with WidgetsBindingObserver {
  // Solo para capturas y pruebas: permite abrir una pestaña concreta al arrancar.
  int _indice = int.fromEnvironment('DEMO_TAB', defaultValue: 0);

  Timer? _reloj;
  String? _avisoMostrado;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ColaOffline.instancia.ultimoAviso.addListener(_avisar);

    // Mientras la app está abierta en el mostrador se reintenta cada 20 s.
    // Así el vendedor no tiene que pulsar nada cuando vuelve el WiFi.
    _reloj = Timer.periodic(const Duration(seconds: 20), (_) => _intentarSync());
    _intentarSync();
  }

  @override
  void dispose() {
    _reloj?.cancel();
    ColaOffline.instancia.ultimoAviso.removeListener(_avisar);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState estado) {
    // Volver a primer plano es la mejor señal de que puede haber red otra vez.
    if (estado == AppLifecycleState.resumed) _intentarSync();
  }

  Future<void> _intentarSync() async {
    final cola = ColaOffline.instancia;
    if (cola.ocupada) return;
    await cola.cargar();
    if (!cola.tienePendientes) return;
    await cola.sincronizar(Api.instancia);
  }

  void _avisar() {
    final aviso = ColaOffline.instancia.ultimoAviso.value;
    if (aviso == null || aviso == _avisoMostrado || !mounted) return;
    _avisoMostrado = aviso;
    final fallo = aviso.startsWith('No se pudo aplicar');
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(aviso),
        backgroundColor: fallo ? TantaColors.stateDanger : TantaColors.stateOk,
      ),
    );
    ColaOffline.instancia.ultimoAviso.value = null;
    _avisoMostrado = null;
  }

  List<_Pestana> get _pestanas {
    final api = Api.instancia;
    // Cada pestaña existe solo si el servidor confirmó el permiso.
    return [
      _Pestana('Panel', Icons.home_outlined, Icons.home,
          _PanelInicio(datos: widget.datos, version: widget.version, irA: _irA)),
      if (api.puede('produccion.ver'))
        _Pestana('Producción', Icons.local_fire_department_outlined, Icons.local_fire_department,
            Produccion(datos: widget.datos)),
      if (api.puede('pedidos.ver'))
        _Pestana('Pedidos', Icons.receipt_long_outlined, Icons.receipt_long,
            Pedidos(datos: widget.datos)),
      if (api.puede('cobranza.ver'))
        _Pestana('Cobranza', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet,
            const Cobranza()),
      if (api.puede('inventario.ver'))
        _Pestana('Almacén', Icons.inventory_2_outlined, Icons.inventory_2,
            Almacen(datos: widget.datos)),
      if (api.puede('catalogo.ver'))
        _Pestana('Catálogo', Icons.bakery_dining_outlined, Icons.bakery_dining,
            Catalogo(datos: widget.datos)),
      // Todos los roles: datos, contraseña, privacidad y eliminar cuenta (exigido por las tiendas).
      _Pestana('Perfil', Icons.person_outline, Icons.person, Perfil(onSalir: widget.onSalir)),
    ];
  }

  /// Accesos rápidos del panel: salta a la pestaña por su título.
  void _irA(String titulo) {
    final i = _pestanas.indexWhere((p) => p.titulo == titulo);
    if (i >= 0) setState(() => _indice = i);
  }

  @override
  Widget build(BuildContext context) {
    final pestanas = _pestanas;
    final indice = _indice.clamp(0, pestanas.length - 1);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 20,
        title: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(pestanas[indice].titulo, style: estiloDisplay.copyWith(fontSize: 20)),
                  Text(
                    '${Api.instancia.nombre} · ${Api.instancia.rol}',
                    style: const TextStyle(fontSize: 11, color: TantaColors.textMuted),
                  ),
                ],
              ),
            ),
            Semantics(
              button: true,
              label: 'Mi perfil',
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: () => _irA('Perfil'),
                child: Avatar(nombre: Api.instancia.nombre, fotoUrl: Api.instancia.fotoUrl, radio: 17),
              ),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          const _AvisoCola(),
          Expanded(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              child: KeyedSubtree(key: ValueKey(indice), child: pestanas[indice].vista),
            ),
          ),
        ],
      ),
      bottomNavigationBar: pestanas.length > 1
          ? NavigationBar(
              selectedIndex: indice,
              onDestinationSelected: (i) => setState(() => _indice = i),
              destinations: pestanas
                  .map((p) => NavigationDestination(
                        icon: Icon(p.icono),
                        selectedIcon: Icon(p.iconoActivo),
                        label: p.titulo,
                      ))
                  .toList(),
            )
          : null,
    );
  }
}

class _Pestana {
  _Pestana(this.titulo, this.icono, this.iconoActivo, this.vista);
  final String titulo;
  final IconData icono;
  final IconData iconoActivo;
  final Widget vista;
}

/// Franja que aparece solo cuando hay operaciones sin enviar.
/// Es la diferencia entre "el sistema falló" y "el sistema aguantó".
class _AvisoCola extends StatefulWidget {
  const _AvisoCola();

  @override
  State<_AvisoCola> createState() => _AvisoColaState();
}

class _AvisoColaState extends State<_AvisoCola> {
  @override
  void initState() {
    super.initState();
    // DEMO_COLA solo existe para revisar la franja en capturas; en un build real vale 0.
    const demo = int.fromEnvironment('DEMO_COLA');
    if (demo > 0) {
      () async {
        await ColaOffline.instancia.cargar();
        for (var i = 0; i < demo; i++) {
          await ColaOffline.instancia.encolar(
            'pago',
            {'cxcId': 'demo-$i', 'monto': 10, 'medio': 'EFECTIVO'},
            descripcion: 'Cobro de prueba',
          );
        }
      }();
      return;
    }
    ColaOffline.instancia.cargar().then((_) => ColaOffline.instancia.sincronizar(Api.instancia));
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: ColaOffline.instancia.pendientes,
      builder: (context, n, _) {
        if (n == 0) return const SizedBox.shrink();
        return ValueListenableBuilder<bool>(
          valueListenable: ColaOffline.instancia.sincronizando,
          builder: (context, activo, __) => Material(
            color: TantaColors.stateWarnBg,
            child: InkWell(
              onTap: activo ? null : () => ColaOffline.instancia.sincronizar(Api.instancia),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 9, 12, 9),
                child: Row(
                  children: [
                    const Icon(Icons.cloud_off_outlined, size: 16, color: TantaColors.stateWarn),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        activo
                            ? 'Sincronizando $n ${n == 1 ? 'operación' : 'operaciones'}…'
                            : '$n ${n == 1 ? 'operación guardada' : 'operaciones guardadas'} sin conexión',
                        style: const TextStyle(fontSize: 12, color: TantaColors.stateWarn, fontWeight: FontWeight.w600),
                      ),
                    ),
                    if (activo)
                      const SizedBox(
                        width: 14, height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.stateWarn),
                      )
                    else
                      const Text('Reintentar',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: TantaColors.stateWarn)),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Panel de inicio: se adapta al perfil con los datos que trae el API.
class _PanelInicio extends StatelessWidget {
  const _PanelInicio({required this.datos, required this.version, required this.irA});
  final Map<String, dynamic> datos;
  final EstadoVersion version;
  final ValueChanged<String> irA;

  @override
  Widget build(BuildContext context) {
    final api = Api.instancia;
    final k = (datos['kpis'] as Map<String, dynamic>?) ?? const {};
    final nombre = api.nombre.split(' ').first;
    final hora = DateTime.now().hour;
    final saludo = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
    final accesos = _accesos(context, api);
    final actividad = _actividad(api);

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(color: TantaColors.ink800, borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('$saludo, $nombre', style: estiloDisplay.copyWith(fontSize: 22, color: TantaColors.cream50)),
                const SizedBox(height: 4),
                Text(api.rol, style: TextStyle(fontSize: 12.5, color: TantaColors.cream50.withValues(alpha: 0.75))),
                const SizedBox(height: 10),
                Text('${(datos['periodo'] as Map?)?['etiqueta'] ?? ''}',
                    style: const TextStyle(fontSize: 11.5, color: TantaColors.sand300, fontWeight: FontWeight.w600)),
              ]),
            ),
            Avatar(nombre: api.nombre, fotoUrl: api.fotoUrl, radio: 26),
          ]),
        ),
        if (version.disponible && !version.obligatoria) ...[
          const SizedBox(height: 12),
          Material(
            color: TantaColors.stateInfo.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(12),
            child: ListTile(
              leading: const Icon(Icons.system_update_outlined, color: TantaColors.stateInfo),
              title: const Text('Hay una nueva versión', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              subtitle: Text(version.mensaje, style: const TextStyle(fontSize: 12)),
            ),
          ),
        ],
        const SizedBox(height: 16),
        GridView(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 280,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            mainAxisExtent: 108,
          ),
          children: _kpis(api, datos, k),
        ),
        if (accesos.isNotEmpty) ...[
          const SizedBox(height: 22),
          const TituloSeccion('Accesos rápidos'),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: accesos),
        ],
        if (actividad.length > 1) ...[
          const SizedBox(height: 22),
          TituloSeccion(actividad.first.$1),
          const SizedBox(height: 10),
          Panel(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (final (i, fila) in actividad.skip(1).indexed) ...[
                if (i > 0) const Divider(height: 1),
                ListTile(
                  dense: true,
                  title: Text(fila.$1, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(fila.$2),
                  trailing: Text(fila.$3, style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
              ],
            ]),
          ),
        ],
      ],
    );
  }

  /// Botones a las pestañas que el rol realmente tiene.
  List<Widget> _accesos(BuildContext context, Api api) {
    Widget chip(String titulo, IconData icono) =>
        ActionChip(avatar: Icon(icono, size: 18), label: Text(titulo), onPressed: () => irA(titulo));
    // Registrar: abre la pantalla de la acción; el servidor vuelve a validar el permiso.
    Widget accion(String titulo, IconData icono, Widget pantalla) => ActionChip(
          avatar: Icon(icono, size: 18), label: Text(titulo),
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => pantalla)),
        );
    return [
      if (api.puede('ventas.registrar')) accion('Nueva venta', Icons.point_of_sale_outlined, NuevaVenta(datos: datos)),
      if (api.puede('inventario.mover')) accion('Registrar baja', Icons.remove_shopping_cart_outlined, BajaInventario(datos: datos)),
      if (api.puede('produccion.planificar')) accion('Nueva OP', Icons.add_task_outlined, NuevaOrden(datos: datos)),
      if (api.puede('requisiciones.atender')) accion('Requisiciones', Icons.assignment_turned_in_outlined, const Requisiciones()),
      if (api.puede('inventario.mover') || api.puede('conteo.aprobar')) accion('Conteo físico', Icons.fact_check_outlined, Conteos(datos: datos)),
      if (api.puede('pedidos.crear') && !api.puede('pedidos.gestionar')) accion('Mis pedidos', Icons.receipt_long_outlined, const MisPedidos()),
      if (api.puede('pedidos.crear') && !api.puede('pedidos.gestionar')) accion('Mi estado de cuenta', Icons.account_balance_wallet_outlined, const EstadoCuenta()),
      if (api.puede('pedidos.ver')) chip('Pedidos', Icons.receipt_long_outlined),
      if (api.puede('cobranza.ver')) chip('Cobranza', Icons.account_balance_wallet_outlined),
      if (api.puede('produccion.ver')) chip('Producción', Icons.local_fire_department_outlined),
      if (api.puede('inventario.ver')) chip('Almacén', Icons.inventory_2_outlined),
      if (api.puede('catalogo.ver')) chip('Catálogo', Icons.bakery_dining_outlined),
    ];
  }

  /// Lo más reciente para el rol. El primer elemento es el título de la sección.
  List<(String, String, String)> _actividad(Api api) {
    String txt(dynamic v) => '${v ?? ''}';
    if (api.puede('produccion.ver')) {
      final ops = ((datos['ops'] as List?) ?? const []).where((o) => o['estado'] != 'TERMINADA').take(5);
      return [('Órdenes pendientes', '', ''), for (final o in ops) (txt(o['producto']), '${o['codigo']} · ${o['estado']}', '${o['cantidad']} u')];
    }
    if (api.puede('inventario.ver')) {
      final ins = ((datos['insumos'] as List?) ?? const []).where((i) => i['estado'] == 'BAJO_MINIMO').take(5);
      return [('Insumos por reponer', '', ''), for (final i in ins) (txt(i['nombre']), 'mínimo ${i['minimo']}', '${i['stock']} ${i['unidad']}')];
    }
    if (api.puede('pedidos.ver')) {
      final ps = ((datos['pedidos'] as List?) ?? const []).take(5);
      return [('Pedidos recientes', '', ''), for (final p in ps) (txt(p['cliente']), '${p['codigo']} · ${p['estado']}', dinero(_n(p['total']).toDouble()))];
    }
    if (api.puede('catalogo.ver')) {
      final ps = ((datos['misPedidos'] as List?) ?? const []).take(5);
      return [('Mis últimos pedidos', '', ''), for (final p in ps) (txt(p['codigo']), txt(p['estado']), dinero(_n(p['total']).toDouble()))];
    }
    return const [];
  }

  /// Los indicadores nacen de los permisos: cada perfil ve lo que le sirve.
  List<Widget> _kpis(Api api, Map<String, dynamic> datos, Map<String, dynamic> k) {
    final lista = <Widget>[];

    if (api.puede('costos.ver')) {
      lista.addAll([
        Kpi(etiqueta: 'Ventas netas', valor: dinero(_n(k['ventasNetas'])), nota: 'últimos 30 días'),
        Kpi(etiqueta: 'Utilidad bruta', valor: dinero(_n(k['utilidadBruta'])), nota: 'sobre ventas netas'),
        Kpi(
          etiqueta: 'Margen',
          valor: porcentaje(_n(k['margen'])),
          nota: 'objetivo ${porcentaje(_n(k['margenObjetivo']), 0)}',
          tono: _n(k['margen']) >= _n(k['margenObjetivo']) ? TantaColors.stateOk : TantaColors.stateDanger,
        ),
        Kpi(etiqueta: 'Por cobrar', valor: dinero(_n(k['porCobrar'])), nota: '${dinero(_n(k['vencido']))} vencido'),
      ]);
    }

    if (api.puede('pedidos.ver')) {
      final pedidos = (datos['pedidos'] as List?) ?? const [];
      final abiertos = pedidos.where((p) => !['ENTREGADO', 'CANCELADO'].contains('${p['estado']}')).length;
      lista.add(Kpi(etiqueta: 'Pedidos abiertos', valor: '$abiertos', nota: '${pedidos.length} en el período'));
    }

    if (api.puede('cobranza.ver')) {
      final clientes = (datos['clientes'] as List?) ?? const [];
      final saldo = clientes.fold<double>(0, (s, c) => s + _n(c['saldo']).toDouble());
      final vencido = clientes.fold<double>(0, (s, c) => s + _n(c['vencido']).toDouble());
      lista.add(Kpi(etiqueta: 'Cartera', valor: dinero(saldo), nota: '${dinero(vencido)} vencido',
          tono: vencido > 0 ? TantaColors.stateDanger : null));
    }

    if (api.puede('produccion.ver')) {
      final ops = (datos['ops'] as List?) ?? const [];
      lista.add(Kpi(
        etiqueta: 'Órdenes de hoy',
        valor: '${ops.where((o) => o['estado'] != 'TERMINADA').length}',
        nota: 'pendientes y en proceso',
      ));
    }

    if (api.puede('inventario.ver')) {
      final insumos = (datos['insumos'] as List?) ?? const [];
      lista.add(Kpi(
        etiqueta: 'Insumos críticos',
        valor: '${insumos.where((i) => i['estado'] == 'BAJO_MINIMO').length}',
        nota: 'bajo el mínimo',
      ));
    }

    if (api.puede('catalogo.ver')) {
      lista.add(Kpi(etiqueta: 'Mi saldo', valor: dinero(_n(datos['miSaldo'])), nota: 'cuentas por pagar'));
      lista.add(Kpi(
          etiqueta: 'Mis pedidos',
          valor: '${(datos['misPedidos'] as List?)?.length ?? 0}',
          nota: 'últimos registrados'));
    }

    return lista;
  }

  num _n(dynamic v) => v is num ? v : num.tryParse('$v') ?? 0;

}
