import { BrowserWindow } from "electron";
import Store from 'electron-store';

import { setupConfigHandlers, setMainWindow as setConfigMainWindow, setStore as setConfigStore } from './ipcHandlers/configHandlers';
import { setupDeviceHandlers, setupDeviceEvents, setMainWindow as setDeviceMainWindow } from './ipcHandlers/deviceHandlers';
import { setupFileHandlers } from './ipcHandlers/fileHandlers';
import { setupNotificationHandlers, setupNotificationEvents, setStore as setNotificationStore, setMainWindow as setNotificationMainWindow } from './ipcHandlers/notificationHandlers';
import { setupStoreHandlers, setStore as setStoreInStoreHandlers, setMainWindow as setStoreMainWindow } from './ipcHandlers/storeHandlers';
import type { StoreSchema } from './src/types/store';

// Module state - maintained for compatibility with existing code
let _mainWindow: BrowserWindow | null = null;
let _store: Store<StoreSchema> | null = null;

// Guard flags to prevent duplicate handler registration
let _handlersRegistered = false;
let _eventsRegistered = false;

// Set references from main process
export const setMainWindow = (window: BrowserWindow | null): void => {
    _mainWindow = window;

    // Pass mainWindow to all handler modules
    setDeviceMainWindow(window);
    setConfigMainWindow(window);
    setStoreMainWindow(window);
    setNotificationMainWindow(window);
};

export const setStore = (storeInstance: Store<StoreSchema>): void => {
    _store = storeInstance;

    // Pass store to modules that need it
    setConfigStore(storeInstance);
    setStoreInStoreHandlers(storeInstance);
    setNotificationStore(storeInstance);
};

// Setup all IPC handlers
export const setupIpcHandlers = (): void => {
    if (_handlersRegistered) {
        console.warn('IPC handlers already registered, skipping duplicate registration');
        return;
    }

    _handlersRegistered = true;

    // Setup handlers from each module
    setupDeviceHandlers();
    setupConfigHandlers();
    setupFileHandlers();
    setupStoreHandlers();
    setupNotificationHandlers();
};

// Setup event handlers (non-handle IPC events)
export const setupIpcEvents = (activePomodoroDevices: Map<string, unknown>, tray: Electron.Tray, createTrayMenuTemplate: () => Electron.MenuItemConstructorOptions[]): void => {
    if (_eventsRegistered) {
        console.warn('IPC events already registered, skipping duplicate registration');
        return;
    }

    _eventsRegistered = true;

    // Setup device events
    setupDeviceEvents();

    // Setup notification events
    setupNotificationEvents(activePomodoroDevices as Map<string, { name: string; phase: number }>, tray, createTrayMenuTemplate);
};