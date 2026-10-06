import os

import pytest

from workspace_adapters.lint import lint_source

EXAMPLE = os.path.join(os.path.dirname(__file__), "..", "examples", "matrix_bd_bd", "adapter.py")


def codes(src):
    return {c for _, c, _ in lint_source(src)}


def test_example_adapter_is_clean():
    assert lint_source(open(EXAMPLE, encoding="utf-8").read()) == []


@pytest.mark.parametrize("src,code", [
    ("import sqlalchemy\n", "AD001"),
    ("q = 'SELECT status FROM sites WHERE id = 1'\n", "AD001"),
    ("def f(ctx):\n    if ctx.actor.role == 'supervisor':\n        return 1\n", "AD002"),
    ("def f(ctx, u):\n    return u['roles']\n", "AD002"),
    ("def f(ctx, who):\n    return who in ('business_admin', 'supervisor')\n", "AD002"),
    ("TENANT = '4e06de1e-1111-2222-3333-444455556666'\n", "AD003"),
    ("def f(ctx):\n    return ctx.config.get('x') if ctx.adapter_key != 'ws_blue_tokai' else 0\n", "AD003"),
    ("SEEN = {}\ndef f(ctx):\n    SEEN[ctx.case.id] = 1\n", "AD004"),
    ("COUNT = 0\ndef f():\n    global COUNT\n    COUNT += 1\n", "AD004"),
    ("import requests\n", "AD005"),
    ("def f():\n    return open('/etc/passwd').read()\n", "AD005"),
    ("from workspace_adapters.sdk import Command\ndef f(ctx):\n    return Command('submit_stage', module='legal', key='k')\n", "AD006"),
    ("import datetime\ndef f():\n    return datetime.datetime.now()\n", "AD007"),
    ("import random\n", "AD007"),
])
def test_rules(src, code):
    assert code in codes(src)
