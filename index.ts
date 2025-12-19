import path from 'path';
import { fileURLToPath } from 'url';

import { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, dialog } from "electron";
import Store from 'electron-store';
import { ActiveWindow } from '@paymoapp/active-window';

import {
    close,
    setMainWindow,
    updateAutoLayerSettings,
    startWindowMonitoring,
    deviceStatusMap,
    writeCommand,
    getKBDList,
    start,
} from './gpkrc';
import { injectWindowMonitoringDependencies } from './gpkrc-modules/windowMonitoring';
import { setupIpcHandlers, setupIpcEvents, setMainWindow as setIpcMainWindow, setStore as setIpcStore } from './ipcHandlers';
import enTranslations from './src/i18n/locales/en';
import type { ActiveWindowResult, DeviceStatus, Device } from './src/types/device';
import type { StoreSchema } from './src/types/store';
import type { TranslationParams } from './src/types/api-types';
import type { TranslationObject } from './src/types/translation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if(process.platform==='linux') {
    app.commandLine.appendArgument("--no-sandbox");
}

// Memory optimization settings
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024'); // 1GB limit for balanced stability

// Global error handlers to prevent app crashes
process.on('uncaughtException', (error: Error): void => {
    console.error('Uncaught Exception:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
        timestamp: new Date().toISOString(),
        platform: process.platform
    });

    // Cleanup and restart on critical error
    const cleanup = async (): Promise<void> => {
        try {
            // Stop window monitoring first
            stopContinuousWindowMonitoring();

            // Close all devices
            await close();
        } catch (cleanupError) {
            console.error('Cleanup failed during uncaught exception:', cleanupError);
        }

        // Show error dialog if app is ready
        if (app.isReady() && mainWindow && !mainWindow.isDestroyed()) {
            await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Application Error',
                message: 'An unexpected error occurred. The application will restart.',
                detail: error.message
            });
        }

        // Restart the application
        app.relaunch();
        app.exit(1);
    };

    void cleanup();
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>): void => {
    console.error('Unhandled Promise Rejection:', {
        reason: reason instanceof Error ? {
            message: reason.message,
            stack: reason.stack,
            name: reason.name
        } : reason,
        promise: promise.toString(),
        timestamp: new Date().toISOString(),
        platform: process.platform
    });
});

// ActiveWindow is already initialized as an instance, no need to call initialize()

interface PomodoroDeviceInfo {
    name: string;
    phase: number;
}

// Global variables
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let windowMonitoringTimer: NodeJS.Timeout | null = null;

// Initialize electron-store
const store = new Store<StoreSchema>({
    name: 'gpk-utility',
    defaults: {
        autoLayerSettings: {},
        oledSettings: {},
        pomodoroDesktopNotificationsSettings: {},
        savedNotifications: [],
        traySettings: {
            minimizeToTray: true,
            backgroundStart: false
        },
        openAtLogin: false,
        windowBounds: { width: 1280, height: 800 },
        locale: 'en',
        notificationApiEndpoint: 'https://getnotifications-svtx62766a-uc.a.run.app',
        pollingInterval: 3000,
        windowMonitoringInterval: 500
    }
});

// Translation utility function
const translate = (key: string, params: TranslationParams = {}): string => {
    const locale = store.get('locale') || 'en';
    const translations = enTranslations as TranslationObject;
    
    // Get nested value from translations using key path
    const getValue = (obj: TranslationObject, path: string): string | undefined => {
        // Type for navigation through translation objects
        type TranslationValue = string | { [key: string]: TranslationValue };
        const result = path.split('.').reduce((o: TranslationValue | undefined, i: string): TranslationValue | undefined => {
            if (o && typeof o === 'object' && i in o) {
                return (o as { [key: string]: TranslationValue })[i];
            }
            return undefined;
        }, obj as TranslationValue);
        return typeof result === 'string' ? result : undefined;
    };
    
    let text = getValue(translations, key);
    
    // Fall back to English if translation not found
    if (text === undefined && locale !== 'en') {
        text = getValue(enTranslations as TranslationObject, key);
    }
    
    // If still undefined, return key
    if (text === undefined) {
        return key;
    }
    
    // Replace parameters
    return text.replace(/\{\{(\w+)\}\}/g, (match, param): string => params[param] !== undefined ? String(params[param]) : match);
};

// Store active pomodoro devices
const activePomodoroDevices = new Map<string, PomodoroDeviceInfo>();

const handleDeviceDisconnect = (deviceId: string): void => {
    if (activePomodoroDevices.has(deviceId)) {
        activePomodoroDevices.delete(deviceId);
    }
};

