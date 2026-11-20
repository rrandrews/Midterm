# Midterm shell integration: zsh bootstrap.
#
# Midterm starts zsh with ZDOTDIR pointing at this directory so that this
# file is read instead of the user's .zshenv. It puts ZDOTDIR back the way it
# was, so every later startup file (.zprofile, .zshrc, .zlogin) and the
# history file come from the user's own directory, sources the user's real
# .zshenv and then loads the integration for interactive shells.
#
# Nothing in here may assume any option is set: it runs before the user's
# configuration, under whatever options zsh starts with.
#
# Started over ssh (MIDTERM_SI_EPHEMERAL, see ssh/bootstrap.sh), this
# directory is a temporary one: both files are deleted once loaded.

_midterm_si_dir=$ZDOTDIR

if [[ -n ${MIDTERM_ZSH_ZDOTDIR+set} ]]; then
  ZDOTDIR=$MIDTERM_ZSH_ZDOTDIR  # still exported: it came from the environment
  builtin unset MIDTERM_ZSH_ZDOTDIR
else
  builtin unset ZDOTDIR
fi

{
  # zsh falls back to $HOME when ZDOTDIR is unset (but not when it is empty).
  _midterm_si_file=${ZDOTDIR-$HOME}/.zshenv
  [[ ! -r $_midterm_si_file ]] || builtin source -- "$_midterm_si_file"
} always {
  if [[ -o interactive && -r $_midterm_si_dir/midterm-integration.zsh ]]; then
    builtin source -- "$_midterm_si_dir/midterm-integration.zsh"
  fi
  if [[ -n ${MIDTERM_SI_EPHEMERAL-} ]]; then
    command rm -f -- "$_midterm_si_dir/.zshenv" "$_midterm_si_dir/midterm-integration.zsh"
    command rmdir -- "$_midterm_si_dir" "$MIDTERM_SI_EPHEMERAL" 2>/dev/null
    builtin unset MIDTERM_SI_EPHEMERAL
  fi
  builtin unset _midterm_si_dir _midterm_si_file
}
