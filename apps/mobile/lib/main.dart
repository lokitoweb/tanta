import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'core/api.dart';
import 'core/arranque.dart';
import 'core/tema.dart';
import 'core/tokens.dart';
import 'pantallas/activacion.dart';
import 'pantallas/actualizar.dart';
import 'pantallas/inicio.dart';
import 'pantallas/login.dart';
import 'ui/comunes.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Api.instancia.cargarSesion();
  await Api.instancia.cargarConfig();
  runApp(const TantaApp());
}

class TantaApp extends StatelessWidget {
  const TantaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tanta',
      debugShowCheckedModeBanner: false,
      theme: construirTema(),
      // Respeta el tamaño de letra del teléfono, con tope para que las tarjetas no se desborden.
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.3)),
        child: child!,
      ),
      home: const Raiz(),
    );
  }
}

/// Decide qué mostrar: carga, login o la aplicación con sesión.
class Raiz extends StatefulWidget {
  const Raiz({super.key});

  @override
  State<Raiz> createState() => _RaizState();
}

class _RaizState extends State<Raiz> {
  Map<String, dynamic>? _datos;
  EstadoVersion _version = const EstadoVersion();
  bool _cargando = true;

  /// Tras entrar: registra versión/dispositivo y pregunta si hay que actualizar.
  Future<void> _sesionLista(Map<String, dynamic> datos) async {
    final v = await arrancarSesion();
    if (mounted) setState(() { _datos = datos; _version = v; });
  }

  @override
  void initState() {
    super.initState();
    _arrancar();
  }

  Future<void> _arrancar() async {
    // Atajo de demostración: solo existe si se compila con DEMO_AUTOLOGIN=true.
    // No salta la autenticación: envía credenciales reales al servidor.
    // Solo en desarrollo: nunca existe en una versión publicada.
    const autologin = bool.fromEnvironment('DEMO_AUTOLOGIN') && !kReleaseMode;
    if (autologin && !Api.instancia.autenticado) {
      try {
        await Api.instancia.login(
          const String.fromEnvironment('DEMO_USER', defaultValue: 'osquilcate'),
          const String.fromEnvironment('DEMO_PASS', defaultValue: 'tanta'),
        );
      } catch (_) {}
    }
    if (Api.instancia.autenticado) {
      try {
        await Api.instancia.yo();
        await _sesionLista(await Api.instancia.datos());
      } catch (_) {
        await Api.instancia.cerrarSesion();
      }
    }
    if (mounted) setState(() => _cargando = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) {
      return const Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Marca(escala: 1.1),
              SizedBox(height: 22),
              SizedBox(
                width: 26,
                height: 26,
                child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.sand500),
              ),
            ],
          ),
        ),
      );
    }

    if (!Api.instancia.activada) {
      return Activacion(onActivada: () => setState(() {}));
    }

    if (_datos == null) {
      return LoginScreen(onEntrar: _sesionLista);
    }

    if (_version.obligatoria) return ActualizacionObligatoria(estado: _version);

    return Inicio(
      datos: _datos!,
      version: _version,
      onSalir: () async {
        await Api.instancia.cerrarSesion();
        if (mounted) setState(() => _datos = null);
      },
    );
  }
}
