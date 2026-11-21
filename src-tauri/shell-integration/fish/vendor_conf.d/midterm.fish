# Midterm shell integration for fish.
#
# Midterm prepends the directory above fish/vendor_conf.d to XDG_DATA_DIRS,
# which makes fish source this file during startup. The first thing it does
# is take that entry out again, so programs started from the shell see the
# user's XDG_DATA_DIRS.
#
# Hooks:
#   __midterm_prompt    before each prompt (fish_prompt event): OSC 6973
#                       (PATH, only when changed), OSC 7, OSC 133;A;
#                       wraps fish_prompt the first time
#   fish_prompt         the user's prompt (__midterm_original_fish_prompt),
#                       then OSC 133;B
#   __midterm_preexec   before each command line runs (fish_preexec event):
#                       OSC 133;C
#   __midterm_postexec  after it (fish_postexec event): OSC 133;D;$status
#
# fish_preexec and fish_postexec are not emitted for empty command lines, so
# those get neither C nor D. A fish_prompt defined after the first prompt
# (e.g. by `fish_config prompt choose`) replaces the wrapper and loses B.

if set -q MIDTERM_FISH_DATA_DIR
    set -l __midterm_keep
    for __midterm_dir in (string split : -- "$XDG_DATA_DIRS")
        if test "$__midterm_dir" != "$MIDTERM_FISH_DATA_DIR"
            set -a __midterm_keep $__midterm_dir
        end
    end
    # It was unset before: Midterm added the default list after its entry.
    # Unset it again, unless something during startup added entries.
    if test (count $__midterm_keep) -eq 0
        or begin
            set -q MIDTERM_FISH_XDG_DATA_DIRS_UNSET
            and test "$__midterm_keep" = "/usr/local/share /usr/share"
        end
        set -e XDG_DATA_DIRS
    else
        set -gx XDG_DATA_DIRS (string join : -- $__midterm_keep)
    end
    set -e __midterm_dir
    set -e MIDTERM_FISH_DATA_DIR
    set -e MIDTERM_FISH_XDG_DATA_DIRS_UNSET
end

# Started over ssh (see ssh/bootstrap.sh), this file is in a temporary
# directory: fish has read it, so it goes.
if set -q MIDTERM_SI_EPHEMERAL
    command rm -f -- $MIDTERM_SI_EPHEMERAL/fish/vendor_conf.d/midterm.fish
    command rmdir -- $MIDTERM_SI_EPHEMERAL/fish/vendor_conf.d $MIDTERM_SI_EPHEMERAL/fish $MIDTERM_SI_EPHEMERAL 2>/dev/null
    set -e MIDTERM_SI_EPHEMERAL
end

# Interactive shells only, and only once.
status is-interactive; or exit 0
functions -q __midterm_report_cwd; and exit 0

# `ssh host` loads this integration on the remote too (see the zsh script):
# an `ssh` function adds the remote command for plain interactive logins.
# A function of the user's (config.fish, or autoloaded) wins.
if set -q MIDTERM_SSH_DIR
    set -g __midterm_ssh_dir $MIDTERM_SSH_DIR
    set -e MIDTERM_SSH_DIR
    if not functions -q ssh
        function ssh --wraps ssh
            if command sh $__midterm_ssh_dir/should-wrap.sh $argv
                command ssh -t $argv (string collect < $__midterm_ssh_dir/remote-command)
            else
                command ssh $argv
            end
        end
    end
end

# This shell's id in its marks (`aid=`), so the terminal can tell them from
# the marks of a shell nested inside it (over ssh).
set -g __midterm_aid $fish_pid.(random)

# OSC 7: tells the terminal the shell's working directory.
function __midterm_report_cwd --on-variable PWD
    printf '\e]7;file://%s%s\a' $hostname (string escape --style=url -- $PWD)
end

# OSC 6973 (Midterm's own): tells the terminal the shell's PATH, for command
# completion, when it differs from the last one reported.
function __midterm_report_path
    set -l path (string join : -- $PATH)
    if set -q __midterm_reported_path; and test "$__midterm_reported_path" = "$path"
        return
    end
    set -g __midterm_reported_path $path
    set -l encoded (string escape --style=url -- $path)
    printf '\e]6973;path=%s;aid=%s\a' "$encoded" $__midterm_aid
end

function __midterm_prompt --on-event fish_prompt
    __midterm_report_path
    __midterm_report_cwd
    printf '\e]133;A;aid=%s\a' $__midterm_aid
    __midterm_wrap_prompt
end

# Puts OSC 133;B after the user's prompt. Done at the first prompt rather
# than now, once config.fish has defined (or autoloading provides) it. The
# event fires before fish_prompt is called, so the first prompt has B too.
function __midterm_wrap_prompt
    set -q __midterm_prompt_wrapped; and return
    set -g __midterm_prompt_wrapped 1
    # Also autoloads it.
    functions -q fish_prompt; or return
    functions -c fish_prompt __midterm_original_fish_prompt
    # The original runs first, so that it still sees the command's $status.
    function fish_prompt
        __midterm_original_fish_prompt $argv
        printf '\e]133;B;aid=%s\a' $__midterm_aid
    end
end

function __midterm_preexec --on-event fish_preexec
    set -g __midterm_ran 1
    printf '\e]133;C;aid=%s\a' $__midterm_aid
end

function __midterm_postexec --on-event fish_postexec
    set -l cmd_status $status
    set -q __midterm_ran; or return
    set -e __midterm_ran
    printf '\e]133;D;%s;aid=%s\a' $cmd_status $__midterm_aid
end
