# Midterm minimal POSIX sh fallback helper, used only when python3 is absent on
# the remote host. Speaks a simple line-oriented protocol over stdin/stdout for
# core file-system operations (list, stat, read, write, create, rename, delete,
# git status, completion).
#
# Protocol:
#   stdin:  <id> <op> <arg_count>\n followed by <arg_count> base64-encoded args
#   stdout: OK <id> <base64-payload>\n  or  ERR <id> <base64-message>\n

_b64_enc() {
  if command -v base64 >/dev/null 2>&1; then
    base64 | tr -d '\r\n'
  else
    openssl base64 -A
  fi
}

_b64_dec() {
  if printf '' | base64 -d >/dev/null 2>&1; then
    base64 -d
  elif printf '' | base64 -D >/dev/null 2>&1; then
    base64 -D
  else
    openssl base64 -d -A
  fi
}

# Decodes base64 $1 into $_VAL preserving all trailing newlines via an appended
# non-newline sentinel. Returns non-zero if base64 decoding fails.
_dec_arg() {
  _raw_dec=$(printf '%s' "$1" | _b64_dec 2>/dev/null && printf X) || return 1
  case "$_raw_dec" in
    *X) _VAL=${_raw_dec%X}; return 0 ;;
    *) return 1 ;;
  esac
}

_ok() {
  printf 'OK %s %s\n' "$1" "$(printf '%s' "$2" | _b64_enc)"
}

_err() {
  printf 'ERR %s %s\n' "$1" "$(printf '%s' "$2" | _b64_enc)"
}

