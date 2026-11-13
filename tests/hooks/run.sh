#!/usr/bin/env bash
# Tests for hooks/bridge-hook.sh against tests/hooks/fake-bridge.mjs.
# Needs bash, curl, jq and node 22. No network, no real Worker.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$ROOT/hooks/bridge-hook.sh"
FIX="$HERE/fixtures"
WORK="$(mktemp -d)"
FAKE_PID=""
FAILS=0

cleanup() {
  stop_fake
  rm -rf "$WORK"
}
trap cleanup EXIT

stop_fake() {
  if [ -n "$FAKE_PID" ]; then
    kill "$FAKE_PID" 2>/dev/null
    wait "$FAKE_PID" 2>/dev/null
    FAKE_PID=""
  fi
}

# new_case: fresh temp dir, config dir, and a fake bridge with the given script JSON.
new_case() {
  T="$(mktemp -d "$WORK/case.XXXXXX")"
  CFG="$T/cfg"
  STATE="$CFG/discord-bridge/state"
  LOG="$T/log.jsonl"
  : > "$LOG"
  printf '%s' "$1" > "$T/script.json"
  node "$HERE/fake-bridge.mjs" "$T/script.json" "$LOG" "$T/port" &
  FAKE_PID=$!
  i=0
  while [ ! -s "$T/port" ] && [ "$i" -lt 100 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  URL="http://127.0.0.1:$(cat "$T/port")"
}

# run_hook <mode> <fixture> [VAR=value ...]; sets OUT, ERR, RC.
run_hook() {
  mode="$1"; fixture="$2"; shift 2
  env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" BRIDGE_URL="$URL" BRIDGE_KEY=test-token \
    BRIDGE_POLL_SECONDS=1 BRIDGE_MACHINE=testbox "$@" \
    bash "$HOOK" "$mode" < "$FIX/$fixture" > "$T/out" 2> "$T/err"
  RC=$?
  OUT="$(cat "$T/out")"
  ERR="$(cat "$T/err")"
}

# count_log <jq-select-expression>
count_log() {
  jq -s "[.[] | select($1)] | length" "$LOG"
}
posts() { count_log '.method=="POST" and .path=="/api/requests"'; }
first_post() { jq -s '[.[] | select(.method=="POST" and .path=="/api/requests")][0].body' "$LOG"; }

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; FAILS=$((FAILS + 1)); }

# expect <name> <condition-exit-status> <message>
check() { if [ "$2" = 0 ]; then pass "$1"; else fail "$1" "$3"; fi; }


# --- permission ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
run_hook permission permission-bash.json
want='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
got="$(printf '%s' "$OUT" | jq -c . 2>/dev/null)"
b="$(first_post)"
if [ "$RC" = 0 ] && [ "$got" = "$want" ] \
  && [ "$(printf '%s' "$b" | jq -r '[.kind,.tool,.preview,.machine,.project,.session]|join("|")')" = "permission|Bash|npm test|testbox|example|aa98a70a-b692-49f2-ac63-beb18981e5ec" ] \
  && [ "$(count_log '.auth==false')" = 0 ]; then
  pass "permission allow prints allow decision"
else fail "permission allow prints allow decision" "rc=$RC out=$OUT body=$b"; fi
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"deny"}}}]}'
run_hook permission permission-bash.json
want='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Discord."}}}'
got="$(printf '%s' "$OUT" | jq -c . 2>/dev/null)"
check "permission deny prints deny decision" "$([ "$RC" = 0 ] && [ "$got" = "$want" ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{}'
run_hook permission permission-ask.json
check "permission ignores AskUserQuestion" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(posts)" = 0 ]; echo $?)" "rc=$RC out=$OUT posts=$(posts)"
stop_fake

# --- fallbacks ---
new_case '{}'
start=$(date +%s)
env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" bash "$HOOK" permission < "$FIX/permission-bash.json" > "$T/out" 2> "$T/err"
RC=$?
took=$(( $(date +%s) - start ))
check "no config falls back" "$([ "$RC" = 0 ] && [ ! -s "$T/out" ] && [ "$took" -lt 2 ] && [ "$(posts)" = 0 ]; echo $?)" "rc=$RC took=$took out=$(cat "$T/out")"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"stopAfterPost":true}'
run_hook permission permission-bash.json BRIDGE_GIVE_UP_SECONDS=2
check "bridge down mid-wait falls back" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(posts)" = 1 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{"post":{"status":502,"body":{"id":"r1","status":"released"}}}'
run_hook permission permission-bash.json
check "failed post exits silently" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="GET"')" = 0 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"expired"}}]}'
run_hook permission permission-bash.json
check "expired exits silently" "$([ "$RC" = 0 ] && [ -z "$OUT" ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}}]}'
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0"
check "local input releases" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

