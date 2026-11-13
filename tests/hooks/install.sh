#!/usr/bin/env bash
# Tests for hooks/bridge-install.sh (setup steps and the join). Needs bash, curl, jq and node 22.
# No network: the only server is the local fake bridge (tests/hooks/fake-bridge.mjs).
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
INSTALL="$ROOT/hooks/bridge-install.sh"
BASH_BIN="$(command -v bash)"
WORK="$(mktemp -d)"
FAKE_PID=""
DEF_PID=""
PRESET=1
FAILS=0
unset BRIDGE_KEY   # a developer's own key must not leak into the cases

stop_fake() {
  if [ -n "$FAKE_PID" ]; then
    kill "$FAKE_PID" 2>/dev/null
    wait "$FAKE_PID" 2>/dev/null
    FAKE_PID=""
  fi
}
cleanup() {
  stop_fake
  [ -n "$DEF_PID" ] && { kill "$DEF_PID" 2>/dev/null; wait "$DEF_PID" 2>/dev/null; }
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; FAILS=$((FAILS + 1)); }
check() { if [ "$2" = 0 ]; then pass "$1"; else fail "$1" "$3"; fi; }

new_case() {
  T="$(mktemp -d "$WORK/case.XXXXXX")"
  CFG="$T/cfg"
  DIR="$CFG/discord-bridge"
}

# start_fake <script-json> [portfile]: starts a fake bridge; sets FAKE_PORT (and $T/log.jsonl).
start_fake() {
  printf '%s' "$1" > "$T/script.json"; : > "$T/log.jsonl"; rm -f "$T/port"
  node "$HERE/fake-bridge.mjs" "$T/script.json" "$T/log.jsonl" "$T/port" &
  FAKE_PID=$!
  i=0
  while [ ! -s "$T/port" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
  FAKE_PORT="$(cat "$T/port")"
}

# The default server answers "already joined" (self 200) for tests that only exercise setup.
mkdir -p "$WORK/def"
echo '{}' > "$WORK/def/script.json"; : > "$WORK/def/log.jsonl"
node "$HERE/fake-bridge.mjs" "$WORK/def/script.json" "$WORK/def/log.jsonl" "$WORK/def/port" &
DEF_PID=$!
i=0
while [ ! -s "$WORK/def/port" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
DEF_URL="http://127.0.0.1:$(cat "$WORK/def/port")"

# run_install [VAR=value ...] -- [args]; sets OUT, RC. URL defaults to a non-network https URL.
run_install() {
  envs=""
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs="$envs $1"; shift; done
  [ "$#" -gt 0 ] && shift
  # Setup-only tests start from a joined machine (a key in config.env), so the join is skipped.
  if [ "$PRESET" = 1 ] && [ ! -e "$DIR/config.env" ]; then
    case " $* $envs " in *" --dry-run "*|*" BRIDGE_URL="*) ;; *) mkdir -p "$DIR"; printf 'BRIDGE_KEY=PRESETKEY\n' > "$DIR/config.env" ;; esac
  fi
  # shellcheck disable=SC2086
  env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" BRIDGE_URL=$DEF_URL $envs \
    "$BASH_BIN" "$INSTALL" "$@" > "$T/out" 2>&1 < /dev/null
  RC=$?
  OUT="$(cat "$T/out")"
}

# tools_without <tool>: a PATH dir holding the tools the script needs, minus one.
tools_without() {
  mkdir -p "$T/bin"
  for t in curl jq dirname basename cat tr sed cut mktemp rm cmp cp chmod mv date hostname uname mkdir grep head sort; do
    [ "$t" = "$1" ] && continue
    p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$T/bin/$t"
  done
}

# --- basics ---
new_case
tools_without jq
run_install PATH="$T/bin" --
check "missing jq is a setup problem" "$([ "$RC" = 2 ] && printf '%s' "$OUT" | grep -q jq; echo $?)" "rc=$RC out=$OUT"

new_case
tools_without curl
run_install PATH="$T/bin" --
check "missing curl is a setup problem" "$([ "$RC" = 2 ] && printf '%s' "$OUT" | grep -q curl; echo $?)" "rc=$RC out=$OUT"

new_case
run_install BRIDGE_URL=http://example.com --
check "plain http is refused" "$([ "$RC" = 2 ] && [ ! -e "$DIR" ]; echo $?)" "rc=$RC out=$OUT"

new_case
run_install --
check "loopback http passes the url check" "$([ "$RC" = 0 ]; echo $?)" "rc=$RC out=$OUT"

new_case
run_install BRIDGE_URL= --
check "missing url is a setup problem" "$([ "$RC" = 2 ] && printf '%s' "$OUT" | grep -q BRIDGE_URL; echo $?)" "rc=$RC out=$OUT"

# --- hook copy ---
new_case
run_install --
check "hook is copied" "$([ "$RC" = 0 ] && cmp -s "$ROOT/hooks/bridge-hook.sh" "$DIR/bridge-hook.sh" && [ "$(stat -c %a "$DIR/bridge-hook.sh" 2>/dev/null || stat -f %Lp "$DIR/bridge-hook.sh")" = 755 ]; echo $?)" "rc=$RC out=$OUT"

new_case
mkdir -p "$DIR"; echo old > "$DIR/bridge-hook.sh"
run_install --
nbak="$(ls "$DIR" | grep -c '^bridge-hook.sh.bak-')"
check "changed hook keeps a backup" "$([ "$RC" = 0 ] && [ "$nbak" = 1 ] && cmp -s "$ROOT/hooks/bridge-hook.sh" "$DIR/bridge-hook.sh"; echo $?)" "rc=$RC nbak=$nbak"

