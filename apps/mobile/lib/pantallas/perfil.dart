import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/api.dart';
import '../core/arranque.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Mi perfil: datos, foto, contraseña, privacidad y eliminación de cuenta.
/// Visible para todos los roles (requisito de App Store y Google Play).
class Perfil extends StatefulWidget {
  const Perfil({super.key, required this.onSalir});
  final VoidCallback onSalir;

  @override
  State<Perfil> createState() => _PerfilState();
}

class _PerfilState extends State<Perfil> {
  Map<String, dynamic>? _p;
  String _version = '';
  bool _ocupado = false;

  @override
  void initState() {
    super.initState();
    _cargar();
    versionInstalada().then((v) => mounted ? setState(() => _version = v) : null).catchError((_) => null);
  }

  Future<void> _cargar() async {
    try {
      final p = await Api.instancia.perfil();
      if (mounted) setState(() => _p = p);
    } catch (e) {
      _aviso('$e', error: true);
    }
  }

  void _aviso(String texto, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(texto), backgroundColor: error ? TantaColors.stateDanger : TantaColors.stateOk),
    );
  }

  Future<void> _accion(Future<void> Function() fn, String ok) async {
    setState(() => _ocupado = true);
    try {
      await fn();
      _aviso(ok);
    } on SinConexion {
      _aviso('Sin conexión. Intenta cuando vuelva la red.', error: true);
    } catch (e) {
      _aviso('$e', error: true);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  Future<void> _foto(ImageSource origen) async {
    // El sistema reduce la foto antes de subirla: ~60 KB en vez de varios MB.
    final x = await ImagePicker().pickImage(source: origen, maxWidth: 512, maxHeight: 512, imageQuality: 85);
    if (x == null) return;
    await _accion(() async {
      await Api.instancia.subirFoto(await x.readAsBytes());
      await _cargar();
    }, 'Foto actualizada');
  }

  void _elegirFoto() {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(children: [
          ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Tomar foto'),
              onTap: () { Navigator.pop(ctx); _foto(ImageSource.camera); }),
          ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Elegir de la galería'),
              onTap: () { Navigator.pop(ctx); _foto(ImageSource.gallery); }),
        ]),
      ),
    );
  }

  Future<void> _editarDatos() async {
    final p = _p!;
    final nombre = TextEditingController(text: '${p['nombre']}');
    final email = TextEditingController(text: '${p['email'] ?? ''}');
    final tel = TextEditingController(text: '${p['telefono'] ?? ''}');
    final ok = await _dialogo('Mis datos', [
      TextField(controller: nombre, decoration: const InputDecoration(labelText: 'Nombre completo'), textCapitalization: TextCapitalization.words),
      const SizedBox(height: 12),
      TextField(controller: email, decoration: const InputDecoration(labelText: 'Correo'), keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email]),
      const SizedBox(height: 12),
      TextField(controller: tel, decoration: const InputDecoration(labelText: 'Teléfono'), keyboardType: TextInputType.phone, autofillHints: const [AutofillHints.telephoneNumber]),
    ], 'Guardar');
    if (ok != true) return;
    await _accion(() async {
      await Api.instancia.actualizarPerfil(nombre: nombre.text.trim(), email: email.text.trim(), telefono: tel.text.trim());
      await _cargar();
    }, 'Datos actualizados');
  }

  Future<void> _cambiarClave() async {
    final actual = TextEditingController();
    final nueva = TextEditingController();
    final repetir = TextEditingController();
    final ok = await _dialogo('Cambiar contraseña', [
      TextField(controller: actual, obscureText: true, decoration: const InputDecoration(labelText: 'Contraseña actual'), autofillHints: const [AutofillHints.password]),
      const SizedBox(height: 12),
      TextField(controller: nueva, obscureText: true, decoration: const InputDecoration(labelText: 'Nueva (mínimo 10 caracteres)'), autofillHints: const [AutofillHints.newPassword]),
      const SizedBox(height: 12),
      TextField(controller: repetir, obscureText: true, decoration: const InputDecoration(labelText: 'Repite la nueva')),
    ], 'Cambiar');
    if (ok != true) return;
    if (nueva.text != repetir.text) return _aviso('Las contraseñas nuevas no coinciden.', error: true);
    if (nueva.text.length < 10) return _aviso('La nueva contraseña debe tener al menos 10 caracteres.', error: true);
    await _accion(() async {
      await Api.instancia.cambiarClave(actual.text, nueva.text);
      // El servidor cerró todas las sesiones: se vuelve a ingresar con la clave nueva.
      widget.onSalir();
    }, 'Contraseña cambiada. Vuelve a ingresar.');
  }

  Future<void> _eliminarCuenta() async {
    final clave = TextEditingController();
    final ok = await _dialogo('Eliminar mi cuenta', [
      const Text(
        'Se borrarán tu nombre, correo, teléfono y foto, y no podrás volver a ingresar. '
        'Las ventas y cobros se conservan sin tus datos personales porque son registros contables.',
        style: TextStyle(fontSize: 13, color: TantaColors.textMuted),
      ),
      const SizedBox(height: 14),
      TextField(controller: clave, obscureText: true, decoration: const InputDecoration(labelText: 'Confirma con tu contraseña')),
    ], 'Eliminar definitivamente', peligro: true);
    if (ok != true) return;
    await _accion(() async {
      await Api.instancia.eliminarCuenta(clave.text);
      widget.onSalir();
    }, 'Tu cuenta fue eliminada.');
  }

  Future<bool?> _dialogo(String titulo, List<Widget> campos, String accion, {bool peligro = false}) => showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(titulo),
          content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: campos)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
            FilledButton(
              style: peligro ? FilledButton.styleFrom(backgroundColor: TantaColors.stateDanger) : null,
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(accion),
            ),
          ],
        ),
      );

  Future<void> _abrir(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.isScheme('https') && !uri.isScheme('mailto')) return _aviso('Enlace no configurado.', error: true);
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    if (p == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final legal = (Api.instancia.config['legal'] as Map?) ?? const {};
    final foto = p['fotoUrl'] as String?;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 32),
      children: [
        Panel(
          child: Column(children: [
            GestureDetector(
              onTap: _ocupado ? null : _elegirFoto,
              child: Stack(alignment: Alignment.bottomRight, children: [
                Avatar(nombre: '${p['nombre']}', fotoUrl: foto, radio: 44),
                const CircleAvatar(radius: 14, backgroundColor: TantaColors.ink800,
                    child: Icon(Icons.photo_camera_outlined, size: 15, color: TantaColors.cream50)),
              ]),
            ),
            const SizedBox(height: 12),
            Text('${p['nombre']}', style: estiloDisplay.copyWith(fontSize: 20), textAlign: TextAlign.center),
            const SizedBox(height: 2),
            Text('${p['rol']} · @${p['usuario']}', style: const TextStyle(fontSize: 12.5, color: TantaColors.textMuted)),
          ]),
        ),
        const SizedBox(height: 14),
        Panel(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _item(Icons.badge_outlined, 'Mis datos', '${p['email'] ?? ''}'.isEmpty ? 'Agrega tu correo y teléfono' : '${p['email']}', _editarDatos),
            const Divider(height: 1),
            _item(Icons.lock_outline, 'Cambiar contraseña', 'Cierra tus sesiones en otros equipos', _cambiarClave),
          ]),
        ),
        const SizedBox(height: 14),
        Panel(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _item(Icons.privacy_tip_outlined, 'Política de privacidad', 'Ley N.° 29733', () => _abrir('${legal['urlPrivacidad'] ?? ''}')),
            const Divider(height: 1),
            _item(Icons.description_outlined, 'Términos y condiciones', null, () => _abrir('${legal['urlTerminos'] ?? ''}')),
            const Divider(height: 1),
            _item(Icons.support_agent_outlined, 'Soporte', '${legal['correoSoporte'] ?? ''}', () => _abrir('mailto:${legal['correoSoporte'] ?? ''}')),
          ]),
        ),
        const SizedBox(height: 14),
        Panel(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _item(Icons.logout, 'Cerrar sesión', null, widget.onSalir),
            const Divider(height: 1),
            _item(Icons.delete_outline, 'Eliminar mi cuenta', 'Borra tus datos personales', _eliminarCuenta, peligro: true),
          ]),
        ),
        const SizedBox(height: 18),
        Center(child: Text('Versión $_version', style: const TextStyle(fontSize: 11.5, color: TantaColors.textMuted))),
      ],
    );
  }

  Widget _item(IconData icono, String titulo, String? sub, VoidCallback alPulsar, {bool peligro = false}) => ListTile(
        enabled: !_ocupado,
        leading: Icon(icono, color: peligro ? TantaColors.stateDanger : TantaColors.ink700),
        title: Text(titulo, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5, color: peligro ? TantaColors.stateDanger : null)),
        subtitle: sub == null || sub.isEmpty ? null : Text(sub, style: const TextStyle(fontSize: 12)),
        trailing: const Icon(Icons.chevron_right, size: 20),
        onTap: alPulsar,
      );
}
