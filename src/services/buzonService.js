const fs = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');
const { RUTA_BUZON } = require('../config/paths');
const { obtenerODefinirCarpetaDestino } = require('./excelService');

let expedienteActivoBuzon = null;
let watcherInstance = null;

function getExpedienteActivo() {
  return expedienteActivoBuzon;
}

function setExpedienteActivo(datos) {
  expedienteActivoBuzon = datos?.expediente ? datos : null;
  return expedienteActivoBuzon;
}

function esArchivoValido(nombreArchivo) {
  const lower = nombreArchivo.toLowerCase();
  return (
    lower.endsWith('.pdf') &&
    !lower.includes(':') &&
    !lower.includes('zone.identifier') &&
    !lower.startsWith('~$') &&
    !lower.endsWith('.tmp') &&
    !lower.endsWith('.crdownload')
  );
}

async function procesarArchivoEntrante(rutaArchivoCompleta, onLog, onCambio) {
  if (!expedienteActivoBuzon) return;

  const nombreArchivo = path.basename(rutaArchivoCompleta);

  // Limpiar identificadores de zona o temporales sueltos
  if (
    nombreArchivo.includes('Zone.Identifier') ||
    nombreArchivo.includes(':') ||
    nombreArchivo.endsWith('.tmp')
  ) {
    await fs.unlink(rutaArchivoCompleta).catch(() => {});
    return;
  }

  if (!esArchivoValido(nombreArchivo)) return;

  try {
    const stats = await fs.stat(rutaArchivoCompleta).catch(() => null);
    if (!stats || stats.size === 0) return;

    const carpetaDestino = await obtenerODefinirCarpetaDestino(
      expedienteActivoBuzon.fecha,
      expedienteActivoBuzon.id,
      expedienteActivoBuzon.nombre,
      expedienteActivoBuzon.expediente
    );

    const destinoFinal = path.join(carpetaDestino, nombreArchivo);

    await fs.copyFile(rutaArchivoCompleta, destinoFinal);
    await fs.unlink(rutaArchivoCompleta).catch(() => {});

    if (onLog) {
      onLog(`[BUZÓN AUTO] Asignado "${nombreArchivo}" -> Exp: ${expedienteActivoBuzon.expediente}\n`);
    }

    if (onCambio) {
      onCambio();
    }
  } catch (err) {
    console.error(`Error procesando archivo de buzón ${nombreArchivo}:`, err.message);
  }
}

async function vaciarBuzonHaciaExpediente(onLog, onCambio) {
  if (!expedienteActivoBuzon) return;

  try {
    const archivos = await fs.readdir(RUTA_BUZON);
    for (const arch of archivos) {
      const rutaCompleta = path.join(RUTA_BUZON, arch);
      await procesarArchivoEntrante(rutaCompleta, onLog, onCambio);
    }
  } catch (err) {
    console.error('Error vaciando buzón:', err.message);
  }
}

function inicializarObservadorBuzon(onLog, onCambio) {
  if (watcherInstance) {
    watcherInstance.close();
  }

  watcherInstance = chokidar.watch(RUTA_BUZON, {
    ignored: /(^|[\/\\])\..|Zone\.Identifier/,
    persistent: true,
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 400,
      pollInterval: 100
    }
  });

  watcherInstance.on('add', (rutaCompleta) => {
    procesarArchivoEntrante(rutaCompleta, onLog, onCambio);
  });

  watcherInstance.on('error', (err) => {
    console.error('Error en watcher chokidar:', err.message);
  });
}

module.exports = {
  getExpedienteActivo,
  setExpedienteActivo,
  vaciarBuzonHaciaExpediente,
  inicializarObservadorBuzon
};