# --- settings merge ---
new_case
mkdir -p "$CFG"
cat > "$CFG/settings.json" <<'JSON'
{"theme":"dark","env":{"CLAUDE_CODE_STOP_HOOK_BLOCK_CAP":"5","MINE":"1"},
 "hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]},
   {"hooks":[{"type":"command","command":"bash \"/old/discord-bridge/bridge-hook.sh\" stop"}]}]}}
JSON
run_install --
ok=1
jq -e '.theme=="dark" and .env.MINE=="1" and .env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=="5"
  and ([.hooks.Stop[].hooks[].command] | map(select(. == "echo mine")) | length) == 1
  and ([.hooks.Stop[].hooks[].command] | map(select(contains("/old/"))) | length) == 0
  and ([.hooks.Stop[].hooks[].command] | map(select(contains("discord-bridge/bridge-hook.sh"))) | length) == 2
  and (.hooks.PermissionRequest | length) == 1 and (.hooks.Notification | length) == 1' "$CFG/settings.json" >/dev/null 2>&1 && ok=0
nbak="$(ls "$CFG" | grep -c '^settings.json.bak-')"
check "settings merge keeps other hooks" "$([ "$RC" = 0 ] && [ "$ok" = 0 ] && [ "$nbak" = 1 ]; echo $?)" "rc=$RC ok=$ok nbak=$nbak"

new_case
run_install --
check "missing settings.json is created without a backup" "$([ "$RC" = 0 ] && jq -e '.hooks.Stop' "$CFG/settings.json" >/dev/null 2>&1 && [ "$(ls "$CFG" | grep -c '\.bak-')" = 0 ]; echo $?)" "rc=$RC"

new_case
run_install --
a="$(cksum < "$CFG/settings.json")"; n1="$(find "$CFG" -name '*.bak-*' | wc -l | tr -d ' ')"
run_install --
b="$(cksum < "$CFG/settings.json")"; n2="$(find "$CFG" -name '*.bak-*' | wc -l | tr -d ' ')"
check "second run changes nothing" "$([ "$RC" = 0 ] && [ "$a" = "$b" ] && [ "$n1" = "$n2" ]; echo $?)" "rc=$RC n1=$n1 n2=$n2"

new_case
mkdir -p "$CFG"; echo '{broken' > "$CFG/settings.json"
run_install --
check "unreadable settings.json is a setup problem" "$([ "$RC" = 2 ] && [ "$(cat "$CFG/settings.json")" = '{broken' ]; echo $?)" "rc=$RC out=$OUT"

# --- dry run ---
new_case
start_fake '{}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_MACHINE=testbox -- --dry-run
nwould="$(printf '%s\n' "$OUT" | grep -c '^would ')"
check "dry run writes nothing" "$([ "$RC" = 0 ] && [ ! -e "$CFG" ] && [ "$nwould" -ge 3 ] && printf '%s' "$OUT" | grep -q '^would join as testbox' && [ ! -s "$T/log.jsonl" ]; echo $?)" "rc=$RC would=$nwould out=$OUT log=$(cat "$T/log.jsonl")"
stop_fake

new_case
run_install -- --dry-run --machine "café✓"
check "name is cleaned to ascii" "$([ "$RC" = 0 ] && printf '%s\n' "$OUT" | grep -qx 'would join as caf'; echo $?)" "rc=$RC out=$OUT"

new_case
run_install BRIDGE_MACHINE=envbox -- --dry-run --machine flagbox
check "--machine overrides the environment" "$([ "$RC" = 0 ] && printf '%s\n' "$OUT" | grep -qx 'would join as flagbox'; echo $?)" "rc=$RC out=$OUT"

# --- settings write keeps a symlink and its mode ---
new_case
mkdir -p "$CFG" "$T/real"
echo '{"theme":"dark"}' > "$T/real/settings.json"; chmod 640 "$T/real/settings.json"
ln -s "$T/real/settings.json" "$CFG/settings.json"
run_install --
mode="$(stat -c %a "$T/real/settings.json" 2>/dev/null || stat -f %Lp "$T/real/settings.json")"
check "settings write keeps a symlink and its mode" "$([ "$RC" = 0 ] && [ -L "$CFG/settings.json" ] && [ "$mode" = 640 ] && jq -e '.theme=="dark" and .hooks.Stop' "$T/real/settings.json" >/dev/null 2>&1; echo $?)" "rc=$RC mode=$mode"

# --- joining ---
PRESET=0
KEYV="9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a9f3a"   # 64 lowercase hex
SECV="7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d"
J_OK="{\"status\":201,\"body\":{\"id\":\"j1\",\"code\":\"ABC-234\",\"secret\":\"$SECV\"}}"
logcount() { jq -s "[.[] | select($1)] | length" "$T/log.jsonl"; }
# join_case <script-json> [VAR=value ...]: fresh case, fake server, one install run (stops the fake).
join_case() {
  new_case
  start_fake "$1"; shift
  run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 "$@" --
  stop_fake
}
SELF401='"self":{"status":401,"body":{"error":"unauthorized"}}'

