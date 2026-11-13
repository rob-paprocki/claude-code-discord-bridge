#!/usr/bin/env bash
# Claude Code hook client for claude-code-discord-bridge.
# Usage: bridge-hook.sh <permission|question|stop|stop-rewake|notify|prompt|handled>
# Hook JSON arrives on stdin. Needs bash 3.2+, curl and jq. Any problem exits 0
# silently, so Claude Code falls back to its normal terminal prompt.

MODE="${1:-}"
CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/discord-bridge"
STATE_DIR="$CFG_DIR/state"
TMP="$(mktemp -d 2>/dev/null)" || exit 0
ACTIVE_ID=""   # the request this process is waiting on, if any
NAP_PID=""
PERM_NOTE=""   # while a permission request waits: the note the "handled" hook looks for
trap 'rm -rf "$TMP"; [ -z "$PERM_NOTE" ] || rm -f "$PERM_NOTE"' EXIT
# A hook that is told to stop tells the Worker it will not read an answer, then leaves quietly.
trap '[ -n "$NAP_PID" ] && kill "$NAP_PID" 2>/dev/null; release_active; exit 0' INT TERM HUP

# ---- config: file first, environment overrides ----
cfg_file_get() {
  [ -f "$CFG_DIR/config.env" ] || return 0
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$CFG_DIR/config.env" | tail -n 1 \
    | sed -e 's/^[^=]*=//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
URL="${BRIDGE_URL:-$(cfg_file_get BRIDGE_URL)}"
KEY="${BRIDGE_KEY:-$(cfg_file_get BRIDGE_KEY)}"
POLL="${BRIDGE_POLL_SECONDS:-$(cfg_file_get BRIDGE_POLL_SECONDS)}"
GIVE_UP="${BRIDGE_GIVE_UP_SECONDS:-$(cfg_file_get BRIDGE_GIVE_UP_SECONDS)}"
URL="${URL%/}"
# Only a positive whole number of seconds is a poll interval: 0 or text would spin.
case "$POLL" in
  ''|*[!0-9]*) POLL=3 ;;
  *) [ "$POLL" -gt 0 ] 2>/dev/null || POLL=3 ;;
esac
# How long the Worker may stay unreachable before the prompt goes back to the terminal.
case "$GIVE_UP" in
  ''|*[!0-9]*) GIVE_UP=120 ;;
  *) [ "$GIVE_UP" -gt 0 ] 2>/dev/null || GIVE_UP=120 ;;
esac
# The key travels in every request: plain http is only for a local test server. For http the
# authority (between "http://" and the next / ? or #) must be exactly 127.0.0.1 or localhost with
# an optional :<digits> port; anything else (userinfo with @, other hosts, a bad port) is refused.
case "$URL" in
  '') ;;
  https://*) ;;
  http://*)
    AUTH="${URL#http://}"
    AUTH="${AUTH%%[/?#]*}"
    case "$AUTH" in
      *@*) URL="" ;;
      127.0.0.1|localhost) ;;
      127.0.0.1:*|localhost:*)
        PORT="${AUTH#*:}"
        case "$PORT" in
          ''|*[!0-9]*) URL="" ;;
        esac
        ;;
      *) URL="" ;;
    esac
    ;;
  *) URL="" ;;
esac

# jqr: jq for values captured into shell variables. A native Windows jq.exe writes CRLF and Git
# Bash keeps the CR, so it is stripped here (not jq -b: jq 1.6 on Unix rejects it).
jqr() { jq "$@" | tr -d '\r'; }

INPUT="$(cat)"
jin() { printf '%s' "$INPUT" | jqr -r "$1" 2>/dev/null; }

SESSION="$(jin '.session_id // ""' | tr -d '\n' | tr -c 'A-Za-z0-9._-' '_')"
PROMPT_ID="$(jin '.prompt_id // ""' | tr -d '\n' | tr -c 'A-Za-z0-9._-' '_')"
[ -n "$SESSION" ] || exit 0

