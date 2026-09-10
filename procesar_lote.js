const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PDFDocument } = require('pdf-lib');
const xlsx = require('xlsx');
const sharp = require('sharp');

const execFileAsync = promisify(execFile);

const {
  RUTA_ENTRADA_BASE,
  RUTA_SALIDA_BASE,
  RUTA_TEMP,
  ARCHIVO_EXCEL_DEFAULT
} = require('./src/config/paths');
const { guardarObservacion } = require('./src/services/dbService');

function normalizarTexto(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

async function registrarAlertaEnObservaciones(expediente, mensajeError) {
  try {
    guardarObservacion(expediente, mensajeError, true);
  } catch (err) {
    console.error(`Error guardando alerta en base de datos SQLite: ${err.message}`);
  }
}

// Filtro para omitir carátulas de firmas GDE o copias redundantes
function esHojaDescartable(textoPagina, esFactura = false) {
  const tNorm = normalizarTexto(textoPagina || '');

  // 1. Descartar Hoja Adicional de Firmas / GEDO (GDE)
  if (
    tNorm.includes('HOJA ADICIONAL DE FIRMAS') ||
    tNorm.includes('EL DOCUMENTO FUE IMPORTADO POR EL SISTEMA GEDO')
  ) {
    return { descartar: true, motivo: 'Hoja Adicional de Firmas / GEDO' };
  }

  // 2. Descartar Duplicados o Triplicados en Facturas AFIP
  if (esFactura) {
    const esCopia = tNorm.includes('DUPLICADO') || tNorm.includes('TRIPLICADO');
    const esOriginal = tNorm.includes('ORIGINAL');

    if (esCopia && !esOriginal) {
      return { descartar: true, motivo: 'Copia no original (Duplicado/Triplicado)' };
    }
  }

  return { descartar: false };
}

function coincidenNombres(nombreExcel, textoDocumentos) {
  if (!nombreExcel || !textoDocumentos) return false;

  const palabrasIgnoradas = new Set(['SA', 'SRL', 'SH', 'DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'E', 'SAN', 'SANTA']);
  const tokensExcel = normalizarTexto(nombreExcel)
    .split(/\s+/)
    .filter(w => w.length >= 3 && !palabrasIgnoradas.has(w));

  if (tokensExcel.length === 0) return true;

  const textoNorm = normalizarTexto(textoDocumentos);
  const coincidencias = tokensExcel.filter(token => textoNorm.includes(token));
  const minimoRequerido = tokensExcel.length <= 2 ? 1 : 2;
  return coincidencias.length >= minimoRequerido;
}

async function resolverRutaExcel() {
  try {
    await fs.access(ARCHIVO_EXCEL_DEFAULT);
    return ARCHIVO_EXCEL_DEFAULT;
  } catch (_) {
    const archivos = await fs.readdir('./');
    const encontrado = archivos.find(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
    return encontrado ? path.resolve('./', encontrado) : null;
  }
}

function cargarDatosExcel(rutaExcel) {
  if (!rutaExcel) return new Map();
  try {
    const wb = xlsx.readFile(rutaExcel, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const filas = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    const mapa = new Map();

    for (const fila of filas) {
      const id = fila[2] ? String(fila[2]).trim() : '';
      const nombre = fila[3] ? String(fila[3]).trim() : '';
      const expRaw = fila[4] ? String(fila[4]).trim() : '';
      const monto = fila[6] !== undefined && fila[6] !== null ? Number(fila[6]) : null;

      if (expRaw && expRaw.includes('-')) {
        const expLimpio = expRaw.replace(/\s+/g, '');
        mapa.set(expLimpio, { id, nombre, expediente: expLimpio, monto });
      }
    }
    return mapa;
  } catch (_) {
    return new Map();
  }
}

async function ejecutarOcrPagina(rutaPdf, numeroPagina) {
  const tmpBase = path.join(RUTA_TEMP, `ocr_${Date.now()}_${numeroPagina}`);
  const tmpImg = `${tmpBase}.png`;

  try {
    await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', String(numeroPagina), '-l', String(numeroPagina), '-singlefile', rutaPdf, tmpBase]);
    let stdout = '';
    try {
      const res = await execFileAsync('tesseract', [tmpImg, 'stdout', '-l', 'spa', '--psm', '6']);
      stdout = res.stdout;
    } catch (_) {
      const resFallback = await execFileAsync('tesseract', [tmpImg, 'stdout', '--psm', '6']);
      stdout = resFallback.stdout;
    }
    await fs.unlink(tmpImg).catch(() => {});
    return stdout || '';
  } catch (err) {
    await fs.unlink(tmpImg).catch(() => {});
    return '';
  }
}

async function extraerTextoPaginaIndividual(rutaPdf, numeroPagina) {
  try {
    const { stdout } = await execFileAsync('pdftotext', [
      '-layout', '-enc', 'UTF-8',
      '-f', String(numeroPagina), '-l', String(numeroPagina),
      rutaPdf, '-'
    ]);
    return stdout || '';
  } catch (_) {
    return '';
  }
}

async function extraerTextoCompleto(rutaArchivo) {
  let textoFinal = '';
  let totalPaginas = 1;

  try {
    const { stdout: infoOut } = await execFileAsync('pdfinfo', [rutaArchivo]);
    const matchPages = infoOut.match(/Pages:\s*(\d+)/i);
    if (matchPages) totalPaginas = parseInt(matchPages[1], 10);
  } catch (_) {}

  for (let p = 1; p <= totalPaginas; p++) {
    let textoPag = await extraerTextoPaginaIndividual(rutaArchivo, p);

    if (textoPag.replace(/\s+/g, '').length < 35) {
      const ocrTexto = await ejecutarOcrPagina(rutaArchivo, p);
      textoPag += '\n' + ocrTexto;
    }
    textoFinal += '\n' + textoPag;
  }
  return textoFinal;
}

function normalizarFactura(pv, num) {
  if (!num) return null;
  const p = parseInt(pv || 0, 10);
  const n = parseInt(num, 10);
  if (isNaN(p) || isNaN(n)) return null;
  return `${p}-${n}`;
}

function limpiarNombre(str) {
  if (!str) return null;
  const limpio = str
    .replace(/ORIGINAL|DUPLICADO|TRIPLICADO|FACTURA|RESPONSABLE|MONOTRIBUTO|MUNICIPALIDAD|DOMICILIO|ARAS|BELGRANO/gi, ' ')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return (limpio.length >= 4 && !limpio.includes('MUNICIPALIDAD') && !limpio.includes('FORMULARIO') && !limpio.includes('SUJETO') && !limpio.includes('EXENTO')) ? limpio : null;
}

function extraerDatos(texto, nombreArchivo) {
  const datos = { op: null, monto: null, factura: null, titular: null, cuit: null };
  const lineas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const textoSinGde = texto
    .replace(/DOCFI-20\d{2}-\d{5,10}[^\s]*/gi, ' ')
    .replace(/EX-20\d{2}-\d{5,10}[^\s]*/gi, ' ');
  const tPlano = textoSinGde.replace(/\s+/g, ' ');

  // 1. Orden de Pago
  const matchOP = tPlano.match(/(?:ORDEN DE PAGO|OP)[^\d]{0,10}(\d{4,8}(?:\/\d{2,4})?)/i);
  if (matchOP) datos.op = matchOP[1].trim();

  // 2. Monto
  const matchMonto = tPlano.match(/\$\s?([\d.,]+)/);
  if (matchMonto) datos.monto = matchMonto[1].trim();

  // 3. CUIT
  const matchesCuit = [...tPlano.matchAll(/(?:CUIT(?:\s*N[°º])?[:\s]*)(\d{2}-?\d{8}-?\d{1})/gi)];
  for (const m of matchesCuit) {
    const c = m[1].replace(/-/g, '');
    if (c !== '30675078544') { datos.cuit = c; break; }
  }
  if (!datos.cuit) {
    const matchCuitFisica = tPlano.match(/\b(2[0347]-?\d{8}-?\d{1})\b/);
    if (matchCuitFisica) datos.cuit = matchCuitFisica[1].replace(/-/g, '');
  }

  // 4. FACTURA
  const matchPuntoVenta = tPlano.match(/Punto\s*de\s*Venta:?\s*(\d{1,5})/i) ||
                          textoSinGde.match(/Punto\s*de\s*Venta:?\s*(\d{1,5})/i);
  const matchCompNro = tPlano.match(/Comp\.?\s*Nro:?\s*(\d{1,8})/i) ||
                       textoSinGde.match(/Comp\.?\s*Nro:?\s*(\d{1,8})/i) ||
                       tPlano.match(/Comp(?:robante)?\.?\s*N[°º]?:?\s*(\d{1,8})/i);

  if (matchPuntoVenta && matchCompNro) {
    datos.factura = normalizarFactura(matchPuntoVenta[1], matchCompNro[1]);
  }

  if (!datos.factura) {
    const matchAfipDirecto = tPlano.match(/Punto\s*de\s*Venta:?\s*(\d{1,5})[^\d]{1,25}Comp\.?\s*Nro:?\s*(\d{1,8})/i);
    if (matchAfipDirecto) {
      datos.factura = normalizarFactura(matchAfipDirecto[1], matchAfipDirecto[2]);
    }
  }

  if (!datos.factura) {
    const matchRentas = tPlano.match(/FACTURA\s+[A-C]?\s+(\d{1,5})\s+(\d{5,8})/i) ||
                        textoSinGde.match(/FACTURA\s+[A-C]?[\s\S]{1,60}?(\d{3,5})\s+(\d{6,8})/i);
    if (matchRentas) {
      datos.factura = normalizarFactura(matchRentas[1], matchRentas[2]);
    }
  }

  if (!datos.factura) {
    const matchSicore = tPlano.match(/(?:Tique|Factura)[^\d]{1,35}(\d{4,5})\s*-\s*(\d{6,8})/i);
    if (matchSicore) {
      datos.factura = normalizarFactura(matchSicore[1], matchSicore[2]);
    }
  }

  if (!datos.factura) {
    const matchOpf = textoSinGde.match(/FAC(?:TURA)?\s+[A-Z\u0400-\u04FF]?\s*(\d{3,5})\s*-\s*(\d{5,8})/i) ||
                     tPlano.match(/FAC(?:TURA)?\s+[A-Z\u0400-\u04FF]?\s*(\d{3,5})\s*-\s*(\d{5,8})/i);
    if (matchOpf) {
      datos.factura = normalizarFactura(matchOpf[1], matchOpf[2]);
    }
  }

  if (!datos.factura && (nombreArchivo.toLowerCase().includes('sicore') || nombreArchivo.toLowerCase().includes('fac') || nombreArchivo.toLowerCase().includes('iibb'))) {
    const mNom = nombreArchivo.match(/(\d{1,5})\s*-\s*(\d{1,8})/);
    if (mNom) datos.factura = normalizarFactura(mNom[1], mNom[2]);
  }

  for (const l of lineas) {
    const matchTes = l.match(/Tesorer.*?a:\s*([A-Za-z\s]{4,40})/i);
    if (matchTes) { datos.titular = limpiarNombre(matchTes[1]); break; }
  }

  if (!datos.titular) {
    for (let i = 0; i < lineas.length; i++) {
      if (/Raz.*?n\s+Social:/i.test(lineas[i]) && !/Apellido/i.test(lineas[i])) {
        const parte = lineas[i].replace(/.*Raz.*?n\s+Social:\s*/i, '');
        const candMisma = limpiarNombre(parte.split(/ORIGINAL|Punto|Domicilio/i)[0]);
        if (candMisma) { datos.titular = candMisma; break; }
      }
    }
  }

  return datos;
}

function calcularPrioridadDocumento(doc) {
  const texto = normalizarTexto(doc.textoCompleto || '');
  const nombre = normalizarTexto(doc.nombreArchivo || '');
  const todo = `${nombre} ${texto}`;

  if (
    todo.includes('COMPROBANTE DE TRANSFERENCIA') ||
    todo.includes('BANCO SANTIAGO DEL ESTERO') ||
    todo.includes('TRANSFERENCIA INMEDIATA') ||
    todo.includes('TIPO CUENTA DEBITO')
  ) {
    return { prioridad: 10, tipo: 'COMPROBANTE_TRANSFERENCIA' };
  }

  if (
    todo.includes('ORDEN DE PAGO FINANCIERA') ||
    todo.includes('OPF') ||
    (todo.includes('ORDEN DE PAGO') && todo.includes('PAGUESE POR TESORERIA'))
  ) {
    return { prioridad: 90, tipo: 'ORDEN_PAGO_FINANCIERA' };
  }

  if (
    todo.includes('SI.CO.RE') ||
    todo.includes('SICORE') ||
    todo.includes('SISTEMA DE CONTROL DE RETENCIONES') ||
    todo.includes('IMPTO. A LAS GANANCIAS')
  ) {
    return { prioridad: 20, tipo: 'RETENCION_SICORE' };
  }

  if (
    todo.includes('DIRECCION GENERAL DE RENTAS') ||
    todo.includes('IMPUESTO SOBRE LOS INGRESOS BRUTOS') ||
    todo.includes('FORMULARIO F.12') ||
    nombre.includes('IIBB')
  ) {
    return { prioridad: 30, tipo: 'RETENCION_IIBB' };
  }

  if (
    todo.includes('SEGURIDAD SOCIAL') ||
    todo.includes('SUSS') ||
    todo.includes('CONTRIB.SEG.SOCIAL') ||
    todo.includes('F.2004')
  ) {
    return { prioridad: 40, tipo: 'RETENCION_SUSS' };
  }

  if (
    todo.includes('DECRETO') ||
    nombre.includes('DECRETO') ||
    todo.includes('VISTO Y CONSIDERANDO')
  ) {
    return { prioridad: 50, tipo: 'DECRETO' };
  }

  if (
    todo.includes('CONTRATO DE LOCACION') ||
    todo.includes('CONTRATO DE SERVICIOS') ||
    todo.includes('CONTRATO') ||
    nombre.includes('CONTRATO')
  ) {
    return { prioridad: 60, tipo: 'CONTRATO' };
  }

  if (
    todo.includes('ACTA DE RECEPCION') ||
    todo.includes('RECEPCION') ||
    nombre.includes('ACTA')
  ) {
    return { prioridad: 70, tipo: 'ACTA' };
  }

  if (
    todo.includes('TIQUE FACTURA') ||
    todo.includes('FACTURA') ||
    todo.includes('PUNTO DE VENTA') ||
    nombre.includes('FAC')
  ) {
    return { prioridad: 80, tipo: 'FACTURA' };
  }

  return { prioridad: 85, tipo: 'OTRO' };
}

function parsearNombreCarpetaExpediente(nombreCarpeta) {
  const limpio = nombreCarpeta.replace(/^\d+[\.\-\s]+/, '').trim();
  const matchExp = limpio.match(/(20\d{2}-\d{4,8})$/);
  const expediente = matchExp ? matchExp[1] : null;

  const matchId = limpio.match(/^(\d{5,8})\b/);
  const id = matchId ? matchId[1] : null;

  let nombre = limpio;
  if (id) nombre = nombre.replace(id, '');
  if (expediente) nombre = nombre.replace(expediente, '');
  nombre = normalizarTexto(nombre);

  return {
    nombreArchivoFinal: limpio,
    id,
    nombre,
    expediente
  };
}

async function purgarArchivosErroneos(carpetaExpediente, rutaPdfFinal) {
  console.log(`\n🧹 [PURGA ACTIVADA] Eliminando archivos erróneos...`);
  try {
    await fs.unlink(rutaPdfFinal);
    console.log(`  • Eliminado de salida: ${path.basename(rutaPdfFinal)}`);
  } catch (_) {}

  try {
    const archivos = await fs.readdir(carpetaExpediente);
    for (const arch of archivos) {
      const rutaArch = path.join(carpetaExpediente, arch);
      const st = await fs.stat(rutaArch).catch(() => null);
      if (st && st.isFile()) {
        await fs.unlink(rutaArch);
        console.log(`  • Eliminado de entrada: ${arch}`);
      }
    }
  } catch (err) {
    console.warn(`  • Error al limpiar entrada: ${err.message}`);
  }
}

async function encontrarAnguloCorrectoActa(rutaImg) {
  const angulos = [90, 270, 0, 180];
  const palabrasClave = ['RECEPCION', 'ACLARACION', 'ACTA', 'TERMAS', 'MUNICIPALIDAD', 'FIRMA', 'D.N.I'];

  for (const deg of angulos) {
    const tmpGiro = path.join(RUTA_TEMP, `test_${deg}_${Date.now()}.png`);
    try {
      if (deg === 0) {
        await fs.copyFile(rutaImg, tmpGiro);
      } else {
        await sharp(rutaImg).rotate(deg).png().toFile(tmpGiro);
      }

      const { stdout } = await execFileAsync('tesseract', [tmpGiro, 'stdout', '-l', 'spa', '--psm', '11'])
        .catch(() => ({ stdout: '' }));

      await fs.unlink(tmpGiro).catch(() => {});

      const texto = normalizarTexto(stdout);
      const coincide = palabrasClave.some(p => texto.includes(p));

      if (coincide) {
        return deg;
      }
    } catch (_) {
      await fs.unlink(tmpGiro).catch(() => {});
    }
  }

  return null;
}

async function procesarSubcarpetaExpediente(carpetaExpediente, carpetaFecha, mapaExcel) {
  const nombreCarpeta = path.basename(carpetaExpediente);
  const parsed = parsearNombreCarpetaExpediente(nombreCarpeta);

  const carpetaDestinoFecha = path.join(RUTA_SALIDA_BASE, carpetaFecha);
  await fs.mkdir(carpetaDestinoFecha, { recursive: true });
  const rutaPdfFinal = path.join(carpetaDestinoFecha, `${parsed.nombreArchivoFinal}.pdf`);

  try {
    await fs.access(rutaPdfFinal);
    console.log(`[SALTADO] Ya existe en salida: ${parsed.nombreArchivoFinal}.pdf`);
    return;
  } catch (_) {}

  const archivos = await fs.readdir(carpetaExpediente);
  const pdfs = archivos.filter(f => f.toLowerCase().endsWith('.pdf') && !f.includes(':'));

  if (pdfs.length === 0) return;

  console.log(`\n======================================================`);
  console.log(`EXPEDIENTE: ${parsed.nombreArchivoFinal}`);
  console.log(`Fecha: ${carpetaFecha}`);
  console.log(`======================================================`);

  const documentos = [];

  for (const nombreArchivo of pdfs) {
    const rutaCompleta = path.join(carpetaExpediente, nombreArchivo);
    const buffer = await fs.readFile(rutaCompleta);
    const textoCompleto = await extraerTextoCompleto(rutaCompleta);
    const metadatos = extraerDatos(textoCompleto, nombreArchivo);

    const clasificacion = calcularPrioridadDocumento({
      nombreArchivo,
      textoCompleto
    });

    const esComprobante = clasificacion.tipo === 'COMPROBANTE_TRANSFERENCIA';
    const esOPF = clasificacion.tipo === 'ORDEN_PAGO_FINANCIERA';
    const esRetencion = clasificacion.tipo.startsWith('RETENCION_');
    const esDocFactura = clasificacion.tipo === 'FACTURA' || clasificacion.tipo === 'ACTA';

    documentos.push({
      nombreArchivo,
      rutaCompleta,
      buffer,
      prioridad: clasificacion.prioridad,
      tipoDetectado: clasificacion.tipo,
      esComprobante,
      esOPF,
      esRetencion,
      esDocFactura,
      textoCompleto,
      ...metadatos
    });
  }

  const comp = documentos.find(d => d.esComprobante);
  const opf = documentos.find(d => d.esOPF);

  const facturaDoc = documentos.find(d => !d.esOPF && !d.esComprobante && !d.esRetencion && d.factura) ||
                     documentos.find(d => (d.nombreArchivo.toUpperCase().includes('FACTURA') || d.nombreArchivo.toUpperCase().includes('FAC')) && d.factura) ||
                     documentos.find(d => d.factura);

  const retencionDoc = documentos.find(d => d.esRetencion && d.factura) || documentos.find(d => d.esRetencion);

  let validacionCorrecta = true;
  let errorTitularExcel = false;
  let mensajeErrorExcel = '';

  console.log('\n=== CONTROL DE METADATOS ===');

  if (parsed.expediente) {
    const infoExcel = mapaExcel.get(parsed.expediente);
    if (infoExcel) {
      console.log('\n--- Cotejo con Planilla Excel ---');
      console.log(`  • Registro Excel: ID ${infoExcel.id} | Titular: ${infoExcel.nombre} | Monto: $${infoExcel.monto?.toLocaleString('es-AR')}`);

      const textoConsolidado = documentos.map(d => `${d.titular || ''} ${d.textoCompleto}`).join(' ');
      const coincideTitular = coincidenNombres(infoExcel.nombre, textoConsolidado);

      if (coincideTitular) {
        console.log(`  [OK EXCEL] Titular validado contra los comprobantes.`);
      } else {
        mensajeErrorExcel = `DISCREPANCIA: Excel indica "${infoExcel.nombre}" pero los PDFs descargados corresponden a otra persona`;
        console.warn(`\n[ALERTA CRÍTICA] ${mensajeErrorExcel}`);
        validacionCorrecta = false;
        errorTitularExcel = true;
      }
    }
  }

  if (errorTitularExcel) {
    await registrarAlertaEnObservaciones(parsed.expediente, mensajeErrorExcel);
    await purgarArchivosErroneos(carpetaExpediente, rutaPdfFinal);
    console.log(`[CANCELADO] Expediente cancelado y purgado para proteger la planilla.`);
    return;
  }

  if (comp && opf) {
    if (comp.op && opf.op && comp.op !== opf.op) {
      console.warn(`[ERROR OP] Discrepancia: Comprobante (${comp.op}) vs OPF (${opf.op})`);
      validacionCorrecta = false;
    } else {
      console.log(`[OK] OP: ${comp.op || opf.op || 'Detectada'}`);
    }

    if (comp.monto && opf.monto && comp.monto !== opf.monto) {
      console.warn(`[ERROR MONTO] Discrepancia: Comprobante ($${comp.monto}) vs OPF ($${opf.monto})`);
      validacionCorrecta = false;
    } else {
      console.log(`[OK] Monto verificado: $${comp.monto || opf.monto}`);
    }
  }

  console.log('\n--- Control de Número de Factura ---');
  const facFisica = facturaDoc?.factura || null;
  const facOPF = opf?.factura || null;
  const tieneRetencion = !!retencionDoc;
  const facRet = retencionDoc?.factura || null;

  console.log(`  • Factura física: ${facFisica ? facFisica.replace('-', ' N° ') : 'No detectada'}`);
  console.log(`  • En OPF: ${facOPF ? facOPF.replace('-', ' N° ') : 'No detectada / no aplica'}`);
  console.log(`  • En Retención: ${facRet ? facRet.replace('-', ' N° ') : (tieneRetencion ? 'NO DETECTADA (ERROR)' : 'No aplica')}`);

  if (!facFisica) {
    console.warn(`[ERROR FACTURA] No se pudo leer el número en la Factura física.`);
    validacionCorrecta = false;
  }

  if (facOPF && facOPF !== facFisica) {
    console.warn(`[ERROR FACTURA] Discrepancia: Física (${facFisica}) vs OPF (${facOPF})`);
    validacionCorrecta = false;
  }

  if (tieneRetencion) {
    if (!facRet) {
      console.warn(`[ERROR FACTURA] Se encontró retención (${retencionDoc.nombreArchivo}) pero no se pudo extraer el número de factura.`);
      validacionCorrecta = false;
    } else if (facRet !== facFisica) {
      console.warn(`[ERROR FACTURA] Discrepancia: Física (${facFisica}) vs Retención (${facRet})`);
      validacionCorrecta = false;
    }
  }

  if (validacionCorrecta && facFisica && (!tieneRetencion || facRet === facFisica)) {
    console.log(`[OK] Factura validada en todos los comprobantes: ${facFisica.replace('-', ' N° ')}`);
  }

  console.log('\n=== COMPAGINANDO ARCHIVOS ===');
  documentos.sort((a, b) => a.prioridad - b.prioridad);
  const pdfFinal = await PDFDocument.create();

  for (const doc of documentos) {
    try {
      const pdfOrigen = await PDFDocument.load(doc.buffer, { ignoreEncryption: true });
      const totalPaginas = pdfOrigen.getPageCount();

      const esCompuesto = (doc.tipoDetectado === 'ACTA' || doc.tipoDetectado === 'FACTURA') && totalPaginas > 1;

      if (esCompuesto) {
        console.log(`\n>>> [DESACOPLANDO DOCUMENTO] Analizando ${totalPaginas} páginas en: ${doc.nombreArchivo}`);

        const paginasActas = [];
        const paginasFacturas = [];

        for (let p = 1; p <= totalPaginas; p++) {
          const textoPagina = await extraerTextoPaginaIndividual(doc.rutaCompleta, p);
          const filtroDescarte = esHojaDescartable(textoPagina, doc.tipoDetectado === 'FACTURA');

          if (filtroDescarte.descartar) {
            console.log(`  ✂️ [PÁGINA DESCARTADA] Pág. ${p} de ${doc.nombreArchivo} (${filtroDescarte.motivo})`);
            continue;
          }

          const tmpBase = path.join(RUTA_TEMP, `pag_comp_${Date.now()}_${p}`);
          const imgFinal = `${tmpBase}.png`;

          await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', String(p), '-l', String(p), '-singlefile', doc.rutaCompleta, tmpBase]);

          let anguloActa = await encontrarAnguloCorrectoActa(imgFinal);

          if (anguloActa === null && (p > 1 || doc.nombreArchivo.toUpperCase().includes('ACTA'))) {
            anguloActa = 90;
          }

          if (anguloActa !== null && anguloActa !== 0) {
            console.log(`  • Pág. ${p}: Identificada como ACTA (Rotando ${anguloActa}° a horizontal)`);
            let pipeline = sharp(imgFinal);
            pipeline = pipeline.rotate(anguloActa);
            const buf = await pipeline.png().toBuffer();
            const imgEmbed = await pdfFinal.embedPng(buf);
            paginasActas.push({ img: imgEmbed, w: imgEmbed.width * 0.36, h: imgEmbed.height * 0.36 });
          } else {
            console.log(`  • Pág. ${p}: Identificada como FACTURA / TICKET (Vertical)`);
            const buf = await sharp(imgFinal).png().toBuffer();
            const imgEmbed = await pdfFinal.embedPng(buf);
            paginasFacturas.push({ img: imgEmbed, w: imgEmbed.width * 0.36, h: imgEmbed.height * 0.36 });
          }

          await fs.unlink(imgFinal).catch(() => {});
        }

        // 1º Actas (horizontales) -> 2º Factura (vertical)
        for (const item of paginasActas) {
          const pag = pdfFinal.addPage([item.w, item.h]);
          pag.drawImage(item.img, { x: 0, y: 0, width: pag.getWidth(), height: pag.getHeight() });
        }

        for (const item of paginasFacturas) {
          const pag = pdfFinal.addPage([item.w, item.h]);
          pag.drawImage(item.img, { x: 0, y: 0, width: pag.getWidth(), height: pag.getHeight() });
        }

      } else {
        // Documentos simples o fojas individuales
        for (let p = 1; p <= totalPaginas; p++) {
          const textoPagina = await extraerTextoPaginaIndividual(doc.rutaCompleta, p);
          const filtroDescarte = esHojaDescartable(textoPagina, doc.tipoDetectado === 'FACTURA');

          if (filtroDescarte.descartar) {
            console.log(`  ✂️ [PÁGINA DESCARTADA] Pág. ${p} de ${doc.nombreArchivo} (${filtroDescarte.motivo})`);
            continue;
          }

          const tmpBase = path.join(RUTA_TEMP, `pag_rot_${Date.now()}_${p}`);
          const imgFinal = `${tmpBase}.png`;

          await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', String(p), '-l', String(p), '-singlefile', doc.rutaCompleta, tmpBase]);

          const anguloActa = await encontrarAnguloCorrectoActa(imgFinal);

          if (anguloActa !== null && anguloActa !== 0) {
            console.log(`>>> [ACTA DETECTADA] ${doc.nombreArchivo} -> Rotando ${anguloActa}° a horizontal`);
            const buf = await sharp(imgFinal).rotate(anguloActa).png().toBuffer();
            const imgEmbed = await pdfFinal.embedPng(buf);
            const pagRot = pdfFinal.addPage([imgEmbed.width * 0.36, imgEmbed.height * 0.36]);
            pagRot.drawImage(imgEmbed, { x: 0, y: 0, width: pagRot.getWidth(), height: pagRot.getHeight() });
          } else {
            const [paginaOriginal] = await pdfFinal.copyPages(pdfOrigen, [p - 1]);
            pdfFinal.addPage(paginaOriginal);
          }

          await fs.unlink(imgFinal).catch(() => {});
        }
      }

      console.log(`[Prioridad ${doc.prioridad}] [${doc.tipoDetectado}] -> ${doc.nombreArchivo}`);
    } catch (errDoc) {
      console.error(`[ERROR DOC ${doc.nombreArchivo}] ${errDoc.message}`);
    }
  }

  const pdfBytes = await pdfFinal.save();
  await fs.writeFile(rutaPdfFinal, pdfBytes);

  console.log(`\nArchivo generado en: ${rutaPdfFinal}`);
  if (!validacionCorrecta) {
    console.log('[ATENCIÓN] REVISIÓN MANUAL: Hubo advertencias.');
  } else {
    console.log('[ÉXITO] Todas las validaciones pasaron correctamente.');
  }
}

async function limpiarTemporales() {
  try {
    const archivos = await fs.readdir(RUTA_TEMP);
    for (const f of archivos) {
      await fs.unlink(path.join(RUTA_TEMP, f)).catch(() => {});
    }
  } catch (_) {}
}

async function main() {
  const rutaExcel = await resolverRutaExcel();
  const mapaExcel = cargarDatosExcel(rutaExcel);

  await fs.mkdir(RUTA_ENTRADA_BASE, { recursive: true });
  await fs.mkdir(RUTA_SALIDA_BASE, { recursive: true });
  await fs.mkdir(RUTA_TEMP, { recursive: true });

  await limpiarTemporales();

  const itemsEntrada = await fs.readdir(RUTA_ENTRADA_BASE, { withFileTypes: true });
  const carpetasFecha = itemsEntrada.filter(i => i.isDirectory()).map(i => i.name);

  for (const fechaDir of carpetasFecha) {
    const rutaFecha = path.join(RUTA_ENTRADA_BASE, fechaDir);
    const subItems = await fs.readdir(rutaFecha, { withFileTypes: true });
    const subcarpetasExpedientes = subItems.filter(i => i.isDirectory()).map(i => path.join(rutaFecha, i.name));

    for (const expDir of subcarpetasExpedientes) {
      await procesarSubcarpetaExpediente(expDir, fechaDir, mapaExcel);
    }
  }

  await limpiarTemporales();

  console.log('\nLote completado.');
}

main().catch(console.error);