new_case
mkdir -p "$DIR"; printf 'BRIDGE_KEY=GOODKEY\n' > "$DIR/config.env"
start_fake '{"self":{"status":200,"body":{"name":"testbox"}}}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" --
stop_fake
check "already joined skips the join" "$([ "$RC" = 0 ] && [ "$(logcount '.method=="POST"')" = 0 ] && printf '%s' "$OUT" | grep -qi 'already joined'; echo $?)" "rc=$RC out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=ADMINKEY\n' > "$DIR/config.env"
start_fake "{\"self\":{\"status\":401,\"body\":{\"error\":\"unauthorized\"}},\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"denied\"}}]}"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
stop_fake
# The Worker no longer knows the shared admin key: it is a dead key like any other, set aside.
check "old shared key is set aside and the machine joins" "$([ "$RC" = 3 ] && [ ! -e "$DIR/config.env" ] && ls "$DIR"/config.env.bak-* >/dev/null 2>&1 && grep -qx 'BRIDGE_KEY=ADMINKEY' "$DIR"/config.env.bak-* && [ "$(logcount '.method=="POST" and .path=="/api/enroll"')" = 1 ]; echo $?)" "rc=$RC ls=$(ls "$DIR") out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=ADMINKEY\n' > "$DIR/config.env"
cp "$DIR/config.env" "$T/before.env"
start_fake '{"self":{"status":409,"body":{"shared":true}}}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" --
stop_fake
# Only a Worker from before the admin key was removed answers 409: an unexpected answer, so nothing changes.
check "a 409 from an older Worker leaves config.env alone" "$([ "$RC" = 3 ] && cmp -s "$DIR/config.env" "$T/before.env" && [ "$(logcount '.method=="POST"')" = 0 ] && printf '%s' "$OUT" | grep -q 'answered 409'; echo $?)" "rc=$RC out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=OLDKEY\n' > "$DIR/config.env"
start_fake "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"denied\"}}]}"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
stop_fake
bak="$(ls "$DIR" | grep '^config.env.bak-')"
check "removed key rejoins" "$([ "$RC" = 3 ] && [ ! -e "$DIR/config.env" ] && [ -n "$bak" ] && grep -q OLDKEY "$DIR/$bak" && [ "$(logcount '.method=="POST" and .path=="/api/enroll"')" = 1 ]; echo $?)" "rc=$RC ls=$(ls "$DIR") out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=OLDKEY\n' > "$DIR/config.env"
start_fake '{"self":{"status":503,"body":{}}}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" --
stop_fake
check "worker unreachable keeps config" "$([ "$RC" = 3 ] && grep -q OLDKEY "$DIR/config.env" && [ "$(ls "$DIR" | grep -c 'config.env')" = 1 ] && printf '%s' "$OUT" | grep -q 'answered 503'; echo $?)" "rc=$RC out=$OUT"

new_case
run_install BRIDGE_URL=http://127.0.0.1:1 --
check "no answer at all exits 3" "$([ "$RC" = 3 ]; echo $?)" "rc=$RC out=$OUT"

# approved: pending, then approved with a key
new_case
# no config.env yet, so the only self check is the confirmation after approval.
start_fake "{\"self\":{\"status\":200,\"body\":{\"name\":\"testbox\"}},\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"pending\"}},{\"status\":200,\"body\":{\"status\":\"approved\",\"key\":\"$KEYV\"}}]}"
( while :; do ps -eo args 2>/dev/null; sleep 0.05; done > "$T/ps.txt" ) &
PSPID=$!
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
kill "$PSPID" 2>/dev/null; wait "$PSPID" 2>/dev/null
stop_fake
cmode="$(stat -c %a "$DIR/config.env" 2>/dev/null || stat -f %Lp "$DIR/config.env")"
nself="$(jq -s '[.[] | select(.method=="GET" and .path=="/api/machines/self")] | length' "$T/log.jsonl")"
check "approved writes config" "$([ "$RC" = 0 ] && [ "$cmode" = 600 ] && [ "$(cat "$DIR/config.env")" = "BRIDGE_URL=http://127.0.0.1:$FAKE_PORT
BRIDGE_KEY=$KEYV" ] && [ "$nself" = 1 ]; echo $?)" "rc=$RC mode=$cmode nself=$nself cfg=$(cat "$DIR/config.env" 2>&1) out=$OUT"
check "prompt line is printed" "$(printf '%s\n' "$OUT" | grep -qx 'Approve "'"$(hostname -s 2>/dev/null || uname -n)"'" in Discord. Code: ABC-234' || printf '%s\n' "$OUT" | grep -q '^Approve ".*" in Discord. Code: ABC-234$'; echo $?)" "out=$OUT"
leak=0
for v in "$KEYV" "$SECV"; do
  grep -q "$v" "$T/out" && leak=1
  grep -q "$v" "$T/ps.txt" && leak=1
  grep -q "$v" "$T/log.jsonl" && leak=1
done
check "key and secret never printed" "$leak" "leaked; out=$OUT"
check "bearer presence is logged" "$([ "$(logcount '(.path|startswith("/api/enroll/")) and .method=="GET" and .bearer==true')" -ge 1 ]; echo $?)" "log=$(cat "$T/log.jsonl")"

for st in denied expired cancelled removed; do
  join_case "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"$st\"}}]}"
  check "$st exits 3" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -qi "$st" && [ ! -e "$DIR/config.env" ]; echo $?)" "rc=$RC out=$OUT"
done

join_case "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"delivered\"}}]}"
check "delivered without key says remove the stale entry" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -q '/machines'; echo $?)" "rc=$RC out=$OUT"

join_case "{$SELF401,\"enroll\":{\"status\":429,\"body\":{}}}"
check "busy says when to try again" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -q 'too many joins are waiting; try again'; echo $?)" "rc=$RC out=$OUT"

