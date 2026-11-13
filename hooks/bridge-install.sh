#!/usr/bin/env bash
# Sets up this machine for claude-code-discord-bridge: copies the hook client, merges the hook
# settings, checks any existing key, and joins the bridge (a code you approve in Discord).
# Usage: BRIDGE_URL=<url> bash hooks/bridge-install.sh [--machine <name>] [--dry-run]
#        bash hooks/bridge-install.sh --leave   (removes this machine; needs no BRIDGE_URL)
# Needs bash 3.2+, curl and jq. Exit codes: 0 done, 2 setup problem, 3 not joined.
# Honours CLAUDE_CONFIG_DIR. Run it from a checkout: it finds hooks/ and examples/ next to itself.

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_HOOK="$SELF_DIR/bridge-hook.sh"
REPO_SETTINGS="$SELF_DIR/../examples/settings-hooks.json"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DIR="$CONFIG_DIR/discord-bridge"
SETTINGS="$CONFIG_DIR/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"
DRY=0
LEAVE=0
MACHINE_ARG=""
DROP_KEY=0
EXTRA_CFG=""   # lines of the old config.env other than BRIDGE_URL and BRIDGE_KEY, kept on a re-join

umask 077
unset TOKEN   # an exported TOKEN from the caller's environment would reach curl; ours is a plain variable
TMP="$(mktemp -d 2>/dev/null)" || { echo "bridge-install: cannot make a temp directory" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT

die() { echo "bridge-install: $*" >&2; exit 2; }

# jqr: jq for values captured into shell variables. A native Windows jq.exe writes CRLF and Git
# Bash keeps the CR, so it is stripped here (not jq -b: jq 1.6 on Unix rejects it).
jqr() { jq "$@" | tr -d '\r'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --machine)
      [ "$#" -ge 2 ] || die "--machine needs a name"
      case "$2" in -*) die "--machine needs a name" ;; esac
      MACHINE_ARG="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --leave) LEAVE=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

# machine_name: --machine, else BRIDGE_MACHINE, else hostname -s, else uname -n, else $COMPUTERNAME;
# trimmed, printable ASCII only, at most 64 characters, "machine" if nothing is left.
# (Differs from bridge-hook.sh's machine_name only in the --machine override and a local variable;
# keep the two in step.)
machine_name() {
  local name
  name="${MACHINE_ARG:-${BRIDGE_MACHINE:-}}"
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

# Step 1: curl and jq exist, BRIDGE_URL is https, or http for exactly 127.0.0.1 / localhost
# (the hook's rule: the authority is checked up to the next / ? or #).
check_tools() {
  local t
  for t in curl jq; do
    command -v "$t" >/dev/null 2>&1 || die "$t is required but was not found"
  done
}

# url_problem <url>: prints why the url is not allowed (nothing if it is fine).
url_problem() {
  local url="$1" auth port
  case "$url" in
    https://*) ;;
    http://*)
      auth="${url#http://}"
      auth="${auth%%[/?#]*}"
      case "$auth" in
        *@*) echo "it must be https:// (http:// only for 127.0.0.1 or localhost)" ;;
        127.0.0.1|localhost) ;;
        127.0.0.1:*|localhost:*)
          port="${auth#*:}"
          case "$port" in
            ''|*[!0-9]*) echo "bad port" ;;
          esac
          ;;
        *) echo "it must be https:// (http:// only for 127.0.0.1 or localhost)" ;;
      esac
      ;;
    *) echo "it must be https:// (http:// only for 127.0.0.1 or localhost)" ;;
  esac
}

check_basics() {
  local url why
  check_tools
  url="${BRIDGE_URL:-}"
  url="${url%/}"
  [ -n "$url" ] || die "BRIDGE_URL is not set (use BRIDGE_URL=https://<your worker> bash hooks/bridge-install.sh)"
  why="$(url_problem "$url")"
  [ -z "$why" ] || die "BRIDGE_URL is not allowed: $why"
  BRIDGE_URL="$url"
}

# Step 2: copy the hook client if it differs; the old file is kept as .bak-<stamp>.
copy_hook() {
  local dest="$DIR/bridge-hook.sh"
  [ -f "$REPO_HOOK" ] || die "cannot find $REPO_HOOK (run this from a checkout of the repository)"
  if [ -f "$dest" ] && cmp -s "$REPO_HOOK" "$dest"; then
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    echo "would copy bridge-hook.sh to $dest"
    return 0
  fi
  mkdir -p "$DIR" || die "cannot create $DIR"
  if [ -f "$dest" ]; then
    cp -p "$dest" "$dest.bak-$STAMP" || die "cannot back up $dest"
  fi
  cp "$REPO_HOOK" "$dest" || die "cannot write $dest"
  chmod 755 "$dest" || die "cannot set the mode of $dest"
  echo "copied bridge-hook.sh to $dest"
}

