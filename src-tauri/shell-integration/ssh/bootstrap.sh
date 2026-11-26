# Midterm shell integration over ssh: stage 1, run on the remote host.
#
# integration.rs fills in the four scripts below (comments and blank lines
# stripped), base64-encodes the result and wraps it in stage 0, a one-line
# `sh -c '…'` that decodes and evals it; that line is the remote command the
# local `ssh` function appends. This must stay POSIX sh: it runs under
# whatever /bin/sh the remote has.
#
# zsh and fish: it writes only that shell's scripts to a private temporary
# directory (mktemp -d makes it 0700), which the scripts delete again once
# loaded (MIDTERM_SI_EPHEMERAL), sets up the shell as integration.rs does
# locally and execs it as a login shell. bash: no files; the script travels
# in MIDTERM_BASH_SCRIPT and a PROMPT_COMMAND entry loads it at the first
# prompt of a real login shell (`bash -l`: login_shell set, ~/.bash_logout
# read), after its startup files. If those replace PROMPT_COMMAND rather
# than add to it, the shell is simply plain. An unknown shell, fish before
# 3.0 or a failing mktemp gets a plain login shell. Nothing is written
# anywhere else and no startup file of the user's is touched.

# Optional initial directory (base64-encoded by direct-SSH pane spawn).
# Fails closed rather than silently starting in the wrong directory.
if [ -n "${MIDTERM_REMOTE_CD-}" ]; then
  _midterm_cd=$( (printf %s "$MIDTERM_REMOTE_CD" | base64 -d || printf %s "$MIDTERM_REMOTE_CD" | base64 -D || printf %s "$MIDTERM_REMOTE_CD" | openssl base64 -d -A) 2>/dev/null && printf X )
  case $_midterm_cd in
    *X)
      _midterm_cd=${_midterm_cd%X}
      if [ -n "$_midterm_cd" ] && ! cd -- "$_midterm_cd"; then
        printf 'midterm: cannot change remote directory to %s\n' "$_midterm_cd" >&2
        exit 1
      fi
      ;;
    *)
      printf 'midterm: invalid remote directory encoding\n' >&2
      exit 1
      ;;
  esac
  unset MIDTERM_REMOTE_CD _midterm_cd
fi

# sshd prints the message of the day only for sessions without a command.
if [ ! -e "$HOME/.hushlogin" ] && [ -r /etc/motd ]; then
  cat /etc/motd
fi

_midterm_shell=${SHELL:-/bin/sh}
_midterm_plain_enc() {
  _mt_enc=
  _mt_s=$1
  case $_mt_s in
    *[!A-Za-z0-9/._~-]*)
      _mt_hex=$(LC_ALL=C printf '%s' "$_mt_s" | od -An -tx1 -v | tr -s ' \t\r\n' ' ')
      for _mt_b in $_mt_hex; do
        case $_mt_b in
          2[de]|2f|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e)
            _mt_c=$(printf "\\$(printf '%03o' "0x$_mt_b")")
            _mt_enc="${_mt_enc}${_mt_c}"
            ;;
          *)
            _mt_u=$(printf '%s' "$_mt_b" | tr 'a-f' 'A-F')
            _mt_enc="${_mt_enc}%${_mt_u}"
            ;;
        esac
      done
      ;;
    *) _mt_enc=$_mt_s ;;
  esac
}
_midterm_plain() {
  # Emit a one-time OSC 7 and OSC 6974 metadata report so Explorer/Editor still
  # open at the remote working directory even when the remote shell is plain.
  _midterm_host=$(hostname 2>/dev/null || :)
  _midterm_plain_enc "$_midterm_host"; _mt_ehost=$_mt_enc
  _midterm_plain_enc "${_midterm_shell##*/}"; _mt_esh=$_mt_enc
  if [ -n "${PWD-}" ]; then
    _midterm_plain_enc "$PWD"; _mt_epwd=$_mt_enc
    printf '\033]7;file://%s%s\007' "$_mt_ehost" "$_mt_epwd"
  fi
  if [ -n "${HOME-}" ]; then
    _midterm_plain_enc "$HOME"; _mt_ehome=$_mt_enc
    printf '\033]6974;meta=1;home=%s;shell=%s\007' "$_mt_ehome" "$_mt_esh"
  fi
  unset _midterm_host _mt_enc _mt_s _mt_hex _mt_b _mt_c _mt_u _mt_ehost _mt_esh _mt_epwd _mt_ehome
  exec "$_midterm_shell" -l
}

