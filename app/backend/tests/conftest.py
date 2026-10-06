"""Shared pytest fixtures + a lightweight AsyncSession stand-in.

The ORM models are heavily Postgres-specific (UUID/JSONB/CHECK constraints,
server-side ``uuid_generate_v4()`` defaults), so a SQLite ``create_all`` harness
is fragile. Instead these tests validate service/router behaviour with:

* pure constructor / helper unit tests (no DB), and
* ``RecordingSession`` — a minimal async stand-in that records the SQL it was
  asked to execute and returns *queued* canned results.

That is enough to assert the things the bug-fix PRs care about: the *shape* of
the SQL emitted (``ON CONFLICT``, ``ORDER BY``, ``notes = NULL`` …), the call
ordering (upload before transaction), and that errors translate to the right
HTTP status. Each test is written to FAIL on the pre-fix code and PASS after.
"""
from __future__ import annotations

import contextlib
import os
from typing import Any

import pytest

# The settings object refuses to instantiate with the placeholder JWT secret
# unless dev mode is explicit (#80). Tests are exactly that.
os.environ.setdefault("ALLOW_INSECURE_DEFAULTS", "true")


class FakeResult:
    """Stand-in for a SQLAlchemy ``Result``.

    Configure exactly the accessor a query uses: ``scalar_one_or_none`` for a
    single ORM row, ``scalars().all()`` for a list, ``all()`` for tuple rows.
    """

    def __init__(
        self,
        *,
        scalar: Any = None,
        scalars_list: list[Any] | None = None,
        all_rows: list[Any] | None = None,
        mappings_rows: list[Any] | None = None,
        rowcount: int = 1,
    ) -> None:
        self._scalar = scalar
        self._scalars_list = scalars_list if scalars_list is not None else []
        self._all_rows = all_rows if all_rows is not None else []
        self._mappings_rows = mappings_rows if mappings_rows is not None else []
        # Mirrors CursorResult.rowcount for guarded UPDATE/DELETE handlers.
        self.rowcount = rowcount

    def scalar_one_or_none(self) -> Any:
        return self._scalar

    def scalar_one(self) -> Any:
        return self._scalar

    def scalar(self) -> Any:
        return self._scalar

    def __iter__(self):
        return iter(self._all_rows)

    def scalars(self) -> "FakeScalars":
        return FakeScalars(self._scalars_list)

    def all(self) -> list[Any]:
        return self._all_rows

    def first(self) -> Any:
        return self._all_rows[0] if self._all_rows else None

    def mappings(self) -> "FakeScalars":
        # FakeScalars exposes .all()/.first(), which is the same surface
        # `.mappings()` callers use.
        return FakeScalars(self._mappings_rows)


class FakeScalars:
    def __init__(self, items: list[Any]) -> None:
        self._items = items

    def all(self) -> list[Any]:
        return self._items

    def first(self) -> Any:
        return self._items[0] if self._items else None

    def __iter__(self):
        # Real SQLAlchemy ScalarResult is iterable; services use
        # ``{x.id: x for x in result.scalars()}`` directly.
        return iter(self._items)


class RecordingSession:
    """A minimal stand-in for ``AsyncSession`` — records, never touches a DB."""

    def __init__(self, results: list[Any] | None = None) -> None:
        self.executed: list[str] = []          # compiled SQL strings
        self.executed_raw: list[Any] = []       # the statement objects
        self.execute_params: list[Any] = []     # the bound params, if any
        self.added: list[Any] = []
        self.deleted: list[Any] = []
        self.flush_count = 0
        self.commit_count = 0
        self.rollback_count = 0
        self.refreshed: list[Any] = []
        self._results: list[Any] = list(results or [])
        self._in_txn = False

    # -- query side -------------------------------------------------------
    async def execute(self, stmt: Any, params: Any = None, *a: Any, **k: Any) -> Any:
        self.executed_raw.append(stmt)
        self.execute_params.append(params)
        try:
            self.executed.append(str(stmt))
        except Exception:  # pragma: no cover - defensive
            self.executed.append(repr(stmt))
        if self._results:
            return self._results.pop(0)
        return FakeResult()

    def queue(self, *results: Any) -> "RecordingSession":
        self._results.extend(results)
        return self

    # -- unit-of-work side ------------------------------------------------
    async def flush(self) -> None:
        self.flush_count += 1

    async def commit(self) -> None:
        self.commit_count += 1

    async def rollback(self) -> None:
        self.rollback_count += 1

    async def refresh(self, obj: Any, *a: Any, **k: Any) -> None:
        self.refreshed.append(obj)

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def delete(self, obj: Any) -> None:
        # AsyncSession.delete is a coroutine (it may need to lazy-load the
        # object's relationships), so the stand-in has to be awaitable too.
        self.deleted.append(obj)

    # -- transaction helper plumbing -------------------------------------
    def in_transaction(self) -> bool:
        return self._in_txn

    def begin(self):
        session = self

        @contextlib.asynccontextmanager
        async def _cm():
            session._in_txn = True
            try:
                yield session
                session.commit_count += 1
            except Exception:
                session.rollback_count += 1
                raise
            finally:
                session._in_txn = False

        return _cm()

    def begin_nested(self):
        return self.begin()

    # -- convenience ------------------------------------------------------
    @property
    def sql(self) -> str:
        return "\n".join(self.executed)


