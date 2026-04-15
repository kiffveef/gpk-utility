import { exec } from 'child_process';
import { promisify } from 'util';

import { ActiveWindow } from '@paymoapp/active-window';

import type { ActiveWindowResult } from '../src/types/device';

const execAsync = promisify(exec);

// Timeout in ms for getActiveWindow (OS window APIs can be slow during app launch)
const GET_ACTIVE_WINDOW_TIMEOUT_MS = 2000;

// Get active window with Linux gdbus fallback and timeout.
// Returns null if the active window cannot be determined.
export const getActiveWindowWithFallback = async (): Promise<ActiveWindowResult | null> => {
    try {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<null>((resolve): void => {
            timeoutId = setTimeout((): void => resolve(null), GET_ACTIVE_WINDOW_TIMEOUT_MS);
        });
        const result = await Promise.race([ActiveWindow.getActiveWindow(), timeoutPromise]);
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (!result) return null;
        return { application: result.application };
    } catch {
        // Fallback for Linux using gdbus (Wayland/GNOME)
        return getActiveWindowViaGdbus();
    }
};

// gdbus fallback for Wayland/GNOME environments
const getActiveWindowViaGdbus = async (): Promise<ActiveWindowResult | null> => {
    if (process.platform !== 'linux') return null;
    try {
        const { stdout } = await execAsync(
            'gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/FocusedWindow --method org.gnome.shell.extensions.FocusedWindow.Get'
        );
        // Parse GVariant tuple: ('{"wm_class":"...", ...}',)
        const jsonStr = stdout.trim().slice(2, -3);
        const data = JSON.parse(jsonStr) as { wm_class?: string };
        if (data.wm_class) {
            // Extract last part: "org.gnome.Nautilus" -> "Nautilus"
            const parts = data.wm_class.split('.');
            const appName = parts[parts.length - 1] || data.wm_class;
            return { application: appName };
        }
    } catch {
        // gdbus also failed
    }
    return null;
};

// Run a promise with a timeout. If the timeout fires first, the promise is abandoned
// but its result is ignored (not cancelled). Cleans up the timer in all cases.
export const withTimeout = <T>(promise: Promise<T>, ms: number, label?: string): Promise<T | void> => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((resolve): void => {
        timeoutId = setTimeout((): void => {
            if (label) console.warn(`${label} timed out after ${ms}ms`);
            resolve();
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally((): void => {
        clearTimeout(timeoutId);
    });
};