case ${_midterm_shell##*/} in
  zsh) ;;
  bash)
    # A heredoc in a function, not inside $( ): bash 3.2 (a macOS /bin/sh)
    # misreads the script's case patterns there.
    _midterm_bash_script() {
      cat <<'MIDTERM_SI_BASH'
@BASH@
MIDTERM_SI_BASH
    }
    MIDTERM_BASH_SCRIPT=$(_midterm_bash_script)
    MIDTERM_BASH_LOAD='eval "$MIDTERM_BASH_SCRIPT"'
    _midterm_nl='
'
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$_midterm_nl}$MIDTERM_BASH_LOAD"
    export MIDTERM_BASH_SCRIPT MIDTERM_BASH_LOAD PROMPT_COMMAND
    export MIDTERM_SHELL_INTEGRATION=1
    exec "$_midterm_shell" -l
    ;;
  fish)
    # `string escape --style=url` (OSC 7) needs fish 3.
    _midterm_v=$("$_midterm_shell" --version 2>/dev/null)
    _midterm_v=${_midterm_v##*version }
    _midterm_v=${_midterm_v%%.*}
    case $_midterm_v in
      '' | *[!0-9]*) _midterm_plain ;;
    esac
    [ "$_midterm_v" -ge 3 ] || _midterm_plain
    ;;
  *) _midterm_plain ;;
esac

_midterm_d=$(mktemp -d "${TMPDIR:-/tmp}/midterm-si.XXXXXX" 2>/dev/null) || _midterm_plain
[ -d "$_midterm_d" ] || _midterm_plain
# fish's XDG_DATA_DIRS entry cannot hold a colon.
case $_midterm_d in
  *:*)
    rmdir "$_midterm_d"
    _midterm_plain
    ;;
esac
export MIDTERM_SI_EPHEMERAL="$_midterm_d"
export MIDTERM_SHELL_INTEGRATION=1

case ${_midterm_shell##*/} in
  zsh)
    mkdir "$_midterm_d/zsh" || _midterm_plain
    cat >"$_midterm_d/zsh/.zshenv" <<'MIDTERM_SI_ZSHENV'
@ZSHENV@
MIDTERM_SI_ZSHENV
    cat >"$_midterm_d/zsh/midterm-integration.zsh" <<'MIDTERM_SI_ZSH'
@ZSH@
MIDTERM_SI_ZSH
    if [ -n "${ZDOTDIR+set}" ]; then
      export MIDTERM_ZSH_ZDOTDIR="$ZDOTDIR"
    else
      unset MIDTERM_ZSH_ZDOTDIR
    fi
    export ZDOTDIR="$_midterm_d/zsh"
    exec "$_midterm_shell" -l
    ;;
  fish)
    mkdir -p "$_midterm_d/fish/vendor_conf.d" || _midterm_plain
    cat >"$_midterm_d/fish/vendor_conf.d/midterm.fish" <<'MIDTERM_SI_FISH'
@FISH@
MIDTERM_SI_FISH
    if [ -n "${XDG_DATA_DIRS-}" ]; then
      unset MIDTERM_FISH_XDG_DATA_DIRS_UNSET
      export XDG_DATA_DIRS="$_midterm_d:$XDG_DATA_DIRS"
    else
      export MIDTERM_FISH_XDG_DATA_DIRS_UNSET=1
      export XDG_DATA_DIRS="$_midterm_d:/usr/local/share:/usr/share"
    fi
    export MIDTERM_FISH_DATA_DIR="$_midterm_d"
    exec "$_midterm_shell" -l
    ;;
esac
_midterm_plain
