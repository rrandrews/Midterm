# Midterm shell integration: whether `ssh "$@"` is a plain interactive login
# that the `ssh` function may wrap (exit 0) or must run as is (exit 1).
#
# Run as `sh <this file> <ssh arguments>` by the `ssh` function our zsh,
# bash and fish scripts define. Wrapping appends `-t` and a remote command
# that loads our integration on the remote (see remote-command, made by
# integration.rs), so it is only done when nothing else is asked of ssh:
#
# - stdin and stdout are terminals;
# - exactly one argument is not an option: the destination (options may
#   come before and after it; a second one is a command for the remote);
# - every option is one ssh knows, and none of -N -f -T -W -O -Q -G -V -s
#   -n, -o RemoteCommand=… or -o RequestTTY=no;
# - `ssh -G` shows no RemoteCommand and not RequestTTY no for the host.
#
# Anything this does not recognise runs plain ssh. POSIX sh only.

dir=${0%/*}
[ -r "$dir/remote-command" ] || exit 1
[ -t 0 ] && [ -t 1 ] || exit 1

# Options that take a value, and flags that do not.
with_value=BbcDEeFIiJLlmOoPpQRSWw
flags=46AaCfGgKkMNnqsTtVvXxYy
# Options that ask ssh for something other than an interactive login.
refuse=NfTWOQGVsn

# Checks one -o value (KEY=VALUE or KEY VALUE).
check_option() {
  key=$(printf %s "$1" | sed 's/[ =].*//' | tr '[:upper:]' '[:lower:]')
  value=$(printf %s "$1" | sed 's/^[^ =]*[ =]*//' | tr '[:upper:]' '[:lower:]')
  case $key in
    remotecommand) exit 1 ;;
    requesttty) case $value in no | false) exit 1 ;; esac ;;
  esac
}

destination=
need_value=
only_positional=
for arg in "$@"; do
  if [ -n "$need_value" ]; then
    [ "$need_value" = o ] && check_option "$arg"
    need_value=
    continue
  fi
  case $arg in
    --)
      if [ -n "$only_positional" ]; then
        # A second `--` is part of a remote command.
        exit 1
      fi
      only_positional=1
      continue
      ;;
    -?*)
      if [ -z "$only_positional" ]; then
        rest=${arg#-}
        while [ -n "$rest" ]; do
          letter=${rest%"${rest#?}"}
          rest=${rest#?}
          case $refuse in *"$letter"*) exit 1 ;; esac
          case $with_value in
            *"$letter"*)
              if [ -n "$rest" ]; then
                [ "$letter" = o ] && check_option "$rest"
              else
                need_value=$letter
              fi
              rest=
              ;;
            *)
              case $flags in *"$letter"*) ;; *) exit 1 ;; esac
              ;;
          esac
        done
        continue
      fi
      ;;
  esac
  # Not an option: the destination, then anything else is a command.
  [ -z "$destination" ] || exit 1
  destination=$arg
done
[ -z "$need_value" ] && [ -n "$destination" ] || exit 1

# The host's own configuration may ask for a command or no terminal.
config=$(command ssh -G "$@" 2>/dev/null) || exit 1
printf '%s\n' "$config" | grep -q -i -E '^(remotecommand |requesttty (no|false)$)' && exit 1
exit 0
