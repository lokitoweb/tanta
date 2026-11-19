import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/api.dart';
import '../core/arranque.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';
import 'legal.dart';

/// Mi perfil: datos, foto, ficha de cliente y direcciones (solo clientes), contraseña, privacidad y eliminación de cuenta.
/// Visible para todos los roles (requisito de App Store y Google Play).
class Perfil extends StatefulWidget {
  const Perfil({super.key, required this.onSalir});
  final VoidCallback onSalir;

  @override
  State<Perfil> createState() => _PerfilState();
}

class _PerfilState extends State<Perfil> {
  Map<String, dynamic>? _p;
  /// Ficha de cliente (contacto, celular, direcciones): el servidor responde 403 al personal y la sección no aparece.
  Map<String, dynamic>? _ficha;
  String? _error;
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
      if (mounted) setState(() { _p = p; _error = null; });
      await _cargarFicha();
    } catch (e) {
      final texto = e is SinConexion ? 'Sin conexión. Intenta cuando vuelva la red.' : '$e';
      // Sin perfil cargado se muestra el error con Reintentar; si ya había uno, basta el aviso.
      if (_p == null) {
        if (mounted) setState(() => _error = texto);
      } else {
        _aviso(texto, error: true);
      }
    }
  }

  Future<void> _cargarFicha() async {
    try {
      final f = await Api.instancia.miFicha();
      if (mounted) setState(() => _ficha = f);
    } on ApiException catch (e) {
      if (e.status == 403 && mounted) setState(() => _ficha = null);
    } catch (_) {} // Sin red: se conserva la que había.
  }

  Future<void> _editarFicha() async {
    final f = _ficha!;
    final contacto = TextEditingController(text: '${f['contacto'] ?? ''}');
    final tel = TextEditingController(text: '${f['telefono'] ?? ''}');
    final doc = '${f['docNumero'] ?? ''}';
    final ok = await _dialogo('Mi ficha de cliente', [
      TextField(controller: contacto, maxLength: 120, textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Persona de contacto', prefixIcon: Icon(Icons.person_outline))),
      const SizedBox(height: 4),
      TextField(controller: tel, maxLength: 30, keyboardType: TextInputType.phone, autofillHints: const [AutofillHints.telephoneNumber],
          decoration: const InputDecoration(labelText: 'Celular', prefixIcon: Icon(Icons.phone_outlined))),
    ], 'Guardar', subtitulo: '${f['docTipo'] ?? ''} ${doc.isEmpty ? '—' : doc} · el documento lo actualiza la panadería');
    if (ok != true) return;
    await _accion(() async {
      await Api.instancia.guardarFicha(contacto: contacto.text.trim(), telefono: tel.text.trim());
      await _cargarFicha();
    }, 'Ficha actualizada');
  }

  Future<void> _direcciones() => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => StatefulBuilder(builder: (ctx, refrescar) {
          final f = _ficha ?? const <String, dynamic>{};
          final dirs = ((f['direcciones'] as List?) ?? const []).cast<Map>();
          final max = (f['maxDirecciones'] as num?)?.toInt() ?? dirs.length;
          Future<void> hacer(Future<void> Function() fn, String ok) async {
            await _accion(() async { await fn(); await _cargarFicha(); }, ok);
            refrescar(() {});
          }
          return SafeArea(
            child: Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(ctx).bottom),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Direcciones de entrega · ${dirs.length} de $max', style: estiloDisplay.copyWith(fontSize: 17)),
                const SizedBox(height: 8),
                for (final d in dirs)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.place_outlined),
                    title: Text('${d['direccion']}'),
                    subtitle: _detalleDireccion(d),
                    // La principal la mantiene la panadería: no se quita desde aquí.
                    trailing: d['id'] == null ? null : IconButton(
                      tooltip: 'Quitar', icon: const Icon(Icons.delete_outline),
                      onPressed: _ocupado ? null : () => hacer(() => Api.instancia.quitarDireccion('${d['id']}'), 'Dirección eliminada'),
                    ),
                  ),
                const SizedBox(height: 8),
                if (dirs.length >= max)
                  const Text('Llegaste al máximo de direcciones: quita una para agregar otra.', style: TextStyle(fontSize: 13, color: TantaColors.textMuted))
                else
                  OutlinedButton.icon(
                    onPressed: _ocupado ? null : () async {
                      final dir = TextEditingController(), ref = TextEditingController();
                      final ok = await _dialogo('Nueva dirección', [
                        TextField(controller: dir, autofocus: true, maxLength: 200, decoration: const InputDecoration(labelText: 'Calle, número, distrito')),
                        TextField(controller: ref, maxLength: 120, decoration: const InputDecoration(labelText: 'Referencia (opcional)')),
                      ], 'Agregar');
                      if (ok != true) return;
                      if (dir.text.trim().length < 5) return _aviso('Escribe la dirección completa.', error: true);
                      await hacer(() => Api.instancia.agregarDireccion(dir.text.trim(), ref.text.trim()), 'Dirección agregada');
                    },
                    icon: const Icon(Icons.add_location_alt_outlined),
                    label: const Text('Agregar dirección'),
                  ),
              ]),
            ),
          );
        }),
      );

  Widget? _detalleDireccion(Map d) {
    final partes = [if (d['principal'] == true) 'Principal', if ('${d['referencia'] ?? ''}'.isNotEmpty) '${d['referencia']}'];
    return partes.isEmpty ? null : Text(partes.join(' · '), style: const TextStyle(fontSize: 12));
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
    final clave = TextEditingController();
    final ok = await _dialogo('Mis datos', [
      TextField(controller: nombre, decoration: const InputDecoration(labelText: 'Nombre completo', prefixIcon: Icon(Icons.person_outline)), textCapitalization: TextCapitalization.words),
      const SizedBox(height: 12),
      TextField(controller: email, decoration: const InputDecoration(labelText: 'Correo', prefixIcon: Icon(Icons.mail_outline)), keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email]),
      const SizedBox(height: 12),
      TextField(controller: tel, decoration: const InputDecoration(labelText: 'Teléfono', prefixIcon: Icon(Icons.phone_outlined)), keyboardType: TextInputType.phone, autofillHints: const [AutofillHints.telephoneNumber]),
      const SizedBox(height: 12),
      TextField(controller: clave, obscureText: true, autofillHints: const [AutofillHints.password],
          decoration: const InputDecoration(labelText: 'Contraseña actual', prefixIcon: Icon(Icons.lock_outline), helperText: 'Solo si cambias el correo')),
    ], 'Guardar', subtitulo: 'Se usan para avisos y para recuperar tu cuenta.');
    if (ok != true) return;
    await _accion(() async {
      await Api.instancia.actualizarPerfil(nombre: nombre.text.trim(), email: email.text.trim(), telefono: tel.text.trim(), clave: clave.text);
      await _cargar();
    }, 'Datos actualizados');
  }

  Future<void> _cambiarClave() async {
    final actual = TextEditingController();
    final nueva = TextEditingController();
    final repetir = TextEditingController();
    final ok = await _dialogo('Cambiar contraseña', [
      TextField(controller: actual, obscureText: true, decoration: const InputDecoration(labelText: 'Contraseña actual', prefixIcon: Icon(Icons.lock_outline)), autofillHints: const [AutofillHints.password]),
      const SizedBox(height: 12),
      TextField(controller: nueva, obscureText: true, decoration: InputDecoration(labelText: 'Nueva contraseña', prefixIcon: const Icon(Icons.key_outlined), helperText: 'Mínimo ${Api.instancia.claveMinima} caracteres'), autofillHints: const [AutofillHints.newPassword]),
      const SizedBox(height: 12),
      TextField(controller: repetir, obscureText: true, decoration: const InputDecoration(labelText: 'Repite la nueva', prefixIcon: Icon(Icons.key_outlined))),
    ], 'Cambiar', subtitulo: 'Al cambiarla se cierran tus sesiones en otros equipos.');
    if (ok != true) return;
    if (nueva.text != repetir.text) return _aviso('Las contraseñas nuevas no coinciden.', error: true);
    if (nueva.text.length < Api.instancia.claveMinima) return _aviso('La nueva contraseña debe tener al menos ${Api.instancia.claveMinima} caracteres.', error: true);
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
      TextField(controller: clave, obscureText: true, decoration: const InputDecoration(labelText: 'Confirma con tu contraseña', prefixIcon: Icon(Icons.lock_outline))),
    ], 'Eliminar', peligro: true);
    if (ok != true) return;
    await _accion(() async {
      await Api.instancia.eliminarCuenta(clave.text);
      widget.onSalir();
    }, 'Tu cuenta fue eliminada.');
  }

  Future<bool?> _dialogo(String titulo, List<Widget> campos, String accion, {bool peligro = false, String? subtitulo}) => showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(titulo),
            if (subtitulo != null) ...[
              const SizedBox(height: 4),
              Text(subtitulo, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w400, color: TantaColors.textMuted)),
            ],
          ]),
          content: SizedBox(
            width: double.maxFinite,
            child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: campos)),
          ),
          actions: [
            AccionesDialogo(
              secundaria: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
              principal: FilledButton(
              style: peligro ? FilledButton.styleFrom(backgroundColor: TantaColors.stateDanger) : null,
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(accion),
            ),
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
    if (p == null) {
      return RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(children: [
          // Cerrar sesión sigue a mano aunque el perfil no cargue.
          if (_error != null) ...[
            ErrorReintentar(mensaje: _error!, onReintentar: _cargar),
            Center(child: TextButton.icon(onPressed: widget.onSalir, icon: const Icon(Icons.logout), label: const Text('Cerrar sesión'))),
          ] else
            const Esqueleto(filas: 4),
        ]),
      );
    }
    final legal = (Api.instancia.config['legal'] as Map?) ?? const {};
    final foto = p['fotoUrl'] as String?;
    final ficha = _ficha;

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
        if (ficha != null) ...[
          const SizedBox(height: 14),
          Panel(
            padding: EdgeInsets.zero,
            child: Column(children: [
              _item(Icons.storefront_outlined, 'Mi ficha de cliente',
                  [ficha['contacto'], ficha['telefono']].map((x) => '${x ?? ''}').where((x) => x.isNotEmpty).join(' · '), _editarFicha),
              const Divider(height: 1),
              _item(Icons.place_outlined, 'Direcciones de entrega',
                  '${(ficha['direcciones'] as List?)?.length ?? 0} de ${ficha['maxDirecciones'] ?? '—'}', _direcciones),
            ]),
          ),
        ],
        const SizedBox(height: 14),
        Panel(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _item(Icons.privacy_tip_outlined, 'Política de privacidad', 'Ley N.° 29733', () => abrirLegal(context, 'privacidad')),
            const Divider(height: 1),
            _item(Icons.description_outlined, 'Términos y condiciones', null, () => abrirLegal(context, 'terminos')),
            const Divider(height: 1),
            if ('${legal['correoSoporte'] ?? ''}'.isNotEmpty) _item(Icons.support_agent_outlined, 'Soporte', '${legal['correoSoporte'] ?? ''}', () => _abrir('mailto:${legal['correoSoporte'] ?? ''}')),
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
