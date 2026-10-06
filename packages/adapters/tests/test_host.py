import time

import pytest

from conftest import ANA, base, case
from workspace_adapters import AdapterHost, ContractViolation
from workspace_adapters.sdk import (Actor, Adapter, AfterContext, ApproveContext, Command, Decision, Descriptor, Effects,
                                    Event, OpenContext, OutcomeContext, RuleContext, SubjectUpdate, SubmitContext,
                                    SubmitResult, SyncContext, Violation, freeze)

MOD = {"key": "fit_out", "stages": [{"key": "plan", "fields": [{"key": "budget"}], "approvals": [{"role": "supervisor", "fields": [{"key": "ok_date"}]}]}],
       "adapter": {"key": "t.adapter", "version": "1.0.0", "hooks": []}}
ALL = ("beforeOpen", "beforeSubmit", "validateBusinessRule", "afterSubmit", "beforeApprove", "afterApprove", "computeOutcome", "syncExternalState")
DESC = Descriptor(key="t.adapter", version="1.0.0", hooks=ALL, namespace="t.adapter", emits=("t.adapter.happened",),
                  consumes=("other.done",), commands=("submit_stage", "open_case"), subject_fields=("code",), timeout_ms=100)


def run(impl, hook, ctx, declared=ALL, desc=DESC):
    h = AdapterHost()
    h.install(desc, impl)
    return h.run(hook, ctx, declared)


def ctx(cls, **kw):
    return base(cls, module=MOD, **kw)


class Emit(Adapter):
    def __init__(self, effects):
        self.effects = effects

    def afterApprove(self, c):
        return self.effects

    def syncExternalState(self, c):
        return self.effects


def after():
    return ctx(AfterContext, stage="plan", action="approve", event_id="e1")


@pytest.mark.parametrize("effects,code", [
    (Effects(commands=(Command("submit_stage", module="bd", on_behalf_of="u-ana", key="k"),)), "cross_module_write"),
    (Effects(commands=(Command("submit_stage", module="fit_out", on_behalf_of="u-ana", key="k", release_version=4),)), "release_override"),
    (Effects(commands=(Command("submit_stage", module="fit_out", key="k"),)), "anonymous_command"),
    (Effects(commands=(Command("submit_stage", module="fit_out", on_behalf_of="u-boss", key="k"),)), "impersonation"),
    (Effects(commands=(Command("reopen_case", module="fit_out", on_behalf_of="u-ana", key="k"),)), "command_not_declared"),
    (Effects(events=(Event("bd.site_updated", {}, "k"),)), "event_not_declared"),
    (Effects(events=(Event("t.adapter.happened", {}, ""),)), "missing_effect_key"),
    (Effects(subject_updates=(SubjectUpdate({"status": "launched"}, "k"),)), "subject_field_not_declared"),
])
def test_effect_rules_dead_letter(effects, code):
    r = run(Emit(effects), "afterApprove", after())
    assert not r.ok and r.error == code and r.dead_letter and r.value == Effects.none()


def test_allowed_effects_pass():
    eff = Effects(events=(Event("t.adapter.happened", {"x": 1}, "e1:a"),),
                  commands=(Command("submit_stage", module="fit_out", case_id="c-1", stage="plan", on_behalf_of="u-ana", key="e1:b"),),
                  subject_updates=(SubjectUpdate({"code": "BT-1"}, "e1:c"),))
    assert run(Emit(eff), "afterApprove", after()).ok


def test_sync_only_on_subscribed_events_and_on_behalf_of_event_actor():
    eff = Effects(commands=(Command("submit_stage", module="fit_out", on_behalf_of="u-sam", key="k"),))
    sync = ctx(SyncContext, event_type="other.done", event_id="e2", event_actor=Actor("u-sam", "Sam"))
    assert run(Emit(eff), "syncExternalState", sync).ok
    wrong = ctx(SyncContext, event_type="other.started", event_id="e3", event_actor=Actor("u-sam", "Sam"))
    assert run(Emit(eff), "syncExternalState", wrong).error == "not_subscribed"


def test_undeclared_hook_is_not_run():
    class Boom(Adapter):
        def beforeOpen(self, c):
            raise RuntimeError("must not run")
    r = run(Boom(), "beforeOpen", ctx(OpenContext), declared=())
    assert r.ok and r.skipped and r.value.allow


def test_fail_closed_on_exception_and_timeout():
    class Boom(Adapter):
        def validateBusinessRule(self, c):
            raise KeyError("x")

        def beforeApprove(self, c):
            time.sleep(0.5)
            return Decision.ok()
    r = run(Boom(), "validateBusinessRule", ctx(RuleContext, stage="plan"))
    assert not r.ok and r.error == "adapter_error" and r.value[0].code == "adapter_error"
    r = run(Boom(), "beforeApprove", ctx(ApproveContext, stage="plan"))
    assert not r.ok and r.error == "adapter_timeout" and r.value.allow is False


def test_context_is_frozen():
    class Mutate(Adapter):
        def beforeOpen(self, c):
            c.case.values["plan"] = {"budget": 0}
            return Decision.ok()
    r = run(Mutate(), "beforeOpen", ctx(OpenContext))
    assert not r.ok and r.error == "adapter_error" and r.value.allow is False


def test_before_submit_may_only_touch_its_own_stage_fields():
    class Sneaky(Adapter):
        def beforeSubmit(self, c):
            return SubmitResult(values={"budget": 1, "ok_date": "2026-01-01"})   # ok_date is an APPROVER field
    r = run(Sneaky(), "beforeSubmit", ctx(SubmitContext, stage="plan", values=freeze({"budget": 2})))
    assert r.error == "foreign_values" and r.value.violations[0].code == "foreign_values"


def test_compute_outcome_must_be_allowed_and_deterministic():
    class Flaky(Adapter):
        n = 0

        def computeOutcome(self, c):
            Flaky.n += 1
            return "done" if Flaky.n % 2 else "rejected"

    class Wrong(Adapter):
        def computeOutcome(self, c):
            return "launched"
    oc = ctx(OutcomeContext, default_outcome="done", allowed=("done", "rejected"))
    assert run(Flaky(), "computeOutcome", oc).error == "nondeterministic_outcome"
    assert run(Wrong(), "computeOutcome", oc).error == "outcome_not_allowed"


def test_pinned_adapter_version_must_be_installed():
    class Fine(Adapter):
        pass
    c = base(OpenContext, module=dict(MOD, adapter={"key": "t.adapter", "version": "2.0.0", "hooks": []}))
    r = run(Fine(), "beforeOpen", c)
    assert not r.ok and r.error == "adapter_missing" and "v3" in r.message


def test_install_rejects_bad_descriptors():
    h = AdapterHost()
    with pytest.raises(ContractViolation):
        h.install(Descriptor(key="a", version="1.0.0", hooks=("afterDelete",), namespace="a"), Adapter())
    with pytest.raises(ContractViolation):
        h.install(Descriptor(key="a", version="1.0.0", hooks=(), namespace="a", emits=("bd.x",)), Adapter())
    with pytest.raises(ContractViolation):
        h.install(Descriptor(key="a", version="1.0.0", hooks=(), namespace="a", commands=("approve_stage",)), Adapter())


def test_actor_exposes_no_roles():
    assert not any("role" in f for f in Actor.__dataclass_fields__)
