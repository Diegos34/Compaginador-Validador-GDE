let procesoActivo = false;
let modoTerminal = 'cerrada';
let ultimoJsonExpedientes = '';
let textoBusqueda = '';
let timerReintentoSSE = null;

let tabActual = 'pendientes';
let paginaActual = 1;
let filasPorPagina = 25;
let todosLosItems = [];
let expedienteEnEscucha = null;

let columnaOrden = null;
let ordenAscendente = true;

// Parser universal a entero matemático YYYYMMDD
function fechaANumeroComparable(fStr) {
  if (!fStr) return 0;
  const limpia = String(fStr).replace(/[\r\n\t]/g, ' ').trim();
  const match = limpia.match(/(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})/);
  if (!match) return 0;

  let d, m, y;
  if (match[1].length === 4) {
    y = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    d = parseInt(match[3], 10);
  } else {
    d = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    y = parseInt(match[3], 10);
    if (y < 100) y = 2000 + y;
  }

  if (isNaN(y) || isNaN(m) || isNaN(d)) return 0;
  return (y * 10000) + (m * 100) + d;
}

function ordenarPor(columna) {
  if (columnaOrden === columna) {
    ordenAscendente = !ordenAscendente;
  } else {
    columnaOrden = columna;
    ordenAscendente = true;
  }
  paginaActual = 1;
  actualizarIndicadoresOrden();
  renderTabla(todosLosItems);
}

function actualizarIndicadoresOrden() {
  ['fecha', 'id', 'nombre', 'expediente', 'monto'].forEach(col => {
    const span = document.getElementById(`sort-${col}`);
    const th = span?.parentElement;
    if (!span || !th) return;

    if (columnaOrden === col) {
      th.classList.add('sort-active');
      span.textContent = ordenAscendente ? '▲' : '▼';
    } else {
      th.classList.remove('sort-active');
      span.textContent = '↕';
    }
  });
}

function cambiarTab(nuevoTab) {
  tabActual = nuevoTab;
  paginaActual = 1;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === nuevoTab);
  });
  renderTabla(todosLosItems);
}

function cambiarFilasPorPagina(val) {
  filasPorPagina = parseInt(val, 10);
  paginaActual = 1;
  renderTabla(todosLosItems);
}

function cambiarPagina(delta) {
  paginaActual += delta;
  renderTabla(todosLosItems);
}

function abrirTerminalModal() {
  const overlay = document.getElementById('terminalOverlay');
  const wrapper = document.getElementById('terminalWrapper');
  const btnDock = document.getElementById('btnDockTerminal');

  if (wrapper.parentElement !== overlay) overlay.appendChild(wrapper);
  document.body.classList.remove('terminal-docked');

  overlay.className = 'terminal-overlay activo modo-modal';
  wrapper.className = 'terminal-wrapper modo-modal';
  btnDock.textContent = '⬇ Anclar Abajo';
  modoTerminal = 'modal';

  hacerScrollAlFondoTerminal();
}

