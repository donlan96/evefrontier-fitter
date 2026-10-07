from __future__ import annotations

import importlib
import itertools
import time

import pytest
from ortools.sat.python import cp_model

from app.jobs import JobManager
from app.solver.cp_sat_solver import build_model
from app.solver.empty_cell_budget import empty_cell_budget
from app.solver.validation import validate_layout
from test_solver import board, enabled_rule, module, placement, request, solve


def test_area_dp_matches_exhaustive_quantity_vectors():
    modules = [module('free', [(0, 0)], 0, 2), module('a', [(0, 0), (1, 0)], 1.125, 3),
               module('b', [(0, 0), (1, 0), (2, 0)], 2.25, 2)]
    lo = {'free': 1, 'a': 0, 'b': 0}
    hi = {'free': 2, 'a': 3, 'b': 2}
    for area, floor in itertools.product(range(12), (None, 0, 1000, 3000, 9000)):
        feasible = [a + 2*b + 3*c for a, b, c in itertools.product(range(1, 3), range(4), range(3))
                    if a + 2*b + 3*c <= area and 1125*b + 2250*c >= (floor or 0)]
        expected = area - min(feasible) if feasible else (area - 1 if area >= 1 else None)
        assert empty_cell_budget(area, modules, lo, hi, floor) == expected


def test_more_score_can_require_more_empty_cells_than_the_hint():
    efficient = module('efficient', [(x, 0) for x in range(5)], 10, 2)
    full = module('full', [(x, 0) for x in range(6)], 9, 2)
    payload = request(board(12, 1), [efficient, full], [enabled_rule('efficient', 2), enabled_rule('full', 2)],
                      current=[placement('f1', 'full', 0), placement('f2', 'full', 6)])
    assert build_model(payload).empty_cell_budget == 2
    result = solve(payload)
    assert result.score == 20
    assert result.best_solution.remaining_cells == 2
    assert validate_layout(payload, result.best_solution.placements).valid


@pytest.mark.parametrize('empty_cells', [8, 12, 20])
def test_proven_optimum_with_large_empty_budget_stays_enabled(empty_cells):
    payload = request(board(empty_cells + 2, 1), [module('cargo', [(0, 0)], 10, 2)], [enabled_rule('cargo', 2)],
                      current=[placement('a', 'cargo', 0), placement('b', 'cargo', 1)])
    artifacts = build_model(payload)
    assert artifacts.empty_cell_budget == empty_cells
    assert any(v.name.startswith('budget_') for v in artifacts.model.proto.variables)
    result = solve(payload)
    assert result.proven_optimal and result.score == result.best_bound == 20
    assert result.best_solution.remaining_cells == empty_cells
    assert validate_layout(payload, result.best_solution.placements).valid


@pytest.mark.parametrize('mode', ['no-hint', 'large-budget', 'invalid-hint', 'work-limit'])
def test_no_ship_or_hint_gate_and_safe_fallback(monkeypatch, mode):
    prod = importlib.import_module('app.solver.cp_sat_solver')
    budget_module = importlib.import_module('app.solver.empty_cell_budget')
    hint = [placement('hint', 'cargo', 0)]
    if mode == 'no-hint':
        hint = []
    elif mode == 'invalid-hint':
        hint = [placement('bad', 'cargo', 20)]
    payload = request(board(10 if mode == 'large-budget' else 3, 1), [module('cargo', [(0, 0)], 1, 10)],
                      [enabled_rule('cargo', 10)], current=hint)
    if mode == 'work-limit':
        monkeypatch.setattr(budget_module, 'MAX_AREA_TRANSITIONS', 0)
    actual = build_model(payload)
    assert actual.empty_cell_budget == (9 if mode == 'large-budget' else 3)
    monkeypatch.setattr(prod, 'add_empty_cell_budget', lambda *args: None)
    original = build_model(payload)
    cells = sum(sum(row) for row in payload.board.mask)
    assert len(actual.model.proto.variables) == len(original.model.proto.variables) + cells + 1
    assert str(actual.model.proto.objective) == str(original.model.proto.objective)
    assert str(actual.model.proto.solution_hint) == str(original.model.proto.solution_hint)
    assert not actual.model.validate()


