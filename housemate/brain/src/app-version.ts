import { readFileSync } from "node:fs";

interface PackageMetadata {
  readonly version?: unknown;
}

export function appVersion(): string {
  const envVersion = process.env.npm_package_version;
  if (envVersion?.trim()) {
    return envVersion.trim();
  }
  try {
    const metadata = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as PackageMetadata;
    return typeof metadata.version === "string" && metadata.version.trim() ? metadata.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
