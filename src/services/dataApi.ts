import type { FitterDataDocument, FitterDataLoadResponse } from "../models/fitterData";
import { RevisionConflictError } from "../persistence/filePersistence";

export { RevisionConflictError } from "../persistence/filePersistence";

const DATA_API_URL = "http://127.0.0.1:8765/api/data";

type ValidationErrorItem = {
  loc?: Array<string | number>;
  msg?: string;
};

function formatValidationPath(location: Array<string | number>): string {
  return location
    .filter((part, index) => !(index === 0 && part === "body"))
    .reduce<string>((path, part) => typeof part === "number" ? `${path}[${part}]` : path ? `${path}.${part}` : part, "");
}

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  let currentRevision: number | null = null;
  try {
    const body = await response.json() as {
      detail?: string | { message?: string; currentRevision?: number } | ValidationErrorItem[];
    };
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) {
      const validationMessages = body.detail.map((item) => {
        const path = Array.isArray(item.loc) ? formatValidationPath(item.loc) : "";
        return [path, item.msg].filter(Boolean).join(": ");
      }).filter(Boolean);
      if (validationMessages.length > 0) message = validationMessages.join("；");
    } else if (body.detail?.message) {
      message = body.detail.message;
      currentRevision = Number.isInteger(body.detail.currentRevision) ? body.detail.currentRevision as number : null;
    }
  } catch {
    // Preserve the HTTP status when the local service returned no JSON body.
  }
  if (response.status === 409) return new RevisionConflictError(currentRevision, message);
  return new Error(message);
}

export async function loadFitterData(): Promise<FitterDataLoadResponse> {
  const response = await fetch(DATA_API_URL, { headers: { "Content-Type": "application/json" } });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<FitterDataLoadResponse>;
}

export async function saveFitterData(document: FitterDataDocument): Promise<FitterDataDocument> {
  const response = await fetch(DATA_API_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(document),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<FitterDataDocument>;
}