# Step 3: merge examples/settings-hooks.json into settings.json (README's merge). Bridge entries
# are replaced, other hooks kept, env merged with the user's values winning. Written only if the
# result differs from the current file.
merge_settings() {
  local cur="$TMP/current.json" merged="$TMP/merged.json"
  [ -f "$REPO_SETTINGS" ] || die "cannot find $REPO_SETTINGS (run this from a checkout of the repository)"
  if [ -f "$SETTINGS" ]; then
    jq -e 'type == "object"' "$SETTINGS" >/dev/null 2>&1 || die "$SETTINGS is not a JSON object; fix it and run again"
    cp "$SETTINGS" "$cur"
  else
    echo '{}' > "$cur"
  fi
  if jq -e '(.env // {}) | type == "object" and has("BRIDGE_KEY")' "$cur" >/dev/null 2>&1; then
    DROP_KEY=1
  fi
  jq -s '(.[0] | del(.env.BRIDGE_KEY)) as $a | .[1] as $b
    | $a * {
        env: (($b.env // {}) + ($a.env // {})),
        hooks: (($a.hooks // {}) as $h
          | reduce ($b.hooks | keys[]) as $k ($h;
              .[$k] = (((.[$k] // [])
                | map(.hooks |= map(select((.command // "") | contains("discord-bridge/bridge-hook.sh") | not)))
                | map(select((.hooks | length) > 0)))
                + $b.hooks[$k])))
      }' "$cur" "$REPO_SETTINGS" > "$merged" 2>/dev/null || die "could not merge the hook settings"
  if [ "$(jq -S . "$cur")" = "$(jq -S . "$merged")" ]; then
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    echo "would merge the bridge hooks into $SETTINGS"
    [ "$DROP_KEY" = 0 ] || echo "would remove env.BRIDGE_KEY from $SETTINGS (a joined machine keeps its key in config.env only)"
    return 0
  fi
  mkdir -p "$CONFIG_DIR" || die "cannot create $CONFIG_DIR"
  if [ -f "$SETTINGS" ]; then
    cp -p "$SETTINGS" "$SETTINGS.bak-$STAMP" || die "cannot back up $SETTINGS"
  fi
  # Write through the existing path (not mv over it): a symlinked settings.json stays a symlink
  # and keeps its mode. A new file gets mode 600 from the umask.
  cat "$merged" > "$SETTINGS" || die "cannot write $SETTINGS (the old file is in $SETTINGS.bak-$STAMP)"
  echo "merged the bridge hooks into $SETTINGS"
  [ "$DROP_KEY" = 0 ] || echo "removed env.BRIDGE_KEY from $SETTINGS: it is a secret and would override the key in config.env"
}

# api <METHOD> <path> [bodyfile] [max-time]: calls the Worker with the bearer token in $TOKEN (if
# any; a plain, never exported variable: set it before the call and clear it after, never as a
# prefix assignment on the call). The token goes to curl on stdin only. Sets CODE (http status, 000 for no answer); the
# response body is in $TMP/resp.
api() {
  local method="$1" path="$2" bodyfile="${3:-}" maxt="${4:-10}" esc
  local -a args
  esc="$(printf '%s' "${TOKEN:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  args=(-sS -K - --connect-timeout 5 --max-time "$maxt" -X "$method" -o "$TMP/resp" -w '%{http_code}')
  [ -z "$bodyfile" ] || args=("${args[@]}" -H 'Content-Type: application/json' --data-binary "@$bodyfile")
  : > "$TMP/resp"
  CODE="$( { [ -z "${TOKEN:-}" ] || printf 'header = "Authorization: Bearer %s"\n' "$esc"; } \
    | curl "${args[@]}" "$BRIDGE_URL$path" 2>/dev/null)"
  case "$CODE" in
    [0-9][0-9][0-9]) ;;
    *) CODE=000 ;;
  esac
}

# Step 4: check an existing key (config.env with a non-empty BRIDGE_KEY) with GET /api/machines/self.
# Returns when the join should go ahead; exits for "already joined" and for an unreachable Worker.
check_existing_key() {
  local cfg="$DIR/config.env" key
  [ -f "$cfg" ] || return 0
  EXTRA_CFG="$(grep -vE '^[[:space:]]*(export[[:space:]]+)?(BRIDGE_URL|BRIDGE_KEY)=' "$cfg")"
  key="$(config_value BRIDGE_KEY)"
  [ -n "$key" ] || return 0
  TOKEN="$key"
  api GET /api/machines/self
  TOKEN=""
  case "$CODE" in
    200)
      refresh_url "$cfg"
      echo "Already joined: the key in $cfg works."
      exit 0
      ;;
    401)
      mv "$cfg" "$cfg.bak-$STAMP" || die "cannot move $cfg"
      echo "The key in $cfg is no longer valid; moved it to $cfg.bak-$STAMP. Joining again."
      ;;
    000)
      echo "bridge-install: could not reach the Worker at $BRIDGE_URL; $cfg left as it is. Try again later." >&2
      exit 3
      ;;
    *)
      echo "bridge-install: the Worker at $BRIDGE_URL answered $CODE; $cfg left as it is. Try again later." >&2
      exit 3
      ;;
  esac
}

# refresh_url <config.env>: the key just worked against $BRIDGE_URL; when the file names another
# BRIDGE_URL, rewrite that one line (other lines kept) so the hook talks to the URL that was checked.
refresh_url() {
  local cfg="$1" old tmpcfg
  old="$(config_value BRIDGE_URL)"
  old="${old%/}"
  [ -n "$old" ] && [ "$old" != "$BRIDGE_URL" ] || return 0
  tmpcfg="$(mktemp "$DIR/config.env.XXXXXX")" || { echo "bridge-install: could not update BRIDGE_URL in $cfg" >&2; return 0; }
  { printf 'BRIDGE_URL=%s\n' "$BRIDGE_URL"; grep -vE '^[[:space:]]*(export[[:space:]]+)?BRIDGE_URL=' "$cfg"; } > "$tmpcfg" \
    && mv "$tmpcfg" "$cfg" \
    || { rm -f "$tmpcfg"; echo "bridge-install: could not update BRIDGE_URL in $cfg" >&2; return 0; }
  echo "BRIDGE_URL in $cfg pointed at another address; it is now $BRIDGE_URL."
}

JOIN_ID=""
JOIN_SECRET=""

# Best effort: tells the Worker this join is over. Used by the signal trap.
cancel_join() {
  if [ -n "$JOIN_ID" ]; then
    TOKEN="$JOIN_SECRET"
    api DELETE "/api/enroll/$JOIN_ID" "" 3
    TOKEN=""
  fi
}
on_signal() {
  trap '' INT TERM HUP
  cancel_join
  echo "bridge-install: cancelled; not joined." >&2
  exit 3
}

# is_hex64 <value>: true for exactly 64 lowercase hex characters (the Worker's poll secrets and keys).
is_hex64() {
  [ "${#1}" = 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

# Step 5: join (spec section 1).
join_bridge() {
  local body="$TMP/body" jcode status key now deadline next_notice start poll timeout notice
  jq -n --arg m "$NAME" '{machine: $m}' > "$body" || die "cannot build the join request"
  TOKEN=""
  api POST /api/enroll "$body"
  case "$CODE" in
    201) ;;
    400) die "the Worker rejected the machine name \"$NAME\"; pass another with --machine" ;;
    429) echo "bridge-install: too many joins are waiting; try again once you have approved or denied them, or after they expire (30 minutes)." >&2; exit 3 ;;
    502)
      echo "bridge-install: Discord refused the join DM. See README \"Deploy the Worker\" step 4, and run \`wrangler tail\` to see Discord's error (50007 means it refused the DM)." >&2
      exit 3
      ;;
    *) echo "bridge-install: the join request failed (status $CODE); try again later." >&2; exit 3 ;;
  esac
  JOIN_ID="$(jqr -r '.id // empty' "$TMP/resp" 2>/dev/null)"
  jcode="$(jqr -r '.code // empty' "$TMP/resp" 2>/dev/null)"
  JOIN_SECRET="$(jqr -r '.secret // empty' "$TMP/resp" 2>/dev/null)"
  case "$JOIN_ID" in
    ''|*[!0-9A-Za-z_-]*) JOIN_ID=""; echo "bridge-install: the Worker's join answer was not understood." >&2; exit 3 ;;
  esac
  # The secret goes into a curl config: only the shape the Worker issues (64 lowercase hex).
  if [ -z "$jcode" ] || ! is_hex64 "$JOIN_SECRET"; then
    JOIN_ID=""; JOIN_SECRET=""
    echo "bridge-install: the Worker's join answer was not understood." >&2
    exit 3
  fi
  trap on_signal INT TERM HUP
  printf 'Approve "%s" in Discord. Code: %s\n' "$NAME" "$jcode"

  poll="${BRIDGE_JOIN_POLL:-3}"
  case "$poll" in ''|*[!0-9.]*|*.*.*) poll=3 ;; esac
  timeout="${BRIDGE_JOIN_TIMEOUT:-1800}"
  case "$timeout" in ''|*[!0-9]*) timeout=1800 ;; esac
  notice="${BRIDGE_WAIT_NOTICE:-30}"
  case "$notice" in ''|*[!0-9]*) notice=30 ;; esac
  [ "$notice" -gt 0 ] || notice=30
  start="$(date +%s)"
  deadline=$((start + timeout))
  next_notice=$((start + notice))
  while :; do
    # Once the deadline has passed this is the last poll: an approval in the final interval counts.
    now="$(date +%s)"
    last=0
    [ "$now" -lt "$deadline" ] || last=1
    TOKEN="$JOIN_SECRET"
    api GET "/api/enroll/$JOIN_ID"
    TOKEN=""
    if [ "$CODE" = 200 ]; then
      status="$(jqr -r '.status // empty' "$TMP/resp" 2>/dev/null)"
      case "$status" in
        approved)
          key="$(jqr -r '.key // empty' "$TMP/resp" 2>/dev/null)"
          if [ -n "$key" ]; then
            if ! is_hex64 "$key"; then
              JOIN_ID=""
              echo "bridge-install: the Worker's join answer was not understood." >&2
              exit 3
            fi
            finish_join "$key"
          fi
          ;;
        denied|expired|cancelled|removed)
          echo "bridge-install: the join was $status; not joined." >&2
          exit 3
          ;;
        delivered)
          echo "bridge-install: this join's key was already handed out and the answer was lost. Remove the stale entry with /machines in Discord, then run this again." >&2
          exit 3
          ;;
      esac
    fi
    if [ "$last" = 1 ]; then
      echo "bridge-install: timed out waiting for approval; not joined. Run it again for a new code." >&2
      exit 3
    fi
    now="$(date +%s)"
    if [ "$now" -ge "$next_notice" ]; then
      echo "Still waiting for approval ($((now - start)) s). Code: $jcode"
      next_notice=$((now + notice))
    fi
    sleep "$poll" &
    wait $!
  done
}

