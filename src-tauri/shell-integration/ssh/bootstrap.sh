# Midterm shell integration over ssh: stage 1, run on the remote host.
#
# integration.rs fills in the four scripts below (comments and blank lines
# stripped), base64-encodes the result and wraps it in stage 0, a one-line
# `sh -c '…'` that decodes and evals it; that line is the remote command the
# local `ssh` function appends. This must stay POSIX sh: it runs under
# whatever /bin/sh the remote has.
#
# It writes only the remote shell's scripts to a private temporary
# directory, which the scripts delete again once loaded
# (MIDTERM_SI_EPHEMERAL), sets up the shell exactly as integration.rs does
# locally and execs it as a login shell. An unknown shell, fish before 3.0
# or a failing mktemp gets a plain login shell instead. Nothing is written
# anywhere else and no startup file of the user's is touched.

# sshd prints the message of the day only for sessions without a command.
if [ ! -e "$HOME/.hushlogin" ] && [ -r /etc/motd ]; then
  cat /etc/motd
fi

_midterm_shell=${SHELL:-/bin/sh}
_midterm_plain() {
  exec "$_midterm_shell" -l
}

case ${_midterm_shell##*/} in
  zsh | bash) ;;
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

umask 077
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
  bash)
    mkdir "$_midterm_d/bash" || _midterm_plain
    cat >"$_midterm_d/bash/midterm.bash" <<'MIDTERM_SI_BASH'
@BASH@
MIDTERM_SI_BASH
    exec "$_midterm_shell" --rcfile "$_midterm_d/bash/midterm.bash"
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
