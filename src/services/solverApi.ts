import type { SolverApiRequest, SolverJobSnapshot } from "../models/solver";

const SOLVER_API_BASE = "http://127.0.0.1:8765/api";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SOLVER_API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { detail?: string | Array<{ msg?: string }> };
      detail = typeof body.detail === "string"
        ? body.detail
        : Array.isArray(body.detail) ? body.detail.map((item) => item.msg).filter(Boolean).join("；") : detail;
    } catch {
      // Keep the HTTP status when the local service did not return JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export function startSolverJob(request: SolverApiRequest): Promise<SolverJobSnapshot> {
  return requestJson("/solver/solve", { method: "POST", body: JSON.stringify(request) });
}

export function getSolverJob(jobId: string, signal?: AbortSignal): Promise<SolverJobSnapshot> {
  return requestJson(`/solver/status/${encodeURIComponent(jobId)}`, { signal });
}

export function stopSolverJob(jobId: string): Promise<SolverJobSnapshot> {
  return requestJson(`/solver/stop/${encodeURIComponent(jobId)}`, { method: "POST" });
}

export async function checkSolverHealth(): Promise<boolean> {
  try {
    const response = await requestJson<{ status: string }>("/health");
    return response.status === "ok";
  } catch {
    return false;
  }
}
