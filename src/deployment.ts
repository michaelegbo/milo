/** The public build has no inference server or server fallback. */
export const isDeviceOnly = import.meta.env?.VITE_MILO_DEVICE_ONLY === '1';
export const MILO_REPOSITORY = 'https://github.com/michaelegbo/milo';
