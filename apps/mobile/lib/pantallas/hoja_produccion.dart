import 'dart:async';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

double _n(Object? v) => (v as num?)?.toDouble() ?? 0;
// Hasta 4 decimales sin ceros de sobra: 0.284 kg no se muestra como 0.28 ni como 0.
String _c(num v) => v == v.roundToDouble() ? '${v.toInt()}' : v.toStringAsFixed(4).replaceFirst(RegExp(r'0+$'), '');
String _dma(String x) => x.split('-').reversed.join('/');

/// Excel real (.xlsx), igual que en la web: una columna por cliente. Se comparte con la app que el usuario elija.
Future<void> compartirHoja(String nombre, List<Map<String, dynamic>> clientes, List<Map<String, dynamic>> filas) async {
  final bytes = await Api.instancia.excel(nombre, [
    for (final f in filas) {
      'Pedido': f['producto'],
      for (final c in clientes) '${c['nombre']}': (f['porCliente'] as Map)[c['id']] ?? '',
      'Pedido sistema': f['pedido'],
    },
  ]);
  await SharePlus.instance.share(ShareParams(
    files: [XFile.fromData(bytes, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: '$nombre.xlsx')],
    fileNameOverrides: ['$nombre.xlsx'],
  ));
}

class _Matriz extends StatelessWidget {
  const _Matriz({required this.clientes, required this.filas});
  final List<Map<String, dynamic>> clientes;
  final List<Map<String, dynamic>> filas;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          columnSpacing: 20,
          headingRowHeight: 40,
          dataRowMinHeight: 38,
          dataRowMaxHeight: 44,
          columns: [
            const DataColumn(label: Text('Pedido')),
            for (final c in clientes) DataColumn(numeric: true, label: Text('${c['nombre']}')),
            const DataColumn(numeric: true, label: Text('Pedido sistema')),
          ],
          rows: [
            for (final f in filas)
              DataRow(cells: [
                DataCell(Text('${f['producto']}', style: const TextStyle(fontWeight: FontWeight.w600))),
                for (final c in clientes) DataCell(Text((f['porCliente'] as Map)[c['id']] == null ? '' : _c((f['porCliente'] as Map)[c['id']] as num))),
                DataCell(Text(_c(f['pedido'] as num), style: const TextStyle(fontWeight: FontWeight.w700))),
              ]),
          ],
        ),
      );
}

/// Hoja de producción: el maestro ve llenarse los pedidos, el kárdex de insumos y cierra pedidos y producción.
class HojaProduccion extends StatefulWidget {
  const HojaProduccion({super.key});
  @override
  State<HojaProduccion> createState() => _HojaProduccionState();
}

class _HojaProduccionState extends State<HojaProduccion> {
  Map<String, dynamic>? _hoja;
  List<Map<String, dynamic>> _hojas = const [];
  String? _error, _fecha;
  bool _ocupado = false;
  Timer? _reloj;

  @override
  void initState() {
    super.initState();
    _cargar();
    _reloj = Timer.periodic(const Duration(seconds: 20), (_) => _cargar());
  }

  @override
  void dispose() {
    _reloj?.cancel();
    super.dispose();
  }

