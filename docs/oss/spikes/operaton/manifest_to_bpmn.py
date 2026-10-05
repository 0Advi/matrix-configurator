#!/usr/bin/env python3
"""Spike helper: one manifest module -> executable BPMN 2.0 (Operaton / Camunda-7 dialect).

Usage: python3 manifest_to_bpmn.py <module_key> [--ns operaton|camunda] > out.bpmn
Reads building-blocks/from-matrix-bd/matrix-bd-flow.json. Mapping (same rules as the in-app runtime):
  stage x tier chain (executive < supervisor < business_admin) -> one userTask per step, candidateGroups = role;
  the first step of a stage carries the stage fields as formData;
  every step after the first -> exclusiveGateway: decision == 'send_back' -> previous step, otherwise forward;
  terminal stage -> endEvent. Entry gates are NOT inside the module process (cross-module = orchestration).
"""
import json
import os
import sys
from xml.sax.saxutils import quoteattr

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
TIER = {"executive": 0, "supervisor": 1, "business_admin": 2}
NS = {"operaton": "http://operaton.org/schema/1.0/bpmn", "camunda": "http://camunda.org/schema/1.0/bpmn"}
KIND = {"number": "long", "yesno": "boolean", "date": "date"}


def chain(stage):
    return sorted(set(stage.get("approvers") or ["supervisor"]), key=lambda r: TIER.get(r, 1))


def build(module, ns="operaton"):
    p = ns  # attribute prefix
    steps = []
    for st in sorted(module["stages"], key=lambda s: s["order"]):
        for i, role in enumerate(chain(st)):
            steps.append({"id": f"s{st['order']}_{i}_{role}", "stage": st, "role": role, "first": i == 0})
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" '
           f'xmlns:{p}="{NS[ns]}" targetNamespace="urn:matrix:{module["key"]}" id="defs_{module["key"]}">',
           f'  <process id="{module["key"]}" name={quoteattr(module["name"])} isExecutable="true" '
           f'{p}:historyTimeToLive="P180D">',
           '    <startEvent id="start"/>']
    flows = []
    prev = "start"
    for idx, s in enumerate(steps):
        st = s["stage"]
        out.append(f'    <userTask id="{s["id"]}" name={quoteattr(st["name"] + " · " + s["role"])} '
                   f'{p}:candidateGroups="{s["role"]}">')
        if s["first"] and st["fields"]:
            out.append(f'      <extensionElements><{p}:formData>')
            for f in st["fields"]:
                typ = KIND.get(f["kind"], "string")
                req = f'<{p}:validation><{p}:constraint name="required"/></{p}:validation>' if f["required"] else ""
                out.append(f'        <{p}:formField id="{f["key"]}" label={quoteattr(f["label"])} type="{typ}">{req}</{p}:formField>')
            out.append(f'      </{p}:formData></extensionElements>')
        out.append('    </userTask>')
        flows.append((prev, s["id"], None, None))
        if idx > 0:  # every step after the first can send back to the previous step (possibly the previous stage)
            gw = f'gw_{s["id"]}'
            out.append(f'    <exclusiveGateway id="{gw}" default="{gw}_fwd"/>')
            flows.append((s["id"], gw, None, None))
            flows.append((gw, steps[idx - 1]["id"], "${decision == 'send_back'}", f"{gw}_back"))
            prev = gw
        else:
            prev = s["id"]
    out.append('    <endEvent id="end"/>')
    flows.append((prev, "end", None, None))
    for n, (src, tgt, cond, fid) in enumerate(flows, 1):
        fid = fid or (f"{src}_fwd" if src.startswith("gw_") else f"f{n}")
        if cond:
            out.append(f'    <sequenceFlow id="{fid}" sourceRef="{src}" targetRef="{tgt}">'
                       f'<conditionExpression xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
                       f'xsi:type="tFormalExpression"><![CDATA[{cond}]]></conditionExpression></sequenceFlow>')
        else:
            out.append(f'    <sequenceFlow id="{fid}" sourceRef="{src}" targetRef="{tgt}"/>')
    out += ['  </process>', '</definitions>']
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) > 1 else "finance_ca"
    ns = sys.argv[sys.argv.index("--ns") + 1] if "--ns" in sys.argv else "operaton"
    with open(os.path.join(ROOT, "building-blocks", "from-matrix-bd", "matrix-bd-flow.json"), encoding="utf-8") as fh:
        flow = json.load(fh)
    mod = next(m for m in flow["modules"] if m["key"] == key)
    sys.stdout.write(build(mod, ns))
