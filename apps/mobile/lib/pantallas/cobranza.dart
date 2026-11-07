import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/cola.dart';
import '../core/comprobante.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

double _d(Object? v) => (v as num?)?.toDouble() ?? 0;

/// Cuentas abiertas de un cliente (de la más antigua a la más nueva, como las devuelve el servidor).
class _Deudor {
  _Deudor(this.id, this.nombre);
  final String id;
  final String nombre;
  final docs = <Map<String, dynamic>>[];
  double get saldo => docs.fold(0, (s, c) => s + _d(c['saldo']));
  int get vencidas => docs.where((c) => c['vencida'] == true).length;
  int get maxDias => docs.fold(0, (m, c) => c['vencida'] == true && (c['diasVencido'] as num).toInt() > m ? (c['diasVencido'] as num).toInt() : m);
}

/// Cobranza: cartera agrupada por cliente. Se cobra todo lo del cliente o las compras marcadas,
/// con una o varias formas de pago; un pago parcial deja la compra en la lista con lo que falta.
class Cobranza extends StatefulWidget {
  const Cobranza({super.key});
  @override
  State<Cobranza> createState() => _CobranzaState();
}

class _CobranzaState extends State<Cobranza> {
  List<Map<String, dynamic>>? _cuentas;
  String? _error;
  final _abiertos = <String>{};
  final _marcadas = <String>{}; // ids de las compras elegidas para cobrar
  int _version = 0;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    try {
      final r = await Api.instancia.cartera();
      if (!mounted) return;
      setState(() { _cuentas = r.cast<Map<String, dynamic>>(); _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  List<_Deudor> get _deudores {
    final m = <String, _Deudor>{};
    for (final c in _cuentas ?? const <Map<String, dynamic>>[]) {
      if (_d(c['saldo']) <= 0.001) continue;
      final id = '${c['clienteId'] ?? c['cliente']}';
      m.putIfAbsent(id, () => _Deudor(id, '${c['cliente']}')).docs.add(c);
    }
    // Primero quien tiene la deuda más vencida.
    return m.values.toList()..sort((a, b) => b.maxDias != a.maxDias ? b.maxDias.compareTo(a.maxDias) : b.saldo.compareTo(a.saldo));
  }

  Future<void> _cobrar(_Deudor d, List<Map<String, dynamic>> docs) async {
    final debe = docs.fold<double>(0, (s, c) => s + _d(c['saldo']));
    final cobro = await mostrarHojaCobro(context, cliente: d.nombre, detalle: docs.length == 1 ? '${docs.first['documento'] ?? 'Compra'}' : '${docs.length} compras', debe: debe, otras: d.saldo - debe);
    if (cobro == null || cobro.pagos.isEmpty || !mounted) return;
    final pagos = cobro.pagos;
    final monto = pagos.fold<double>(0, (s, p) => s + _d(p['monto']));
    // Lo que el cliente sigue debiendo, contando las compras que no entraron en este cobro.
    final queda = d.saldo - monto;
    final aviso = ScaffoldMessenger.of(context);
    final datos = {
      'clienteId': d.id,
      'cxcIds': [for (final c in docs) '${c['id']}'],
      'pagos': pagos,
    };
    final clave = ColaOffline.instancia.nuevaClave();
    final textoQueda = queda > 0.009 ? ' · queda ${dinero(queda)} por cobrar' : ' · cuenta saldada';

    try {
      // En línea: se registra al instante y hay número de recibo real.
      final r = await Api.instancia.registrarRecibo(datos, claveIdempotencia: clave);
      await _cargar();
      setState(() { _version++; _marcadas.removeAll(datos['cxcIds'] as List<String>); });
      aviso.showSnackBar(SnackBar(
        content: Text('Pago de ${dinero(monto)} registrado$textoQueda'),
        backgroundColor: TantaColors.stateOk,
        duration: const Duration(seconds: 6),
        persist: false, // con botón también se cierra solo
        action: SnackBarAction(
          label: 'Recibo PDF',
          textColor: Colors.white,
          onPressed: () => compartirComprobante(
            titulo: 'Recibo de cobro',
            numero: '${r['numero']}',
            cliente: d.nombre,
            lineas: lineasRecibo(pagos, queda),
            total: dinero(monto),
            vendedor: Api.instancia.nombre,
          ),
        ),
      ));
    } on ApiException catch (e) {
      if (e.esDefinitivo) {
        aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
        return;
      }
      await _guardarSinRed(d, docs, datos, clave, monto, textoQueda);
    } catch (_) {
      // Sin red: la misma clave viaja en la cola, así el cobro nunca se duplica.
      await _guardarSinRed(d, docs, datos, clave, monto, textoQueda);
    }
  }

  Future<void> _guardarSinRed(_Deudor d, List<Map<String, dynamic>> docs, Map<String, dynamic> datos, String clave, double monto, String textoQueda) async {
    await ColaOffline.instancia.encolar('recibo', {...datos, 'cliente': d.nombre},
        descripcion: 'Cobro ${dinero(monto)} · ${d.nombre}', clave: clave);
    if (!mounted) return;
    // Se descuenta en pantalla (más antiguas primero, como el servidor) para no cobrar dos veces.
    setState(() {
      _marcadas.removeAll(datos['cxcIds'] as List<String>);
      var resto = monto;
      for (final c in docs) {
        final aplica = resto < _d(c['saldo']) ? resto : _d(c['saldo']);
        c['saldo'] = _d(c['saldo']) - aplica;
        c['pagado'] = _d(c['pagado']) + aplica;
        c['pendiente'] = true;
        resto -= aplica;
      }
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('Sin conexión · cobro de ${dinero(monto)} guardado$textoQueda'),
      backgroundColor: TantaColors.stateWarn,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final cuentas = _cuentas;
    if (_error != null || cuentas == null) {
      return RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(children: [
          _error != null ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar) : const Esqueleto(),
        ]),
      );
    }
    final deudores = _deudores;
    final total = deudores.fold<double>(0, (s, d) => s + d.saldo);
    final vencidos = deudores.where((d) => d.vencidas > 0).length;
    final puedeCobrar = Api.instancia.puede('cobranza.registrar');

    return RefreshIndicator(
      onRefresh: () async { await _cargar(); setState(() => _version++); },
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          Panel(
            child: Row(children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Total por cobrar', style: TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                const SizedBox(height: 2),
                Text(dinero(total), style: estiloDisplay.copyWith(fontSize: 26)),
              ])),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text('${deudores.length} ${deudores.length == 1 ? 'cliente' : 'clientes'}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                Text('$vencidos con deuda vencida', style: TextStyle(fontSize: 11.5, color: vencidos > 0 ? TantaColors.stateDanger : TantaColors.textMuted)),
              ]),
            ]),
          ),
          const SizedBox(height: 14),
          if (puedeCobrar) ...[MiDia(key: ValueKey(_version)), const SizedBox(height: 14)],
          if (deudores.isEmpty) const VacioMensaje('No hay cuentas por cobrar', icono: Icons.account_balance_wallet_outlined),
          for (final d in deudores) _tarjeta(d, puedeCobrar),
        ],
      ),
    );
  }

  Widget _tarjeta(_Deudor d, bool puedeCobrar) {
    final abierto = _abiertos.contains(d.id);
    final n = d.docs.length;
    final marcadas = d.docs.where((c) => _marcadas.contains('${c['id']}')).toList();
    final suma = marcadas.fold<double>(0, (s, c) => s + _d(c['saldo']));
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        padding: EdgeInsets.zero,
        child: Column(children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => abierto ? _abiertos.remove(d.id) : _abiertos.add(d.id)),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
              child: Row(children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(d.nombre, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(
                    '$n ${n == 1 ? 'compra' : 'compras'} por pagar${d.vencidas > 0 ? ' · ${d.vencidas} vencida${d.vencidas == 1 ? '' : 's'} (hasta ${d.maxDias} d)' : ''}',
                    style: TextStyle(fontSize: 11.5, color: d.vencidas > 0 ? TantaColors.stateDanger : TantaColors.textMuted),
                  ),
                ])),
                Text(dinero(d.saldo), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                Icon(abierto ? Icons.expand_less : Icons.expand_more, color: TantaColors.textMuted),
              ]),
            ),
          ),
          if (abierto) ...[
            const Divider(height: 1),
            if (puedeCobrar && n > 1)
              const Padding(
                padding: EdgeInsets.fromLTRB(14, 10, 14, 0),
                child: Text('Marca las compras que va a pagar. Sin marcar se cobra todo.', style: TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
              ),
            for (final c in d.docs) _documento(d, c, puedeCobrar),
          ],
          if (puedeCobrar)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: TantaColors.ink800, minimumSize: const Size.fromHeight(40)),
                onPressed: () => _cobrar(d, marcadas.isEmpty ? d.docs : marcadas),
                icon: const Icon(Icons.payments_outlined, size: 18),
                label: Text(marcadas.isNotEmpty ? 'Cobrar ${dinero(suma)} (${marcadas.length} de $n)' : n == 1 ? 'Cobrar' : 'Cobrar al cliente'),
              ),
            ),
        ]),
      ),
    );
  }

  Widget _documento(_Deudor d, Map<String, dynamic> c, bool puedeCobrar) {
    final vencida = c['vencida'] == true;
    final pagado = _d(c['pagado']);
    final parcial = pagado > 0.009;
    final id = '${c['id']}';
    final elegible = puedeCobrar && d.docs.length > 1;
    void marcar() => setState(() => _marcadas.contains(id) ? _marcadas.remove(id) : _marcadas.add(id));
    return InkWell(
      onTap: elegible ? marcar : null,
      child: Padding(
      padding: EdgeInsets.fromLTRB(elegible ? 4 : 14, 10, 14, 10),
      child: Row(children: [
        if (elegible) Checkbox(value: _marcadas.contains(id), onChanged: (_) => marcar()),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Flexible(child: Text('${c['documento'] ?? 'Compra'}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600))),
            const SizedBox(width: 6),
            if (c['pendiente'] == true) const Insignia('Por enviar', tono: Tono.warn)
            else if (parcial) const Insignia('Pago parcial', tono: Tono.info),
          ]),
          const SizedBox(height: 2),
          Text('vence ${fechaCorta('${c['venceEn']}')}${vencida ? ' · ${c['diasVencido']} días vencida' : ''}',
              style: TextStyle(fontSize: 11.5, color: vencida ? TantaColors.stateDanger : TantaColors.textMuted)),
          if (parcial)
            Text('Total ${dinero(_d(c['monto']))} · pagado ${dinero(pagado)}',
                style: const TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
        ])),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(dinero(_d(c['saldo'])), style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
          if (parcial) const Text('queda', style: TextStyle(fontSize: 10.5, color: TantaColors.textMuted)),
        ]),
      ]),
    ),
    );
  }
}

