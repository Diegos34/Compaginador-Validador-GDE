let expedientesGlobales = [];
let expedientesFiltrados = [];
let filtroTabActual = 'pendientes';
let paginaActual = 1;
let filasPorPagina = 25;
let columnaOrden = 'id';
let ordenAsc = true;
let botEnEjecucion = false;

// Formateador de fecha a DD-MM-YYYY
function formatearFecha(valor) {
  if (!valor) return '-';
  const d = new Date(valor);
  if (!isNaN(d.getTime())) {
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const anio = d.getFullYear();
    return `${dia}-${mes}-${anio}`;
  }
  return valor;
}

// Iniciar conexión de Server-Sent Events (SSE)
function inicializarEventosSSE() {
  const banner = document.getElementById('bannerConexion');
  const evtSource = new EventSource('/api/eventos');

  evtSource.onopen = () => {
    if (banner) banner.style.display = 'none';
  };

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.tipo === 'log') {
        agregarLogTerminal(data.texto);
      } else if (data.tipo === 'actualizar') {
        cargarExpedientes();
      } else if (data.tipo === 'bot_terminado') {
        setBotEstado(false);
      }
    } catch (_) {}
  };

  evtSource.onerror = () => {
    if (banner) banner.style.display = 'inline-flex';
  };
}

function agregarLogTerminal(texto) {
  const terminal = document.getElementById('terminalLogs');
  if (!terminal) return;

  if (terminal.textContent === 'Esperando órdenes...') {
    terminal.textContent = '';
  }

  const linea = document.createElement('div');
  linea.className = 'linea-log';

  if (texto.includes('❌') || texto.includes('Error') || texto.includes('🛑')) {
    linea.className += ' log-error';
  } else if (texto.includes('✔') || texto.includes('✅') || texto.includes('🎉')) {
    linea.className += ' log-success';
  } else if (texto.includes('⚠️') || texto.includes('•') || texto.includes('⏹')) {
    linea.className += ' log-warn';
  }

  linea.textContent = texto;
  terminal.appendChild(linea);
  terminal.scrollTop = terminal.scrollHeight;
}

function abrirTerminalModal() {
  const overlay = document.getElementById('terminalOverlay');
  const wrapper = document.getElementById('terminalWrapper');
  if (!overlay || !wrapper) return;

  overlay.classList.add('activo', 'modo-modal');
  wrapper.classList.remove('modo-docked');
  wrapper.classList.add('modo-modal');
  document.body.classList.remove('terminal-docked');
}

function cerrarTerminal() {
  const overlay = document.getElementById('terminalOverlay');
  const wrapper = document.getElementById('terminalWrapper');
  if (overlay) overlay.classList.remove('activo', 'modo-modal');
  if (wrapper) wrapper.classList.remove('modo-modal', 'modo-docked');
  document.body.classList.remove('terminal-docked');
}

function cerrarTerminalPorFondo(event) {
  if (event.target.id === 'terminalOverlay') {
    cerrarTerminal();
  }
}

function toggleDockTerminal() {
  const overlay = document.getElementById('terminalOverlay');
  const wrapper = document.getElementById('terminalWrapper');
  const btnDock = document.getElementById('btnDockTerminal');

  if (wrapper.classList.contains('modo-modal')) {
    overlay.classList.remove('activo', 'modo-modal');
    wrapper.classList.remove('modo-modal');
    wrapper.classList.add('modo-docked');
    document.body.classList.add('terminal-docked');
    if (btnDock) btnDock.textContent = '⬆ Centrar Consola';
    document.body.appendChild(wrapper);
  } else {
    wrapper.classList.remove('modo-docked');
    document.body.classList.remove('terminal-docked');
    overlay.appendChild(wrapper);
    overlay.classList.add('activo', 'modo-modal');
    wrapper.classList.add('modo-modal');
    if (btnDock) btnDock.textContent = '⬇ Anclar Abajo';
  }
}

// Cargar registros desde la API
async function cargarExpedientes() {
  try {
    const res = await fetch('/api/expedientes');
    expedientesGlobales = await res.json();
    actualizarMetricas();
    aplicarFiltrosYOrden();
  } catch (err) {
    console.error('Error al obtener expedientes:', err);
  }
}

function actualizarMetricas() {
  const total = expedientesGlobales.length;
  const completados = expedientesGlobales.filter(e => e.estado === 'Completado').length;
  const listos = expedientesGlobales.filter(e => e.estado === 'Listo (Con PDFs)').length;
  const problemas = expedientesGlobales.filter(e => e.tiene_error_manual || e.estado === 'Con Problema').length;
  const pendientes = expedientesGlobales.filter(e => e.estado === 'Pendiente').length;

  document.getElementById('totalCount').textContent = total;
  document.getElementById('procesadosCount').textContent = completados;
  document.getElementById('listosCount').textContent = listos;
  document.getElementById('errorCount').textContent = problemas;
  document.getElementById('pendientesCount').textContent = pendientes;

  document.getElementById('badgeTabPendientes').textContent = pendientes + listos;
  document.getElementById('badgeTabErrores').textContent = problemas;
  document.getElementById('badgeTabCompletados').textContent = completados;
  document.getElementById('badgeTabTodos').textContent = total;
}

