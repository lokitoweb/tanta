import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/cola.dart';
import '../core/comprobante.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';
import 'acciones.dart' show etiquetaPedido, tonoPedido;
import 'cobranza.dart';

export 'cobranza.dart';

/// Pedidos del vendedor: lista con filtros, detalle completo del pedido y cada paso del flujo
/// (confirmar, observar, rechazar/anular, listo, despachar, entregar y cobrar). El servidor valida cada transición.
class Pedidos extends StatefulWidget {
  const Pedidos({super.key, required this.datos});
  final Map<String, dynamic> datos;

  @override
  State<Pedidos> createState() => _PedidosState();
}

class _PedidosState extends State<Pedidos> {
  List<Map<String, dynamic>>? _pedidos;
  String? _error;
  String? _ocupado;
  String _filtro = 'activos';
  // Selección múltiple para cancelar varios pedidos (VEN-06).
  bool _seleccionando = false;
  final Set<String> _marcados = {};
  bool _cancelable(Map<String, dynamic> p) => ['REGISTRADO', 'CONFIRMADO', 'EN_PRODUCCION', 'LISTO'].contains(p['estado']) && p['pendiente'] != true;

  static const _filtros = {
    'activos': 'Activos',
    'confirmar': 'Por confirmar',
    'entregar': 'Por entregar',
    'todos': 'Todos',
  };