join_case "{$SELF401,\"enroll\":{\"status\":502,\"body\":{}}}"
check "refused DM names Deploy step 4 and wrangler tail, 50007 only as an example" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -q 'Deploy the Worker" step 4' && printf '%s' "$OUT" | grep -q 'wrangler tail' && printf '%s' "$OUT" | grep -q '50007 means' && ! printf '%s' "$OUT" | grep -q 'code 50007'; echo $?)" "rc=$RC out=$OUT"

join_case "{$SELF401,\"enroll\":{\"status\":400,\"body\":{}}}"
check "bad name is a setup problem" "$([ "$RC" = 2 ]; echo $?)" "rc=$RC out=$OUT"

join_case "{$SELF401,\"enroll\":{\"status\":500,\"body\":{}}}"
check "enroll 5xx exits 3" "$([ "$RC" = 3 ]; echo $?)" "rc=$RC out=$OUT"

# transient answers while polling are retried
join_case "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":404,\"body\":{}},{\"status\":503,\"body\":{}},{\"status\":200,\"body\":{\"status\":\"denied\"}}]}"
check "404 and 5xx while polling are retried" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -qi denied; echo $?)" "rc=$RC out=$OUT"

# approved but the confirmation fails
new_case
start_fake "{\"self\":[{\"status\":401,\"body\":{}},{\"status\":401,\"body\":{}}],\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"approved\",\"key\":\"$KEYV\"}}]}"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
stop_fake
check "unconfirmed key keeps config and exits 3" "$([ "$RC" = 3 ] && grep -q "BRIDGE_KEY=$KEYV" "$DIR/config.env" && printf '%s' "$OUT" | grep -qi 'confirm' && ! grep -q "$KEYV" "$T/out"; echo $?)" "rc=$RC out=$OUT"

# timeout and notices
t0="$(date +%s)"
join_case "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"pending\"}}]}" BRIDGE_JOIN_TIMEOUT=4
t1="$(date +%s)"
check "timeout ends the wait" "$([ "$RC" = 3 ] && [ $((t1 - t0)) -le 8 ]; echo $?)" "rc=$RC secs=$((t1 - t0)) out=$OUT"

join_case "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"pending\"}}]}" BRIDGE_JOIN_TIMEOUT=5 BRIDGE_WAIT_NOTICE=2
check "still waiting lines appear" "$(printf '%s' "$OUT" | grep -qi 'still waiting'; echo $?)" "rc=$RC out=$OUT"

# ctrl-c / TERM cancels the join
new_case
start_fake "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"pending\"}}]}"
env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 \
  "$BASH_BIN" "$INSTALL" > "$T/out" 2>&1 < /dev/null &
IPID=$!
i=0
while ! grep -q '^Approve' "$T/out" 2>/dev/null && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
kill -TERM "$IPID" 2>/dev/null
wait "$IPID"; RC=$?
stop_fake
check "ctrl-c cancels the join" "$([ "$RC" = 3 ] && [ "$(logcount '.method=="DELETE" and .path=="/api/enroll/j1"')" = 1 ]; echo $?)" "rc=$RC log=$(cat "$T/log.jsonl")"

# empty key counts as no key
new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=\n' > "$DIR/config.env"
start_fake "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"denied\"}}]}"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
stop_fake
check "empty key in config joins" "$([ "$RC" = 3 ] && [ "$(logcount '.path=="/api/machines/self"')" = 0 ] && [ "$(logcount '.path=="/api/enroll" and .method=="POST"')" = 1 ]; echo $?)" "rc=$RC out=$OUT"

# --- leave ---
new_case
mkdir -p "$CFG"
cat > "$CFG/settings.json" <<'JSON'
{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}
JSON
cp "$CFG/settings.json" "$T/orig.json"
start_fake '{}'
mkdir -p "$DIR"; printf 'BRIDGE_URL=http://127.0.0.1:%s\nBRIDGE_KEY=LEAVEKEY\n' "$FAKE_PORT" > "$DIR/config.env"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" --
inst_rc=$RC
run_install BRIDGE_URL= -- --leave
nbak="$(ls "$CFG" | grep -c '^settings.json.bak-')"
stop_fake
check "leave undoes the install" "$([ "$inst_rc" = 0 ] && [ "$RC" = 0 ] \
  && [ "$(jq -S 'del(.env)' "$CFG/settings.json")" = "$(jq -S . "$T/orig.json")" ] \
  && jq -e '.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP == "100"' "$CFG/settings.json" >/dev/null 2>&1 \
  && [ ! -e "$DIR/config.env" ] && [ ! -e "$DIR/bridge-hook.sh" ] && [ "$nbak" -ge 1 ] \
  && [ "$(logcount '.method=="DELETE" and .path=="/api/machines/self" and .bearer==true')" = 1 ] \
  && ! grep -q LEAVEKEY "$T/out" && ! grep -q LEAVEKEY "$T/log.jsonl"; echo $?)" "inst=$inst_rc rc=$RC nbak=$nbak settings=$(cat "$CFG/settings.json") out=$OUT log=$(cat "$T/log.jsonl")"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=http://127.0.0.1:1\nBRIDGE_KEY=LEAVEKEY\n' > "$DIR/config.env"
echo '#!/bin/sh' > "$DIR/bridge-hook.sh"
run_install BRIDGE_URL= -- --leave
check "leave without a worker still cleans up" "$([ "$RC" = 0 ] && [ ! -e "$DIR/config.env" ] && [ ! -e "$DIR/bridge-hook.sh" ]; echo $?)" "rc=$RC out=$OUT"

