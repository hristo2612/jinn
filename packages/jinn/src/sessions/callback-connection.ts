import { loadConfig } from "../shared/config.js";
import { GATEWAY_INFO_FILE } from "../shared/paths.js";
import { gatewayBaseUrl, readGatewayInfo } from "../gateway/gateway-info.js";

export function internalGatewayConnection(): { baseUrl: string; token?: string } {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let fallbackHost: string | undefined;
  let fallbackPort = 7777;
  try {
    const config = loadConfig();
    fallbackHost = config.gateway?.host;
    fallbackPort = config.gateway?.port || 7777;
  } catch {
    // Use gateway.json/defaults if config is unavailable.
  }
  const port = info?.port ?? fallbackPort;
  return {
    baseUrl: gatewayBaseUrl({ port, host: info?.host }, fallbackHost),
    token: info?.token,
  };
}

export function internalGatewayHeaders(gateway: { token?: string }): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(gateway.token ? { authorization: `Bearer ${gateway.token}` } : {}),
  };
}
