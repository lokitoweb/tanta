import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';
import 'dos_pasos.dart';
import 'legal.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onEntrar});
  final ValueChanged<Map<String, dynamic>> onEntrar;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with SingleTickerProviderStateMixin {
  /// Solo en desarrollo: la build publicada se compila sin DEMO_LOGIN (sin credenciales ni atajos).
  static const _esDemo = bool.fromEnvironment('DEMO_LOGIN');
  static const _demo = [('Gerente', 'osquilcate'), ('Administrador', 'lbermudez'), ('Producción', 'rquispe'),
    ('Almacén', 'jramos'), ('Compras', 'psalas'), ('Vendedor', 'cmedina'), ('Cliente', 'mfernandez')];

  final _usuario = TextEditingController(text: _esDemo ? 'osquilcate' : '');
  final _clave = TextEditingController(text: _esDemo ? 'tanta' : '');
  late final AnimationController _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..forward();
  bool _cargando = false;
  bool _ver = false;
  bool _recuperar = false;
  String? _error;
  String? _ok;

  @override
  void initState() {
    super.initState();
    Api.instancia.recuperacionDisponible().then((v) { if (mounted) setState(() => _recuperar = v); });
  }

  @override
  void dispose() {
    _anim.dispose();
    _usuario.dispose();
    _clave.dispose();
    super.dispose();
  }

  Future<void> _cambiarServidor() async {
    final campo = TextEditingController(text: Api.base.replaceAll(RegExp(r'/api/v1$'), ''));
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Servidor'),
        content: TextField(
          controller: campo,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(labelText: 'Dirección del sistema', hintText: 'https://tu-dominio.com'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(ctx, campo.text), child: const Text('Conectar')),
        ],
      ),
    );
    if (url == null || url.trim().isEmpty || !mounted) return;
    setState(() { _cargando = true; _error = null; _ok = null; });
    try {
      await Api.instancia.cambiarServidor(url, forzar: true);
      if (mounted) setState(() => _ok = 'Conectado a ${Uri.tryParse(Api.base)?.host ?? url}. Ya puedes ingresar.');
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _entrar() async {
    FocusScope.of(context).unfocus();
    setState(() { _cargando = true; _error = null; _ok = null; });
    try {
      final paso = await Api.instancia.login(_usuario.text.trim(), _clave.text);
      if (paso != null) {
        // El rol exige verificación en dos pasos: código de la app autenticadora (o activarla la primera vez).
        if (!mounted) return;
        final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => DosPasos(paso: paso)));
        if (ok != true) return;
      }
      final datos = await Api.instancia.datos();
      if (!mounted) return;
      widget.onEntrar(datos);
    } on SinConexion {
      if (mounted) setState(() => _error = 'Sin conexión con el servidor. Revisa tu internet.');
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _clave.clear(); });
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final claim = '${(Api.instancia.config['negocio'] as Map?)?['claim'] ?? ''}';
    return Scaffold(
      backgroundColor: TantaColors.surfacePage,
      body: LayoutBuilder(builder: (context, c) {
        final alto = c.maxHeight;
        return SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: alto),
            child: Column(children: [
              // Encabezado de marca: degradado cálido, logo centrado que aparece con un leve zoom.
              Container(
                width: double.infinity,
                height: alto * 0.36,
                decoration: const BoxDecoration(
                  gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [TantaColors.ink900, TantaColors.ink700]),
                  borderRadius: BorderRadius.vertical(bottom: Radius.circular(28)),
                ),
                child: SafeArea(
                  bottom: false,
                  child: Center(
                    child: FadeTransition(
                        opacity: CurvedAnimation(parent: _anim, curve: Curves.easeOut),
                        child: ScaleTransition(
                          scale: Tween(begin: 0.86, end: 1.0).animate(CurvedAnimation(parent: _anim, curve: Curves.easeOutBack)),
                          child: Column(mainAxisSize: MainAxisSize.min, children: [
                            const Marca(escala: 1.15, invertida: true),
                            if (claim.isNotEmpty) ...[
                              const SizedBox(height: 14),
                              Text(claim.toUpperCase(), textAlign: TextAlign.center,
                                  style: TextStyle(fontSize: 10.5, letterSpacing: 3, fontWeight: FontWeight.w600, color: TantaColors.sand300.withValues(alpha: 0.9))),
                            ],
                          ]),
                        ),
                    ),
                  ),
                ),
              ),
              SlideTransition(
                position: Tween(begin: const Offset(0, 0.08), end: Offset.zero).animate(CurvedAnimation(parent: _anim, curve: Curves.easeOutCubic)),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(26, 30, 26, 24),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 420),
                    child: AutofillGroup(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Text('Iniciar sesión', textAlign: TextAlign.center, style: estiloDisplay.copyWith(fontSize: 26)),
                        const SizedBox(height: 24),
                        TextField(
                          controller: _usuario,
                          textInputAction: TextInputAction.next,
                          autocorrect: false,
                          autofillHints: const [AutofillHints.username],
                          decoration: const InputDecoration(labelText: 'Usuario o correo', prefixIcon: Icon(Icons.person_outline)),
                        ),
                        const SizedBox(height: 14),
                        TextField(
                          controller: _clave,
                          obscureText: !_ver,
                          textInputAction: TextInputAction.done,
                          autofillHints: const [AutofillHints.password],
                          onSubmitted: (_) => _cargando ? null : _entrar(),
                          decoration: InputDecoration(
                            labelText: 'Contraseña',
                            prefixIcon: const Icon(Icons.lock_outline),
                            suffixIcon: IconButton(
                              tooltip: _ver ? 'Ocultar contraseña' : 'Mostrar contraseña',
                              icon: Icon(_ver ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 21),
                              onPressed: () => setState(() => _ver = !_ver),
                            ),
                          ),
                        ),
                        if (_recuperar)
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              onPressed: () async {
                                final msg = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => RecuperarClave(identificador: _usuario.text.trim())));
                                if (msg != null && mounted) setState(() { _ok = msg; _error = null; });
                              },
                              child: const Text('¿Olvidaste tu contraseña?', style: TextStyle(fontWeight: FontWeight.w600)),
                            ),
                          )
                        else
                          const SizedBox(height: 14),
                        AnimatedSwitcher(
                          duration: const Duration(milliseconds: 200),
                          child: _error != null ? _Aviso(texto: _error!, error: true) : _ok != null ? _Aviso(texto: _ok!) : const SizedBox.shrink(),
                        ),
                        const SizedBox(height: 10),
                        FilledButton(
                          onPressed: _cargando ? null : _entrar,
                          child: _cargando
                              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.cream50))
                              : const Text('Ingresar'),
                        ),
                        TextButton(
                          onPressed: _cargando ? null : () async {
                            final msg = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const RegistroCliente()));
                            if (msg != null && mounted) setState(() { _ok = msg; _error = null; });
                          },
                          child: const Text('¿Eres cliente nuevo? Crear cuenta'),
                        ),
                        // El servidor al que se conecta y cómo cambiarlo (p. ej. un túnel con dirección nueva).
                        TextButton(
                          onPressed: _cargando ? null : _cambiarServidor,
                          child: Text('Servidor: ${Uri.tryParse(Api.base)?.host ?? '—'} · Cambiar',
                              style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
                        ),
                        if (_esDemo) ...[
                          const SizedBox(height: 24),
                          const Text('ACCESO RÁPIDO DE DEMOSTRACIÓN', textAlign: TextAlign.center,
                              style: TextStyle(fontSize: 10, letterSpacing: 1.2, fontWeight: FontWeight.w700, color: TantaColors.textMuted)),
                          const SizedBox(height: 10),
                          Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: _demo.map((d) => ActionChip(
                                label: Text(d.$1, style: const TextStyle(fontSize: 12)),
                                onPressed: () => setState(() { _usuario.text = d.$2; _clave.text = 'tanta'; _error = null; }),
                              )).toList()),
                        ],
                      ]),
                    ),
                  ),
                ),
              ),
            ]),
          ),
        );
      }),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso({required this.texto, this.error = false});
  final String texto;
  final bool error;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: error ? TantaColors.stateDangerBg : TantaColors.stateOk.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
        child: Row(children: [
          Icon(error ? Icons.error_outline : Icons.check_circle_outline, size: 18, color: error ? TantaColors.stateDanger : TantaColors.stateOk),
          const SizedBox(width: 8),
          Expanded(child: Text(texto, style: TextStyle(fontSize: 13, color: error ? TantaColors.stateDanger : TantaColors.stateOk))),
        ]),
      );
}