new_case
mkdir -p "$CFG" "$DIR"
cat > "$CFG/settings.json" <<'JSON'
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/x/discord-bridge/bridge-hook.sh"}]}]}}
JSON
cp "$CFG/settings.json" "$T/orig.json"
start_fake '{}'
printf 'BRIDGE_URL=http://127.0.0.1:%s\nBRIDGE_KEY=LEAVEKEY\n' "$FAKE_PORT" > "$DIR/config.env"
echo '#!/bin/sh' > "$DIR/bridge-hook.sh"
run_install BRIDGE_URL= -- --leave --dry-run
nbak="$(ls "$CFG" | grep -c '^settings.json.bak-')"
stop_fake
check "leave --dry-run changes nothing" "$([ "$RC" = 0 ] && [ "$(cat "$CFG/settings.json")" = "$(cat "$T/orig.json")" ] \
  && [ -e "$DIR/config.env" ] && [ -e "$DIR/bridge-hook.sh" ] && [ "$nbak" = 0 ] \
  && [ "$(logcount '.method=="DELETE"')" = 0 ] && printf %s "$OUT" | grep -q 'would'; echo $?)" "rc=$RC nbak=$nbak out=$OUT log=$(cat "$T/log.jsonl")"

# --- final review fixes ---
APPROVED="{\"self\":{\"status\":200,\"body\":{\"name\":\"testbox\"}},\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"approved\",\"key\":\"$KEYV\"}}]}"
REALJQ="$(command -v jq)"
REALCURL="$(command -v curl)"

# I1: a jq that writes CRLF (a native Windows jq.exe) must not break the join.
mk_crjq() {
  mkdir -p "$T/crbin"
  printf '#!/bin/bash\n"%s" "$@" > "$0.out"; rc=$?\nawk '"'"'{ printf "%%s\\r\\n", $0 }'"'"' "$0.out"; rm -f "$0.out"\nexit $rc\n' "$REALJQ" > "$T/crbin/jq"
  chmod +x "$T/crbin/jq"
}
new_case
mk_crjq
start_fake "$APPROVED"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 PATH="$T/crbin:$PATH" --
stop_fake
check "CRLF jq output still joins" "$([ "$RC" = 0 ] && [ "$(cat "$DIR/config.env" | tr -d '\r')" = "BRIDGE_URL=http://127.0.0.1:$FAKE_PORT
BRIDGE_KEY=$KEYV" ] && ! tr -cd '\r' < "$DIR/config.env" | grep -q .; echo $?)" "rc=$RC out=$OUT cfg=$(cat "$DIR/config.env" 2>&1 | od -c | head -5)"

# S3 / M1: no secret reaches curl's environment (a curl wrapper dumps its own).
new_case
mkdir -p "$T/curlbin"
printf '#!/bin/bash\nenv >> "%s/curl-env.txt"\nexec "%s" "$@"\n' "$T" "$REALCURL" > "$T/curlbin/curl"
chmod +x "$T/curlbin/curl"
start_fake "$APPROVED"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 PATH="$T/curlbin:$PATH" TOKEN=exported-before --
stop_fake
check "secrets are not exported to curl" "$([ "$RC" = 0 ] && [ -s "$T/curl-env.txt" ] && ! grep -q "$KEYV" "$T/curl-env.txt" && ! grep -q "$SECV" "$T/curl-env.txt" && ! grep -q 'exported-before' "$T/curl-env.txt"; echo $?)" "rc=$RC out=$OUT leaked=$(grep -E "$KEYV|$SECV|exported-before" "$T/curl-env.txt" 2>&1 | cut -c1-30)"
bad="$(grep -nE '^[[:space:]]*(if |\{ )?[A-Za-z_]*(TOKEN|KEY|SECRET)=("[^"]*"|[^ ]*) +(api|curl)( |$)' "$ROOT/hooks/bridge-install.sh" "$ROOT/hooks/bridge-hook.sh")"
check "no secret prefix assignments on calls" "$([ -z "$bad" ]; echo $?)" "$bad"

# I2: BRIDGE_KEY in the environment stops the join before any network call.
new_case
start_fake '{}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_KEY=sharedkey BRIDGE_JOIN_TIMEOUT=3 --
stop_fake
check "BRIDGE_KEY in the environment exits 2 before any request" "$([ "$RC" = 2 ] && printf '%s' "$OUT" | grep -q 'BRIDGE_KEY' && printf '%s' "$OUT" | grep -qi 'unset' && [ ! -s "$T/log.jsonl" ] && [ ! -e "$DIR/bridge-hook.sh" ] && [ ! -e "$CFG/settings.json" ] && ! printf '%s' "$OUT" | grep -q sharedkey; echo $?)" "rc=$RC out=$OUT log=$(cat "$T/log.jsonl")"

new_case
start_fake '{}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_KEY=sharedkey -- --dry-run
stop_fake
check "dry run reports the environment key and exits 2" "$([ "$RC" = 2 ] && printf '%s\n' "$OUT" | grep -q '^would ' && printf '%s' "$OUT" | grep -q 'BRIDGE_KEY' && [ ! -e "$CFG" ] && [ ! -s "$T/log.jsonl" ]; echo $?)" "rc=$RC out=$OUT"

new_case
run_install BRIDGE_URL= BRIDGE_KEY=sharedkey -- --leave
check "--leave ignores the environment key" "$([ "$RC" = 0 ]; echo $?)" "rc=$RC out=$OUT"