# --- the terminal's "don't ask again" and "switch to auto mode" choices, from Discord ---
SUGGESTED='[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"echo \"permission test\":*"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["/tmp"],"destination":"session"}]'
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow","scope":"always"}}}]}'
run_hook permission permission-suggest.json
check "the request says what always-allow covers, in plain words" "$([ "$(first_post | jq -r '.always')" = 'allow Bash commands starting with echo "permission test" in this project; allow access to /tmp for this session' ]; echo $?)" "post=$(first_post)"
check "Always allow returns Claude Code's own suggestions" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.decision')" = "$(jq -cn --argjson s "$SUGGESTED" '{behavior:"allow",updatedPermissions:$s}')" ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

# The Write prompt from the live test: Claude Code suggests accept-edits mode and two folders.
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
run_hook permission permission-write-suggest.json
check "modes and folders read plainly" "$([ "$(first_post | jq -r '.always')" = 'switch this session to accept-edits mode (auto-approves file edits); allow access to /tmp and /private/tmp for this session' ]; echo $?)" "post=$(first_post)"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow","scope":"auto"}}}]}'
run_hook permission permission-suggest.json
check "Switch to auto mode sets the session's mode" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.decision')" = '{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}' ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
run_hook permission permission-suggest.json
check "a plain Allow stays plain" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.decision')" = '{"behavior":"allow"}' ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow","scope":"always"}}}]}'
run_hook permission permission-bash.json
check "no suggestions: no always line, and always is a plain allow" "$([ "$(first_post | jq -r 'has("always")')" = false ] && [ "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.decision')" = '{"behavior":"allow"}' ]; echo $?)" "post=$(first_post) out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow","scope":"bogus"}}}]}'
run_hook permission permission-suggest.json
check "an unknown scope is a plain allow" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.decision')" = '{"behavior":"allow"}' ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

# --- a prompt answered in the terminal (or the Claude app) clears its DM as soon as the tool has run ---
SID=aa98a70a-b692-49f2-ac63-beb18981e5ec
BASH_HASH="$(jq -cS '.tool_input // {}' "$FIX/permission-bash.json" | cksum | cut -d' ' -f1)"
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
run_hook permission permission-bash.json > /dev/null &
HP=$!
i=0; while [ ! -f "$CFG/discord-bridge/state/$SID.perm.r1" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
NOTE="$(cat "$CFG/discord-bridge/state/$SID.perm.r1" 2>/dev/null)"
wait "$HP"
check "a waiting permission leaves a note naming the tool and command" "$([ "$NOTE" = "$(printf 'Bash\t%s' "$BASH_HASH")" ]; echo $?)" "note=[$NOTE] want=[Bash $BASH_HASH]"
check "the note is gone once the hook ends" "$([ ! -e "$CFG/discord-bridge/state/$SID.perm.r1" ]; echo $?)" "state=$(ls "$CFG/discord-bridge/state" 2>/dev/null)"
stop_fake

new_case '{"release":{"status":200,"body":{"status":"released"}}}'
mkdir -p "$CFG/discord-bridge/state"
printf 'Bash\t%s' "$BASH_HASH" > "$CFG/discord-bridge/state/$SID.perm.r1"
run_hook handled permission-bash.json
check "handled releases the matching request" "$([ "$RC" = 0 ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ] && [ ! -e "$CFG/discord-bridge/state/$SID.perm.r1" ]; echo $?)" "rc=$RC log=$(cat "$LOG")"
stop_fake

new_case '{"release":{"status":200,"body":{"status":"released"}}}'
mkdir -p "$CFG/discord-bridge/state"
printf 'Bash\t%s' "123" > "$CFG/discord-bridge/state/$SID.perm.r1"
printf 'Bash\t%s' "$BASH_HASH" > "$CFG/discord-bridge/state/other-session.perm.r2"
run_hook handled permission-bash.json
check "handled leaves another command's and another session's prompt alone" "$([ ! -s "$LOG" ] && [ -e "$CFG/discord-bridge/state/$SID.perm.r1" ] && [ -e "$CFG/discord-bridge/state/other-session.perm.r2" ]; echo $?)" "log=$(cat "$LOG")"
stop_fake

new_case '{}'
run_hook handled permission-bash.json
check "handled with nothing waiting makes no request" "$([ "$RC" = 0 ] && [ ! -s "$LOG" ]; echo $?)" "log=$(cat "$LOG")"
stop_fake

# Input counts only while a terminal app is in front: using Discord (or anything else) on the same machine keeps waiting.
PENDING_THEN_ALLOW='{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
ALLOW_OUT='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
new_case "$PENDING_THEN_ALLOW"
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_FRONT_APP_CMD="echo com.hnc.Discord"
check "input while Discord is in front keeps waiting" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$ALLOW_OUT" ] && [ "$(count_log '(.path|endswith("/release"))')" = 0 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

new_case "$PENDING_THEN_ALLOW"
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_FRONT_APP_CMD="echo com.apple.Terminal"
check "input while a terminal is in front releases" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case "$PENDING_THEN_ALLOW"
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_FRONT_APP_CMD="printf '%s\n' '\"CFBundleIdentifier\"=\"com.googlecode.iterm2\"'"
check "lsappinfo's output format is understood" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case "$PENDING_THEN_ALLOW"
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_FRONT_APP_CMD="echo com.jetbrains.goland"
check "a JetBrains IDE counts as a terminal" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case "$PENDING_THEN_ALLOW"
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_FRONT_APP_CMD="echo com.example.MyTerm" BRIDGE_TERMINAL_APPS="org.other.App, com.example.MyTerm"
check "BRIDGE_TERMINAL_APPS adds an app" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case "$PENDING_THEN_ALLOW"
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_FRONT_APP_CMD="true"
check "an unknown app in front keeps waiting" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$ALLOW_OUT" ] && [ "$(count_log '(.path|endswith("/release"))')" = 0 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

# A touch after wake while the Worker cannot be reached: the release did not happen, so the held answer must survive.
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":503,"body":{}},{"status":503,"body":{}},{"status":503,"body":{}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}],"release":{"status":503,"body":{}}}'
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_GIVE_UP_SECONDS=30
check "local input while offline keeps a held answer" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}}],"release":{"status":200,"body":{"status":"released"}}}'
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0"
check "local input releases once the Worker answers" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":503,"body":{}}],"release":{"status":503,"body":{}}}'
start=$(date +%s)
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_GIVE_UP_SECONDS=3
took=$(( $(date +%s) - start ))
check "local input while offline still gives up after the window" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$took" -ge 3 ] && [ "$took" -le 23 ]; echo $?)" "rc=$RC out=$OUT took=$took"
stop_fake