function cambiarTab(tab) {
  filtroTabActual = tab;
  paginaActual = 1;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  });
  aplicarFiltrosYOrden();
}

function filtrarPorTexto() {
  paginaActual = 1;
  aplicarFiltrosYOrden();
}

function limpiarBuscador() {
  const input = document.getElementById('inputBuscador');
  input.value = '';
  document.getElementById('btnLimpiarBusqueda').style.display = 'none';
  aplicarFiltrosYOrden();
}

function manejarTeclasBuscador(event) {
  if (event.key === 'Escape') {
    limpiarBuscador();
  }
}

function ordenarPor(columna) {
  if (columnaOrden === columna) {
    ordenAsc = !ordenAsc;
  } else {
    columnaOrden = columna;
    ordenAsc = true;
  }
  aplicarFiltrosYOrden();
}

function aplicarFiltrosYOrden() {
  const input = document.getElementById('inputBuscador');
  const busqueda = (input ? input.value : '').toLowerCase().trim();
  const btnLimpiar = document.getElementById('btnLimpiarBusqueda');
  if (btnLimpiar) btnLimpiar.style.display = busqueda ? 'block' : 'none';

  expedientesFiltrados = expedientesGlobales.filter(exp => {
    if (filtroTabActual === 'pendientes' && (exp.estado === 'Completado' || exp.tiene_error_manual)) return false;
    if (filtroTabActual === 'errores' && !exp.tiene_error_manual && exp.estado !== 'Con Problema') return false;
    if (filtroTabActual === 'completados' && exp.estado !== 'Completado') return false;

    if (busqueda) {
      const match = (exp.id && String(exp.id).toLowerCase().includes(busqueda)) ||
                    (exp.nombre && exp.nombre.toLowerCase().includes(busqueda)) ||
                    (exp.expediente && exp.expediente.toLowerCase().includes(busqueda));
      if (!match) return false;
    }

    return true;
  });

  expedientesFiltrados.sort((a, b) => {
    let valA = a[columnaOrden] ?? '';
    let valB = b[columnaOrden] ?? '';

    if (columnaOrden === 'id' || columnaOrden === 'monto') {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
    }

    if (valA < valB) return ordenAsc ? -1 : 1;
    if (valA > valB) return ordenAsc ? 1 : -1;
    return 0;
  });

  renderizarTabla();
}