# machine_name: BRIDGE_MACHINE, else hostname -s, else uname -n, else $COMPUTERNAME;
# trimmed, printable ASCII only, at most 64 characters, "machine" if nothing is left.
# (bridge-install.sh carries a copy that differs only in using a local variable and honouring
# --machine; keep the two in step.)
machine_name() {
  name="${BRIDGE_MACHINE:-}"
  if [ -z "$name" ]; then
    if name="$(hostname -s 2>/dev/null)" && [ -n "$name" ]; then :
    elif name="$(uname -n 2>/dev/null)" && [ -n "$name" ]; then :
    else name="${COMPUTERNAME:-}"
    fi
  fi
  name="$(printf '%s' "$name" | LC_ALL=C tr -cd ' -~' | sed -e 's/^ *//' -e 's/ *$//' | cut -c1-64 | sed -e 's/ *$//')"
  [ -n "$name" ] || name="machine"
  printf '%s' "$name"
}
MACHINE="$(machine_name)"
PROJECT="$(basename "$(jin '.cwd // ""')")"

# Hand-off file between `stop` (done mode) and `stop-rewake`.
if [ -n "$PROMPT_ID" ]; then HANDOFF="$STATE_DIR/$SESSION.$PROMPT_ID.stop"; else HANDOFF="$STATE_DIR/$SESSION.stop"; fi

# ---- HTTP ----
# api <method> <path> [body-file] [max-seconds]: body-less requests send an empty body
# (Content-Length: 0). Sets CODE, response body in $TMP/resp.
# The key goes to curl on stdin as a config, never in argv.
api() {
  method="$1"; path="$2"; bodyfile="${3:-}"; maxt="${4:-10}"
  esc="$(printf '%s' "$KEY" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  : > "$TMP/resp"
  if [ -n "$bodyfile" ]; then
    CODE="$(printf 'header = "Authorization: Bearer %s"\n' "$esc" \
      | curl -sS -K - --max-time "$maxt" -X "$method" -o "$TMP/resp" -w '%{http_code}' \
          -H 'Content-Type: application/json' --data-binary "@$bodyfile" "$URL$path" 2>/dev/null)"
  elif [ "$method" = POST ]; then
    CODE="$(printf 'header = "Authorization: Bearer %s"\n' "$esc" \
      | curl -sS -K - --max-time "$maxt" -X "$method" -o "$TMP/resp" -w '%{http_code}' \
          --data-binary '' "$URL$path" 2>/dev/null)"
  else
    CODE="$(printf 'header = "Authorization: Bearer %s"\n' "$esc" \
      | curl -sS -K - --max-time "$maxt" -X "$method" -o "$TMP/resp" -w '%{http_code}' "$URL$path" 2>/dev/null)"
  fi
  [ -n "$CODE" ] || CODE=000
}

have_config() { [ -n "$URL" ] && [ -n "$KEY" ]; }

# ---- local-input release ----
idle_seconds() {
  if [ -n "${BRIDGE_IDLE_CMD:-}" ]; then
    sh -c "$BRIDGE_IDLE_CMD" 2>/dev/null | head -n 1
  elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ { printf "%d\n", $NF / 1000000000; exit }'
  fi
}

# The app in front, as a bundle ID ("" when unknown); fails when there is no way to tell. A
# BRIDGE_FRONT_APP_CMD may print a bare ID or lsappinfo's '"CFBundleIdentifier"="<id>"' line.
front_app() {
  local out
  if [ -n "${BRIDGE_FRONT_APP_CMD:-}" ]; then
    out="$(sh -c "$BRIDGE_FRONT_APP_CMD" 2>/dev/null | head -n 1)"
  elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsappinfo >/dev/null 2>&1; then
    out="$(lsappinfo info -only bundleid "$(lsappinfo front 2>/dev/null)" 2>/dev/null | head -n 1)"
  else
    return 1
  fi
  printf '%s' "$out" | tr -d '\r' | sed -e 's/^.*"="//' -e 's/"$//'
}