# The Worker answers polls (pending) but every release fails: a 200 poll must not keep restarting the window.
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}}],"release":{"status":503,"body":{}}}'
( sleep 40; pkill -f "bridge-hook.sh permission" 2>/dev/null ) & WATCHDOG=$!
start=$(date +%s)
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0" BRIDGE_GIVE_UP_SECONDS=3
took=$(( $(date +%s) - start ))
kill "$WATCHDOG" 2>/dev/null; wait "$WATCHDOG" 2>/dev/null
check "a release that keeps failing still gives up" "$([ -z "$OUT" ] && [ "$took" -ge 3 ] && [ "$took" -le 23 ]; echo $?)" "rc=$RC out=$OUT took=$took"
stop_fake

# --- question ---
Q='{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":'
new_case "$Q"'{"type":"answers","answers":{"Pick a colour":"Red","Pick sizes":"Small, Large"}}}}]}'
run_hook question pretool-ask.json
ok=$(printf '%s' "$OUT" | jq -e '
  .hookSpecificOutput.hookEventName=="PreToolUse"
  and .hookSpecificOutput.permissionDecision=="allow"
  and .hookSpecificOutput.updatedInput.answers=={"Pick a colour":"Red","Pick sizes":"Small, Large"}
  and (.hookSpecificOutput.updatedInput.questions|length)==2
  and .hookSpecificOutput.updatedInput.questions[0].question=="Pick a colour"' >/dev/null 2>&1; echo $?)
b="$(first_post)"
ok2=$(printf '%s' "$b" | jq -e '.kind=="question" and (.questions|length)==2 and .questions[1].multiSelect==true' >/dev/null 2>&1; echo $?)
check "question answers map exact question text" "$([ "$RC" = 0 ] && [ "$ok" = 0 ] && [ "$ok2" = 0 ]; echo $?)" "rc=$RC out=$OUT body=$b"
stop_fake

new_case "$Q"'{"type":"text","text":"something else"}}}]}'
run_hook question pretool-ask.json
check "question text answers every question" "$(printf '%s' "$OUT" | jq -e '.hookSpecificOutput.updatedInput.answers=={"Pick a colour":"something else","Pick sizes":"something else"}' >/dev/null 2>&1; echo $?)" "out=$OUT"
stop_fake

new_case "$Q"'{"type":"chat","text":"lets talk first"}}}]}'
run_hook question pretool-ask.json
check "question chat denies with the reply as reason" "$(printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName=="PreToolUse" and .hookSpecificOutput.permissionDecision=="deny" and (.hookSpecificOutput.permissionDecisionReason|startswith("The user replied from Discord:")) and (.hookSpecificOutput.permissionDecisionReason|contains("lets talk first"))' >/dev/null 2>&1; echo $?)" "out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"released","answer":{"type":"back"}}}]}'
run_hook question pretool-ask.json
check "question back prints nothing" "$([ "$RC" = 0 ] && [ -z "$OUT" ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

# --- stop ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending","mode":"turn"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"type":"text","text":"keep going"}}}]}'
mkdir -p "$STATE"
echo $(( $(date +%s) - 400 )) > "$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.start"
run_hook stop stop.json
b="$(first_post)"
want='{"decision":"block","reason":"The user replied from Discord: keep going"}'
got="$(printf '%s' "$OUT" | jq -c . 2>/dev/null)"
el=$(printf '%s' "$b" | jq -r '.elapsedSeconds')
check "stop turn blocks with the reply" "$([ "$RC" = 0 ] && [ "$got" = "$want" ] && [ "$(printf '%s' "$b" | jq -r '.kind+"|"+.text')" = "stop|done" ] && [ "$el" -ge 400 ] && [ "$el" -lt 420 ]; echo $?)" "rc=$RC out=$OUT body=$b"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"none","mode":"none"}}}'
run_hook stop stop.json
check "stop outside conversation prints nothing" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="GET"')" = 0 ] && [ "$(printf '%s' "$(first_post)" | jq -r '.elapsedSeconds')" = 0 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"rid-done","status":"pending","mode":"done"}}}'
run_hook stop stop.json
f="$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.cb40bd11-b619-4d06-a57c-438987036bf3.stop"
check "stop done writes the hand-off file" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(cat "$f" 2>/dev/null)" = rid-done ] && [ "$(count_log '.method=="GET"')" = 0 ]; echo $?)" "rc=$RC out=$OUT"
rm -f "$f"
run_hook stop stop-no-prompt-id.json
check "stop done without prompt_id uses session.stop" "$([ "$(cat "$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.stop" 2>/dev/null)" = rid-done ]; echo $?)" "state=$(ls "$STATE")"
stop_fake

