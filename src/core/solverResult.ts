import type { SolverJobSnapshot, SolverSolution } from "../models/solver";
import { validateSolverSolution, type SolverLayoutContext } from "./solverLayout";

/** Keep only complete layouts that satisfy this run's frozen problem. */
export function reconcileSolverSnapshot(
  snapshot: SolverJobSnapshot,
  incumbent: SolverSolution | null,
  context: SolverLayoutContext,
) {
  const checkedCandidate = snapshot.bestSolution ? validateSolverSolution(snapshot.bestSolution, context) : null;
  const candidate = checkedCandidate?.valid ? checkedCandidate.solution : null;
  const checkedIncumbent = incumbent ? validateSolverSolution(incumbent, context) : null;
  const current = checkedIncumbent?.valid ? checkedIncumbent.solution : null;
  const bestSolution = !current || (candidate && (candidate.totalScore > current.totalScore
    || (candidate.totalScore === current.totalScore && candidate.occupiedCells > current.occupiedCells)))
    ? candidate : current;
  const score = bestSolution?.totalScore ?? 0;
  const provenOptimal = snapshot.provenOptimal && snapshot.solverStatus === "OPTIMAL" && candidate !== null
    && snapshot.score === candidate.totalScore && snapshot.bestBound === candidate.totalScore
    && score === candidate.totalScore;
  const errors = checkedCandidate && !checkedCandidate.valid
    ? [...snapshot.errors, `求解方案未通过完整校验：${checkedCandidate.reasons.join("；")}`] : snapshot.errors;
  return {
    candidate,
    snapshot: {
      ...snapshot, bestSolution, score, provenOptimal, errors, problemChanged: false,
      bestBound: Math.max(snapshot.bestBound, score),
      optimalityGap: Math.max(0, snapshot.bestBound - score),
    },
  };
}

/** A cached proof is meaningful only for the problem that produced it. */
export function revalidateCachedSolverSnapshot(
  snapshot: SolverJobSnapshot,
  context: SolverLayoutContext,
  sameProblem: boolean,
): SolverJobSnapshot {
  const checked = reconcileSolverSnapshot(snapshot, null, context).snapshot;
  return { ...checked, provenOptimal: checked.provenOptimal && sameProblem, problemChanged: !sameProblem };
}
