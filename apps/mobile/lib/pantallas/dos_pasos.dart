import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/api.dart';
import '../core/tokens.dart';

/// Segundo paso del ingreso para los roles que lo exigen (Usuarios y roles → «Exige verificación en dos pasos»).
/// Con la app autenticadora ya activa pide el código; la primera vez la activa aquí mismo (sin pasar por la web).
/// Devuelve true cuando la sesión quedó abierta.
class DosPasos extends StatefulWidget {
  const DosPasos({super.key, required this.paso});
  final PasoMfa paso;

  @override
  State<DosPasos> createState() => _DosPasosState();
}

class _DosPasosState extends State<DosPasos> {
  final _codigo = TextEditingController();
  Map<String, dynamic>? _enrolamiento;
  String? _error;
  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    if (widget.paso.enrolar) _iniciarEnrolamiento();
  }

  @override
  void dispose() {
    _codigo.dispose();
    super.dispose();
  }

  Future<void> _iniciarEnrolamiento() async {
    setState(() { _enviando = true; _error = null; });
    try {
      final e = await Api.instancia.enrolarMfa(widget.paso.ticket);
      if (mounted) setState(() => _enrolamiento = e);
    } catch (e) {
      if (mounted) setState(() => _error = e is SinConexion ? 'Sin conexión con el servidor.' : '$e');
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  Future<void> _confirmar() async {
    if (_enviando) return;
    setState(() { _enviando = true; _error = null; });
    try {
      final codigos = await Api.instancia.completarMfa(widget.paso.ticket, _codigo.text, activar: widget.paso.enrolar);
      if (!mounted) return;
      if (codigos.isNotEmpty) await _mostrarCodigos(codigos);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() { _error = e is SinConexion ? 'Sin conexión con el servidor.' : '$e'; _codigo.clear(); });
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  /// Los códigos de recuperación se entregan una sola vez: sin ellos, perder el teléfono deja la cuenta fuera.
  Future<void> _mostrarCodigos(List<String> codigos) => showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Guarda tus códigos de recuperación'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Cada uno sirve una sola vez si pierdes el teléfono. No se volverán a mostrar.', style: TextStyle(fontSize: 13)),
            const SizedBox(height: 12),
            SelectableText(codigos.join('\n'), style: const TextStyle(fontFamily: 'monospace', fontSize: 15, height: 1.5)),
          ]),
          actions: [
            TextButton(onPressed: () => Clipboard.setData(ClipboardData(text: codigos.join('\n'))), child: const Text('Copiar')),
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Ya los guardé')),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final e = _enrolamiento;
    final esperandoEnrolamiento = widget.paso.enrolar && e == null;
    return Scaffold(
      appBar: AppBar(title: Text(widget.paso.enrolar ? 'Activa la verificación en dos pasos' : 'Verificación en dos pasos')),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          if (widget.paso.enrolar) ...[
            const Text('Tu perfil entra con contraseña y un código de 6 dígitos que cambia cada 30 segundos.',
                style: TextStyle(fontSize: 14)),
            const SizedBox(height: 12),
            const Text('1. Instala Google Authenticator, Microsoft Authenticator o Authy.\n'
                '2. Si la app está en este teléfono, toca «Abrir en la app autenticadora»; si está en otro, escanea el código QR.\n'
                '3. Escribe el código de 6 dígitos que te muestra.', style: TextStyle(fontSize: 13, color: TantaColors.textMuted, height: 1.5)),
            const SizedBox(height: 16),
            if (esperandoEnrolamiento && _error == null) const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator())),
            if (e != null) ...[
              if ('${e['qr'] ?? ''}'.contains('base64,'))
                Center(child: Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
                  child: Image.memory(base64Decode('${e['qr']}'.split('base64,').last), width: 200, height: 200, filterQuality: FilterQuality.none),
                )),
              const SizedBox(height: 12),
              FilledButton.tonalIcon(
                  onPressed: () => launchUrl(Uri.parse('${e['otpauth']}'), mode: LaunchMode.externalApplication).catchError((_) => false),
                  icon: const Icon(Icons.open_in_new, size: 18), label: const Text('Abrir en la app autenticadora')),
              const SizedBox(height: 12),
              const Text('¿No puedes escanear? Escribe esta clave', style: TextStyle(fontSize: 12, color: TantaColors.textMuted)),
              const SizedBox(height: 4),
              SelectableText('${e['secreto']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: 1)),
              const SizedBox(height: 8),
              Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => Clipboard.setData(ClipboardData(text: '${e['secreto']}')),
                  icon: const Icon(Icons.copy, size: 18), label: const Text('Copiar clave'))),
              const SizedBox(height: 20),
            ],
          ] else ...[
            const Text('Escribe el código de 6 dígitos de tu app autenticadora. Si perdiste el teléfono, usa uno de tus códigos de recuperación.',
                style: TextStyle(fontSize: 14)),
            const SizedBox(height: 20),
          ],
          if (!esperandoEnrolamiento)
            TextField(
              controller: _codigo,
              autofocus: true,
              keyboardType: widget.paso.enrolar ? TextInputType.number : TextInputType.text,
              textInputAction: TextInputAction.done,
              maxLength: 20,
              onSubmitted: (_) => _confirmar(),
              decoration: const InputDecoration(labelText: 'Código', counterText: ''),
            ),
          if (_error != null)
            Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: TantaColors.stateDanger))),
          if (widget.paso.enrolar && e == null && _error != null)
            TextButton(onPressed: _enviando ? null : _iniciarEnrolamiento, child: const Text('Reintentar')),
          const SizedBox(height: 16),
          if (!esperandoEnrolamiento)
            FilledButton(
              onPressed: _enviando ? null : _confirmar,
              child: Text(_enviando ? 'Verificando…' : widget.paso.enrolar ? 'Activar y entrar' : 'Entrar'),
            ),
        ]),
      ),
    );
  }
}
