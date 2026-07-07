// Embedded build version, injected by Vite `define` (beta plan §3.1). The
// server's manifest.json carries `latestAppVersion`; the client compares the
// two on launch / resume and shows an update banner when it's behind.
export const APP_VERSION: string = __APP_VERSION__;
