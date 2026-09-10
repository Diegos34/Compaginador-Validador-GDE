const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const {
  RUTA_ENTRADA_BASE,
  RUTA_SALIDA_BASE,
  ARCHIVO_EXCEL_DEFAULT
} = require('../config/paths');
const {
  insertarOActualizarLote,
  obtenerTodosLosExpedientes
} = require('./dbService');

let cacheEstado = null;
let ultimaLecturaCache = 0;
const TTL_CACHE_MS = 2000;

function limpiarCacheEstado() {
  cacheEstado = null;
}

function normalizarTexto(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function formatearFecha(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${d}-${m}-${y}`;
  }
  const str = String(val).trim();

  const matchIso = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (matchIso) {
    const d = matchIso[3].padStart(2, '0');
    const m = matchIso[2].padStart(2, '0');
    return `${d}-${m}-${matchIso[1]}`;
  }

  const matchLatam = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (matchLatam) {
    const d = matchLatam[1].padStart(2, '0');
    const m = matchLatam[2].padStart(2, '0');
    return `${d}-${m}-${matchLatam[3]}`;
  }

  return str.replace(/[/\\?%*:|"<>]/g, '-');
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

// Carga el archivo Excel a la base SQLite
async function sincronizarExcelConDB() {
  const rutaExcel = await resolverRutaExcel();
  if (!rutaExcel) return null;

  const wb = xlsx.readFile(rutaExcel, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const filas = xlsx.utils.sheet_to_json(sheet, { header: 1 });

  const registros = [];
  let ultimaFechaValida = '';

  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || fila.length === 0) continue;

    if (fila[0]) {
      const f = formatearFecha(fila[0]);
      if (f) ultimaFechaValida = f;
    }

    const expRaw = fila[4] ? String(fila[4]).trim() : '';
    const matchExp = expRaw.match(/^20\d{2}-\d{4,8}$/);
    if (!matchExp) continue;

    const expediente = matchExp[0];
    const id = fila[2] ? String(Math.floor(Number(fila[2])) || fila[2]).trim() : '';
    const nombre = fila[3] ? String(fila[3]).trim() : '';
    const monto = fila[6] ? Number(fila[6]) : 0;

    registros.push({
      expediente,
      id,
      nombre,
      fecha: ultimaFechaValida || 'Sin fecha',
      monto
    });
  }

  if (registros.length > 0) {
    insertarOActualizarLote(registros);
  }

  return path.basename(rutaExcel);
}

async function obtenerODefinirCarpetaDestino(fecha, id, nombre, expediente) {
  const fechaCarpeta = (fecha || 'Sin fecha').replace(/[/\\?%*:|"<>]/g, '-');
  const rutaFecha = path.join(RUTA_ENTRADA_BASE, fechaCarpeta);
  await fs.mkdir(rutaFecha, { recursive: true });

  const existentes = await fs.readdir(rutaFecha).catch(() => []);
  const yaExiste = existentes.find(dir => dir.includes(expediente));
  if (yaExiste) {
    return path.join(rutaFecha, yaExiste);
  }

  let maxNum = 0;
  for (const item of existentes) {
    const match = item.match(/^(\d+)[\.\-\s]/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  const siguienteOrden = maxNum + 1;
  const nombreLimpio = normalizarTexto(nombre);
  const nombreCarpeta = `${siguienteOrden}. ${id} ${nombreLimpio} ${expediente}`.trim();
  const rutaCompleta = path.join(rutaFecha, nombreCarpeta);
  await fs.mkdir(rutaCompleta, { recursive: true });
  return rutaCompleta;
}

async function obtenerEstadoExpedientes(forzar = false) {
  const ahora = Date.now();
  if (!forzar && cacheEstado && (ahora - ultimaLecturaCache < TTL_CACHE_MS)) {
    return cacheEstado;
  }

  const nombreExcel = await resolverRutaExcel();
  let registrosDB = obtenerTodosLosExpedientes();

  // Si la base está vacía pero existe el archivo Excel, sincronizar
  if (registrosDB.length === 0 && nombreExcel) {
    await sincronizarExcelConDB();
    registrosDB = obtenerTodosLosExpedientes();
  }

  if (registrosDB.length === 0) {
    return { expedientes: [], archivoCargado: null };
  }

  // Escaneo del sistema de archivos
  const carpetasCreadas = new Set();
  const carpetasConPdfs = new Set();

  try {
    const fechas = await fs.readdir(RUTA_ENTRADA_BASE);
    for (const f of fechas) {
      const rutaF = path.join(RUTA_ENTRADA_BASE, f);
      const st = await fs.stat(rutaF).catch(() => null);
      if (st && st.isDirectory()) {
        const subDirs = await fs.readdir(rutaF);
        for (const sub of subDirs) {
          const m = sub.match(/(20\d{2}-\d{4,8})/);
          if (m) {
            const expEncontrado = m[1];
            carpetasCreadas.add(expEncontrado);

            const rutaSub = path.join(rutaF, sub);
            const stSub = await fs.stat(rutaSub).catch(() => null);
            if (stSub && stSub.isDirectory()) {
              const archivos = await fs.readdir(rutaSub);
              const tienePdfs = archivos.some(a => a.toLowerCase().endsWith('.pdf'));
              if (tienePdfs) carpetasConPdfs.add(expEncontrado);
            }
          }
        }
      }
    }
  } catch (_) {}

  const archivosSalida = new Set();
  try {
    const fechasSalida = await fs.readdir(RUTA_SALIDA_BASE);
    for (const f of fechasSalida) {
      const rutaF = path.join(RUTA_SALIDA_BASE, f);
      const st = await fs.stat(rutaF).catch(() => null);
      if (st && st.isDirectory()) {
        const archivos = await fs.readdir(rutaF);
        for (const a of archivos) {
          const m = a.match(/(20\d{2}-\d{4,8})/);
          if (m) archivosSalida.add(m[1]);
        }
      }
    }
  } catch (_) {}

  const lista = registrosDB.map(reg => {
    const carpetaExiste = carpetasCreadas.has(reg.expediente);
    const tienePdfs = carpetasConPdfs.has(reg.expediente);
    const procesado = archivosSalida.has(reg.expediente);
    const tieneErrorManual = Boolean(reg.tiene_error_manual);

    let estado = 'pendiente';
    if (tieneErrorManual) {
      estado = 'error';
    } else if (procesado) {
      estado = 'procesado';
    } else if (tienePdfs) {
      estado = 'listo_para_procesar';
    }

    return {
      fecha: reg.fecha,
      id: reg.id,
      nombre: reg.nombre,
      expediente: reg.expediente,
      monto: reg.monto,
      estado,
      carpetaExiste,
      tienePdfs,
      observacion: reg.observacion || '',
      tieneErrorManual
    };
  });

  cacheEstado = { expedientes: lista, archivoCargado: nombreExcel ? path.basename(nombreExcel) : null };
  ultimaLecturaCache = Date.now();
  return cacheEstado;
}

module.exports = {
  limpiarCacheEstado,
  sincronizarExcelConDB,
  obtenerODefinirCarpetaDestino,
  obtenerEstadoExpedientes
};
