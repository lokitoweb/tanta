import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Promociones y comunicados a todos los clientes o a los elegidos (permiso «clientes.avisar»).
class AvisosClientes extends StatefulWidget {
  const AvisosClientes({super.key});
  @override
  State<AvisosClientes> createState() => _AvisosClientesState();
}

class _AvisosClientesState extends State<AvisosClientes> {
  final _titulo = TextEditingController();
  final _cuerpo = TextEditingController();
  final _elegidos = <String>{};
  Map<String, dynamic>? _datos;
  String? _error;
  bool _todos = true;
  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  @override
  void dispose() {
    _titulo.dispose();
    _cuerpo.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    try {
      final d = await Api.instancia.avisosClientes();
      if (mounted) setState(() { _datos = d; _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  List<Map<String, dynamic>> get _clientes => (_datos?['clientes'] as List? ?? const []).cast<Map<String, dynamic>>();
  List<Map<String, dynamic>> get _historial => (_datos?['historial'] as List? ?? const []).cast<Map<String, dynamic>>();
  int get _conApp => _clientes.where((c) => (c['cuentas'] as num) > 0).length;
  int get _destinos => _todos ? _conApp : _elegidos.length;

  String? get _problema {
    if (_titulo.text.trim().length < 3) return 'Escribe un título';
    if (_cuerpo.text.trim().length < 5) return 'Escribe el mensaje';
    if (_destinos == 0) return _todos ? 'Ningún cliente tiene cuenta en la app' : 'Elige al menos un cliente';
    return null;
  }

  Future<void> _enviar() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('¿Enviar este aviso?'),
        content: Text('Lo recibirán $_destinos cliente(s). Una vez enviado no se puede retirar.'),
        actions: [
          AccionesDialogo(
            secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
            principal: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Enviar aviso')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _enviando = true);
    try {
      final r = await Api.instancia.enviarAvisoClientes(_titulo.text.trim(), _cuerpo.text.trim(), _todos, _elegidos.toList());
      aviso.showSnackBar(SnackBar(content: Text('Aviso enviado a ${r['clientes']} cliente(s)'), backgroundColor: TantaColors.stateOk));
      _titulo.clear();
      _cuerpo.clear();
      _elegidos.clear();
      await _cargar();
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje), backgroundColor: TantaColors.stateDanger));
    } catch (_) {
      // Sin cola offline a propósito: una promoción no debe salir horas después de escribirla.
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: el aviso no se envió'), backgroundColor: TantaColors.stateDanger));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final sinApp = _clientes.length - _conApp;
    final problema = _problema;
    return Scaffold(
      appBar: AppBar(title: const Text('Avisos a clientes')),
      body: _error != null
          ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar)
          : _datos == null
              ? const Esqueleto()
              : ListView(
                  padding: EdgeInsets.fromLTRB(16, 16, 16, 24 + MediaQuery.of(context).viewPadding.bottom),
                  children: [
                    Panel(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        TextField(controller: _titulo, maxLength: 80, onChanged: (_) => setState(() {}),
                            decoration: const InputDecoration(labelText: 'Título', counterText: '')),
                        const SizedBox(height: 12),
                        TextField(controller: _cuerpo, maxLength: 300, minLines: 3, maxLines: 5, onChanged: (_) => setState(() {}),
                            decoration: const InputDecoration(labelText: 'Mensaje')),
                        const SizedBox(height: 8),
                        SegmentedButton<bool>(
                          segments: [
                            ButtonSegment(value: true, label: Text('Todos ($_conApp)')),
                            const ButtonSegment(value: false, label: Text('Elegir')),
                          ],
                          selected: {_todos},
                          onSelectionChanged: (s) => setState(() => _todos = s.first),
                        ),
                        if (!_todos)
                          for (final c in _clientes)
                            CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              title: Text('${c['nombre']}'),
                              subtitle: (c['cuentas'] as num) > 0 ? null : const Text('Sin cuenta en la app'),
                              value: _elegidos.contains(c['id']),
                              onChanged: (c['cuentas'] as num) > 0
                                  ? (v) => setState(() => v == true ? _elegidos.add('${c['id']}') : _elegidos.remove(c['id']))
                                  : null,
                            ),
                        if (sinApp > 0) ...[
                          const SizedBox(height: 8),
                          Text('$sinApp de ${_clientes.length} clientes aún no tienen cuenta en la app: no recibirán el aviso.',
                              style: const TextStyle(fontSize: 12, color: TantaColors.stateWarn)),
                        ],
                        const SizedBox(height: 12),
                        FilledButton.icon(
                          onPressed: problema != null || _enviando ? null : _enviar,
                          icon: const Icon(Icons.campaign_outlined, size: 18),
                          label: Text(_enviando ? 'Enviando…' : problema ?? 'Enviar aviso'),
                        ),
                      ]),
                    ),
                    const SizedBox(height: 16),
                    const Text('Enviados', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    if (_historial.isEmpty) const VacioMensaje('Aún no se envían avisos', icono: Icons.campaign_outlined),
                    for (final a in _historial)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Panel(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('${a['titulo']}', style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text('${a['cuerpo']}', style: const TextStyle(fontSize: 12.5)),
                            const SizedBox(height: 4),
                            Text('${fechaCorta('${a['fecha']}'.substring(0, 10))} · ${a['enviadoPor']} · ${a['clientes']} cliente(s)',
                                style: const TextStyle(fontSize: 11.5, color: TantaColors.textMuted)),
                          ]),
                        ),
                      ),
                  ],
                ),
    );
  }
}
