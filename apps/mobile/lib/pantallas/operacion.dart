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
        const TituloSeccion('',
            subtitulo: 'Órdenes del día · el consumo de insumos se descuenta al cerrar'),
        const SizedBox(height: 16),
        if (ops.isEmpty) const VacioMensaje('No hay órdenes de producción para hoy', icono: Icons.local_fire_department_outlined),
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
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: TantaColors.borderSubtle),
      ),
      child: Column(
        children: [
          Container(
            height: 3,
            decoration: BoxDecoration(
              color: esTerminada ? TantaColors.stateOk : TantaColors.sand300,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
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
                          onPressed: () => _accion(context, op),
                          child: Text(op['estado'] == 'PENDIENTE' ? 'Iniciar' : 'Registrar cierre'),
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

  /// PENDIENTE → iniciar; EN_PROCESO → cierre con lo producido de verdad y la merma con su motivo.
  Future<void> _accion(BuildContext context, Map<String, dynamic> op) async {
    final aviso = ScaffoldMessenger.of(context);
    final codigo = '${op['codigo']}';
    try {
      if (op['estado'] == 'PENDIENTE') {
        await Api.instancia.iniciarOrden(codigo);
        aviso.showSnackBar(SnackBar(content: Text('Orden $codigo en proceso · recarga para ver el cambio')));
        return;
      }
      final c = await showDialog<_Cierre>(context: context, builder: (_) => _DialogoCierre(op: op));
      if (c == null) return;
      await Api.instancia.cerrarOrden(codigo, c.buenas, c.merma, c.motivoTipo, c.motivo, horasHombre: c.horasHombre, horasHorno: c.horasHorno);
      aviso.showSnackBar(SnackBar(content: Text('Orden $codigo cerrada · inventario actualizado'), backgroundColor: TantaColors.stateOk));
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: intenta de nuevo'), backgroundColor: TantaColors.stateDanger));
    }
  }
}

class _DialogoCierre extends StatefulWidget {
  const _DialogoCierre({required this.op});
  final Map<String, dynamic> op;
  @override
  State<_DialogoCierre> createState() => _DialogoCierreState();
}

typedef _Cierre = ({double buenas, double merma, String motivoTipo, String motivo, double? horasHombre, double? horasHorno});

const _motivos = {'CORTE': 'Corte', 'ROTURA': 'Rotura', 'QUEMADO': 'Quemado', 'DEFORME': 'Deforme', 'OTRO': 'Otro'};

class _DialogoCierreState extends State<_DialogoCierre> {
  late final _buenas = TextEditingController(text: '${(widget.op['cantidad'] as num?) ?? ''}');
  final _merma = TextEditingController(text: '0');
  final _motivo = TextEditingController();
  final _hh = TextEditingController();
  final _hn = TextEditingController();
  String _motivoTipo = 'QUEMADO';
  String? _error;

  double? _n(TextEditingController c) => c.text.trim().isEmpty ? null : double.tryParse(c.text.replaceAll(',', '.'));

  void _aceptar() {
    final b = _n(_buenas), m = _n(_merma) ?? 0;
    if (b == null || b < 0 || m < 0) return setState(() => _error = 'Revisa las cantidades');
    Navigator.pop<_Cierre>(context, (buenas: b, merma: m, motivoTipo: _motivoTipo, motivo: _motivo.text.trim(), horasHombre: _n(_hh), horasHorno: _n(_hn)));
  }

  @override
  Widget build(BuildContext context) {
    const teclado = TextInputType.numberWithOptions(decimal: true);
    final hayMerma = (_n(_merma) ?? 0) > 0;
    return AlertDialog(
      title: Text('Cerrar ${widget.op['codigo']}'),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _buenas, keyboardType: teclado, decoration: const InputDecoration(labelText: 'Unidades buenas')),
          const SizedBox(height: 12),
          TextField(controller: _merma, keyboardType: teclado, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Unidades de merma')),
          if (hayMerma) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _motivoTipo,
              decoration: const InputDecoration(labelText: 'Motivo de la merma'),
              items: [for (final m in _motivos.entries) DropdownMenuItem(value: m.key, child: Text(m.value))],
              onChanged: (v) => setState(() => _motivoTipo = v!),
            ),
            const SizedBox(height: 12),
            TextField(controller: _motivo, maxLength: 200, decoration: const InputDecoration(labelText: 'Observación (opcional)')),
          ],
          const SizedBox(height: 12),
          TextField(controller: _hh, keyboardType: teclado, decoration: const InputDecoration(labelText: 'Horas hombre reales', helperText: 'Vacío = estándar del pan')),
          const SizedBox(height: 12),
          TextField(controller: _hn, keyboardType: teclado, decoration: const InputDecoration(labelText: 'Horas de horno reales', helperText: 'Vacío = estándar del pan')),
          if (_error != null) Text(_error!, style: const TextStyle(color: TantaColors.stateDanger)),
        ]),
      ),
      actions: [
        AccionesDialogo(
          secundaria: OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
          principal: FilledButton(onPressed: _aceptar, child: const Text('Cerrar orden')),
        ),
      ],
    );
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
        TituloSeccion('',
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