# Prints "<version_token>\t<size>" for a regular file (following symlinks
# consistently), non-zero otherwise. Combines mtime, inode, and POSIX cksum CRC
# (skipped when optional $2 max_cksum limit is exceeded so oversized files
# return TooLarge without a full read).
_file_version() {
  [ -f "$1" ] || return 1
  _fv_limit=${2-}
  _fv_size=
  _fv_meta=
  if _fv_out=$(stat -L -c '%Y.%y:%i:%s' "$1" 2>/dev/null); then
    _fv_size=${_fv_out##*:}
    _fv_meta=${_fv_out%:*}
    _fv_meta=$(printf '%s' "$_fv_meta" | tr ' \t' '__')
  elif _fv_out=$(stat -L -f '%Fm:%i:%z' "$1" 2>/dev/null); then
    _fv_size=${_fv_out##*:}
    _fv_meta=${_fv_out%:*}
  else
    _fv_size=$(wc -c < "$1" 2>/dev/null | tr -d ' ') || return 1
    _fv_meta="0"
  fi
  _fv_crc=0
  if [ -n "$_fv_limit" ] && [ "$_fv_size" -gt "$_fv_limit" ] 2>/dev/null; then
    _fv_crc=oversize
  elif command -v cksum >/dev/null 2>&1; then
    _fv_ck=$(cksum < "$1" 2>/dev/null) || return 1
    _fv_crc=${_fv_ck%% *}
  fi
  printf '%s:%s\t%s\n' "$_fv_meta" "$_fv_crc" "$_fv_size"
}

_is_root_path() {
  # Reject lexical root (/, ///, /.) and any non-symlink directory resolving to /.
  case "$1" in
    ""|/|"/.") return 0 ;;
  esac
  # Strip repeated slashes: if nothing remains, it is /.
  _stripped=$(printf '%s' "$1" | tr -d '/')
  [ -n "$_stripped" ] || return 0
  if [ ! -L "$1" ] && [ -d "$1" ]; then
    _rp=$(cd -- "$1" 2>/dev/null && pwd -P 2>/dev/null)
    [ "$_rp" = "/" ] && return 0
  fi
  return 1
}

_NL='
'

_resolve_symlink_target() {
  # Follow symlinks up to 40 hops to locate the write target (preserving
  # trailing newlines in both readlink and dirname output via sentinel X).
  _cur=$1
  _hops=0
  while [ -L "$_cur" ] && [ "$_hops" -lt 40 ]; do
    _tgt_x=$(readlink "$_cur" 2>/dev/null && printf X) || break
    case "$_tgt_x" in
      *"${_NL}X") _tgt=${_tgt_x%"${_NL}X"} ;;
      *X) _tgt=${_tgt_x%X} ;;
      *) break ;;
    esac
    case "$_tgt" in
      /*) _cur=$_tgt ;;
      *)
        _dir_x=$(dirname -- "$_cur" && printf X) || break
        _dir=${_dir_x%"${_NL}X"}
        if [ "$_dir" = "/" ]; then
          _cur="/$_tgt"
        else
          _cur="$_dir/$_tgt"
        fi
        ;;
    esac
    _hops=$((_hops + 1))
  done
  printf '%sX' "$_cur"
}

while IFS=' ' read -r req_id op argc; do
  [ -n "$req_id" ] || continue
  r1= r2= r3= r4= r5=
  i=1
  while [ "$i" -le "${argc:-0}" ]; do
    IFS= read -r raw_arg || break
    case $i in
      1) r1=$raw_arg ;;
      2) r2=$raw_arg ;;
      3) r3=$raw_arg ;;
      4) r4=$raw_arg ;;
      5) r5=$raw_arg ;;
    esac
    i=$((i + 1))
  done

  case "$op" in
    hello)
      _ok "$req_id" "${HOME:-/}	$(uname -s 2>/dev/null || echo Unix)	$(uname -m 2>/dev/null || echo unknown)"
      ;;
    list_dir)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if [ ! -d "$a1" ]; then
        _err "$req_id" "cannot list $a1: not a directory"
        continue
      fi
      out=$(
        _base=${a1%/}
        for f in "$_base"/.* "$_base"/*; do
          [ -e "$f" ] || [ -L "$f" ] || continue
          name=${f##*/}
          [ "$name" = "." ] || [ "$name" = ".." ] && continue
          kind=file
          [ -d "$f" ] && kind=dir
          sym=0
          [ -L "$f" ] && sym=1
          nb64=$(printf '%s' "$name" | _b64_enc)
          printf '%s\t%s\t%s\n' "$kind" "$sym" "$nb64"
        done
      )
      _ok "$req_id" "$out"
      ;;
    stat)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if [ ! -e "$a1" ] && [ ! -L "$a1" ]; then
        _ok "$req_id" ""
      else
        kind=file
        [ -d "$a1" ] && kind=dir
        sym=0
        [ -L "$a1" ] && sym=1
        _ok "$req_id" "$kind	$sym"
      fi
      ;;
    file_version)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      a2=
      if [ -n "$r2" ]; then
        if ! _dec_arg "$r2"; then _err "$req_id" "invalid limit encoding"; continue; fi
        a2=$_VAL
      fi
      if info=$(_file_version "$a1" "$a2"); then
        _ok "$req_id" "$info"
      else
        _ok "$req_id" ""
      fi
      ;;
    read_bytes)
      if ! _dec_arg "$r1" || ! _dec_arg "$r2"; then _err "$req_id" "invalid arg encoding"; continue; fi
      _dec_arg "$r1"; a1=$_VAL
      _dec_arg "$r2"; limit=$_VAL
      if [ ! -f "$a1" ] || [ ! -r "$a1" ]; then
        _err "$req_id" "cannot read $a1: not a readable regular file"
        continue
      fi
      # Quick stat size check before streaming bytes.
      _sz=$(stat -c '%s' "$a1" 2>/dev/null || stat -f '%z' "$a1" 2>/dev/null || echo 0)
      if [ "$_sz" -gt "$limit" ] 2>/dev/null; then
        _err "$req_id" "TOO_LARGE:$_sz"
        continue
      fi
      # Open explicitly on fd 3 so open errors fail cleanly before encoding.
      if ! exec 3< "$a1" 2>/dev/null; then
        _err "$req_id" "cannot open $a1"
        continue
      fi
      _want=$((limit + 1))
      _b64_data=$(
        (
          if head -c 1 /dev/null >/dev/null 2>&1; then
            head -c "$_want" <&3
          else
            dd bs=1 count="$_want" <&3 2>/dev/null
          fi && printf '\nMT_EOF_OK'
        ) | _b64_enc
      )
      _rc=$?
      exec 3<&-
      if [ "$_rc" -ne 0 ] || [ -z "$_b64_data" ]; then
        _err "$req_id" "cannot read $a1"
      else
        printf 'OK %s %s\n' "$req_id" "$_b64_data"
      fi
      ;;
    write_text)
      # Args: r1=path_b64, r2=content_b64 (kept raw!), r3=expect_kind, r4=expect_mtime, r5=expect_size
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if ! _dec_arg "$r3"; then _err "$req_id" "invalid expect kind"; continue; fi
      ekind=$_VAL
      if ! _dec_arg "$r4"; then _err "$req_id" "invalid expect mtime"; continue; fi
      emtime=$_VAL
      if ! _dec_arg "$r5"; then _err "$req_id" "invalid expect size"; continue; fi
      esize=$_VAL

      # Serialized version check inside the same single-threaded request loop.
      _cur_ver=$(_file_version "$a1" 2>/dev/null || true)
      _match=0
      case "$ekind" in
        any) _match=1 ;;
        absent) [ -z "$_cur_ver" ] && _match=1 ;;
        version)
          _want_ver="${emtime}	${esize}"
          [ "$_cur_ver" = "$_want_ver" ] && _match=1
          ;;
        *)
          _err "$req_id" "unknown write expectation: $ekind"
          continue
          ;;
      esac
      if [ "$_match" -ne 1 ]; then
        _ok "$req_id" "CONFLICT	$_cur_ver"
        continue
      fi

      _t_x=$(_resolve_symlink_target "$a1")
      _target=${_t_x%X}
      if [ -d "$_target" ]; then
        _err "$req_id" "cannot save $a1: is a directory"
        continue
      fi
      _p_x=$(dirname -- "$_target"; printf X)
      _parent=${_p_x%
X}
      _old_mode=$(stat -L -c '%a' "$_target" 2>/dev/null || stat -L -f '%Lp' "$_target" 2>/dev/null || true)

      # Create an exclusively-owned unique temp file via mktemp; NEVER unlink a
      # file unless mktemp actually created it for this request.
      _tmp=$(umask 077; mktemp "$_parent/.midterm-save.XXXXXX" 2>/dev/null) || _tmp=
      if [ -n "$_tmp" ]; then
        if printf '%s' "$r2" | _b64_dec > "$_tmp" 2>/dev/null; then
          if [ -n "$_old_mode" ]; then
            chmod "$_old_mode" "$_tmp" 2>/dev/null || true
          fi
          if [ -d "$_target" ]; then
            rm -f -- "$_tmp" 2>/dev/null || true
            _err "$req_id" "cannot save $a1: is a directory"
          elif (mv -fT -- "$_tmp" "$_target" 2>/dev/null || ( [ ! -d "$_target" ] && mv -f -- "$_tmp" "$_target" 2>/dev/null )); then
            _new_ver=$(_file_version "$_target" 2>/dev/null || true)
            if [ -z "$_new_ver" ]; then
              _err "$req_id" "cannot save $a1: file vanished after write"
            else
              _ok "$req_id" "WRITTEN	$_new_ver"
            fi
          else
            rm -f -- "$_tmp" 2>/dev/null || true
            _err "$req_id" "cannot save $a1"
          fi
        else
          rm -f -- "$_tmp" 2>/dev/null || true
          _err "$req_id" "cannot save $a1: base64 decode failed"
        fi
      else
        # Fallback for writable file in read-only parent: decode to a unique
        # private staging file in $TMPDIR first so decode failure never
        # truncates the target, and only unlink the file mktemp created.
        _stage=$(umask 077; mktemp "${TMPDIR:-/tmp}/.midterm-save.XXXXXX" 2>/dev/null) || _stage=
        if [ -z "$_stage" ]; then
          _err "$req_id" "cannot save $a1: could not create temporary file"
        elif printf '%s' "$r2" | _b64_dec > "$_stage" 2>/dev/null; then
          if [ ! -d "$_target" ] && cat "$_stage" > "$_target" 2>/dev/null; then
            rm -f -- "$_stage" 2>/dev/null || true
            _new_ver=$(_file_version "$_target" 2>/dev/null || true)
            if [ -z "$_new_ver" ]; then
              _err "$req_id" "cannot save $a1: file vanished after write"
            else
              _ok "$req_id" "WRITTEN	$_new_ver"
            fi
          else
            rm -f -- "$_stage" 2>/dev/null || true
            _err "$req_id" "cannot save $a1"
          fi
        else
          rm -f -- "$_stage" 2>/dev/null || true
          _err "$req_id" "cannot save $a1: base64 decode failed"
        fi
      fi
      ;;
    create)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if ! _dec_arg "$r2"; then _err "$req_id" "invalid kind encoding"; continue; fi
      a2=$_VAL
      if [ -e "$a1" ] || [ -L "$a1" ]; then
        _err "$req_id" "$a1 already exists"
      elif [ "$a2" = "dir" ]; then
        if mkdir -- "$a1" 2>/dev/null; then _ok "$req_id" ""; else _err "$req_id" "cannot create $a1"; fi
      else
        if (set -C; : > "$a1") 2>/dev/null; then _ok "$req_id" ""; else _err "$req_id" "cannot create $a1"; fi
      fi
      ;;
    rename)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if ! _dec_arg "$r2"; then _err "$req_id" "invalid path encoding"; continue; fi
      a2=$_VAL
      if [ -e "$a2" ] || [ -L "$a2" ]; then
        _err "$req_id" "$a2 already exists"
      elif mv -- "$a1" "$a2" 2>/dev/null; then
        _ok "$req_id" ""
      else
        _err "$req_id" "cannot rename $a1 to $a2"
      fi
      ;;
    delete)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if _is_root_path "$a1"; then
        _err "$req_id" "refusing to delete filesystem root"
        continue
      fi
      if [ -L "$a1" ]; then
        if rm -f -- "$a1" 2>/dev/null; then _ok "$req_id" ""; else _err "$req_id" "cannot delete $a1"; fi
      elif [ -d "$a1" ]; then
        if rm -rf -- "$a1" 2>/dev/null; then _ok "$req_id" ""; else _err "$req_id" "cannot delete $a1"; fi
      elif [ -e "$a1" ]; then
        if rm -f -- "$a1" 2>/dev/null; then _ok "$req_id" ""; else _err "$req_id" "cannot delete $a1"; fi
      else
        _err "$req_id" "cannot delete $a1: not found"
      fi
      ;;
    git_status)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if command -v git >/dev/null 2>&1 && top=$(git -C "$a1" --no-optional-locks rev-parse --show-toplevel 2>/dev/null); then
        status_b64=$(git -C "$top" --no-optional-locks status --porcelain=v1 -z -uall --branch 2>/dev/null | _b64_enc)
        top_b64=$(printf '%s' "$top" | _b64_enc)
        _ok "$req_id" "$top_b64	$status_b64"
      else
        _ok "$req_id" ""
      fi
      ;;
    complete_list)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      if [ ! -d "$a1" ]; then
        _err "$req_id" "cannot list $a1"
      else
        out=$(
          _base=${a1%/}
          for f in "$_base"/.* "$_base"/*; do
            [ -e "$f" ] || [ -L "$f" ] || continue
            name=${f##*/}
            [ "$name" = "." ] || [ "$name" = ".." ] && continue
            is_d=0; [ -d "$f" ] && is_d=1
            is_x=0; [ -f "$f" ] && [ -x "$f" ] && is_x=1
            nb64=$(printf '%s' "$name" | _b64_enc)
            printf '%s\t%s\t%s\n' "$is_d" "$is_x" "$nb64"
          done
        )
        _ok "$req_id" "$out"
      fi
      ;;
    path_commands)
      if ! _dec_arg "$r1"; then _err "$req_id" "invalid path encoding"; continue; fi
      a1=$_VAL
      p=${a1:-$PATH}
      old_ifs=$IFS
      IFS=:
      out=$(
        for d in $p; do
          [ "${d#/}" != "$d" ] || continue
          [ -d "$d" ] || continue
          for f in "$d"/*; do
            [ -f "$f" ] && [ -x "$f" ] && printf '%s\n' "$(printf '%s' "${f##*/}" | _b64_enc)"
          done
        done | sort -u
      )
      IFS=$old_ifs
      _ok "$req_id" "$out"
      ;;
    *)
      _err "$req_id" "unsupported op on shell fallback: $op"
      ;;
  esac
done