@pytest.fixture
def session() -> RecordingSession:
    return RecordingSession()


@pytest.fixture
def make_session():
    def _factory(*results: Any) -> RecordingSession:
        return RecordingSession(list(results))

    return _factory


@pytest.fixture
def fake_result():
    """The ``FakeResult`` class, so tests can queue canned query results."""
    return FakeResult


@pytest.fixture(autouse=True)
def _reset_storage_client():
    """Reset the process-wide storage httpx client between tests.

    storage_service now reuses one module-level client (#94); resetting it keeps
    per-test monkeypatching of ``httpx.AsyncClient`` honoured and isolated.
    """
    from app.services import storage_service

    storage_service._holder.client = None
    yield
    storage_service._holder.client = None


# ── Phase 2: the per-tenant module registry in RecordingSession tests ──────────
#
# Services now read the tenant's module registry (tenant_modules, migration
# 20261004_2) before minting codes, granting memberships or building the org
# view. The pre-existing unit tests queue canned results for the queries they
# were written against and describe a tenant that never published a
# configuration — i.e. the backfilled built-in seed. This autouse fixture serves
# exactly that seed (mirroring module_catalog: every non-retired built-in,
# enabled, NSO supervisor-only) so those tests keep exercising what they always
# did. Tests of the registry itself opt out with @pytest.mark.real_registry.

LEGACY_REGISTRY = [
    # key, label, position, has_membership, supervisor_only, surface
    ("bd", "BD", 10, True, False, "module"),
    ("legal", "Legal & Compliance", 20, True, False, "module"),
    ("finance_ca", "CA / Commercial Code", 25, False, False, "module"),
    ("design", "Design / Technical", 30, True, False, "module"),
    ("project_excellence", "Project Excellence", 40, True, False, "module"),
    ("project", "Project Execution", 50, True, False, "module"),
    ("nso", "NSO", 60, True, True, "module"),
    ("launch_approval", "Launch Approval", 70, False, False, "module"),
    ("financial_closure", "Financial Closure", 80, False, False, "module"),
    ("quality_audit", "Quality audit reports", 90, False, False, "scope"),
]


def legacy_registry_rows() -> list[dict]:
    from app.services.module_registry_service import module_route

    rows = []
    for key, label, pos, has_m, sup_only, surface in LEGACY_REGISTRY:
        row = {
            "module_key": key, "kind": "builtin", "catalog_key": key, "config_key": key,
            "label": label, "position": pos, "enabled": True, "supervisor_only": sup_only,
            "delegation_enabled": True, "route": None, "introduced_release_id": None,
            "updated_release_id": None, "surface": surface,
            "implementation": f"builtin:{key}", "retired": False, "has_membership": has_m,
        }
        row["route"] = module_route(row)
        rows.append(row)
    return rows


@pytest.fixture(autouse=True)
def _legacy_module_registry(request, monkeypatch):
    if request.node.get_closest_marker("real_registry"):
        yield
        return
    from app.services import module_registry_service as registry

    async def _list(session, tenant_id, *, enabled_only=True):
        return [r for r in legacy_registry_rows() if r["enabled"] or not enabled_only]

    async def _get(session, tenant_id, module_key):
        return next((r for r in legacy_registry_rows() if r["module_key"] == module_key), None)

    monkeypatch.setattr(registry, "list_tenant_modules", _list)
    monkeypatch.setattr(registry, "get_tenant_module", _get)
    yield


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "real_registry: do not stub the module registry with the legacy built-in seed",
    )
