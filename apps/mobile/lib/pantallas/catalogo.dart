import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tema.dart';
import '../core/tokens.dart';

/// Catálogo para el cliente: precio con IGV y pedido rápido.
class Catalogo extends StatefulWidget {
  const Catalogo({super.key, required this.datos});
  final Map<String, dynamic> datos;

  @override
  State<Catalogo> createState() => _CatalogoState();
}

class _CatalogoState extends State<Catalogo> {
  final Map<String, int> _carrito = {};
  String _categoria = 'todas';

  @override
  Widget build(BuildContext context) {
    final productos = (widget.datos['productos'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    final categorias = (widget.datos['categorias'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    final filtrados = _categoria == 'todas'
        ? productos
        : productos.where((p) => p['categoriaId'] == _categoria).toList();

    final items = _carrito.values.fold<int>(0, (s, v) => s + v);
    final total = filtrados.fold<double>(0, (s, p) {
      final q = _carrito[p['id']] ?? 0;
      return s + q * ((p['precioConIgv'] as num?)?.toDouble() ?? 0);
    });

    return Column(
      children: [
        SizedBox(
          height: 56,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            children: [
              _chip('todas', 'Todo'),
              ...categorias.map((c) => _chip(c['id'] as String, c['nombre'] as String)),
            ],
          ),
        ),
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 120),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 230,
              mainAxisSpacing: 14,
              crossAxisSpacing: 14,
              childAspectRatio: 0.78,
            ),
            itemCount: filtrados.length,
            itemBuilder: (context, i) => _Producto(
              p: filtrados[i],
              cantidad: _carrito[filtrados[i]['id']] ?? 0,
              onAgregar: () => setState(() {
                final id = filtrados[i]['id'] as String;
                _carrito[id] = (_carrito[id] ?? 0) + 1;
              }),
            ),
          ),
        ),
        if (items > 0)
          Container(
            margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            padding: const EdgeInsets.fromLTRB(18, 14, 14, 14),
            decoration: BoxDecoration(
              color: TantaColors.ink800,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              children: [
                Container(
                  width: 30,
                  height: 30,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(color: TantaColors.cream50, shape: BoxShape.circle),
                  child: Text('$items',
                      style: const TextStyle(fontWeight: FontWeight.w700, color: TantaColors.ink900)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('$items ${items == 1 ? 'producto' : 'productos'}',
                          style: const TextStyle(
                              color: TantaColors.cream50, fontWeight: FontWeight.w600, fontSize: 13.5)),
                      Text('Total ${dinero(total)}',
                          style: const TextStyle(color: TantaColors.sand300, fontSize: 11.5)),
                    ],
                  ),
                ),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: TantaColors.cream50,
                    foregroundColor: TantaColors.ink900,
                    minimumSize: const Size(0, 42),
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                  ),
                  onPressed: () => setState(() => _carrito.clear()),
                  child: const Text('Pedir'),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _chip(String id, String etiqueta) {
    final activo = _categoria == id;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(etiqueta, style: TextStyle(fontSize: 12, color: activo ? TantaColors.cream50 : TantaColors.textSecondary)),
        selected: activo,
        backgroundColor: TantaColors.surfaceCard,
        selectedColor: TantaColors.ink800,
        side: BorderSide(color: activo ? TantaColors.ink800 : TantaColors.borderDefault),
        showCheckmark: false,
        onSelected: (_) => setState(() => _categoria = id),
      ),
    );
  }
}

class _Producto extends StatelessWidget {
  const _Producto({required this.p, required this.cantidad, required this.onAgregar});
  final Map<String, dynamic> p;
  final int cantidad;
  final VoidCallback onAgregar;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: TantaColors.surfaceCard,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: TantaColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Container(
              width: double.infinity,
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Color(0xFFE8D9C3), Color(0xFFD8C0A0)],
                ),
              ),
              alignment: Alignment.center,
              child: Text(
                '${p['nombre']}'.substring(0, 1),
                style: const TextStyle(
                  fontFamily: 'Fraunces',
                  fontSize: 44,
                  fontWeight: FontWeight.w600,
                  color: Color(0x552E1F18),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${p['nombre']}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: estiloDisplay.copyWith(fontSize: 14)),
                const SizedBox(height: 2),
                Text('por ${'${p['unidad']}'.toLowerCase()}',
                    style: const TextStyle(fontSize: 11, color: TantaColors.textMuted)),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(dinero((p['precioConIgv'] as num?)?.toDouble() ?? 0),
                        style: estiloDisplay.copyWith(fontSize: 15)),
                    InkWell(
                      onTap: onAgregar,
                      borderRadius: BorderRadius.circular(999),
                      child: Container(
                        width: 30,
                        height: 30,
                        decoration: BoxDecoration(
                          border: Border.all(color: TantaColors.borderDefault),
                          shape: BoxShape.circle,
                        ),
                        child: cantidad > 0
                            ? Center(
                                child: Text('$cantidad',
                                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12)))
                            : const Icon(Icons.add, size: 16),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
