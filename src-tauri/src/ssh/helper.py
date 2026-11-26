# Midterm remote SSH helper daemon (Python 3.6+, stdlib only).
#
# Runs over a single multiplexed SSH channel (stdin/stdout), serving concurrent
# file-system, git, search, watcher, and completion RPCs without writing any
# files to the remote host.
#
# Wire protocol:
#   stdin  -> one UTF-8 JSON line per request: {"id": N, "op": "...", ...}\n
#   stdout -> either:
#       J <utf-8 json>\n          (RPC response or async watch/search event)
#       B <id> <byte_len>\n<raw>  (raw bytes response for read_bytes)

import base64
import ctypes
import ctypes.util
import errno
import fnmatch
import json
import os
import platform
import re
import select
import shutil
import stat as statmod
import struct
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

TEXT_LIMIT = 16 * 1024 * 1024
BYTES_LIMIT = 64 * 1024 * 1024
BINARY_SNIFF = 8000
SEARCH_MAX_FILE_SIZE = 8 * 1024 * 1024
SEARCH_MAX_LINE = 300
SEARCH_MAX_RANGES = 100
SEARCH_CONTEXT_BEFORE = 60
SEARCH_BATCH_FILES = 100
SEARCH_FLUSH_INTERVAL = 0.05
WATCH_DEBOUNCE = 0.15
WATCH_POLL_INTERVAL = 1.2
PATH_CACHE_TTL = 30.0

stdin_buf = sys.stdin.buffer
stdout_buf = sys.stdout.buffer
stdout_lock = threading.Lock()
write_lock = threading.Lock()

HAS_GIT = shutil.which("git") is not None
HAS_RG = shutil.which("rg") is not None


