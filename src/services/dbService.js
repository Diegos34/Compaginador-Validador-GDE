const db = require('../config/db');

// Inserción o actualización atómica (UPSERT) al cargar Excel
const stmtUpsert = db.prepare(`
  INSERT INTO expedientes (expediente, id, nombre, fecha, monto)
  VALUES (@expediente, @id, @nombre, @fecha, @monto)
  ON CONFLICT(expediente) DO UPDATE SET
    id = excluded.id,
    nombre = excluded.nombre,
    fecha = excluded.fecha,
    monto = excluded.monto,
    actualizado_en = CURRENT_TIMESTAMP
`);

const insertarOActualizarLote = db.transaction((filas) => {
  for (const fila of filas) {
    stmtUpsert.run(fila);
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

// Obtener todos los expedientes ordenados por fecha e ID
const stmtObtenerTodos = db.prepare(`
  SELECT expediente, id, nombre, fecha, monto, observacion, tiene_error_manual
  FROM expedientes
`);

function obtenerTodosLosExpedientes() {
  return stmtObtenerTodos.all();
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
  vaciarExpedientes
};