def test_uncoverable_cell_is_forced_empty():
    payload = request(board(4, 1, [[1, 1, 0, 1]]), [module('d', [(0, 0), (1, 0)], 3, 1)],
                      [enabled_rule('d', 1)], current=[placement('hint', 'd', 0)])
    artifacts = build_model(payload)
    assert artifacts.empty_cell_budget == 1
    assert not artifacts.model.validate()
    solver = cp_model.CpSolver()
    assert solver.solve(artifacts.model) == cp_model.OPTIMAL
    empty = next(i for i, v in enumerate(artifacts.model.proto.variables) if v.name == 'budget_empty_3')
    assert solver.value(artifacts.model.get_int_var_from_proto_index(empty)) == 1


def test_zero_budget_and_valid_zero_score_hint():
    payload = request(board(2, 1), [module('required', [(0, 0)], 0, 2)], [enabled_rule('required', 2, 2)],
                      current=[placement('a', 'required', 0), placement('b', 'required', 1)])
    assert build_model(payload).empty_cell_budget == 0
    result = solve(payload)
    assert result.best_solution.occupied_cells == 2
    assert result.proven_optimal


@pytest.mark.parametrize('rotate,locked,required', itertools.product((False, True), repeat=3))
@pytest.mark.parametrize('cold', [False, True])
def test_projected_legal_layouts_equal_original(monkeypatch, rotate, locked, required, cold):
    prod = importlib.import_module('app.solver.cp_sat_solver')
    add_budget = prod.add_empty_cell_budget
    hint = [placement('d1', 'd', 0), placement('s1', 's', 2)]
    payload = request(board(3, 2, [[1, 1, 1], [1, 1, 0]]),
        [module('d', [(0, 0), (1, 0)], 3, 2, rotate), module('s', [(0, 0)], 1, 3)],
        [enabled_rule('d', 2, int(required)), enabled_rule('s', 3)],
        current=[] if cold else hint, locked=hint[:1] if locked else [], scope='rearrange-unlocked')

    class Collect(cp_model.CpSolverSolutionCallback):
        def __init__(self, variables):
            super().__init__()
            self.variables = variables
            self.rows = set()

        def on_solution_callback(self):
            self.rows.add(tuple(self.value(v) for v in self.variables))

    results = []
    for enabled in (False, True):
        monkeypatch.setattr(prod, 'add_empty_cell_budget', add_budget if enabled else lambda *args: None)
        artifacts = build_model(payload)
        budget = (3 if locked or required else 5) if cold else 2
        assert artifacts.empty_cell_budget == (budget if enabled else None)
        artifacts.model.clear_objective()
        artifacts.model.clear_hints()
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.enumerate_all_solutions = True
        solver.parameters.max_time_in_seconds = 5
        collector = Collect(artifacts.variables)
        assert solver.solve(artifacts.model, collector) == cp_model.OPTIMAL
        results.append(collector.rows)
    assert results[0] == results[1]


def test_stop_keeps_best_with_budget_enabled():
    payload = request(board(80, 1), [module('cargo', [(0, 0)], 1, 80)], [enabled_rule('cargo', 80)],
        current=[placement(f'hint-{x}', 'cargo', x) for x in range(76)], time_limit_ms=None)
    assert build_model(payload).empty_cell_budget == 4
    manager = JobManager()  # No writes to the user's diagnostics directory.
    job = manager.create(payload)
    job.request_stop()
    deadline = time.monotonic() + 5
    while job.snapshot().status in ('queued', 'running') and time.monotonic() < deadline:
        time.sleep(.01)
    result = job.snapshot()
    assert result.status in ('stopped', 'completed')
    assert result.score >= 76
    assert validate_layout(payload, result.best_solution.placements).valid
