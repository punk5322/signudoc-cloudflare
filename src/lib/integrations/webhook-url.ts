import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { readEnv, type EnvSource } from "../utils/env.ts";

// Where a webhook may be sent. The server makes these requests, so an
// address an administrator types in must not reach anything the public
// cannot: this machine, the private network, cloud metadata, or the
// container's own gateways to storage and email (*.signudoc.internal on
// Cloudflare). Checked when an endpoint is added and again, with the name
// resolved, before every request.

const blocked = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 127],
  // NAT64 can reach any IPv4 address. (IPv4 written as IPv6, ::ffff:10.0.0.1,
  // is matched against the IPv4 rules by BlockList itself.)
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 0) {
    return true;
  }

  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The app's own hosts: its public address and its storage and email gateways. */
function ownHosts(env: EnvSource): Set<string> {
  const hosts = new Set<string>();

  for (const name of ["APP_URL", "S3_ENDPOINT", "CLOUDFLARE_EMAIL_API_URL"]) {
    const value = readEnv(env, name);

    if (value) {
      try {
        hosts.add(new URL(value).hostname.toLowerCase());
      } catch {
        // Not a URL: nothing to block.
      }
    }
  }

  return hosts;
}

/** The reason a URL may not be used, or null when it may. No DNS lookup. */
export function checkWebhookUrl(
  value: string,
  env: EnvSource = process.env,
): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, starting with https://.";
  }

  if (url.protocol !== "https:") {
    return "The URL must start with https://.";
  }

  if (url.username || url.password) {
    return "The URL must not contain a user name or password.";
  }

  if (url.port && url.port !== "443") {
    return "The URL must use the standard HTTPS port.";
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    return isBlockedAddress(host)
      ? "That address is on a private or internal network."
      : null;
  }

  if (
    !host.includes(".") ||
    host.endsWith(".") ||
    host === "localhost" ||
    /\.(localhost|internal|local|lan|home\.arpa)$/.test(host) ||
    ownHosts(env).has(host)
  ) {
    return "That address is on a private or internal network.";
  }

  return null;
}

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

const resolveWithDns: ResolveAddresses = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

/**
 * checkWebhookUrl, then every address the name resolves to. A name that
 * points at a private address is refused like the address itself.
 *
 * shortcut: fetch resolves the name again, so a DNS answer that changes
 * between the two lookups is not caught; pinning the address would need a
 * custom HTTPS agent.
 */
export async function checkWebhookTarget(
  value: string,
  {
    env = process.env,
    resolve = resolveWithDns,
  }: { env?: EnvSource; resolve?: ResolveAddresses } = {},
): Promise<string | null> {
  const problem = checkWebhookUrl(value, env);

  if (problem) {
    return problem;
  }

  const host = new URL(value).hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    return null;
  }

  let addresses: string[];

  try {
    addresses = await resolve(host);
  } catch {
    return "That host name could not be found.";
  }

  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    return "That address is on a private or internal network.";
  }

  return null;
}
