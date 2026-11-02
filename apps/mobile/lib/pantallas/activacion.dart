import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Primera apertura: la app no trae ninguna dirección. Se escanea el QR de
/// Configuración → App móvil en la web, o se escribe el dominio de la empresa.
class Activacion extends StatefulWidget {
  const Activacion({super.key, required this.onActivada});
  final VoidCallback onActivada;

  @override
  State<Activacion> createState() => _ActivacionState();
}

class _ActivacionState extends State<Activacion> {
  final _direccion = TextEditingController();
  bool _ocupado = false;
  String? _error;

  Future<void> _activar(String texto) async {
    if (_ocupado || texto.trim().isEmpty) return;
    setState(() { _ocupado = true; _error = null; });
    try {
      await Api.instancia.cambiarServidor(texto);
      widget.onActivada();
    } on ApiException catch (e) {
      setState(() => _error = e.mensaje);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  Future<void> _escanear() async {
    final leido = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const _Escaner()));
    if (leido != null) await _activar(leido);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Center(child: Marca(escala: 1.1)),
                const SizedBox(height: 28),
                Text('Activa la aplicación', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                const Text('En la web entra a Configuración → App móvil y escanea el código QR.', textAlign: TextAlign.center),
                const SizedBox(height: 24),
                FilledButton.icon(
                  onPressed: _ocupado ? null : _escanear,
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('Escanear código'),
                ),
                const SizedBox(height: 24),
                TextField(
                  controller: _direccion,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  onSubmitted: _activar,
                  decoration: const InputDecoration(labelText: 'O escribe la dirección (ej. empresa.com)', prefixIcon: Icon(Icons.language)),
                ),
                const SizedBox(height: 12),
                OutlinedButton(onPressed: _ocupado ? null : () => _activar(_direccion.text), child: const Text('Conectar')),
                if (_ocupado) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.sand500))),
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.error))),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _Escaner extends StatefulWidget {
  const _Escaner();
  @override
  State<_Escaner> createState() => _EscanerState();
}

class _EscanerState extends State<_Escaner> {
  bool _listo = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Escanea el código')),
      body: MobileScanner(
        onDetect: (captura) {
          final valor = captura.barcodes.firstOrNull?.rawValue;
          if (_listo || valor == null || !valor.startsWith('tanta://')) return;
          _listo = true;
          Navigator.pop(context, valor);
        },
      ),
    );
  }
}
