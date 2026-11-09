import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/api.dart';
import '../core/tokens.dart';

/// Política de privacidad o términos dentro de la app (lo exigen Google Play y App Store).
/// El texto sale del sistema (Configuración → Legal y soporte, o el texto base); si el superadmin
/// puso un enlace a otro sitio, se abre ese.
Future<void> abrirLegal(BuildContext context, String doc) async {
  final legal = (Api.instancia.config['legal'] as Map?) ?? const {};
  final url = '${legal[doc == 'privacidad' ? 'urlPrivacidad' : 'urlTerminos'] ?? ''}';
  final uri = Uri.tryParse(url);
  final propio = Uri.tryParse(Api.base)?.host;
  if (uri != null && uri.isScheme('https') && uri.host.isNotEmpty && uri.host != propio) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
    return;
  }
  if (!context.mounted) return;
  await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PaginaLegal(doc: doc)));
}

class PaginaLegal extends StatefulWidget {
  const PaginaLegal({super.key, required this.doc});
  final String doc;

  @override
  State<PaginaLegal> createState() => _PaginaLegalState();
}

class _PaginaLegalState extends State<PaginaLegal> {
  late Future<Map<String, dynamic>> _datos = Api.instancia.legal(widget.doc);

  @override
  Widget build(BuildContext context) {
    final titulo = widget.doc == 'privacidad' ? 'Política de privacidad' : 'Términos y condiciones';
    return Scaffold(
      appBar: AppBar(title: Text(titulo)),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _datos,
        builder: (context, s) {
          if (s.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          if (s.hasError) {
            return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('No se pudo cargar el documento.', style: TextStyle(color: TantaColors.textMuted)),
              const SizedBox(height: 12),
              OutlinedButton(
                style: OutlinedButton.styleFrom(minimumSize: const Size(160, 44)),
                onPressed: () => setState(() => _datos = Api.instancia.legal(widget.doc)),
                child: const Text('Reintentar'),
              ),
            ]));
          }
          final d = s.data!;
          return SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
              child: SelectableText('${d['texto'] ?? ''}', style: const TextStyle(fontSize: 14.5, height: 1.55, color: TantaColors.textPrimary)),
            ),
          );
        },
      ),
    );
  }
}