# --- stop-rewake ---
new_case '{"gets":[{"status":200,"body":{"id":"rid-done","status":"answered","answer":{"type":"chat","text":"one more thing"}}}]}'
mkdir -p "$STATE"
f="$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.cb40bd11-b619-4d06-a57c-438987036bf3.stop"
echo rid-done > "$f"
run_hook stop-rewake stop.json BRIDGE_HANDOFF_SECONDS=3
check "stop-rewake exits 2 with the reply on stderr" "$([ "$RC" = 2 ] && [ "$ERR" = "The user replied from Discord: one more thing" ] && [ -z "$OUT" ] && [ ! -e "$f" ] && [ "$(posts)" = 0 ] && [ "$(count_log '.path=="/api/requests/rid-done"')" = 1 ]; echo $?)" "rc=$RC err=$ERR"
stop_fake

new_case '{}'
start=$(date +%s)
run_hook stop-rewake stop.json BRIDGE_HANDOFF_SECONDS=2
took=$(( $(date +%s) - start ))
check "stop-rewake ignores a turn" "$([ "$RC" = 0 ] && [ -z "$ERR" ] && [ -z "$OUT" ] && [ "$(count_log 'true')" = 0 ] && [ "$took" -ge 1 ] && [ "$took" -le 5 ]; echo $?)" "rc=$RC took=$took"
stop_fake

new_case '{"gets":[{"status":200,"body":{"id":"rid-done","status":"released"}}]}'
mkdir -p "$STATE"
echo rid-done > "$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.cb40bd11-b619-4d06-a57c-438987036bf3.stop"
run_hook stop-rewake stop.json BRIDGE_HANDOFF_SECONDS=3
check "stop-rewake exits 0 when released" "$([ "$RC" = 0 ] && [ -z "$ERR" ]; echo $?)" "rc=$RC err=$ERR"
stop_fake

# --- notify / prompt ---
new_case '{"post":{"status":201,"body":{"id":"n1","status":"sent"}}}'
run_hook notify notification.json
b="$(first_post)"
check "notify posts event and text" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(printf '%s' "$b" | jq -r '[.kind,.event,.text,.project]|join("|")')" = "notify|Notification:agent_needs_input|Claude needs your input|example" ]; echo $?)" "rc=$RC body=$b"
stop_fake

new_case '{}'
run_hook prompt prompt.json
s="$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.start"
now=$(date +%s)
v="$(cat "$s" 2>/dev/null)"
check "prompt records the start time" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ -n "$v" ] && [ "$v" -le "$now" ] && [ "$v" -ge $((now - 5)) ] && [ "$(count_log '.method=="POST" and .path=="/api/sessions/aa98a70a-b692-49f2-ac63-beb18981e5ec/end"')" = 1 ] && [ "$(posts)" = 0 ]; echo $?)" "rc=$RC v=$v"
stop_fake

new_case '{}'
run_hook prompt prompt-rewake.json
s="$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.start"
v="$(cat "$s" 2>/dev/null)"
check "prompt after a Discord rewake keeps conversation mode" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ -n "$v" ] && [ "$(count_log '.path|endswith("/end")')" = 0 ] && [ "$(count_log 'true')" = 0 ]; echo $?)" "rc=$RC v=$v log=$(cat "$LOG")"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"n1","status":"sent"}}}'
run_hook notify stop-failure-object.json
b="$(first_post)"
txt="$(printf '%s' "$b" | jq -r '.text')"
check "notify sends a non-string error on one line" "$([ "$RC" = 0 ] && [ -n "$txt" ] && [ "$(printf '%s' "$txt" | wc -l | tr -d ' ')" = 0 ] && case "$txt" in *'"type":"x"'*) true ;; *) false ;; esac; echo $?)" "rc=$RC text=$txt"
stop_fake

