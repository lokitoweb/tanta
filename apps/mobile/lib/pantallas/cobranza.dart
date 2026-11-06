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

/// Cobranza: cartera agrupada por cliente. Se cobra todo lo del cliente o una compra puntual,
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
    final pagos = await showModalBottomSheet<List<Map<String, dynamic>>>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _HojaCobro(cliente: d.nombre, detalle: docs.length == 1 ? '${docs.first['documento'] ?? 'Compra'}' : '${docs.length} compras', debe: debe),
    );
    if (pagos == null || !mounted) return;
    final monto = pagos.fold<double>(0, (s, p) => s + _d(p['monto']));
    final queda = debe - monto;
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
      aviso.showSnackBar(SnackBar(
        content: Text('Pago de ${dinero(monto)} registrado$textoQueda'),
        backgroundColor: TantaColors.stateOk,
        duration: const Duration(seconds: 6),
        action: SnackBarAction(
          label: 'Recibo PDF',
          textColor: Colors.white,
          onPressed: () => compartirComprobante(
            titulo: 'Recibo de cobro',
            numero: '${r['numero']}',
            cliente: d.nombre,
            lineas: [
              for (final p in pagos) ('Pago ${'${p['medio']}'.toLowerCase()}${'${p['referencia'] ?? ''}'.isEmpty ? '' : ' · op. ${p['referencia']}'}', dinero(_d(p['monto']))),
              if (queda > 0.009) ('Saldo pendiente', dinero(queda)),
            ],
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
      onRefresh: _cargar,
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
          if (deudores.isEmpty) const VacioMensaje('No hay cuentas por cobrar', icono: Icons.account_balance_wallet_outlined),
          for (final d in deudores) _tarjeta(d, puedeCobrar),
        ],
      ),
    );
  }

  Widget _tarjeta(_Deudor d, bool puedeCobrar) {
    final abierto = _abiertos.contains(d.id);
    final n = d.docs.length;
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
            for (final c in d.docs) _documento(d, c, puedeCobrar),
          ],
          if (puedeCobrar)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: TantaColors.ink800, minimumSize: const Size.fromHeight(40)),
                onPressed: () => _cobrar(d, d.docs),
                icon: const Icon(Icons.payments_outlined, size: 18),
                label: Text(n == 1 ? 'Cobrar' : 'Cobrar al cliente'),
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
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
      child: Row(children: [
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
        if (puedeCobrar && d.docs.length > 1)
          TextButton(onPressed: () => _cobrar(d, [c]), child: const Text('Cobrar')),
      ]),
    );
  }
}

/// Formulario del cobro: una o varias formas de pago (p. ej. efectivo + Yape) que suman lo que se cobra.
class _HojaCobro extends StatefulWidget {
  const _HojaCobro({required this.cliente, required this.detalle, required this.debe});
  final String cliente;
  final String detalle;
  final double debe;
  @override
  State<_HojaCobro> createState() => _HojaCobroState();
}

class _Linea {
  _Linea(this.medio, double monto) : monto = TextEditingController(text: monto > 0 ? monto.toStringAsFixed(2) : '');
  String medio;
  final TextEditingController monto;
  final referencia = TextEditingController();
  double get valor => double.tryParse(monto.text.replaceAll(',', '.')) ?? 0;
}

class _HojaCobroState extends State<_HojaCobro> {
  final _medios = mediosPago('enCobranza');
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
    final queda = widget.debe - _suma;
    final problema = _problema;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const Expanded(child: Text('Registrar pago', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
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
          const SizedBox(height: 14),
          FilledButton(
            onPressed: problema != null
                ? null
                : () => Navigator.pop(context, [
                      for (final l in _lineas)
                        {'monto': double.parse(l.valor.toStringAsFixed(2)), 'medio': l.medio, 'referencia': l.referencia.text.trim()},
                    ]),
            child: Text('Cobrar ${dinero(_suma)}'),
          ),
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
