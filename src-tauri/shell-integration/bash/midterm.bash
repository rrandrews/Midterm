# Midterm shell integration for bash.
#
# Midterm starts bash as `bash --rcfile <this file>`, an interactive
# non-login shell, so this file is read instead of ~/.bashrc. (Over ssh it
# is loaded differently, into a real login shell: see MIDTERM_BASH_LOAD.) Midterm wants a
# login shell, so the first thing it does is read the startup files a login
# shell reads: /etc/profile, then the first readable one of ~/.bash_profile,
# ~/.bash_login and ~/.profile. (Whether those go on to read ~/.bashrc is up
# to them, exactly as in a login shell.)
#
# Must work with bash 3.2, which macOS ships as /bin/bash.
#
# Hooks:
#   _midterm_prompt_command  before each prompt (first in PROMPT_COMMAND):
#                            OSC 133;D;<status> (only after a C), OSC 6973
#                            (PATH, only when changed), OSC 7, OSC 133;A
#   _midterm_prompt_end      last in PROMPT_COMMAND: OSC 6973 again if the
#                            user's hooks (direnv) changed PATH, moves
#                            OSC 133;B to the end of PS1 and arms
#                            _midterm_debug_trap
#   _midterm_debug_trap      DEBUG trap: OSC 133;C before the first command
#                            of a command line, then the user's own trap
#
# C comes from a DEBUG trap rather than PS0 in every bash version: PS0 needs
# bash 4.4, the trap works everywhere. Limitations:
# - The trap fires only before simple commands (and for/case/select/((...))),
#   so a command line that is only a subshell, like `(make)`, gets no C, and
#   then no D either.
# - A DEBUG trap set by the user's startup files is chained; one set later
#   replaces ours, which only stops C (and so D). Tools that install theirs
#   lazily at the first prompt (bash-preexec) do the same.
# - Commands run from `bind -x` key bindings at the prompt emit a C.
# - A hook that is later put in front of ours in PROMPT_COMMAND emits a C at
#   every prompt.

# Load once per shell, even if sourced again.
if [ -z "${_midterm_si_loaded-}" ]; then
_midterm_si_loaded=1

# Returns $1: ends a run of commands with a status of our choosing.
_midterm_return() { builtin return "$1"; }
# Returns the status it was called with, so later PROMPT_COMMAND hooks still
# see the command's.
_midterm_keep_status() { builtin return $?; }

