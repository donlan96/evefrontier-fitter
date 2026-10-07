from __future__ import annotations

from ortools.sat.python import cp_model

from app.models import ModuleDefinition
from app.solver.placement_generator import SCORE_SCALE
from app.solver.score_bound import module_area


# Limit preprocessing work, not the number of empty cells or eligible ships.
MAX_AREA_TRANSITIONS = 1_000_000


def empty_cell_budget(
    valid_cells: int,
    modules: list[ModuleDefinition],
    minimums: dict[str, int],
    maximums: dict[str, int],
    score_lower_bound: int | None,
) -> int | None:
    """Safe empty-area budget, tightened by an integer area/quantity relaxation.

    Each DP entry holds the largest score at one exact occupied area. Every
    legal layout has a quantity vector in this relaxation, so its occupied
    area is at least the smallest DP area reaching the model's score floor.
    If the tighter computation is unavailable, required area alone still gives
    a safe budget. None is reserved for required area already exceeding the
    board; the caller's existing feasibility checks handle that condition.
    """
    minimum_area = sum(module_area(m) * minimums[m.id] for m in modules)
    if minimum_area > valid_cells:
        return None
    basic_budget = valid_cells - minimum_area
    minimum_score = sum(round(m.base_score * SCORE_SCALE) * minimums[m.id] for m in modules)
    if score_lower_bound is None or score_lower_bound <= minimum_score:
        return basic_budget
    scores_by_area = {0: 0}
    transitions = 0
    for module in modules:
        area = module_area(module)
        score = round(module.base_score * SCORE_SCALE)
        minimum = minimums[module.id]
        maximum = maximums[module.id]
        next_scores: dict[int, int] = {}
        for used_area, used_score in scores_by_area.items():
            upper = min(maximum, (valid_cells - used_area) // area)
            transitions += max(0, upper - minimum + 1)
            if transitions > MAX_AREA_TRANSITIONS:
                return basic_budget
            for quantity in range(minimum, upper + 1):
                next_area = used_area + quantity * area
                next_score = used_score + quantity * score
                next_scores[next_area] = max(next_scores.get(next_area, -1), next_score)
        scores_by_area = next_scores
    feasible_areas = [area for area, score in scores_by_area.items() if score >= score_lower_bound]
    if not feasible_areas:
        return basic_budget
    return valid_cells - min(feasible_areas)


def add_empty_cell_budget(
    model: cp_model.CpModel,
    by_cell: dict[int, list[cp_model.IntVar]],
    cell_constraints: dict[int, cp_model.Constraint],
    module_counts: dict[str, cp_model.IntVar],
    modules: list[ModuleDefinition],
    minimums: dict[str, int],
    maximums: dict[str, int],
    score_lower_bound: int | None,
) -> int | None:
    budget = empty_cell_budget(len(by_cell), modules, minimums, maximums, score_lower_bound)
    if budget is None:
        return None

    # Append after the original variables, matching the accepted encoding.
    empty_variables: list[cp_model.IntVar] = []
    for cell, placements in by_cell.items():
        empty = model.new_bool_var(f"budget_empty_{cell}")
        empty_variables.append(empty)
        constraint = cell_constraints[cell].proto
        if placements:
            constraint.linear.vars.append(empty.index)
            constraint.linear.coeffs.append(1)
            constraint.linear.domain[0] = 1
        else:
            # The original sum([]) <= 1 is a tautology; this cell must be empty.
            replacement = cp_model.CpModel()
            dummy = replacement.new_bool_var("empty")
            replacement.add(dummy == 1)
            if hasattr(constraint, "copy_from"):
                constraint.copy_from(replacement.proto.constraints[0])
            else:
                constraint.CopyFrom(replacement.proto.constraints[0])
            constraint.linear.vars[0] = empty.index

    total_empty = model.new_int_var(0, len(by_cell), "budget_total_empty")
    model.add(total_empty == sum(empty_variables))
    model.add(total_empty + sum(module_area(m) * module_counts[m.id] for m in modules) == len(by_cell))
    model.add(total_empty <= budget)
    return budget
