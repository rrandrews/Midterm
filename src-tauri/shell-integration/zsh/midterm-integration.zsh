# Midterm shell integration for zsh. Sourced by the bootstrap .zshenv in
# interactive shells, after the user's own .zshenv.
#
# Hooks:
#   _midterm_precmd      before each prompt, first in precmd_functions:
#                        OSC 133;D;<status> (only after a C), OSC 6973
#                        (PATH, only when changed), OSC 7, OSC 133;A
#   _midterm_prompt_end  last in precmd_functions, after whatever the
#                        user's hooks (themes, direnv) did: OSC 6973 again
#                        if PATH changed, moves OSC 133;B to the end of PS1
#   _midterm_preexec     before each command line runs: OSC 133;C
#
# Limitations: B is left out when prompt_percent is off (zsh could not tell
# it is zero-width). A precmd hook added while a prompt is being prepared
# only comes after _midterm_prompt_end until the next prompt. If the user's
# startup files define a `precmd` function, B on the first prompt can be
# lost to hooks that rewrite PS1 (see _midterm_deferred_init).

# Load once per shell, even if sourced again.
(( ${+_midterm_si_loaded} )) && builtin return 0
builtin typeset -g _midterm_si_loaded=1

# This shell's id in its marks (`aid=`), so the terminal can tell them from
# the marks of a shell nested inside it (over ssh). Digits and a dot only:
# it goes into PS1 below.
builtin typeset -g _midterm_aid=$$.$RANDOM