/// Resultado de la hoja: las formas de pago (vacío = no pagó, queda como deuda) y una nota opcional.
class Cobro {
  const Cobro(this.pagos, this.nota);
  final List<Map<String, dynamic>> pagos;
  final String nota;
  double get monto => pagos.fold(0, (s, p) => s + _d(p['monto']));
}

/// Líneas del recibo PDF: cada forma de pago y, si queda, el saldo pendiente.
List<(String, String)> lineasRecibo(List<Map<String, dynamic>> pagos, double queda) => [
      for (final p in pagos) ('Pago ${'${p['medio']}'.toLowerCase()}${'${p['referencia'] ?? ''}'.isEmpty ? '' : ' · op. ${p['referencia']}'}', dinero(_d(p['monto']))),
      if (queda > 0.009) ('Saldo pendiente', dinero(queda)),
    ];

/// Abre la hoja de cobro. Con [alEntregar] ofrece «No pagó» y la nota de la entrega (quién recibió).
/// [otras]: lo que el cliente debe fuera de este cobro; sigue pendiente aunque este se pague completo.
Future<Cobro?> mostrarHojaCobro(BuildContext context, {required String cliente, required String detalle, required double debe, double otras = 0, bool alEntregar = false}) =>
    showModalBottomSheet<Cobro>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => HojaCobro(cliente: cliente, detalle: detalle, debe: debe, otras: otras, alEntregar: alEntregar),
    );