new_case '{}'
mkdir -p "$STATE"
printf '1\n' > "$STATE/old.start"
touch -t "$(date -d '8 days ago' +%Y%m%d%H%M 2>/dev/null || date -v-8d +%Y%m%d%H%M)" "$STATE/old.start"
printf '1\n' > "$STATE/recent.start"
touch -t "$(date -d '6 days ago' +%Y%m%d%H%M 2>/dev/null || date -v-6d +%Y%m%d%H%M)" "$STATE/recent.start"
printf 'BRIDGE_KEY=keep\n' > "$CFG/discord-bridge/config.env"
touch -t "$(date -d '3 days ago' +%Y%m%d%H%M 2>/dev/null || date -v-3d +%Y%m%d%H%M)" "$CFG/discord-bridge/config.env"
run_hook prompt prompt.json
check "old state files are cleaned" "$([ "$RC" = 0 ] && [ ! -e "$STATE/old.start" ] && [ -e "$STATE/recent.start" ] && [ -s "$STATE/aa98a70a-b692-49f2-ac63-beb18981e5ec.start" ] && [ -f "$CFG/discord-bridge/config.env" ]; echo $?)" "rc=$RC state=$(ls "$STATE")"
stop_fake

# --- body-less POSTs carry Content-Length: 0 ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}}]}'
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0"
rel="$(count_log '.path=="/api/requests/r1/release" and .contentLength=="0"')"
run_hook prompt prompt.json
endc="$(count_log '(.path|endswith("/end")) and .contentLength=="0"')"
check "bodyless posts carry Content-Length 0" "$([ "$rel" = 1 ] && [ "$endc" = 1 ]; echo $?)" "release=$rel end=$endc log=$(cat "$LOG")"
stop_fake

# --- key never in argv ---
# A shim curl first on PATH logs its argv, then execs the real curl.
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
REAL_CURL="$(command -v curl)"
mkdir -p "$T/shim"
ARGV_LOG="$T/argv.log"
: > "$ARGV_LOG"
cat > "$T/shim/curl" <<SHIM
#!/bin/bash
{ printf 'CALL'; for a in "\$@"; do printf ' [%s]' "\$a"; done; printf '\\n'; } >> "$ARGV_LOG"
exec "$REAL_CURL" "\$@"
SHIM
chmod +x "$T/shim/curl"
run_hook permission permission-bash.json PATH="$T/shim:$PATH"
calls="$(grep -c '^CALL' "$ARGV_LOG")"
leak=1
grep -q "test-token" "$ARGV_LOG" || leak=0
usedk=1
[ "$calls" -ge 1 ] && ! grep '^CALL' "$ARGV_LOG" | grep -qv -e '\[-K\] \[-\]' && usedk=0
[ "$(posts)" = 1 ] || usedk=1
check "key never appears in argv" "$((leak + usedk))" "calls=$calls leak=$leak usedk=$usedk"
stop_fake

# --- BRIDGE_QUESTIONS=notify: questions are not held; Discord gets a one-way heads-up ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"sent"}}}'
run_hook question pretool-ask.json BRIDGE_QUESTIONS=notify
check "notify: a question is posted as a one-way notice" "$([ "$(first_post | jq -r '.kind + "|" + .event')" = 'notify|AskUserQuestion' ] && [ "$(first_post | jq -c '.questions')" = "$(jq -c '.tool_input.questions' "$FIX/pretool-ask.json")" ]; echo $?)" "post=$(first_post)"
check "notify: the question is not held" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="GET"')" = 0 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"sent"}}}'
mkdir -p "$CFG/discord-bridge"
printf 'BRIDGE_QUESTIONS=notify\n' > "$CFG/discord-bridge/config.env"
run_hook question pretool-ask.json
check "notify: config.env sets it too" "$([ "$(first_post | jq -r '.kind')" = notify ] && [ -z "$OUT" ]; echo $?)" "post=$(first_post) out=$OUT"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"type":"answers","answers":{}}}}]}'
run_hook question pretool-ask.json BRIDGE_QUESTIONS=bogus
check "any other BRIDGE_QUESTIONS value holds the question as before" "$([ "$(first_post | jq -r '.kind')" = question ]; echo $?)" "post=$(first_post)"
stop_fake

# --- config.env and environment precedence ---
ALLOW='{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
ALLOW_OUT='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
new_case "$ALLOW"
mkdir -p "$CFG/discord-bridge"
cat > "$CFG/discord-bridge/config.env" <<CFGEOF
# the bridge
export BRIDGE_URL="$URL/"
BRIDGE_KEY='test-token'
BRIDGE_POLL_SECONDS=2
CFGEOF
run_hook permission permission-bash.json BRIDGE_URL= BRIDGE_KEY= BRIDGE_POLL_SECONDS=
check "config.env alone works" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$ALLOW_OUT" ] && [ "$(posts)" = 1 ]; echo $?)" "rc=$RC out=$OUT err=$ERR"
stop_fake

