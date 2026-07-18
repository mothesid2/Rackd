const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portal', {
  login: (code) => ipcRenderer.invoke('portal:login', code),
  logout: () => ipcRenderer.invoke('portal:logout'),
  session: () => ipcRenderer.invoke('portal:session'),
  dashboard: (range) => ipcRenderer.invoke('portal:dashboard', range),
  locationReport: (args) => ipcRenderer.invoke('portal:locationReport', args),
  locations: () => ipcRenderer.invoke('portal:locations'),
  rebates: (range) => ipcRenderer.invoke('portal:rebates', range),
  inventory: () => ipcRenderer.invoke('portal:inventory'),
  customers: () => ipcRenderer.invoke('portal:customers'),
  createCustomer: (args) => ipcRenderer.invoke('portal:createCustomer', args),
  updateCustomer: (args) => ipcRenderer.invoke('portal:updateCustomer', args),
  storefrontLocations: () => ipcRenderer.invoke('portal:storefrontLocations'),
  setStorefront: (args) => ipcRenderer.invoke('portal:setStorefront', args),
  stripeConnect: (args) => ipcRenderer.invoke('portal:stripeConnect', args),
  openExternal: (url) => ipcRenderer.invoke('portal:openExternal', url),
  uploadProductImage: (args) => ipcRenderer.invoke('portal:uploadProductImage', args),
  menu: (args) => ipcRenderer.invoke('portal:menu', args),
  setMenuItem: (args) => ipcRenderer.invoke('portal:setMenuItem', args),
  orders: (args) => ipcRenderer.invoke('portal:orders', args),
  orderStatus: (args) => ipcRenderer.invoke('portal:orderStatus', args),
});
