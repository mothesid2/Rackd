import { BrowserWindow, screen } from 'electron';
import path from 'path';

let customerDisplayWindow: BrowserWindow | null = null;

export function createCustomerDisplayWindow(): BrowserWindow | null {
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return null;

  const secondDisplay = displays[1];

  customerDisplayWindow = new BrowserWindow({
    x: secondDisplay.bounds.x,
    y: secondDisplay.bounds.y,
    width: secondDisplay.bounds.width,
    height: secondDisplay.bounds.height,
    fullscreen: true,
    title: 'rackd - Customer Display',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    frame: false,
  });

  customerDisplayWindow.loadFile(
    path.join(__dirname, '../../../src/renderer/customer-display/index.html')
  );

  customerDisplayWindow.on('closed', () => {
    customerDisplayWindow = null;
  });

  return customerDisplayWindow;
}

export function getCustomerDisplayWindow(): BrowserWindow | null {
  return customerDisplayWindow;
}

export function updateCustomerDisplay(data: object): void {
  customerDisplayWindow?.webContents.send('update-display', data);
}
