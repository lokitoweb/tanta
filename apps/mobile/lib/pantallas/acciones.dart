import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/comprobante.dart';

/// Acciones de registro del PDF §3.2–3.3 que se hacen desde el teléfono o la tablet:
/// venta a terceros (vendedor), baja de inventario (almacén) y orden de producción.

List<Map<String, dynamic>> _lista(Map<String, dynamic> datos, String clave) =>
    ((datos[clave] as List?) ?? const []).cast<Map<String, dynamic>>();

String _mensaje(Object e) => e is ApiException ? e.mensaje : 'Sin conexión: intenta de nuevo';

/* ------------------------------------------------------------ nueva venta */
class NuevaVenta extends StatefulWidget {
  const NuevaVenta({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<NuevaVenta> createState() => _NuevaVentaState();
}

class _NuevaVentaState extends State<NuevaVenta> {
  final Map<String, int> _cant = {};
  String _forma = 'EFECTIVO';
  String? _cliente;
  final _descuento = TextEditingController(text: '0');
  final _referencia = TextEditingController();
  bool _enviando = false;
  // COB-02: con tarjeta, Yape, Plin o transferencia se registra el número de operación.
  bool get _conReferencia => _forma != 'EFECTIVO' && _forma != 'CREDITO';

  double get _total {
    final d = (double.tryParse(_descuento.text.replaceAll(',', '.')) ?? 0) / 100;
    return _lista(widget.datos, 'productos').fold<double>(0,
        (s, p) => s + (_cant[p['id']] ?? 0) * ((p['precioConIgv'] as num?)?.toDouble() ?? 0)) * (1 - d);
  }

  Future<void> _registrar() async {
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() => _enviando = true);
    try {
      final productos = _lista(widget.datos, 'productos');
      final r = await Api.instancia.registrarVenta(
        items: _cant.entries.where((e) => e.value > 0).map((e) => {'productoId': e.key, 'cantidad': e.value}).toList(),
        formaPago: _forma,
        clienteId: _cliente,
        descuentoPct: (double.tryParse(_descuento.text.replaceAll(',', '.')) ?? 0) / 100,
        referenciaPago: _conReferencia ? _referencia.text.trim() : '',
      );
      final comprobante = r['comprobante'] as Map<String, dynamic>?;
      final cliente = _lista(widget.datos, 'clientes').where((c) => c['id'] == _cliente).firstOrNull?['nombre'] ?? 'Público general';
      await compartirComprobante(
        titulo: 'Nota de venta', numero: '${comprobante?['numero'] ?? r['codigo']}', cliente: '$cliente', vendedor: Api.instancia.nombre, total: dinero(_total),
        lineas: [
          for (final e in _cant.entries.where((e) => e.value > 0))
            ('${e.value} × ${productos.firstWhere((p) => p['id'] == e.key)['nombre']}', ''),
        ],
      );
      aviso.showSnackBar(SnackBar(content: Text('Nota de venta ${comprobante?['numero'] ?? r['codigo']} registrada')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final productos = _lista(widget.datos, 'productos').where((p) => (p['stock'] as num? ?? 0) > 0).toList();
    final clientes = _lista(widget.datos, 'clientes');
    final hay = _cant.values.any((v) => v > 0);
    return Scaffold(
      appBar: AppBar(title: const Text('Nueva venta')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 120), children: [
        for (final p in productos)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('${p['nombre']}'),
            subtitle: Text('${dinero((p['precioConIgv'] as num).toDouble())} · stock ${p['stock']}'),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              IconButton(tooltip: 'Quitar', icon: const Icon(Icons.remove_circle_outline),
                  onPressed: (_cant[p['id']] ?? 0) > 0 ? () => setState(() => _cant[p['id']] = _cant[p['id']]! - 1) : null),
              SizedBox(width: 28, child: Text('${_cant[p['id']] ?? 0}', textAlign: TextAlign.center)),
              IconButton(tooltip: 'Agregar', icon: const Icon(Icons.add_circle_outline),
                  onPressed: (_cant[p['id']] ?? 0) < (p['stock'] as num) ? () => setState(() => _cant[p['id']] = (_cant[p['id']] ?? 0) + 1) : null),
            ]),
          ),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          initialValue: _forma,
          decoration: const InputDecoration(labelText: 'Forma de pago'),
          items: const ['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA', 'TRANSFERENCIA', 'CREDITO']
              .map((f) => DropdownMenuItem(value: f, child: Text(f == 'CREDITO' ? 'Crédito' : f[0] + f.substring(1).toLowerCase()))).toList(),
          onChanged: (v) => setState(() => _forma = v!),
        ),
        if (_conReferencia) ...[
          const SizedBox(height: 12),
          TextField(controller: _referencia, maxLength: 60, onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'N.° de operación')),
        ],
        const SizedBox(height: 12),
        DropdownButtonFormField<String?>(
          initialValue: _cliente,
          decoration: InputDecoration(labelText: _forma == 'CREDITO' ? 'Cliente (obligatorio)' : 'Cliente (opcional)'),
          items: [
            const DropdownMenuItem<String?>(value: null, child: Text('Público general')),
            for (final c in clientes) DropdownMenuItem<String?>(value: '${c['id']}', child: Text('${c['nombre']}')),
          ],
          onChanged: (v) => setState(() => _cliente = v),
        ),
        const SizedBox(height: 12),
        TextField(controller: _descuento, keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Descuento %', helperText: 'El tope lo fija el administrador')),
      ]),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            onPressed: !hay || _enviando || (_forma == 'CREDITO' && _cliente == null) || (_conReferencia && _referencia.text.trim().length < 3) ? null : _registrar,
            child: Text(_enviando ? 'Registrando…' : 'Cobrar ${dinero(_total)}'),
          ),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------- baja de inventario */
class BajaInventario extends StatefulWidget {
  const BajaInventario({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<BajaInventario> createState() => _BajaInventarioState();
}

class _BajaInventarioState extends State<BajaInventario> {
  bool _producto = false;
  String? _item;
  String _motivoTipo = 'MERMA';
  final _cantidad = TextEditingController();
  final _motivo = TextEditingController();
  bool _enviando = false;

  Future<void> _registrar() async {
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    final cantidad = double.tryParse(_cantidad.text.replaceAll(',', '.'));
    if (_item == null || cantidad == null || cantidad <= 0 || _motivo.text.trim().length < 3) {
      aviso.showSnackBar(const SnackBar(content: Text('Completa ítem, cantidad y motivo')));
      return;
    }
    setState(() => _enviando = true);
    try {
      await Api.instancia.registrarBaja(producto: _producto, id: _item!, cantidad: cantidad, motivoTipo: _motivoTipo, motivo: _motivo.text.trim());
      aviso.showSnackBar(const SnackBar(content: Text('Movimiento registrado en el kárdex')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _lista(widget.datos, _producto ? 'productos' : 'insumos');
    final motivos = _producto
        ? const {'MERMA': 'Merma', 'VENCIMIENTO': 'Vencimiento', 'DEVOLUCION': 'Devolución de cliente (suma stock)'}
        : const {'MERMA': 'Merma', 'VENCIMIENTO': 'Vencimiento', 'CONSUMO': 'Consumo', 'AJUSTE': 'Ajuste'};
    return Scaffold(
      appBar: AppBar(title: const Text('Registrar baja')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SegmentedButton<bool>(
          segments: const [ButtonSegment(value: false, label: Text('Insumo')), ButtonSegment(value: true, label: Text('Producto'))],
          selected: {_producto},
          onSelectionChanged: (s) => setState(() { _producto = s.first; _item = null; _motivoTipo = 'MERMA'; }),
        ),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          key: ValueKey(_producto),
          initialValue: _item,
          isExpanded: true,
          decoration: InputDecoration(labelText: _producto ? 'Producto' : 'Insumo'),
          items: [for (final i in items) DropdownMenuItem(value: '${i['id']}', child: Text('${i['nombre']} · stock ${i['stock']} ${i['unidad'] ?? ''}'))],
          onChanged: (v) => setState(() => _item = v),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          key: ValueKey('m$_producto'),
          initialValue: _motivoTipo,
          decoration: const InputDecoration(labelText: 'Motivo'),
          items: [for (final m in motivos.entries) DropdownMenuItem(value: m.key, child: Text(m.value))],
          onChanged: (v) => setState(() => _motivoTipo = v!),
        ),
        const SizedBox(height: 12),
        TextField(controller: _cantidad, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Cantidad')),
        const SizedBox(height: 12),
        TextField(controller: _motivo, maxLength: 200, decoration: const InputDecoration(labelText: 'Detalle (lote, OP, pedido o venta)')),
        const SizedBox(height: 8),
        FilledButton(onPressed: _enviando ? null : _registrar, child: Text(_enviando ? 'Registrando…' : 'Registrar')),
      ]),
    );
  }
}

/* --------------------------------------------------- orden de producción */
class NuevaOrden extends StatefulWidget {
  const NuevaOrden({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<NuevaOrden> createState() => _NuevaOrdenState();
}

class _NuevaOrdenState extends State<NuevaOrden> {
  String? _producto;
  final _cantidad = TextEditingController();
  DateTime _entrega = DateTime.now().add(const Duration(days: 1));
  String _criterio = 'LOTES_COMPLETOS';
  bool _enviando = false;

  Future<void> _crear() async {
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    final cantidad = double.tryParse(_cantidad.text.replaceAll(',', '.'));
    if (_producto == null || cantidad == null || cantidad <= 0) {
      aviso.showSnackBar(const SnackBar(content: Text('Elige producto y cantidad')));
      return;
    }
    setState(() => _enviando = true);
    try {
      final r = await Api.instancia.crearOrden(productoId: _producto!, cantidad: cantidad, entrega: _entrega.toIso8601String().substring(0, 10), criterio: _criterio);
      final calc = (r['calculo'] as Map?) ?? const {};
      final faltan = (r['insumosInsuficientes'] as List?) ?? const [];
      aviso.showSnackBar(SnackBar(content: Text(faltan.isEmpty
          ? 'Orden ${r['codigo']} · ${calc['lotes']} lotes, ${calc['unidadesObtenidas']} unidades. Requisición enviada a Almacén'
          : 'Orden ${r['codigo']} creada · faltan insumos: ${faltan.map((f) => f['insumo'] ?? f['nombre'] ?? '').join(', ')}')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nueva orden de producción')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        DropdownButtonFormField<String>(
          initialValue: _producto,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Producto'),
          items: [for (final p in _lista(widget.datos, 'productos')) DropdownMenuItem(value: '${p['id']}', child: Text('${p['nombre']}'))],
          onChanged: (v) => setState(() => _producto = v),
        ),
        const SizedBox(height: 12),
        TextField(controller: _cantidad, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Cantidad a producir')),
        const SizedBox(height: 12),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'LOTES_COMPLETOS', label: Text('Lotes completos')), ButtonSegment(value: 'PROPORCIONAL', label: Text('Proporcional'))],
          selected: {_criterio},
          onSelectionChanged: (v) => setState(() => _criterio = v.first),
        ),
        const SizedBox(height: 12),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.event_outlined),
          title: const Text('Entrega'),
          subtitle: Text(_entrega.toIso8601String().substring(0, 10)),
          onTap: () async {
            final hoy = DateTime.now();
            final f = await showDatePicker(context: context, initialDate: _entrega, firstDate: hoy, lastDate: hoy.add(const Duration(days: 60)));
            if (f != null) setState(() => _entrega = f);
          },
        ),
        const SizedBox(height: 8),
        FilledButton(onPressed: _enviando ? null : _crear, child: Text(_enviando ? 'Creando…' : 'Crear orden')),
      ]),
    );
  }
}

/* ------------------------------------------------ requisiciones de Almacén */
/// A18/A19: Almacén entrega a Producción los insumos de cada orden; el stock baja al confirmar.
class Requisiciones extends StatefulWidget {
  const Requisiciones({super.key});
  @override
  State<Requisiciones> createState() => _RequisicionesState();
}

class _RequisicionesState extends State<Requisiciones> {
  List<dynamic>? _lista;
  String? _error;

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.requisiciones();
      if (mounted) setState(() { _lista = l; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _entregar(Map<String, dynamic> r) async {
    final lineas = ((r['lineas'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final ctrls = {for (final l in lineas) l['insumoId'] as String: TextEditingController(text: '${((l['solicitada'] as num) - (l['entregada'] as num)).clamp(0, double.infinity)}')};
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text('Entregar ${r['codigo']}'),
      content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('${r['op']} · ${r['producto']}'),
        const SizedBox(height: 12),
        for (final l in lineas) Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: TextField(controller: ctrls[l['insumoId']], keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: '${l['insumo']} (${l['unidad']})', helperText: 'Pide ${l['solicitada']} · stock ${l['stock']}')),
        ),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Confirmar entrega')),
      ],
    ));
    if (ok != true || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      final res = await Api.instancia.atenderRequisicion('${r['codigo']}', [
        for (final l in lineas) {'insumoId': l['insumoId'], 'cantidad': double.tryParse(ctrls[l['insumoId']]!.text.replaceAll(',', '.')) ?? 0},
      ]);
      aviso.showSnackBar(SnackBar(content: Text('${r['codigo']}: ${res['estado'] == 'ATENDIDA' ? 'atendida' : 'atendida en parte'}')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final lista = (_lista ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Requisiciones')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text(_error!))])
            : _lista == null
                ? const Center(child: CircularProgressIndicator())
                : lista.isEmpty
                    ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('Sin requisiciones por atender'))])
                    : ListView.separated(
                        itemCount: lista.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final r = lista[i];
                          return ListTile(
                            title: Text('${r['producto']}'),
                            subtitle: Text('${r['codigo']} · ${r['op']} · ${(r['lineas'] as List).length} insumos'),
                            trailing: Text(r['estado'] == 'PARCIAL' ? 'Parcial' : 'Pendiente'),
                            onTap: () => _entregar(r),
                          );
                        },
                      ),
      ),
    );
  }
}

