import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/cola.dart';
import '../core/comprobante.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

export 'cobranza.dart';

/// Pedidos del vendedor: ve la lista y avanza el estado.
/// Las transiciones válidas las valida el servidor; aquí solo se ofrecen las que aplican.
class Pedidos extends StatefulWidget {
  const Pedidos({super.key, required this.datos});
  final Map<String, dynamic> datos;

  @override
  State<Pedidos> createState() => _PedidosState();
}

class _PedidosState extends State<Pedidos> {
  late List<Map<String, dynamic>> _pedidos;
  String? _ocupado;

  // RN-26. "Listo" se despacha vendiendo (botón propio); "Registrado" también se puede rechazar.
  static const _siguiente = <String, String>{
    'REGISTRADO': 'CONFIRMADO',
    'CONFIRMADO': 'LISTO',
    'EN_PRODUCCION': 'LISTO',
    'DESPACHADO': 'ENTREGADO',
  };

  static const _etiqueta = <String, String>{
    'REGISTRADO': 'Por confirmar',
    'CONFIRMADO': 'Confirmado',
    'RECHAZADO': 'Rechazado',
    'EN_PRODUCCION': 'En producción',
    'LISTO': 'Listo',
    'DESPACHADO': 'Despachado',
    'ENTREGADO': 'Entregado',
    'CANCELADO': 'Cancelado',
  };

