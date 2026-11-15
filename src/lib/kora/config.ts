export const koraConfig = {
  // KORA SignalR hub. The api/ service serves this app and the hub from one origin, so the default is relative;
  // set VITE_KORA_HUB_URL only to point a local dev server at another backend.
  hubUrl: (import.meta.env.VITE_KORA_HUB_URL as string | undefined) || "/hubs/runners"
};
