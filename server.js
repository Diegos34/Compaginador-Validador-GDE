const express = require('express');
const { PORT, CARPETA_PUBLIC } = require('./src/config/paths');
const { router, emitirLog, notificarCambioEstado } = require('./src/routes/apiRoutes');
const { inicializarObservadorBuzon } = require('./src/services/buzonService');

const app = express();

app.use(express.json());
app.use(express.static(CARPETA_PUBLIC));

// Enrutador de API
app.use('/api', router);

// Inicializar observador del buzón con callbacks a SSE
inicializarObservadorBuzon(emitirLog, notificarCambioEstado);

process.on('uncaughtException', err => {
  console.error('Excepción global no capturada:', err);
});

app.listen(PORT, () => {
  console.log(`Servidor modular Express activo en: http://localhost:${PORT}`);
});