  @override
  void initState() {
    super.initState();
    _pedidos = ((widget.datos['pedidos'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .toList();
  }

  Future<void> _avanzar(Map<String, dynamic> p) async {
    final actual = '${p['estado']}';
    final destino = _siguiente[actual];
    if (destino == null) return;

    setState(() => _ocupado = p['codigo'] as String);

    // Primero se guarda en disco: si no hay red, el cambio no se pierde.
    await ColaOffline.instancia.encolar(
      'pedido',
      {'codigo': '${p['codigo']}', 'estado': destino},
      descripcion: '${p['codigo']} → ${_etiqueta[destino]}',
    );
    final enviadas = await ColaOffline.instancia.sincronizar(Api.instancia);

    if (!mounted) return;
    setState(() {
      p['estado'] = destino;
      p['pendiente'] = enviadas == 0;
    });
    setState(() => _ocupado = null);

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(enviadas > 0
            ? '${p['codigo']} → ${_etiqueta[destino]}'
            : 'Sin conexión · guardado, se enviará al volver la red'),
        backgroundColor: enviadas > 0 ? TantaColors.stateOk : TantaColors.stateWarn,
        action: destino == 'DESPACHADO'
            ? SnackBarAction(
                label: 'Guía PDF',
                textColor: Colors.white,
                onPressed: () => compartirComprobante(
                  titulo: 'Guía de despacho',
                  numero: '${p['codigo']}',
                  cliente: '${p['cliente'] ?? '-'}',
                  lineas: [('Pedido ${p['codigo']}', dinero(((p['total'] as num?) ?? 0).toDouble()))],
                  total: dinero(((p['total'] as num?) ?? 0).toDouble()),
                  vendedor: Api.instancia.nombre,
                ),
              )
            : null,
      ),
    );
  }

  /// Pide un texto (motivo u observación) y devuelve null si se cancela.
  Future<String?> _pedirTexto(String titulo, String etiqueta, {bool obligatorio = true}) async {
    final c = TextEditingController();
    return showDialog<String>(context: context, builder: (_) => AlertDialog(
      title: Text(titulo),
      content: TextField(controller: c, autofocus: true, maxLength: 200, decoration: InputDecoration(labelText: etiqueta)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Volver')),
        FilledButton(onPressed: () { if (!obligatorio || c.text.trim().length >= 3) Navigator.pop(context, c.text.trim()); }, child: const Text('Confirmar')),
      ],
    ));
  }

  Future<void> _rechazar(Map<String, dynamic> p) async {
    final motivo = await _pedirTexto('Rechazar ${p['codigo']}', 'Motivo del rechazo');
    if (motivo == null || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      await Api.instancia.cambiarEstadoPedido('${p['codigo']}', 'RECHAZADO', motivo: motivo);
      setState(() => p['estado'] = 'RECHAZADO');
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje)));
    }
  }

  /// VEN-02/05: despachar = vender lo pedido (descuenta stock, libera la reserva y deja el pedido despachado).
  Future<void> _despachar(Map<String, dynamic> p) async {
    final forma = await showDialog<String>(context: context, builder: (_) => SimpleDialog(
      title: Text('Despachar ${p['codigo']}'),
      children: [for (final m in mediosPago('enVentas'))
        SimpleDialogOption(onPressed: () => Navigator.pop(context, '${m['codigo']}'), child: Text('${m['nombre']}'))],
    ));
    if (forma == null || !mounted) return;
    var referencia = '';
    if (requiereOperacion(forma)) {
      final r = await _pedirTexto('Pago con ${forma.toLowerCase()}', 'N.° de operación');
      if (r == null || !mounted) return;
      referencia = r;
    }
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _ocupado = p['codigo'] as String);
    try {
      final completo = (await Api.instancia.misPedidos()).cast<Map<String, dynamic>>().firstWhere((x) => x['codigo'] == p['codigo']);
      final items = ((completo['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
      final v = await Api.instancia.registrarVenta(
        items: [for (final i in items) {'productoId': i['productoId'], 'cantidad': i['cantidad']}],
        formaPago: forma, clienteId: '${completo['clienteId']}', pedidoId: '${completo['id']}', referenciaPago: referencia);
      setState(() => p['estado'] = 'DESPACHADO');
      await compartirComprobante(
        titulo: 'Nota de venta', numero: '${(v['comprobante'] as Map?)?['numero'] ?? v['codigo']}', cliente: '${p['cliente'] ?? '-'}', vendedor: Api.instancia.nombre,
        total: dinero(((p['total'] as num?) ?? 0).toDouble()),
        lineas: [for (final i in items) ('${i['cantidad']} × ${i['producto']}', '')]);
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje)));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: intenta de nuevo')));
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  Color _tono(String estado) => switch (estado) {
        'ENTREGADO' => TantaColors.stateOk,
        'LISTO' || 'DESPACHADO' => TantaColors.stateInfo,
        'EN_PRODUCCION' => TantaColors.stateWarn,
        'CANCELADO' => TantaColors.stateDanger,
        _ => TantaColors.textMuted,
      };

  @override
  Widget build(BuildContext context) {
    final puedeGestionar = Api.instancia.puede('pedidos.gestionar');

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        TituloSeccion('', subtitulo: '${_pedidos.length} en el período'),
        const SizedBox(height: 14),
        if (_pedidos.isEmpty) const VacioMensaje('No hay pedidos en el período', icono: Icons.receipt_long_outlined),
        ..._pedidos.map((p) {
          final estado = '${p['estado']}';
          final siguiente = _siguiente[estado];
          final ocupado = _ocupado == p['codigo'];

          return Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Panel(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('${p['cliente']}',
                            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                      ),
                      Insignia(_etiqueta[estado] ?? estado,
                          tono: estado == 'ENTREGADO'
                              ? Tono.ok
                              : estado == 'CANCELADO'
                                  ? Tono.danger
                                  : estado == 'EN_PRODUCCION'
                                      ? Tono.warn
                                      : Tono.info,
                          punto: true),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text('${p['codigo']} · entrega ${fechaCorta('${p['fechaEntrega']}')}',
                      style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Text(dinero((p['total'] as num?)?.toDouble() ?? 0),
                          style: estiloDisplay.copyWith(fontSize: 16)),
                      const Spacer(),
                      if (puedeGestionar && estado == 'REGISTRADO')
                        TextButton(onPressed: ocupado ? null : () => _rechazar(p), child: const Text('Rechazar')),
                      if (puedeGestionar && estado == 'LISTO' && Api.instancia.puede('ventas.registrar'))
                        FilledButton(onPressed: ocupado ? null : () => _despachar(p), child: const Text('Despachar y vender')),
                      if (puedeGestionar && siguiente != null)
                        SizedBox(
                          height: 34,
                          child: FilledButton(
                            style: FilledButton.styleFrom(
                              backgroundColor: _tono(estado),
                              minimumSize: const Size(0, 34),
                              padding: const EdgeInsets.symmetric(horizontal: 14),
                              textStyle: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                            ),
                            onPressed: ocupado ? null : () => _avanzar(p),
                            child: ocupado
                                ? const SizedBox(
                                    width: 14, height: 14,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.cream50))
                                : Text('Marcar ${_etiqueta[siguiente]?.toLowerCase()}'),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }
}