// Create a menu template for tray based on current pomodoro status
const createTrayMenuTemplate = (): Electron.MenuItemConstructorOptions[] => {
    // Base menu items
    const menuItems: Electron.MenuItemConstructorOptions[] = [
        { 
            label: 'Show Window', 
            click: async (): Promise<void> => {
                if (mainWindow) {
                    mainWindow.show();
                } else {
                    await createWindow();
                }
            } 
        }
    ];
    
    // Add pomodoro status items if any device has active pomodoro
    if (activePomodoroDevices.size > 0) {
        menuItems.push({ type: 'separator' });
        menuItems.push({ label: 'Active Pomodoro Timers', enabled: false });
        
        // Add an entry for each active pomodoro device
        activePomodoroDevices.forEach((deviceInfo, __deviceId): void => {
            const { name, phase } = deviceInfo;
            let phaseText = '';
            
            switch (phase) {
                case 1:
                    phaseText = 'Working';
                    break;
                case 2:
                    phaseText = 'Break';
                    break;
                case 3:
                    phaseText = 'Long Break';
                    break;
            }
            
            // Display only the phase without minutes
            menuItems.push({
                label: `${name}: ${phaseText}`,
                enabled: false
            });
        });
    }
    
    // Add quit item
    menuItems.push({ type: 'separator' });
    menuItems.push({
        label: 'Quit',
        click: (): void => {
            void safeQuit('tray-menu');
        }
    });
    
    return menuItems;
};

const createTray = (): void => {
    const iconPath = path.join(__dirname, '..', 'icons', '16x16.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);

    // Set default context menu immediately
    const contextMenu = Menu.buildFromTemplate(createTrayMenuTemplate());
    tray.setContextMenu(contextMenu);

    tray.setToolTip(translate('header.title'));

    // Set up click handler
    tray.on('click', async (): Promise<void> => {
        if (mainWindow) {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.show();
            }
        } else {
            await createWindow();
        }
    });
};

// Window monitoring for automatic layer switching
const monitorActiveWindow = async (): Promise<void> => {
    try {
        await startWindowMonitoring({
            getActiveWindow: async (): Promise<ActiveWindowResult> => {
                const result = await ActiveWindow.getActiveWindow();
                return {
                    title: result.title,
                    application: result.application,
                    name: result.application,
                    executableName: result.application
                };
            }
        });
    } catch (error) {
        // Silently ignore errors from window monitoring
        // This is expected when accessing system-level applications
        if (process.env.NODE_ENV === 'development') {
            console.warn('Window monitoring error (expected for system apps):', {
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                } : error,
                context: 'window-monitoring',
                timestamp: new Date().toISOString()
            });
        }
    }
};

// Start window monitoring with cleanup
const startContinuousWindowMonitoring = (intervalMs: number = 500): void => {
    // Stop existing monitoring if any
    if (windowMonitoringTimer) {
        clearInterval(windowMonitoringTimer);
    }

    // Initial check with error handling
    monitorActiveWindow().catch((error): void => {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Initial window monitoring failed:', {
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                } : error,
                context: 'initial-window-monitoring',
                timestamp: new Date().toISOString()
            });
        }
    });

    // Set up interval for continuous monitoring
    windowMonitoringTimer = setInterval((): void => {
        monitorActiveWindow().catch((error): void => {
            if (process.env.NODE_ENV === 'development') {
                console.warn('Window monitoring interval failed:', {
                    error: error instanceof Error ? {
                        message: error.message,
                        stack: error.stack,
                        name: error.name
                    } : error,
                    context: 'window-monitoring-interval',
                    timestamp: new Date().toISOString()
                });
            }
        });
    }, intervalMs);
};

// Stop window monitoring
const stopContinuousWindowMonitoring = (): void => {
    if (windowMonitoringTimer) {
        clearInterval(windowMonitoringTimer);
        windowMonitoringTimer = null;
    }
};

// Safe quit function with proper cleanup
const safeQuit = async (context: string = 'unknown'): Promise<void> => {
    console.warn(`Safe quit initiated from: ${context}`);

    try {
        // Stop window monitoring first
        stopContinuousWindowMonitoring();

        // Close all devices with timeout
        const closePromise = close();
        const timeoutPromise = new Promise<void>((resolve): ReturnType<typeof setTimeout> =>
            setTimeout((): void => {
                console.warn('Device close timeout, proceeding with quit');
                resolve();
            }, 2000)
        );

        await Promise.race([closePromise, timeoutPromise]);

        console.warn('Cleanup completed, exiting application');
    } catch (error) {
        console.error(`Error during safe quit from ${context}:`, {
            error: error instanceof Error ? {
                message: error.message,
                stack: error.stack,
                name: error.name
            } : error,
            context,
            timestamp: new Date().toISOString()
        });
    } finally {
        // Small delay to ensure cleanup completes
        await new Promise<void>((resolve): ReturnType<typeof setTimeout> =>
            setTimeout(resolve, 300)
        );
        app.exit(0);
    }
};

