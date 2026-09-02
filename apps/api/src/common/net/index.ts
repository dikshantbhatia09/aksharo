/** Outbound HTTP, under the SSRF rules of THREAT-MODEL T6. */

export {
  DENIED_IPV4,
  DENIED_IPV6,
  isPublicAddress,
  parseIpv4,
  parseIpv6,
  reasonAddressIsDenied,
} from "./ip-rules.js";
export type { DeniedRange, IpFamily } from "./ip-rules.js";
export {
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  resolveSafeTarget,
  safeFetch,
  SafeFetchError,
} from "./safe-fetch.js";
export type {
  AddressResolver,
  SafeFetchErrorCode,
  SafeFetchOptions,
  SafeFetchResult,
  SafeTarget,
  SafeTransport,
  SafeTransportRequest,
  SafeTransportResponse,
} from "./safe-fetch.js";
