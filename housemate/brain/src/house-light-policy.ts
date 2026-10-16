import { houseConfig } from "./house-config.js";

/** The house's lights (house.json `lights.reportable`); without a list, every light counts. */
export function isReportableHouseLightEntityId(entityId: string): boolean {
  const reportable = houseConfig().lights.reportable;
  return reportable ? reportable.includes(entityId) : entityId.startsWith("light.");
}