  Future<void> _cargar() async {
    try {
      final h = await Api.instancia.hojaProduccion(_fecha);
      final l = await Api.instancia.hojasProduccion();
      if (mounted) setState(() { _hoja = h; _hojas = l.cast<Map<String, dynamic>>(); _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  Future<void> _cerrarPedidos() async {
    final h = _hoja!;
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('¿Cerrar pedidos?'),
      content: Text('Los pedidos del ${_dma('${h['fecha']}')} pasan a producción y se crea el lote.'),
      actions: [
        AccionesDialogo(
          secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Volver')),
          principal: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Cerrar pedidos')),
        ),
      ],
    ));
    if (ok != true || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _ocupado = true);
    try {
      final r = await Api.instancia.cerrarPedidosHoja('${h['fecha']}');
      await _cargar();
      aviso.showSnackBar(SnackBar(content: Text('${r['codigo']}: pedidos en producción'), backgroundColor: TantaColors.stateOk));
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: los pedidos no se cerraron')));
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final h = _hoja;
    final clientes = (h?['clientes'] as List? ?? const []).cast<Map<String, dynamic>>();
    final filas = (h?['filas'] as List? ?? const []).cast<Map<String, dynamic>>();
    final insumos = (h?['insumos'] as List? ?? const []).cast<Map<String, dynamic>>();
    final sinReceta = (h?['sinReceta'] as List? ?? const []).cast<String>();
    final fechas = (h?['fechas'] as List? ?? const []).cast<String>();
    final enCurso = _hojas.where((x) => x['estado'] == 'EN_PRODUCCION').toList();
    final fecha = '${h?['fecha'] ?? ''}';
    return Scaffold(
      appBar: AppBar(title: const Text('Hoja de producción'), actions: [
        IconButton(tooltip: 'Exportar a Excel', icon: const Icon(Icons.ios_share), onPressed: filas.isEmpty ? null : () => compartirHoja('hoja-produccion-$fecha', clientes, filas)),
      ]),
      body: _error != null
          ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar)
          : h == null
              ? const Esqueleto()
              : RefreshIndicator(
                  onRefresh: _cargar,
                  child: ListView(padding: EdgeInsets.fromLTRB(16, 16, 16, 24 + MediaQuery.of(context).viewPadding.bottom), children: [
                    for (final x in enCurso)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: FilledButton.icon(
                          onPressed: () async {
                            await Navigator.push(context, MaterialPageRoute(builder: (_) => DetalleHoja(codigo: '${x['codigo']}')));
                            _cargar();
                          },
                          icon: const Icon(Icons.local_fire_department_outlined, size: 18),
                          label: Text('${x['codigo']} · grabar producción'),
                        ),
                      ),
                    Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      Text('Pedidos para el ${_dma(fecha)}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                      const Text('El código de lote se asigna al cerrar los pedidos', style: TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                      if (fechas.length > 1) ...[
                        const SizedBox(height: 8),
                        Wrap(spacing: 6, children: [
                          for (final f in fechas) ChoiceChip(label: Text(_dma(f)), selected: f == fecha, onSelected: (_) { _fecha = f; _cargar(); }),
                        ]),
                      ],
                      const SizedBox(height: 8),
                      if (filas.isEmpty) const VacioMensaje('Sin pedidos confirmados para esta fecha', icono: Icons.assignment_outlined)
                      else _Matriz(clientes: clientes, filas: filas),
                      if (sinReceta.isNotEmpty) Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text('Sin receta vigente: ${sinReceta.join(', ')}', style: const TextStyle(fontSize: 12.5, color: TantaColors.stateDanger)),
                      ),
                      if (Api.instancia.puede('produccion.planificar')) ...[
                        const SizedBox(height: 10),
                        FilledButton(onPressed: filas.isEmpty || sinReceta.isNotEmpty || _ocupado ? null : _cerrarPedidos, child: const Text('Cerrar pedidos')),
                      ],
                    ])),
                    if (insumos.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const Text('Kárdex de insumos', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                        const Text('Se descarga al cerrar la producción', style: TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                        const SizedBox(height: 8),
                        for (final i in insumos) Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Row(children: [
                            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text('${i['insumo']}', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                              Text('Consumo ${_c(i['cantidad'] as num)} ${'${i['unidad']}'.toLowerCase()} · stock ${_c(_n(i['stock']))} · saldo ${_c(i['restante'] as num)}', style: const TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                              if (i['costoTotal'] != null)
                                Text('Costo unitario ${dinero(_n(i['costoUnitario']))} · total ${dinero(_n(i['costoTotal']))}', style: const TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                            ])),
                            Insignia(i['estado'] == 'NORMAL' ? 'Normal' : i['estado'] == 'ALERTA' ? 'Alerta' : 'Falta',
                                tono: i['estado'] == 'NORMAL' ? Tono.ok : i['estado'] == 'ALERTA' ? Tono.warn : Tono.danger, punto: true),
                          ]),
                        ),
                        if (insumos.any((i) => i['costoTotal'] != null)) ...[
                          const Divider(height: 18),
                          Row(children: [
                            const Expanded(child: Text('Costo total de insumos', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700))),
                            Text(dinero(insumos.fold<double>(0, (a, i) => a + _n(i['costoTotal']))), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                          ]),
                        ],
                      ])),
                    ],
                    if (_hojas.any((x) => x['estado'] == 'CERRADA')) ...[
                      const SizedBox(height: 14),
                      const Text('Producciones anteriores', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                      for (final x in _hojas.where((x) => x['estado'] == 'CERRADA').take(10))
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text('${x['codigo']}'),
                          subtitle: Text('${_dma('${x['fecha']}')} · ${_c(x['unidades'] as num)} unidades'),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => DetalleHoja(codigo: '${x['codigo']}'))),
                        ),
                    ],
                  ]),
                ),
    );
  }
}

/// Un lote: producción real por pan y cierre (entran los panes y se descargan los insumos).
class DetalleHoja extends StatefulWidget {
  const DetalleHoja({super.key, required this.codigo});
  final String codigo;
  @override
  State<DetalleHoja> createState() => _DetalleHojaState();
}

class _DetalleHojaState extends State<DetalleHoja> {
  Map<String, dynamic>? _d;
  String? _error;
  bool _ocupado = false;
  final _real = <String, TextEditingController>{};
  final _merma = <String, TextEditingController>{};
  double _num(TextEditingController? c) => double.tryParse((c?.text ?? '').replaceAll(',', '.')) ?? 0;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  @override
  void dispose() {
    for (final c in [..._real.values, ..._merma.values]) { c.dispose(); }
    super.dispose();
  }

