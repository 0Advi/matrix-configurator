#!/usr/bin/env python3
"""Spike: run the generated finance_ca BPMN in SpiffWorkflow 3.2.0 (LGPL-3.0, used as an unmodified pip dep).

    python3 -m venv .venv && .venv/bin/pip install SpiffWorkflow==3.2.0
    .venv/bin/python run_spiff.py
Path: start -> executive submits -> supervisor SENDS BACK -> executive resubmits -> supervisor approves
      -> admin approves -> end. Also serializes the running workflow to JSON midway (what you'd store per case).
"""
import json
import os
import re
import subprocess
import sys
import tempfile

from SpiffWorkflow.bpmn.serializer import BpmnWorkflowSerializer
from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.camunda.parser import CamundaParser
from SpiffWorkflow.camunda.serializer import DEFAULT_CONFIG
from SpiffWorkflow.util.task import TaskState

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, "..", "operaton", "manifest_to_bpmn.py")

xml = subprocess.run([sys.executable, GEN, "finance_ca", "--ns", "camunda"], capture_output=True, text=True, check=True).stdout
# Finding: Camunda/Operaton conditions are JUEL (${...}); SpiffWorkflow evaluates Python expressions.
xml = re.sub(r"<!\[CDATA\[\$\{(.*?)\}\]\]>", r"<![CDATA[\1]]>", xml)
path = os.path.join(tempfile.mkdtemp(), "finance_ca.bpmn")
with open(path, "w", encoding="utf-8") as fh:
    fh.write(xml)

parser = CamundaParser()
parser.add_bpmn_file(path)
wf = BpmnWorkflow(parser.get_spec("finance_ca"))
wf.do_engine_steps()
serializer = BpmnWorkflowSerializer(BpmnWorkflowSerializer.configure(DEFAULT_CONFIG))
trace = []


def step(expected_group, data):
    global wf
    ready = wf.get_tasks(state=TaskState.READY, manual=True)
    assert len(ready) == 1, ready
    t = ready[0]
    group = t.task_spec.extensions.get("candidateGroups") if hasattr(t.task_spec, "extensions") else None
    fields = [f.id for f in getattr(t.task_spec, "form", None).fields] if getattr(t.task_spec, "form", None) else []
    trace.append({"task": t.task_spec.bpmn_id, "name": t.task_spec.bpmn_name, "fields": fields, "data_in": data})
    t.data.update(data)
    t.run()
    wf.do_engine_steps()
    # round-trip through JSON like a per-case DB row would
    blob = serializer.serialize_json(wf)
    wf = serializer.deserialize_json(blob)
    return len(blob)


sizes = [
    step("executive", {"kyc_verified": True, "ca_code": "CA-1", "finance_amount": 100000}),
    step("supervisor", {"decision": "send_back"}),
    step("executive", {"kyc_verified": True, "ca_code": "CA-1b", "finance_amount": 90000}),
    step("supervisor", {"decision": "approve"}),
    step("business_admin", {"decision": "approve"}),
]
print(json.dumps({"completed": wf.is_completed(), "trace": [t["task"] for t in trace],
                  "first_task_fields": trace[0]["fields"], "serialized_bytes_per_step": sizes,
                  "final_data": {k: v for k, v in wf.last_task.data.items()} if wf.last_task else None}, indent=1))
assert wf.is_completed()
assert [t["task"] for t in trace] == ["s1_0_executive", "s2_0_supervisor", "s1_0_executive", "s2_0_supervisor", "s3_0_business_admin"]
print("SPIFF OK")
