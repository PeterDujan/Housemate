import { loadConfig } from "./config.js";
import { buildLocalReport } from "./report.js";

const report = buildLocalReport(loadConfig());
console.log(JSON.stringify(report, null, 2));