if [ -n "${MIDTERM_BASH_LOAD-}" ]; then
  # Over ssh (ssh/bootstrap.sh) bash is a real login shell (`bash -l`): it
  # has read its startup files and runs this from MIDTERM_BASH_SCRIPT via
  # the PROMPT_COMMAND entry MIDTERM_BASH_LOAD, at the first prompt. That
  # entry becomes a no-op that keeps `$?`, and nothing stays exported.
  _midterm_si_status=$?
  _midterm_si_late=1
  [[ $PROMPT_COMMAND == *"$MIDTERM_BASH_LOAD" ]] && _midterm_si_late=last
  PROMPT_COMMAND=${PROMPT_COMMAND//"$MIDTERM_BASH_LOAD"/_midterm_keep_status}
  builtin export -n PROMPT_COMMAND MIDTERM_BASH_SCRIPT
  builtin unset MIDTERM_BASH_LOAD MIDTERM_BASH_SCRIPT
else
  if [ -r /etc/profile ]; then
    builtin source /etc/profile
  fi
  for _midterm_si_file in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [ -r "$_midterm_si_file" ]; then
      builtin source "$_midterm_si_file"
      break
    fi
  done
  builtin unset _midterm_si_file
fi

# The workspace's default Python environment (MIDTERM_PYTHON_VENV: a venv
# directory, MIDTERM_PYTHON_CONDA: a conda environment name), activated once
# here: the startup files have run, the hooks below are not in place yet, so
# the `(venv)` prefix the activate script adds to PS1 is there before
# _midterm_prompt_end appends OSC 133;B. Never ends the startup, even under
# `set -e` from the user's files (hence the `|| :`).
_midterm_activate_python() {
  if [ -n "${MIDTERM_PYTHON_VENV-}" ]; then
    if [ -r "$MIDTERM_PYTHON_VENV/bin/activate" ]; then
      builtin source "$MIDTERM_PYTHON_VENV/bin/activate" || :
    fi
  elif [ -n "${MIDTERM_PYTHON_CONDA-}" ]; then
    if builtin declare -F conda >/dev/null || command -v conda >/dev/null 2>&1; then
      conda activate "$MIDTERM_PYTHON_CONDA" 2>/dev/null || :
    fi
  fi
  builtin unset MIDTERM_PYTHON_VENV MIDTERM_PYTHON_CONDA
  builtin return 0
}
_midterm_activate_python
builtin unset -f _midterm_activate_python

# `ssh host` loads this integration on the remote too (see the zsh script):
# an `ssh` function adds the remote command for plain interactive logins,
# unless the user's startup files defined their own.
if [ -n "${MIDTERM_SSH_DIR-}" ]; then
  _midterm_ssh_dir=$MIDTERM_SSH_DIR
  builtin unset MIDTERM_SSH_DIR
  if ! builtin declare -F ssh >/dev/null; then
    ssh() {
      if command sh "$_midterm_ssh_dir/should-wrap.sh" "$@"; then
        command ssh -t "$@" "$(<"$_midterm_ssh_dir/remote-command")"
      else
        command ssh "$@"
      fi
    }
  fi
fi

# Percent-encodes $1 byte by byte for a file:// URL into _midterm_encoded.
_midterm_urlencode() {
  local LC_ALL=C
  local s=$1 c n i
  if [[ $s != *[!A-Za-z0-9/._~-]* ]]; then
    _midterm_encoded=$s
    builtin return
  fi
  _midterm_encoded=
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9/._~-]) _midterm_encoded+=$c ;;
      *)
        builtin printf -v n '%d' "'$c"
        # bash 3.2 sign-extends bytes above 0x7f.
        (( n < 0 )) && (( n += 256 ))
        builtin printf -v c '%%%02X' "$n"
        _midterm_encoded+=$c
        ;;
    esac
  done
}

# OSC 7: tells the terminal the shell's working directory.
_midterm_report_cwd() {
  _midterm_urlencode "$PWD"
  builtin printf '\033]7;file://%s%s\007' "${HOSTNAME-}" "$_midterm_encoded"
}

# OSC 6973 (Midterm's own): tells the terminal the shell's PATH, for command
# completion, when it differs from the last one reported.
_midterm_report_path() {
  [[ -n ${_midterm_reported_path+set} && ${PATH-} == "$_midterm_reported_path" ]] && builtin return
  _midterm_reported_path=${PATH-}
  _midterm_urlencode "${PATH-}"
  builtin printf '\033]6973;path=%s;aid=%s\007' "$_midterm_encoded" "$_midterm_aid"
}

# OSC 133 state: _midterm_ran is set once a C has been emitted for the
# current command line (so the next prompt emits D), _midterm_armed from the
# end of PROMPT_COMMAND until the first command of the next command line.
_midterm_ran=
_midterm_armed=
# This shell's id in its marks (`aid=`), so the terminal can tell them from
# the marks of a shell nested inside it (over ssh).
_midterm_aid=$$.$RANDOM
# OSC 133;B, wrapped in \[ \] so that bash does not count it as visible.
_midterm_mark_b='\[\e]133;B;aid='"$_midterm_aid"'\a\]'

_midterm_prompt_command() {
  local ret=$?  # exit status of the last command, for OSC 133;D
  _midterm_armed=
  if [[ -n $_midterm_ran ]]; then
    _midterm_ran=
    builtin printf '\033]133;D;%s;aid=%s\007' "$ret" "$_midterm_aid"
  fi
  _midterm_report_path
  _midterm_report_cwd
  builtin printf '\033]133;A;aid=%s\007' "$_midterm_aid"
  # Pass the status on to the user's hooks, except under errexit, where a
  # failing hook would end the shell.
  [[ $- == *e* ]] && builtin return 0
  builtin return $ret
}

