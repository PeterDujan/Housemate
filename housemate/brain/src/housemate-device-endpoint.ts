import type { AlarmRecord } from "./alarm-clock.js";

export const JARVIS_NUC_ENDPOINT_ID = "nuc";

export interface JarvisEndpointActionResult {
  readonly touchedEntities: readonly string[];
}

/** Where an alarm rings. Music no longer goes through here: it plays on the speaker's own player (`music-control.ts`). */
export interface JarvisDeviceEndpoint {
  readonly id: string;
  readonly label: string;
  playAlarm(request: { readonly alarm: AlarmRecord }): Promise<JarvisEndpointActionResult>;
  stopAlarm(request: { readonly alarm: AlarmRecord | null }): Promise<JarvisEndpointActionResult>;
}

export class NucJarvisDeviceEndpoint implements JarvisDeviceEndpoint {
  readonly id = JARVIS_NUC_ENDPOINT_ID;
  readonly label = "Voice host";

  async playAlarm(request: { readonly alarm: AlarmRecord }): Promise<JarvisEndpointActionResult> {
    console.warn(`[brain] alarm endpoint ${this.id} ringing: ${request.alarm.id} ${request.alarm.fireAt}`);
    return { touchedEntities: [] };
  }

  async stopAlarm(_request: { readonly alarm: AlarmRecord | null }): Promise<JarvisEndpointActionResult> {
    return { touchedEntities: [] };
  }
}
