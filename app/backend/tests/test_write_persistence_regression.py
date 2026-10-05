"""Regression: every write was silently rolled back (DB frozen since 2026-06-12).

Root cause: the per-request `is_active` SELECT added to get_current_user (#103)
auto-begins a transaction on the request-scoped session. The service-layer
`transaction()` helper then sees `in_transaction()` True and opens a SAVEPOINT
(`begin_nested`) inside it — releasing a savepoint does NOT commit the outer
transaction, so the write was discarded when get_db closed the session. The
route still returned 201 (the flushed row had an id), so it looked like success.

Fixes locked in here:
  1. get_db commits any transaction still open when a route returns successfully
     (the durable, all-modules safety net).
  2. get_current_user rolls back its read-only is_active txn so the write path
     opens a real committing transaction instead of a non-committing savepoint.
"""
from __future__ import annotations

import pytest

from app.db import session as session_mod


class _FakeSession:
    def __init__(self, in_txn: bool = True) -> None:
        self._in_txn = in_txn
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def in_transaction(self) -> bool:
        return self._in_txn

    async def commit(self) -> None:
        self.committed = True
        self._in_txn = False

    async def rollback(self) -> None:
        self.rolled_back = True
        self._in_txn = False

    async def close(self) -> None:
        self.closed = True


async def test_get_db_commits_open_transaction_on_success(monkeypatch):
    # Simulates the bug scenario: a txn is still open (the savepoint-only path
    # left the outer txn uncommitted) when the route returns. get_db MUST commit.
    fake = _FakeSession(in_txn=True)
    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake)

    gen = session_mod.get_db()
    await gen.__anext__()                      # run up to `yield session`
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()                  # resume after yield → commit + close

    assert fake.committed is True, "open transaction must be committed on success"
    assert fake.rolled_back is False
    assert fake.closed is True


async def test_get_db_no_commit_when_nothing_open(monkeypatch):
    fake = _FakeSession(in_txn=False)
    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake)

    gen = session_mod.get_db()
    await gen.__anext__()
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()

    assert fake.committed is False             # no txn → nothing to commit
    assert fake.closed is True


async def test_get_db_rolls_back_on_error(monkeypatch):
    # An errored request must NOT commit a partial write.
    fake = _FakeSession(in_txn=True)
    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake)

    gen = session_mod.get_db()
    await gen.__anext__()
    with pytest.raises(ValueError):
        await gen.athrow(ValueError("boom"))   # exception injected at the route

    assert fake.rolled_back is True
    assert fake.committed is False
    assert fake.closed is True
