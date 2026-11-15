export const koraConfig = {
  // KORA backend SignalR hub (DoPilot-api), e.g. https://<backend-domain>/hubs/runners. Empty until it is deployed.
  hubUrl: (import.meta.env.VITE_KORA_HUB_URL as string | undefined) || ""
};
