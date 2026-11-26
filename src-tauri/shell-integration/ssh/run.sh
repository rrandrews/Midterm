# Midterm shell integration: local wrapper for interactive `ssh` sessions.
#
# Invoked by the `ssh` shell function (zsh, bash, fish) with:
#   MIDTERM_RUN_SOCK_DIR=<private 0700 socket dir>
#   MIDTERM_RUN_TOKEN=<per-PTY secret token>
#   sh <this file> <original ssh args...>
#
# Responsibilities:
# 1. Delegates to should-wrap.sh: anything other than a plain interactive login
#    runs `ssh "$@"` completely unchanged.
# 2. Resolves effective host/user/port/proxy/identities/controlpath via `ssh -G`.
# 3. Ensures OpenSSH ControlMaster multiplexing is active (reusing the user's
#    own ControlPath/ControlMaster when configured, otherwise creating a short
#    Midterm-owned socket inside MIDTERM_RUN_SOCK_DIR isolated by full auth
#    context).
# 4. Emits token-authenticated OSC 6974;ssh=start before `ssh` and
#    OSC 6974;ssh=end after `ssh` exits, preserving its exit status.
#
# POSIX sh only.

_dir=${0%/*}
_sock_dir=${MIDTERM_RUN_SOCK_DIR-}
_token=${MIDTERM_RUN_TOKEN-}
unset MIDTERM_RUN_SOCK_DIR MIDTERM_RUN_TOKEN

if ! sh "$_dir/should-wrap.sh" "$@"; then
  exec ssh "$@"
fi

_remote_cmd=$(cat "$_dir/remote-command")

# Without a socket directory + PTY token (e.g. minimal standalone integration),
# preserve basic remote shell-integration wrapping only.
if [ -z "$_sock_dir" ] || [ -z "$_token" ]; then
  exec ssh -t "$@" "$_remote_cmd"
fi

_cfg=$(ssh -G "$@" 2>/dev/null) || exec ssh -t "$@" "$_remote_cmd"

# Percent-encodes $1 byte-by-byte into $_ENC (safe for OSC 6974 key=val fields).
_urlencode() {
  _ENC=
  _s=$1
  case $_s in
    *[!A-Za-z0-9/._~:-]*) ;;
    *) _ENC=$_s; return 0 ;;
  esac
  _hex=$(LC_ALL=C printf '%s' "$_s" | od -An -tx1 -v | tr -s ' \t\r\n' ' ')
  for _b in $_hex; do
    case $_b in
      2[de]|2f|3[0-9]|3a|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e)
        _ch=$(printf "\\$(printf '%03o' "0x$_b")")
        _ENC="${_ENC}${_ch}"
        ;;
      *)
        _u=$(printf '%s' "$_b" | tr 'a-f' 'A-F')
        _ENC="${_ENC}%${_u}"
        ;;
    esac
  done
}

# Extracts the first value for key $1 from `ssh -G` output in $_cfg, preserving
# internal whitespace verbatim.
_cfg_get() {
  printf '%s\n' "$_cfg" | sed -n "s/^$1 //p" | head -n 1
}

# Extracts ALL values for key $1 (e.g. multiple identityfile lines) joined by `|`.
_cfg_get_all() {
  printf '%s\n' "$_cfg" | sed -n "s/^$1 //p" | tr '\n' '|'
}

_host=$(_cfg_get hostname)
_user=$(_cfg_get user)
_port=$(_cfg_get port)
_pjump=$(_cfg_get proxyjump)
_pcmd=$(_cfg_get proxycommand)
_cfg_cp=$(_cfg_get controlpath)
_cfg_cm=$(_cfg_get controlmaster | tr '[:upper:]' '[:lower:]')
_identities=$(_cfg_get_all identityfile)
_id_only=$(_cfg_get identitiesonly)
_certs=$(_cfg_get_all certificatefile)
_id_agent=$(_cfg_get identityagent)
_pkcs11=$(_cfg_get pkcs11provider)
_sk_prov=$(_cfg_get securitykeyprovider)
_fwd_agent=$(_cfg_get forwardagent)

[ -n "$_port" ] || _port=22
[ "$_pjump" = "none" ] && _pjump=
[ "$_pcmd" = "none" ] && _pcmd=
[ "$_cfg_cp" = "none" ] && _cfg_cp=

# Walk "$@" once using OpenSSH's option grammar to extract:
# - _dest: the single positional destination
# - _cli_ctrl: whether user explicitly passed -S / -M / -o ControlPath / -o ControlMaster
# - _cli_cpersist: whether user explicitly passed -o ControlPersist=...
# - _safe_csv: comma-separated percent-encoded allowlisted reconnect args
# - _non_replayable: set if any option outside the safe reconnect allowlist may
#   alter routing/config (e.g. -F, -o HostName=..., -o ProxyCommand=...), so
#   direct panes stay multiplex-only instead of reconnecting to a different host
_with_value=BbcDEeFIiJLlmOoPpQRSWw
_dest=
_need_val=
_only_pos=
_cli_ctrl=
_cli_cpersist=
_safe_csv=
_non_replayable=

_append_safe() {
  _urlencode "$1"
  if [ -n "$_safe_csv" ]; then
    _safe_csv="${_safe_csv},${_ENC}"
  else
    _safe_csv="${_ENC}"
  fi
}

_check_o() {
  _ok=$(printf '%s' "$1" | sed 's/[ =].*//' | tr '[:upper:]' '[:lower:]')
  case $_ok in
    controlpath|controlmaster) _cli_ctrl=1 ;;
    controlpersist) _cli_cpersist=1 ;;
    serveraliveinterval|serveralivecountmax|connecttimeout|compression|tcpkeepalive) ;;
    *) _non_replayable=1 ;;
  esac
}

