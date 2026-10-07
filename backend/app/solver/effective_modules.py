from __future__ import annotations

from collections import Counter

from app.models import ModuleDefinition, ModuleRule, PlacedModule, SolveRequest


def fixed_placements(request: SolveRequest) -> list[PlacedModule]:
    if request.scope == "empty-board":
        return []
    if request.scope == "fill-current":
        return request.current_layout
    return request.locked_placements


def effective_limits(
    request: SolveRequest,
    fixed_counts: Counter[str] | None = None,
) -> tuple[dict[str, int], dict[str, int]]:
    if fixed_counts is None:
        fixed_counts = Counter(item.module_id for item in fixed_placements(request))
    rule_map = {rule.module_id: rule for rule in request.module_rules}
    minimums: dict[str, int] = {}
    maximums: dict[str, int] = {}
    for module in request.modules:
        rule = rule_map.get(
            module.id,
            ModuleRule(module_id=module.id, required_count=0, enabled=False, max_count=0),
        )
        minimum = max(rule.required_count, fixed_counts[module.id])
        enabled_maximum = min(module.available_quantity, rule.max_count) if rule.enabled else minimum
        minimums[module.id] = minimum
        maximums[module.id] = max(minimum, enabled_maximum)
    return minimums, maximums


def effective_module_ids(
    request: SolveRequest,
    fixed_counts: Counter[str] | None = None,
) -> set[str]:
    _, maximums = effective_limits(request, fixed_counts)
    return {module_id for module_id, maximum in maximums.items() if maximum > 0}


def effective_modules(
    request: SolveRequest,
    fixed_counts: Counter[str] | None = None,
) -> list[ModuleDefinition]:
    active_ids = effective_module_ids(request, fixed_counts)
    return [module for module in request.modules if module.id in active_ids]