function toggleDockTerminal() {
  const overlay = document.getElementById('terminalOverlay');
  const wrapper = document.getElementById('terminalWrapper');
  const tablaContenedor = document.getElementById('contenedorTabla');
  const btnDock = document.getElementById('btnDockTerminal');

  if (modoTerminal === 'modal') {
    overlay.className = 'terminal-overlay';
    tablaContenedor.insertAdjacentElement('afterend', wrapper);
    wrapper.className = 'terminal-wrapper modo-docked';
    document.body.classList.add('terminal-docked');

    btnDock.textContent = '⛶ Al Centro';
    modoTerminal = 'docked';
    setTimeout(() => { wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
  } else {
    abrirTerminalModal();
  }
  hacerScrollAlFondoTerminal();
}

function cerrarTerminal() {
  const overlay = document.getElementById('terminalOverlay');
  const wrapper = document.getElementById('terminalWrapper');
  if (wrapper.parentElement !== overlay) overlay.appendChild(wrapper);
  document.body.classList.remove('terminal-docked');
  overlay.className = 'terminal-overlay';
  wrapper.className = 'terminal-wrapper';
  modoTerminal = 'cerrada';
}

function cerrarTerminalPorFondo(e) {
  if (modoTerminal === 'modal' && e.target.id === 'terminalOverlay') cerrarTerminal();
}

function hacerScrollAlFondoTerminal() {
  const term = document.getElementById('terminalLogs');
  setTimeout(() => { term.scrollTop = term.scrollHeight; }, 50);
}

function formatearLogsConColores(rawLogs) {
  if (!rawLogs) return '';
  return rawLogs
    .split('\n')
    .map(linea => {
      const segura = linea
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      if (/\[ERROR|ALERTA|DISCREPANCIA|CANCELADO|FALLO\]/i.test(segura)) {
        return `<span class="log-error">${segura}</span>`;
      }
      if (/\[OK|ÉXITO|EXITOSAMENTE|COMPLETADO|BUZÓN AUTO\]/i.test(segura)) {
        return `<span class="log-success">${segura}</span>`;
      }
      if (/\[ATENCIÓN|REVISIÓN|ADVERTENCIA|SALTADO\]/i.test(segura)) {
        return `<span class="log-warn">${segura}</span>`;
      }
      if (/^(===|---|=== EXPEDIENTE|EXPEDIENTE:)/.test(segura.trim())) {
        return `<span class="log-header">${segura}</span>`;
      }
      return segura;
    })
    .join('\n');
}

function actualizarUIProceso(enProc) {
  procesoActivo = enProc;
  const btn = document.getElementById('btnProcesar');
  const btnTermCancelar = document.getElementById('btnTermCancelar');

  // Mostrar u ocultar el botón de cancelación en la terminal según corresponda
  if (btnTermCancelar) {
    btnTermCancelar.style.display = enProc ? 'inline-flex' : 'none';
  }

  if (!btn) return;

  const txtBtn = btn.querySelector('.btn-txt');
  const svg = btn.querySelector('.btn-icon');

  if (enProc) {
    btn.disabled = false;
    btn.classList.add('btn-detener');
    btn.title = 'Detener ejecución actual';
    if (txtBtn) txtBtn.textContent = 'Detener Lote';
    if (svg) {
      svg.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1.5" />';
    }
  } else {
    btn.disabled = false;
    btn.classList.remove('btn-detener');
    btn.title = 'Procesar Documentos';
    if (txtBtn) txtBtn.textContent = 'Procesar Documentos';
    if (svg) {
      svg.innerHTML = '<path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />';
    }
  }
}

function actualizarUIBuzon(expediente) {
  expedienteEnEscucha = expediente || null;
  const buzonTxt = document.getElementById('buzonTxt');
  const buzonPill = document.getElementById('buzonStatus');
  if (expedienteEnEscucha) {
    buzonTxt.textContent = `Buzón esperando descargas para: ${expedienteEnEscucha}`;
    buzonPill.classList.add('activo');
  } else {
    buzonTxt.textContent = 'Buzón inactivo (Clic en "Buzón" en una fila)';
    buzonPill.classList.remove('activo');
  }
}

function renderTabla(items) {
  todosLosItems = items;

  let cProcesados = 0, cListos = 0, cError = 0, cPendientes = 0;
  items.forEach(exp => {
    if (exp.estado === 'error') cError++;
    else if (exp.estado === 'procesado') cProcesados++;
    else if (exp.estado === 'listo_para_procesar') cListos++;
    else cPendientes++;
  });

  const totalActivos = cListos + cPendientes;

  document.getElementById('totalCount').innerText = items.length;
  document.getElementById('procesadosCount').innerText = cProcesados;
  document.getElementById('listosCount').innerText = cListos;
  document.getElementById('errorCount').innerText = cError;
  document.getElementById('pendientesCount').innerText = cPendientes;

  document.getElementById('badgeTabPendientes').innerText = totalActivos;
  document.getElementById('badgeTabErrores').innerText = cError;
  document.getElementById('badgeTabCompletados').innerText = cProcesados;
  document.getElementById('badgeTabTodos').innerText = items.length;

 let filtrados = [];
  if (tabActual === 'pendientes') {
    filtrados = items.filter(exp => exp.estado !== 'procesado' && exp.estado !== 'error');
  } else if (tabActual === 'errores') {
    filtrados = items.filter(exp => exp.estado === 'error');
  } else if (tabActual === 'completados') {
    filtrados = items.filter(exp => exp.estado === 'procesado');
  } else {
    filtrados = items;
  }

  // Filtrado reactivo por texto
  if (textoBusqueda.trim() !== '') {
    const q = normalizarTextoParaBusqueda(textoBusqueda);
    filtrados = filtrados.filter(exp => {
      const nom = normalizarTextoParaBusqueda(exp.nombre || '');
      const id = String(exp.id || '').toLowerCase();
      const numExp = normalizarTextoParaBusqueda(exp.expediente || '');
      const fec = normalizarTextoParaBusqueda(exp.fecha || '');
      const obs = normalizarTextoParaBusqueda(exp.observacion || '');

      return nom.includes(q) || id.includes(q) || numExp.includes(q) || fec.includes(q) || obs.includes(q);
    });
  }

  // Ordenamiento Determinista
  if (columnaOrden) {
    filtrados.sort((a, b) => {
      let resultado = 0;

      if (columnaOrden === 'fecha') {
        const numA = fechaANumeroComparable(a.fecha);
        const numB = fechaANumeroComparable(b.fecha);
        resultado = numA - numB;
      } else if (columnaOrden === 'id' || columnaOrden === 'monto') {
        const valA = parseFloat(a[columnaOrden]) || 0;
        const valB = parseFloat(b[columnaOrden]) || 0;
        resultado = valA - valB;
      } else {
        const strA = (a[columnaOrden] || '').toString();
        const strB = (b[columnaOrden] || '').toString();
        resultado = strA.localeCompare(strB, 'es', { sensitivity: 'base', numeric: true });
      }

      if (resultado === 0) {
        resultado = (a.expediente || '').localeCompare(b.expediente || '');
      }

      return ordenAscendente ? resultado : -resultado;
    });
  }

  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / filasPorPagina));
  if (paginaActual > totalPaginas) paginaActual = totalPaginas;
  if (paginaActual < 1) paginaActual = 1;

  const inicio = (paginaActual - 1) * filasPorPagina;
  const fin = Math.min(inicio + filasPorPagina, filtrados.length);
  const itemsPagina = filtrados.slice(inicio, fin);

  document.getElementById('btnPrevPage').disabled = paginaActual === 1;
  document.getElementById('btnNextPage').disabled = paginaActual === totalPaginas || filtrados.length === 0;
  document.getElementById('paginationCurrent').innerText = `Pág. ${paginaActual} de ${totalPaginas}`;
  document.getElementById('paginationInfo').innerText = filtrados.length > 0
    ? `Mostrando ${inicio + 1}-${fin} de ${filtrados.length}`
    : 'Sin registros';

 if (document.activeElement && document.activeElement.classList.contains('input-obs')) return;

  const tbody = document.getElementById('tablaBody');
  tbody.innerHTML = '';

  itemsPagina.forEach(exp => {
    const tr = document.createElement('tr');
    tr.className = exp.estado;

    if (exp.expediente === expedienteEnEscucha) {
      tr.classList.add('fila-escuchando');
    }

    configurarDragAndDropFila(tr, exp);

    let badgeHtml = '';
    if (exp.estado === 'error') badgeHtml = '<span class="badge badge-error">Con Error</span>';
    else if (exp.estado === 'procesado') badgeHtml = '<span class="badge badge-procesado">Completado</span>';
    else if (exp.estado === 'listo_para_procesar') badgeHtml = '<span class="badge badge-listo">Listo (Con PDFs)</span>';
    else badgeHtml = '<span class="badge badge-pendiente">Pendiente</span>';

    const esProcesado = exp.estado === 'procesado';
    const estaListo = exp.estado === 'listo_para_procesar';
    const puedeAbrirEntrada = Boolean(exp.carpetaExiste || estaListo);
    const tieneArchivosEntrada = Boolean(exp.tienePdfs || estaListo);
    const puedeBorrar = puedeAbrirEntrada;

    let grupoAcciones = '';

    if (esProcesado) {
      grupoAcciones = `
        <div class="acciones-btn-group">
          <button class="btn-action-pill btn-action-view"
            onclick="abrirArchivoSalida('${exp.expediente}')"
            title="Abrir PDF unificado en el visor">
            <svg viewBox="0 0 24 24">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span class="txt">Ver PDF</span>
          </button>

          <button class="btn-action-pill btn-action-folder"
            onclick="abrirCarpetaSalida('${exp.fecha}', '${exp.expediente}')"
            title="Abrir carpeta de salida en el explorador">
            <svg viewBox="0 0 24 24">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="txt">Salida</span>
          </button>

          <button class="btn-action-pill btn-action-clear"
            onclick="reprocesarExpediente('${exp.expediente}')"
            title="Borrar archivo generado para reprocesar">
            <svg viewBox="0 0 24 24">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            <span class="txt">Rehacer</span>
          </button>
        </div>
      `;
    } else {
      const esActivoBuzon = (exp.expediente === expedienteEnEscucha);
      const textoBorrar = tieneArchivosEntrada ? 'Vaciar' : 'Borrar';
      const tooltipBorrar = tieneArchivosEntrada
        ? 'Vaciar los PDFs de este expediente'
        : 'Eliminar la carpeta del expediente';

      grupoAcciones = `
        <div class="acciones-btn-group">
          <button class="btn-action-pill btn-action-buzon ${esActivoBuzon ? 'activo' : ''}"
            onclick="toggleEscuchaBuzon('${exp.fecha}', '${exp.id}', '${encodeURIComponent(exp.nombre)}', '${exp.expediente}')"
            title="${esActivoBuzon ? 'Desactivar escucha' : 'Asignar descargas a este expediente'}">
            <svg viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span class="txt">${esActivoBuzon ? 'Escuchando' : 'Buzón'}</span>
          </button>

          <button class="btn-action-pill btn-action-folder"
            ${!puedeAbrirEntrada ? 'disabled' : ''}
            onclick="abrirCarpetaExpediente('${exp.fecha}', '${exp.expediente}')"
            title="${puedeAbrirEntrada ? 'Abrir carpeta en el explorador' : 'Carpeta no creada'}">
            <svg viewBox="0 0 24 24">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="txt">Abrir</span>
          </button>

          <button class="btn-action-pill btn-action-clear"
            ${!puedeBorrar ? 'disabled' : ''}
            onclick="limpiarCarpetaExpediente('${exp.fecha}', '${exp.expediente}', ${tieneArchivosEntrada})"
            title="${puedeBorrar ? tooltipBorrar : 'No hay carpeta para borrar'}">
            <svg viewBox="0 0 24 24">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            <span class="txt">${textoBorrar}</span>
          </button>
        </div>
      `;
    }

    tr.innerHTML = `
      <td>${exp.fecha}</td>
      <td><strong>${exp.id}</strong></td>
      <td>${exp.nombre}</td>
      <td>
        <div class="exp-pill" onclick="abrirMenuGde(event, '${exp.expediente}')" title="Clic para copiar">
          📄 ${exp.expediente}
        </div>
      </td>
      <td>$${exp.monto ? exp.monto.toLocaleString('es-AR', { minimumFractionDigits: 2 }) : '0,00'}</td>
      <td>${badgeHtml}</td>
      <td>${grupoAcciones}</td>
      <td style="text-align: center;">
        <input type="checkbox" class="checkbox-error"
          ${exp.tieneErrorManual ? 'checked' : ''}
          ${exp.estado === 'procesado' ? 'disabled' : ''}
          onchange="cambiarError('${exp.expediente}', this.checked, '${encodeURIComponent(exp.observacion)}', this)">
      </td>
      <td>
        <input type="text" class="input-obs" value="${exp.observacion.replace(/"/g, '&quot;')}"
          placeholder="Anotar observación o detalle..."
          onblur="guardarNota('${exp.expediente}', this.value, ${exp.tieneErrorManual})">
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function configurarDragAndDropFila(tr, exp) {
  tr.addEventListener('dragover', (e) => {
    e.preventDefault();
    tr.classList.add('drop-target');
  });

  tr.addEventListener('dragleave', () => {
    tr.classList.remove('drop-target');
  });

  tr.addEventListener('drop', async (e) => {
    e.preventDefault();
    tr.classList.remove('drop-target');

    const archivos = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (archivos.length === 0) {
      mostrarToast('⚠️ Arrastrá solo archivos PDF');
      return;
    }

    const formData = new FormData();
    formData.append('fecha', exp.fecha);
    formData.append('id', exp.id);
    formData.append('nombre', exp.nombre);
    formData.append('expediente', exp.expediente);

    archivos.forEach(arch => formData.append('pdfs', arch));

    mostrarToast(`Subiendo ${archivos.length} PDF(s) a ${exp.expediente}...`);
    try {
      const res = await fetch('/api/subir-pdfs-expediente', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        mostrarToast(`✓ ${archivos.length} archivo(s) guardados correctamente`);
      } else {
        alert('Error al subir archivos');
      }
    } catch (err) {
      console.error(err);
      alert('Fallo de conexión al soltar archivos');
    }
  });
}

async function toggleEscuchaBuzon(fecha, id, nombreEncoded, expediente) {
  const nombre = decodeURIComponent(nombreEncoded);

  const nuevoEstado = (expedienteEnEscucha === expediente)
    ? {}
    : { fecha, id, nombre, expediente };

  actualizarUIBuzon(nuevoEstado.expediente || null);
  renderTabla(todosLosItems);

  try {
    await fetch('/api/activar-escucha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nuevoEstado)
    });
    if (nuevoEstado.expediente) {
      mostrarToast(`📥 Asignando descargas a: ${expediente}`);
    } else {
      mostrarToast(`Escucha desactivada`);
    }
  } catch (err) {
    console.error(err);
  }
}

async function abrirCarpetaExpediente(fecha, expediente) {
  try {
    const res = await fetch('/api/abrir-carpeta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fecha, expediente })
    });
    if (res.ok) {
      mostrarToast(`Abriendo carpeta de ${expediente}...`);
    } else {
      mostrarToast(`⚠️ La carpeta no existe`);
    }
  } catch (err) {
    console.error('Error abriendo carpeta:', err);
  }
}

async function abrirArchivoSalida(expediente) {
  try {
    const res = await fetch('/api/abrir-archivo-salida', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expediente })
    });
    if (res.ok) {
      mostrarToast(`Abriendo documento unificado de ${expediente}...`);
    } else {
      mostrarToast(`⚠️ No se encontró el PDF generado`);
    }
  } catch (err) {
    console.error('Error abriendo PDF de salida:', err);
  }
}

async function abrirCarpetaSalida(fecha, expediente) {
  try {
    const res = await fetch('/api/abrir-carpeta-salida', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fecha, expediente })
    });
    if (res.ok) {
      mostrarToast(`Abriendo carpeta de salida...`);
    } else {
      mostrarToast(`⚠️ No se pudo abrir la carpeta de salida`);
    }
  } catch (err) {
    console.error('Error abriendo carpeta de salida:', err);
  }
}

async function reprocesarExpediente(expediente) {
  const confirmar = confirm(
    `¿Querés eliminar el PDF unificado de salida de ${expediente}?\n\n` +
    `El expediente volverá a estado "Listo (Con PDFs)" para que puedas volver a procesarlo.`
  );
  if (!confirmar) return;

  try {
    const res = await fetch('/api/limpiar-salida-expediente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expediente })
    });
    if (res.ok) {
      mostrarToast(`✓ PDF de salida eliminado. Listo para reprocesar.`);
    } else {
      mostrarToast(`⚠️ No se pudo eliminar el PDF de salida`);
    }
  } catch (err) {
    console.error('Error al reprocesar salida:', err);
  }
}

async function limpiarCarpetaExpediente(fecha, expediente, tienePdfs) {
  const mensajeConfirmacion = tienePdfs
    ? `¿Querés vaciar los archivos PDFs de ${expediente}?`
    : `La carpeta está vacía. ¿Querés eliminar la carpeta del expediente ${expediente}?`;

  const confirmar = confirm(mensajeConfirmacion);
  if (!confirmar) return;

  try {
    const res = await fetch('/api/limpiar-carpeta-expediente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fecha, expediente })
    });
    const data = await res.json();
    if (res.ok) {
      if (data.accion === 'vaciada') {
        mostrarToast(`✓ PDFs eliminados. Clic de nuevo para borrar la carpeta.`);
      } else {
        mostrarToast(`✓ Carpeta eliminada por completo.`);
      }
    } else {
      mostrarToast(`⚠️ ${data.error || 'No se pudo realizar la acción'}`);
    }
  } catch (err) {
    console.error('Error al limpiar carpeta:', err);
  }
}

function abrirMenuGde(event, expedienteRaw) {
  event.stopPropagation();
  const popover = document.getElementById('popoverGde');
  const optMee = `EX-${expedienteRaw}- -TRHONDO-MEE#SEH`;
  const optMeg = `EX-${expedienteRaw}- -TRHONDO-MEG#INT`;

  const btnMee = document.getElementById('btnGdeMee');
  const btnMeg = document.getElementById('btnGdeMeg');

  btnMee.querySelector('.txt').textContent = optMee;
  btnMee.dataset.copiar = optMee;

  btnMeg.querySelector('.txt').textContent = optMeg;
  btnMeg.dataset.copiar = optMeg;

  popover.style.display = 'block';
  popover.style.top = `${event.pageY + 10}px`;
  popover.style.left = `${Math.min(event.pageX, window.innerWidth - 350)}px`;
}

function cerrarPopover() {
  document.getElementById('popoverGde').style.display = 'none';
}

document.addEventListener('click', (e) => {
  const pop = document.getElementById('popoverGde');
  if (pop && !pop.contains(e.target)) cerrarPopover();
});

async function copiarTextoGde(btnElement) {
  const texto = btnElement.dataset.copiar;
  if (!texto) return;

  try {
    await navigator.clipboard.writeText(texto);
  } catch (_) {
    const temp = document.createElement('textarea');
    temp.value = texto;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
  }

  cerrarPopover();
  mostrarToast(`Copiado: ${texto}`);
}

function mostrarToast(mensaje) {
  const toast = document.getElementById('toastCopiado');
  toast.textContent = mensaje;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2200);
}

async function subirExcel() {
  const input = document.getElementById('inputExcel');
  if (!input.files || input.files.length === 0) return;

  const formData = new FormData();
  formData.append('excel', input.files[0]);

  await fetch('/api/upload-excel', { method: 'POST', body: formData });
}

async function cambiarError(expediente, tieneError, obsEncoded, inputCheckbox) {
  const observacion = decodeURIComponent(obsEncoded);
  try {
    await fetch('/api/guardar-observacion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expediente, observacion, tieneErrorManual: tieneError })
    });
  } catch (err) {
    console.error('Error al guardar estado de error:', err);
    inputCheckbox.checked = !tieneError;
  }
}