for _arg in "$@"; do
  if [ -n "$_need_val" ]; then
    case $_need_val in
      o) _check_o "$_arg" ;;
      S) _cli_ctrl=1 ;;
      p|l|i|J)
        _append_safe "-$_need_val"
        _append_safe "$_arg"
        ;;
      *) _non_replayable=1 ;;
    esac
    _need_val=
    continue
  fi
  case $_arg in
    --)
      _only_pos=1
      continue
      ;;
    -?*)
      if [ -z "$_only_pos" ]; then
        _rest=${_arg#-}
        while [ -n "$_rest" ]; do
          _ch=${_rest%"${_rest#?}"}
          _rest=${_rest#?}
          case $_ch in
            M|S) _cli_ctrl=1 ;;
            4|6|C) _append_safe "-$_ch" ;;
            t|q|v) ;;
            *)
              case $_with_value in
                *"$_ch"*) ;;
                *) _non_replayable=1 ;;
              esac
              ;;
          esac
          case $_with_value in
            *"$_ch"*)
              if [ -n "$_rest" ]; then
                case $_ch in
                  o) _check_o "$_rest" ;;
                  S) _cli_ctrl=1 ;;
                  p|l|i|J)
                    _append_safe "-$_ch"
                    _append_safe "$_rest"
                    ;;
                  *) _non_replayable=1 ;;
                esac
              else
                _need_val=$_ch
              fi
              _rest=
              ;;
          esac
        done
        continue
      fi
      ;;
  esac
  _dest=$_arg
done

if [ -n "$_non_replayable" ]; then
  _safe_csv=
elif [ -n "$_dest" ]; then
  _append_safe "$_dest"
fi

# Friendly label: destination alias as typed (strip ssh:// scheme if present).
_label=${_dest#ssh://}
[ -n "$_label" ] || _label=$_host

# Deterministic remote_id: <safe-slug>-<12-hex-hash> of canonical endpoint AND
# authentication context so distinct keys/certs/identities never share a master.
_slug_src=${_label##*@}
_slug_src=${_slug_src%%:*}
_slug=$(printf '%s' "$_slug_src" | tr -cd 'A-Za-z0-9._-' | cut -c 1-24 | sed 's/^[.-]*//; s/[.-]*$//')
[ -n "$_slug" ] || _slug=ssh

_key="${_user}@${_host}:${_port}|${_pjump}|${_pcmd}|${_identities}|${_id_only}|${_certs}|${_id_agent}|${_pkcs11}|${_sk_prov}|${_fwd_agent}"
if command -v shasum >/dev/null 2>&1; then
  _hash=$(printf '%s' "$_key" | shasum -a 256 | awk '{print substr($1,1,12)}')
elif command -v sha256sum >/dev/null 2>&1; then
  _hash=$(printf '%s' "$_key" | sha256sum | awk '{print substr($1,1,12)}')
elif command -v openssl >/dev/null 2>&1; then
  _hash=$(printf '%s' "$_key" | openssl dgst -sha256 | awk '{print substr($NF,1,12)}')
else
  _ck=$(printf '%s' "$_key" | cksum | awk '{printf "%08x%04x", $1, $2 % 65536}')
  _hash=$(printf '%s' "$_ck" | cut -c 1-12)
fi
_remote_id="${_slug}-${_hash}"

# Choose ControlPath: reuse user's explicit ControlMaster/ControlPath if valid
# and concrete; otherwise create a short Midterm-owned socket in $_sock_dir.
_use_midterm_ctrl=1
_owned=1
_sock_path="$_sock_dir/s-$_hash"

_is_concrete_path() {
  case $1 in
    /*) case $1 in *%*) return 1 ;; *) return 0 ;; esac ;;
    *) return 1 ;;
  esac
}

if [ -n "$_cli_ctrl" ]; then
  _use_midterm_ctrl=0
  _owned=0
  if _is_concrete_path "$_cfg_cp"; then
    _sock_path=$_cfg_cp
  else
    _sock_path=
  fi
elif _is_concrete_path "$_cfg_cp"; then
  case $_cfg_cm in
    auto|yes|autoask|ask|true)
      _use_midterm_ctrl=0
      _owned=0
      _sock_path=$_cfg_cp
      ;;
  esac
fi

# Emit token-authenticated OSC 6974;ssh=start only when we have a usable socket path.
_announced=0
_emit_end() {
  if [ "$_announced" -eq 1 ]; then
    _announced=0
    printf '\033]6974;ssh=end;id=%s;token=%s\007' "$_remote_id" "$_token"
  fi
}

if [ -n "$_sock_path" ]; then
  _urlencode "$_label"; _e_label=$_ENC
  _urlencode "$_host"; _e_host=$_ENC
  _urlencode "$_user"; _e_user=$_ENC
  _urlencode "$_sock_path"; _e_sock=$_ENC
  printf '\033]6974;ssh=start;id=%s;label=%s;host=%s;user=%s;port=%s;sock=%s;owned=%s;args=%s;token=%s\007' \
    "$_remote_id" "$_e_label" "$_e_host" "$_e_user" "$_port" "$_e_sock" "$_owned" "$_safe_csv" "$_token"
  _announced=1
  trap '_emit_end' EXIT HUP TERM
fi

if [ "$_use_midterm_ctrl" -eq 1 ]; then
  if [ -n "$_cli_cpersist" ]; then
    ssh -t -o ControlMaster=auto -S "$_sock_path" "$@" "$_remote_cmd"
  else
    ssh -t -o ControlMaster=auto -S "$_sock_path" -o ControlPersist=60s "$@" "$_remote_cmd"
  fi
  _rc=$?
else
  ssh -t "$@" "$_remote_cmd"
  _rc=$?
fi

_emit_end
exit "$_rc"
