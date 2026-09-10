const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const {
  RUTA_ENTRADA_BASE,
  RUTA_SALIDA_BASE,
  RUTA_TEMP,
  RUTA_BUZON,
  ARCHIVO_EXCEL_DEFAULT,
  ARCHIVO_OBSERVACIONES
} = require('../config/paths');
const { abrirEnExplorador } = require('../services/explorerService');
const { guardarObservacion, vaciarExpedientes } = require('../services/dbService');
const {
  obtenerEstadoExpedientes,
  obtenerODefinirCarpetaDestino,
  limpiarCacheEstado
} = require('../services/excelService');
const {
  getExpedienteActivo,
  setExpedienteActivo,
  vaciarBuzonHaciaExpediente
} = require('../services/buzonService');
const {
  agregarCliente,
  removerCliente,
  emitirEvento
} = require('../services/sseService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

let enProceso = false;
let ultimosLogs = '';
let procesoActivoChild = null;

function emitirLog(linea) {
  ultimosLogs += linea;
  emitirEvento('log', { log: linea, enProceso });
}

function notificarCambioEstado() {
  limpiarCacheEstado();
  obtenerEstadoExpedientes(true).then(data => {
    emitirEvento('estado', {
      ...data,
      enProceso,
      expedienteActivoBuzon: getExpedienteActivo()
    });
  }).catch(() => {});
}

// Canal SSE
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  agregarCliente(res);

  obtenerEstadoExpedientes().then(data => {
    res.write(`event: init\ndata: ${JSON.stringify({
      ...data,
      enProceso,
      logs: ultimosLogs,
      expedienteActivoBuzon: getExpedienteActivo()
    })}\n\n`);
  }).catch(() => {});

  req.on('close', () => removerCliente(res));
});

router.get('/expedientes', async (req, res) => {
  try {
    const data = await obtenerEstadoExpedientes(true);
    res.json({
      ...data,
      enProceso,
      logs: ultimosLogs,
      expedienteActivoBuzon: getExpedienteActivo()
    });
  } catch (err) {
    res.status(500).json({ error: err.message, expedientes: [] });
  }
});

