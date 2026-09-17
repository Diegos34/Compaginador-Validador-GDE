const db = require('../config/db');

// Inserción o actualización atómica (UPSERT) al cargar Excel
const stmtUpsert = db.prepare(`
  INSERT INTO expedientes (expediente, id, nombre, fecha, monto, estado)
  VALUES (@expediente, @id, @nombre, @fecha, @monto, COALESCE(@estado, 'PENDIENTE'))
  ON CONFLICT(expediente) DO UPDATE SET
    id = excluded.id,
    nombre = excluded.nombre,
    fecha = excluded.fecha,
    monto = excluded.monto,
    actualizado_en = CURRENT_TIMESTAMP
`);

const insertarOActualizarLote = db.transaction((filas) => {
  for (const fila of filas) {
    // Normalizar fila asegurando la existencia de todas las claves nombradas (@estado, @nombre, etc.)
    stmtUpsert.run({
      expediente: fila.expediente,
      id: fila.id,
      nombre: fila.nombre || fila.beneficiario || '',
      fecha: fila.fecha || fila.fecha_orden || null,
      monto: fila.monto || 0,
      estado: fila.estado || 'PENDIENTE'
    });
  }
});

// Guardar observación o marca de error
const stmtGuardarObs = db.prepare(`
  INSERT INTO expedientes (expediente, observacion, tiene_error_manual)
  VALUES (?, ?, ?)
  ON CONFLICT(expediente) DO UPDATE SET
    observacion = excluded.observacion,
    tiene_error_manual = excluded.tiene_error_manual,
    actualizado_en = CURRENT_TIMESTAMP
`);

function guardarObservacion(expediente, observacion, tieneErrorManual) {
  stmtGuardarObs.run(expediente, observacion || '', tieneErrorManual ? 1 : 0);
}

// En dbService.js: ordenar por rowid o dejar el orden original del archivo
const stmtObtenerTodos = db.prepare(`
  SELECT expediente, id, nombre, fecha, monto, observacion, tiene_error_manual, estado, fecha_procesado
  FROM expedientes
  ORDER BY rowid ASC
`);

function obtenerTodosLosExpedientes() {
  return stmtObtenerTodos.all();
}

// Cola de trabajo activo (excluye completados y errores manuales)
const stmtObtenerTrabajoActivo = db.prepare(`
  SELECT expediente, id, nombre, fecha, monto, observacion, tiene_error_manual, estado
  FROM expedientes
  WHERE tiene_error_manual = 0
    AND (estado IS NULL OR estado NOT IN ('COMPLETADO'))
  ORDER BY CAST(id AS INTEGER) ASC
`);

function obtenerTrabajoActivo() {
  return stmtObtenerTrabajoActivo.all();
}

// Actualizar estado del expediente
const stmtActualizarEstado = db.prepare(`
  UPDATE expedientes
  SET estado = ?,
      fecha_procesado = CASE WHEN ? = 'COMPLETADO' THEN CURRENT_TIMESTAMP ELSE fecha_procesado END,
      actualizado_en = CURRENT_TIMESTAMP
  WHERE expediente = ?
`);

function actualizarEstado(expediente, nuevoEstado) {
  stmtActualizarEstado.run(nuevoEstado, nuevoEstado, expediente);
}

// Devolver expediente al trabajo activo
const stmtRevertirAActivo = db.prepare(`
  UPDATE expedientes
  SET estado = 'PENDIENTE',
      fecha_procesado = NULL,
      tiene_error_manual = 0,
      actualizado_en = CURRENT_TIMESTAMP
  WHERE expediente = ?
`);

function revertirAActivo(expediente) {
  stmtRevertirAActivo.run(expediente);
}

// Vaciar tabla completa (Reset)
function vaciarExpedientes() {
  db.prepare('DELETE FROM expedientes').run();
  db.pragma('vacuum');
}

module.exports = {
  insertarOActualizarLote,
  guardarObservacion,
  obtenerTodosLosExpedientes,
  obtenerTrabajoActivo,
  actualizarEstado,
  revertirAActivo,
  vaciarExpedientes
};