# Whether input on this machine means someone is at the terminal: a terminal app (or one listed in
# BRIDGE_TERMINAL_APPS, comma-separated bundle IDs) is in front. With no way to tell which app is
# in front, any input counts.
input_at_terminal() {
  local app id
  app="$(front_app)" || return 0
  [ -n "$app" ] || return 1
  case "$app" in com.jetbrains.*) return 0 ;; esac
  for id in com.apple.Terminal com.googlecode.iterm2 com.mitchellh.ghostty dev.warp.Warp-Stable \
    com.github.wez.wezterm net.kovidgoyal.kitty org.alacritty co.zeit.hyper com.microsoft.VSCode \
    com.todesktop.230313mzl4w4u92 dev.zed.Zed; do
    [ "$app" = "$id" ] && return 0
  done
  case ",$(printf '%s' "${BRIDGE_TERMINAL_APPS:-}" | tr -d ' ')," in *",$app,"*) return 0 ;; esac
  return 1
}

# Best effort: tells the Worker this process stopped waiting for ACTIVE_ID.
release_active() {
  [ -n "$ACTIVE_ID" ] || return 0
  rid="$ACTIVE_ID"
  ACTIVE_ID=""
  api POST "/api/requests/$rid/release" "" 3
}

# nap <seconds>: sleeps in the background so a trapped signal is handled at once.
nap() {
  sleep "$1" &
  NAP_PID=$!
  wait "$NAP_PID" 2>/dev/null
  NAP_PID=""
}

# ---- waiting ----
# wait_for_answer <id>: returns 0 with the answer in ANSWER when the request was
# answered; returns 1 for anything else (released, expired, unknown, poll
# failures, or a release because of local input).
wait_for_answer() {
  wid="$1"
  ACTIVE_ID="$wid"
  posted="$(date +%s)"
  first_fail=""   # epoch seconds the current run of failed polls counts from; empty after an answered poll
  last_poll=""    # epoch seconds of the previous failed poll
  rel_fail=""     # epoch seconds the current run of failed releases counts from (a pending poll does not reset it)
  rel_last=""     # epoch seconds of the previous failed release
  step="$POLL"
  waited=0
  after="${BRIDGE_BACKOFF_AFTER:-300}"      # seconds at the normal interval; env knobs are for tests
  slow="${BRIDGE_BACKOFF_SECONDS:-15}"
  while :; do
    api GET "/api/requests/$wid"
    if [ "$CODE" = 200 ]; then
      first_fail=""
      st="$(jqr -r '.status // ""' "$TMP/resp" 2>/dev/null)"
      case "$st" in
        answered)
          ANSWER="$(jqr -c '.answer // {}' "$TMP/resp" 2>/dev/null)"
          ACTIVE_ID=""
          return 0 ;;
        pending) ;;
        *) ACTIVE_ID=""; return 1 ;;
      esac
    else
      case "$CODE" in
        # The key or the request is gone: nothing will change by waiting.
        401|403|404) release_active; return 1 ;;
      esac
      # No answer, 429 or 5xx: keep trying until the window since the first failure is used up.
      # A gap far longer than the nap just taken means the machine slept; the window restarts after wake.
      now="$(date +%s)"
      if [ -z "$first_fail" ] || [ -z "$last_poll" ] || [ $(( now - last_poll )) -gt $(( step + 60 )) ]; then first_fail="$now"; fi
      last_poll="$now"
      if [ $(( now - first_fail )) -ge "$GIVE_UP" ]; then release_active; return 1; fi
    fi
    idle="$(idle_seconds)"
    case "$idle" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$idle" -lt $(( $(date +%s) - posted )) ] && input_at_terminal; then
          api POST "/api/requests/$wid/release" "" 5
          case "$CODE" in
            200)
              ACTIVE_ID=""
              # An answer that landed just before the release still counts.
              if [ "$(jqr -r '.status // ""' "$TMP/resp" 2>/dev/null)" = answered ]; then
                api GET "/api/requests/$wid"
                if [ "$CODE" = 200 ] && [ "$(jqr -r '.status // ""' "$TMP/resp" 2>/dev/null)" = answered ]; then
                  ANSWER="$(jqr -c '.answer // {}' "$TMP/resp" 2>/dev/null)"
                  return 0
                fi
              fi
              return 1 ;;
            401|403|404) ACTIVE_ID=""; return 1 ;;
            *)
              # The release did not happen (no answer, 429, 5xx): a held answer must survive, so keep
              # waiting until the give-up window is used up. Failed releases have their own window,
              # which a pending poll does not reset; a long gap (a sleep) restarts it, as for polls.
              now="$(date +%s)"
              if [ -z "$rel_fail" ] || [ -z "$rel_last" ] || [ $(( now - rel_last )) -gt $(( step + 60 )) ]; then rel_fail="$now"; fi
              rel_last="$now"
              if [ $(( now - rel_fail )) -ge "$GIVE_UP" ]; then release_active; return 1; fi ;;
          esac
        fi ;;
    esac
    # Five minutes of waiting cuts the poll rate: 28,800 polls a day is too many for a prompt
    # that was answered in the terminal on a machine with no idle detection.
    if [ "$waited" -ge "$after" ]; then step="$slow"; [ "$POLL" -gt "$step" ] && step="$POLL"; else step="$POLL"; fi
    nap "$step"
    waited=$((waited + step))
  done
}

