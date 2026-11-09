import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

String _c(Object? v) { final n = (v as num?) ?? num.tryParse('$v') ?? 0; return n == n.roundToDouble() ? '${n.toInt()}' : n.toStringAsFixed(2); }

/// Despacho: pedidos listos por empacar, carga a la móvil («En tránsito») y vehículos.
class Despacho extends StatefulWidget {
  const Despacho({super.key});
  @override
  State<Despacho> createState() => _DespachoState();
}

class _DespachoState extends State<Despacho> {
  Map<String, dynamic>? _datos;
  String? _error;
  String? _ocupado;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    try {
      final d = await Api.instancia.despacho();
      if (mounted) setState(() { _datos = d; _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  List<Map<String, dynamic>> _lista(String clave) => (_datos?[clave] as List? ?? const []).cast<Map<String, dynamic>>();
  List<Map<String, dynamic>> get _activos => _lista('vehiculos').where((v) => v['activo'] == true).toList();

  void _aviso(String t, {Color? color}) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t), backgroundColor: color));

  Future<void> _cargarAMovil(Map<String, dynamic> p) async {
    if (_activos.isEmpty) return _aviso('Primero registra un vehículo');
    final elegido = await showModalBottomSheet<(String, Map<String, double>)>(context: context, isScrollControlled: true, useSafeArea: true,
        builder: (_) => _HojaCarga(pedido: p, vehiculos: _activos, empaques: _lista('empaques')));
    if (elegido == null || !mounted) return;
    setState(() => _ocupado = '${p['codigo']}');
    try {
      final items = (p['items'] as List).cast<Map<String, dynamic>>();
      await Api.instancia.despacharPedido(
        pedidoId: '${p['id']}', vehiculoId: elegido.$1,
        items: [for (final i in items)
          if ('${i['presentacion'] ?? ''}'.isNotEmpty && i['cantidadPresentacion'] != null)
            {'productoId': i['productoId'], 'cantidad': i['cantidadPresentacion'], 'presentacion': i['presentacion']}
          else
            {'productoId': i['productoId'], 'cantidad': i['cantidad']}],
        empaques: [for (final e in elegido.$2.entries) if (e.value > 0) {'insumoId': e.key, 'cantidad': e.value}],
      );
      await _cargar();
      if (mounted) _aviso('${p['codigo']} en tránsito', color: TantaColors.stateOk);
    } on ApiException catch (e) {
      if (mounted) _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      if (mounted) _aviso('Sin conexión: el despacho necesita internet');
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  Future<void> _vehiculo([Map<String, dynamic>? v]) async {
    final placa = TextEditingController(text: '${v?['placa'] ?? ''}');
    final descripcion = TextEditingController(text: '${v?['descripcion'] ?? ''}');
    final conductor = TextEditingController(text: '${v?['conductor'] ?? ''}');
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text(v == null ? 'Nuevo vehículo' : 'Editar vehículo'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: placa, maxLength: 12, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Placa', counterText: '')),
        TextField(controller: descripcion, maxLength: 80, decoration: const InputDecoration(labelText: 'Descripción', counterText: '')),
        TextField(controller: conductor, maxLength: 80, decoration: const InputDecoration(labelText: 'Conductor', counterText: '')),
      ]),
      actions: [
        AccionesDialogo(
          secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          principal: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Guardar')),
        ),
      ],
    ));
    final datos = {'placa': placa.text.trim(), 'descripcion': descripcion.text.trim(), 'conductor': conductor.text.trim(), 'activo': v?['activo'] ?? true};
    placa.dispose(); descripcion.dispose(); conductor.dispose();
    if (ok != true) return;
    try {
      await Api.instancia.guardarVehiculo(v == null ? null : '${v['id']}', datos);
      await _cargar();
    } on ApiException catch (e) {
      if (mounted) _aviso(e.mensaje, color: TantaColors.stateDanger);
    } catch (_) {
      if (mounted) _aviso('Sin conexión: intenta de nuevo');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null || _datos == null) {
      return RefreshIndicator(onRefresh: _cargar, child: ListView(children: [
        _error != null ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar) : const Esqueleto(),
      ]));
    }
    final gestiona = Api.instancia.puede('despacho.gestionar');
    final pedidos = _lista('pedidos');
    final listos = pedidos.where((p) => p['estado'] == 'LISTO').toList();
    final transito = pedidos.where((p) => p['estado'] == 'DESPACHADO').toList();
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 32), children: [
        const Text('Por despachar', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        if (listos.isEmpty) const VacioMensaje('No hay pedidos listos', icono: Icons.inventory_2_outlined),
        for (final p in listos) Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${p['codigo']} · ${p['cliente']}', style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
            if ('${p['direccion'] ?? ''}'.isNotEmpty) Text('${p['direccion']}', style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
            const SizedBox(height: 4),
            Text((p['items'] as List).cast<Map<String, dynamic>>().map((i) => '${_c(i['cantidad'])} · ${i['producto']}').join('\n'), style: const TextStyle(fontSize: 12.5)),
            if (gestiona) ...[
              const SizedBox(height: 8),
              FilledButton.icon(onPressed: _ocupado == null ? () => _cargarAMovil(p) : null, icon: const Icon(Icons.local_shipping_outlined, size: 18), label: const Text('Cargar a móvil')),
            ],
          ])),
        ),
        const SizedBox(height: 10),
        const Text('En tránsito', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        if (transito.isEmpty) const VacioMensaje('Nada en tránsito', icono: Icons.local_shipping_outlined),
        for (final p in transito) ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${p['codigo']} · ${p['cliente']}'),
          subtitle: Text('Móvil ${p['vehiculo'] ?? 'sin asignar'}'),
          trailing: const Insignia('En tránsito', tono: Tono.info, punto: true),
        ),
        const SizedBox(height: 10),
        Row(children: [
          const Expanded(child: Text('Vehículos', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700))),
          if (gestiona) TextButton.icon(onPressed: _vehiculo, icon: const Icon(Icons.add, size: 18), label: const Text('Agregar')),
        ]),
        for (final v in _lista('vehiculos')) ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${v['placa']}'),
          subtitle: Text([v['descripcion'], v['conductor']].where((x) => '$x'.isNotEmpty).join(' · ')),
          trailing: gestiona ? const Icon(Icons.edit_outlined, size: 18) : null,
          onTap: gestiona ? () => _vehiculo(v) : null,
        ),
      ]),
    );
  }
}

