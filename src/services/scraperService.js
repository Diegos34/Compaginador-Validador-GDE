const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');
const { RUTA_ENTRADA_BASE, RUTA_SALIDA_BASE } = require('../config/paths');
const { obtenerTodosLosExpedientes, guardarObservacion } = require('./dbService');

const URL_EE_PANEL = 'https://eue-termasderiohondo.gde.gob.ar/expedientes-web/panelUsuario.zul';
const RUTA_SESION = path.resolve('./gde_session');

let procesoEnEjecucion = false;
let abortarScraper = false;
let contextoNavegadorActivo = null;

function detenerScraper(emitirLog = console.log) {
  if (!procesoEnEjecucion) return false;
  abortarScraper = true;
  emitirLog('[RPA GDE] 🛑 Solicitud de detención recibida. Cerrando navegador...');
  if (contextoNavegadorActivo) {
    contextoNavegadorActivo.close().catch(() => {});
  }
  return true;
}

function formatearExpedienteCompleto(expBase, reparticion = 'MEE#SEH') {
  const limpio = expBase.trim().replace(/^EX-/, '').replace(/-\s*-TRHONDO.*$/, '');
  return `EX-${limpio}- -TRHONDO-${reparticion}`;
}

async function inicializarNavegador(headless = false) {
  await fs.mkdir(RUTA_SESION, { recursive: true });
  const context = await chromium.launchPersistentContext(RUTA_SESION, {
    headless,
    viewport: { width: 1366, height: 768 },
    acceptDownloads: true,
    args: ['--start-maximized']
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  return { context, page };
}

async function asegurarSesionActiva(page, emitirLog) {
  await page.goto('https://eu-termasderiohondo.gde.gob.ar/eu-web/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (page.url().includes('/acceso/login')) {
    emitirLog('[RPA GDE] ⚠️ Sesión no iniciada. Por favor iniciá sesión en la ventana del navegador...');
    await page.waitForURL('**/eu-web/**', { timeout: 180000 });
    emitirLog('[RPA GDE] ✅ Inicio de sesión detectado y guardado.');
  }

  if (!page.url().includes('expedientes-web')) {
    emitirLog('[RPA GDE] Accediendo al módulo de Expediente Electrónico (EE)...');
    await page.goto(URL_EE_PANEL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function yaFueProcesado(expData) {
  const { expediente, id } = expData;
  try {
    const carpetasSalida = await fs.readdir(RUTA_SALIDA_BASE).catch(() => []);
    for (const fDir of carpetasSalida) {
      const rutaFecha = path.join(RUTA_SALIDA_BASE, fDir);
      const st = await fs.stat(rutaFecha).catch(() => null);
      if (st && st.isDirectory()) {
        const archivos = await fs.readdir(rutaFecha);
        if (archivos.some(a => a.toLowerCase().endsWith('.pdf') && (a.startsWith(`${id} `) || a.includes(expediente)))) {
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

async function descargarAdjuntosDeFila(page, carpetaDestino, emitirLog) {
  const modalVisor = page.locator('.z-window-modal, [class*="window"]').filter({ hasText: 'Visualizar Documento' });
  await modalVisor.waitFor({ state: 'visible', timeout: 8000 }).catch(() => null);

  if (!(await modalVisor.isVisible())) return;

  const btnDescargarDoc = modalVisor.locator('button, a, span').filter({ hasText: 'Descargar Documento' });
  if (await btnDescargarDoc.count() > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 7000 }),
        btnDescargarDoc.first().click()
      ]);
      const sugerido = download.suggestedFilename();
      const rutaDest = path.join(carpetaDestino, sugerido);
      await download.saveAs(rutaDest);
      emitirLog(`    📥 Documento principal descargado: ${sugerido}`);
    } catch (_) {}
  }

  const filasTrabajo = modalVisor.locator('tr').filter({ hasText: 'Visualizar' });
  const totalTrabajo = await filasTrabajo.count();

  for (let i = 0; i < totalTrabajo; i++) {
    if (abortarScraper) return;
    const fila = filasTrabajo.nth(i);
    const linkVisualizar = fila.locator('a, span, button').filter({ hasText: 'Visualizar' });

    if (await linkVisualizar.count() > 0) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 7000 }),
          linkVisualizar.first().click()
        ]);
        const nombreArchivo = download.suggestedFilename();
        const rutaDest = path.join(carpetaDestino, nombreArchivo);
        await download.saveAs(rutaDest);
        emitirLog(`    📎 Adjunto descargado: ${nombreArchivo}`);
      } catch (_) {}
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

async function buscarExpedienteEnGde(page, expBase, emitirLog) {
  const reparticiones = ['MEE#SEH', 'MEG#INT'];

  const tabConsultas = page.locator('.z-tab, .z-tab-text').filter({ hasText: 'Consultas' }).first();
  if (await tabConsultas.isVisible()) {
    await tabConsultas.click();
    await page.waitForTimeout(1000);
  }

  for (const rep of reparticiones) {
    if (abortarScraper) return { encontrado: false };
    const expedienteCompleto = formatearExpedienteCompleto(expBase, rep);
    emitirLog(`  • Probando búsqueda: ${expedienteCompleto}`);

    const inputBusqueda = page.locator('input[placeholder*="GDE"], input[title*="GDE"], .z-bandbox-input, .z-textbox').first();
    await inputBusqueda.click({ clickCount: 3 });
    await inputBusqueda.press('Backspace');
    await page.waitForTimeout(150);

    await inputBusqueda.fill(expedienteCompleto);
    await page.waitForTimeout(250);

    const btnLupa = page.locator('.z-bandbox-button, button:has(i.z-icon-search)').first();
    if (await btnLupa.isVisible()) {
      await btnLupa.click();
    } else {
      await inputBusqueda.press('Enter');
    }

    await page.waitForTimeout(3000);

    const popupError = page.locator('.z-messagebox-window, .z-window-highlighted').filter({ hasText: /no existe|no se encontr/i });
    if (await popupError.isVisible()) {
      emitirLog(`    ✖ No encontrado con ${rep}. Probando alternativa...`);
      const btnOk = popupError.locator('button').first();
      if (await btnOk.isVisible()) await btnOk.click();
      await page.waitForTimeout(800);
      continue;
    }

    const filaExpediente = page.locator('tr.z-row, tr.z-listitem').filter({ hasText: expBase }).first();
    if (await filaExpediente.isVisible()) {
      emitirLog(`    ✔ Localizado con repartición: ${rep}`);
      return { encontrado: true, fila: filaExpediente, expedienteCompleto };
    }
  }

  return { encontrado: false };
}

async function procesarExpedienteScraper(page, expData, emitirLog, notificarCambioEstado) {
  if (abortarScraper) return;
  const { expediente, id, nombre, fecha } = expData;
  emitirLog(`\n[RPA GDE] Iniciando: ID ${id} | ${nombre} | Exp: ${expediente}`);

  const fechaLimpia = (fecha || 'SIN_FECHA').replace(/\//g, '-');
  const nombreCarpeta = `${id} ${nombre} ${expediente}`.trim().replace(/[/\\?%*:|"<>]/g, ' ');
  const carpetaDestino = path.join(RUTA_ENTRADA_BASE, fechaLimpia, nombreCarpeta);

  const resultado = await buscarExpedienteEnGde(page, expediente, emitirLog);
  if (abortarScraper) return;

  if (!resultado.encontrado) {
    guardarObservacion(expediente, 'No se encontró el expediente en MEE#SEH ni en MEG#INT', true);
    if (notificarCambioEstado) notificarCambioEstado();
    return;
  }

  const comboAcciones = resultado.fila.locator('.z-combobox-button, input[readonly]').last();
  await comboAcciones.click();
  await page.waitForTimeout(600);

  const opcionVisualizar = page.locator('.z-combobox-popup .z-comboitem-text, .z-comboitem').filter({ hasText: 'Visualizar' }).first();
  if (await opcionVisualizar.isVisible()) {
    await opcionVisualizar.click();
  } else {
    await page.getByText('Visualizar', { exact: true }).last().click();
  }

  await page.waitForTimeout(2500);
  if (abortarScraper) return;

  await fs.mkdir(carpetaDestino, { recursive: true });

  const tabSinPase = page.locator('.z-tab, .z-tab-text').filter({ hasText: 'Sin Pase' }).first();
  if (await tabSinPase.isVisible()) {
    await tabSinPase.click();
    await page.waitForTimeout(1500);
  }

  const filasDoc = page.locator('tr.z-row, tr.z-listitem').filter({
    hasText: /DOCFI|NO - Nota|Orden de Pago/i
  });
  const total = await filasDoc.count();
  emitirLog(`  • Inspeccionando ${total} documentos en "Sin Pase"...`);

  for (let i = 0; i < total; i++) {
    if (abortarScraper) return;
    const fila = filasDoc.nth(i);
    const btnLupa = fila.locator('[title*="Visualizar"], i.z-icon-search, .z-toolbarbutton').last();

    if (await btnLupa.isVisible()) {
      await btnLupa.click();
      await page.waitForTimeout(1500);
      await descargarAdjuntosDeFila(page, carpetaDestino, emitirLog);
    }
  }

  const btnCerrarTramitacion = page.locator('.z-window-modal-close, .z-window-close').last();
  if (await btnCerrarTramitacion.isVisible()) {
    await btnCerrarTramitacion.click();
    await page.waitForTimeout(1000);
  }

  emitirLog(`[RPA GDE] ✔ Descargas finalizadas para el expediente ${expediente}.`);
  if (notificarCambioEstado) notificarCambioEstado();
}

async function ejecutarDescargaAutomatica(emitirLog = console.log, notificarCambioEstado = () => {}) {
  if (procesoEnEjecucion) {
    emitirLog('[RPA GDE] ⚠️ Ya hay una sesión de descarga activa.');
    return;
  }

  procesoEnEjecucion = true;
  abortarScraper = false;

  try {
    const expedientes = obtenerTodosLosExpedientes();

    const pendientes = [];
    for (const exp of expedientes) {
      if (exp.tiene_error_manual) continue;
      const procesado = await yaFueProcesado(exp);
      if (!procesado) pendientes.push(exp);
    }

    emitirLog(`[RPA GDE] Total a procesar: ${pendientes.length} expedientes.`);

    if (pendientes.length === 0) {
      emitirLog('[RPA GDE] No hay expedientes pendientes de descarga.');
      return;
    }

    emitirLog(`[RPA GDE] Lanzando navegador para procesar ${pendientes.length} expedientes...`);
    const { context, page } = await inicializarNavegador(false);
    contextoNavegadorActivo = context;

    await asegurarSesionActiva(page, emitirLog);

    for (const exp of pendientes) {
      if (abortarScraper) {
        emitirLog('[RPA GDE] ⏹ Proceso abortado por el usuario.');
        break;
      }
      await procesarExpedienteScraper(page, exp, emitirLog, notificarCambioEstado);
    }

    if (!abortarScraper) {
      emitirLog('\n[RPA GDE] 🎉 Proceso completado exitosamente.');
    }
  } catch (err) {
    if (abortarScraper) {
      emitirLog('[RPA GDE] ⏹ Sesión cerrada por solicitud de detención.');
    } else {
      emitirLog(`[RPA GDE] ❌ Error en el scraper: ${err.message}`);
    }
  } finally {
    procesoEnEjecucion = false;
    abortarScraper = false;
    if (contextoNavegadorActivo) {
      await contextoNavegadorActivo.close().catch(() => {});
      contextoNavegadorActivo = null;
    }
    if (notificarCambioEstado) notificarCambioEstado({ tipo: 'bot_terminado' });
  }
}

module.exports = {
  ejecutarDescargaAutomatica,
  detenerScraper
};
