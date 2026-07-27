// Electron main process — wraps the built Vite app in a desktop window so it
// can ship as a Windows .exe (and mac/linux). In dev it loads the Vite dev
// server; in production it loads the bundled dist/index.html.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#eef1f7',
    title: 'Ali Nawaz Accounting Software',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    // Files are packaged under the app root; dist/ sits next to electron/.
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Open external links (if any) in the system browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