/// Recuperar contraseña: código de 6 dígitos al correo (SMTP configurado por el Superadmin).
class RecuperarClave extends StatefulWidget {
  const RecuperarClave({super.key, this.identificador = ''});
  final String identificador;

  @override
  State<RecuperarClave> createState() => _RecuperarClaveState();
}

class _RecuperarClaveState extends State<RecuperarClave> {
  late final _id = TextEditingController(text: widget.identificador);
  final _codigo = TextEditingController();
  final _nueva = TextEditingController();
  final _repetir = TextEditingController();
  bool _enviado = false;
  bool _ocupado = false;
  String? _error;
  String? _info;

  Future<void> _correr(Future<void> Function() fn) async {
    setState(() { _ocupado = true; _error = null; });
    try {
      await fn();
    } on SinConexion {
      setState(() => _error = 'Sin conexión con el servidor.');
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Recuperar contraseña')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Text(_enviado ? 'Escribe el código que te enviamos y tu nueva contraseña.' : 'Te enviaremos un código de 6 dígitos a tu correo registrado.',
            style: const TextStyle(color: TantaColors.textMuted)),
        const SizedBox(height: 20),
        TextField(controller: _id, enabled: !_enviado, autocorrect: false, decoration: const InputDecoration(labelText: 'Usuario o correo', prefixIcon: Icon(Icons.person_outline))),
        if (_enviado) ...[
          const SizedBox(height: 14),
          TextField(controller: _codigo, keyboardType: TextInputType.number, maxLength: 6, autofillHints: const [AutofillHints.oneTimeCode],
              decoration: const InputDecoration(labelText: 'Código', prefixIcon: Icon(Icons.pin_outlined), counterText: '')),
          const SizedBox(height: 14),
          TextField(controller: _nueva, obscureText: true, autofillHints: const [AutofillHints.newPassword], decoration: const InputDecoration(labelText: 'Nueva contraseña (mínimo 10)', prefixIcon: Icon(Icons.lock_outline))),
          const SizedBox(height: 14),
          TextField(controller: _repetir, obscureText: true, decoration: const InputDecoration(labelText: 'Repite la contraseña', prefixIcon: Icon(Icons.lock_outline))),
        ],
        if (_info != null) ...[const SizedBox(height: 14), _Aviso(texto: _info!)],
        if (_error != null) ...[const SizedBox(height: 14), _Aviso(texto: _error!, error: true)],
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _ocupado ? null : () => _correr(() async {
            if (!_enviado) {
              final m = await Api.instancia.pedirCodigo(_id.text.trim());
              setState(() { _enviado = true; _info = m; });
            } else {
              if (_nueva.text != _repetir.text) throw 'Las contraseñas no coinciden.';
              final m = await Api.instancia.restablecerClave(_id.text.trim(), _codigo.text.trim(), _nueva.text);
              if (mounted) Navigator.pop(this.context, m);
            }
          }),
          child: Text(_enviado ? 'Cambiar contraseña' : 'Enviarme un código'),
        ),
        if (_enviado) TextButton(onPressed: () => setState(() { _enviado = false; _info = null; }), child: const Text('No me llegó: pedir otro código')),
      ]),
    );
  }
}

