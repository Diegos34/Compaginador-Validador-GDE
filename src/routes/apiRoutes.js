const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const xlsx = require('xlsx');

const {
  RUTA_ENTRADA_BASE,
  RUTA_SALIDA_BASE,
  ARCHIVO_EXCEL_DEFAULT
} = require('../config/paths');

const dbService = require('../services/dbService');
const { ejecutarDescargaAutomatica, detenerScraper } = require('../services/scraperService');

// Configuración de multer para subida del archivo Excel
const upload = multer({ dest: path.resolve('./temp') });

// Gestión de clientes SSE (Server-Sent Events)
let clientesSSE = [];

function emitirLog(mensaje) {
  console.log(mensaje);
  const data = JSON.stringify({ tipo: 'log', texto: mensaje });
  clientesSSE.forEach(res => res.write(`data: ${data}\n\n`));
}

function notificarCambioEstado(payload = { tipo: 'actualizar' }) {
  const data = JSON.stringify(payload);
  clientesSSE.forEach(res => res.write(`data: ${data}\n\n`));
}

function normalizarFechaExcel(val) {
  if (!val) return null;
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const anio = d.getFullYear();
    return `${dia}-${mes}-${anio}`;
  }
  return String(val).trim();
}

// Endpoint SSE para terminal en vivo
router.get('/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  clientesSSE.push(res);

  req.on('close', () => {
    clientesSSE = clientesSSE.filter(c => c !== res);
  });
});

// Obtener lista completa de expedientes con cálculo de estado en disco
router.get('/expedientes', async (req, res) => {
  try {
    const expedientes = dbService.obtenerTodosLosExpedientes();
    const resultado = [];

    const carpetasSalida = await fs.readdir(RUTA_SALIDA_BASE).catch(() => []);
    const carpetasEntrada = await fs.readdir(RUTA_ENTRADA_BASE).catch(() => []);

    for (const exp of expedientes) {
      let estado = 'Pendiente';

      if (exp.tiene_error_manual) {
        estado = 'Con Problema';
      } else {
        let existeEnSalida = false;
        for (const fDir of carpetasSalida) {
          const rutaF = path.join(RUTA_SALIDA_BASE, fDir);
          const st = await fs.stat(rutaF).catch(() => null);
          if (st && st.isDirectory()) {
            const archivos = await fs.readdir(rutaF);
            if (archivos.some(a => a.toLowerCase().endsWith('.pdf') && (a.startsWith(`${exp.id} `) || a.includes(exp.expediente)))) {
              existeEnSalida = true;
              break;
            }
          }
        }

        if (existeEnSalida) {
          estado = 'Completado';
        } else {
          let existeEnEntrada = false;
          for (const fDir of carpetasEntrada) {
            const rutaF = path.join(RUTA_ENTRADA_BASE, fDir);
            const st = await fs.stat(rutaF).catch(() => null);
            if (st && st.isDirectory()) {
              const subdirs = await fs.readdir(rutaF);
              const coincidente = subdirs.find(s => s.includes(exp.expediente) || s.startsWith(`${exp.id} `));
              if (coincidente) {
                const archivosEntrada = await fs.readdir(path.join(rutaF, coincidente));
                if (archivosEntrada.some(a => a.toLowerCase().endsWith('.pdf'))) {
                  existeEnEntrada = true;
                  break;
                }
              }
            }
          }

          if (existeEnEntrada) {
            estado = 'Listo (Con PDFs)';
          }
        }
      }

      resultado.push({
        ...exp,
        estado
      });
    }

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subir y parsear Excel
router.post('/subir-excel', upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

  try {
    await fs.copyFile(req.file.path, ARCHIVO_EXCEL_DEFAULT);
    await fs.unlink(req.file.path).catch(() => {});

    const wb = xlsx.readFile(ARCHIVO_EXCEL_DEFAULT, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const filas = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const lote = [];
    for (const fila of filas) {
      const id = fila[2] ? String(fila[2]).trim() : '';
      const nombre = fila[3] ? String(fila[3]).trim() : '';
      const expRaw = fila[4] ? String(fila[4]).trim() : '';
      const monto = fila[6] !== undefined && fila[6] !== null ? Number(fila[6]) : null;

      if (expRaw && expRaw.includes('-')) {
        const expLimpio = expRaw.replace(/\s+/g, '');
        lote.push({
          expediente: expLimpio,
          id,
          nombre,
          fecha: normalizarFechaExcel(fila[0]),
          monto
        });
      }
    }

    dbService.insertarOActualizarLote(lote);
    emitirLog(`[EXCEL] Planilla importada exitosamente: ${lote.length} registros cargados.`);
    notificarCambioEstado();
    res.json({ ok: true, cantidad: lote.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guardar observación o flag de error manual
router.post('/guardar-observacion', (req, res) => {
  const { expediente, observacion, tiene_error_manual } = req.body;
  try {
    dbService.guardarObservacion(expediente, observacion, tiene_error_manual);
    notificarCambioEstado();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resetear base de datos completa
router.post('/resetear', (req, res) => {
  try {
    dbService.vaciarExpedientes();
    emitirLog('[RESET] Base de datos vaciada y reiniciada.');
    notificarCambioEstado();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar Scraper / Bot de GDE a demanda
router.post('/iniciar-scraper', (req, res) => {
  res.json({ ok: true, mensaje: 'Descarga de GDE iniciada en segundo plano.' });

  ejecutarDescargaAutomatica(
    (log) => emitirLog(log),
    (evt) => notificarCambioEstado(evt)
  ).catch(err => {
    emitirLog(`[RPA GDE] ❌ Error en el proceso: ${err.message}`);
  });
});

// Detener Scraper / Bot de GDE
router.post('/detener-scraper', (req, res) => {
  const detenido = detenerScraper(emitirLog);
  res.json({ ok: true, detenido });
});

module.exports = {
  router,
  emitirLog,
  notificarCambioEstado
};
