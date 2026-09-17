const Database = require('better-sqlite3');
const path = require('path');

const RUTA_DB = path.resolve(process.env.DB_PATH || './datos.db');
const db = new Database(RUTA_DB);

// Optimización WAL y claves foráneas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Inicialización de la tabla con campos de control de estado
db.exec(`
  CREATE TABLE IF NOT EXISTS expedientes (
    expediente TEXT PRIMARY KEY,
    id TEXT,
    nombre TEXT,
    fecha TEXT,
    monto REAL DEFAULT 0,
    observacion TEXT DEFAULT '',
    tiene_error_manual INTEGER DEFAULT 0,
    estado TEXT DEFAULT 'PENDIENTE',
    fecha_procesado DATETIME DEFAULT NULL,
    actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migraciones automáticas seguras si la tabla ya existía sin estas columnas
try {
  const columnas = db.prepare(`PRAGMA table_info(expedientes)`).all();
  const nombresCol = columnas.map(c => c.name);

  if (!nombresCol.includes('estado')) {
    db.exec(`ALTER TABLE expedientes ADD COLUMN estado TEXT DEFAULT 'PENDIENTE';`);
  }
  if (!nombresCol.includes('fecha_procesado')) {
    db.exec(`ALTER TABLE expedientes ADD COLUMN fecha_procesado DATETIME DEFAULT NULL;`);
  }
} catch (err) {
  console.warn('Nota en migración de columnas:', err.message);
}

// Índices para búsquedas y orden numérico estricto
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_expedientes_fecha ON expedientes(fecha);
  CREATE INDEX IF NOT EXISTS idx_expedientes_estado ON expedientes(estado);
  CREATE INDEX IF NOT EXISTS idx_expedientes_id_num ON expedientes(CAST(id AS INTEGER));
`);

module.exports = db;
