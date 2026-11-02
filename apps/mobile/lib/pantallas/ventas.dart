import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/cola.dart';
import '../core/comprobante.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

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

  static const _siguiente = <String, String>{
    'REGISTRADO': 'EN_PRODUCCION',
    'EN_PRODUCCION': 'LISTO',
    'LISTO': 'DESPACHADO',
    'DESPACHADO': 'ENTREGADO',
  };

  static const _etiqueta = <String, String>{
    'REGISTRADO': 'Registrado',
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
        TituloSeccion('Pedidos', subtitulo: '${_pedidos.length} en el período'),
        const SizedBox(height: 14),
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

/// Cobranza: cartera abierta y registro de pagos.
class Cobranza extends StatefulWidget {
  const Cobranza({super.key});
  @override
  State<Cobranza> createState() => _CobranzaState();
}

class _CobranzaState extends State<Cobranza> {
  List<Map<String, dynamic>>? _cuentas;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    try {
      final r = await Api.instancia.cartera();
      if (!mounted) return;
      setState(() => _cuentas = r.cast<Map<String, dynamic>>());
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  double get _total =>
      (_cuentas ?? const []).fold<double>(0, (s, c) => s + ((c['saldo'] as num?)?.toDouble() ?? 0));

  Future<void> _cobrar(Map<String, dynamic> c) async {
    final controlador = TextEditingController(text: (c['saldo'] as num).toStringAsFixed(2));
    final medio = ValueNotifier<String>('EFECTIVO');

    final confirmado = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Registrar pago'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${c['cliente']}', style: const TextStyle(fontWeight: FontWeight.w600)),
            Text('Saldo ${dinero((c['saldo'] as num).toDouble())}',
                style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
            const SizedBox(height: 14),
            TextField(
              controller: controlador,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Monto'),
            ),
            const SizedBox(height: 12),
            ValueListenableBuilder<String>(
              valueListenable: medio,
              builder: (_, v, __) => DropdownButtonFormField<String>(
                initialValue: v,
                decoration: const InputDecoration(labelText: 'Medio'),
                items: const ['EFECTIVO', 'TRANSFERENCIA', 'YAPE', 'PLIN']
                    .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                    .toList(),
                onChanged: (x) => medio.value = x ?? 'EFECTIVO',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Cobrar')),
        ],
      ),
    );

    if (confirmado != true) return;

    final monto = double.tryParse(controlador.text.replaceAll(',', '.'));
    if (monto == null || monto <= 0) return;

    // La clave de idempotencia se crea aquí y viaja con la operación: reintentar
    // cinco veces el mismo cobro no lo duplica en el servidor.
    await ColaOffline.instancia.encolar(
      'pago',
      {
        'cxcId': '${c['id']}',
        'monto': monto,
        'medio': medio.value,
        'cliente': '${c['cliente']}',
      },
      descripcion: 'Cobro ${dinero(monto)} · ${c['cliente']}',
    );

    final enviadas = await ColaOffline.instancia.sincronizar(Api.instancia);

    if (!mounted) return;
    if (enviadas > 0) {
      await _cargar();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Pago de ${dinero(monto)} registrado'),
          backgroundColor: TantaColors.stateOk,
          action: SnackBarAction(
            label: 'Recibo PDF',
            textColor: Colors.white,
            onPressed: () => compartirComprobante(
              titulo: 'Recibo de cobro',
              numero: 'REC-${DateTime.now().millisecondsSinceEpoch}',
              cliente: '${c['cliente']}',
              lineas: [('Pago ${medio.value}', dinero(monto))],
              total: dinero(monto),
              vendedor: Api.instancia.nombre,
            ),
          ),
        ),
      );
    } else {
      // Se descuenta en pantalla para no cobrar dos veces al mismo cliente.
      setState(() {
        c['saldo'] = ((c['saldo'] as num) - monto).clamp(0, double.infinity);
        c['pendiente'] = true;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Sin conexión · cobro de ${dinero(monto)} guardado'),
          backgroundColor: TantaColors.stateWarn,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!)));
    }
    final cuentas = _cuentas;
    if (cuentas == null) {
      return const Center(child: CircularProgressIndicator(color: TantaColors.sand500));
    }

    final puedeCobrar = Api.instancia.puede('cobranza.registrar');
    final vencidas = cuentas.where((c) => c['vencida'] == true).length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        TituloSeccion('Cobranza',
            subtitulo: '${cuentas.length} cuentas · $vencidas vencidas'),
        const SizedBox(height: 14),
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Total por cobrar',
                  style: TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
              const SizedBox(height: 2),
              Text(dinero(_total), style: estiloDisplay.copyWith(fontSize: 26)),
            ],
          ),
        ),
        const SizedBox(height: 14),
        ...cuentas.map((c) {
          final vencida = c['vencida'] == true;
          return Padding(
            padding: const EdgeInsets.only(bottom: 9),
            child: Panel(
              padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${c['cliente']}',
                            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                        Text('vence ${fechaCorta('${c['venceEn']}')}${vencida ? ' · ${c['diasVencido']} días' : ''}',
                            style: TextStyle(
                              fontSize: 11.5,
                              color: vencida ? TantaColors.stateDanger : TantaColors.textMuted,
                            )),
                      ],
                    ),
                  ),
                  Text(dinero((c['saldo'] as num).toDouble()),
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                  const SizedBox(width: 10),
                  if (puedeCobrar)
                    SizedBox(
                      height: 32,
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: TantaColors.ink800,
                          minimumSize: const Size(0, 32),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                        ),
                        onPressed: () => _cobrar(c),
                        child: const Text('Cobrar'),
                      ),
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