# Percent-encodes $1 byte by byte for a file:// URL and stores it in REPLY.
_midterm_urlencode() {
  builtin emulate -L zsh
  builtin local LC_ALL=C
  builtin local s=$1 c
  REPLY=
  if [[ $s != *[^A-Za-z0-9/._~-]* ]]; then
    REPLY=$s
    builtin return
  fi
  builtin local -i i
  for (( i = 1; i <= $#s; i++ )); do
    c=$s[i]
    if [[ $c == [A-Za-z0-9/._~-] ]]; then
      REPLY+=$c
    else
      REPLY+=%${(l:2::0:)$(( [##16] #c ))}
    fi
  done
}

# OSC 7: tells the terminal the shell's working directory.
_midterm_report_cwd() {
  builtin emulate -L zsh
  builtin local REPLY
  _midterm_urlencode $PWD
  builtin print -rn -- $'\e]7;file://'"${HOST}${REPLY}"$'\a'
}

# OSC 6973 (Midterm's own): tells the terminal the shell's PATH, for command
# completion, when it differs from the last one reported.
_midterm_report_path() {
  builtin emulate -L zsh
  (( ${+_midterm_reported_path} )) && [[ $PATH == "$_midterm_reported_path" ]] && builtin return
  builtin typeset -g _midterm_reported_path=$PATH
  builtin local REPLY
  _midterm_urlencode $PATH
  builtin print -rn -- $'\e]6973;path='"${REPLY};aid=$_midterm_aid"$'\a'
}

# Set by preexec once a C has been emitted, so that the next prompt emits D
# (none after an empty line or ^C at the prompt).
builtin typeset -gi _midterm_ran=0

# OSC 133;D;$1 if a command ran, OSC 7 and OSC 133;A; then makes sure
# _midterm_prompt_end is still the last precmd hook.
_midterm_prompt_start() {
  builtin emulate -L zsh
  if (( _midterm_ran )); then
    _midterm_ran=0
    builtin print -rn -- $'\e]133;D;'"$1;aid=$_midterm_aid"$'\a'
  fi
  _midterm_report_path
  _midterm_report_cwd
  builtin print -rn -- $'\e]133;A;aid='"$_midterm_aid"$'\a'
  if [[ ${precmd_functions[-1]-} != _midterm_prompt_end ]]; then
    precmd_functions=(${precmd_functions:#_midterm_prompt_end} _midterm_prompt_end)
  fi
}

_midterm_precmd() {
  builtin local ret=$?  # exit status of the last command, for OSC 133;D
  _midterm_prompt_start $ret
  # Pass the status on to later hooks, except under errexit, where a
  # failing hook would end the shell.
  [[ -o errexit ]] && builtin return 0
  builtin return ret
}

# Appends OSC 133;B to PS1, removing any copy an earlier prompt left in it.
# The mark is plain bytes (no `$`, backslash, backquote or `!`), so
# prompt_subst and prompt_bang leave it alone; %{ %} makes it zero-width.
_midterm_prompt_end() {
  builtin local ret=$?
  _midterm_report_path
  builtin local mark=$'%{\e]133;B;aid='"$_midterm_aid"$'\a%}'
  PS1=${PS1//"$mark"/}
  [[ -o prompt_percent ]] && PS1+=$mark
  [[ -o errexit ]] && builtin return 0
  builtin return ret
}

_midterm_preexec() {
  _midterm_ran=1
  builtin print -rn -- $'\e]133;C;aid='"$_midterm_aid"$'\a'
}

# `ssh host` loads this integration on the remote too, so its commands get
# blocks of their own: when Midterm asks for it (MIDTERM_SSH_DIR), an `ssh`
# function adds the remote command for plain interactive logins
# (ssh/should-wrap.sh decides). A function of the user's, defined later in
# .zshrc, replaces it; `command ssh` skips it.
if [[ -n ${MIDTERM_SSH_DIR-} ]]; then
  builtin typeset -g _midterm_ssh_dir=$MIDTERM_SSH_DIR
  builtin unset MIDTERM_SSH_DIR
  if (( ! ${+functions[ssh]} )); then
    ssh() {
      if command sh "$_midterm_ssh_dir/should-wrap.sh" "$@"; then
        command ssh -t "$@" "$(<"$_midterm_ssh_dir/remote-command")"
      else
        command ssh "$@"
      fi
    }
  fi
fi

# The workspace's default Python environment (MIDTERM_PYTHON_VENV: a venv
# directory, MIDTERM_PYTHON_CONDA: a conda environment name) is activated
# once, at the first prompt, so after the user's startup files (macOS's
# path_helper and rc files put PATH in order meanwhile). It runs before the
# hooks below touch PS1, so the `(venv)` prefix the activate script adds
# comes before OSC 133;B, which _midterm_prompt_end puts at the end. Run
# with zsh's own defaults, whatever options the user's files set, and it
# never ends the startup.
_midterm_activate_python() {
  builtin emulate -L zsh
  if [[ -n ${MIDTERM_PYTHON_VENV-} ]]; then
    [[ -r $MIDTERM_PYTHON_VENV/bin/activate ]] &&
      builtin source -- "$MIDTERM_PYTHON_VENV/bin/activate"
  elif [[ -n ${MIDTERM_PYTHON_CONDA-} ]]; then
    (( ${+functions[conda]} )) || (( ${+commands[conda]} )) &&
      conda activate "$MIDTERM_PYTHON_CONDA" 2>/dev/null
  fi
  builtin unset MIDTERM_PYTHON_VENV MIDTERM_PYTHON_CONDA
  builtin return 0
}

# The hooks are put in place at the first prompt rather than now: the user's
# .zprofile/.zshrc have not run yet and may add hooks of their own.
# _midterm_precmd goes first so that it sees the command's exit status,
# _midterm_prompt_end last.
#
# zsh runs a function named `precmd` and then a copy of precmd_functions.
# Run from our temporary `precmd`, this comes before the copy is made, so the
# hooks run in the right order at the first prompt already. If the user's
# startup files defined their own `precmd`, it is run from precmd_functions
# instead, where the copy is already made: then the hooks are called directly
# and hooks after it may still rewrite PS1 for that one prompt.
_midterm_deferred_init() {
  builtin emulate -L zsh
  _midterm_activate_python
  builtin unfunction _midterm_activate_python
  precmd_functions=(${precmd_functions:#_midterm_deferred_init})
  precmd_functions=(_midterm_precmd ${precmd_functions:#(_midterm_precmd|_midterm_prompt_end)} _midterm_prompt_end)
  preexec_functions=(_midterm_preexec ${preexec_functions:#_midterm_preexec})
  if [[ ${functions[precmd]-} == *_midterm_deferred_init* ]]; then
    builtin unfunction precmd
  fi
  builtin unfunction _midterm_deferred_init
  if [[ ${1-} != from-precmd ]]; then
    _midterm_precmd
    _midterm_prompt_end
  fi
}

builtin typeset -ga precmd_functions
precmd_functions+=(_midterm_deferred_init)
if (( ! ${+functions[precmd]} )); then
  precmd() { _midterm_deferred_init from-precmd }
fi
