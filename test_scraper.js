const { ejecutarDescargaAutomatica } = require('./src/services/scraperService');

console.log('Iniciando prueba del scraper GDE...');
ejecutarDescargaAutomatica(
  msg => console.log(msg),
  () => console.log('[SSE] Estado actualizado')
);
