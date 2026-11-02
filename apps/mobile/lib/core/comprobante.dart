import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

/// Comprobante interno de venta/despacho/cobro en PDF, compartible por WhatsApp o correo
/// (PDF 3.2, Vendedor). No es comprobante electrónico SUNAT y así lo dice el documento.
Future<void> compartirComprobante({
  required String titulo,
  required String numero,
  required String cliente,
  required List<(String, String)> lineas,
  required String total,
  required String vendedor,
}) async {
  final fecha = DateFormat('dd/MM/yyyy HH:mm').format(DateTime.now());
  final doc = pw.Document(title: '$titulo $numero', author: 'Panadería Tanta');

  doc.addPage(pw.Page(
    // Ticket de 80 mm: se lee bien en el celular y en una impresora térmica.
    pageFormat: PdfPageFormat.roll80,
    margin: const pw.EdgeInsets.all(14),
    build: (_) => pw.Column(
      crossAxisAlignment: pw.CrossAxisAlignment.start,
      children: [
        pw.Center(child: pw.Text('PANADERÍA TANTA', style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold))),
        pw.Center(child: pw.Text('www.tantapanaderia.com', style: const pw.TextStyle(fontSize: 8))),
        pw.SizedBox(height: 10),
        pw.Text('$titulo · $numero', style: pw.TextStyle(fontSize: 10, fontWeight: pw.FontWeight.bold)),
        pw.Text('Fecha: $fecha', style: const pw.TextStyle(fontSize: 8)),
        pw.Text('Cliente: $cliente', style: const pw.TextStyle(fontSize: 8)),
        pw.Divider(),
        for (final (concepto, monto) in lineas)
          pw.Row(mainAxisAlignment: pw.MainAxisAlignment.spaceBetween, children: [
            pw.Expanded(child: pw.Text(concepto, style: const pw.TextStyle(fontSize: 9))),
            pw.Text(monto, style: const pw.TextStyle(fontSize: 9)),
          ]),
        pw.Divider(),
        pw.Row(mainAxisAlignment: pw.MainAxisAlignment.spaceBetween, children: [
          pw.Text('TOTAL', style: pw.TextStyle(fontSize: 11, fontWeight: pw.FontWeight.bold)),
          pw.Text(total, style: pw.TextStyle(fontSize: 11, fontWeight: pw.FontWeight.bold)),
        ]),
        pw.SizedBox(height: 10),
        pw.Text('Atendido por: $vendedor', style: const pw.TextStyle(fontSize: 8)),
        pw.SizedBox(height: 6),
        pw.Text('Documento interno. No es comprobante electrónico SUNAT.',
            style: pw.TextStyle(fontSize: 7, fontStyle: pw.FontStyle.italic)),
      ],
    ),
  ));

  await Printing.sharePdf(bytes: await doc.save(), filename: '${numero.replaceAll(RegExp(r'[^A-Za-z0-9-]'), '_')}.pdf');
}
