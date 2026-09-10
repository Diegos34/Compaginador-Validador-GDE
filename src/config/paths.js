const path = require('path');
const fsSync = require('fs');

const PORT = process.env.PORT || 3000;
const RUTA_ENTRADA_BASE = path.resolve(process.env.DIR_ENTRADA || './entrada');
const RUTA_SALIDA_BASE = path.resolve(process.env.DIR_SALIDA || './salida');
const RUTA_BUZON = path.resolve(process.env.DIR_BUZON || './buzon');
const RUTA_TEMP = path.resolve(process.env.DIR_TEMP || './temp');
const ARCHIVO_EXCEL_DEFAULT = path.resolve(process.env.FILE_EXCEL_DEFAULT || './planilla_activa.xlsx');
const ARCHIVO_DB = path.resolve(process.env.DB_PATH || './datos.db');
const CARPETA_PUBLIC = path.join(__dirname, '../../public');

// Inicialización de directorios requeridos
[RUTA_ENTRADA_BASE, RUTA_SALIDA_BASE, RUTA_BUZON, RUTA_TEMP].forEach(dir => {
  try {
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error(`Error inicializando directorio ${dir}:`, err.message);
  }
});

module.exports = {
  PORT,
  RUTA_ENTRADA_BASE,
  RUTA_SALIDA_BASE,
  RUTA_BUZON,
  RUTA_TEMP,
  ARCHIVO_EXCEL_DEFAULT,
  ARCHIVO_DB,
  CARPETA_PUBLIC
};