def send_json(obj):
    data = ("J " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with stdout_lock:
        stdout_buf.write(data)
        stdout_buf.flush()


def send_bytes(req_id, raw):
    header = ("B %d %d\n" % (req_id, len(raw))).encode("ascii")
    with stdout_lock:
        stdout_buf.write(header)
        stdout_buf.write(raw)
        stdout_buf.flush()


def send_ok(req_id, value):
    send_json({"id": req_id, "ok": value})


def send_err(req_id, msg):
    send_json({"id": req_id, "err": str(msg)})


def valid_utf8(name):
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def file_version_of(st):
    return {"mtime": str(st.st_mtime_ns), "size": st.st_size}


def join_posix(dir_path, name):
    if dir_path == "/":
        return "/" + name
    return dir_path.rstrip("/") + "/" + name


# --- Ignore rules (.ignore everywhere; git check-ignore inside git repos) ---

def find_git_root(dir_path):
    cur = dir_path
    while True:
        git_entry = join_posix(cur, ".git")
        try:
            os.lstat(git_entry)
            return cur
        except OSError:
            pass
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def parse_ignore_lines(lines):
    rules = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if not line or line.startswith("#"):
            continue
        neg = False
        if line.startswith("!"):
            neg = True
            line = line[1:]
        elif line.startswith(r"\#") or line.startswith(r"\!"):
            line = line[1:]
        if not line:
            continue
        dir_only = line.endswith("/")
        if dir_only:
            line = line[:-1]
        if not line:
            continue
        anchored = "/" in line
        if line.startswith("/"):
            line = line[1:]
        rules.append((neg, dir_only, anchored, line))
    return rules


IGNORE_MAX_BYTES = 512 * 1024
_glob_rx_cache = {}
_glob_rx_lock = threading.Lock()


def load_ignore_file(path):
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return []
    try:
        st = os.fstat(fd)
        if not statmod.S_ISREG(st.st_mode):
            return []
        chunks = []
        total = 0
        while total < IGNORE_MAX_BYTES:
            chunk = os.read(fd, min(65536, IGNORE_MAX_BYTES - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        text = b"".join(chunks).decode("utf-8", errors="replace")
        return parse_ignore_lines(text.splitlines())
    except OSError:
        return []
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _compile_ignore_glob(pat):
    with _glob_rx_lock:
        hit = _glob_rx_cache.get(pat)
        if hit is not None:
            return hit
    # Path-component aware gitignore-style glob compiler: `*` and `?` never cross `/`.
    rx = ["^"]
    i = 0
    n = len(pat)
    while i < n:
        if pat[i:i + 3] == "**/":
            rx.append("(?:.*/)?")
            i += 3
        elif pat[i:i + 2] == "**":
            rx.append(".*")
            i += 2
        elif pat[i] == "*":
            rx.append("[^/]*")
            i += 1
        elif pat[i] == "?":
            rx.append("[^/]")
            i += 1
        elif pat[i] == "[":
            j = i + 1
            if j < n and pat[j] in ("!", "^"):
                j += 1
            if j < n and pat[j] == "]":
                j += 1
            while j < n and pat[j] != "]":
                j += 1
            if j >= n:
                rx.append(r"\[")
                i += 1
            else:
                stuff = pat[i + 1:j]
                if stuff.startswith("!"):
                    stuff = "^" + stuff[1:]
                stuff = stuff.replace("\\", r"\\")
                rx.append("[" + stuff + "]")
                i = j + 1
        else:
            rx.append(re.escape(pat[i]))
            i += 1
    rx.append("$")
    compiled = re.compile("".join(rx))
    with _glob_rx_lock:
        if len(_glob_rx_cache) > 4096:
            _glob_rx_cache.clear()
        _glob_rx_cache[pat] = compiled
    return compiled


def match_ignore_rule(rule, rel_path, name, is_dir):
    neg, dir_only, anchored, pat = rule
    if dir_only and not is_dir:
        return False
    target = rel_path if anchored else name
    return _compile_ignore_glob(pat).match(target) is not None


def collect_dot_ignore_rules(dir_path):
    # Ancestor .ignore files from outermost to innermost
    chain = []
    cur = dir_path
    while True:
        chain.append(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    chain.reverse()
    out = []
    for base in chain:
        rules = load_ignore_file(join_posix(base, ".ignore"))
        if rules:
            out.append((base, rules))
    return out


def is_dot_ignored(base_rules, entry_path, name, is_dir):
    ignored = False
    for base, rules in base_rules:
        if base == "/":
            rel = entry_path.lstrip("/")
        elif entry_path.startswith(base + "/"):
            rel = entry_path[len(base) + 1:]
        else:
            continue
        for rule in rules:
            if match_ignore_rule(rule, rel, name, is_dir):
                ignored = not rule[0]
    return ignored


def git_check_ignored_set(repo_root, dir_path, items):
    # items: list of (name, is_dir)
    if not items:
        return set()
    if HAS_GIT:
        rel_dir = os.path.relpath(dir_path, repo_root)
        rels = []
        rel_to_name = {}
        for name, is_dir in items:
            if name == ".git":
                continue
            rel = name if rel_dir == "." else (rel_dir + "/" + name)
            probe = rel + "/" if is_dir else rel
            rels.append(probe)
            rel_to_name[probe] = name
            rel_to_name[rel] = name
        if not rels:
            return set()
        payload = ("\0".join(rels) + "\0").encode("utf-8", errors="surrogateescape")
        try:
            proc = subprocess.run(
                ["git", "-C", repo_root, "--no-optional-locks", "check-ignore", "--no-index", "-z", "--stdin"],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            # exit 0 = some ignored, 1 = none ignored, 128 = error
            if proc.returncode in (0, 1):
                ignored = set()
                for raw in proc.stdout.split(b"\0"):
                    if not raw:
                        continue
                    s = raw.decode("utf-8", errors="surrogateescape")
                    nm = rel_to_name.get(s) or rel_to_name.get(s.rstrip("/"))
                    if nm:
                        ignored.add(nm)
                return ignored
        except Exception:
            pass
    # Fallback when git binary is absent: parse .gitignore files from repo_root to dir_path
    chain = []
    cur = dir_path
    while True:
        chain.append(cur)
        if cur == repo_root:
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    chain.reverse()
    rule_sets = []
    exc = load_ignore_file(join_posix(repo_root, ".git/info/exclude"))
    if exc:
        rule_sets.append((repo_root, exc))
    for base in chain:
        rules = load_ignore_file(join_posix(base, ".gitignore"))
        if rules:
            rule_sets.append((base, rules))
    ignored = set()
    for name, is_dir in items:
        if is_dot_ignored(rule_sets, join_posix(dir_path, name), name, is_dir):
            ignored.add(name)
    return ignored


# --- Core FS ops ---

def op_list_dir(path, show_hidden):
    try:
        raw_entries = list(os.scandir(path))
    except OSError as e:
        raise RuntimeError("cannot list %s: %s" % (path, e))

    parsed = []
    for entry in raw_entries:
        name = entry.name
        if not valid_utf8(name):
            continue
        try:
            is_link = entry.is_symlink()
            if is_link:
                try:
                    is_dir = os.path.isdir(entry.path)
                except OSError:
                    is_dir = False
            else:
                is_dir = entry.is_dir(follow_symlinks=False)
        except OSError:
            continue
        parsed.append((name, is_dir, is_link))

    git_root = find_git_root(path)
    git_ignored = git_check_ignored_set(git_root, path, [(n, d) for n, d, _ in parsed]) if git_root else set()
    dot_ignore_rules = collect_dot_ignore_rules(path)

    out = []
    for name, is_dir, is_link in parsed:
        full = join_posix(path, name)
        hidden = name.startswith(".")
        ignored = (
            name == ".git"
            or (name in git_ignored)
            or is_dot_ignored(dot_ignore_rules, full, name, is_dir)
        )
        if not show_hidden and (hidden or ignored):
            continue
        out.append({
            "name": name,
            "path": full,
            "kind": "dir" if is_dir else "file",
            "symlink": is_link,
            "hidden": hidden,
            "ignored": ignored,
        })
    out.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower(), e["name"]))
    return out


def op_stat(path):
    try:
        lst = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise RuntimeError("cannot stat %s: %s" % (path, e))
    is_link = statmod.S_ISLNK(lst.st_mode)
    if is_link:
        try:
            is_dir = statmod.S_ISDIR(os.stat(path).st_mode)
        except OSError:
            is_dir = False
    else:
        is_dir = statmod.S_ISDIR(lst.st_mode)
    trimmed = path.rstrip("/")
    name = os.path.basename(trimmed) if trimmed else "/"
    return {
        "name": name,
        "path": path,
        "kind": "dir" if is_dir else "file",
        "symlink": is_link,
        "hidden": name.startswith("."),
        "ignored": False,
    }


def op_stat_batch(paths):
    results = []
    for p in paths:
        try:
            results.append(op_stat(p))
        except Exception:
            results.append(None)
    return results


def op_create(path, is_dir):
    try:
        if is_dir:
            os.mkdir(path)
        else:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
            os.close(fd)
    except OSError as e:
        raise RuntimeError("cannot create %s: %s" % (path, e))


def _libc():
    try:
        name = ctypes.util.find_library("c")
        return ctypes.CDLL(name, use_errno=True) if name else None
    except Exception:
        return None


_LIBC = _libc()
_SYS = platform.system()


def _rename_no_replace(src, dst):
    if _LIBC is None:
        return None
    src_b = os.fsencode(src)
    dst_b = os.fsencode(dst)
    try:
        if _SYS == "Darwin" and hasattr(_LIBC, "renamex_np"):
            # RENAME_EXCL = 0x00000004 on macOS
            rc = _LIBC.renamex_np(ctypes.c_char_p(src_b), ctypes.c_char_p(dst_b), ctypes.c_uint(4))
        elif _SYS == "Linux" and hasattr(_LIBC, "renameat2"):
            # AT_FDCWD = -100, RENAME_NOREPLACE = 1 on Linux
            rc = _LIBC.renameat2(
                ctypes.c_int(-100),
                ctypes.c_char_p(src_b),
                ctypes.c_int(-100),
                ctypes.c_char_p(dst_b),
                ctypes.c_uint(1),
            )
        else:
            return None
        if rc == 0:
            return True
        err = ctypes.get_errno()
        if err in (errno.EINVAL, errno.ENOSYS, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP)):
            return None
        raise OSError(err, os.strerror(err))
    except OSError:
        raise
    except Exception:
        return None


def _is_case_only_rename(src, dst):
    if src == dst or src.lower() != dst.lower():
        return False
    try:
        a = os.lstat(src)
        b = os.lstat(dst)
        return a.st_dev == b.st_dev and a.st_ino == b.st_ino
    except OSError:
        return False


def op_rename(src, dst):
    try:
        os.lstat(dst)
        exists = True
    except FileNotFoundError:
        exists = False
    except OSError as e:
        raise RuntimeError("cannot rename %s to %s: %s" % (src, dst, e))

    if exists:
        if _is_case_only_rename(src, dst):
            try:
                os.rename(src, dst)
                return
            except OSError as e:
                raise RuntimeError("cannot rename %s to %s: %s" % (src, dst, e))
        raise RuntimeError("%s already exists" % dst)

    try:
        res = _rename_no_replace(src, dst)
        if res is None:
            os.rename(src, dst)
    except FileExistsError:
        raise RuntimeError("%s already exists" % dst)
    except OSError as e:
        raise RuntimeError("cannot rename %s to %s: %s" % (src, dst, e))


def _is_filesystem_root(path, lstat_res, root_id):
    if not path or not path.startswith("/"):
        return True
    if os.path.normpath(path) == "/":
        return True
    if statmod.S_ISLNK(lstat_res.st_mode):
        return False
    if root_id is not None and (lstat_res.st_dev, lstat_res.st_ino) == root_id:
        return True
    try:
        if os.path.realpath(path) == "/":
            return True
    except OSError:
        pass
    return False


def op_delete(paths):
    try:
        r_st = os.stat("/")
        root_id = (r_st.st_dev, r_st.st_ino)
    except OSError:
        root_id = None

    # Validate every path in the batch BEFORE deleting anything.
    validated = []
    for p in paths:
        if not p or not p.startswith("/") or os.path.normpath(p) == "/":
            raise RuntimeError("refusing to delete filesystem root")
        try:
            st = os.lstat(p)
        except OSError as e:
            raise RuntimeError("cannot delete %s: %s" % (p, e))
        if _is_filesystem_root(p, st, root_id):
            raise RuntimeError("refusing to delete filesystem root")
        validated.append((p, st))

    for p, st in validated:
        try:
            if statmod.S_ISDIR(st.st_mode) and not statmod.S_ISLNK(st.st_mode):
                shutil.rmtree(p)
            else:
                os.unlink(p)
        except OSError as e:
            raise RuntimeError("cannot delete %s: %s" % (p, e))


def _candidate_name(name, is_dir, attempt):
    if attempt == 1:
        return name
    dot = name.rfind(".")
    if dot > 0 and not is_dir and dot + 1 < len(name):
        stem, ext = name[:dot], name[dot:]
    else:
        stem, ext = name, ""
    if attempt == 2:
        return "%s copy%s" % (stem, ext)
    return "%s copy %d%s" % (stem, attempt - 1, ext)


def _is_ancestor_inode(src_dev_ino, target_dir):
    # Walk target_dir AND realpath(target_dir) up to / comparing (st_dev, st_ino).
    # Catches Linux bind mounts as well as symlinks and direct descendants.
    for start in {target_dir, os.path.realpath(target_dir)}:
        cur = start
        seen = set()
        while cur not in seen:
            seen.add(cur)
            try:
                st = os.stat(cur)
                if (st.st_dev, st.st_ino) == src_dev_ino:
                    return True
            except OSError:
                break
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
    return False


def _rollback_owned(created):
    # Only remove entries whose (st_dev, st_ino) still match what we created.
    for c_path, c_is_dir, c_dev, c_ino in reversed(created):
        try:
            cur = os.lstat(c_path)
            if (cur.st_dev, cur.st_ino) != (c_dev, c_ino):
                continue
            if c_is_dir:
                os.rmdir(c_path)
            else:
                os.unlink(c_path)
        except OSError:
            pass


def _copy_file_to_fd(src_path, out_fd):
    out_f = None
    try:
        out_f = os.fdopen(out_fd, "wb")
    except Exception:
        try:
            os.close(out_fd)
        except OSError:
            pass
        raise
    with out_f:
        with open(src_path, "rb") as in_f:
            st = os.fstat(in_f.fileno())
            if not statmod.S_ISREG(st.st_mode):
                raise OSError("not a regular file")
            shutil.copyfileobj(in_f, out_f, 1024 * 1024)
        os.fchmod(out_f.fileno(), statmod.S_IMODE(st.st_mode))


def _copy_dir_contents(src_dir, dst_dir, created, dir_modes, dest_root_id, active_src_dirs):
    for entry in os.scandir(src_dir):
        src_p = entry.path
        dst_p = join_posix(dst_dir, entry.name)
        lst = os.lstat(src_p)
        mode = lst.st_mode
        if statmod.S_ISLNK(mode):
            os.symlink(os.readlink(src_p), dst_p)
            dst_st = os.lstat(dst_p)
            created.append((dst_p, False, dst_st.st_dev, dst_st.st_ino))
        elif statmod.S_ISDIR(mode):
            src_id = (lst.st_dev, lst.st_ino)
            if src_id == dest_root_id or src_id in active_src_dirs:
                raise OSError("cannot copy %s into itself" % src_p)
            os.mkdir(dst_p, 0o700)
            dst_st = os.lstat(dst_p)
            created.append((dst_p, True, dst_st.st_dev, dst_st.st_ino))
            dir_modes.append((dst_p, statmod.S_IMODE(mode)))
            active_src_dirs.add(src_id)
            try:
                _copy_dir_contents(src_p, dst_p, created, dir_modes, dest_root_id, active_src_dirs)
            finally:
                active_src_dirs.discard(src_id)
        elif statmod.S_ISREG(mode):
            fd = os.open(dst_p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            dst_st = os.fstat(fd)
            created.append((dst_p, False, dst_st.st_dev, dst_st.st_ino))
            _copy_file_to_fd(src_p, fd)
        else:
            # Skip sockets, FIFOs, and device nodes inside trees.
            pass


def _publish_staged(stage_path, to_dir, name, is_dir):
    attempt = 1
    while True:
        dest = join_posix(to_dir, _candidate_name(name, is_dir, attempt))
        attempt += 1
        try:
            res = _rename_no_replace(stage_path, dest)
            if res is None:
                if not is_dir:
                    # Atomic no-replace publication for regular files via hard link + unlink.
                    try:
                        os.link(stage_path, dest)
                    except FileExistsError:
                        continue
                    except OSError as e:
                        raise RuntimeError(
                            "atomic non-replacing rename is not supported on this filesystem (%s)" % e
                        )
                    try:
                        os.unlink(stage_path)
                    except OSError:
                        pass
                    return dest
                raise RuntimeError("atomic non-replacing rename is not supported on this filesystem")
            return dest
        except FileExistsError:
            continue


def _create_stage_dir(to_dir):
    pid = os.getpid()
    for _ in range(64):
        stage = join_posix(to_dir, ".midterm-copy-%d-%s" % (pid, os.urandom(8).hex()))
        try:
            os.mkdir(stage, 0o700)
            st = os.lstat(stage)
            return stage, st.st_dev, st.st_ino
        except FileExistsError:
            continue
    raise OSError("could not create staging directory")


def _create_stage_file(to_dir):
    pid = os.getpid()
    for _ in range(64):
        stage = join_posix(to_dir, ".midterm-copy-%d-%s" % (pid, os.urandom(8).hex()))
        try:
            fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            st = os.fstat(fd)
            return fd, stage, st.st_dev, st.st_ino
        except FileExistsError:
            continue
    raise OSError("could not create staging file")


def op_copy_into(src, to_dir):
    try:
        lst = os.lstat(src)
    except OSError as e:
        raise RuntimeError("cannot copy %s to %s: %s" % (src, to_dir, e))
    trimmed = src.rstrip("/")
    name = os.path.basename(trimmed)
    if not name or not valid_utf8(name):
        raise RuntimeError("cannot copy %s: no usable name" % src)
    try:
        dst_st = os.stat(to_dir)
    except OSError as e:
        raise RuntimeError("cannot copy %s to %s: %s" % (src, to_dir, e))
    if not statmod.S_ISDIR(dst_st.st_mode):
        raise RuntimeError("%s is not a directory" % to_dir)

    mode = lst.st_mode
    is_link = statmod.S_ISLNK(mode)
    is_dir = statmod.S_ISDIR(mode) and not is_link
    is_reg = statmod.S_ISREG(mode) and not is_link
    if not (is_link or is_dir or is_reg):
        raise RuntimeError("cannot copy %s: not a file or directory" % src)

    if is_dir and _is_ancestor_inode((lst.st_dev, lst.st_ino), to_dir):
        raise RuntimeError("cannot copy %s into itself" % src)

    if is_link:
        target = os.readlink(src)
        attempt = 1
        while True:
            dest = join_posix(to_dir, _candidate_name(name, False, attempt))
            attempt += 1
            try:
                os.symlink(target, dest)
                return dest
            except FileExistsError:
                continue
            except OSError as e:
                raise RuntimeError("cannot copy %s to %s: %s" % (src, to_dir, e))

    created = []
    dir_modes = []
    try:
        if is_dir:
            stage, s_dev, s_ino = _create_stage_dir(to_dir)
            created.append((stage, True, s_dev, s_ino))
            dir_modes.append((stage, statmod.S_IMODE(mode)))
            active_src_dirs = {(lst.st_dev, lst.st_ino)}
            _copy_dir_contents(src, stage, created, dir_modes, (s_dev, s_ino), active_src_dirs)
            for d_path, d_mode in reversed(dir_modes):
                os.chmod(d_path, d_mode)
            return _publish_staged(stage, to_dir, name, True)
        else:
            fd, stage, s_dev, s_ino = _create_stage_file(to_dir)
            created.append((stage, False, s_dev, s_ino))
            _copy_file_to_fd(src, fd)
            return _publish_staged(stage, to_dir, name, False)
    except Exception as e:
        _rollback_owned(created)
        raise RuntimeError("cannot copy %s to %s: %s" % (src, to_dir, e))


# --- Whole-file read / write / version ---

def op_file_version(path):
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise RuntimeError("cannot read %s: %s" % (path, e))
    if not statmod.S_ISREG(st.st_mode):
        return None
    return file_version_of(st)


def _read_limited(path, limit):
    st0 = os.stat(path)
    if not statmod.S_ISREG(st0.st_mode):
        raise OSError("not a regular file")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if not statmod.S_ISREG(st.st_mode):
            raise OSError("not a regular file")
        ver = file_version_of(st)
        if st.st_size > limit:
            return None, ver
        chunks = []
        total = 0
        want = limit + 1
        while total < want:
            chunk = os.read(fd, min(256 * 1024, want - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            return None, ver
        return b"".join(chunks), ver
    finally:
        os.close(fd)


def op_read_text(path, limit):
    try:
        raw, ver = _read_limited(path, limit)
    except OSError as e:
        raise RuntimeError("cannot read %s: %s" % (path, e))
    if raw is None:
        return {"kind": "tooLarge", "version": ver}
    if b"\x00" in raw[:BINARY_SNIFF]:
        return {"kind": "binary", "version": ver}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"kind": "binary", "version": ver}
    return {"kind": "text", "text": text, "version": ver}


def op_read_bytes(path, limit):
    try:
        raw, ver = _read_limited(path, limit)
    except OSError as e:
        raise RuntimeError("cannot read %s: %s" % (path, e))
    if raw is None:
        raise RuntimeError("%s is too large to show (%d bytes)" % (path, ver["size"]))
    return raw


def _resolve_symlinks(path):
    # Follow symlinks up to 40 hops, even to a missing target, without lexically
    # collapsing `dirlink/..` via normpath so the OS resolves parent components
    # in real filesystem order.
    cur = path
    for _ in range(40):
        try:
            lst = os.lstat(cur)
        except FileNotFoundError:
            return cur
        if not statmod.S_ISLNK(lst.st_mode):
            return cur
        target = os.readlink(cur)
        if os.path.isabs(target):
            cur = target
        else:
            parent = os.path.dirname(cur) or "."
            cur = join_posix(parent, target) if parent.startswith("/") else os.path.join(parent, target)
    raise OSError("too many levels of symbolic links")


def _atomic_tmp_in(dir_path, mode):
    pid = os.getpid()
    tid = threading.get_ident() & 0xFFFF
    for _ in range(64):
        rand = os.urandom(6).hex()
        tmp = join_posix(dir_path, ".midterm-save-%d-%x-%s.tmp" % (pid, tid, rand))
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            return fd, tmp
        except FileExistsError:
            continue
    raise OSError("could not create temporary file")


def op_write_text(path, text, expect):
    with write_lock:
        current = op_file_version(path)
        kind = expect.get("kind")
        if kind == "version":
            matches = current == expect.get("version")
        elif kind == "absent":
            matches = current is None
        elif kind == "any":
            matches = True
        else:
            raise RuntimeError("unknown write expectation: %r" % (kind,))
        if not matches:
            return {"kind": "conflict", "current": current}

        try:
            target = _resolve_symlinks(path)
            try:
                old_mode = statmod.S_IMODE(os.stat(target).st_mode)
            except OSError:
                old_mode = None
            parent = os.path.dirname(target) or "."
            raw = text.encode("utf-8")
            create_mode = 0o600 if old_mode is not None else 0o666
            try:
                fd, tmp_path = _atomic_tmp_in(parent, create_mode)
            except PermissionError:
                # Writable file in a read-only directory: overwrite in place.
                with open(target, "wb") as f:
                    f.write(raw)
                    f.flush()
                    os.fsync(f.fileno())
            else:
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(raw)
                        f.flush()
                        os.fsync(f.fileno())
                    if old_mode is not None:
                        os.chmod(tmp_path, old_mode)
                    os.replace(tmp_path, target)
                except Exception:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    raise
            ver = op_file_version(target)
            if ver is None:
                raise RuntimeError("cannot save %s: file vanished after write" % path)
            return {"kind": "written", "version": ver}
        except OSError as e:
            raise RuntimeError("cannot save %s: %s" % (path, e))


_transfer_lock = threading.Lock()
_transfer_handles = {}  # handle_id -> {"fd": int|None, "mode": "r"|"w", "lock": Lock}
_next_transfer_id = 1


def _alloc_transfer(fd, rw_mode):
    global _next_transfer_id
    with _transfer_lock:
        if len(_transfer_handles) >= 64:
            raise RuntimeError("too many open transfer handles")
        hid = _next_transfer_id
        _next_transfer_id += 1
        _transfer_handles[hid] = {"fd": fd, "mode": rw_mode, "lock": threading.Lock()}
        return hid


def _close_all_transfers():
    with _transfer_lock:
        items = list(_transfer_handles.values())
        _transfer_handles.clear()
    for info in items:
        with info["lock"]:
            fd = info["fd"]
            if fd is not None:
                info["fd"] = None
                try:
                    os.close(fd)
                except OSError:
                    pass


def op_transfer_open_read(path):
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as e:
        raise RuntimeError("cannot open %s: %s" % (path, e))
    try:
        st = os.fstat(fd)
        if not statmod.S_ISREG(st.st_mode):
            raise RuntimeError("cannot copy %s: not a regular file" % path)
        return _alloc_transfer(fd, "r")
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def op_transfer_read(handle_id, max_bytes):
    with _transfer_lock:
        info = _transfer_handles.get(handle_id)
    if info is None or info["mode"] != "r":
        raise RuntimeError("invalid read handle")
    want = max(1, min(int(max_bytes), 4 * 1024 * 1024))
    with info["lock"]:
        fd = info["fd"]
        if fd is None:
            raise RuntimeError("read handle closed")
        try:
            return os.read(fd, want)
        except OSError as e:
            raise RuntimeError("read failed: %s" % e)


def op_transfer_open_write(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RuntimeError("EEXIST")
    except OSError as e:
        raise RuntimeError("cannot create %s: %s" % (path, e))
    try:
        st = os.fstat(fd)
        hid = _alloc_transfer(fd, "w")
        return {"handle": hid, "dev": st.st_dev, "ino": st.st_ino}
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def op_transfer_write(handle_id, data_b64):
    with _transfer_lock:
        info = _transfer_handles.get(handle_id)
    if info is None or info["mode"] != "w":
        raise RuntimeError("invalid write handle")
    raw = base64.b64decode(data_b64)
    view = memoryview(raw)
    written = 0
    with info["lock"]:
        fd = info["fd"]
        if fd is None:
            raise RuntimeError("write handle closed")
        try:
            while written < len(view):
                n = os.write(fd, view[written:])
                if n <= 0:
                    raise OSError("short write")
                written += n
        except OSError as e:
            raise RuntimeError("write failed: %s" % e)


def op_transfer_finish_write(handle_id, mode):
    with _transfer_lock:
        info = _transfer_handles.pop(handle_id, None)
    if info is None or info["mode"] != "w":
        raise RuntimeError("invalid write handle")
    with info["lock"]:
        fd = info["fd"]
        if fd is None:
            raise RuntimeError("write handle closed")
        info["fd"] = None
        try:
            if mode is not None:
                os.fchmod(fd, int(mode) & 0o777)
        except OSError as e:
            raise RuntimeError("cannot set permissions: %s" % e)
        finally:
            try:
                os.close(fd)
            except OSError:
                pass


def op_transfer_close(handle_id):
    with _transfer_lock:
        info = _transfer_handles.pop(handle_id, None)
    if info is not None:
        with info["lock"]:
            fd = info["fd"]
            if fd is not None:
                info["fd"] = None
                try:
                    os.close(fd)
                except OSError:
                    pass


def op_mkdir_private(path):
    try:
        os.mkdir(path, 0o700)
        st = os.lstat(path)
        return {"dev": st.st_dev, "ino": st.st_ino}
    except FileExistsError:
        raise RuntimeError("EEXIST")
    except OSError as e:
        raise RuntimeError("cannot create %s: %s" % (path, e))


def op_rename_no_replace(src, dst):
    try:
        res = _rename_no_replace(src, dst)
        if res is None:
            # Atomic hard-link fallback for regular files; fail closed for directories.
            st = os.lstat(src)
            if statmod.S_ISREG(st.st_mode):
                try:
                    os.link(src, dst)
                except FileExistsError:
                    raise RuntimeError("EEXIST")
                except OSError as e:
                    raise RuntimeError(
                        "atomic non-replacing rename is not supported on this filesystem (%s)" % e
                    )
                try:
                    os.unlink(src)
                except OSError:
                    pass
                return
            raise RuntimeError("atomic non-replacing rename is not supported on this filesystem")
    except FileExistsError:
        raise RuntimeError("EEXIST")
    except RuntimeError:
        raise
    except OSError as e:
        raise RuntimeError("cannot rename %s to %s: %s" % (src, dst, e))


def op_list_copy_children(dir_path):
    try:
        raw_entries = list(os.scandir(dir_path))
    except OSError as e:
        raise RuntimeError("cannot list %s: %s" % (dir_path, e))
    names = []
    for entry in raw_entries:
        if not valid_utf8(entry.name):
            raise RuntimeError("cannot copy %s: directory contains a non-UTF-8 filename" % dir_path)
        names.append(entry.name)
    return names


def op_symlink_new(target, dest):
    try:
        os.symlink(target, dest)
        st = os.lstat(dest)
        return {"dev": st.st_dev, "ino": st.st_ino}
    except FileExistsError:
        raise RuntimeError("EEXIST")
    except OSError as e:
        raise RuntimeError("cannot create symlink %s: %s" % (dest, e))


def op_readlink(path):
    try:
        return os.readlink(path)
    except OSError as e:
        raise RuntimeError("cannot readlink %s: %s" % (path, e))


def op_lstat_meta(path):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise RuntimeError("cannot lstat %s: %s" % (path, e))
    m = st.st_mode
    if statmod.S_ISLNK(m):
        kind = "symlink"
    elif statmod.S_ISDIR(m):
        kind = "dir"
    elif statmod.S_ISREG(m):
        kind = "file"
    else:
        kind = "special"
    return {
        "kind": kind,
        "mode": statmod.S_IMODE(m),
        "size": st.st_size,
        "dev": st.st_dev,
        "ino": st.st_ino,
    }


def op_chmod(path, mode):
    try:
        os.chmod(path, mode & 0o777)
    except OSError as e:
        raise RuntimeError("cannot chmod %s: %s" % (path, e))


def op_remove_single(path, is_dir, expected_dev=None, expected_ino=None):
    try:
        if expected_dev is not None and expected_ino is not None:
            cur = os.lstat(path)
            if (cur.st_dev, cur.st_ino) != (int(expected_dev), int(expected_ino)):
                return
        if is_dir:
            os.rmdir(path)
        else:
            os.unlink(path)
    except OSError:
        pass


# --- Git status ---

GIT_PRECEDENCE = {"C": 0, "D": 1, "R": 2, "A": 3, "M": 4, "U": 5}


def _git_code(x, y):
    pair = x + y
    if pair in ("DD", "AU", "UD", "UA", "DU", "AA", "UU"):
        return "C"
    if x == "D" or y == "D":
        return "D"
    if x == "R":
        return "R"
    if x == "A":
        return "A"
    if x in ("M", "T") or y in ("M", "T", "R"):
        return "M"
    if pair == "??":
        return "U"
    return None


def _root_in_callers_terms(caller_path, real_workdir):
    try:
        rp = os.path.realpath(caller_path)
        rw = os.path.realpath(real_workdir)
    except OSError:
        return real_workdir.rstrip("/") or "/"
    if rp == rw:
        return caller_path.rstrip("/") or "/"
    prefix = "/" if rw == "/" else rw + "/"
    if not rp.startswith(prefix):
        return real_workdir.rstrip("/") or "/"
    below = rp[len(prefix):]
    depth = len([c for c in below.split("/") if c])
    candidate = caller_path.rstrip("/")
    for _ in range(depth):
        parent = os.path.dirname(candidate)
        if parent == candidate:
            return real_workdir.rstrip("/") or "/"
        candidate = parent
    try:
        if os.path.realpath(candidate) == rw:
            return candidate.rstrip("/") or "/"
    except OSError:
        pass
    return real_workdir.rstrip("/") or "/"


def _parse_branch_header(header):
    # "## main...origin/main [ahead 1]"
    # "## No commits yet on main" / "## Initial commit on main"
    # "## HEAD (no branch)"
    if header.startswith("HEAD (no branch)") or header == "HEAD":
        return None
    for prefix in ("No commits yet on ", "Initial commit on "):
        if header.startswith(prefix):
            return header[len(prefix):].split("...")[0].strip() or None
    branch = header.split("...")[0].strip()
    return branch or None


def op_git_status(path):
    if not HAS_GIT:
        return None
    try:
        top = subprocess.run(
            ["git", "-C", path, "--no-optional-locks", "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except Exception:
        return None
    if top.returncode != 0:
        return None
    workdir = top.stdout.decode("utf-8", errors="surrogateescape").rstrip("\r\n")
    if not workdir:
        return None
    root = _root_in_callers_terms(path, workdir)
    try:
        st = subprocess.run(
            ["git", "-C", workdir, "--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--branch"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
    except Exception as e:
        raise RuntimeError("git status failed: %s" % e)
    if st.returncode != 0:
        raise RuntimeError("git status failed: %s" % st.stderr.decode("utf-8", errors="replace").strip())

    tokens = st.stdout.split(b"\0")
    branch = None
    entries = {}
    i = 0
    n = len(tokens)
    while i < n:
        raw = tokens[i]
        i += 1
        if not raw:
            continue
        if raw.startswith(b"## "):
            branch = _parse_branch_header(raw[3:].decode("utf-8", errors="replace"))
            continue
        if len(raw) < 4:
            continue
        try:
            line = raw.decode("utf-8")
        except UnicodeDecodeError:
            # Skip non-UTF-8 paths (cannot be matched by frontend)
            x0, y0 = chr(raw[0]), chr(raw[1])
            if x0 in ("R", "C") or y0 in ("R", "C"):
                i += 1
            continue
        x, y = line[0], line[1]
        rel = line[3:]
        # In porcelain -z, R and C are followed by a second NUL-terminated orig path.
        if x in ("R", "C") or y in ("R", "C"):
            i += 1
        code = _git_code(x, y)
        if code is None:
            continue
        prev = entries.get(rel)
        if prev is None or GIT_PRECEDENCE[code] < GIT_PRECEDENCE[prev]:
            entries[rel] = code

    return {"root": root, "branch": branch, "entries": entries}


MAX_GIT_EXEC_BYTES = 8 * 1024 * 1024
MAX_GIT_STDERR_BYTES = 256 * 1024
_GIT_ENV_STRIP = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
)


def _drain_pipe(pipe, limit, out_box):
    buf = bytearray()
    truncated = False
    try:
        while True:
            chunk = pipe.read(65536)
            if not chunk:
                break
            if len(buf) < limit:
                keep = min(limit - len(buf), len(chunk))
                buf.extend(chunk[:keep])
                if keep < len(chunk):
                    truncated = True
            else:
                truncated = True
    finally:
        try:
            pipe.close()
        except Exception:
            pass
    out_box[0] = bytes(buf)
    out_box[1] = truncated


def _write_pipe(pipe, data):
    try:
        pipe.write(data)
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def op_git_exec(cwd, args, stdin_b64=None, read_only=True, timeout_secs=30):
    if not HAS_GIT:
        raise RuntimeError("git is not installed on the remote host")
    if not isinstance(cwd, str) or not cwd or "\0" in cwd:
        raise RuntimeError("invalid git working directory")
    if not isinstance(args, list) or not all(isinstance(a, str) and "\0" not in a for a in args):
        raise RuntimeError("invalid git arguments")
    stdin_bytes = base64.b64decode(stdin_b64) if stdin_b64 is not None else None
    env = {k: v for k, v in os.environ.items() if k not in _GIT_ENV_STRIP}
    if "LC_CTYPE" not in env and "LC_ALL" in env:
        env["LC_CTYPE"] = env["LC_ALL"]
    env.pop("LC_ALL", None)
    env["LC_MESSAGES"] = "C"
    env["LANGUAGE"] = "C"
    env["GIT_TERMINAL_PROMPT"] = "0"
    if read_only:
        env["GIT_OPTIONAL_LOCKS"] = "0"
    timeout = max(1, min(int(timeout_secs or 30), 120))
    deadline = time.monotonic() + timeout
    cmd = ["git", "-C", cwd, "-c", "core.quotepath=false", "--literal-pathspecs"] + args
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except Exception as e:
        raise RuntimeError("git command failed: %s" % e)

    out_box = [b"", False]
    err_box = [b"", False]
    t_out = threading.Thread(target=_drain_pipe, args=(proc.stdout, MAX_GIT_EXEC_BYTES, out_box), daemon=True)
    t_err = threading.Thread(target=_drain_pipe, args=(proc.stderr, MAX_GIT_STDERR_BYTES, err_box), daemon=True)
    t_out.start()
    t_err.start()

    t_in = None
    if stdin_bytes is not None and proc.stdin is not None:
        t_in = threading.Thread(target=_write_pipe, args=(proc.stdin, stdin_bytes), daemon=True)
        t_in.start()

    try:
        remaining = max(0.05, deadline - time.monotonic())
        proc.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except Exception:
            pass
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except Exception:
                pass
        try:
            proc.wait(timeout=2)
        except Exception:
            pass
        if t_in is not None:
            t_in.join(timeout=1)
        t_out.join(timeout=1)
        t_err.join(timeout=1)
        raise RuntimeError("git command timed out after %ds" % timeout)

    join_budget = max(0.2, min(2.0, deadline - time.monotonic()))
    if t_in is not None:
        t_in.join(timeout=join_budget)
    t_out.join(timeout=join_budget)
    t_err.join(timeout=join_budget)
    stderr_text = err_box[0].decode("utf-8", errors="replace")
    return {
        "code": proc.returncode,
        "stdoutB64": base64.b64encode(out_box[0]).decode("ascii"),
        "stderr": stderr_text,
        "truncated": bool(out_box[1]),
    }


def _open_confined_parent(root_dir, git_dir, rel_path):
    if not isinstance(rel_path, str) or not rel_path or rel_path.startswith("/") or "\0" in rel_path:
        raise RuntimeError("invalid relative path: %s" % rel_path)
    parts = rel_path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise RuntimeError("invalid relative path: %s" % rel_path)
    git_stat = os.stat(git_dir)
    git_id = (git_stat.st_dev, git_stat.st_ino)
    dir_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    cur_fd = os.open(root_dir, dir_flags)
    try:
        for seg in parts[:-1]:
            nxt = os.open(seg, dir_flags | nofollow, dir_fd=cur_fd)
            os.close(cur_fd)
            cur_fd = nxt
            st = os.fstat(cur_fd)
            if (st.st_dev, st.st_ino) == git_id:
                raise RuntimeError("refusing to traverse into git metadata directory")
        leaf = parts[-1]
        leaf_st = os.lstat(leaf, dir_fd=cur_fd)
        if (leaf_st.st_dev, leaf_st.st_ino) == git_id:
            raise RuntimeError("refusing to operate on git metadata directory")
        return cur_fd, leaf, leaf_st
    except Exception:
        try:
            os.close(cur_fd)
        except Exception:
            pass
        raise


def op_git_read_untracked(root_dir, git_dir, rel_path, max_bytes):
    cur_fd, leaf, st = _open_confined_parent(root_dir, git_dir, rel_path)
    try:
        if statmod.S_ISLNK(st.st_mode):
            target = os.readlink(leaf, dir_fd=cur_fd)
            return ("symlink -> " + target + "\n").encode("utf-8", errors="replace")
        if not statmod.S_ISREG(st.st_mode):
            raise RuntimeError("not a regular file: %s" % rel_path)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        ffd = os.open(leaf, flags, dir_fd=cur_fd)
        try:
            fst = os.fstat(ffd)
            if not statmod.S_ISREG(fst.st_mode):
                raise RuntimeError("not a regular file: %s" % rel_path)
            cap = max(1, min(int(max_bytes), 4 * 1024 * 1024))
            chunks = []
            total = 0
            while total <= cap:
                data = os.read(ffd, min(65536, cap + 1 - total))
                if not data:
                    break
                chunks.append(data)
                total += len(data)
            return b"".join(chunks)
        finally:
            os.close(ffd)
    finally:
        os.close(cur_fd)


def op_git_remove_untracked(root_dir, git_dir, rel_paths):
    for rel in rel_paths:
        try:
            cur_fd, leaf, st = _open_confined_parent(root_dir, git_dir, rel)
        except FileNotFoundError:
            continue
        try:
            if statmod.S_ISDIR(st.st_mode):
                raise RuntimeError("refusing to delete directory as untracked file: %s" % rel)
            os.unlink(leaf, dir_fd=cur_fd)
        finally:
            os.close(cur_fd)


# --- Walk, Find Files, Find Entries ---

def _walk_sorted(root, show_hidden, cancel_event=None):
    # Yields (abs_path, rel_path, is_dir, is_symlink, is_file_target)
    git_root = None if show_hidden else find_git_root(root)
    base_dot_rules = [] if show_hidden else collect_dot_ignore_rules(root)

    def recurse(dir_path, rel_prefix, dot_rules):
        if cancel_event is not None and cancel_event.is_set():
            return
        try:
            raw_entries = list(os.scandir(dir_path))
        except OSError:
            return
        raw_entries.sort(key=lambda e: e.name)

        local_rules = dot_rules
        if not show_hidden and dir_path != root:
            extra = load_ignore_file(join_posix(dir_path, ".ignore"))
            if extra:
                local_rules = dot_rules + [(dir_path, extra)]

        parsed = []
        for entry in raw_entries:
            name = entry.name
            if not valid_utf8(name):
                continue
            if not show_hidden and name.startswith("."):
                continue
            try:
                is_link = entry.is_symlink()
                if is_link:
                    try:
                        st = os.stat(entry.path)
                        t_dir = statmod.S_ISDIR(st.st_mode)
                        t_file = statmod.S_ISREG(st.st_mode)
                    except OSError:
                        t_dir = False
                        t_file = False
                else:
                    t_dir = entry.is_dir(follow_symlinks=False)
                    t_file = entry.is_file(follow_symlinks=False)
            except OSError:
                continue
            parsed.append((entry.path, name, is_link, t_dir, t_file))

        git_ignored = set()
        if not show_hidden and git_root is not None:
            git_ignored = git_check_ignored_set(git_root, dir_path, [(n, td) for _, n, _, td, _ in parsed])

        for full, name, is_link, t_dir, t_file in parsed:
            if cancel_event is not None and cancel_event.is_set():
                return
            if not show_hidden:
                if name == ".git" or name in git_ignored or is_dot_ignored(local_rules, full, name, t_dir):
                    continue
            rel = name if not rel_prefix else (rel_prefix + "/" + name)
            yield (full, rel, t_dir, is_link, t_file)
            # Symlinks are never followed; with show_hidden, .git itself is yielded
            # but its contents are not traversed (unless root itself is .git).
            if t_dir and not is_link:
                if show_hidden and name == ".git":
                    continue
                yield from recurse(full, rel, local_rules)

    yield from recurse(root, "", base_dot_rules)


def op_find_files(root, limit):
    if not os.path.isdir(root):
        raise RuntimeError("%s is not a directory" % root)
    paths = []
    truncated = False
    for _, rel, t_dir, is_link, t_file in _walk_sorted(root, False):
        if not t_file:
            continue
        if len(paths) == limit:
            truncated = True
            break
        paths.append(rel)
    return {"paths": paths, "truncated": truncated}


def op_find_entries(root, limit, show_hidden):
    if not os.path.isdir(root):
        raise RuntimeError("%s is not a directory" % root)
    entries = []
    truncated = False
    for _, rel, t_dir, _, _ in _walk_sorted(root, show_hidden):
        if len(entries) == limit:
            truncated = True
            break
        entries.append({"path": rel, "dir": t_dir})
    return {"entries": entries, "truncated": truncated}


# --- Text search (streaming & cancellable) ---

def _char_ranges_to_utf16(line, char_ranges):
    # Streaming O(1)-extra-memory conversion of ascending char index ranges to
    # UTF-16 code-unit ranges (stops after the last range end).
    out = []
    c_pos = 0
    u_pos = 0
    for s_c, e_c in char_ranges:
        if s_c >= e_c:
            continue
        if s_c > c_pos:
            seg = line[c_pos:s_c]
            u_pos += len(seg.encode("utf-16-le")) // 2
            c_pos = s_c
        u_s = u_pos
        if e_c > c_pos:
            seg = line[c_pos:e_c]
            u_pos += len(seg.encode("utf-16-le")) // 2
            c_pos = e_c
        u_e = u_pos
        if u_s < u_e:
            out.append([u_s, u_e])
    return out


def _window_line(line, ranges_u16):
    first = ranges_u16[0][0]
    column = first + 1
    u16 = line.encode("utf-16-le")
    total_units = len(u16) // 2
    if total_units <= SEARCH_MAX_LINE:
        return {"column": column, "text": line, "ranges": ranges_u16}
    start = max(0, first - SEARCH_CONTEXT_BEFORE)
    if start > 0:
        unit_start = struct.unpack_from("<H", u16, start * 2)[0]
        if 0xDC00 <= unit_start <= 0xDFFF:
            start += 1
    end = min(total_units, start + SEARCH_MAX_LINE)
    if end < total_units:
        unit_end = struct.unpack_from("<H", u16, end * 2)[0]
        if 0xDC00 <= unit_end <= 0xDFFF:
            end -= 1
    lead = 1 if start > 0 else 0
    body = u16[start * 2:end * 2].decode("utf-16-le", errors="replace")
    text = ("…" if start > 0 else "") + body + ("…" if end < total_units else "")
    clipped = []
    for s, e in ranges_u16:
        if s < end:
            clipped.append([max(s, start) - start + lead, min(e, end) - start + lead])
    return {"column": column, "text": text, "ranges": clipped}


def _match_line_re(pattern, line):
    ranges_c = []
    for m in pattern.finditer(line):
        s, e = m.span()
        if s < e:
            ranges_c.append((s, e))
            if len(ranges_c) >= SEARCH_MAX_RANGES:
                break
    if not ranges_c:
        return None
    ranges_u16 = _char_ranges_to_utf16(line, ranges_c)
    return _window_line(line, ranges_u16) if ranges_u16 else None


def _match_line_literal(line, query, case_sensitive, whole_word):
    # Linear-time non-backtracking literal search (safe in-process without GIL DoS).
    hay = line if case_sensitive else line.lower()
    needle = query if case_sensitive else query.lower()
    if not needle:
        return None
    nlen = len(needle)
    hlen = len(hay)
    ranges_c = []
    pos = 0
    while pos <= hlen - nlen:
        idx = hay.find(needle, pos)
        if idx < 0:
            break
        end = idx + nlen
        if whole_word:
            left_ok = idx == 0 or not (hay[idx - 1].isalnum() or hay[idx - 1] == "_")
            right_ok = end == hlen or not (hay[end].isalnum() or hay[end] == "_")
            if not (left_ok and right_ok):
                pos = idx + 1
                continue
        ranges_c.append((idx, end))
        if len(ranges_c) >= SEARCH_MAX_RANGES:
            break
        pos = end
    if not ranges_c:
        return None
    ranges_u16 = _char_ranges_to_utf16(line, ranges_c)
    return _window_line(line, ranges_u16) if ranges_u16 else None


active_searches = {}
searches_lock = threading.Lock()


def _emit_search(search_id, payload):
    send_json({"event": "search", "searchId": search_id, "payload": payload})


def _utf8_byte_ranges_to_utf16(line, byte_ranges):
    # Streaming O(1)-extra-memory conversion of ascending UTF-8 byte ranges to
    # UTF-16 code-unit ranges, rounding outwards around multibyte characters and
    # merging overlaps. Never allocates per-character tuples.
    cleaned = [(s, e) for s, e in byte_ranges if s < e]
    if not cleaned:
        return []
    cleaned.sort()
    b_pos = 0
    u_pos = 0
    out = []
    r_idx = 0
    n_ranges = len(cleaned)
    cur_u_s = None
    s_b, e_b = cleaned[0]

    for ch in line:
        cp = ord(ch)
        if cp < 0x80:
            b_len = 1
        elif cp < 0x800:
            b_len = 2
        elif cp < 0x10000:
            b_len = 3
        else:
            b_len = 4
        u_len = 2 if cp > 0xFFFF else 1
        b_end = b_pos + b_len
        u_end = u_pos + u_len

        while r_idx < n_ranges:
            if cur_u_s is None:
                if b_end <= s_b:
                    break
                cur_u_s = u_pos
            if b_end < e_b:
                break
            u_e = u_end
            if cur_u_s < u_e:
                if out and cur_u_s < out[-1][1]:
                    if u_e > out[-1][1]:
                        out[-1][1] = u_e
                else:
                    out.append([cur_u_s, u_e])
                    if len(out) >= SEARCH_MAX_RANGES:
                        return out
            r_idx += 1
            cur_u_s = None
            if r_idx >= n_ranges:
                return out
            s_b, e_b = cleaned[r_idx]
            if b_end <= s_b:
                break

        b_pos = b_end
        u_pos = u_end

    if r_idx < n_ranges and cur_u_s is not None and cur_u_s < u_pos:
        if out and cur_u_s < out[-1][1]:
            if u_pos > out[-1][1]:
                out[-1][1] = u_pos
        else:
            out.append([cur_u_s, u_pos])
    return out


def _run_search_rg(search_id, root, options, state):
    cancel = state["event"]
    query = options.get("query", "")
    is_regex = bool(options.get("regex", False))
    case_sensitive = bool(options.get("caseSensitive", False))
    whole_word = bool(options.get("wholeWord", False))
    show_hidden = bool(options.get("showHidden", False))
    max_results = int(options.get("maxResults", 2000))

    cmd = ["rg", "--json", "--no-config", "--max-filesize", "8M", "--sort", "path", "--no-follow"]
    if not is_regex:
        cmd.append("--fixed-strings")
    cmd.append("-s" if case_sensitive else "-i")
    if whole_word:
        cmd.append("-w")
    if show_hidden:
        cmd.extend(["--hidden", "--no-ignore", "--glob", "!.git/**"])
    cmd.extend(["-e", query, "."])

    proc = subprocess.Popen(
        cmd,
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    with state["lock"]:
        state["proc"] = proc
        if cancel.is_set():
            try:
                proc.terminate()
            except OSError:
                pass

    # Drain stderr concurrently (bounded to 64 KiB captured) so stderr warnings
    # can never fill the pipe buffer and deadlock rg while stdout is idle.
    stderr_chunks = []

    def _drain_stderr():
        kept = 0
        try:
            while True:
                chunk = proc.stderr.read(8192)
                if not chunk:
                    break
                if kept < 65536:
                    take = chunk[: 65536 - kept]
                    stderr_chunks.append(take)
                    kept += len(take)
        except Exception:
            pass

    err_thread = threading.Thread(target=_drain_stderr, daemon=True)
    err_thread.start()

    pending = []
    last_flush = time.monotonic()
    remaining = max_results
    truncated = False
    files_searched = 0
    cur_path = None
    cur_matches = []

    def flush_pending():
        nonlocal last_flush
        if pending:
            _emit_search(search_id, {"type": "files", "files": list(pending)})
            pending.clear()
            last_flush = time.monotonic()

    def finish_file():
        nonlocal cur_path, cur_matches, remaining
        if cur_path is not None and cur_matches:
            remaining -= len(cur_matches)
            pending.append({"path": cur_path, "matches": cur_matches})
        cur_path = None
        cur_matches = []
        if len(pending) >= SEARCH_BATCH_FILES or (pending and time.monotonic() - last_flush >= SEARCH_FLUSH_INTERVAL):
            flush_pending()

    try:
        while True:
            if cancel.is_set():
                try:
                    proc.terminate()
                except OSError:
                    pass
                break
            raw_line = proc.stdout.readline()
            if not raw_line:
                break
            if cancel.is_set():
                break
            try:
                ev = json.loads(raw_line.decode("utf-8", errors="replace"))
            except Exception:
                continue
            etype = ev.get("type")
            data = ev.get("data") or {}
            if etype == "begin":
                finish_file()
                files_searched += 1
                p = (data.get("path") or {}).get("text")
                if p:
                    cur_path = p[2:] if p.startswith("./") else p
            elif etype == "match" and cur_path is not None:
                lines_obj = data.get("lines") or {}
                if "text" in lines_obj:
                    line_text = lines_obj["text"].rstrip("\r\n")
                    subs = data.get("submatches") or []
                    b_ranges = [(sm["start"], sm["end"]) for sm in subs if sm["end"] > sm["start"]]
                    u16_ranges = _utf8_byte_ranges_to_utf16(line_text, b_ranges)
                elif "bytes" in lines_obj:
                    raw_b = base64.b64decode(lines_obj["bytes"]).rstrip(b"\r\n")
                    line_text = raw_b.decode("utf-8", errors="replace")
                    pat_src = query if is_regex else re.escape(query)
                    if whole_word:
                        pat_src = r"\b(?:%s)\b" % pat_src
                    try:
                        rx = re.compile(pat_src, 0 if case_sensitive else re.IGNORECASE)
                        m_res = _match_line_re(rx, line_text)
                    except re.error:
                        m_res = None
                    if m_res is None:
                        continue
                    if len(cur_matches) >= remaining:
                        truncated = True
                        try:
                            proc.terminate()
                        except OSError:
                            pass
                        break
                    m_res["line"] = int(data.get("line_number") or 0)
                    cur_matches.append(m_res)
                    continue
                else:
                    continue
                if not u16_ranges:
                    continue
                if len(cur_matches) >= remaining:
                    truncated = True
                    try:
                        proc.terminate()
                    except OSError:
                        pass
                    break
                win = _window_line(line_text, u16_ranges)
                win["line"] = int(data.get("line_number") or 0)
                cur_matches.append(win)
            elif etype == "end":
                finish_file()
        finish_file()
        try:
            rc = proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = proc.wait()
        err_thread.join(timeout=2)
        stderr_out = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
        if rc == 2 and not cancel.is_set() and not truncated and not pending and files_searched == 0:
            _emit_search(search_id, {"type": "error", "message": stderr_out or "search failed"})
            return
        flush_pending()
        _emit_search(
            search_id,
            {"type": "done", "truncated": truncated, "cancelled": cancel.is_set(), "filesSearched": files_searched},
        )
    finally:
        with state["lock"]:
            state["proc"] = None
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
        try:
            proc.stdout.close()
        except Exception:
            pass
        try:
            proc.stderr.close()
        except Exception:
            pass
        err_thread.join(timeout=1)


_REGEX_WORKER_CODE = r"""
import json, os, re, struct, sys

SEARCH_MAX_FILE_SIZE = 8 * 1024 * 1024
SEARCH_MAX_LINE = 300
SEARCH_MAX_RANGES = 100
SEARCH_CONTEXT_BEFORE = 60

cfg = json.loads(sys.stdin.readline())
pat_src = cfg["pat"]
flags = int(cfg["flags"])
remaining = int(cfg["maxResults"])
try:
    pattern = re.compile(pat_src, flags)
except re.error as e:
    sys.stdout.write(json.dumps({"type": "error", "message": str(e)}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

def char_ranges_to_utf16(line, char_ranges):
    out = []
    c_pos = 0
    u_pos = 0
    for s_c, e_c in char_ranges:
        if s_c >= e_c:
            continue
        if s_c > c_pos:
            u_pos += len(line[c_pos:s_c].encode("utf-16-le")) // 2
            c_pos = s_c
        u_s = u_pos
        if e_c > c_pos:
            u_pos += len(line[c_pos:e_c].encode("utf-16-le")) // 2
            c_pos = e_c
        if u_s < u_pos:
            out.append([u_s, u_pos])
    return out

def window_line(line, ranges_u16):
    first = ranges_u16[0][0]
    column = first + 1
    u16 = line.encode("utf-16-le")
    total_units = len(u16) // 2
    if total_units <= SEARCH_MAX_LINE:
        return {"column": column, "text": line, "ranges": ranges_u16}
    start = max(0, first - SEARCH_CONTEXT_BEFORE)
    if start > 0 and 0xDC00 <= struct.unpack_from("<H", u16, start * 2)[0] <= 0xDFFF:
        start += 1
    end = min(total_units, start + SEARCH_MAX_LINE)
    if end < total_units and 0xDC00 <= struct.unpack_from("<H", u16, end * 2)[0] <= 0xDFFF:
        end -= 1
    lead = 1 if start > 0 else 0
    body = u16[start * 2:end * 2].decode("utf-16-le", errors="replace")
    text = ("…" if start > 0 else "") + body + ("…" if end < total_units else "")
    clipped = [[max(s, start) - start + lead, min(e, end) - start + lead] for s, e in ranges_u16 if s < end]
    return {"column": column, "text": text, "ranges": clipped}

files_searched = 0
truncated = False
for raw_in in sys.stdin:
    item = json.loads(raw_in)
    full, rel = item[0], item[1]
    try:
        st = os.stat(full)
        if st.st_size > SEARCH_MAX_FILE_SIZE:
            continue
        with open(full, "rb") as f:
            raw = f.read(SEARCH_MAX_FILE_SIZE + 1)
    except OSError:
        continue
    files_searched += 1
    if len(raw) > SEARCH_MAX_FILE_SIZE or b"\x00" in raw:
        continue
    text = raw.decode("utf-8", errors="replace")
    matches = []
    overflow = False
    for line_no, raw_line in enumerate(text.splitlines(), 1):
        ranges_c = []
        for m in pattern.finditer(raw_line):
            s, e = m.span()
            if s < e:
                ranges_c.append((s, e))
                if len(ranges_c) >= SEARCH_MAX_RANGES:
                    break
        if not ranges_c:
            continue
        if len(matches) >= remaining:
            overflow = True
            break
        u16_ranges = char_ranges_to_utf16(raw_line, ranges_c)
        if not u16_ranges:
            continue
        win = window_line(raw_line, u16_ranges)
        win["line"] = line_no
        matches.append(win)
    if matches:
        remaining -= len(matches)
        sys.stdout.write(json.dumps({"type": "file", "file": {"path": rel, "matches": matches}}) + "\n")
        sys.stdout.flush()
    if overflow:
        truncated = True
        break

sys.stdout.write(json.dumps({"type": "done", "truncated": truncated, "filesSearched": files_searched}) + "\n")
sys.stdout.flush()
"""


def _run_search_python_regex_subproc(search_id, root, options, state):
    cancel = state["event"]
    query = options.get("query", "")
    case_sensitive = bool(options.get("caseSensitive", False))
    whole_word = bool(options.get("wholeWord", False))
    show_hidden = bool(options.get("showHidden", False))
    max_results = int(options.get("maxResults", 2000))

    pat_src = r"\b(?:%s)\b" % query if whole_word else query
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        re.compile(pat_src, flags)
    except re.error as e:
        _emit_search(search_id, {"type": "error", "message": str(e)})
        return

    proc = subprocess.Popen(
        [sys.executable, "-u", "-c", _REGEX_WORKER_CODE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    with state["lock"]:
        state["proc"] = proc
        if cancel.is_set():
            try:
                proc.terminate()
            except OSError:
                pass

    def _feed_files():
        try:
            cfg_line = (json.dumps({"pat": pat_src, "flags": flags, "maxResults": max_results}) + "\n").encode("utf-8")
            proc.stdin.write(cfg_line)
            proc.stdin.flush()
            for full, rel, _, is_link, t_file in _walk_sorted(root, show_hidden, cancel):
                if cancel.is_set() or proc.poll() is not None:
                    break
                if is_link or not t_file:
                    continue
                proc.stdin.write((json.dumps([full, rel]) + "\n").encode("utf-8"))
            proc.stdin.flush()
        except Exception:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder = threading.Thread(target=_feed_files, daemon=True)
    feeder.start()

    pending = []
    last_flush = time.monotonic()
    truncated = False
    files_searched = 0

    def flush():
        nonlocal last_flush
        if pending:
            _emit_search(search_id, {"type": "files", "files": list(pending)})
            pending.clear()
            last_flush = time.monotonic()

    try:
        while True:
            if cancel.is_set():
                try:
                    proc.terminate()
                except OSError:
                    pass
                break
            raw_line = proc.stdout.readline()
            if not raw_line:
                break
            if cancel.is_set():
                break
            try:
                ev = json.loads(raw_line.decode("utf-8", errors="replace"))
            except Exception:
                continue
            etype = ev.get("type")
            if etype == "error":
                _emit_search(search_id, {"type": "error", "message": ev.get("message", "search failed")})
                return
            elif etype == "file":
                pending.append(ev["file"])
                if len(pending) >= SEARCH_BATCH_FILES or (time.monotonic() - last_flush >= SEARCH_FLUSH_INTERVAL):
                    flush()
            elif etype == "done":
                truncated = bool(ev.get("truncated", False))
                files_searched = int(ev.get("filesSearched", 0))
        flush()
        _emit_search(
            search_id,
            {"type": "done", "truncated": truncated, "cancelled": cancel.is_set(), "filesSearched": files_searched},
        )
    finally:
        with state["lock"]:
            state["proc"] = None
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
        try:
            proc.stdout.close()
        except Exception:
            pass
        feeder.join(timeout=1)


def _run_search(search_id, root, options, state):
    cancel = state["event"]
    try:
        query = options.get("query", "")
        if not query:
            _emit_search(search_id, {"type": "done", "truncated": False, "cancelled": False, "filesSearched": 0})
            return
        if not os.path.isdir(root):
            _emit_search(search_id, {"type": "error", "message": "%s is not a directory" % root})
            return

        if HAS_RG:
            _run_search_rg(search_id, root, options, state)
            return

        is_regex = bool(options.get("regex", False))
        if is_regex:
            # Isolate backtracking regexes in a killable child process so they
            # can never starve the GIL or block cancellation.
            _run_search_python_regex_subproc(search_id, root, options, state)
            return

        case_sensitive = bool(options.get("caseSensitive", False))
        whole_word = bool(options.get("wholeWord", False))
        show_hidden = bool(options.get("showHidden", False))
        max_results = int(options.get("maxResults", 2000))

        pending = []
        last_flush = time.monotonic()
        remaining = max_results
        truncated = False
        files_searched = 0

        def flush():
            nonlocal last_flush
            if pending:
                _emit_search(search_id, {"type": "files", "files": list(pending)})
                pending.clear()
                last_flush = time.monotonic()

        for full, rel, t_dir, is_link, t_file in _walk_sorted(root, show_hidden, cancel):
            if cancel.is_set():
                break
            if is_link or not t_file:
                continue
            try:
                st = os.stat(full)
                if st.st_size > SEARCH_MAX_FILE_SIZE:
                    continue
                with open(full, "rb") as f:
                    raw = f.read(SEARCH_MAX_FILE_SIZE + 1)
            except OSError:
                continue
            files_searched += 1
            if len(raw) > SEARCH_MAX_FILE_SIZE or b"\x00" in raw:
                continue
            text = raw.decode("utf-8", errors="replace")
            matches = []
            overflow = False
            for line_no, raw_line in enumerate(text.splitlines(), 1):
                if cancel.is_set():
                    break
                found = _match_line_literal(raw_line, query, case_sensitive, whole_word)
                if found is None:
                    continue
                if len(matches) >= remaining:
                    overflow = True
                    break
                found["line"] = line_no
                matches.append(found)
            if matches:
                remaining -= len(matches)
                pending.append({"path": rel, "matches": matches})
            if overflow:
                truncated = True
                break
            if len(pending) >= SEARCH_BATCH_FILES or (pending and time.monotonic() - last_flush >= SEARCH_FLUSH_INTERVAL):
                flush()

        flush()
        _emit_search(
            search_id,
            {"type": "done", "truncated": truncated, "cancelled": cancel.is_set(), "filesSearched": files_searched},
        )
    except Exception as e:
        _emit_search(search_id, {"type": "error", "message": str(e)})
    finally:
        with searches_lock:
            active_searches.pop(search_id, None)


def _cancel_search_state(state):
    state["event"].set()
    with state["lock"]:
        proc = state.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass


def op_search_start(search_id, root, options):
    state = {"event": threading.Event(), "proc": None, "lock": threading.Lock()}
    with searches_lock:
        active_searches[search_id] = state
    t = threading.Thread(target=_run_search, args=(search_id, root, options, state), daemon=True)
    t.start()
    return True


def op_search_cancel(search_id):
    with searches_lock:
        state = active_searches.get(search_id)
    if state is not None:
        _cancel_search_state(state)
    return True


# --- Completion ---

_path_cache = {}
_path_cache_lock = threading.Lock()


def _executables_in(dir_path):
    names = []
    try:
        for entry in os.scandir(dir_path):
            if not valid_utf8(entry.name):
                continue
            try:
                st = os.stat(entry.path)
                if statmod.S_ISREG(st.st_mode) and (st.st_mode & 0o111) != 0:
                    names.append(entry.name)
            except OSError:
                continue
    except OSError:
        return []
    return names


def op_path_commands(path_var):
    if path_var is None:
        path_var = os.environ.get("PATH", "")
    seen = set()
    names = set()
    now = time.monotonic()
    for d in path_var.split(":"):
        if not d.startswith("/") or d in seen:
            continue
        seen.add(d)
        try:
            mtime = os.stat(d).st_mtime_ns
        except OSError:
            continue
        with _path_cache_lock:
            hit = _path_cache.get(d)
            if hit is not None and hit[0] == mtime and (now - hit[1]) < PATH_CACHE_TTL:
                names.update(hit[2])
                continue
        found = _executables_in(d)
        with _path_cache_lock:
            _path_cache[d] = (mtime, now, found)
        names.update(found)
    return sorted(names)


def op_complete_list(dir_path):
    try:
        raw_entries = list(os.scandir(dir_path))
    except OSError as e:
        raise RuntimeError("cannot list %s: %s" % (dir_path, e))
    out = []
    for entry in raw_entries:
        if not valid_utf8(entry.name):
            continue
        try:
            st = os.stat(entry.path)
            is_dir = statmod.S_ISDIR(st.st_mode)
            is_exec = statmod.S_ISREG(st.st_mode) and (st.st_mode & 0o111) != 0
        except OSError:
            is_dir = False
            is_exec = False
        out.append({"name": entry.name, "dir": is_dir, "executable": is_exec})
    out.sort(key=lambda e: e["name"])
    return out


# --- Real-time directory watching (inotify on Linux, kqueue+stat on macOS, stat poll fallback) ---

def _dir_snapshot(dir_path):
    # Lightweight snapshot of one directory (non-recursive): dir mtime + entry (mtime_ns, size)
    try:
        dst = os.stat(dir_path)
    except OSError:
        return None
    items = []
    try:
        with os.scandir(dir_path) as it:
            count = 0
            for e in it:
                count += 1
                if count > 2000:
                    break
                try:
                    st = os.lstat(e.path)
                    items.append((e.name, st.st_mtime_ns, st.st_size))
                except OSError:
                    items.append((e.name, 0, 0))
    except OSError:
        pass
    items.sort()
    return (dst.st_mtime_ns, tuple(items))


class WatchService:
    def __init__(self):
        self._lock = threading.Lock()
        self._watches = {}  # watch_id -> set(requested_dir)
        self._stop = threading.Event()
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_r, False)
        os.set_blocking(self._wake_w, False)
        self._inotify_fd = -1
        self._mode = "poll"
        if _SYS == "Linux" and _LIBC is not None and hasattr(_LIBC, "inotify_init1"):
            fd = _LIBC.inotify_init1(0o4000 | 0o2000000)  # IN_NONBLOCK | IN_CLOEXEC
            if fd >= 0:
                self._inotify_fd = fd
                self._mode = "inotify"
        elif _SYS == "Darwin" and hasattr(select, "kqueue"):
            self._mode = "kqueue"
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    @property
    def mode(self):
        return self._mode

    def _wake(self):
        try:
            os.write(self._wake_w, b"x")
        except OSError:
            pass

    def _drain_wake(self):
        while True:
            try:
                if not os.read(self._wake_r, 64):
                    break
            except OSError:
                break

    def set_dirs(self, watch_id, dirs):
        with self._lock:
            self._watches[watch_id] = list(dict.fromkeys(dirs))
        self._wake()

    def stop_watch(self, watch_id):
        with self._lock:
            self._watches.pop(watch_id, None)
        self._wake()

    def shutdown(self):
        self._stop.set()
        self._wake()

    def _desired_map(self):
        # Returns (watch_id -> [dirs], unique_dirs -> [watch_ids])
        with self._lock:
            snap = {wid: list(ds) for wid, ds in self._watches.items()}
        by_dir = {}
        for wid, ds in snap.items():
            for d in ds:
                by_dir.setdefault(d, []).append(wid)
        return snap, by_dir

    def _run(self):
        if self._mode == "inotify":
            self._run_inotify()
        elif self._mode == "kqueue":
            self._run_kqueue()
        else:
            self._run_poll()

    def _emit_pending(self, pending):
        # pending: watch_id -> set(dirs)
        for wid, dirs in list(pending.items()):
            if dirs:
                send_json({"event": "watch", "watchId": wid, "dirs": sorted(dirs)})
        pending.clear()

    def _run_inotify(self):
        # IN_MODIFY|IN_ATTRIB|IN_CLOSE_WRITE|IN_MOVED_FROM|IN_MOVED_TO|IN_CREATE|IN_DELETE|IN_DELETE_SELF|IN_MOVE_SELF
        MASK = 0x00000002 | 0x00000004 | 0x00000008 | 0x00000040 | 0x00000080 | 0x00000100 | 0x00000200 | 0x00000400 | 0x00000800
        # Linux returns the same wd for symlink/bind aliases resolving to one dir,
        # so map each wd to ALL active aliases and remove the kernel watch only
        # when the last alias is dropped.
        wd_to_dirs = {}
        dir_to_wd = {}
        fallback_snaps = {}
        pending = {}
        flush_at = None
        last_poll = time.monotonic()

        while not self._stop.is_set():
            _, by_dir = self._desired_map()
            wanted = set(by_dir.keys())
            for d in list(dir_to_wd.keys()):
                if d not in wanted:
                    wd = dir_to_wd.pop(d)
                    aliases = wd_to_dirs.get(wd)
                    if aliases is not None:
                        aliases.discard(d)
                        if not aliases:
                            wd_to_dirs.pop(wd, None)
                            _LIBC.inotify_rm_watch(ctypes.c_int(self._inotify_fd), ctypes.c_int(wd))
            for d in list(fallback_snaps.keys()):
                if d not in wanted:
                    fallback_snaps.pop(d, None)
            for d in wanted:
                if d in dir_to_wd or d in fallback_snaps:
                    continue
                if not os.path.isdir(d):
                    continue
                wd = _LIBC.inotify_add_watch(ctypes.c_int(self._inotify_fd), ctypes.c_char_p(os.fsencode(d)), ctypes.c_uint32(MASK))
                if wd >= 0:
                    dir_to_wd[d] = wd
                    wd_to_dirs.setdefault(wd, set()).add(d)
                else:
                    fallback_snaps[d] = _dir_snapshot(d)

            timeout = WATCH_POLL_INTERVAL if fallback_snaps else 30.0
            if flush_at is not None:
                timeout = min(timeout, max(0.0, flush_at - time.monotonic()))
            rlist, _, _ = select.select([self._wake_r, self._inotify_fd], [], [], timeout)
            if self._wake_r in rlist:
                self._drain_wake()
            if self._inotify_fd in rlist:
                try:
                    buf = os.read(self._inotify_fd, 65536)
                except OSError:
                    buf = b""
                off = 0
                while off + 16 <= len(buf):
                    wd, mask, cookie, name_len = struct.unpack_from("iIII", buf, off)
                    off += 16 + name_len
                    aliases = list(wd_to_dirs.get(wd, ()))
                    if mask & 0x8000:  # IN_IGNORED: kernel removed this watch
                        wd_to_dirs.pop(wd, None)
                        for a in aliases:
                            if dir_to_wd.get(a) == wd:
                                dir_to_wd.pop(a, None)
                    elif mask & (0x0400 | 0x0800):  # IN_DELETE_SELF | IN_MOVE_SELF
                        # Drop the moved/deleted inode watch so the next loop
                        # iteration rebinds the pathname if replaced.
                        wd_to_dirs.pop(wd, None)
                        for a in aliases:
                            if dir_to_wd.get(a) == wd:
                                dir_to_wd.pop(a, None)
                        _LIBC.inotify_rm_watch(ctypes.c_int(self._inotify_fd), ctypes.c_int(wd))
                    for d in aliases:
                        if d in by_dir:
                            for wid in by_dir[d]:
                                pending.setdefault(wid, set()).add(d)
                            if flush_at is None:
                                flush_at = time.monotonic() + WATCH_DEBOUNCE
            if fallback_snaps and time.monotonic() - last_poll >= WATCH_POLL_INTERVAL:
                last_poll = time.monotonic()
                for d in list(fallback_snaps.keys()):
                    cur = _dir_snapshot(d)
                    if cur != fallback_snaps[d]:
                        fallback_snaps[d] = cur
                        for wid in by_dir.get(d, ()):
                            pending.setdefault(wid, set()).add(d)
                        if flush_at is None:
                            flush_at = time.monotonic() + WATCH_DEBOUNCE
            if flush_at is not None and time.monotonic() >= flush_at:
                self._emit_pending(pending)
                flush_at = None

        for wd in list(wd_to_dirs.keys()):
            _LIBC.inotify_rm_watch(ctypes.c_int(self._inotify_fd), ctypes.c_int(wd))
        os.close(self._inotify_fd)

    def _run_kqueue(self):
        kq = select.kqueue()
        dir_to_fd = {}
        fd_to_dir = {}
        snaps = {}
        pending = {}
        flush_at = None
        last_poll = time.monotonic()
        NOTE_FLAGS = (
            select.KQ_NOTE_WRITE
            | select.KQ_NOTE_DELETE
            | select.KQ_NOTE_RENAME
            | select.KQ_NOTE_EXTEND
            | select.KQ_NOTE_ATTRIB
        )
        # Register wake pipe on kqueue
        kq.control([select.kevent(self._wake_r, filter=select.KQ_FILTER_READ, flags=select.KQ_EV_ADD)], 0)

        try:
            while not self._stop.is_set():
                _, by_dir = self._desired_map()
                wanted = set(by_dir.keys())
                for d in list(dir_to_fd.keys()):
                    if d not in wanted:
                        fd = dir_to_fd.pop(d)
                        fd_to_dir.pop(fd, None)
                        snaps.pop(d, None)
                        try:
                            os.close(fd)
                        except OSError:
                            pass
                for d in wanted:
                    if d in dir_to_fd or not os.path.isdir(d):
                        continue
                    try:
                        fd = os.open(d, os.O_RDONLY | getattr(os, "O_EVTONLY", 0))
                        kq.control(
                            [select.kevent(fd, filter=select.KQ_FILTER_VNODE, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=NOTE_FLAGS)],
                            0,
                        )
                        dir_to_fd[d] = fd
                        fd_to_dir[fd] = d
                        snaps[d] = _dir_snapshot(d)
                    except OSError:
                        pass

                timeout = WATCH_POLL_INTERVAL if dir_to_fd else 30.0
                if flush_at is not None:
                    timeout = min(timeout, max(0.0, flush_at - time.monotonic()))
                events = kq.control(None, 64, timeout)
                for ev in events:
                    if ev.ident == self._wake_r:
                        self._drain_wake()
                    else:
                        d = fd_to_dir.get(ev.ident)
                        if d and d in by_dir:
                            snaps[d] = _dir_snapshot(d)
                            for wid in by_dir[d]:
                                pending.setdefault(wid, set()).add(d)
                            if flush_at is None:
                                flush_at = time.monotonic() + WATCH_DEBOUNCE
                if dir_to_fd and time.monotonic() - last_poll >= WATCH_POLL_INTERVAL:
                    last_poll = time.monotonic()
                    for d in list(dir_to_fd.keys()):
                        cur = _dir_snapshot(d)
                        if cur != snaps.get(d):
                            snaps[d] = cur
                            for wid in by_dir.get(d, ()):
                                pending.setdefault(wid, set()).add(d)
                            if flush_at is None:
                                flush_at = time.monotonic() + WATCH_DEBOUNCE
                if flush_at is not None and time.monotonic() >= flush_at:
                    self._emit_pending(pending)
                    flush_at = None
        finally:
            for fd in dir_to_fd.values():
                try:
                    os.close(fd)
                except OSError:
                    pass
            kq.close()

    def _run_poll(self):
        snaps = {}
        pending = {}
        while not self._stop.is_set():
            _, by_dir = self._desired_map()
            wanted = set(by_dir.keys())
            for d in list(snaps.keys()):
                if d not in wanted:
                    snaps.pop(d, None)
            for d in wanted:
                cur = _dir_snapshot(d)
                if d not in snaps:
                    snaps[d] = cur
                elif cur != snaps[d]:
                    snaps[d] = cur
                    for wid in by_dir.get(d, ()):
                        pending.setdefault(wid, set()).add(d)
            if pending:
                self._emit_pending(pending)
            rlist, _, _ = select.select([self._wake_r], [], [], WATCH_POLL_INTERVAL if wanted else 30.0)
            if self._wake_r in rlist:
                self._drain_wake()


watch_service = WatchService()


def dispatch(req):
    req_id = req["id"]
    op = req["op"]
    try:
        if op == "hello":
            send_ok(req_id, {
                "home": os.path.expanduser("~"),
                "os": platform.system(),
                "arch": platform.machine(),
                "pid": os.getpid(),
                "hasRg": HAS_RG,
                "hasGit": HAS_GIT,
                "watchMode": watch_service.mode,
            })
        elif op == "list_dir":
            send_ok(req_id, op_list_dir(req["path"], bool(req.get("showHidden", False))))
        elif op == "stat":
            send_ok(req_id, op_stat(req["path"]))
        elif op == "stat_batch":
            send_ok(req_id, op_stat_batch(req["paths"]))
        elif op == "create":
            op_create(req["path"], bool(req.get("dir", False)))
            send_ok(req_id, None)
        elif op == "rename":
            op_rename(req["from"], req["to"])
            send_ok(req_id, None)
        elif op == "delete":
            op_delete(req["paths"])
            send_ok(req_id, None)
        elif op == "copy_into":
            send_ok(req_id, op_copy_into(req["from"], req["toDir"]))
        elif op == "read_text":
            send_ok(req_id, op_read_text(req["path"], int(req.get("limit", TEXT_LIMIT))))
        elif op == "read_bytes":
            raw = op_read_bytes(req["path"], int(req.get("limit", BYTES_LIMIT)))
            send_bytes(req_id, raw)
        elif op == "write_text":
            send_ok(req_id, op_write_text(req["path"], req["text"], req["expect"]))
        elif op == "transfer_open_read":
            send_ok(req_id, op_transfer_open_read(req["path"]))
        elif op == "transfer_read":
            raw = op_transfer_read(int(req["handle"]), int(req.get("maxBytes", 512 * 1024)))
            send_bytes(req_id, raw)
        elif op == "transfer_open_write":
            send_ok(req_id, op_transfer_open_write(req["path"]))
        elif op == "transfer_write":
            op_transfer_write(int(req["handle"]), req["data"])
            send_ok(req_id, None)
        elif op == "transfer_finish_write":
            op_transfer_finish_write(int(req["handle"]), req.get("mode"))
            send_ok(req_id, None)
        elif op == "transfer_close":
            op_transfer_close(int(req["handle"]))
            send_ok(req_id, None)
        elif op == "mkdir_private":
            send_ok(req_id, op_mkdir_private(req["path"]))
        elif op == "rename_no_replace":
            op_rename_no_replace(req["from"], req["to"])
            send_ok(req_id, None)
        elif op == "list_copy_children":
            send_ok(req_id, op_list_copy_children(req["dir"]))
        elif op == "symlink_new":
            send_ok(req_id, op_symlink_new(req["target"], req["dest"]))
        elif op == "readlink":
            send_ok(req_id, op_readlink(req["path"]))
        elif op == "lstat_meta":
            send_ok(req_id, op_lstat_meta(req["path"]))
        elif op == "chmod":
            op_chmod(req["path"], int(req["mode"]))
            send_ok(req_id, None)
        elif op == "remove_single":
            op_remove_single(req["path"], bool(req.get("dir", False)), req.get("dev"), req.get("ino"))
            send_ok(req_id, None)
        elif op == "file_version":
            send_ok(req_id, op_file_version(req["path"]))
        elif op == "git_status":
            send_ok(req_id, op_git_status(req["path"]))
        elif op == "git_exec":
            send_ok(
                req_id,
                op_git_exec(
                    req["cwd"],
                    req["args"],
                    req.get("stdinB64"),
                    bool(req.get("readOnly", True)),
                    req.get("timeoutSecs", 30),
                ),
            )
        elif op == "git_read_untracked":
            raw = op_git_read_untracked(
                req["root"],
                req["gitDir"],
                req["relPath"],
                int(req.get("maxBytes", 2 * 1024 * 1024)),
            )
            send_bytes(req_id, raw)
        elif op == "git_remove_untracked":
            op_git_remove_untracked(req["root"], req["gitDir"], req["relPaths"])
            send_ok(req_id, None)
        elif op == "find_files":
            send_ok(req_id, op_find_files(req["root"], int(req.get("limit", 50000))))
        elif op == "find_entries":
            send_ok(req_id, op_find_entries(req["root"], int(req.get("limit", 50000)), bool(req.get("showHidden", False))))
        elif op == "search_start":
            send_ok(req_id, op_search_start(int(req["searchId"]), req["root"], req["options"]))
        elif op == "search_cancel":
            send_ok(req_id, op_search_cancel(int(req["searchId"])))
        elif op == "watch_set":
            watch_service.set_dirs(int(req["watchId"]), req["dirs"])
            send_ok(req_id, None)
        elif op == "watch_stop":
            watch_service.stop_watch(int(req["watchId"]))
            send_ok(req_id, None)
        elif op == "path_commands":
            send_ok(req_id, op_path_commands(req.get("path")))
        elif op == "complete_list":
            send_ok(req_id, op_complete_list(req["dir"]))
        else:
            send_err(req_id, "unknown op: %s" % op)
    except Exception as e:
        send_err(req_id, e)


def main():
    pool = ThreadPoolExecutor(max_workers=8)
    try:
        while True:
            line = stdin_buf.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            pool.submit(dispatch, req)
    finally:
        watch_service.shutdown()
        with searches_lock:
            states = list(active_searches.values())
        for st in states:
            _cancel_search_state(st)
        _close_all_transfers()
        pool.shutdown(wait=False)


main()