router.post('/activar-escucha', (req, res) => {
  try {
    const activo = setExpedienteActivo(req.body);
    if (activo) {
      setTimeout(() => {
        vaciarBuzonHaciaExpediente(emitirLog, notificarCambioEstado);
      }, 200);
    }
    emitirEvento('buzon', { expedienteActivoBuzon: activo });
    res.json({ ok: true, expedienteActivoBuzon: activo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/abrir-carpeta', async (req, res) => {
  try {
    const { fecha, expediente } = req.body;
    let destinoFinal = null;
    const fechaCarpeta = (fecha || '').replace(/[/\\?%*:|"<>]/g, '-');
    const rutaFecha = path.join(RUTA_ENTRADA_BASE, fechaCarpeta);

    try {
      const existentes = await fs.readdir(rutaFecha);
      const sub = existentes.find(dir => dir.includes(expediente));
      if (sub) destinoFinal = path.join(rutaFecha, sub);
    } catch (_) {}

    if (!destinoFinal) {
      try {
        const fechas = await fs.readdir(RUTA_ENTRADA_BASE);
        for (const f of fechas) {
          const rF = path.join(RUTA_ENTRADA_BASE, f);
          const st = await fs.stat(rF).catch(() => null);
          if (st && st.isDirectory()) {
            const subs = await fs.readdir(rF);
            const match = subs.find(d => d.includes(expediente));
            if (match) {
              destinoFinal = path.join(rF, match);
              break;
            }
          }
        }
      } catch (_) {}
    }

    if (!destinoFinal) {
      return res.status(404).json({ error: 'No se encontró la carpeta en el disco' });
    }

    abrirEnExplorador(destinoFinal);
    res.json({ ok: true, ruta: destinoFinal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/abrir-archivo-salida', async (req, res) => {
  try {
    const { expediente } = req.body;
    let rutaPdf = null;

    const fechasSalida = await fs.readdir(RUTA_SALIDA_BASE).catch(() => []);
    for (const f of fechasSalida) {
      const rF = path.join(RUTA_SALIDA_BASE, f);
      const st = await fs.stat(rF).catch(() => null);
      if (st && st.isDirectory()) {
        const archivos = await fs.readdir(rF);
        const match = archivos.find(a => a.includes(expediente) && a.toLowerCase().endsWith('.pdf'));
        if (match) {
          rutaPdf = path.join(rF, match);
          break;
        }
      }
    }

    if (!rutaPdf) {
      return res.status(404).json({ error: 'No se encontró el PDF de salida generado.' });
    }

    abrirEnExplorador(rutaPdf);
    res.json({ ok: true, ruta: rutaPdf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/abrir-carpeta-salida', async (req, res) => {
  try {
    const { fecha, expediente } = req.body;
    let carpetaFinal = null;

    const fechasSalida = await fs.readdir(RUTA_SALIDA_BASE).catch(() => []);
    for (const f of fechasSalida) {
      const rF = path.join(RUTA_SALIDA_BASE, f);
      const st = await fs.stat(rF).catch(() => null);
      if (st && st.isDirectory()) {
        const archivos = await fs.readdir(rF);
        const match = archivos.find(a => a.includes(expediente) && a.toLowerCase().endsWith('.pdf'));
        if (match) {
          carpetaFinal = rF;
          break;
        }
      }
    }

    if (!carpetaFinal && fecha) {
      const fechaLimpia = fecha.replace(/[/\\?%*:|"<>]/g, '-');
      const posibleRuta = path.join(RUTA_SALIDA_BASE, fechaLimpia);
      const stFecha = await fs.stat(posibleRuta).catch(() => null);
      if (stFecha && stFecha.isDirectory()) {
        carpetaFinal = posibleRuta;
      }
    }

    if (!carpetaFinal) {
      carpetaFinal = RUTA_SALIDA_BASE;
    }

    abrirEnExplorador(carpetaFinal);
    res.json({ ok: true, ruta: carpetaFinal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/limpiar-salida-expediente', async (req, res) => {
  try {
    const { expediente } = req.body;
    let borrado = false;

    const fechasSalida = await fs.readdir(RUTA_SALIDA_BASE).catch(() => []);
    for (const f of fechasSalida) {
      const rF = path.join(RUTA_SALIDA_BASE, f);
      const st = await fs.stat(rF).catch(() => null);
      if (st && st.isDirectory()) {
        const archivos = await fs.readdir(rF);
        const match = archivos.find(a => a.includes(expediente) && a.toLowerCase().endsWith('.pdf'));
        if (match) {
          await fs.unlink(path.join(rF, match)).catch(() => {});
          borrado = true;
          break;
        }
      }
    }

    notificarCambioEstado();
    res.json({ ok: true, borrado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/limpiar-carpeta-expediente', async (req, res) => {
  try {
    const { fecha, expediente } = req.body;
    let rutaSub = null;

    const fechaCarpeta = (fecha || '').replace(/[/\\?%*:|"<>]/g, '-');
    const rutaFecha = path.join(RUTA_ENTRADA_BASE, fechaCarpeta);

    try {
      const existentes = await fs.readdir(rutaFecha);
      const sub = existentes.find(dir => dir.includes(expediente));
      if (sub) rutaSub = path.join(rutaFecha, sub);
    } catch (_) {}

    if (!rutaSub) {
      try {
        const fechas = await fs.readdir(RUTA_ENTRADA_BASE);
        for (const f of fechas) {
          const rF = path.join(RUTA_ENTRADA_BASE, f);
          const st = await fs.stat(rF).catch(() => null);
          if (st && st.isDirectory()) {
            const subs = await fs.readdir(rF);
            const match = subs.find(d => d.includes(expediente));
            if (match) {
              rutaSub = path.join(rF, match);
              break;
            }
          }
        }
      } catch (_) {}
    }

    if (!rutaSub) {
      return res.status(404).json({ error: 'No existe la carpeta para este expediente' });
    }

    const archivos = await fs.readdir(rutaSub);
    let accionRealizada = '';

    if (archivos.length > 0) {
      for (const arch of archivos) {
        await fs.unlink(path.join(rutaSub, arch)).catch(() => {});
      }
      accionRealizada = 'vaciada';
    } else {
      await fs.rm(rutaSub, { recursive: true, force: true }).catch(() => {});
      accionRealizada = 'eliminada';
    }

    notificarCambioEstado();
    res.json({ ok: true, accion: accionRealizada });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subir-pdfs-expediente', upload.array('pdfs'), async (req, res) => {
  try {
    const { fecha, id, nombre, expediente } = req.body;
    const archivos = req.files;

    if (!expediente || !archivos || archivos.length === 0) {
      return res.status(400).json({ error: 'Datos incompletos o sin archivos.' });
    }

    const carpetaDestino = await obtenerODefinirCarpetaDestino(fecha, id, nombre, expediente);
    for (const arch of archivos) {
      await fs.writeFile(path.join(carpetaDestino, arch.originalname), arch.buffer);
    }

    notificarCambioEstado();
    res.json({ ok: true, guardados: archivos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload-excel', upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se encontró archivo' });
    }

    await fs.writeFile(ARCHIVO_EXCEL_DEFAULT, req.file.buffer);
    notificarCambioEstado();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/guardar-observacion', async (req, res) => {
  try {
    const { expediente, observacion, tieneErrorManual } = req.body;
    await guardarObservacion(expediente, observacion, tieneErrorManual);
    notificarCambioEstado();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset-todo', async (req, res) => {
  if (enProceso) {
    return res.status(409).json({ error: 'No se puede resetear mientras hay un lote en ejecución.' });
  }

  try {
    await fs.rm(RUTA_ENTRADA_BASE, { recursive: true, force: true });
    await fs.mkdir(RUTA_ENTRADA_BASE, { recursive: true });

    await fs.rm(RUTA_SALIDA_BASE, { recursive: true, force: true });
    await fs.mkdir(RUTA_SALIDA_BASE, { recursive: true });

    await fs.rm(RUTA_TEMP, { recursive: true, force: true });
    await fs.mkdir(RUTA_TEMP, { recursive: true });

    await fs.rm(RUTA_BUZON, { recursive: true, force: true });
    await fs.mkdir(RUTA_BUZON, { recursive: true });

    await fs.unlink(ARCHIVO_EXCEL_DEFAULT).catch(() => {});
    await fs.unlink(ARCHIVO_OBSERVACIONES).catch(() => {});

    setExpedienteActivo(null);
    ultimosLogs = `[${new Date().toLocaleTimeString()}] Sistema reseteado a cero.\n`;

    notificarCambioEstado();
    emitirEvento('log', { log: ultimosLogs, reset: true });

    res.json({ ok: true, mensaje: 'Sistema reseteado exitosamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/procesar', (req, res) => {
  if (enProceso) {
    return res.status(409).json({ error: 'Ya hay un lote en proceso.' });
  }

  enProceso = true;
  emitirLog(`\n[${new Date().toLocaleTimeString()}] Iniciando lote...\n`);
  emitirEvento('estado_proceso', { enProceso: true });

  procesoActivoChild = spawn('node', ['procesar_lote.js']);

  procesoActivoChild.stdout.on('data', d => {
    emitirLog(d.toString());
    process.stdout.write(d.toString());
  });

  procesoActivoChild.stderr.on('data', d => {
    emitirLog(`[ERROR] ${d.toString()}`);
    process.stderr.write(d.toString());
  });

  procesoActivoChild.on('error', err => {
    enProceso = false;
    procesoActivoChild = null;
    emitirLog(`\n[ERROR FATAL]: ${err.message}\n`);
    emitirEvento('estado_proceso', { enProceso: false });
    notificarCambioEstado();
  });

  procesoActivoChild.on('close', (code, signal) => {
    enProceso = false;
    procesoActivoChild = null;

    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      emitirLog(`\n[CANCELADO]: Lote detenido manualmente por el usuario.\n`);
    } else {
      emitirLog(`\n[${new Date().toLocaleTimeString()}] Lote finalizado (Código: ${code})\n`);
    }

    emitirEvento('estado_proceso', { enProceso: false });
    notificarCambioEstado();
  });

  res.json({ ok: true });
});

router.post('/cancelar-proceso', (req, res) => {
  if (!enProceso || !procesoActivoChild) {
    return res.status(400).json({ error: 'No hay ningún lote en ejecución.' });
  }

  try {
    procesoActivoChild.kill('SIGTERM');
    res.json({ ok: true, mensaje: 'Señal de detención enviada.' });
  } catch (err) {
    res.status(500).json({ error: `Error deteniendo el proceso: ${err.message}` });
  }
});

module.exports = {
  router,
  emitirLog,
  notificarCambioEstado
};
