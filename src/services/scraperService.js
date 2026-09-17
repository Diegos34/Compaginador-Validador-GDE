const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs/promises');
const { RUTA_ENTRADA_BASE } = require('../config/paths');
const dbService = require('./dbService');
const { clasificarYValidarPdf, evaluarChecklist } = require('./pdfClassifier');

const RUTA_SESION = path.resolve(__dirname, '../../temp_session');
const CARPETA_TEMP_DESCARGAS = path.resolve(__dirname, '../../temp_downloads');
let abortarScraper = false;

function detenerScraper(emitirLog) {
  abortarScraper = true;
  if (typeof emitirLog === 'function') emitirLog('[RPA GDE] ⛔ Solicitud de detención recibida.');
  return true;
}

function formatearFechaCarpeta(fechaCruda) {
  if (!fechaCruda) return 'SIN_FECHA';

  const str = String(fechaCruda).trim();

  // Si la fecha viene de la BD como "2025-12-02" (AAAA-MM-DD)
  const m2 = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (m2) {
    // m2[1]=Año, m2[2]=Mes, m2[3]=Día
    // Invertimos para forzar la salida a "02-12-2025"
    return `${m2[2]}-${m2[3]}-${m2[1]}`;
  }

  // Si la fecha ya viene en la tabla como "12-02-2025"
  const m1 = str.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m1) {
    // m1[1]=Primer par, m1[2]=Segundo par, m1[3]=Año
    // Cruzamos las posiciones de los dos primeros pares
    return `${m1[2]}-${m1[1]}-${m1[3]}`;
  }

  // Parseo genérico (fallback)
  const parseada = new Date(str);
  if (!isNaN(parseada.getTime())) {
    const d = String(parseada.getUTCDate()).padStart(2, '0');
    const m = String(parseada.getUTCMonth() + 1).padStart(2, '0');
    const y = parseada.getUTCFullYear();
    // Forzamos el mismo cruce aquí
    return `${m}-${d}-${y}`;
  }

  return 'SIN_FECHA';
}

function formatearNumeroSADE(expedienteRaw) {
  if (!expedienteRaw) return '';
  const str = String(expedienteRaw).trim();
  if (str.startsWith('EX-') && str.includes('TRHONDO')) return str;
  const match = str.match(/(\d{4})\s*[-/]\s*(\d+)/);
  if (match) {
    const anio = match[1];
    const numeroPadded = match[2].padStart(8, '0');
    return `EX-${anio}-${numeroPadded}- -TRHONDO-MEE#SEH`;
  }
  return str;
}

function esDocumentoRelevante(textoFila) {
  const patron = /docfi|orden\s+de\s+pago|opf|comprobante|transferencia|banco|f\.?2004|suss|sicore|retenci[oó]n|rentas|iibb|factura|decreto|contrato|recepci[oó]n|reparo/i;
  return patron.test(textoFila);
}