new_case "$ALLOW"
mkdir -p "$CFG/discord-bridge"
printf 'BRIDGE_URL=http://127.0.0.1:9\nBRIDGE_KEY=wrong-key\n' > "$CFG/discord-bridge/config.env"
run_hook permission permission-bash.json
check "environment overrides config.env" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$ALLOW_OUT" ] && [ "$(posts)" = 1 ] && [ "$(count_log '.auth==false')" = 0 ]; echo $?)" "rc=$RC out=$OUT"
stop_fake

# --- BRIDGE_POLL_SECONDS must be a positive whole number ---
for bad in 0 abc -1 1.5; do
  new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
  start=$(date +%s)
  run_hook permission permission-bash.json BRIDGE_POLL_SECONDS="$bad"
  took=$(( $(date +%s) - start ))
  check "poll seconds '$bad' falls back to 3" "$([ "$RC" = 0 ] && [ "$took" -ge 3 ] && [ "$took" -le 6 ] && [ "$(count_log '.method=="GET"')" = 2 ]; echo $?)" "rc=$RC took=$took"
  stop_fake
done

# --- the Worker URL must be https (loopback excepted) ---
for bad in http://example.com http://192.168.100.7:8787 http://127.0.0.1.example.com ftp://example.com http://localhost:1@example.com http://127.0.0.1:80@example.com http://localhost@example.com http://localhost:abc http://localhost: http://127.0.0.1:1@evil.example.com/path; do
  new_case '{}'
  REAL_CURL="$(command -v curl)"
  mkdir -p "$T/shim"
  : > "$T/curl.calls"
  printf '#!/bin/bash\necho call >> "%s"\nexec "%s" "$@"\n' "$T/curl.calls" "$REAL_CURL" > "$T/shim/curl"
  chmod +x "$T/shim/curl"
  run_hook permission permission-bash.json BRIDGE_URL="$bad" PATH="$T/shim:$PATH"
  check "non-https url $bad makes no request" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -s "$T/curl.calls" ] && [ "$(count_log 'true')" = 0 ]; echo $?)" "rc=$RC out=$OUT calls=$(cat "$T/curl.calls")"
  stop_fake
done

# https still reaches curl (the connection itself fails: nothing listens there).
new_case '{}'
mkdir -p "$T/shim"
: > "$T/curl.calls"
printf '#!/bin/bash\necho call >> "%s"\nexec "%s" "$@"\n' "$T/curl.calls" "$REAL_CURL" > "$T/shim/curl"
chmod +x "$T/shim/curl"
run_hook permission permission-bash.json BRIDGE_URL="https://127.0.0.1:1" PATH="$T/shim:$PATH"
check "https url is still used" "$([ "$RC" = 0 ] && [ -s "$T/curl.calls" ]; echo $?)" "rc=$RC"
stop_fake

# --- the hook tells the Worker when it stops waiting ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":500,"body":{}}]}'
run_hook permission permission-bash.json BRIDGE_GIVE_UP_SECONDS=2
check "giving up after failed polls sends a release" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(count_log '.method=="GET"')" -ge 2 ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

# --- the hook gives up by elapsed time, not by a count of failed polls ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":503,"body":{}},{"status":503,"body":{}},{"status":503,"body":{}},{"status":503,"body":{}},{"status":503,"body":{}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
run_hook permission permission-bash.json BRIDGE_GIVE_UP_SECONDS=30
check "slow reconnect keeps the answer" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$ALLOW_OUT" ] && [ "$(count_log '.path|endswith("/release")')" = 0 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":503,"body":{}}]}'
start=$(date +%s)
run_hook permission permission-bash.json BRIDGE_GIVE_UP_SECONDS=3
took=$(( $(date +%s) - start ))
check "gives up after the window" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$took" -ge 3 ] && [ "$took" -le 23 ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT took=$took log=$(cat "$LOG")"
stop_fake