const createWindow = async (): Promise<void> => {
    // Get window position and size from store
    const windowBounds = store.get('windowBounds');
    const minWidth = 800;
    const minHeight = 600;  
    const windowOptions: Electron.BrowserWindowConstructorOptions = {
        width: windowBounds.width || minWidth,
        height: windowBounds.height || minHeight,
        minWidth: minWidth,
        minHeight: minHeight,
        icon: `${__dirname}/../icons/256x256.png`,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        show: !store.get('traySettings')?.backgroundStart,
        backgroundColor: '#f0f0f0', // Prevent white flash
    };
    
    if (windowBounds.x !== undefined) {
        windowOptions.x = windowBounds.x;
    }
    if (windowBounds.y !== undefined) {
        windowOptions.y = windowBounds.y;
    }
    
    mainWindow = new BrowserWindow(windowOptions);

    void mainWindow.loadURL(`file://${__dirname}/public/index.html`);
    mainWindow.setMenu(null);

    // Pass the main window reference to modules
    setMainWindow(mainWindow);
    setIpcMainWindow(mainWindow);
    
    // Pass the store reference to modules
    updateAutoLayerSettings(store);
    setIpcStore(store);
    
    // Re-inject window monitoring dependencies with the actual store
    injectWindowMonitoringDependencies({
        deviceStatusMap: deviceStatusMap as Record<string, DeviceStatus>,
        settingsStore: store,
        writeCommand,
        mainWindow: mainWindow
    });
    
    // Monitor window size and position changes
    mainWindow!.on('resize', (): void => {
        if (!mainWindow!.isMinimized() && !mainWindow!.isMaximized()) {
            const bounds = mainWindow!.getBounds();
            store.set('windowBounds', bounds);
        }
    });
    
    mainWindow!.on('move', (): void => {
        if (!mainWindow!.isMinimized() && !mainWindow!.isMaximized()) {
            const bounds = mainWindow!.getBounds();
            store.set('windowBounds', bounds);
        }
    });

    mainWindow.on('close', (event): void => {
        const traySettings = store.get('traySettings');
        if (traySettings?.minimizeToTray) {
            event.preventDefault();
            mainWindow!.hide();
            return;
        }

        // Prevent default close and use safe quit instead
        event.preventDefault();
        void safeQuit('window-close');
    });

    mainWindow.on('minimize', (): void => {
        const traySettings = store.get('traySettings');
        if (traySettings?.minimizeToTray) {
            mainWindow!.hide();
        }
    });

    // Focus-based window monitoring optimization
    mainWindow.on('focus', (): void => {
        // Setting window focused = stop layer switching
        stopContinuousWindowMonitoring();

        if (process.env.NODE_ENV === 'development') {
            console.warn('Window focused: stopped window monitoring');
        }
    });

    mainWindow.on('blur', (): void => {
        // Window lost focus = resume layer switching
        // Adjust interval based on visibility
        const interval = mainWindow!.isVisible() ? 1500 : 500;
        startContinuousWindowMonitoring(interval);

        if (process.env.NODE_ENV === 'development') {
            console.warn(`Window blurred: started window monitoring (${interval}ms interval, visible: ${mainWindow!.isVisible()})`);
        }
    });

    // Clean up event listeners when window is destroyed
    mainWindow.once('closed', (): void => {
        mainWindow = null;
    });
};

const doubleBoot = app.requestSingleInstanceLock();
if (!doubleBoot) app.quit();

app.setName(translate('header.title'));

app.on('window-all-closed', (): void => {
    if (process.platform !== 'darwin') {
        const traySettings = store.get('traySettings');
        if (traySettings?.minimizeToTray) {
            return;
        }

        void safeQuit('window-all-closed');
    }
});

app.on('ready', async (): Promise<void> => {
    // Set login item settings based on stored preference
    const openAtLogin = store.get('openAtLogin') || false;
    app.setLoginItemSettings({
        openAtLogin: openAtLogin,
        openAsHidden: false
    });

    createTray();
    await createWindow();

    // Setup IPC handlers and events
    setupIpcHandlers();
    if (tray) {
        setupIpcEvents(activePomodoroDevices, tray, createTrayMenuTemplate as () => Electron.MenuItemConstructorOptions[]);
    }

    // Setup power monitoring for sleep/resume
    setupPowerMonitoring();

    // Start window monitoring for automatic layer switching
    // Adjust initial interval based on window state
    if (!mainWindow!.isFocused()) {
        const interval = mainWindow!.isVisible() ? 1500 : 500;
        startContinuousWindowMonitoring(interval);

        if (process.env.NODE_ENV === 'development') {
            console.warn(`Initial window monitoring: ${interval}ms (focused: ${mainWindow!.isFocused()}, visible: ${mainWindow!.isVisible()})`);
        }
    } else {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Window focused at startup: window monitoring not started');
        }
    }

    if (process.env.NODE_ENV === 'development') {
        mainWindow!.webContents.openDevTools();
    }
});

