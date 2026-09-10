const path = require('path');
const { exec } = require('child_process');

function abrirEnExplorador(rutaAbsoluta) {
  const rutaNormalizada = path.resolve(rutaAbsoluta);
  const plataforma = process.platform;

  if (plataforma === 'win32') {
    const winPath = rutaNormalizada.replace(/\//g, '\\');
    exec(`explorer.exe "${winPath}"`);
    return;
  }

  if (plataforma === 'darwin') {
    exec(`open "${rutaNormalizada}"`);
    return;
  }

  // Entorno WSL / Linux
  exec(`wslpath -w "${rutaNormalizada.replace(/"/g, '\\"')}"`, (err, stdout) => {
    if (err || !stdout.trim()) {
      exec(`xdg-open "${rutaNormalizada}"`);
      return;
    }

    const rutaWin = stdout.trim().replace(/\r?\n/g, '');
    const scriptPs = `Start-Process -FilePath '${rutaWin.replace(/'/g, "''")}'`;
    const encodedCommand = Buffer.from(scriptPs, 'utf16le').toString('base64');

    exec(`powershell.exe -NoProfile -EncodedCommand ${encodedCommand}`, (errPs) => {
      if (errPs) {
        exec(`explorer.exe "${rutaWin.replace(/\\/g, '\\\\')}"`);
      }
    });
  });
}

module.exports = { abrirEnExplorador };