# I2: env.BRIDGE_KEY in settings.json is dropped by the merge.
new_case
mkdir -p "$CFG"
echo '{"env":{"BRIDGE_KEY":"settingskey","MINE":"1"},"theme":"dark"}' > "$CFG/settings.json"
PRESET=1; run_install --; PRESET=0
check "settings env.BRIDGE_KEY is removed" "$([ "$RC" = 0 ] && jq -e '(.env | has("BRIDGE_KEY") | not) and .env.MINE == "1" and .theme == "dark" and .hooks.Stop' "$CFG/settings.json" >/dev/null 2>&1 && printf '%s' "$OUT" | grep -q 'env.BRIDGE_KEY' && ! printf '%s' "$OUT" | grep -q settingskey && grep -q settingskey "$CFG"/settings.json.bak-*; echo $?)" "rc=$RC out=$OUT settings=$(cat "$CFG/settings.json")"

new_case
mkdir -p "$CFG"
echo '{"env":{"BRIDGE_KEY":"settingskey"}}' > "$CFG/settings.json"
cp "$CFG/settings.json" "$T/orig.json"
run_install -- --dry-run
check "dry run reports env.BRIDGE_KEY and writes nothing" "$([ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'would remove env.BRIDGE_KEY' && cmp -s "$CFG/settings.json" "$T/orig.json" && [ "$(ls "$CFG" | wc -l | tr -d ' ')" = 1 ]; echo $?)" "rc=$RC out=$OUT"

# S4: the Worker's secret and key must be lowercase hex of the right length.
SHORT_HEX="abcdef0123456789"
bad_join() { # <name> <enroll-json> <approved-key-or-empty>
  new_case
  if [ -n "$3" ]; then gets="[{\"status\":200,\"body\":$(jq -n --arg k "$3" '{status:"approved",key:$k}')}]"; else gets='[{"status":200,"body":{"status":"denied"}}]'; fi
  start_fake "{$SELF401,\"enroll\":$2,\"enrollGets\":$gets}"
  run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 BRIDGE_JOIN_TIMEOUT=3 --
  stop_fake
  check "$1" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -q 'not understood' && [ ! -e "$DIR/config.env" ]; echo $?)" "rc=$RC out=$OUT"
}
bad_join "key with a newline is refused" "$J_OK" "$(printf '%s' "$KEYV" | cut -c1-30)
header = \"X-Evil: 1\""
bad_join "non-hex key is refused" "$J_OK" "KEYVALUE-for-test-9f3a-KEYVALUE-for-test-9f3a-KEYVALUE-for-test-9f3a"
bad_join "uppercase key is refused" "$J_OK" "$(printf '%s' "$KEYV" | tr a-f A-F)"
bad_join "short key is refused" "$J_OK" "$SHORT_HEX"
bad_join "secret with a newline is refused" "$(jq -nc --arg s "$(printf '%s' "$SECV" | cut -c1-30)
header = \"X-Evil: 1\"" '{status:201,body:{id:"j1",code:"ABC-234",secret:$s}}')" ""
bad_join "non-hex secret is refused" "$(jq -nc '{status:201,body:{id:"j1",code:"ABC-234",secret:"not-hex-secret"}}')" ""

# L4: an approval that arrives on the poll after the deadline is still collected.
new_case
start_fake "$APPROVED"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 BRIDGE_JOIN_TIMEOUT=0 --
stop_fake
check "approval on the last poll after the deadline joins" "$([ "$RC" = 0 ] && grep -q "BRIDGE_KEY=$KEYV" "$DIR/config.env"; echo $?)" "rc=$RC out=$OUT"
join_case "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"pending\"}}]}" BRIDGE_JOIN_TIMEOUT=0
check "deadline with no approval polls once, then gives up" "$([ "$RC" = 3 ] && printf '%s' "$OUT" | grep -qi 'timed out' && [ "$(logcount '.method=="GET" and (.path|startswith("/api/enroll/"))')" = 1 ]; echo $?)" "rc=$RC out=$OUT"

# M2: --machine needs a name.
new_case
start_fake '{}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" -- --machine
r1=$RC; o1="$OUT"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_TIMEOUT=3 -- --machine --dry-run
stop_fake
check "--machine without a name exits 2" "$([ "$r1" = 2 ] && printf '%s' "$o1" | grep -q -- '--machine needs a name'; echo $?)" "rc=$r1 out=$o1"
check "--machine followed by an option exits 2 and writes nothing" "$([ "$RC" = 2 ] && printf '%s' "$OUT" | grep -q -- '--machine needs a name' && [ ! -e "$CFG" ] && [ ! -s "$T/log.jsonl" ]; echo $?)" "rc=$RC out=$OUT"

# M5: --leave drops an empty hooks key.
new_case
mkdir -p "$CFG"
echo '{"theme":"dark"}' > "$CFG/settings.json"
PRESET=1; run_install --; PRESET=0
i_rc=$RC
run_install BRIDGE_URL= -- --leave
check "leave drops hooks when it ends up empty" "$([ "$i_rc" = 0 ] && [ "$RC" = 0 ] && [ "$(jq -S 'del(.env)' "$CFG/settings.json")" = "$(printf '{"theme":"dark"}' | jq -S .)" ]; echo $?)" "rc=$RC settings=$(cat "$CFG/settings.json")"

