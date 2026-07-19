const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owner', {
  status: () => ipcRenderer.invoke('owner:status'),
  activate: (args) => ipcRenderer.invoke('owner:activate', args),
  login: (args) => ipcRenderer.invoke('owner:login', args),
  logout: () => ipcRenderer.invoke('owner:logout'),

  businesses: () => ipcRenderer.invoke('owner:businesses'),
  createBusiness: (payload) => ipcRenderer.invoke('owner:createBusiness', payload),
  locations: (tenantId) => ipcRenderer.invoke('owner:locations', tenantId),
  addLocation: (tenantId, name) => ipcRenderer.invoke('owner:addLocation', tenantId, name),
  renameLocation: (locationId, name) => ipcRenderer.invoke('owner:renameLocation', locationId, name),

  kiosks: (tenantId) => ipcRenderer.invoke('owner:kiosks', tenantId),
  resetKiosk: (tenantId, machineId) => ipcRenderer.invoke('owner:resetKiosk', tenantId, machineId),
  cancelReset: (tenantId, machineId) => ipcRenderer.invoke('owner:cancelReset', tenantId, machineId),

  onlineOrders: (tenantId) => ipcRenderer.invoke('owner:onlineOrders', tenantId),

  staff: (tenantId) => ipcRenderer.invoke('owner:staff', tenantId),
  setStaffPermission: (payload) => ipcRenderer.invoke('owner:setStaffPermission', payload),
  resetStaffPassword: (tenantId, employeeUid) => ipcRenderer.invoke('owner:resetStaffPassword', tenantId, employeeUid),
  revenueByLocation: (tenantId) => ipcRenderer.invoke('owner:revenueByLocation', tenantId),
  auditLog: (tenantId) => ipcRenderer.invoke('owner:auditLog', tenantId),

  publishStatus: () => ipcRenderer.invoke('owner:publishStatus'),
  publish: (appId) => ipcRenderer.invoke('owner:publish', appId),
});