# A machine that sleeps: the clock jumps an hour between two polls. The window restarts after wake.
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":503,"body":{}},{"status":503,"body":{}},{"status":503,"body":{}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
mkdir -p "$T/clock"
echo 0 > "$T/clock/offset"
REAL_DATE="$(command -v date)"
cat > "$T/clock/date" <<EOS
#!/bin/bash
if [ "\$1" = "+%s" ]; then echo \$(( \$("$REAL_DATE" +%s) + \$(cat "$T/clock/offset") )); else exec "$REAL_DATE" "\$@"; fi
EOS
chmod +x "$T/clock/date"
(
  i=0
  while [ "$(count_log '.method=="GET"')" = 0 ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
  sleep 0.3
  echo 3600 > "$T/clock/offset"
) &
JUMP_PID=$!
run_hook permission permission-bash.json BRIDGE_GIVE_UP_SECONDS=20 PATH="$T/clock:$PATH"
wait "$JUMP_PID" 2>/dev/null
check "a sleep restarts the window" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$ALLOW_OUT" ] && [ "$(count_log '.path|endswith("/release")')" = 0 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

for code in 401 403 404; do
  new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":'$code',"body":{}}]}'
  start=$(date +%s)
  run_hook permission permission-bash.json BRIDGE_GIVE_UP_SECONDS=60
  took=$(( $(date +%s) - start ))
  check "$code ends the wait at once" "$([ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$took" -lt 5 ] && [ "$(count_log '.method=="GET"')" = 1 ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT took=$took log=$(cat "$LOG")"
  stop_fake
done

# Not given up after 6 s means the value was not taken as a tiny window; killed before 120 s.
# The four values run side by side so they share one 6 s wait.
BAD_VALUES="abc 0 -1 1.5"
# The fake servers and hooks of these cases are stopped on exit or interrupt, too.
bad_cleanup() {
  for n in 1 2 3 4; do
    eval "kill \$BHP$n \$BFAKE$n 2>/dev/null"
  done
}
trap 'bad_cleanup; cleanup' EXIT
trap 'exit 130' INT TERM
n=0
for bad in $BAD_VALUES; do
  n=$((n + 1))
  new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":503,"body":{}}]}'
  eval "BT$n=\"$T\"; BFAKE$n=$FAKE_PID; BLOG$n=\"$LOG\""
  env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" BRIDGE_URL="$URL" BRIDGE_KEY=test-token BRIDGE_POLL_SECONDS=1 \
    BRIDGE_MACHINE=testbox BRIDGE_GIVE_UP_SECONDS="$bad" \
    bash "$HOOK" permission < "$FIX/permission-bash.json" > "$T/out" 2> "$T/err" &
  eval "BHP$n=$!"
  FAKE_PID=""
done
sleep 6
n=0
for bad in $BAD_VALUES; do
  n=$((n + 1))
  eval "T=\$BT$n; LOG=\$BLOG$n; HP=\$BHP$n; fp=\$BFAKE$n"
  alive=1; kill -0 "$HP" 2>/dev/null || alive=0
  gets_n="$(count_log '.method=="GET"')"
  kill -TERM "$HP" 2>/dev/null
  wait "$HP" 2>/dev/null
  kill "$fp" 2>/dev/null
  wait "$fp" 2>/dev/null
  check "give-up value '$bad' means 120" "$([ "$alive" = 1 ] && [ "$gets_n" -ge 4 ] && [ ! -s "$T/out" ]; echo $?)" "alive=$alive gets=$gets_n"
done
trap cleanup EXIT
trap - INT TERM

new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}}}'
env HOME="$T/home" CLAUDE_CONFIG_DIR="$CFG" BRIDGE_URL="$URL" BRIDGE_KEY=test-token BRIDGE_POLL_SECONDS=30 BRIDGE_MACHINE=testbox \
  bash "$HOOK" permission < "$FIX/permission-bash.json" > "$T/out" 2> "$T/err" &
