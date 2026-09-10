const Database = require('better-sqlite3');
const path = require('path');

const RUTA_DB = path.resolve(process.env.DB_PATH || './datos.db');
const db = new Database(RUTA_DB);

// Modo WAL y claves foráneas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Inicialización de la tabla
db.exec(`
  CREATE TABLE IF NOT EXISTS expedientes (
    expediente TEXT PRIMARY KEY,
    id TEXT,
    nombre TEXT,
    fecha TEXT,
    monto REAL DEFAULT 0,
    observacion TEXT DEFAULT '',
    tiene_error_manual INTEGER DEFAULT 0,
    actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_expedientes_fecha ON expedientes(fecha);
  CREATE INDEX IF NOT EXISTS idx_expedientes_id ON expedientes(id);
`);

module.exports = db;