function renderizarTabla() {
  const tbody = document.getElementById('tablaBody');
  tbody.innerHTML = '';

  const total = expedientesFiltrados.length;
  const totalPaginas = Math.ceil(total / filasPorPagina) || 1;

  if (paginaActual > totalPaginas) paginaActual = totalPaginas;

  const inicio = (paginaActual - 1) * filasPorPagina;
  const fin = Math.min(inicio + filasPorPagina, total);
  const paginaItems = expedientesFiltrados.slice(inicio, fin);

  paginaItems.forEach(exp => {
    const tr = document.createElement('tr');
    let claseFila = 'pendiente';
    let claseBadge = 'badge-pendiente';

    if (exp.estado === 'Completado') {
      claseFila = 'procesado';
      claseBadge = 'badge-procesado';
    } else if (exp.estado === 'Listo (Con PDFs)') {
      claseFila = 'listo_para_procesar';
      claseBadge = 'badge-listo';
    } else if (exp.tiene_error_manual || exp.estado === 'Con Problema') {
      claseFila = 'error';
      claseBadge = 'badge-error';
    }

    tr.className = claseFila;
    const montoFormateado = exp.monto ? `$${Number(exp.monto).toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-';

    tr.innerHTML = `
      <td>${formatearFecha(exp.fecha)}</td>
      <td><strong>${exp.id || '-'}</strong></td>
      <td>${exp.nombre || '-'}</td>
      <td>
        <span class="exp-pill" onclick="abrirPopoverGde(event, '${exp.expediente}')">${exp.expediente}</span>
      </td>
      <td>${montoFormateado}</td>
      <td><span class="badge ${claseBadge}">${exp.estado}</span></td>
      <td>
        <div class="acciones-btn-group">
          <button class="btn-action-pill btn-action-buzon" title="Vincular Buzón">
            <svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
            <span class="txt">Buzón</span>
          </button>
          <button class="btn-action-pill btn-action-folder" title="Abrir Carpeta Entrada">
            <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span class="txt">Carpeta</span>
          </button>
        </div>
      </td>
      <td style="text-align: center;">
        <input type="checkbox" class="checkbox-error" ${exp.tiene_error_manual ? 'checked' : ''} onchange="cambiarErrorManual('${exp.expediente}', this.checked)">
      </td>
      <td>
        <input type="text" class="input-obs" value="${exp.observacion || ''}" placeholder="Anotar observación..." onblur="actualizarObservacion('${exp.expediente}', this.value)">
      </td>
    `;

    tbody.appendChild(tr);
  });

  document.getElementById('paginationInfo').textContent = `Mostrando ${total === 0 ? 0 : inicio + 1}-${fin} de ${total}`;
  document.getElementById('paginationCurrent').textContent = `Pág. ${paginaActual} de ${totalPaginas}`;
  document.getElementById('btnPrevPage').disabled = paginaActual <= 1;
  document.getElementById('btnNextPage').disabled = paginaActual >= totalPaginas;
}

function cambiarFilasPorPagina(val) {
  filasPorPagina = parseInt(val, 10);
  paginaActual = 1;
  aplicarFiltrosYOrden();
}

function cambiarPagina(delta) {
  paginaActual += delta;
  renderizarTabla();
}

// Control visual del estado de ejecución del Bot
function setBotEstado(activo) {
  botEnEjecucion = activo;
  const btn = document.getElementById('btnIniciarBot');
  const btnTermCancelar = document.getElementById('btnTermCancelar');
  const txtSpan = btn ? btn.querySelector('.btn-txt') : null;

  if (activo) {
    if (btn) {
      btn.classList.remove('btn-bot', 'btn-primary');
      btn.classList.add('btn-detener');
    }
    if (txtSpan) txtSpan.textContent = 'Detener Bot';
    if (btnTermCancelar) {
      btnTermCancelar.style.display = 'inline-flex';
      btnTermCancelar.textContent = '⏹ Detener Bot';
    }
  } else {
    if (btn) {
      btn.classList.remove('btn-detener');
      btn.classList.add('btn-bot');
    }
    if (txtSpan) txtSpan.textContent = 'Descargar de GDE (Bot)';
    if (btnTermCancelar) {
      btnTermCancelar.style.display = 'none';
    }
  }
}

// Iniciar o Detener Scraper según el estado
async function toggleScraperGDE() {
  if (botEnEjecucion) {
    await detenerScraperGDE();
  } else {
    await iniciarScraperGDE();
  }
}

async function iniciarScraperGDE() {
  try {
    setBotEstado(true);
    const res = await fetch('/api/iniciar-scraper', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.mensaje || 'Error al iniciar bot');
    abrirTerminalModal();
  } catch (err) {
    setBotEstado(false);
    alert('Error al iniciar el scraper: ' + err.message);
  }
}

async function detenerScraperGDE() {
  try {
    const res = await fetch('/api/detener-scraper', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      setBotEstado(false);
    }
  } catch (err) {
    alert('Error al solicitar detención: ' + err.message);
  }
}

// Enlazar la acción de cancelar en la barra superior de la terminal
function cancelarProcesoDesdeTerminal() {
  detenerScraperGDE();
}

async function cambiarErrorManual(expediente, valor) {
  await fetch('/api/guardar-observacion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expediente, tiene_error_manual: valor })
  });
}

async function actualizarObservacion(expediente, valor) {
  await fetch('/api/guardar-observacion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expediente, observacion: valor })
  });
}

async function subirExcel() {
  const input = document.getElementById('inputExcel');
  const archivo = input.files[0];
  if (!archivo) return;

  const formData = new FormData();
  formData.append('archivo', archivo);

  try {
    const res = await fetch('/api/subir-excel', { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('archivoCargadoTxt').textContent = `Archivo: ${archivo.name}`;
      cargarExpedientes();
    } else {
      alert('Error al procesar el Excel: ' + data.error);
    }
  } catch (err) {
    alert('Error en la comunicación con el servidor: ' + err.message);
  }
}

async function resetearTodo() {
  if (confirm('¿Estás seguro de que deseas vaciar y resetear todos los datos de la base?')) {
    await fetch('/api/resetear', { method: 'POST' });
  }
}

function abrirPopoverGde(event, exp) {
  const popover = document.getElementById('popoverGde');
  const rect = event.target.getBoundingClientRect();
  const expLimpio = exp.replace(/^EX-/, '').replace(/-\s*-TRHONDO.*$/, '');

  const txtMee = `EX-${expLimpio}- -TRHONDO-MEE#SEH`;
  const txtMeg = `EX-${expLimpio}- -TRHONDO-MEG#INT`;

  const btnMee = document.getElementById('btnGdeMee');
  const btnMeg = document.getElementById('btnGdeMeg');

  btnMee.querySelector('.txt').textContent = txtMee;
  btnMee.setAttribute('data-copy', txtMee);

  btnMeg.querySelector('.txt').textContent = txtMeg;
  btnMeg.setAttribute('data-copy', txtMeg);

  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popover.style.left = `${rect.left + window.scrollX}px`;
  popover.style.display = 'block';
}

function cerrarPopover() {
  document.getElementById('popoverGde').style.display = 'none';
}

function copiarTextoGde(btn) {
  const texto = btn.getAttribute('data-copy');
  navigator.clipboard.writeText(texto).then(() => {
    cerrarPopover();
    const toast = document.getElementById('toastCopiado');
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 2000);
  });
}

// Atajo de teclado: presionar '/' para enfocar el buscador
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    const input = document.getElementById('inputBuscador');
    if (input) input.focus();
  }
});

window.addEventListener('DOMContentLoaded', () => {
  inicializarEventosSSE();
  cargarExpedientes();
});