app.on('activate', async (): Promise<void> => {
    if (mainWindow === null) await createWindow();
});

app.on('before-quit', (): void => {
    // Clean up window monitoring timer
    stopContinuousWindowMonitoring();
});

// Power management event handlers for sleep/resume
// Store connected device IDs before suspend
let connectedDeviceIds: string[] = [];
let powerMonitoringRegistered = false;

const setupPowerMonitoring = (): void => {
    if (powerMonitoringRegistered) {
        console.warn('Power monitoring already registered, skipping duplicate registration');
        return;
    }

    powerMonitoringRegistered = true;

    powerMonitor.on('suspend', (): void => {
        if (process.env.NODE_ENV === 'development') {
            console.warn('System is going to sleep');
        }

        try {
            // Stop window monitoring before sleep
            stopContinuousWindowMonitoring();

            // Store currently connected device IDs
            connectedDeviceIds = Object.keys(deviceStatusMap).filter((id): boolean => {
                const status = deviceStatusMap[id];
                return status !== undefined && status.connected === true;
            });

            if (process.env.NODE_ENV === 'development') {
                console.warn('Connected devices before sleep:', connectedDeviceIds);
            }

            // Close all device connections gracefully
            close().catch((error): void => {
                console.error('Error closing devices during suspend:', {
                    error: error instanceof Error ? {
                        message: error.message,
                        stack: error.stack,
                        name: error.name
                    } : error,
                    context: 'system-suspend',
                    connectedDeviceIds,
                    timestamp: new Date().toISOString(),
                    platform: process.platform
                });
            });
        } catch (error) {
            console.error('Error during system suspend:', error);
        }
    });

    powerMonitor.on('resume', (): void => {
        if (process.env.NODE_ENV === 'development') {
            console.warn('System resumed from sleep');
        }

        try {
            // Wait a moment for USB devices to stabilize
            setTimeout((): void => {
                if (process.env.NODE_ENV === 'development') {
                    console.warn('Attempting to reconnect devices...');
                }

                try {
                    // Get current device list
                    const availableDevices = getKBDList();
                    if (process.env.NODE_ENV === 'development') {
                        console.warn('Available devices after resume:', availableDevices.length);
                    }

                    // Attempt to reconnect previously connected devices
                    connectedDeviceIds.forEach((previousId): void => {
                        try {
                            // Find matching device in current list
                            const matchingDevice = availableDevices.find((d): boolean => d.id === previousId);

                            if (matchingDevice && matchingDevice.manufacturer && matchingDevice.product) {
                                if (process.env.NODE_ENV === 'development') {
                                    console.warn(`Reconnecting device: ${previousId}`);
                                }

                                // Convert DeviceWithId to Device type
                                const deviceToReconnect: Device = {
                                    ...matchingDevice,
                                    id: matchingDevice.id,
                                    manufacturer: matchingDevice.manufacturer,
                                    product: matchingDevice.product,
                                    vendorId: matchingDevice.vendorId,
                                    productId: matchingDevice.productId
                                };

                                start(deviceToReconnect)
                                    .then((newId): void => {
                                        if (process.env.NODE_ENV === 'development') {
                                            console.warn(`Successfully reconnected device: ${newId}`);
                                        }

                                        // Notify renderer if window exists
                                        if (mainWindow && !mainWindow.isDestroyed()) {
                                            mainWindow.webContents.send('device-reconnected', { deviceId: newId });
                                        }
                                    })
                                    .catch((error): void => {
                                        console.error(`Failed to reconnect device ${previousId}:`, error);
                                    });
                            } else {
                                if (process.env.NODE_ENV === 'development') {
                                    console.warn(`Device ${previousId} not found after resume or missing required properties`);
                                }
                            }
                        } catch (deviceError) {
                            console.error(`Error reconnecting device ${previousId}:`, deviceError);
                        }
                    });

                    // Restart window monitoring
                    startContinuousWindowMonitoring();

                    if (process.env.NODE_ENV === 'development') {
                        console.warn('Device reconnection attempts completed');
                    }
                } catch (error) {
                    console.error('Error during device reconnection:', error);

                    // Still try to restart window monitoring even if device reconnection fails
                    startContinuousWindowMonitoring();
                }
            }, 2000);
        } catch (error) {
            console.error('Error during system resume:', error);
        }
    });
};

// Export handleDeviceDisconnect for use by IPC handlers
export { handleDeviceDisconnect };