async function inicializarNavegador(headless = false) {
  await fs.mkdir(RUTA_SESION, { recursive: true });
  await fs.mkdir(CARPETA_TEMP_DESCARGAS, { recursive: true });

  const context = await chromium.launchPersistentContext(RUTA_SESION, {
    headless,
    viewport: null,
    acceptDownloads: true,
    downloadsPath: CARPETA_TEMP_DESCARGAS,
    args: [
      '--start-maximized',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--js-flags=--max-old-space-size=4096'
    ]
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  return { context, page };
}

async function procesarYGuardarBuffer(buffer, expData, carpetaDestino, nombreSugerido, hashesGuardados, docsRegistrados, emitirLog, notificarCambio) {
  if (!buffer || buffer.length < 1500) return false;

  const resultado = await clasificarYValidarPdf(buffer, expData);
  if (!resultado.valido) return false;

  if (hashesGuardados.has(resultado.sha)) {
    emitirLog(`    ℹ Duplicado omitido [${resultado.tipo}]: archivo idéntico ya guardado.`);
    return false;
  }

  hashesGuardados.add(resultado.sha);
  docsRegistrados.push({ tipo: resultado.tipo, sha: resultado.sha, fechaDoc: resultado.fechaDoc });

  const nombreLimpio = `${resultado.tipo}_${nombreSugerido}.pdf`.replace(/[/\\?%*:|"<>]/g, '_');
  const rutaFinal = path.join(carpetaDestino, nombreLimpio);

  await fs.writeFile(rutaFinal, buffer);
  emitirLog(`    ✔ [${resultado.tipo}] Guardado (${Math.round(buffer.length / 1024)} KB): ${nombreLimpio}`);

  if (typeof notificarCambio === 'function') notificarCambio();
  return true;
}

async function salirDelVisor(page, emitirLog) {
  if (page.isClosed()) return;
  try {
    emitirLog('    🔙 Recargando página de Consultas para salir de forma segura...');
    await page.goto('https://eue-termasderiohondo.gde.gob.ar/expedientes-web/panelUsuario.zul', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const tabConsultas = page.locator('.z-tab:has-text("Consultas")').first();
    if (await tabConsultas.isVisible().catch(() => false)) {
        await tabConsultas.click({ force: true });
        await page.waitForTimeout(1000);
    }
  } catch (error) {
    if (emitirLog) emitirLog(`    ⚠️ Error al recargar página: ${error.message}`);
  }
}

async function procesarModalAbierto(page, expData, carpetaDestino, prefijoFila, hashesGuardados, docsRegistrados, emitirLog, notificarCambio, promesaPdf) {
  let bufferCapturado = null;

  try {
    if (page.isClosed()) return;
    emitirLog('    ⏳ Esperando recepción del stream PDF desde la red...');

    if (promesaPdf) {
      bufferCapturado = await promesaPdf;
      if (bufferCapturado) {
        emitirLog(`    ✔ PDF capturado desde red (${Math.round(bufferCapturado.length / 1024)} KB)`);

        // --- INICIO INYECCIÓN DEBUG: GUARDADO FORZOSO ---
        try {
          const debugPath = path.join(carpetaDestino, `DEBUG_${prefijoFila}.pdf`.replace(/[/\\?%*:|"<>]/g, '_'));
          await fs.writeFile(debugPath, bufferCapturado);
          emitirLog(`    🛠️ [DEBUG] Archivo crudo forzado en disco: DEBUG_${prefijoFila}.pdf`);
        } catch (e) {
          emitirLog(`    ⚠️ [DEBUG] Error al forzar guardado en disco: ${e.message}`);
        }
        // --- FIN INYECCIÓN DEBUG ---

        // Dejamos que el flujo normal intente clasificarlo
        await procesarYGuardarBuffer(bufferCapturado, expData, carpetaDestino, prefijoFila, hashesGuardados, docsRegistrados, emitirLog, notificarCambio);
      }
    }

    if (!bufferCapturado) {
      emitirLog('    ⚠️ No se pudo capturar el archivo PDF por red.');
    }

  } finally {
    if (!page.isClosed() && !abortarScraper) {
        await salirDelVisor(page, emitirLog);
    }
  }
}

async function procesarExpedienteScraper(page, expedienteRow, carpetaBaseEntrada, emitirLog, notificarCambio) {
  const expNumero = expedienteRow.expediente;
  const codigoSADEOficial = formatearNumeroSADE(expNumero);
  const matchNum = expNumero.match(/(\d{4})\s*[-/]\s*(\d+)/);
  const anio = matchNum ? matchNum[1] : '2025';
  const soloNumero = matchNum ? matchNum[2] : expNumero;
  const numeroConCeros = soloNumero.padStart(8, '0');

  emitirLog(`\n[RPA GDE] Procesando: ID ${expedienteRow.id} | ${expedienteRow.beneficiario} | Exp: ${expNumero}`);
  emitirLog(`  • Buscando: ${codigoSADEOficial}`);

  // Extrae la fecha que viene de la tabla de tu sitio web
  const fechaFila = expedienteRow.fecha_orden || expedienteRow.fecha;
  const fechaCarpeta = formatearFechaCarpeta(fechaFila);

  // Arma la subcarpeta: ID + Nombre + Numero de expediente
  const subcarpetaNombre = `${expedienteRow.id} ${expedienteRow.beneficiario} ${expedienteRow.expediente}`.replace(/[/\\?%*:|"<>]/g, '_');

  // 👇 ESTA ES LA LÍNEA QUE FALTABA 👇
  const carpetaDestino = path.join(carpetaBaseEntrada, fechaCarpeta, subcarpetaNombre);

  // Si la carpeta de la fecha o del expediente no existen, las crea. Si existen, las conserva.
  await fs.mkdir(carpetaDestino, { recursive: true });

  const hashesGuardados = new Set();
  const docsRegistrados = [];

  await page.goto('https://eue-termasderiohondo.gde.gob.ar/expedientes-web/panelUsuario.zul', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const tabConsultasInit = page.locator('.z-tab:has-text("Consultas")').first();
  if (await tabConsultasInit.isVisible().catch(() => false)) {
      await tabConsultasInit.click({ force: true });
      await page.waitForTimeout(1000);
  }

  const inputBuscador = page.locator('input[placeholder*="número GDE" i], input[title*="número GDE" i], input.z-textbox').first();
  await inputBuscador.waitFor({ state: 'visible', timeout: 10000 });
  await inputBuscador.fill('');
  await inputBuscador.fill(codigoSADEOficial);

  const btnLupa = page.locator('button:has(i.z-icon-search), a:has(i.z-icon-search)').first();
  if (await btnLupa.isVisible().catch(() => false)) {
    await btnLupa.click({ force: true });
  } else {
    await page.keyboard.press('Enter');
  }

  emitirLog('  ⏳ Esperando grilla de resultados...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);

  const filaExp = page.locator('tr.z-listitem, tr.z-row').filter({ hasText: numeroConCeros }).first();
  await filaExp.waitFor({ state: 'visible', timeout: 10000 });
  emitirLog('  ✔ Expediente encontrado. Abriendo menú de acciones...');

  const combobox = filaExp.locator('.z-combobox').first();
  await combobox.scrollIntoViewIfNeeded();

  const btnFlecha = combobox.locator('.z-combobox-button, .z-combobox-btn, i.z-icon-caret-down').first();
  if (await btnFlecha.isVisible().catch(() => false)) {
    await btnFlecha.click();
  } else {
    const inputCombo = combobox.locator('input').first();
    await inputCombo.click();
    await page.keyboard.press('Alt+ArrowDown');
  }

  const itemVisualizar = page.locator('div.z-combobox-popup li.z-comboitem span.z-comboitem-text:text-is("Visualizar"), .z-comboitem-text:text-is("Visualizar")').first();
  await itemVisualizar.waitFor({ state: 'visible', timeout: 6000 });
  await itemVisualizar.click({ force: true });

  emitirLog('  ⏳ Esperando carga de la vista del expediente...');
  await page.waitForTimeout(4500);

  const tabSinPase = page.locator('.z-tab:has-text("Sin Pase")').first();
  if (await tabSinPase.isVisible({ timeout: 8000 }).catch(() => false)) {
    await tabSinPase.click({ force: true });
    emitirLog('  ✔ Pestaña "Sin Pase" seleccionada.');
    await page.waitForTimeout(2000);
  }

  let hayPaginaDocSiguiente = true;
  let numeroPaginaDoc = 1;

  while (hayPaginaDocSiguiente && !page.isClosed()) {
    const panelActivo = page.locator('.z-tabpanel:not([style*="display: none"])');
    const filasDoc = panelActivo.locator('tr.z-listitem, tr.z-row');
    const totalFilas = await filasDoc.count().catch(() => 0);
    emitirLog(`  • Pág ${numeroPaginaDoc}: Analizando ${totalFilas} filas...`);

    for (let i = 0; i < totalFilas; i++) {
      if (abortarScraper || page.isClosed()) break;

      const fila = filasDoc.nth(i);
      const textoFila = await fila.innerText().catch(() => '');

      if (!esDocumentoRelevante(textoFila)) continue;

      const matchNumDoc = textoFila.match(/(IF|DOCFI|NO|DECRE|ACTO|PV)-\d{4}-\d+-[A-Z0-9_#-]+/i);
      const nombreBase = matchNumDoc ? matchNumDoc[0].replace(/[/\\?%*:|"<>]/g, '_') : `doc_p${numeroPaginaDoc}_${i + 1}`;

      const btnHojaVisualizar = fila.locator('button:has(i.z-icon-file-text-o), button:has(i.z-icon-file-text), button[title*="Visualizar" i], a[title*="Visualizar" i]').first();

      if (await btnHojaVisualizar.isVisible().catch(() => false)) {
        emitirLog(`  ▶ Abriendo visor (icono hoja): ${nombreBase}...`);

        let resolverPdf;
        const promesaPdf = new Promise((resolve) => {
          const timeoutId = setTimeout(() => resolve(null), 25000);
          const onResponse = async (res) => {
            try {
              if (res.status() !== 200) return;

              const url = res.url();
              const headers = res.headers();
              const contentType = headers['content-type'] || '';
              const disposition = headers['content-disposition'] || '';

              const esPdf = (
                contentType.includes('application/pdf') ||
                url.includes('previsualizacion.pdf') ||
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(url)
              );

              if (esPdf) {
                const body = await res.body().catch(() => null);
                if (body && body.length > 2000 && body.toString('utf8', 0, 4) === '%PDF') {
                  clearTimeout(timeoutId);
                  page.off('response', onResponse);
                  resolve(body);
                }
              }
            } catch (_) {}
          };
          page.on('response', onResponse);
        });

        await btnHojaVisualizar.click({ force: true });

        await procesarModalAbierto(
          page,
          expedienteRow,
          carpetaDestino,
          nombreBase,
          hashesGuardados,
          docsRegistrados,
          emitirLog,
          notificarCambio,
          promesaPdf
        );

        if (!page.isClosed()) {
            emitirLog('  🔄 Reconstruyendo vista del expediente para continuar...');

            const inputReBuscador = page.locator('input[placeholder*="número GDE" i], input[title*="número GDE" i], input.z-textbox').first();
            await inputReBuscador.waitFor({ state: 'visible', timeout: 10000 });
            await inputReBuscador.fill('');
            await inputReBuscador.fill(codigoSADEOficial);
            const btnReLupa = page.locator('button:has(i.z-icon-search), a:has(i.z-icon-search)').first();
            if (await btnReLupa.isVisible().catch(() => false)) await btnReLupa.click({ force: true });
            else await page.keyboard.press('Enter');
            await page.waitForTimeout(4000);

            const reFilaExp = page.locator('tr.z-listitem, tr.z-row').filter({ hasText: numeroConCeros }).first();
            await reFilaExp.waitFor({ state: 'visible', timeout: 10000 });
            const reCombobox = reFilaExp.locator('.z-combobox').first();
            await reCombobox.scrollIntoViewIfNeeded();
            const reBtnFlecha = reCombobox.locator('.z-combobox-button, .z-combobox-btn, i.z-icon-caret-down').first();
            if (await reBtnFlecha.isVisible().catch(() => false)) await reBtnFlecha.click();
            else { const inputReCombo = reCombobox.locator('input').first(); await inputReCombo.click(); await page.keyboard.press('Alt+ArrowDown'); }
            const reItemVisualizar = page.locator('div.z-combobox-popup li.z-comboitem span.z-comboitem-text:text-is("Visualizar"), .z-comboitem-text:text-is("Visualizar")').first();
            await reItemVisualizar.waitFor({ state: 'visible', timeout: 6000 });
            await reItemVisualizar.click({ force: true });
            await page.waitForTimeout(4500);

            const reTabSinPase = page.locator('.z-tab:has-text("Sin Pase")').first();
            if (await reTabSinPase.isVisible({ timeout: 8000 }).catch(() => false)) {
                await reTabSinPase.click({ force: true });
                await page.waitForTimeout(2000);
            }

            for(let p = 1; p < numeroPaginaDoc; p++) {
                const rePanelActivo = page.locator('.z-tabpanel:not([style*="display: none"])');
                const btnReSiguiente = rePanelActivo.locator('.z-paging-next:not([disabled])').first();
                if (await btnReSiguiente.isVisible().catch(() => false)) {
                    await btnReSiguiente.click({ force: true });
                    await page.waitForTimeout(2000);
                }
            }
        }
      }

      await page.waitForTimeout(600).catch(() => {});
    }

    const evaluacionActual = evaluarChecklist(docsRegistrados, fechaCarpeta);
    if (evaluacionActual.completo) {
      hayPaginaDocSiguiente = false;
      break;
    }

    const btnSiguiente = panelActivo.locator('.z-paging-next:not([disabled])').first();
    if (await btnSiguiente.isVisible().catch(() => false)) {
      await btnSiguiente.click({ force: true });
      numeroPaginaDoc++;
      emitirLog(`  ⏳ Pasando a página ${numeroPaginaDoc} de "Sin Pase"...`);
      await page.waitForTimeout(2000);
    } else {
      hayPaginaDocSiguiente = false;
    }
  }

  const evaluacion = evaluarChecklist(docsRegistrados, fechaCarpeta);
  if (evaluacion.completo) {
    emitirLog(`[RPA GDE] ✔ Expediente completado con éxito (${docsRegistrados.length} PDFs válidos).`);
    return true;
  } else {
    emitirLog(`[RPA GDE] ⚠️ Expediente incompleto. Faltan: ${evaluacion.faltantes.join(', ')}.`);
    return false;
  }
}

async function ejecutarDescargaAutomatica(emitirLog, notificarCambio) {
  abortarScraper = false;
  let context = null;
  let page = null;

  try {
    const todos = dbService.obtenerTodosLosExpedientes();
    const pendientes = todos.filter(e => !e.tiene_error_manual && (!e.estado || e.estado.toLowerCase() === 'pendiente'));

    if (pendientes.length === 0) {
      emitirLog('[RPA GDE] ℹ No hay expedientes pendientes para procesar.');
      return;
    }

    emitirLog(`[RPA GDE] Total a procesar: ${pendientes.length} expedientes.`);
    emitirLog('[RPA GDE] Lanzando navegador...');

    const nav = await inicializarNavegador(false);
    context = nav.context;
    page = nav.page;

    await page.goto('https://eu-termasderiohondo.gde.gob.ar/eu-web/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    if (page.url().includes('login') || page.url().includes('cas')) {
      emitirLog('[RPA GDE] ⚠️ Sesión no iniciada. Por favor iniciá sesión en la ventana del navegador...');
      await page.waitForURL('**/eu-web/**', { timeout: 120000 }).catch(() => null);
      emitirLog('[RPA GDE] ✔ Inicio de sesión detectado.');
      await page.waitForTimeout(2000);
    }

    for (const exp of pendientes) {
      if (abortarScraper || page.isClosed()) {
        emitirLog('[RPA GDE] ⛔ Proceso detenido por el usuario.');
        break;
      }

      const expFila = {
        id: exp.id,
        beneficiario: exp.beneficiario || exp.nombre || '',
        expediente: exp.expediente,
        fecha_orden: exp.fecha || exp.fecha_orden,
        monto: exp.monto
      };

      const exito = await procesarExpedienteScraper(page, expFila, RUTA_ENTRADA_BASE, emitirLog, notificarCambio);

      if (!exito) {
        dbService.guardarObservacion(exp.expediente, 'Faltan documentos obligatorios en checklist o revisión manual', 1);
      }

      if (typeof notificarCambio === 'function') notificarCambio();
      await page.waitForTimeout(1500);
    }

    emitirLog('[RPA GDE] 🎉 Proceso completado exitosamente.');
  } catch (error) {
    emitirLog(`[RPA GDE] ❌ Error general en la ejecución: ${error.message}`);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

module.exports = {
  inicializarNavegador,
  procesarExpedienteScraper,
  ejecutarDescargaAutomatica,
  detenerScraper
};
