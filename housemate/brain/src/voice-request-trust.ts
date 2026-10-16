import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { AppConfig } from "./config.js";
import type { VoiceBrainIdentitySource } from "./voice-brain.js";

export interface VoiceRequestTransportTrust {
  readonly actorId: string;
  readonly source: Exclude<VoiceBrainIdentitySource, "none">;
}

export function resolveVoiceRequestTransportTrust(
  config: Pick<
    AppConfig,
    "cognitiveIngressUserId" | "cognitiveApiToken" | "cognitiveOperatorActorId"
  >,
  request: {
    readonly remoteAddress: string | undefined;
    readonly headers: IncomingHttpHeaders;
  },
): VoiceRequestTransportTrust | null {
  const remoteAddress = normalizeRemoteAddress(request.remoteAddress);
  const ingressUserId = singleHeader(request.headers["x-remote-user-id"]);
  if (
    remoteAddress === "172.30.32.2"
    && config.cognitiveIngressUserId
    && ingressUserId === config.cognitiveIngressUserId
  ) {
    return {
      actorId: config.cognitiveOperatorActorId,
      source: "ha_ingress",
    };
  }

  const bearer = bearerToken(singleHeader(request.headers.authorization));
  const jarvisToken = singleHeader(request.headers["x-jarvis-token"]);
  const apiCredential = bearer ?? jarvisToken;
  if (
    apiCredential
    && config.cognitiveApiToken
    && constantTimeEqual(apiCredential, config.cognitiveApiToken)
  ) {
    return {
      actorId: config.cognitiveOperatorActorId,
      source: "api_token",
    };
  }
  return null;
}

function normalizeRemoteAddress(value: string | undefined): string {
  return (value ?? "").replace(/^::ffff:/, "");
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bearerToken(value: string | null): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(value ?? "");
  return match?.[1] ?? null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}