/// Vehículo y materiales de empaque usados en el pedido.
class _HojaCarga extends StatefulWidget {
  const _HojaCarga({required this.pedido, required this.vehiculos, required this.empaques});
  final Map<String, dynamic> pedido;
  final List<Map<String, dynamic>> vehiculos;
  final List<Map<String, dynamic>> empaques;
  @override
  State<_HojaCarga> createState() => _HojaCargaState();
}

class _HojaCargaState extends State<_HojaCarga> {
  late String? _vehiculo = widget.vehiculos.length == 1 ? '${widget.vehiculos.first['id']}' : null;
  final _cantidades = <String, double>{};

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(20, 16, 20, 16 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Cargar ${widget.pedido['codigo']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _vehiculo,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Vehículo'),
            items: [for (final v in widget.vehiculos) DropdownMenuItem(value: '${v['id']}', child: Text('${v['placa']} ${v['descripcion']}'))],
            onChanged: (v) => setState(() => _vehiculo = v),
          ),
          for (final e in widget.empaques) Padding(
            padding: const EdgeInsets.only(top: 10),
            child: TextField(
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: '${e['nombre']}', helperText: 'Hay ${_c(e['stock'])} ${'${e['unidad']}'.toLowerCase()}'),
              onChanged: (t) => _cantidades['${e['id']}'] = double.tryParse(t.replaceAll(',', '.')) ?? 0,
            ),
          ),
          const SizedBox(height: 14),
          FilledButton(onPressed: _vehiculo == null ? null : () => Navigator.pop(context, (_vehiculo!, _cantidades)), child: const Text('Cargar: pasa a En tránsito')),
        ])),
      );
}
