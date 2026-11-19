# Midterm shell integration for bash.
#
# Midterm starts bash as `bash --rcfile <this file>`, an interactive
# non-login shell, so this file is read instead of ~/.bashrc. Midterm wants a
# login shell, so the first thing it does is read the startup files a login
# shell reads: /etc/profile, then the first readable one of ~/.bash_profile,
# ~/.bash_login and ~/.profile. (Whether those go on to read ~/.bashrc is up
# to them, exactly as in a login shell.)
#
# Must work with bash 3.2, which macOS ships as /bin/bash.
#
# Hooks:
#   _midterm_prompt_command  before each prompt (first in PROMPT_COMMAND)
# OSC 133 prompt marks go in there (D;<status> from `ret`, A before the
# prompt), plus a preexec mechanism (DEBUG trap or PS0) for C.

# Load once per shell, even if sourced again.
if [ -z "${_midterm_si_loaded-}" ]; then
_midterm_si_loaded=1

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

_midterm_prompt_command() {
  local ret=$?  # exit status of the last command, for OSC 133;D
  _midterm_report_cwd
  builtin return $ret
}

# Runs first, so that it sees the command's exit status, and passes that
# status on to whatever the user's PROMPT_COMMAND does after it. bash 5.1+
# runs every element of a PROMPT_COMMAND array; older versions only run the
# first, which the string assignment below extends (other elements are kept).
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) &&
  [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=(_midterm_prompt_command "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="_midterm_prompt_command${PROMPT_COMMAND:+
$PROMPT_COMMAND}"
fi

fi
