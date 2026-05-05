const DEFAULT_API_BASE_URL = "https://whisperbox.koyeb.app";
const DEFAULT_WS_BASE_URL = "wss://whisperbox.koyeb.app/ws";

export const appConfig = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL,
  wsBaseUrl: process.env.NEXT_PUBLIC_WS_BASE_URL ?? DEFAULT_WS_BASE_URL,
};
