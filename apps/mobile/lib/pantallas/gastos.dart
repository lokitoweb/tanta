import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';
import 'cobranza.dart' show BotonVoucher;

/// Gastos de caja chica (menú, gasolina, distribución): salen de la caja abierta y entran a la liquidación diaria.
class Gastos extends StatefulWidget {
  const Gastos({super.key});
  @override
  State<Gastos> createState() => _GastosState();
}

class _GastosState extends State<Gastos> {
  final _serie = TextEditingController();
  final _numero = TextEditingController();
  final _glosa = TextEditingController();
  final _monto = TextEditingController();
  final _autorizado = TextEditingController();
  final _tipos = tiposGasto();
  final _documentos = tiposDocumento();
  String? _tipo, _documento, _imagen;
  List<Map<String, dynamic>>? _lista;
  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  @override
  void dispose() {
    for (final c in [_serie, _numero, _glosa, _monto, _autorizado]) { c.dispose(); }
    super.dispose();
  }

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.gastos();
      if (mounted) setState(() => _lista = l.cast<Map<String, dynamic>>().where((g) => g['tipoGasto'] != null).toList());
    } catch (_) {
      if (mounted) setState(() => _lista ??= const []);
    }
  }

  double get _valor => double.tryParse(_monto.text.replaceAll(',', '.')) ?? 0;
  bool get _valido => _tipo != null && _glosa.text.trim().length >= 2 && _valor > 0 && _autorizado.text.trim().length >= 2;

  Future<void> _guardar() async {
    final aviso = ScaffoldMessenger.of(context);
    final hoy = DateTime.now().toIso8601String().substring(0, 10);
    final medio = mediosPago('cajaChica').firstOrNull?['codigo'];
    setState(() => _enviando = true);
    try {
      final r = await Api.instancia.registrarGasto({
        'concepto': _glosa.text.trim(), 'fechaOperacion': hoy, 'periodoMes': int.parse(hoy.substring(5, 7)), 'periodoAnio': int.parse(hoy.substring(0, 4)),
        'monto': _valor, 'caja': 'CHICA', 'medio': medio ?? 'EFECTIVO', 'tipoGasto': _tipo, 'docTipo': _documento, 'docSerie': _serie.text.trim(),
        'docNumero': _numero.text.trim(), 'autorizadoPor': _autorizado.text.trim(), 'comprobante': _imagen,
      });
      aviso.showSnackBar(SnackBar(content: Text('Gasto ${r['codigo']} registrado'), backgroundColor: TantaColors.stateOk));
      for (final c in [_serie, _numero, _glosa, _monto, _autorizado]) { c.clear(); }
      setState(() { _tipo = null; _documento = null; _imagen = null; });
      await _cargar();
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: el gasto no se registró')));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Gastos')),
        body: ListView(padding: EdgeInsets.fromLTRB(16, 16, 16, 24 + MediaQuery.of(context).viewPadding.bottom), children: [
          Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            DropdownButtonFormField<String>(
              key: ValueKey('tipo$_tipo'), initialValue: _tipo, isExpanded: true, decoration: const InputDecoration(labelText: 'Tipo de gasto'),
              items: [for (final t in _tipos) DropdownMenuItem(value: '${t['codigo']}', child: Text('${t['nombre']}'))],
              onChanged: (v) => setState(() => _tipo = v),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              key: ValueKey('doc$_documento'), initialValue: _documento, isExpanded: true, decoration: const InputDecoration(labelText: 'Documento (opcional)'),
              items: [for (final t in _documentos) DropdownMenuItem(value: '${t['codigo']}', child: Text('${t['nombre']}'))],
              onChanged: (v) => setState(() => _documento = v),
            ),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: TextField(controller: _serie, maxLength: 10, decoration: const InputDecoration(labelText: 'Serie', counterText: ''))),
              const SizedBox(width: 10),
              Expanded(child: TextField(controller: _numero, maxLength: 20, decoration: const InputDecoration(labelText: 'N.°', counterText: ''))),
            ]),
            const SizedBox(height: 10),
            TextField(controller: _glosa, maxLength: 120, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Glosa', hintText: 'Gasto de menú', counterText: '')),
            const SizedBox(height: 10),
            TextField(controller: _monto, keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Monto', prefixText: 'S/ ')),
            const SizedBox(height: 10),
            TextField(controller: _autorizado, maxLength: 80, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Autorizado por', counterText: '')),
            const SizedBox(height: 6),
            BotonVoucher(valor: _imagen, texto: 'Adjuntar imagen', onCambio: (v) => setState(() => _imagen = v)),
            const SizedBox(height: 8),
            FilledButton(onPressed: !_valido || _enviando ? null : _guardar, child: Text(_enviando ? 'Registrando…' : 'Registrar gasto')),
          ])),
          const SizedBox(height: 14),
          const Text('Registrados', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
          if (_lista == null) const Esqueleto(filas: 2)
          else if (_lista!.isEmpty) const VacioMensaje('Aún no hay gastos', icono: Icons.receipt_long_outlined),
          for (final g in _lista ?? const <Map<String, dynamic>>[])
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${g['concepto']}'),
              subtitle: Text('${g['codigo']} · ${fechaCorta('${g['fecha']}')} · ${g['tipoGastoNombre']} · autorizó ${g['autorizadoPor']}'),
              trailing: Text(dinero((g['monto'] as num).toDouble()), style: const TextStyle(fontWeight: FontWeight.w700)),
            ),
        ]),
      );
}