# M7: already joined rewrites a stale BRIDGE_URL.
new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://old.example.com\nBRIDGE_KEY=GOODKEY\nBRIDGE_POLL_SECONDS=7\n' > "$DIR/config.env"
start_fake '{"self":{"status":200,"body":{"name":"testbox"}}}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" --
stop_fake
cmode="$(stat -c %a "$DIR/config.env" 2>/dev/null || stat -f %Lp "$DIR/config.env")"
check "already joined updates a stale BRIDGE_URL" "$([ "$RC" = 0 ] && [ "$cmode" = 600 ] && [ "$(grep -c '^BRIDGE_URL=' "$DIR/config.env")" = 1 ] && grep -qx "BRIDGE_URL=http://127.0.0.1:$FAKE_PORT" "$DIR/config.env" && grep -qx 'BRIDGE_KEY=GOODKEY' "$DIR/config.env" && grep -qx 'BRIDGE_POLL_SECONDS=7' "$DIR/config.env"; echo $?)" "rc=$RC mode=$cmode cfg=$(cat "$DIR/config.env") out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=http://127.0.0.1:PORT\nBRIDGE_KEY=GOODKEY\n' > "$DIR/config.env"
start_fake '{"self":{"status":200,"body":{"name":"testbox"}}}'
sed -i.x "s/PORT/$FAKE_PORT/" "$DIR/config.env"; rm -f "$DIR/config.env.x"
cp "$DIR/config.env" "$T/before.env"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT/" --
stop_fake
check "already joined leaves a matching BRIDGE_URL alone" "$([ "$RC" = 0 ] && cmp -s "$DIR/config.env" "$T/before.env"; echo $?)" "rc=$RC out=$OUT"

# M8: a re-join keeps the other config.env lines.
for st in 401; do
  new_case
  mkdir -p "$DIR"; printf '# mine\nBRIDGE_URL=https://old.example.com\nBRIDGE_KEY=OLDKEY\nBRIDGE_POLL_SECONDS=7\n' > "$DIR/config.env"
  SELF1='{"status":401,"body":{"error":"unauthorized"}}'
  start_fake "{\"self\":[$SELF1,{\"status\":200,\"body\":{\"name\":\"testbox\"}}],\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"approved\",\"key\":\"$KEYV\"}}]}"
  run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
  stop_fake
  check "re-join after $st keeps BRIDGE_POLL_SECONDS" "$([ "$RC" = 0 ] && grep -qx 'BRIDGE_POLL_SECONDS=7' "$DIR/config.env" && grep -qx '# mine' "$DIR/config.env" && [ "$(grep -c '^BRIDGE_KEY=' "$DIR/config.env")" = 1 ] && grep -qx "BRIDGE_KEY=$KEYV" "$DIR/config.env" && [ "$(grep -c '^BRIDGE_URL=' "$DIR/config.env")" = 1 ] && grep -qx "BRIDGE_URL=http://127.0.0.1:$FAKE_PORT" "$DIR/config.env"; echo $?)" "rc=$RC cfg=$(cat "$DIR/config.env") out=$OUT"
done

# M11: the hostname fallback and name cleaning.
new_case
mkdir -p "$T/fakebin"
printf '#!/bin/sh\nexit 1\n' > "$T/fakebin/hostname"; chmod +x "$T/fakebin/hostname"
run_install BRIDGE_MACHINE= PATH="$T/fakebin:$PATH" -- --dry-run
want="$(uname -n | LC_ALL=C tr -cd ' -~' | cut -c1-64)"
check "name falls back when hostname fails" "$([ "$RC" = 0 ] && [ -n "$want" ] && printf '%s\n' "$OUT" | grep -qx "would join as $want"; echo $?)" "rc=$RC want=$want out=$OUT"

new_case
run_install -- --dry-run --machine "✓✓"
check "a name with nothing printable becomes machine" "$([ "$RC" = 0 ] && printf '%s\n' "$OUT" | grep -qx 'would join as machine'; echo $?)" "rc=$RC out=$OUT"
new_case
long="$(printf 'abcdefghij%.0s' 1 2 3 4 5 6 7)"
run_install -- --dry-run --machine "$long"
check "a 70-character name is cut to 64" "$([ "$RC" = 0 ] && printf '%s\n' "$OUT" | grep -qx "would join as $(printf '%s' "$long" | cut -c1-64)"; echo $?)" "rc=$RC out=$OUT"
new_case
run_install -- --dry-run --machine "  x  "
check "a name is trimmed" "$([ "$RC" = 0 ] && printf '%s\n' "$OUT" | grep -qx 'would join as x'; echo $?)" "rc=$RC out=$OUT"