# Approved: write config.env (umask 077 temp file, then mv), then confirm the key works.
finish_join() {
  local key="$1" cfg="$DIR/config.env" tmpcfg
  JOIN_ID=""
  trap - INT TERM HUP
  mkdir -p "$DIR" || die "cannot create $DIR"
  tmpcfg="$(mktemp "$DIR/config.env.XXXXXX")" || die "cannot write the key under $DIR"
  { printf 'BRIDGE_URL=%s\n' "$BRIDGE_URL"; printf 'BRIDGE_KEY=%s\n' "$key"
    [ -z "$EXTRA_CFG" ] || printf '%s\n' "$EXTRA_CFG"; } > "$tmpcfg" \
    && mv "$tmpcfg" "$cfg" \
    || { rm -f "$tmpcfg"; die "cannot write $cfg; the key was approved but not saved: remove the entry with /machines and run this again"; }
  TOKEN="$key"
  api GET /api/machines/self
  TOKEN=""
  if [ "$CODE" = 200 ]; then
    echo "Joined as \"$NAME\". The key is saved in $cfg."
    exit 0
  fi
  echo "bridge-install: the key was saved in $cfg but could not be confirmed (status $CODE); not joined. Run this again to retry." >&2
  exit 3
}

# config_value <name>: the value of NAME= in config.env (last one wins), quotes stripped.
config_value() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$DIR/config.env" 2>/dev/null | tail -n 1 \
    | sed -e 's/^[^=]*=//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# --leave: tell the Worker (best effort), remove the bridge's hooks from settings.json (backup
