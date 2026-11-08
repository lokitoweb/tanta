import 'dart:async';
import 'acciones.dart';
import 'avisos_clientes.dart';
import 'despacho.dart';
import 'gastos.dart';
import 'hoja_produccion.dart';
import 'promociones.dart';
import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/arranque.dart';
import '../core/cola.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';
import 'operacion.dart';
import 'ventas.dart';
import 'catalogo.dart';
import 'perfil.dart';
import 'notificaciones.dart';
import 'actualizar.dart';

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
  Timer? _espera;
  String? _avisoMostrado;
  late Map<String, dynamic> _datos = widget.datos;
  late EstadoVersion _version = widget.version;
  DateTime _ultimaRevision = DateTime.now();
  String? _versionAvisada;

  /// Al volver a la app (máx. 1 vez por minuto): ¿salió una versión nueva? También renueva el token push.
  Future<void> _revisarVersion() async {
    if (DateTime.now().difference(_ultimaRevision) < const Duration(minutes: 1)) return;
    _ultimaRevision = DateTime.now();
    final v = await arrancarSesion();
    if (!mounted) return;
    setState(() => _version = v);
    _avisarVersion();
  }

  /// Ventana «Hay una nueva versión» una vez por versión; si es obligatoria, no deja seguir.
  void _avisarVersion() {
    final v = _version;
    if (!mounted) return;
    if (v.obligatoria) {
      Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => ActualizacionObligatoria(estado: v)), (_) => false);
      return;
    }
    if (!v.disponible || _versionAvisada == v.url) return;
    _versionAvisada = v.url;
    showDialog<void>(context: context, builder: (ctx) => AlertDialog(
      icon: const Icon(Icons.system_update_outlined, color: TantaColors.ink800),
      title: const Text('Nueva versión disponible'),
      content: Text(v.mensaje.isEmpty ? 'Actualiza Tanta para tener las últimas mejoras.' : v.mensaje),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Más tarde')),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
          onPressed: () { Navigator.pop(ctx); abrirActualizacion(v.url); },
          child: const Text('Actualizar'),
        ),
      ],
    ));
  }

  /// Notificación que llega con la app abierta: se muestra arriba como aviso y se recargan los datos.
  void _alPush() {
    final m = avisoPush.value;
    if (m == null || !mounted) return;
    avisoPush.value = null;
    final n = m.notification;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text([n?.title, n?.body].whereType<String>().where((t) => t.isNotEmpty).join('\n')),
      duration: const Duration(seconds: 5),
    ));
    _alCambiar();
  }

  /// Vuelve a pedir el resumen (KPIs, últimos pedidos…). Sin red se queda con lo que tenía.
  Future<void> _recargar() async {
    try {
      final d = await Api.instancia.datos();
      if (mounted) setState(() => _datos = d);
    } catch (_) {}
  }

  // Varios cambios seguidos (pedido + su pago) = una sola recarga.
  void _alCambiar() {
    _espera?.cancel();
    _espera = Timer(const Duration(milliseconds: 400), _recargar);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ColaOffline.instancia.ultimoAviso.addListener(_avisar);
    Api.instancia.cambios.addListener(_alCambiar);
    avisoPush.addListener(_alPush);
    WidgetsBinding.instance.addPostFrameCallback((_) => _avisarVersion());

    // Mientras la app está abierta en el mostrador se reintenta cada 20 s.
    // Así el vendedor no tiene que pulsar nada cuando vuelve el WiFi.
    _reloj = Timer.periodic(const Duration(seconds: 20), (_) => _intentarSync());
    _intentarSync();
  }

  @override
  void dispose() {
    _reloj?.cancel();
    _espera?.cancel();
    Api.instancia.cambios.removeListener(_alCambiar);
    avisoPush.removeListener(_alPush);
    ColaOffline.instancia.ultimoAviso.removeListener(_avisar);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState estado) {
    // Volver a primer plano es la mejor señal de que puede haber red otra vez.
    if (estado == AppLifecycleState.resumed) {
      _intentarSync();
      _recargar(); // lo que cambió en otro equipo (pedido confirmado, pago registrado)
      _revisarVersion();
    }
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
          _PanelInicio(datos: _datos, version: _version, irA: _irA, onRecargar: _recargar)),
      if (api.puede('produccion.ver'))
        _Pestana('Producción', Icons.local_fire_department_outlined, Icons.local_fire_department,
            Produccion(datos: _datos)),
      if (api.puede('pedidos.ver'))
        _Pestana('Pedidos', Icons.receipt_long_outlined, Icons.receipt_long,
            Pedidos(datos: _datos)),
      if (api.puede('despacho.ver'))
        _Pestana('Despacho', Icons.local_shipping_outlined, Icons.local_shipping, const Despacho()),
      if (api.puede('cobranza.ver'))
        _Pestana('Cobranza', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet,
            const Cobranza()),
      if (trabajaAlmacen(api))
        _Pestana('Almacén', Icons.inventory_2_outlined, Icons.inventory_2,
            Almacen(datos: _datos)),
      if (esTienda(api, _datos))
        _Pestana('Catálogo', Icons.bakery_dining_outlined, Icons.bakery_dining,
            Catalogo(datos: _datos)),
      // Todos los roles: datos, contraseña, privacidad y eliminar cuenta (exigido por las tiendas).
      _Pestana('Perfil', Icons.person_outline, Icons.person, Perfil(onSalir: widget.onSalir)),
    ];
  }

  /// Un aviso abre su pantalla: la pestaña o la acción relacionada (A11).
  void _abrirRuta(String ruta) {
    final api = Api.instancia;
    Widget? pantalla;
    if (ruta.startsWith('/pedidos/') && api.puede('pedidos.crear') && !api.puede('pedidos.gestionar')) pantalla = MisPedidos(productos: _productos);
    if (ruta.startsWith('/almacen/requisiciones')) pantalla = const Requisiciones();
    if (ruta.startsWith('/almacen/compras') && api.puede('compras.verificar')) pantalla = const VerificarCompras();
    if (ruta.startsWith('/almacen/conteos')) pantalla = Conteos(datos: _datos);
    if (pantalla != null) { Navigator.push(context, MaterialPageRoute(builder: (_) => pantalla!)); return; }
    if (ruta.startsWith('/catalogo')) _irA('Catálogo');
    if (ruta.startsWith('/ventas/pedidos')) _irA('Pedidos');
    if (ruta.startsWith('/almacen')) _irA('Almacén');
    if (ruta.startsWith('/ventas/cobranza')) _irA('Cobranza');
  }

  List<Map<String, dynamic>> get _productos => (_datos['productos'] as List? ?? const []).cast<Map<String, dynamic>>();

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
            Campana(onAbrir: _abrirRuta),
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
    cargarCatalogos();
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
  const _PanelInicio({required this.datos, required this.version, required this.irA, required this.onRecargar});
  final Map<String, dynamic> datos;
  final EstadoVersion version;
  final ValueChanged<String> irA;
  final Future<void> Function() onRecargar;

  @override
  Widget build(BuildContext context) {
    final api = Api.instancia;
    final k = (datos['kpis'] as Map<String, dynamic>?) ?? const {};
    final nombre = api.nombre.split(' ').first;
    final hora = DateTime.now().hour;
    final saludo = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
    final accesos = _accesos(context, api);
    final actividad = _actividad(api);

    var orden = 0; // entrada escalonada de las secciones
    Widget entra(Widget w) => Aparecer(orden: orden++, child: w);
    return RefreshIndicator(
      color: TantaColors.ink800,
      onRefresh: onRecargar,
      child: ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        entra(Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
                colors: [TantaColors.ink800, TantaColors.ink900]),
            borderRadius: BorderRadius.circular(8),
            boxShadow: [BoxShadow(color: TantaColors.ink900.withValues(alpha: 0.18), blurRadius: 18, offset: const Offset(0, 8))],
          ),
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
        )),
        if (version.disponible && !version.obligatoria) ...[
          const SizedBox(height: 12),
          Material(
            color: TantaColors.stateInfo.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(8),
            child: ListTile(
              leading: const Icon(Icons.system_update_outlined, color: TantaColors.stateInfo),
              title: const Text('Hay una nueva versión', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              subtitle: Text(version.mensaje, style: const TextStyle(fontSize: 12)),
              trailing: TextButton(onPressed: () => abrirActualizacion(version.url), child: const Text('Actualizar')),
            ),
          ),
        ],
        const SizedBox(height: 16),
        entra(LayoutBuilder(builder: (_, c) {
          // Columnas de hasta 280 px; la última fila, si queda incompleta, reparte todo el ancho.
          final kpis = _kpis(context, api, datos, k);
          const sep = 12.0;
          final cols = ((c.maxWidth + sep) / (280 + sep)).ceil().clamp(1, 6);
          final resto = kpis.length % cols;
          double ancho(int i) {
            final n = resto != 0 && i >= kpis.length - resto ? resto : cols;
            return ((c.maxWidth - sep * (n - 1)) / n).floorToDouble(); // sin redondeo que haga saltar de fila
          }
          return Wrap(spacing: sep, runSpacing: sep, children: [
            for (var i = 0; i < kpis.length; i++) SizedBox(width: ancho(i), height: 108, child: kpis[i]),
          ]);
        })),
        if (accesos.isNotEmpty) ...[
          const SizedBox(height: 22),
          entra(const TituloSeccion('Accesos rápidos')),
          const SizedBox(height: 10),
          // Una sola fila horizontal (Android e iOS): se desliza si no caben.
          entra(SizedBox(
            height: 40,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: accesos.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (_, i) => accesos[i],
            ),
          )),
        ],
        if (actividad.length > 1) ...[
          const SizedBox(height: 22),
          entra(TituloSeccion(actividad.first.titulo)),
          const SizedBox(height: 10),
          entra(Panel(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (final (i, fila) in actividad.skip(1).indexed) ...[
                if (i > 0) const Divider(height: 1, indent: 16, endIndent: 16),
                ListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                  onTap: fila.abrir == null ? null : () => Navigator.push(context, MaterialPageRoute(builder: (_) => fila.abrir!)),
                  title: Text(fila.titulo, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                  subtitle: Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Align(alignment: Alignment.centerLeft, child: fila.estado.isEmpty
                        ? Text(fila.detalle, style: const TextStyle(fontSize: 12.5))
                        : Insignia(etiquetaPedido[fila.estado] ?? fila.estado, tono: tonoPedido(fila.estado), punto: true)),
                  ),
                  trailing: Text(fila.valor, style: estiloDisplay.copyWith(fontSize: 15)),
                ),
              ],
            ]),
          )),
        ],
      ],
    ));
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
      if (api.puede('compras.registrar')) accion('Registrar compra', Icons.local_shipping_outlined, NuevaCompra(datos: datos)),
      if (api.puede('caja.abrir')) accion('Caja chica', Icons.point_of_sale_outlined, const CajaChica()),
      if (api.puede('produccion.ver')) accion('Hoja de producción', Icons.assignment_outlined, const HojaProduccion()),
      if (api.puede('gastos.registrar')) accion('Registrar gasto', Icons.receipt_long_outlined, const Gastos()),
      if (api.puede('clientes.avisar')) accion('Avisos a clientes', Icons.campaign_outlined, const AvisosClientes()),
      if (api.puede('promociones.gestionar')) accion('Promociones', Icons.local_offer_outlined, Promociones(productos: (datos['productos'] as List? ?? const []).cast<Map<String, dynamic>>().where((p) => p['insumoId'] == null).toList())),
      if (api.puede('compras.verificar')) accion('Verificar compras', Icons.fact_check_outlined, const VerificarCompras()),
      if (api.puede('inventario.mover') || api.puede('conteo.aprobar')) accion('Conteo físico', Icons.fact_check_outlined, Conteos(datos: datos)),
      if (api.puede('pedidos.crear') && !api.puede('pedidos.gestionar')) accion('Mis pedidos', Icons.receipt_long_outlined, MisPedidos(productos: (datos['productos'] as List? ?? const []).cast<Map<String, dynamic>>())),
      if (api.puede('pedidos.crear') && !api.puede('pedidos.gestionar')) accion('Mi estado de cuenta', Icons.account_balance_wallet_outlined, const EstadoCuenta()),
      if (api.puede('pedidos.ver')) chip('Pedidos', Icons.receipt_long_outlined),
      if (api.puede('cobranza.ver')) chip('Cobranza', Icons.account_balance_wallet_outlined),
      if (api.puede('produccion.ver')) chip('Producción', Icons.local_fire_department_outlined),
      if (trabajaAlmacen(api)) chip('Almacén', Icons.inventory_2_outlined),
      if (esTienda(api, datos)) chip('Catálogo', Icons.bakery_dining_outlined),
    ];
  }

  /// Lo más reciente para el rol. El primer elemento es el título de la sección.
  List<_Fila> _actividad(Api api) {
    String txt(dynamic v) => '${v ?? ''}';
    if (api.puede('produccion.ver')) {
      final ops = ((datos['ops'] as List?) ?? const []).where((o) => o['estado'] != 'TERMINADA').take(5);
      return [const _Fila('Órdenes pendientes'), for (final o in ops) _Fila(txt(o['producto']), detalle: '${o['codigo']} · ${o['estado']}', valor: '${o['cantidad']} u')];
    }
    if (trabajaAlmacen(api)) {
      final ins = ((datos['insumos'] as List?) ?? const []).where((i) => i['estado'] == 'BAJO_MINIMO').take(5);
      return [const _Fila('Insumos por reponer'), for (final i in ins) _Fila(txt(i['nombre']), detalle: 'mínimo ${i['minimo']}', valor: '${i['stock']} ${i['unidad']}')];
    }
    if (api.puede('pedidos.ver')) {
      final ps = ((datos['pedidos'] as List?) ?? const []).take(5);
      return [const _Fila('Pedidos recientes'), for (final p in ps) _Fila('${txt(p['cliente'])} · ${txt(p['codigo'])}', estado: txt(p['estado']), valor: dinero(_n(p['total']).toDouble()))];
    }
    if (esTienda(api, datos)) {
      final ps = ((datos['misPedidos'] as List?) ?? const []).take(5);
      final productos = (datos['productos'] as List? ?? const []).cast<Map<String, dynamic>>();
      return [const _Fila('Mis últimos pedidos'), for (final p in ps) _Fila(txt(p['codigo']), detalle: p['observacion'] == null ? '' : 'Revisa: ${txt(p['observacion'])}', estado: txt(p['estado']), valor: dinero(_n(p['total']).toDouble()), abrir: MisPedidos(productos: productos))];
    }
    return const [];
  }

  /// Los indicadores nacen de los permisos: cada perfil ve lo que le sirve.
  List<Widget> _kpis(BuildContext context, Api api, Map<String, dynamic> datos, Map<String, dynamic> k) {
    Widget abre(Widget kpi, Widget pantalla) => Pulsable(radio: 8,
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => pantalla)), child: kpi);
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

    if (trabajaAlmacen(api)) {
      final insumos = (datos['insumos'] as List?) ?? const [];
      lista.add(Kpi(
        etiqueta: 'Insumos críticos',
        valor: '${insumos.where((i) => i['estado'] == 'BAJO_MINIMO').length}',
        nota: 'bajo el mínimo',
      ));
    }

    if (datos.containsKey('miSaldo')) {
      // Saldo = compras a crédito aún no pagadas (cuentas por cobrar); un pedido suma deuda recién al venderse a crédito.
      final deudas = _n(datos['misDeudas']).toInt();
      final pedidos = _n(datos['misPedidosTotal'] ?? (datos['misPedidos'] as List?)?.length).toInt();
      lista.add(abre(Kpi(etiqueta: 'Mi saldo', valor: dinero(_n(datos['miSaldo'])),
          nota: deudas == 0 ? 'estás al día' : '$deudas ${deudas == 1 ? 'compra' : 'compras'} a crédito por pagar',
          tono: deudas > 0 ? TantaColors.stateDanger : TantaColors.stateOk), const EstadoCuenta()));
      lista.add(abre(Kpi(etiqueta: 'Mis pedidos', valor: '$pedidos', nota: 'en total · toca para verlos'),
          MisPedidos(productos: (datos['productos'] as List? ?? const []).cast<Map<String, dynamic>>())));
    }

    return lista;
  }

  num _n(dynamic v) => v is num ? v : num.tryParse('$v') ?? 0;
}

/// Una fila de «lo más reciente»: con estado se muestra como insignia de color.
class _Fila {
  const _Fila(this.titulo, {this.detalle = '', this.estado = '', this.valor = '', this.abrir});
  final String titulo, detalle, estado, valor;
  final Widget? abrir;
}

/// Trabaja el almacén: mueve stock, atiende requisiciones o verifica compras (se asigna en Sistema → Roles).
/// Consultar el stock (inventario.ver) no basta: el vendedor lo consulta al vender, pero no gestiona el almacén.
bool trabajaAlmacen(Api api) => api.puede('inventario.mover') || api.puede('requisiciones.atender') || api.puede('compras.verificar');

/// Tienda para pedir: una cuenta de cliente (el servidor envía su saldo) con permiso de catálogo.
/// El personal no compra para sí: registra pedidos de sus clientes desde Pedidos.
bool esTienda(Api api, Map<String, dynamic> datos) => api.puede('catalogo.ver') && datos.containsKey('miSaldo');