/// Formulario del cobro: una o varias formas de pago (p. ej. efectivo + Yape) que suman lo que se cobra.
class HojaCobro extends StatefulWidget {
  const HojaCobro({super.key, required this.cliente, required this.detalle, required this.debe, this.otras = 0, this.alEntregar = false});
  final String cliente;
  final String detalle;
  final double debe;
  final double otras;
  final bool alEntregar;
  @override
  State<HojaCobro> createState() => _HojaCobroState();
}

class _Linea {
  _Linea(this.medio, double monto) : monto = TextEditingController(text: monto > 0 ? monto.toStringAsFixed(2) : '');
  String medio;
  final TextEditingController monto;
  final referencia = TextEditingController();
  double get valor => double.tryParse(monto.text.replaceAll(',', '.')) ?? 0;
}

class _HojaCobroState extends State<HojaCobro> {
  final _medios = mediosPago('enCobranza');
  final _nota = TextEditingController();
  late final List<_Linea> _lineas = [_Linea('${_medios.first['codigo']}', widget.debe)];

  double get _suma => _lineas.fold(0, (s, l) => s + l.valor);

  String? get _problema {
    if (_lineas.any((l) => l.valor <= 0)) return 'Indica el monto de cada forma de pago';
    if (_suma > widget.debe + 0.009) return 'Supera lo que debe (${dinero(widget.debe)})';
    final sinOp = _lineas.where((l) => requiereOperacion(l.medio) && l.referencia.text.trim().length < 3);
    if (sinOp.isNotEmpty) return 'Falta el N.° de operación de ${nombreMedio(sinOp.first.medio)}';
    return null;
  }

