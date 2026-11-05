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
  /// Sin red al abrir: la sesión (y la cola offline) se conservan; se ofrece reintentar.
  String? _sinRed;

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
      } on ApiException catch (e) {
        // Solo una sesión rechazada (401/403) cierra la sesión; un 5xx no borra nada.
        if (e.status == 401 || e.status == 403) {
          await Api.instancia.cerrarSesion();
        } else {
          _sinRed = e.mensaje;
        }
      } catch (e) {
        _sinRed = e is SinConexion ? 'No hay conexión con el servidor.' : 'No se pudo cargar la información.';
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

    if (_sinRed != null) {
      return Scaffold(
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Marca(escala: 1.1),
                const SizedBox(height: 22),
                const Icon(Icons.wifi_off_rounded, size: 32, color: TantaColors.textMuted),
                const SizedBox(height: 10),
                Text(_sinRed!, textAlign: TextAlign.center, style: const TextStyle(color: TantaColors.textMuted)),
                const SizedBox(height: 4),
                const Text('Tu sesión y las operaciones pendientes siguen guardadas.', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: TantaColors.textMuted)),
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: () { setState(() { _sinRed = null; _cargando = true; }); _arrancar(); },
                  icon: const Icon(Icons.refresh_rounded), label: const Text('Reintentar'),
                ),
              ]),
            ),
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