# Runs last, after whatever the user's hooks did to PS1 (themes rebuild it at
# every prompt), and moves the B mark to the end of PS1. Passes the status on
# to the prompt, where `\$?` sees it.
_midterm_prompt_end() {
  local ret=$?
  _midterm_report_path
  PS1=${PS1//"$_midterm_mark_b"/}$_midterm_mark_b
  _midterm_armed=1
  [[ $- == *e* ]] && builtin return 0
  builtin return $ret
}

# The DEBUG trap runs before every simple command, including the ones
# PROMPT_COMMAND runs, but not inside functions (unless functrace is on). It
# emits C before the first command after the prompt only.
#
# Chained to a user trap, it is called as `_midterm_debug_trap chain "$_"`:
# the last argument leaves `$_` unchanged for the user's trap, and the return
# value passes `$?` on to it. Alone it returns 0, as under extdebug a
# non-zero status would skip the command. (bash restores `$?` and `$_` after
# the trap either way.)
_midterm_debug_trap() {
  local ret=$?
  if [[ -n $_midterm_armed ]]; then
    if [[ $BASH_COMMAND == _midterm_prompt_command* ]]; then
      # Nothing ran: an empty line, ^C, or a line the trap never saw.
      _midterm_armed=
    elif (( ${#FUNCNAME[@]} <= 1 )); then
      # (Under functrace the trap also fires inside functions, ours too.)
      _midterm_armed=
      _midterm_ran=1
      builtin printf '\033]133;C;aid=%s\007' "$_midterm_aid"
    fi
  fi
  [[ ${1-} == chain ]] && builtin return $ret
  builtin return 0
}

# _midterm_prompt_command runs first, so that it sees the command's exit
# status, and passes that status on to whatever the user's PROMPT_COMMAND
# does after it; _midterm_prompt_end runs last. bash 5.1+ runs every element
# of a PROMPT_COMMAND array; older versions only run the first, which the
# string assignment below extends (other elements are kept).
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) &&
  [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=(_midterm_prompt_command "${PROMPT_COMMAND[@]}" _midterm_prompt_end)
else
  PROMPT_COMMAND="_midterm_prompt_command${PROMPT_COMMAND:+
$PROMPT_COMMAND}
_midterm_prompt_end"
fi

# Chains the DEBUG trap the user's startup files set, if any. `trap -p`
# prints `trap -- '<command>' DEBUG`; evaluating its arguments gives the
# command back unquoted.
_midterm_capture_trap() { _midterm_user_trap=$2; }
_midterm_user_trap=
_midterm_si_trap=$(builtin trap -p DEBUG)
if [[ -n $_midterm_si_trap ]]; then
  builtin eval "_midterm_capture_trap ${_midterm_si_trap#trap }"
fi
if [[ -n $_midterm_user_trap ]]; then
  builtin trap -- "_midterm_debug_trap chain \"\$_\"
$_midterm_user_trap" DEBUG
else
  builtin trap -- _midterm_debug_trap DEBUG
fi
builtin unset _midterm_si_trap _midterm_user_trap
builtin unset -f _midterm_capture_trap

# Loaded at the first prompt (over ssh): mark this prompt now. It is armed
# for the command typed at it only when nothing else of PROMPT_COMMAND runs
# after this, or the DEBUG trap would take that for the command.
# _midterm_prompt_end, which arms the trap, must be the very last command.
if [ -n "${_midterm_si_late-}" ]; then
  _midterm_return "$_midterm_si_status"
  _midterm_prompt_command
  if [ "$_midterm_si_late" = last ]; then
    builtin unset _midterm_si_late
    _midterm_return "$_midterm_si_status"
    _midterm_prompt_end
  else
    builtin unset _midterm_si_late
    PS1=${PS1//"$_midterm_mark_b"/}$_midterm_mark_b
    _midterm_return "$_midterm_si_status"
  fi
fi

fi
