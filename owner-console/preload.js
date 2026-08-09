const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owner', {
  status: () => ipcRenderer.invoke('owner:status'),
  activate: (args) => ipcRenderer.invoke('owner:activate', args),

  businesses: () => ipcRenderer.invoke('owner:businesses'),
  createBusiness: (payload) => ipcRenderer.invoke('owner:createBusiness', payload),
  deleteBusiness: (tenantId) => ipcRenderer.invoke('owner:deleteBusiness', tenantId),
  locations: (tenantId) => ipcRenderer.invoke('owner:locations', tenantId),
  addLocation: (tenantId, name, address, zip) => ipcRenderer.invoke('owner:addLocation', tenantId, name, address, zip),
  renameLocation: (locationId, name) => ipcRenderer.invoke('owner:renameLocation', locationId, name),

  setLocationAddress: (locationId, address, zip) => ipcRenderer.invoke('owner:setLocationAddress', locationId, address, zip),
  setLocationMerchantFee: (locationId, fees) => ipcRenderer.invoke('owner:setLocationMerchantFee', locationId, fees),
  setLocationContact: (locationId, phone, email) => ipcRenderer.invoke('owner:setLocationContact', locationId, phone, email),
  setBusinessContact: (tenantId, contactEmail, contactPhone) => ipcRenderer.invoke('owner:setBusinessContact', tenantId, contactEmail, contactPhone),
  setFeatures: (tenantId, features) => ipcRenderer.invoke('owner:setFeatures', tenantId, features),
  setTwilioConfig: (tenantId, cfg) => ipcRenderer.invoke('owner:setTwilioConfig', tenantId, cfg),
  setMaxRegisters: (licenseKey, maxRegisters) => ipcRenderer.invoke('owner:setMaxRegisters', licenseKey, maxRegisters),
  setAds: (licenseKey, displayConfig) => ipcRenderer.invoke('owner:setAds', licenseKey, displayConfig),
  createManager: (tenantId, username, name) => ipcRenderer.invoke('owner:createManager', tenantId, username, name),
  createStaffUser: (tenantId, payload) => ipcRenderer.invoke('owner:createStaffUser', tenantId, payload),

  kiosks: (tenantId) => ipcRenderer.invoke('owner:kiosks', tenantId),
  resetKiosk: (tenantId, machineId) => ipcRenderer.invoke('owner:resetKiosk', tenantId, machineId),
  cancelReset: (tenantId, machineId) => ipcRenderer.invoke('owner:cancelReset', tenantId, machineId),

  onlineOrders: (tenantId) => ipcRenderer.invoke('owner:onlineOrders', tenantId),

  staff: (tenantId) => ipcRenderer.invoke('owner:staff', tenantId),
  setStaffPermission: (payload) => ipcRenderer.invoke('owner:setStaffPermission', payload),
  resetStaffPassword: (tenantId, employeeUid) => ipcRenderer.invoke('owner:resetStaffPassword', tenantId, employeeUid),
  resetStaffPin: (tenantId, employeeUid) => ipcRenderer.invoke('owner:resetStaffPin', tenantId, employeeUid),
  revenueByLocation: (tenantId) => ipcRenderer.invoke('owner:revenueByLocation', tenantId),
  auditLog: (tenantId) => ipcRenderer.invoke('owner:auditLog', tenantId),

  publishStatus: () => ipcRenderer.invoke('owner:publishStatus'),
  publish: (appId) => ipcRenderer.invoke('owner:publish', appId),
});
