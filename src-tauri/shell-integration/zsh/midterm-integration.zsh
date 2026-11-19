# Midterm shell integration for zsh. Sourced by the bootstrap .zshenv in
# interactive shells, after the user's own .zshenv.
#
# Hooks:
#   _midterm_precmd   before each prompt
#   _midterm_preexec  before each command line runs
# OSC 133 prompt marks (A/B before and after the prompt, C in preexec,
# D;<status> in precmd) slot into these two functions.

# Load once per shell, even if sourced again.
(( ${+_midterm_si_loaded} )) && builtin return 0
builtin typeset -g _midterm_si_loaded=1

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

_midterm_precmd() {
  builtin local ret=$?  # exit status of the last command, for OSC 133;D
  _midterm_report_cwd
  # Pass the status on to later hooks, except under errexit, where a
  # failing hook would end the shell.
  [[ -o errexit ]] && builtin return 0
  builtin return ret
}

_midterm_preexec() {
  :
}

# The hooks are put in place at the first prompt rather than now: the user's
# .zprofile/.zshrc have not run yet and may add hooks of their own. Ours go
# first so they see the command's exit status.
_midterm_deferred_init() {
  builtin emulate -L zsh
  precmd_functions=(${precmd_functions:#_midterm_deferred_init})
  precmd_functions=(_midterm_precmd ${precmd_functions:#_midterm_precmd})
  preexec_functions=(_midterm_preexec ${preexec_functions:#_midterm_preexec})
  builtin unfunction _midterm_deferred_init
  _midterm_precmd
}

builtin typeset -ga precmd_functions
precmd_functions+=(_midterm_deferred_init)