async function guardarNota(expediente, valor, tieneErrorManual) {
  await fetch('/api/guardar-observacion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expediente, observacion: valor, tieneErrorManual })
  });
}

async function cancelarProcesoDesdeTerminal() {
  if (!procesoActivo) return;

  const confirmar = confirm('¿Seguro que querés DETENER el proceso de lotes en ejecución?');
  if (!confirmar) return;

  try {
    const res = await fetch('/api/cancelar-proceso', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo detener el proceso.');
    } else {
      mostrarToast('⚠️ Deteniendo lote...');
    }
  } catch (err) {
    console.error('Error al solicitar detención:', err);
  }
}

async function iniciarProceso() {
  if (procesoActivo) {
    const confirmar = confirm('¿Seguro que querés DETENER el proceso de lotes en ejecución?');
    if (!confirmar) return;

    try {
      const res = await fetch('/api/cancelar-proceso', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'No se pudo detener el proceso.');
      } else {
        mostrarToast('⚠️ Deteniendo lote...');
      }
    } catch (err) {
      console.error('Error al solicitar detención:', err);
    }
    return;
  }

  actualizarUIProceso(true);
  abrirTerminalModal();

  try {
    const res = await fetch('/api/procesar', { method: 'POST' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const term = document.getElementById('terminalLogs');
      term.textContent = `[ERROR DE SERVIDOR]: ${data.error || 'Código HTTP ' + res.status}`;
      actualizarUIProceso(false);
    }
  } catch (err) {
    console.error('Error al iniciar proceso:', err);
    const term = document.getElementById('terminalLogs');
    term.textContent = `[ERROR DE RED]: ${err.message}`;
    actualizarUIProceso(false);
  }
}