# post_request <jq-filter-args...>: builds the body with jq -n, posts it,
# sets REQ_ID and REQ_MODE. Returns 1 unless the Worker answered 201.
post_request() {
  jq -n "$@" > "$TMP/body" 2>/dev/null || return 1
  api POST /api/requests "$TMP/body"
  [ "$CODE" = 201 ] || return 1
  REQ_ID="$(jqr -r '.id // ""' "$TMP/resp" 2>/dev/null)"
  REQ_MODE="$(jqr -r '.mode // ""' "$TMP/resp" 2>/dev/null)"
  [ -n "$REQ_ID" ]
}

# The tool call's input, canonical (sorted keys), as a short checksum: the same command gives the
# same value in the PermissionRequest and the PostToolUse hook.
input_hash() { printf '%s' "$INPUT" | jq -cS '.tool_input // {}' 2>/dev/null | cksum | cut -d' ' -f1; }

reply_text() { printf '%s' "$ANSWER" | jqr -r 'if (.type=="text" or .type=="chat") then (.text // "") else empty end' 2>/dev/null; }
reply_type() { printf '%s' "$ANSWER" | jqr -r '.type // ""' 2>/dev/null; }

case "$MODE" in
  prompt)
    if mkdir -p "$STATE_DIR" 2>/dev/null; then
      # Files of sessions that never ended (start times, hand-offs) are dropped after 7 days.
      find "$STATE_DIR" -type f -mmin +10080 -exec rm -f {} + 2>/dev/null
      date +%s > "$STATE_DIR/$SESSION.start"
    fi
    # The rewake prompt Claude Code fires after a Discord reply is not typed input:
    # it must not end conversation mode.
    PROMPT="$(jin '.prompt // ""')"
    case "$PROMPT" in
      '<task-notification>'*'The user replied from Discord:'*) exit 0 ;;
    esac
    if have_config; then api POST "/api/sessions/$SESSION/end" "" 5; fi
    exit 0 ;;

  permission)
    have_config || exit 0
    TOOL="$(jin '.tool_name // ""')"
    [ "$TOOL" = "AskUserQuestion" ] && exit 0
    PREVIEW="$(printf '%s' "$INPUT" | jqr -r '
      (.tool_name // "") as $t | (.tool_input // {}) as $i
      | (if $t == "Bash" then ($i.command // "")
         elif ($t == "Edit" or $t == "Write" or $t == "Read") then ($i.file_path // "")
         else ($i | tojson) end) | tostring | .[0:1500]' 2>/dev/null)"
    # Claude Code's "Yes, and don't ask again" choice: its suggestions stay here (only a readable
    # summary goes to the Worker), and an "always" answer hands back exactly these.
    SUGGESTIONS="$(printf '%s' "$INPUT" | jqr -c '[(.permission_suggestions // [])[]? | objects]' 2>/dev/null)"
    [ -n "$SUGGESTIONS" ] || SUGGESTIONS='[]'
    ALWAYS="$(printf '%s' "$SUGGESTIONS" | jqr -r '
      def where: {session: " for this session", localSettings: " in this project",
                  projectSettings: " in this project (shared settings)", userSettings: " everywhere"}[.destination // ""] // "";
      def verb: {allow: "allow", deny: "block", ask: "always ask before"}[.behavior // "allow"] // "allow";
      def modename: {acceptEdits: "accept-edits mode (auto-approves file edits)", auto: "auto mode", plan: "plan mode",
                     default: "default mode (asks each time)", dontAsk: "don'"'"'t-ask mode",
                     bypassPermissions: "bypass-permissions mode"}[.] // (. + " mode");
      def rule: (.toolName // "") as $t | (.ruleContent // "") as $c
        | if $c == "" then "all " + $t + " uses"
          elif $t == "Bash" and ($c | endswith(":*")) then "Bash commands starting with " + ($c | rtrimstr(":*"))
          elif $t == "Bash" then "the Bash command " + $c
          else $t + " for " + $c end;
      [.[]
      | if .type == "addRules" then . as $s | (.rules // [])[]? | objects | select((.toolName // "") != "")
          | ($s | verb) + " " + rule + ($s | where)
        elif .type == "addDirectories" then
          ([(.directories // [])[]? | strings] | select(length > 0) | "allow access to " + join(" and ")) + where
        elif .type == "setMode" and (.mode // "") != "" then
          if .destination == "session" then "switch this session to " + (.mode | modename)
          else "make " + (.mode | modename) + " the default" + where end
        else empty end
      | select(. != "")] | join("; ") | .[0:300]' 2>/dev/null)"
    post_request --arg machine "$MACHINE" --arg project "$PROJECT" --arg session "$SESSION" \
      --arg tool "$TOOL" --arg preview "$PREVIEW" --arg always "$ALWAYS" \
      '{kind:"permission",machine:$machine,project:$project,session:$session,tool:$tool,preview:$preview}
        + (if $always != "" then {always:$always} else {} end)' || exit 0
    # Claude Code shows its own dialog alongside this hook. When the terminal or the Claude app
    # answers first and the tool runs, the "handled" hook finds this note and clears the DM.
    case "$REQ_ID" in
      ""|*[!A-Za-z0-9]*) ;;
      *) if mkdir -p "$STATE_DIR" 2>/dev/null; then
           PERM_NOTE="$STATE_DIR/$SESSION.perm.$REQ_ID"
           printf '%s\t%s' "$TOOL" "$(input_hash)" > "$PERM_NOTE" 2>/dev/null || PERM_NOTE=""
         fi ;;
    esac
    wait_for_answer "$REQ_ID" || exit 0
    case "$(printf '%s' "$ANSWER" | jqr -r '.behavior // ""' 2>/dev/null)" in
      allow)
        case "$(printf '%s' "$ANSWER" | jqr -r '.scope // ""' 2>/dev/null)" in
          always) UPDATES="$SUGGESTIONS" ;;
          auto) UPDATES='[{"type":"setMode","mode":"auto","destination":"session"}]' ;;
          *) UPDATES='[]' ;;
        esac
        jq -cn --argjson u "$UPDATES" \
          '{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:({behavior:"allow"} + (if ($u | length) > 0 then {updatedPermissions:$u} else {} end))}}' ;;
      deny)  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Discord."}}}' ;;
    esac
    exit 0 ;;

  question)
    have_config || exit 0
    QUESTIONS="$(printf '%s' "$INPUT" | jqr -c '.tool_input.questions // empty' 2>/dev/null)"
    [ -n "$QUESTIONS" ] || exit 0
    # BRIDGE_QUESTIONS=notify: Claude Code shows a question only once this hook returns, so holding
    # it hides it from the terminal and Remote Control. Notify mode sends a heads-up and returns.
    if [ "${BRIDGE_QUESTIONS:-$(cfg_file_get BRIDGE_QUESTIONS)}" = notify ]; then
      post_request --arg machine "$MACHINE" --arg project "$PROJECT" --arg session "$SESSION" \
        --argjson questions "$QUESTIONS" \
        '{kind:"notify",event:"AskUserQuestion",machine:$machine,project:$project,session:$session,questions:$questions}'
      exit 0
    fi
    post_request --arg machine "$MACHINE" --arg project "$PROJECT" --arg session "$SESSION" \
      --argjson questions "$QUESTIONS" \
      '{kind:"question",machine:$machine,project:$project,session:$session,questions:$questions}' || exit 0
    wait_for_answer "$REQ_ID" || exit 0
    case "$(reply_type)" in
      answers)
        printf '%s' "$INPUT" | jq -c --argjson a "$(printf '%s' "$ANSWER" | jqr -c '.answers // {}')" \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:((.tool_input // {}) + {answers:$a})}}' ;;
      text)
        printf '%s' "$INPUT" | jq -c --arg t "$(reply_text)" \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",
            updatedInput:((.tool_input // {}) + {answers:([.tool_input.questions[].question | {key:., value:$t}] | from_entries)})}}' ;;
      chat)
        jq -n -c --arg t "The user replied from Discord: $(reply_text)" \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$t}}' ;;
    esac
    exit 0 ;;

  stop)
    have_config || exit 0
    ELAPSED=0
    if [ -f "$STATE_DIR/$SESSION.start" ]; then
      START="$(head -n 1 "$STATE_DIR/$SESSION.start" 2>/dev/null)"
      case "$START" in
        ''|*[!0-9]*) ;;
        *) ELAPSED=$(( $(date +%s) - START )); [ "$ELAPSED" -ge 0 ] || ELAPSED=0 ;;
      esac
    fi
    LAST="$(jin '.last_assistant_message // ""')"
    post_request --arg machine "$MACHINE" --arg project "$PROJECT" --arg session "$SESSION" \
      --arg text "$LAST" --argjson elapsed "$ELAPSED" \
      '{kind:"stop",machine:$machine,project:$project,session:$session,text:$text,elapsedSeconds:$elapsed}' || exit 0
    case "$REQ_MODE" in
      turn)
        wait_for_answer "$REQ_ID" || exit 0
        case "$(reply_type)" in
          text|chat)
            jq -n -c --arg r "The user replied from Discord: $(reply_text)" '{decision:"block",reason:$r}' ;;
        esac ;;
      done)
        mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
        printf '%s\n' "$REQ_ID" > "$HANDOFF.tmp" && mv "$HANDOFF.tmp" "$HANDOFF" ;;
    esac
    exit 0 ;;

  stop-rewake)
    have_config || exit 0
    LIMIT="${BRIDGE_HANDOFF_SECONDS:-30}"
    n=0
    while [ ! -f "$HANDOFF" ]; do
      [ "$n" -ge "$LIMIT" ] && exit 0
      sleep 1
      n=$((n + 1))
    done
    RID="$(head -n 1 "$HANDOFF" 2>/dev/null)"
    rm -f "$HANDOFF"
    [ -n "$RID" ] || exit 0
    wait_for_answer "$RID" || exit 0
    case "$(reply_type)" in
      text|chat)
        printf 'The user replied from Discord: %s\n' "$(reply_text)" >&2
        exit 2 ;;
    esac
    exit 0 ;;

  handled)
    # PostToolUse, on every tool call: a tool that ran was approved somewhere. If this session has a
    # permission request waiting for exactly this tool and input, it was answered in the terminal or
    # the Claude app, so the DM is released. Nothing waiting: no network, no output.
    have_config || exit 0
    set -- "$STATE_DIR/$SESSION".perm.*
    [ -f "$1" ] || exit 0
    WANT="$(printf '%s\t%s' "$(jin '.tool_name // ""')" "$(input_hash)")"
    for note in "$@"; do
      [ -f "$note" ] || continue
      rid="${note##*.perm.}"
      case "$rid" in ''|*[!A-Za-z0-9]*) continue ;; esac
      [ "$(cat "$note" 2>/dev/null)" = "$WANT" ] || continue
      rm -f "$note"
      api POST "/api/requests/$rid/release" "" 5
    done
    exit 0 ;;

  notify)
    have_config || exit 0
    EVENT="$(jin '.hook_event_name // ""')"
    [ "$EVENT" = "Notification" ] && EVENT="$EVENT:$(jin '.notification_type // ""')"
    TEXT="$(jin '(.message // .reason // .error // "") | if type == "string" then . else tojson end')"
    TOOL="$(jin '.tool_name // ""')"
    post_request --arg machine "$MACHINE" --arg project "$PROJECT" --arg session "$SESSION" \
      --arg event "$EVENT" --arg text "$TEXT" --arg tool "$TOOL" \
      '{kind:"notify",machine:$machine,project:$project,session:$session,event:$event,text:$text}
       + (if $tool != "" then {tool:$tool} else {} end)' || exit 0
    exit 0 ;;
esac
exit 0