/// A03 / SEG-04: registro del cliente. El servidor valida DNI/RUC (dígito verificador) y que no se repitan.
class RegistroCliente extends StatefulWidget {
  const RegistroCliente({super.key});
  @override
  State<RegistroCliente> createState() => _RegistroClienteState();
}

class _RegistroClienteState extends State<RegistroCliente> {
  final _c = {for (final k in ['nombre', 'docNumero', 'telefono', 'email', 'direccion', 'usuario', 'clave']) k: TextEditingController()};
  String _docTipo = 'DNI';
  bool _enviando = false;
  String? _error;

  Future<void> _registrar() async {
    setState(() { _enviando = true; _error = null; });
    try {
      final msg = await Api.instancia.registrarse({for (final e in _c.entries) e.key: e.value.text.trim(), 'docTipo': _docTipo});
      if (mounted) Navigator.pop(context, msg);
    } on ApiException catch (e) {
      setState(() => _error = e.mensaje);
    } catch (_) {
      setState(() => _error = 'Sin conexión: intenta de nuevo');
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  Widget _enlaceLegal(String texto, String doc) => GestureDetector(
        onTap: () => abrirLegal(context, doc),
        child: Text(texto, style: const TextStyle(fontSize: 12, color: TantaColors.ink800, fontWeight: FontWeight.w600, decoration: TextDecoration.underline)),
      );

  Widget _campo(String k, String etiqueta, IconData icono, {TextInputType? teclado, bool oculto = false, String? ayuda}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextField(controller: _c[k], keyboardType: teclado, obscureText: oculto, autocorrect: false,
            decoration: InputDecoration(labelText: etiqueta, prefixIcon: Icon(icono), helperText: ayuda)),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Crear cuenta')),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          _campo('nombre', 'Nombre o razón social', Icons.person_outline),
          SegmentedButton<String>(
            segments: const [ButtonSegment(value: 'DNI', label: Text('DNI')), ButtonSegment(value: 'RUC', label: Text('RUC'))],
            selected: {_docTipo},
            onSelectionChanged: (v) => setState(() => _docTipo = v.first),
          ),
          const SizedBox(height: 12),
          _campo('docNumero', _docTipo == 'DNI' ? 'Número de DNI (8 dígitos)' : 'Número de RUC (11 dígitos)', Icons.badge_outlined, teclado: TextInputType.number),
          _campo('telefono', 'Teléfono', Icons.phone_outlined, teclado: TextInputType.phone),
          _campo('email', 'Correo', Icons.mail_outline, teclado: TextInputType.emailAddress),
          _campo('direccion', 'Dirección de entrega', Icons.place_outlined),
          _campo('usuario', 'Usuario', Icons.alternate_email, ayuda: '4 a 30 letras o números'),
          _campo('clave', 'Contraseña', Icons.lock_outline, oculto: true, ayuda: 'Mínimo ${Api.instancia.claveMinima} caracteres'),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          FilledButton(onPressed: _enviando ? null : _registrar, child: Text(_enviando ? 'Creando…' : 'Crear cuenta')),
          const SizedBox(height: 10),
          Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
            const Text('Al registrarte aceptas la ', style: TextStyle(fontSize: 12, color: TantaColors.textMuted)),
            _enlaceLegal('política de privacidad', 'privacidad'),
            const Text(' y los ', style: TextStyle(fontSize: 12, color: TantaColors.textMuted)),
            _enlaceLegal('términos', 'terminos'),
            const Text('.', style: TextStyle(fontSize: 12, color: TantaColors.textMuted)),
          ]),
        ]),
      ),
    );
  }
}