  Future<void> _cargar() async {
    try {
      final d = await Api.instancia.detalleHoja(widget.codigo);
      for (final r in (d['resumen'] as List).cast<Map<String, dynamic>>()) {
        _real.putIfAbsent('${r['productoId']}', () => TextEditingController(text: _c((r['real'] ?? r['pedido']) as num)));
        _merma.putIfAbsent('${r['productoId']}', () => TextEditingController(text: '0'));
      }
      if (mounted) setState(() { _d = d; _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  Future<void> _cerrar() async {
    // Lo producido lejos de lo solicitado (200 pedidos, 2,080 producidos) se confirma antes de mover el almacén.
    final tol = _n(_d?['tolerancia']);
    final fuera = [
      for (final r in (_d!['resumen'] as List).cast<Map<String, dynamic>>())
        if (tol > 0 && _n(r['pedido']) > 0 && ((_num(_real['${r['productoId']}']) - _n(r['pedido'])).abs() / _n(r['pedido'])) > tol)
          '${r['producto']}: solicitado ${_c(r['pedido'] as num)}, producido ${_c(_num(_real['${r['productoId']}']))}',
    ];
    if (fuera.isNotEmpty) {
      final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
        title: const Text('Revisa lo producido'),
        content: Text('${fuera.join('\n')}\n\nSi la cantidad es correcta, graba así.'),
        actions: [
          AccionesDialogo(
            secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Corregir')),
            principal: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Grabar así')),
          ),
        ],
      ));
      if (ok != true || !mounted) return;
    }
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _ocupado = true);
    try {
      final r = await Api.instancia.cerrarProduccionHoja(widget.codigo, [
        for (final e in _real.entries) {'productoId': e.key, 'real': _num(e.value), 'merma': _num(_merma[e.key])},
      ], confirmar: fuera.isNotEmpty);
      await _cargar();
      final falta = (r['sinStock'] as List? ?? const []);
      aviso.showSnackBar(SnackBar(content: Text('Grabado: los panes entraron al almacén · ${r['listos']} pedido(s) listo(s)${falta.isEmpty ? '' : ' · sin stock: ${falta.join(', ')}'}'), backgroundColor: falta.isEmpty ? TantaColors.stateOk : TantaColors.stateWarn));
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: la producción no se grabó')));
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final clientes = (d?['clientes'] as List? ?? const []).cast<Map<String, dynamic>>();
    final filas = (d?['filas'] as List? ?? const []).cast<Map<String, dynamic>>();
    final resumen = (d?['resumen'] as List? ?? const []).cast<Map<String, dynamic>>();
    final abierta = d?['estado'] == 'EN_PRODUCCION';
    return Scaffold(
      appBar: AppBar(title: Text('${widget.codigo} - Tanta'), actions: [
        IconButton(tooltip: 'Exportar a Excel', icon: const Icon(Icons.ios_share), onPressed: filas.isEmpty ? null : () => compartirHoja('hoja-${widget.codigo.replaceAll(' ', '-')}', clientes, filas)),
      ]),
      body: _error != null
          ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar)
          : d == null
              ? const Esqueleto()
              : ListView(padding: EdgeInsets.fromLTRB(16, 16, 16, 24 + MediaQuery.of(context).viewPadding.bottom), children: [
                  Panel(child: _Matriz(clientes: clientes, filas: filas)),
                  const SizedBox(height: 14),
                  Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const Text('Resumen de lo producido', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                    if (abierta) const Text('Al grabar, los panes entran al almacén y se descargan los insumos', style: TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                    const SizedBox(height: 8),
                    for (final r in resumen) Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: abierta
                          ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Expanded(flex: 3, child: TextField(controller: _real['${r['productoId']}'], keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                  decoration: InputDecoration(labelText: '${r['producto']}', helperText: 'Solicitado: ${_c(r['pedido'] as num)}'))),
                              const SizedBox(width: 10),
                              Expanded(flex: 2, child: TextField(controller: _merma['${r['productoId']}'], keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                  decoration: const InputDecoration(labelText: 'Merma'))),
                            ])
                          : Row(children: [
                              Expanded(child: Text('${r['producto']}')),
                              Text('${_c((r['real'] ?? 0) as num)} de ${_c(r['pedido'] as num)}', style: const TextStyle(fontWeight: FontWeight.w600)),
                            ]),
                    ),
                    if (abierta && Api.instancia.puede('produccion.ejecutar'))
                      FilledButton(onPressed: _ocupado ? null : _cerrar, child: Text(_ocupado ? 'Grabando…' : 'Grabar producción')),
                    if (!abierta && (d['insumosPorComprar'] as List).isNotEmpty) ...[
                      const Divider(height: 22),
                      const Text('Insumos por comprar', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                      for (final i in (d['insumosPorComprar'] as List).cast<Map<String, dynamic>>())
                        Text('${i['insumo']}: faltan ${_c(_n(i['falta']))} ${'${i['unidad']}'.toLowerCase()}', style: const TextStyle(fontSize: 12.5, color: TantaColors.stateWarn)),
                    ],
                  ])),
                ]),
    );
  }
}
