#!/usr/bin/env bash
# Operaton spike — deploy the generated finance_ca BPMN, start an instance, complete user tasks via REST
# (incl. a send-back), read history, tear down. Loopback only, port 18080, container removed at the end.
# STATUS 2026-10-04 07:08: EXECUTED, "SPIKE OK" (log: spike-run-2026-10-04.log). A first attempt at 01:34 was
# blocked by a wedged Docker daemon; see docs/oss/OPERATON-SPIKE.md. Uses the Camunda-7-compatible REST API.
set -euo pipefail
cd "$(dirname "$0")"
IMG=operaton/operaton:2.1.5        # Apache-2.0; digest seen 2026-10-04: sha256:ed5d6863…6892 (815 MB unpacked)
NAME=f3-operaton-spike
BASE=http://127.0.0.1:18080/engine-rest
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

python3 manifest_to_bpmn.py finance_ca --ns operaton > finance_ca.operaton.bpmn
docker run -d --name "$NAME" -p 127.0.0.1:18080:8080 "$IMG" >/dev/null
t0=$(date +%s)
until curl -sf -m 3 "$BASE/engine" >/dev/null; do
  sleep 2; [ $(( $(date +%s) - t0 )) -lt 240 ] || { echo "engine did not come up"; docker logs --tail 50 "$NAME"; exit 1; }
done
echo "engine up after $(( $(date +%s) - t0 ))s: $(curl -s "$BASE/version")"
docker stats --no-stream --format 'memory {{.MemUsage}}' "$NAME"

dep=$(curl -sf -X POST "$BASE/deployment/create" -F deployment-name=matrix-finance-ca -F deploy-changed-only=true \
      -F "finance_ca.bpmn=@finance_ca.operaton.bpmn")
echo "deployed: $(echo "$dep" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"], list((d.get("deployedProcessDefinitions") or {}).keys()))')"

pi=$(curl -sf -X POST "$BASE/process-definition/key/finance_ca/start" -H 'Content-Type: application/json' \
     -d '{"businessKey":"site-1","variables":{"site":{"value":"site-1","type":"String"}}}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "instance: $pi"

complete() {  # $1 expected task definition key, $2 JSON variables
  local task key
  task=$(curl -sf "$BASE/task?processInstanceId=$pi")
  key=$(echo "$task" | python3 -c 'import json,sys; t=json.load(sys.stdin); print(t[0]["taskDefinitionKey"] if t else "-")')
  [ "$key" = "$1" ] || { echo "expected $1, got $key"; exit 1; }
  id=$(echo "$task" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
  curl -sf -X POST "$BASE/task/$id/complete" -H 'Content-Type: application/json' -d "{\"variables\":$2}" >/dev/null
  echo "completed $key"
}
complete s1_0_executive '{"kyc_verified":{"value":true,"type":"Boolean"},"ca_code":{"value":"CA-1","type":"String"},"finance_amount":{"value":100000,"type":"Long"}}'
complete s2_0_supervisor '{"decision":{"value":"send_back","type":"String"}}'
complete s1_0_executive '{"kyc_verified":{"value":true,"type":"Boolean"},"ca_code":{"value":"CA-1b","type":"String"},"finance_amount":{"value":90000,"type":"Long"}}'
complete s2_0_supervisor '{"decision":{"value":"approve","type":"String"}}'
complete s3_0_business_admin '{"decision":{"value":"approve","type":"String"}}'

curl -sf "$BASE/history/process-instance/$pi" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("history:", d["state"], d.get("durationInMillis"), "ms")'
curl -sf "$BASE/history/activity-instance?processInstanceId=$pi&sortBy=startTime&sortOrder=asc" \
  | python3 -c 'import json,sys; print(" > ".join(a["activityId"] for a in json.load(sys.stdin) if a["activityType"]=="userTask"))'
echo "SPIKE OK"
