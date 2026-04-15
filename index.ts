import path from 'path';
import { fileURLToPath } from 'url';

import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from "electron";
import Store from 'electron-store';

import {
    close,
    setMainWindow,
    updateAutoLayerSettings,
    deviceStatusMap,
    writeCommand,
} from './gpkrc';
import { injectWindowMonitoringDependencies } from './gpkrc-modules/windowMonitoring';
import { setupIpcHandlers, setupIpcEvents, setMainWindow as setIpcMainWindow, setStore as setIpcStore } from './ipcHandlers';
import enTranslations from './src/i18n/locales/en';
import type { DeviceStatus } from './src/types/device';
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
        const PHASE_LABELS: Record<number, string> = { 1: 'Working', 2: 'Break', 3: 'Long Break' };

        activePomodoroDevices.forEach((deviceInfo, __deviceId): void => {
            const { name, phase } = deviceInfo;
            const phaseText = PHASE_LABELS[phase] ?? '';
            menuItems.push({ label: `${name}: ${phaseText}`, enabled: false });
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

// Safe quit function with proper cleanup
const safeQuit = async (context: string = 'unknown'): Promise<void> => {
    console.warn(`Safe quit initiated from: ${context}`);

    try {

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
        backgroundColor: '#111827',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        show: !store.get('traySettings')?.backgroundStart,
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

    if (process.env.NODE_ENV === 'development') {
        mainWindow!.webContents.openDevTools();
    }
});

app.on('activate', async (): Promise<void> => {
    if (mainWindow === null) await createWindow();
});


// Export handleDeviceDisconnect for use by IPC handlers
export { handleDeviceDisconnect };