  bool _pasa(Map<String, dynamic> p) => switch (_filtro) {
        'activos' => !['ENTREGADO', 'CANCELADO', 'RECHAZADO'].contains(p['estado']),
        'confirmar' => p['estado'] == 'REGISTRADO',
        'entregar' => p['estado'] == 'LISTO' || p['estado'] == 'DESPACHADO',
        _ => true,
      };

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  /// Lista completa con productos (GET /pedidos): la del panel no trae el detalle.
  Future<void> _cargar() async {
    try {
      final r = await Api.instancia.misPedidos();
      if (!mounted) return;
      setState(() { _pedidos = r.cast<Map<String, dynamic>>(); _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  double _n(Object? v) => (v as num?)?.toDouble() ?? 0;
  List<Map<String, dynamic>> _items(Map<String, dynamic> p) => ((p['items'] as List?) ?? const []).cast<Map<String, dynamic>>();

  /// «2 × paquete x 6 (12 unid)» o «5 unid».
  String _cantidad(Map<String, dynamic> i) {
    final pres = '${i['presentacion'] ?? ''}';
    final unid = _n(i['cantidad']);
    final u = unid == unid.roundToDouble() ? unid.toStringAsFixed(0) : unid.toStringAsFixed(2);
    return pres.isNotEmpty && i['cantidadPresentacion'] != null
        ? '${_n(i['cantidadPresentacion']).toStringAsFixed(0)} × ${pres.toLowerCase()} ($u unid)'
        : '$u unid';
  }

  void _aviso(String texto, {Color? color, SnackBarAction? accion}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(texto), backgroundColor: color, action: accion, persist: false, duration: const Duration(seconds: 6)));
  }

  /// Pide un texto (motivo u observación) y devuelve null si se cancela.
  Future<String?> _pedirTexto(String titulo, String etiqueta, {int minimo = 3}) async {
    final c = TextEditingController();
    return showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: Text(titulo),
      content: TextField(controller: c, autofocus: true, maxLength: 200, maxLines: 3, minLines: 1, decoration: InputDecoration(labelText: etiqueta)),
      actions: [
        AccionesDialogo(
          secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('Volver')),
          principal: FilledButton(onPressed: () { if (c.text.trim().length >= minimo) Navigator.pop(ctx, c.text.trim()); }, child: const Text('Confirmar')),
        ),
      ],
    ));
  }

  /// Cambios de estado simples: se guardan primero en el teléfono (sin red no se pierden).
  Future<void> _cambiar(Map<String, dynamic> p, String destino, {String motivo = ''}) async {
    setState(() => _ocupado = '${p['codigo']}');
    try {
      if (motivo.isNotEmpty) {
        await Api.instancia.cambiarEstadoPedido('${p['codigo']}', destino, motivo: motivo);
        _aviso('${p['codigo']} → ${etiquetaPedido[destino]}', color: TantaColors.stateOk);
      } else {
        await ColaOffline.instancia.encolar('pedido', {'codigo': '${p['codigo']}', 'estado': destino}, descripcion: '${p['codigo']} → ${etiquetaPedido[destino]}');
        final enviadas = await ColaOffline.instancia.sincronizar(Api.instancia);
        // Una oferta confirmada queda lista (el servidor la pasa a Listo: es stock, no se produce).
        final real = p['esOferta'] == true && destino == 'CONFIRMADO' ? 'LISTO' : destino;
        _aviso(enviadas > 0 ? '${p['codigo']} → ${etiquetaPedido[real]}' : 'Sin conexión · guardado, se enviará al volver la red',
            color: enviadas > 0 ? TantaColors.stateOk : TantaColors.stateWarn);
        if (enviadas == 0) setState(() { p['estado'] = destino; p['pendiente'] = true; });
      }
      await _cargar();
    } on ApiException catch (e) {
      _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      _aviso('Sin conexión: intenta de nuevo');
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  Future<void> _observar(Map<String, dynamic> p) async {
    final m = await _pedirTexto('Observar ${p['codigo']}', '¿Qué está mal? (le llega al cliente)', minimo: 5);
    if (m == null || !mounted) return;
    setState(() => _ocupado = '${p['codigo']}');
    try {
      await Api.instancia.observarPedido('${p['codigo']}', m);
      _aviso('Observación enviada a ${p['cliente']}', color: TantaColors.stateOk);
      await _cargar();
    } on ApiException catch (e) {
      _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      _aviso('Sin conexión: intenta de nuevo');
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  /// VEN-02/05: despachar = vender lo pedido «por cobrar» (descuenta stock y libera la reserva).
  /// Cómo paga el cliente se registra al entregar.
  Future<void> _despachar(Map<String, dynamic> p) async {
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text('Despachar ${p['codigo']}'),
      content: Text('Se registra la venta por ${dinero(_n(p['total']))} a ${p['cliente']} y sale de almacén.\n\nEl pago se registra al entregar: todo, una parte o nada (queda como deuda).'),
      actions: [
        AccionesDialogo(
          secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Volver')),
          principal: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Despachar')),
        ),
      ],
    ));
    if (ok != true || !mounted) return;
    setState(() => _ocupado = '${p['codigo']}');
    try {
      final items = _items(p);
      final v = await Api.instancia.registrarVenta(
        // Se despacha en la presentación pedida (paquete x 6): el servidor la convierte a unidades y descarga su empaque.
        items: [for (final i in items)
          if ('${i['presentacion'] ?? ''}'.isNotEmpty && i['cantidadPresentacion'] != null)
            {'productoId': i['productoId'], 'cantidad': i['cantidadPresentacion'], 'presentacion': i['presentacion']}
          else
            {'productoId': i['productoId'], 'cantidad': i['cantidad']}],
        formaPago: 'CREDITO', clienteId: '${p['clienteId']}', pedidoId: '${p['id']}');
      await _cargar();
      final alerta = '${v['alertaCredito'] ?? ''}';
      _aviso(alerta.isEmpty ? '${p['codigo']} despachado · por cobrar ${dinero(_n(p['total']))}' : '${p['codigo']} despachado · $alerta',
          color: alerta.isEmpty ? TantaColors.stateOk : TantaColors.stateWarn,
          accion: SnackBarAction(label: 'Guía PDF', textColor: Colors.white, onPressed: () => compartirComprobante(
            titulo: 'Guía de despacho', numero: '${(v['comprobante'] as Map?)?['numero'] ?? v['codigo']}', cliente: '${p['cliente'] ?? '-'}',
            vendedor: Api.instancia.nombre, total: dinero(_n(p['total'])),
            lineas: [for (final i in items) ('${_cantidad(i)} · ${i['producto']}', dinero(_n(i['precio']) * _n(i['cantidad'])))])));
    } on ApiException catch (e) {
      _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      _aviso('Sin conexión: el despacho necesita internet');
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  /// Entregar y cobrar: lo que paga en el momento entra por Cobranza; lo que falta queda como deuda.
  Future<void> _entregar(Map<String, dynamic> p) async {
    final debe = p['porCobrar'] == null ? _n(p['total']) : _n(p['porCobrar']);
    final cobro = await mostrarHojaCobro(context, cliente: '${p['cliente']}', detalle: '${p['codigo']}', debe: debe, alEntregar: true);
    if (cobro == null || !mounted) return;
    final queda = debe - cobro.monto;
    final resumen = cobro.pagos.isEmpty ? 'queda ${dinero(debe)} por cobrar' : 'cobrado ${dinero(cobro.monto)}${queda > 0.009 ? ' · queda ${dinero(queda)}' : ' · saldado'}';
    setState(() => _ocupado = '${p['codigo']}');
    try {
      final r = await Api.instancia.entregarPedido('${p['codigo']}', pagos: cobro.pagos, observaciones: cobro.nota, voucher: cobro.pagos.isEmpty ? null : cobro.voucher);
      await _cargar();
      final recibo = (r['recibo'] as Map?)?.cast<String, dynamic>();
      _aviso('${p['codigo']} entregado · $resumen', color: TantaColors.stateOk,
          accion: recibo == null ? null : SnackBarAction(label: 'Recibo PDF', textColor: Colors.white, onPressed: () => compartirComprobante(
            titulo: 'Recibo de cobro', numero: '${recibo['numero']}', cliente: '${p['cliente']}',
            lineas: lineasRecibo(cobro.pagos, queda), total: dinero(cobro.monto), vendedor: Api.instancia.nombre)));
    } on ApiException catch (e) {
      if (e.esDefinitivo) {
        _aviso(e.mensaje, color: TantaColors.stateDanger);
      } else {
        await _entregaSinRed(p, cobro, resumen);
      }
    } catch (_) {
      await _entregaSinRed(p, cobro, resumen);
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  /// Sin señal en la calle: la entrega (con su cobro) se guarda y se envía sola; el servidor no la repite.
  Future<void> _entregaSinRed(Map<String, dynamic> p, Cobro cobro, String resumen) async {
    await ColaOffline.instancia.encolar('entrega', {'codigo': '${p['codigo']}', 'pagos': cobro.pagos, 'observaciones': cobro.nota, 'voucher': cobro.pagos.isEmpty ? null : cobro.voucher},
        descripcion: 'Entrega ${p['codigo']} · $resumen');
    if (!mounted) return;
    setState(() { p['estado'] = 'ENTREGADO'; p['pendiente'] = true; });
    _aviso('Sin conexión · entrega guardada ($resumen), se enviará al volver la red', color: TantaColors.stateWarn);
  }

  /// El vendedor corrige lo pedido antes de producción; el servidor recalcula el total y avisa al cliente.
  Future<void> _corregir(Map<String, dynamic> p) async {
    final items = _items(p);
    final cantidades = [for (final i in items) TextEditingController(text: _n(i['cantidad']).toStringAsFixed(_n(i['cantidad']) % 1 == 0 ? 0 : 2))];
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text('Corregir ${p['codigo']}'),
      content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        for (var k = 0; k < items.length; k++) Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: TextField(controller: cantidades[k], keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: '${items[k]['producto']}', helperText: '0 quita el producto')),
        ),
      ])),
      actions: [
        AccionesDialogo(
          secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Volver')),
          principal: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Guardar')),
        ),
      ],
    ));
    final nuevos = <Map<String, dynamic>>[
      for (var k = 0; k < items.length; k++)
        if ((double.tryParse(cantidades[k].text.replaceAll(',', '.')) ?? 0) > 0)
          {'productoId': items[k]['productoId'], 'cantidad': double.parse(cantidades[k].text.replaceAll(',', '.'))},
    ];
    for (final c in cantidades) { c.dispose(); }
    if (ok != true || !mounted) return;
    if (nuevos.isEmpty) return _aviso('El pedido debe tener al menos un producto', color: TantaColors.stateDanger);
    setState(() => _ocupado = '${p['codigo']}');
    try {
      final r = await Api.instancia.corregirPedido('${p['codigo']}', nuevos);
      await _cargar();
      _aviso('${p['codigo']} corregido · total ${dinero(_n(r['total']))}', color: TantaColors.stateOk);
    } on ApiException catch (e) {
      _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      _aviso('Sin conexión: la corrección necesita internet');
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  /// Detalle completo del pedido con las acciones de su estado.
  Future<void> _detalle(Map<String, dynamic> p) async {
    final gestiona = Api.instancia.puede('pedidos.gestionar');
    final vende = Api.instancia.puede('ventas.registrar');
    final estado = '${p['estado']}';
    final items = _items(p);
    final obs = '${p['observacion'] ?? ''}';
    final porCobrar = p['porCobrar'] == null ? null : _n(p['porCobrar']);
    // Cada acción cierra la hoja y luego se ejecuta.
    Widget accion(BuildContext ctx, String texto, Future<void> Function() fn, {bool principal = false, bool peligro = false}) {
      void tocar() { Navigator.pop(ctx); fn(); }
      return principal
          ? FilledButton(onPressed: tocar, child: Text(texto))
          : OutlinedButton(
              style: peligro ? OutlinedButton.styleFrom(foregroundColor: TantaColors.stateDanger, side: const BorderSide(color: TantaColors.stateDanger)) : null,
              onPressed: tocar, child: Text(texto));
    }

    await showModalBottomSheet<void>(context: context, isScrollControlled: true, useSafeArea: true, builder: (ctx) => DraggableScrollableSheet(
      expand: false, initialChildSize: 0.8, builder: (_, scroll) => ListView(controller: scroll,
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(ctx).viewPadding.bottom), children: [
        Row(children: [
          Expanded(child: Text('${p['codigo']}', style: Theme.of(ctx).textTheme.titleLarge)),
          Insignia(etiquetaPedido[estado] ?? estado, tono: tonoPedido(estado), punto: true),
        ]),
        Text('${p['cliente']}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Text('Entrega ${fechaCorta('${p['fecha_entrega']}')}${'${p['hora_entrega'] ?? ''}'.isEmpty ? '' : ' · ${p['hora_entrega']}'} · '
            '${p['tipoEntrega'] == 'DELIVERY' ? 'entrega en ${p['direccion']}' : 'recojo en tienda'}${p['vehiculo'] == null ? '' : ' · móvil ${p['vehiculo']}'}', style: const TextStyle(color: TantaColors.textMuted)),
        if ('${p['observaciones'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Nota del cliente: ${p['observaciones']}')),
        if (obs.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6),
            child: Text('Tu observación: $obs', style: const TextStyle(color: TantaColors.stateWarn))),
        if ('${p['motivo'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Motivo: ${p['motivo']}')),
        if ('${p['entregaObs'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Entrega: ${p['entregaObs']}')),
        const Divider(height: 24),
        for (final i in items)
          Padding(padding: const EdgeInsets.symmetric(vertical: 5), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${i['producto']}', style: const TextStyle(fontWeight: FontWeight.w600)),
              Text('${_cantidad(i)} · ${dinero(_n(i['precio']))} c/u', style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
            ])),
            Text(dinero(_n(i['precio']) * _n(i['cantidad']))),
          ])),
        const Divider(height: 20),
        Row(children: [
          const Expanded(child: Text('Total', style: TextStyle(fontWeight: FontWeight.w700))),
          Text(dinero(_n(p['total'])), style: estiloDisplay.copyWith(fontSize: 18)),
        ]),
        if (porCobrar != null) Padding(padding: const EdgeInsets.only(top: 4), child: Row(children: [
          const Expanded(child: Text('Por cobrar', style: TextStyle(color: TantaColors.textMuted))),
          Text(porCobrar > 0.009 ? dinero(porCobrar) : 'Pagado', style: TextStyle(fontWeight: FontWeight.w600,
              color: porCobrar > 0.009 ? TantaColors.stateWarn : TantaColors.stateOk)),
        ])),
        const SizedBox(height: 16),
        if (gestiona && p['pendiente'] != true) Wrap(spacing: 8, runSpacing: 8, children: [
          // Oferta: al confirmarla queda lista para despacho (es stock reservado, no se produce).
          if (estado == 'REGISTRADO') accion(ctx, p['esOferta'] == true ? 'Confirmar · sale del stock' : 'Confirmar', () => _cambiar(p, 'CONFIRMADO'), principal: true),
          if (estado == 'CONFIRMADO' || estado == 'EN_PRODUCCION') accion(ctx, 'Marcar listo', () => _cambiar(p, 'LISTO'), principal: true),
          if (estado == 'LISTO' && vende) accion(ctx, 'Despachar', () => _despachar(p), principal: true),
          if (estado == 'DESPACHADO' && Api.instancia.puede('cobranza.registrar')) accion(ctx, 'Entregar y cobrar', () => _entregar(p), principal: true),
          if (estado == 'REGISTRADO' || estado == 'CONFIRMADO') accion(ctx, 'Corregir pedido', () => _corregir(p)),
          if (estado == 'REGISTRADO' || estado == 'CONFIRMADO') accion(ctx, 'Observar', () => _observar(p)),
          if (estado == 'REGISTRADO') accion(ctx, 'Rechazar', () async {
            final m = await _pedirTexto('Rechazar ${p['codigo']}', 'Motivo (le llega al cliente)');
            if (m != null) await _cambiar(p, 'RECHAZADO', motivo: m);
          }, peligro: true),
          if (['CONFIRMADO', 'EN_PRODUCCION', 'LISTO'].contains(estado)) accion(ctx, 'Anular', () async {
            final m = await _pedirTexto('Anular ${p['codigo']}', 'Motivo (le llega al cliente)');
            if (m != null) await _cambiar(p, 'CANCELADO', motivo: m);
          }, peligro: true),
        ]),
      ]),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final pedidos = _pedidos;
    if (_error != null || pedidos == null) {
      return RefreshIndicator(onRefresh: _cargar, child: ListView(children: [
        _error != null ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar) : const Esqueleto(),
      ]));
    }
    final lista = pedidos.where(_pasa).toList();
    int cuenta(String f) => pedidos.where((p) { final a = _filtro; _filtro = f; final r = _pasa(p); _filtro = a; return r; }).length;

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          SizedBox(height: 40, child: ListView(scrollDirection: Axis.horizontal, children: [
            for (final f in _filtros.entries)
              Padding(padding: const EdgeInsets.only(right: 8), child: ChoiceChip(
                label: Text('${f.value} ${cuenta(f.key)}'), selected: _filtro == f.key, onSelected: (_) => setState(() => _filtro = f.key))),
            if (Api.instancia.puede('pedidos.gestionar'))
              ActionChip(
                avatar: Icon(_seleccionando ? Icons.close : Icons.checklist, size: 18),
                label: Text(_seleccionando ? 'Terminar' : 'Cancelar varios'),
                onPressed: () => setState(() { _seleccionando = !_seleccionando; _marcados.clear(); })),
          ])),
          const SizedBox(height: 12),
          if (_seleccionando) ...[_barraSeleccion(lista), const SizedBox(height: 10)],
          if (lista.isEmpty) const VacioMensaje('No hay pedidos con este filtro', icono: Icons.receipt_long_outlined),
          for (final p in lista) _tarjeta(p),
        ],
      ),
    );
  }

  /// VEN-06: cancela los pedidos marcados con un solo motivo; la API informa los que ya no se podían cancelar.
  Future<void> _cancelarMarcados() async {
    final m = await _pedirTexto('Cancelar ${_marcados.length} pedido(s)', 'Motivo (le llega a cada cliente)');
    if (m == null) return;
    setState(() => _ocupado = 'varios');
    try {
      final r = await Api.instancia.cancelarVarios(_marcados.toList(), m);
      final no = ((r['rechazados'] as List?) ?? const []).cast<Map>();
      _aviso('${(r['cancelados'] as List).length} cancelado(s)${no.isEmpty ? '' : ' · no se cancelaron: ${no.map((x) => '${x['codigo']} (${x['motivo']})').join(', ')}'}',
          color: no.isEmpty ? TantaColors.stateOk : TantaColors.stateWarn);
      setState(() { _marcados.clear(); _seleccionando = false; });
      await _cargar();
    } on ApiException catch (e) {
      _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      _aviso('Sin conexión: intenta de nuevo');
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  Widget _barraSeleccion(List<Map<String, dynamic>> lista) {
    final cancelables = lista.where(_cancelable).map((p) => '${p['codigo']}').toList();
    return Panel(
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 8),
      // Texto arriba y botones abajo: el tema da ancho completo a los botones y en una sola fila aplastaba el texto.
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(_marcados.isEmpty ? 'Toca los pedidos que quieras cancelar' : '${_marcados.length} pedido(s) seleccionado(s)',
            style: const TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Row(children: [
          TextButton(
            style: TextButton.styleFrom(minimumSize: const Size(0, 40)),
            onPressed: cancelables.isEmpty ? null : () => setState(() => _marcados.length == cancelables.length ? _marcados.clear() : _marcados.addAll(cancelables)),
            child: Text(_marcados.length == cancelables.length && cancelables.isNotEmpty ? 'Quitar todos' : 'Marcar todos')),
          const Spacer(),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: TantaColors.stateDanger, minimumSize: const Size(0, 40)),
            onPressed: _marcados.isEmpty || _ocupado != null ? null : _cancelarMarcados,
            child: Text(_marcados.isEmpty ? 'Cancelar' : 'Cancelar ${_marcados.length}')),
        ]),
      ]),
    );
  }

  Widget _tarjeta(Map<String, dynamic> p) {
    final estado = '${p['estado']}';
    final items = _items(p);
    final ocupado = _ocupado == p['codigo'];
    final observado = '${p['observacion'] ?? ''}'.isNotEmpty && (estado == 'REGISTRADO' || estado == 'CONFIRMADO');
    final porCobrar = p['porCobrar'] == null ? 0.0 : _n(p['porCobrar']);
    final codigo = '${p['codigo']}';
    final marcado = _marcados.contains(codigo);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Pulsable(
        radio: 8,
        onTap: ocupado ? null : _seleccionando
            ? (_cancelable(p) ? () => setState(() => marcado ? _marcados.remove(codigo) : _marcados.add(codigo)) : null)
            : () => _detalle(p),
        child: Panel(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              if (_seleccionando) Padding(padding: const EdgeInsets.only(right: 8), child: Icon(
                  !_cancelable(p) ? Icons.block : marcado ? Icons.check_box : Icons.check_box_outline_blank,
                  size: 22, color: !_cancelable(p) ? TantaColors.textMuted : marcado ? TantaColors.stateDanger : TantaColors.ink800,
                  semanticLabel: _cancelable(p) ? (marcado ? 'Seleccionado' : 'Sin seleccionar') : 'No se puede cancelar')),
              Expanded(child: Text('${p['cliente']}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
              if (p['esOferta'] == true) const Padding(padding: EdgeInsets.only(right: 6), child: Insignia('Oferta', tono: Tono.ok)),
              if (ocupado) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              else Insignia(p['pendiente'] == true ? 'Por enviar' : etiquetaPedido[estado] ?? estado,
                  tono: p['pendiente'] == true ? Tono.warn : tonoPedido(estado), punto: true),
            ]),
            const SizedBox(height: 2),
            Text('${p['codigo']} · entrega ${fechaCorta('${p['fecha_entrega']}')}${'${p['hora_entrega'] ?? ''}'.isEmpty ? '' : ' ${p['hora_entrega']}'}'
                '${p['tipoEntrega'] == 'DELIVERY' ? ' · delivery' : ''}', style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
            if (items.isNotEmpty)
              Text('${items.take(2).map((i) => '${_cantidad(i)} ${i['producto']}').join(', ')}${items.length > 2 ? ' +${items.length - 2}' : ''}',
                  maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
            const SizedBox(height: 6),
            Row(children: [
              Text(dinero(_n(p['total'])), style: estiloDisplay.copyWith(fontSize: 16)),
              const Spacer(),
              if (observado) const Insignia('Observado', tono: Tono.warn),
              if (estado == 'ENTREGADO' && porCobrar > 0.009) Insignia('Por cobrar ${dinero(porCobrar)}', tono: Tono.danger),
              const Icon(Icons.chevron_right, color: TantaColors.textMuted),
            ]),
          ]),
        ),
      ),
    );
  }
}
