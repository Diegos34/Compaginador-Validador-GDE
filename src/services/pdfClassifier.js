const pdfParse = require('pdf-parse');
const crypto = require('crypto');

const REGLAS_DOCUMENTOS = [
  { tipo: 'RETENCION_SUSS', regex: /f\.?2004|seguridad\s+social|contrib\.?seg\.?social/i },
  { tipo: 'RETENCION_SICORE', regex: /si\.?co\.?re|sistema\s+de\s+control\s+de\s+retenciones|impto\.?\s+a\s+las\s+ganancias/i },
  { tipo: 'RETENCION_IIBB', regex: /ingresos\s+brutos|rentas\s+santiago\s+del\s+estero|f\.?12\.?0031|direcci[oó]n\s+general\s+de\s+rentas/i },
  { tipo: 'FACTURA', regex: /factura\s+[abc]|punto\s+de\s+venta|c\.a\.e\.|cuit\s+emisor/i },
  { tipo: 'DECRETO', regex: /\bdecreto\b|el\s+intendente\s+municipal.*decreta/i },
  { tipo: 'CONTRATO', regex: /contrato\s+de\s+locaci[oó]n|cl[aá]usula\s+primera/i },
  { tipo: 'ACTA', regex: /acta\s+de\s+recepci[oó]n|certificaci[oó]n\s+de\s+servicios/i },
  { tipo: 'FONDO_REPARO', regex: /fondo\s+de\s+reparo|garant[ií]a\s+de\s+obra/i }
];

function extraerFechaDocumento(texto) {
  const matchGen = texto.match(/\b(\d{2})[-/](\d{2})[-/](\d{4})\b/);
  return matchGen ? `${matchGen[1]}-${matchGen[2]}-${matchGen[3]}` : null;
}

async function clasificarYValidarPdf(buffer, expData = {}) {
  try {
    const data = await pdfParse(buffer);
    const texto = data.text.replace(/\s+/g, ' ');
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');

    const esOpf = /[oó]rden\s+de\s+pago\s+financiera|p[aá]guese\s+por\s+tesorer[ií]a|opf/i.test(texto);
    const esComprobante = /comprobante\s+de\s+transferencia|banco\s+santiago|n[°º]\s*de\s*transacci[oó]n|transferencia\s+bancaria/i.test(texto);

    let tipoDetectado = 'ANEXO_DESCONOCIDO';

    if (esOpf && esComprobante) {
      tipoDetectado = 'OPF_Y_COMPROBANTE';
    } else if (esOpf) {
      tipoDetectado = 'OPF';
    } else if (esComprobante) {
      tipoDetectado = 'COMPROBANTE';
    } else {
      for (const r of REGLAS_DOCUMENTOS) {
        if (r.regex.test(texto)) {
          tipoDetectado = r.tipo;
          break;
        }
      }
    }

    const fechaDetectada = extraerFechaDocumento(texto);

    return {
      valido: true,
      tipo: tipoDetectado,
      sha,
      fechaDoc: fechaDetectada,
      paginas: data.numpages,
      textoCorto: texto.substring(0, 300)
    };
  } catch (err) {
    return { valido: false, error: err.message };
  }
}

function evaluarChecklist(documentosEncontrados, fechaEsperada) {
  const tipos = new Set(documentosEncontrados.map(d => d.tipo));

  const faltantesObligatorios = [];
  const tieneOPF = tipos.has('OPF') || tipos.has('OPF_Y_COMPROBANTE');
  const tieneComprobante = tipos.has('COMPROBANTE') || tipos.has('OPF_Y_COMPROBANTE');

  if (!tieneComprobante) faltantesObligatorios.push('COMPROBANTE');
  if (!tieneOPF) faltantesObligatorios.push('OPF');

  let fechasCoinciden = true;
  let fechaDocInvalida = null;

  if (fechaEsperada && fechaEsperada !== 'SIN_FECHA') {
    for (const doc of documentosEncontrados) {
      if ((doc.tipo === 'COMPROBANTE' || doc.tipo === 'OPF' || doc.tipo === 'OPF_Y_COMPROBANTE') && doc.fechaDoc) {
        if (doc.fechaDoc !== fechaEsperada) {
          fechasCoinciden = false;
          fechaDocInvalida = `${doc.tipo} (${doc.fechaDoc} vs ${fechaEsperada})`;
          break;
        }
      }
    }
  }

  return {
    completo: faltantesObligatorios.length === 0 && fechasCoinciden,
    faltantes: faltantesObligatorios,
    fechasCoinciden,
    fechaDocInvalida,
    presentes: Array.from(tipos)
  };
}

module.exports = {
  clasificarYValidarPdf,
  evaluarChecklist
};