# first, written through the existing path), delete config.env and bridge-hook.sh. Leaves
# env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP alone. Exits 0 even when the Worker cannot be reached.
leave_bridge() {
  local FAILED key url why cleaned="$TMP/cleaned.json" cfg="$DIR/config.env" hook="$DIR/bridge-hook.sh"
  check_tools
  if [ "$DRY" = 1 ]; then
    echo "would tell the Worker to remove this machine (if $cfg has a key)"
    echo "would remove the bridge hooks from $SETTINGS (after a backup)"
    echo "would delete $cfg and $hook"
    exit 0
  fi
  if [ -f "$cfg" ]; then
    key="$(config_value BRIDGE_KEY)"
    url="$(config_value BRIDGE_URL)"
    url="${url%/}"
    if [ -z "$key" ]; then
      echo "no key in $cfg; nothing to tell the Worker"
    elif [ -z "$url" ]; then
      echo "no BRIDGE_URL in $cfg; could not tell the Worker"
    else
      why="$(url_problem "$url")"
      if [ -n "$why" ]; then
        echo "BRIDGE_URL in $cfg is not allowed ($why); could not tell the Worker"
      else
        BRIDGE_URL="$url"
        TOKEN="$key"
        api DELETE /api/machines/self "" 5
        TOKEN=""
        case "$CODE" in
          2??) echo "removed this machine from the bridge" ;;
          401|404) echo "the bridge did not accept this key (status $CODE): this machine was already removed; nothing to remove there" ;;
          000) echo "could not reach the Worker (status $CODE); remove the machine with /machines in Discord" ;;
          *) echo "the Worker answered $CODE; remove the machine with /machines in Discord" ;;
        esac
      fi
    fi
  else
    echo "no $cfg; nothing to tell the Worker"
  fi

  # A settings.json that cannot be edited does not stop the leave: config.env is still deleted (the
  # hook does nothing without it) and bridge-hook.sh stays (the hooks still point at it).
  FAILED=""
  if [ -f "$SETTINGS" ]; then
    if jq -e 'type == "object"' "$SETTINGS" >/dev/null 2>&1; then
      if ! jq '(.hooks // null) as $h
        | if ($h | type) == "object" then
            .hooks = ($h
              | map_values(map(.hooks |= map(select((.command // "") | contains("discord-bridge/bridge-hook.sh") | not)))
                  | map(select((.hooks | length) > 0)))
              | with_entries(select((.value | length) > 0)))
            | if (.hooks | length) == 0 then del(.hooks) else . end
          else . end' "$SETTINGS" > "$cleaned" 2>/dev/null; then
        FAILED="could not edit the hook settings in $SETTINGS"
      elif [ "$(jq -S . "$SETTINGS")" = "$(jq -S . "$cleaned")" ]; then
        echo "no bridge hooks in $SETTINGS"
      elif ! cp -p "$SETTINGS" "$SETTINGS.bak-$STAMP"; then
        FAILED="cannot back up $SETTINGS"
      elif ! cat "$cleaned" > "$SETTINGS"; then
        FAILED="cannot write $SETTINGS (the old file is in $SETTINGS.bak-$STAMP)"
      else
        echo "removed the bridge hooks from $SETTINGS (backup: $SETTINGS.bak-$STAMP)"
      fi
    else
      echo "$SETTINGS is not a JSON object; left it alone"
    fi
  else
    echo "no $SETTINGS; no hooks to remove"
  fi

  if [ -f "$cfg" ]; then
    rm -f "$cfg" || die "cannot delete $cfg"
    echo "deleted $cfg"
  fi
  if [ -n "$FAILED" ]; then
    echo "bridge-install: $FAILED. Left $hook in place (the hooks in settings.json still point at it; with no config.env it does nothing). Fix $SETTINGS or take the bridge hooks out of it by hand, then run --leave again to finish." >&2
    exit 2
  fi
  if [ -f "$hook" ]; then
    rm -f "$hook" || die "cannot delete $hook"
    echo "deleted $hook"
  fi
  exit 0
}

[ "$LEAVE" = 0 ] || leave_bridge
check_basics
# The environment overrides config.env in the hook, so a BRIDGE_KEY here would keep a joined
# machine on that other key. Refuse before touching anything or calling the Worker.
ENV_KEY=0
[ -z "${BRIDGE_KEY:-}" ] || ENV_KEY=1
env_key_message() {
  echo "bridge-install: BRIDGE_KEY is set in the environment. It overrides the key in config.env, so this machine would keep using it after joining. Unset it and take it out of your shell profile, then run this again." >&2
}
if [ "$ENV_KEY" = 1 ] && [ "$DRY" = 0 ]; then
  env_key_message
  exit 2
fi
NAME="$(machine_name)"
copy_hook
merge_settings
if [ "$DRY" = 1 ]; then
  echo "would check any existing key, then join as $NAME"
  echo "would join as $NAME"
  if [ "$ENV_KEY" = 1 ]; then
    echo "would refuse to run: BRIDGE_KEY is set in the environment"
    env_key_message
    exit 2
  fi
  exit 0
fi
check_existing_key
join_bridge