/* ------------------------------------------------------ conteo físico */
/// M05: conteo contra el sistema; las diferencias se ajustan solo con la aprobación del Gerente.
class Conteos extends StatefulWidget {
  const Conteos({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<Conteos> createState() => _ConteosState();
}

class _ConteosState extends State<Conteos> {
  List<dynamic>? _conteos;
  String? _error;

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.conteos();
      if (mounted) setState(() { _conteos = l; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _nuevo() async {
    final insumos = _lista(widget.datos, 'insumos');
    final ctrls = {for (final i in insumos) '${i['id']}': TextEditingController()};
    final obs = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: const Text('Nuevo conteo'),
      content: SizedBox(width: double.maxFinite, child: ListView(shrinkWrap: true, children: [
        const Text('Deja en blanco lo que no contaste.'),
        for (final i in insumos) TextField(controller: ctrls['${i['id']}'], keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: '${i['nombre']} (${i['unidad']})', helperText: 'Sistema: ${i['stock']}')),
        TextField(controller: obs, maxLength: 200, decoration: const InputDecoration(labelText: 'Observación')),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Enviar a aprobación')),
      ],
    ));
    if (ok != true || !mounted) return;
    final items = [
      for (final e in ctrls.entries)
        if (double.tryParse(e.value.text.replaceAll(',', '.')) case final v? when v >= 0) {'insumoId': e.key, 'contado': v},
    ];
    if (items.isEmpty) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      final r = await Api.instancia.registrarConteo(items, obs.text.trim());
      aviso.showSnackBar(SnackBar(content: Text('${r['codigo']} enviado con ${r['diferencias']} diferencia(s)')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  Future<void> _ver(Map<String, dynamic> k) async {
    final items = ((k['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final aprueba = k['estado'] == 'PENDIENTE' && Api.instancia.puede('conteo.aprobar');
    final motivo = TextEditingController();
    final r = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text('${k['codigo']} · ${'${k['estado']}'.toLowerCase()}'),
      content: SizedBox(width: double.maxFinite, child: ListView(shrinkWrap: true, children: [
        for (final i in items) ListTile(dense: true, contentPadding: EdgeInsets.zero,
            title: Text('${i['insumo']}'),
            subtitle: Text('Sistema ${i['sistema']} · contado ${i['contado']}'),
            trailing: Text((i['diferencia'] as num).abs() < 0.0005 ? 'OK' : '${i['diferencia']}')),
        if (aprueba) TextField(controller: motivo, decoration: const InputDecoration(labelText: 'Motivo (solo para rechazar)')),
      ])),
      actions: aprueba
          ? [
              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Rechazar')),
              FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Aprobar y ajustar')),
            ]
          : [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar'))],
    ));
    if (!aprueba || r == null || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      final res = await Api.instancia.resolverConteo('${k['id']}', r, motivo: motivo.text.trim());
      aviso.showSnackBar(SnackBar(content: Text(r ? '${k['codigo']} aprobado: ${res['ajustes']} ajuste(s)' : '${k['codigo']} rechazado')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final lista = (_conteos ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Conteo físico')),
      floatingActionButton: Api.instancia.puede('inventario.mover')
          ? FloatingActionButton.extended(onPressed: _nuevo, icon: const Icon(Icons.add), label: const Text('Nuevo conteo'))
          : null,
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text(_error!))])
            : _conteos == null
                ? const Center(child: CircularProgressIndicator())
                : lista.isEmpty
                    ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('Sin conteos registrados'))])
                    : ListView.separated(
                        itemCount: lista.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final k = lista[i];
                          return ListTile(
                            title: Text('${k['codigo']} · ${k['registradoPor']}'),
                            subtitle: Text('${(k['items'] as List).length} insumos'),
                            trailing: Text('${k['estado']}'.toLowerCase()),
                            onTap: () => _ver(k),
                          );
                        },
                      ),
      ),
    );
  }
}

/* ------------------------------------------------------ mis pedidos */
/// A08/A09: historial del cliente con estado y cancelación antes de producir (PED-07).
class MisPedidos extends StatefulWidget {
  const MisPedidos({super.key});
  @override
  State<MisPedidos> createState() => _MisPedidosState();
}

class _MisPedidosState extends State<MisPedidos> {
  List<dynamic>? _lista;
  static const _etiqueta = {'REGISTRADO': 'Por confirmar', 'CONFIRMADO': 'Confirmado', 'EN_PRODUCCION': 'En producción', 'LISTO': 'Listo para entregar',
    'DESPACHADO': 'En camino', 'ENTREGADO': 'Entregado', 'RECHAZADO': 'Rechazado', 'CANCELADO': 'Cancelado'};

  Future<void> _cargar() async {
    try { final l = await Api.instancia.misPedidos(); if (mounted) setState(() => _lista = l); } catch (_) { if (mounted) setState(() => _lista = const []); }
  }

  @override
  void initState() { super.initState(); _cargar(); }

  Future<void> _cancelar(Map<String, dynamic> p) async {
    final c = TextEditingController();
    final motivo = await showDialog<String>(context: context, builder: (_) => AlertDialog(
      title: Text('Cancelar ${p['codigo']}'),
      content: TextField(controller: c, autofocus: true, maxLength: 200, decoration: const InputDecoration(labelText: 'Motivo')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Volver')),
        FilledButton(onPressed: () { if (c.text.trim().length >= 3) Navigator.pop(context, c.text.trim()); }, child: const Text('Cancelar pedido')),
      ],
    ));
    if (motivo == null || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      await Api.instancia.cancelarPedido('${p['codigo']}', motivo);
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = (_lista ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Mis pedidos')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _lista == null
            ? const Center(child: CircularProgressIndicator())
            : l.isEmpty
                ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('Aún no tienes pedidos'))])
                : ListView.separated(
                    itemCount: l.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final p = l[i];
                      final cancelable = p['estado'] == 'REGISTRADO' || p['estado'] == 'CONFIRMADO';
                      return ListTile(
                        title: Text('${p['codigo']} · ${dinero(((p['total'] as num?) ?? 0).toDouble())}'),
                        subtitle: Text('${_etiqueta[p['estado']] ?? p['estado']} · entrega ${p['fecha_entrega']}${p['tipoEntrega'] == 'DELIVERY' ? ' · delivery' : ''}'),
                        trailing: cancelable ? TextButton(onPressed: () => _cancelar(p), child: const Text('Cancelar')) : null,
                      );
                    },
                  ),
      ),
    );
  }
}
