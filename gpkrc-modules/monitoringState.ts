// Shared state for window monitoring guards.
// Both index.ts and ipcHandlers/deviceHandlers.ts import this module
// to prevent concurrent HID writes and calls during suspend/resume.
export const monitoringState = {
    isActive: false,
    isSuspended: false
};