HP=$!
i=0
while [ "$(count_log '.method=="GET"')" = 0 ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
start=$(date +%s)
kill -TERM "$HP" 2>/dev/null
wait "$HP"
RC=$?
took=$(( $(date +%s) - start ))
check "SIGTERM sends a release" "$([ "$RC" = 0 ] && [ ! -s "$T/out" ] && [ "$took" -le 5 ] && [ "$(count_log '.method=="POST" and .path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC took=$took log=$(cat "$LOG")"
stop_fake

# --- a release that finds an answer acts on it ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"deny"}}}],"release":{"status":200,"body":{"status":"answered"}}}'
run_hook permission permission-bash.json BRIDGE_IDLE_CMD="echo 0"
want='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Discord."}}}'
check "a release answered with an answer still acts on it" "$([ "$RC" = 0 ] && [ "$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" = "$want" ] && [ "$(count_log '.path=="/api/requests/r1/release"')" = 1 ]; echo $?)" "rc=$RC out=$OUT log=$(cat "$LOG")"
stop_fake

# --- the poll slows down after a while ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"pending"}},{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
run_hook permission permission-bash.json BRIDGE_BACKOFF_AFTER=1 BRIDGE_BACKOFF_SECONDS=3
gaps="$(jq -s '[.[] | select(.method=="GET") | .t] | [.[1]-.[0], .[2]-.[1]] | map(. / 1000) | @csv' -r "$LOG")"
g1="${gaps%,*}"; g2="${gaps#*,}"
check "poll backs off after the threshold" "$(awk -v a="$g1" -v b="$g2" 'BEGIN{exit !(a>=0.9 && a<2 && b>=2.9 && b<5)}'; echo $?)" "gaps=$gaps"
stop_fake

# --- a jq that writes CRLF (a native Windows jq.exe) changes nothing ---
new_case '{"post":{"status":201,"body":{"id":"r1","status":"pending"}},"gets":[{"status":200,"body":{"id":"r1","status":"answered","answer":{"behavior":"allow"}}}]}'
mkdir -p "$T/crbin"
printf '#!/bin/bash\n"%s" "$@" > "$0.out"; rc=$?\nawk '"'"'{ printf "%%s\\r\\n", $0 }'"'"' "$0.out"; rm -f "$0.out"\nexit $rc\n' "$(command -v jq)" > "$T/crbin/jq"
chmod +x "$T/crbin/jq"
run_hook permission permission-bash.json PATH="$T/crbin:$PATH"
want='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
got="$(printf '%s' "$OUT" | jq -c . 2>/dev/null)"
b="$(first_post)"
check "permission allow is the same with CRLF jq output" "$([ "$RC" = 0 ] && [ "$got" = "$want" ] && [ "$(printf '%s' "$b" | jq -r '[.kind,.tool,.preview,.machine,.project,.session]|join("|")')" = "permission|Bash|npm test|testbox|example|aa98a70a-b692-49f2-ac63-beb18981e5ec" ]; echo $?)" "rc=$RC out=$OUT body=$b"
stop_fake

# --- machine name ---
new_case '{"post":{"status":201,"body":{"id":"n1","status":"sent"}}}'
mkdir -p "$T/fakebin"
printf '#!/bin/sh\nexit 1\n' > "$T/fakebin/hostname"
chmod +x "$T/fakebin/hostname"
run_hook notify notification.json BRIDGE_MACHINE= PATH="$T/fakebin:$PATH"
want="$(uname -n | LC_ALL=C tr -cd ' -~' | cut -c1-64)"
got="$(first_post | jq -r '.machine')"
check "name falls back when hostname fails" "$([ "$RC" = 0 ] && [ -n "$want" ] && [ "$got" = "$want" ]; echo $?)" "rc=$RC got=$got want=$want"
stop_fake

new_case '{"post":{"status":201,"body":{"id":"n1","status":"sent"}}}'
run_hook notify notification.json "BRIDGE_MACHINE=café-laptop✓"
got="$(first_post | jq -r '.machine')"
check "name is cleaned to ascii" "$([ "$got" = "caf-laptop" ]; echo $?)" "got=$got"
stop_fake

# Runs against the repo's current HEAD, so .gitattributes must be committed.
CLONE="$WORK/clone"
if git clone -q "$ROOT" "$CLONE" 2>/dev/null; then
  crs="$(git -C "$CLONE" -c core.autocrlf=true archive HEAD hooks/bridge-hook.sh hooks/bridge-install.sh | tar -xO | tr -cd '\r' | wc -c | tr -d ' ')"
  check "scripts keep lf endings in archives" "$([ "$crs" = 0 ]; echo $?)" "cr bytes=$crs"
else
  fail "scripts keep lf endings in archives" "clone failed"
fi

# --- static checks ---
if [ -f "$HOOK" ]; then
  /bin/bash -n "$HOOK"; check "bash -n syntax" "$?" "syntax error"
  bad="$(grep -nE 'declare -A|local -n|\$\{[A-Za-z_0-9]+(,,|\^\^)|mapfile|readarray|\|&|&>>|wait -n|\[-[0-9]' "$HOOK" "$ROOT/hooks/bridge-install.sh")"
  check "no post-3.2 bash constructs" "$([ -z "$bad" ]; echo $?)" "$bad"
else
  fail "bash -n syntax" "hooks/bridge-hook.sh missing"
  fail "no post-3.2 bash constructs" "hooks/bridge-hook.sh missing"
fi

EX="$ROOT/examples/settings-hooks.json"
if [ -f "$EX" ] && jq -e '
  def cmds: [.hooks | to_entries[] | .key as $ev | .value[] | .matcher as $m | .hooks[] | {ev:$ev, m:$m, h:.}];
  (cmds | all(.h.type=="command" and (.h.command | test("^bash \"\\$\\{CLAUDE_CONFIG_DIR:-\\$HOME/\\.claude\\}/discord-bridge/bridge-hook\\.sh\" [a-z-]+$"))))
  and (cmds | map(select(.h.command | endswith(" permission")))[0] | .ev=="PermissionRequest" and .h.timeout==86400 and (.h.async|not))
  and (cmds | map(select(.h.command | endswith(" question")))[0] | .ev=="PreToolUse" and .m=="AskUserQuestion" and .h.timeout==86400)
  and (cmds | map(select(.h.command | endswith(" stop")))[0] | .ev=="Stop" and .h.timeout==86400)
  and (cmds | map(select(.h.command | endswith(" stop-rewake")))[0] | .ev=="Stop" and .h.asyncRewake==true and .h.timeout==7200)
  and (cmds | map(select(.h.command | endswith(" prompt")))[0] | .ev=="UserPromptSubmit" and .h.async==true)
  and (cmds | map(select(.h.command | endswith(" notify")) | .ev) | sort) == ["Notification","PermissionDenied","StopFailure"]
  and (cmds | map(select(.h.command | endswith(" notify")) | .h.async) | all)
  and (.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP == "100")
  and (cmds | map(select(.ev=="Notification"))[0].m == "agent_needs_input|elicitation_dialog|elicitation_url_dialog|auth_storage_failure")
' "$EX" >/dev/null 2>&1; then
  pass "settings example is valid"
else
  fail "settings example is valid" "examples/settings-hooks.json missing or wrong"
fi

# --- install script tests (their failures count here) ---
bash "$HERE/install.sh" || FAILS=$((FAILS + 1))

[ "$FAILS" = 0 ]
