import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import { getValidAccessToken } from "../blocks/auth";
import { koraConfig } from "./config";

// A connection to the KORA hub. Auth: the browser's Blocks session cookie rides along (withCredentials); a
// bearer token is sent too when the app happens to hold one.
export function createKoraConnection() {
  return new HubConnectionBuilder()
    .withUrl(koraConfig.hubUrl, {
      withCredentials: true,
      accessTokenFactory: async () => (await getValidAccessToken()) ?? ""
    })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();
}

// The JS client wraps a HubException as "An unexpected error occurred invoking 'X' on the server. HubException: <message>".
export function describeHubError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthorized/i.test(message)) return "The KORA backend did not accept your session. Sign in again.";
  return message.replace(/^.*HubException: /s, "");
}