  String nombreMedio(String codigo) => '${_medios.where((m) => m['codigo'] == codigo).firstOrNull?['nombre'] ?? codigo}';

  void _agregar() {
    final resto = widget.debe - _suma;
    // La nueva forma de pago propone lo que falta y otro medio distinto al primero.
    final otro = _medios.map((m) => '${m['codigo']}').firstWhere((c) => !_lineas.any((l) => l.medio == c), orElse: () => '${_medios.first['codigo']}');
    setState(() => _lineas.add(_Linea(otro, resto > 0 ? resto : 0)));
  }

  @override
  Widget build(BuildContext context) {
    final queda = widget.debe + widget.otras - _suma;
    final problema = _problema;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 16 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(child: Text(widget.alEntregar ? 'Entregar y cobrar' : 'Registrar pago', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
            IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close), tooltip: 'Cerrar'),
          ]),
          Text(widget.cliente, style: const TextStyle(fontWeight: FontWeight.w600)),
          Text('${widget.detalle} · debe ${dinero(widget.debe)}', style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
          const SizedBox(height: 14),
          for (var i = 0; i < _lineas.length; i++) _linea(i),
          if (_lineas.length < 5)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(onPressed: _agregar, icon: const Icon(Icons.add, size: 18), label: const Text('Agregar otra forma de pago')),
            ),
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: TantaColors.cream100, borderRadius: BorderRadius.circular(8)),
            child: Column(children: [
              _fila('Cobras', dinero(_suma), negrita: true),
              const SizedBox(height: 4),
              _fila(queda > 0.009 ? 'Queda por cobrar' : 'Queda', queda > 0.009 ? dinero(queda) : 'Cuenta saldada',
                  color: queda > 0.009 ? TantaColors.stateWarn : TantaColors.stateOk),
            ]),
          ),
          if (problema != null) ...[
            const SizedBox(height: 8),
            Text(problema, style: const TextStyle(fontSize: 12.5, color: TantaColors.stateDanger)),
          ],
          if (widget.alEntregar) ...[
            const SizedBox(height: 12),
            TextField(controller: _nota, maxLength: 200, decoration: const InputDecoration(labelText: 'Nota de la entrega (opcional)', hintText: 'Quién recibió, hora…', counterText: '')),
          ],
          const SizedBox(height: 14),
          FilledButton(
            onPressed: problema != null
                ? null
                : () => Navigator.pop(context, Cobro([
                      for (final l in _lineas)
                        {'monto': double.parse(l.valor.toStringAsFixed(2)), 'medio': l.medio, 'referencia': l.referencia.text.trim()},
                    ], _nota.text.trim())),
            child: Text(widget.alEntregar ? 'Entregar y cobrar ${dinero(_suma)}' : 'Cobrar ${dinero(_suma)}'),
          ),
          // «Te pago mañana»: se entrega y todo queda como deuda en Cobranza.
          if (widget.alEntregar) ...[
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => Navigator.pop(context, Cobro(const [], _nota.text.trim())),
              child: const Text('No pagó: entregar y dejar como deuda'),
            ),
          ],
        ]),
      ),
    );
  }

  Widget _fila(String a, String b, {bool negrita = false, Color? color}) => Row(children: [
        Expanded(child: Text(a, style: const TextStyle(fontSize: 13, color: TantaColors.textMuted))),
        Text(b, style: TextStyle(fontSize: 14, fontWeight: negrita ? FontWeight.w700 : FontWeight.w600, color: color)),
      ]);

  Widget _linea(int i) {
    final l = _lineas[i];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            flex: 5,
            child: DropdownButtonFormField<String>(
              initialValue: l.medio,
              isExpanded: true,
              decoration: InputDecoration(labelText: _lineas.length > 1 ? 'Forma de pago ${i + 1}' : 'Forma de pago'),
              items: [for (final m in _medios) DropdownMenuItem(value: '${m['codigo']}', child: Text('${m['nombre']}'))],
              onChanged: (v) => setState(() => l.medio = v ?? l.medio),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 4,
            child: TextField(
              controller: l.monto,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Monto', prefixText: 'S/ '),
              onChanged: (_) => setState(() {}),
            ),
          ),
          if (_lineas.length > 1)
            IconButton(tooltip: 'Quitar', onPressed: () => setState(() => _lineas.removeAt(i)), icon: const Icon(Icons.close, size: 20)),
        ]),
        if (requiereOperacion(l.medio)) ...[
          const SizedBox(height: 8),
          TextField(
            controller: l.referencia,
            maxLength: 60,
            decoration: InputDecoration(labelText: 'N.° de operación (${nombreMedio(l.medio)})', counterText: ''),
            onChanged: (_) => setState(() {}),
          ),
        ],
      ]),
    );
  }
}

