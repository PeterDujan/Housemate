import { parentPort, workerData } from "node:worker_threads";

import { WikipediaKnowledgeStore } from "./wikipedia-knowledge-store.js";

interface WikipediaWorkerData {
  readonly dataDir: string;
}

type WikipediaWorkerRequest =
  | {
      readonly id: number;
      readonly kind: "query";
      readonly transcript: string;
    }
  | {
      readonly id: number;
      readonly kind: "early_title";
      readonly titleText: string;
    }
  | {
      readonly id: number;
      readonly kind: "early_qualified_title";
      readonly titleText: string;
      readonly mediaKind: "film" | "book" | "show" | "music";
    };

const input = workerData as WikipediaWorkerData;
const store = new WikipediaKnowledgeStore({ dataDir: input.dataDir });
store.prewarm(false);
parentPort?.on("message", (request: WikipediaWorkerRequest) => {
  const result = request.kind === "query"
    ? store.lookupWithDiagnostics(request.transcript)
    : request.kind === "early_title"
      ? store.lookupEarlyTitleTextWithDiagnostics(request.titleText)
      : store.lookupEarlyQualifiedTitleTextWithDiagnostics(
        request.titleText,
        request.mediaKind,
      );
  parentPort?.postMessage({
    id: request.id,
    result,
  });
});
