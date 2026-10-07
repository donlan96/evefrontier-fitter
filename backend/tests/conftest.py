from importlib import import_module

import pytest

from app import jobs


@pytest.fixture(autouse=True)
def isolated_solver_diagnostics(monkeypatch, tmp_path):
    """Keep all test jobs, including API globals, away from real diagnostics."""
    test_root = tmp_path / "solver-diagnostics"
    original_init = jobs.JobManager.__init__

    def initialize(self, diagnostics_root=None):
        original_init(self, diagnostics_root if diagnostics_root is not None else test_root)

    monkeypatch.setattr(jobs.JobManager, "__init__", initialize)
    manager = jobs.JobManager(diagnostics_root=test_root)
    monkeypatch.setattr(jobs, "job_manager", manager)
    monkeypatch.setattr(import_module("app.main"), "job_manager", manager)