# M11: LF endings.
crs=0
for f in "$ROOT"/hooks/*.sh; do crs=$((crs + $(tr -cd '\r' < "$f" | wc -c))); done
check "scripts in hooks/ have no CR bytes" "$([ "$crs" = 0 ]; echo $?)" "cr bytes=$crs"

# --- Plan D task 2: install script rough edges ---
# A jq that fails when given the --leave cleaning filter (it uses map_values) and is the real jq otherwise.
mk_failjq() {
  mkdir -p "$T/failbin"
  printf '#!/bin/bash\nfor a in "$@"; do case "$a" in *map_values*) exit 5 ;; esac; done\nexec "%s" "$@"\n' "$REALJQ" > "$T/failbin/jq"
  chmod +x "$T/failbin/jq"
}
new_case
mkdir -p "$CFG" "$DIR"
cat > "$CFG/settings.json" <<'JSON'
{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/x/discord-bridge/bridge-hook.sh"}]}]}}
JSON
printf 'BRIDGE_URL=http://127.0.0.1:1\nBRIDGE_KEY=LEAVEKEY\n' > "$DIR/config.env"
echo '#!/bin/sh' > "$DIR/bridge-hook.sh"
mk_failjq
run_install BRIDGE_URL= PATH="$T/failbin:$PATH" -- --leave
check "leave survives a settings failure" "$([ "$RC" = 2 ] && [ ! -e "$DIR/config.env" ] && [ -e "$DIR/bridge-hook.sh" ] \
  && printf '%s' "$OUT" | grep -q 'settings.json' && printf '%s' "$OUT" | grep -q -e '--leave again'; echo $?)" "rc=$RC ls=$(ls "$DIR") out=$OUT"

new_case
start_fake '{"selfDelete":{"status":401,"body":{"error":"unauthorized"}}}'
mkdir -p "$DIR"; printf 'BRIDGE_URL=http://127.0.0.1:%s\nBRIDGE_KEY=ADMINKEY\n' "$FAKE_PORT" > "$DIR/config.env"
run_install BRIDGE_URL= -- --leave
stop_fake
check "leave with a refused key explains the 401" "$([ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'did not accept this key' && printf '%s' "$OUT" | grep -q 'already removed'; echo $?)" "rc=$RC out=$OUT"

new_case
start_fake '{"selfDelete":{"status":503,"body":{}}}'
mkdir -p "$DIR"; printf 'BRIDGE_URL=http://127.0.0.1:%s\nBRIDGE_KEY=SOMEKEY\n' "$FAKE_PORT" > "$DIR/config.env"
run_install BRIDGE_URL= -- --leave
stop_fake
check "leave says the Worker answered when it did" "$([ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'Worker answered 503' && ! printf '%s' "$OUT" | grep -q 'could not reach'; echo $?)" "rc=$RC out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=OLDKEY\n' > "$DIR/config.env"
start_fake '{"self":{"status":403,"body":{}}}'
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" --
stop_fake
check "key check other answers say so" "$([ "$RC" = 3 ] && grep -q OLDKEY "$DIR/config.env" && printf '%s' "$OUT" | grep -q 'answered 403' && ! printf '%s' "$OUT" | grep -q 'could not reach'; echo $?)" "rc=$RC out=$OUT"

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=OLDKEY\n' > "$DIR/config.env"
run_install BRIDGE_URL=http://127.0.0.1:1 --
check "key check with no answer says could not reach" "$([ "$RC" = 3 ] && grep -q OLDKEY "$DIR/config.env" && printf '%s' "$OUT" | grep -q 'could not reach'; echo $?)" "rc=$RC out=$OUT"

PRESET=1
new_case
run_install --
first_rc=$RC
run_install -- --dry-run
check "dry run with nothing to change" "$([ "$first_rc" = 0 ] && [ "$RC" = 0 ] && ! printf '%s' "$OUT" | grep -q 'would copy' && ! printf '%s' "$OUT" | grep -q 'would merge'; echo $?)" "first=$first_rc rc=$RC out=$OUT"

# INT and HUP cancel the join like TERM (job control gives the background run default signal handling).
for sig in INT HUP; do
  new_case
  start_fake "{$SELF401,\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"pending\"}}]}"
  set -m
  env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 \
    "$BASH_BIN" "$INSTALL" > "$T/out" 2>&1 < /dev/null &
  IPID=$!
  set +m
  i=0
  while ! grep -q '^Approve' "$T/out" 2>/dev/null && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
  kill -"$sig" "$IPID" 2>/dev/null
  wait "$IPID"; RC=$?
  stop_fake
  check "$sig during the join cancels" "$([ "$RC" = 3 ] && [ "$(logcount '.method=="DELETE" and .path=="/api/enroll/j1"')" = 1 ] && grep -q 'cancelled' "$T/out"; echo $?)" "rc=$RC log=$(cat "$T/log.jsonl") out=$(cat "$T/out")"
done

new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=https://x.example.com\nBRIDGE_KEY=OLDKEY\n' > "$DIR/config.env"
start_fake "{\"self\":[{\"status\":401,\"body\":{}},{\"status\":200,\"body\":{\"name\":\"testbox\"}}],\"enroll\":$J_OK,\"enrollGets\":[{\"status\":200,\"body\":{\"status\":\"approved\",\"key\":\"$KEYV\"}}]}"
run_install BRIDGE_URL="http://127.0.0.1:$FAKE_PORT" BRIDGE_JOIN_POLL=0.2 --
stop_fake
check "key check and poll send the bearer" "$([ "$RC" = 0 ] && [ "$(logcount '.method=="GET" and .path=="/api/machines/self" and .bearer==true')" = 2 ] && [ "$(logcount '.method=="GET" and .path=="/api/enroll/j1" and .bearer==true')" -ge 1 ]; echo $?)" "rc=$RC log=$(cat "$T/log.jsonl")"

new_case
run_install --
smode="$(stat -c %a "$CFG/settings.json" 2>/dev/null || stat -f %Lp "$CFG/settings.json")"
check "new settings.json is mode 600" "$([ "$RC" = 0 ] && [ "$smode" = 600 ]; echo $?)" "rc=$RC mode=$smode"

PRESET=0
new_case
mkdir -p "$CFG"; echo '{"theme":"dark"}' > "$CFG/settings.json"
run_install BRIDGE_URL= -- --leave
check "leave with config missing" "$([ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'nothing to tell the Worker'; echo $?)" "rc=$RC out=$OUT"
new_case
mkdir -p "$DIR"; printf 'BRIDGE_URL=http://127.0.0.1:1\nBRIDGE_KEY=LEAVEKEY\n' > "$DIR/config.env"
run_install BRIDGE_URL= -- --leave
check "leave with settings missing" "$([ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'no hooks to remove'; echo $?)" "rc=$RC out=$OUT"

# --- static checks ---
if [ -f "$INSTALL" ]; then
  /bin/bash -n "$INSTALL"; check "install bash -n syntax" "$?" "syntax error"
else
  fail "install bash -n syntax" "hooks/bridge-install.sh missing"
fi

[ "$FAILS" = 0 ]
