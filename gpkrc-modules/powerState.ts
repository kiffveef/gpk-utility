// Global power state shared across the HID layer.
// Opening a HID handle (node-hid) whose USB device is powered down or mid-
// re-enumeration during sleep/resume can crash the process natively, bypassing JS
// try/catch. addKbd() (the only path that opens a handle) short-circuits while
// suspended so no open reaches an unstable device. Writes are already safe because
// close() nulls every handle on suspend, so they hit the existing not-connected guard.
let suspended = false;

// Mark the system as suspended or resumed. Set to true on 'suspend' before closing
// devices, and back to false on 'resume' only after the USB stabilize delay.
export const setSuspended = (value: boolean): void => {
    suspended = value;
};

// Whether the system is currently suspended (or resuming and not yet stabilized).
export const isSuspended = (): boolean => suspended;
