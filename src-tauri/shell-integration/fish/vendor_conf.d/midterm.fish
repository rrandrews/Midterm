# Midterm shell integration for fish.
#
# Midterm prepends the directory above fish/vendor_conf.d to XDG_DATA_DIRS,
# which makes fish source this file during startup. The first thing it does
# is take that entry out again, so programs started from the shell see the
# user's XDG_DATA_DIRS.
#
# Hooks:
#   __midterm_prompt   before each prompt (fish_prompt event)
#   __midterm_preexec  before each command line runs (fish_preexec event)
# OSC 133 prompt marks (A in __midterm_prompt, C in __midterm_preexec,
# D;$status from a fish_postexec handler) slot in next to them.

if set -q MIDTERM_FISH_DATA_DIR
    set -l __midterm_keep
    for __midterm_dir in (string split : -- "$XDG_DATA_DIRS")
        if test "$__midterm_dir" != "$MIDTERM_FISH_DATA_DIR"
            set -a __midterm_keep $__midterm_dir
        end
    end
    if set -q MIDTERM_FISH_XDG_DATA_DIRS_UNSET; or test (count $__midterm_keep) -eq 0
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
end

function __midterm_preexec --on-event fish_preexec
end