async function resetearTodo() {
  const confirmacion = confirm(
    '¿Estás seguro de que querés resetear TODO?\n\n' +
    '• Se borrarán todos los PDFs de entrada, salida y buzón.\n' +
    '• Se eliminará la planilla Excel cargada.\n' +
    '• Se borrarán las observaciones y marcas de error.\n\n' +
    'Esta acción no se puede deshacer.'
  );

  if (!confirmacion) return;

  try {
    const res = await fetch('/api/reset-todo', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      alert(`Error: ${data.error || 'No se pudo resetear'}`);
      return;
    }

    renderTabla([]);
    document.getElementById('terminalLogs').textContent = 'Esperando órdenes...';
    mostrarToast('✓ Sistema reseteado a cero');
  } catch (err) {
    console.error(err);
    alert('Error al contactar con el servidor.');
  }
}

function mostrarBannerReconexion(visible, texto) {
  const banner = document.getElementById('bannerConexion');
  const txt = document.getElementById('bannerConexionTxt');
  if (!banner) return;

  if (visible) {
    if (txt && texto) txt.textContent = texto;
    banner.style.display = 'inline-flex';
  } else {
    banner.style.display = 'none';
  }
}

function conectarSSE() {
  if (timerReintentoSSE) {
    clearTimeout(timerReintentoSSE);
    timerReintentoSSE = null;
  }

  const sse = new EventSource('/api/stream');

  sse.onopen = () => {
    mostrarBannerReconexion(false);
  };

  sse.addEventListener('init', (e) => {
    mostrarBannerReconexion(false);
    const data = JSON.parse(e.data);
    actualizarUIProceso(data.enProceso);
    actualizarUIBuzon(data.expedienteActivoBuzon?.expediente);
    document.getElementById('archivoCargadoTxt').textContent = data.archivoCargado
      ? `Planilla activa: ${data.archivoCargado}`
      : '⚠️ Ningún archivo Excel cargado';

    const term = document.getElementById('terminalLogs');
    if (data.logs) {
      term.innerHTML = formatearLogsConColores(data.logs);
      hacerScrollAlFondoTerminal();
    }

    if (Array.isArray(data.expedientes)) {
      ultimoJsonExpedientes = JSON.stringify(data.expedientes);
      todosLosItems = [...data.expedientes];
      renderTabla(todosLosItems);
    }
  });

  sse.addEventListener('estado', (e) => {
    const data = JSON.parse(e.data);
    actualizarUIProceso(data.enProceso);
    actualizarUIBuzon(data.expedienteActivoBuzon?.expediente);
    document.getElementById('archivoCargadoTxt').textContent = data.archivoCargado
      ? `Planilla activa: ${data.archivoCargado}`
      : '⚠️ Ningún archivo Excel cargado';

    if (Array.isArray(data.expedientes)) {
      const nuevoJson = JSON.stringify(data.expedientes);
      if (nuevoJson !== ultimoJsonExpedientes) {
        ultimoJsonExpedientes = nuevoJson;
        todosLosItems = [...data.expedientes];
        renderTabla(todosLosItems);
      }
    }
  });

  sse.addEventListener('estado_proceso', (e) => {
    const data = JSON.parse(e.data);
    actualizarUIProceso(data.enProceso);
  });

  sse.addEventListener('buzon', (e) => {
    const data = JSON.parse(e.data);
    actualizarUIBuzon(data.expedienteActivoBuzon?.expediente);
    renderTabla(todosLosItems);
  });

  sse.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    const term = document.getElementById('terminalLogs');

    if (data.reset) {
      term.innerHTML = formatearLogsConColores(data.log);
      return;
    }

    const estabaAlFondo = (term.scrollHeight - term.scrollTop - term.clientHeight) < 60;
    term.innerHTML += formatearLogsConColores(data.log);

    if (estabaAlFondo || modoTerminal !== 'cerrada') {
      term.scrollTop = term.scrollHeight;
    }
  });

  sse.onerror = () => {
    mostrarBannerReconexion(true, 'Conexión perdida. Reconectando con el servidor...');
    sse.close();
    timerReintentoSSE = setTimeout(conectarSSE, 2500);
  };
}

conectarSSE();

function normalizarTextoParaBusqueda(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function filtrarPorTexto(val) {
  textoBusqueda = val;
  paginaActual = 1;
  const btnClear = document.getElementById('btnLimpiarBusqueda');
  if (btnClear) {
    btnClear.style.display = val.trim().length > 0 ? 'block' : 'none';
  }
  renderTabla(todosLosItems);
}

function limpiarBuscador() {
  const input = document.getElementById('inputBuscador');
  if (input) {
    input.value = '';
    input.focus();
  }
  filtrarPorTexto('');
}

function manejarTeclasBuscador(e) {
  if (e.key === 'Escape') {
    limpiarBuscador();
  }
}

// Atajo global: presionar "/" o "Ctrl + K" enfoca el buscador
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    const input = document.getElementById('inputBuscador');
    if (input) {
      input.focus();
      input.select();
    }
  }
});
