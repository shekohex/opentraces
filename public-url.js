export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:3000";

export function normalizePublicBaseUrl(value, fallback = DEFAULT_PUBLIC_BASE_URL) {
  const candidate = (value ?? fallback).trim();
  if (!candidate) return fallback;
  return candidate.replace(/\/+$/, "");
}

export function getPublicBaseUrl() {
  return normalizePublicBaseUrl(process.env.OPENTRACES_PUBLIC_URL ?? process.env.PUBLIC_URL);
}

export function getPublicHost(baseUrl = getPublicBaseUrl()) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "");
  }
}
