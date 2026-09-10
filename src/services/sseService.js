let clientesSSE = [];

function agregarCliente(res) {
  clientesSSE.push(res);
}

function removerCliente(res) {
  clientesSSE = clientesSSE.filter(c => c !== res);
}

function emitirEvento(tipo, data) {
  const payload = `event: ${tipo}\ndata: ${JSON.stringify(data)}\n\n`;
  clientesSSE.forEach(res => res.write(payload));
}

module.exports = {
  agregarCliente,
  removerCliente,
  emitirEvento
};