/// Caja del vendedor (cada día empieza en cero): lo cobrado hoy por forma de pago y la rendición a caja.
class MiDia extends StatefulWidget {
  const MiDia({super.key});
  @override
  State<MiDia> createState() => _MiDiaState();
}

class _MiDiaState extends State<MiDia> {
  Map<String, dynamic>? _dia;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    try {
      final d = await Api.instancia.miDia();
      if (mounted) setState(() => _dia = d);
    } catch (_) {/* sin red: la tarjeta no se muestra */}
  }

  String _nombre(String medio) => '${medioPago(medio)?['nombre'] ?? medio}';

  Future<void> _rendir() async {
    final d = _dia!;
    final esperado = _d(d['efectivo']);
    final entregado = TextEditingController(text: esperado.toStringAsFixed(2));
    final nota = TextEditingController();
    final porMedio = (d['porMedio'] as Map? ?? const {}).cast<String, dynamic>();
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(20, 16, 20, 16 + MediaQuery.of(ctx).viewInsets.bottom + MediaQuery.of(ctx).viewPadding.bottom),
        child: StatefulBuilder(builder: (ctx, set) {
          final dif = (double.tryParse(entregado.text.replaceAll(',', '.')) ?? 0) - esperado;
          return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              const Expanded(child: Text('Rendir mi día', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
              IconButton(onPressed: () => Navigator.pop(ctx), icon: const Icon(Icons.close), tooltip: 'Cerrar'),
            ]),
            const Text('Lo que cobraste hoy, según el sistema. Entrega el efectivo a la persona encargada de caja.',
                style: TextStyle(fontSize: 12.5, color: TantaColors.textMuted)),
            const SizedBox(height: 12),
            for (final e in porMedio.entries)
              Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(children: [
                Expanded(child: Text(_nombre(e.key))),
                Text(dinero(_d(e.value)), style: const TextStyle(fontWeight: FontWeight.w600)),
              ])),
            const Divider(height: 18),
            Row(children: [
              const Expanded(child: Text('Total cobrado', style: TextStyle(fontWeight: FontWeight.w700))),
              Text(dinero(_d(d['total'])), style: const TextStyle(fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 14),
            TextField(controller: entregado, keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => set(() {}),
                decoration: InputDecoration(labelText: 'Efectivo que entregas', prefixText: 'S/ ', helperText: 'Esperado en efectivo: ${dinero(esperado)}')),
            if (dif.abs() > 0.009)
              Padding(padding: const EdgeInsets.only(top: 6), child: Text(dif < 0 ? 'Faltan ${dinero(-dif)}' : 'Sobran ${dinero(dif)}',
                  style: TextStyle(fontSize: 12.5, color: dif < 0 ? TantaColors.stateDanger : TantaColors.stateWarn))),
            const SizedBox(height: 8),
            TextField(controller: nota, maxLength: 300, decoration: const InputDecoration(labelText: 'Nota (opcional)', counterText: '')),
            const SizedBox(height: 12),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Enviar rendición')),
          ]);
        }),
      ),
    );
    if (ok != true || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      await Api.instancia.rendirDia(double.tryParse(entregado.text.replaceAll(',', '.')) ?? 0, nota.text.trim());
      aviso.showSnackBar(const SnackBar(content: Text('Rendición enviada: caja la confirmará al recibir el dinero'), backgroundColor: TantaColors.stateOk));
      _cargar();
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: la rendición necesita internet')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _dia;
    if (d == null) return const SizedBox.shrink();
    final porMedio = (d['porMedio'] as Map? ?? const {}).cast<String, dynamic>();
    final r = (d['rendicion'] as Map?)?.cast<String, dynamic>();
    final total = _d(d['total']);
    final entregas = (d['entregas'] as List? ?? const []).cast<Map<String, dynamic>>();
    final quedo = entregas.fold<double>(0, (s, e) => s + _d(e['quedaPorCobrar']));
    final (estado, tono) = r == null
        ? (total > 0 ? ('Sin rendir', Tono.warn) : ('Sin cobros hoy', Tono.neutral))
        : r['estado'] == 'RECIBIDA'
            ? ('Recibida${_d(r['diferencia']).abs() > 0.009 ? ' · dif. ${dinero(_d(r['diferencia']))}' : ''}', _d(r['diferencia']).abs() > 0.009 ? Tono.danger : Tono.ok)
            : ('Enviada · por recibir', Tono.info);
    return Panel(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: Text('Mi caja de hoy', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700))),
          Insignia(estado, tono: tono, punto: true),
        ]),
        const SizedBox(height: 4),
        Text(dinero(total), style: estiloDisplay.copyWith(fontSize: 22)),
        if (porMedio.isNotEmpty)
          Text(porMedio.entries.map((e) => '${_nombre(e.key).toLowerCase()} ${dinero(_d(e.value))}').join(' · '),
              style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
        if (entregas.isNotEmpty)
          Text('${entregas.length} ${entregas.length == 1 ? 'entrega' : 'entregas'} hoy${quedo > 0.009 ? ' · quedó por cobrar ${dinero(quedo)}' : ''}',
              style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
        if (r != null && r['desactualizada'] == true)
          const Text('Cobraste después de rendir: vuelve a rendir.', style: TextStyle(fontSize: 12, color: TantaColors.stateWarn)),
        if (total > 0 && r?['estado'] != 'RECIBIDA') ...[
          const SizedBox(height: 10),
          OutlinedButton.icon(onPressed: _rendir, icon: const Icon(Icons.point_of_sale_outlined, size: 18),
              label: Text(r == null ? 'Rendir mi día' : 'Actualizar rendición')),
        ],
      ]),
    );
  }
}
