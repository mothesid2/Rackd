import { BrowserWindow, screen } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(initialPage = 'login'): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 1200,
    minHeight: 700,
    title: 'rackd POS',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../../assets/icon.svg'),
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.loadFile(path.join(__dirname, `../../../src/renderer/${initialPage}/index.html`));

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function navigateTo(page: string): void {
  // Handle sub-pages like 'merchandise/inventory' (maps to inventory.html, not index.html)
  const parts = page.split('/');
  let filePath: string;

  if (parts.length === 2) {
    // e.g. merchandise/inventory → src/renderer/merchandise/inventory.html
    filePath = path.join(__dirname, `../../../src/renderer/${parts[0]}/${parts[1]}.html`);
  } else {
    filePath = path.join(__dirname, `../../../src/renderer/${page}/index.html`);
  }

  mainWindow?.loadFile(filePath);
}
