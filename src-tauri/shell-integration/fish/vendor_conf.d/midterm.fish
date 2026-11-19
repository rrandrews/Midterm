# Midterm shell integration for fish.
#
# Midterm prepends the directory above fish/vendor_conf.d to XDG_DATA_DIRS,
# which makes fish source this file during startup. The first thing it does
# is take that entry out again, so programs started from the shell see the
# user's XDG_DATA_DIRS.
#
# Hooks:
#   __midterm_prompt    before each prompt (fish_prompt event): OSC 7,
#                       OSC 133;A; wraps fish_prompt the first time
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

# Interactive shells only, and only once.
status is-interactive; or exit 0
functions -q __midterm_report_cwd; and exit 0

# OSC 7: tells the terminal the shell's working directory.
function __midterm_report_cwd --on-variable PWD
    printf '\e]7;file://%s%s\a' $hostname (string escape --style=url -- $PWD)
end

function __midterm_prompt --on-event fish_prompt
    __midterm_report_cwd
    printf '\e]133;A\a'
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
        printf '\e]133;B\a'
    end
end

function __midterm_preexec --on-event fish_preexec
    set -g __midterm_ran 1
    printf '\e]133;C\a'
end

function __midterm_postexec --on-event fish_postexec
    set -l cmd_status $status
    set -q __midterm_ran; or return
    set -e __midterm_ran
    printf '\e]133;D;%s\a' $cmd_status
end
