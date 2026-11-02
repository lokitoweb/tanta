import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Tablero de producción: tarjetas grandes, pensadas para tablet en planta.
class Produccion extends StatelessWidget {
  const Produccion({super.key, required this.datos});
  final Map<String, dynamic> datos;

  @override
  Widget build(BuildContext context) {
    final ops = (datos['ops'] as List? ?? const []).cast<Map<String, dynamic>>();
    final pendientes = ops.where((o) => o['estado'] == 'PENDIENTE').toList();
    final enProceso = ops.where((o) => o['estado'] == 'EN_PROCESO').toList();
    final terminadas = ops.where((o) => o['estado'] == 'TERMINADA').toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 32),
      children: [
        const TituloSeccion('Tablero de producción',
            subtitulo: 'Órdenes del día · el consumo de insumos se descuenta al cerrar'),
        const SizedBox(height: 16),
        _grupo(context, 'Pendientes', pendientes, Tono.neutral),
        _grupo(context, 'En proceso', enProceso, Tono.warn),
        _grupo(context, 'Terminadas', terminadas, Tono.ok),
      ],
    );
  }

  Widget _grupo(BuildContext context, String titulo, List<Map<String, dynamic>> items, Tono tono) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 10, top: 6),
          child: Row(
            children: [
              Text(titulo, style: estiloDisplay.copyWith(fontSize: 17)),
              const SizedBox(width: 8),
              Insignia('${items.length}', tono: tono),
            ],
          ),
        ),
        ...items.map((o) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _TarjetaOp(op: o, esTerminada: o['estado'] == 'TERMINADA'),
            )),
        const SizedBox(height: 8),
      ],
    );
  }
}

class _TarjetaOp extends StatelessWidget {
  const _TarjetaOp({required this.op, required this.esTerminada});
  final Map<String, dynamic> op;
  final bool esTerminada;

  @override
  Widget build(BuildContext context) {
    final avance = (op['avance'] as num?)?.toDouble() ?? 0;
    final puedeEjecutar = Api.instancia.puede('produccion.ejecutar');
    return Container(
      decoration: BoxDecoration(
        color: TantaColors.surfaceCard,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: TantaColors.borderSubtle),
      ),
      child: Column(
        children: [
          Container(
            height: 3,
            decoration: BoxDecoration(
              color: esTerminada ? TantaColors.stateOk : TantaColors.sand300,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('${op['codigo']}',
                        style: const TextStyle(
                            fontSize: 11, color: TantaColors.textMuted, letterSpacing: 0.2)),
                    Text('entrega ${op['entrega']}',
                        style: const TextStyle(fontSize: 11, color: TantaColors.textMuted)),
                  ],
                ),
                const SizedBox(height: 6),
                Text('${op['producto']}', style: estiloDisplay.copyWith(fontSize: 17)),
                const SizedBox(height: 2),
                Text('${op['cantidad']} unidades · ${op['responsable']}',
                    style: const TextStyle(fontSize: 12.5, color: TantaColors.textMuted)),
                const SizedBox(height: 12),
                Progreso(
                  valor: avance,
                  color: esTerminada
                      ? TantaColors.stateOk
                      : avance > 0
                          ? TantaColors.stateWarn
                          : TantaColors.ink300,
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        esTerminada ? 'Producto en stock' : 'Avance ${porcentaje(avance, 0)}',
                        style: const TextStyle(fontSize: 11.5, color: TantaColors.textMuted),
                      ),
                    ),
                    if (!esTerminada && puedeEjecutar)
                      SizedBox(
                        height: 40,
                        child: FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: TantaColors.ink800,
                            padding: const EdgeInsets.symmetric(horizontal: 18),
                            minimumSize: const Size(0, 40),
                            textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                          ),
                          onPressed: () => _accion(context, op, esTerminada: false),
                          child: const Text('Registrar cierre'),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _accion(BuildContext context, Map<String, dynamic> op, {required bool esTerminada}) async {
    final cantidad = (op['cantidad'] as num?)?.toDouble() ?? 0;
    // La merma estándar viene de la orden (definida en la receta), no del código.
    final merma = (op['mermaEsperada'] as num?)?.toDouble() ?? 0;
    try {
      await Api.instancia.cerrarOrden('${op['codigo']}', cantidad, merma);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Orden ${op['codigo']} cerrada · inventario actualizado'),
          backgroundColor: TantaColors.stateOk,
        ),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('No se pudo cerrar: $e'), backgroundColor: TantaColors.stateDanger),
      );
    }
  }
}

/// Almacén: stock de insumos con semáforo de mínimo.
class Almacen extends StatelessWidget {
  const Almacen({super.key, required this.datos});
  final Map<String, dynamic> datos;

  @override
  Widget build(BuildContext context) {
    final insumos = (datos['insumos'] as List? ?? const []).cast<Map<String, dynamic>>();
    final criticos = insumos.where((i) => i['estado'] == 'BAJO_MINIMO').length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 32),
      children: [
        TituloSeccion('Almacén e inventario',
            subtitulo: '$criticos insumos bajo el stock mínimo'),
        const SizedBox(height: 14),
        ...insumos.map((i) {
          final stock = (i['stock'] as num?)?.toDouble() ?? 0;
          final minimo = (i['minimo'] as num?)?.toDouble() ?? 1;
          final critico = i['estado'] == 'BAJO_MINIMO';
          return Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Panel(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('${i['nombre']}',
                            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                      ),
                      Insignia(critico ? 'Reponer' : 'Disponible',
                          tono: critico ? Tono.danger : Tono.ok, punto: true),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '${stock.toStringAsFixed(1)} ${i['unidad']} · mínimo ${minimo.toStringAsFixed(0)}',
                    style: const TextStyle(fontSize: 12, color: TantaColors.textMuted),
                  ),
                  const SizedBox(height: 8),
                  Progreso(
                    valor: minimo > 0 ? stock / (minimo * 3) : 1,
                    color: critico ? TantaColors.stateDanger : TantaColors.stateOk,
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
