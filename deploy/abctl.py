#!/usr/bin/env python3
"""abctl — poolmanager A/B 双槽发布(安卓式:同一时刻只有一个槽在用,另一个是热备)。

语义(和安卓手机 A/B 系统更新一样):
  * manager-a / manager-b 两个槽的容器都一直在跑,但只有「活动槽」接 HAProxy 流量、跑后台单活任务
    (健康检查、拉起实例、官方额度探测);「备用槽」进程活着、/readyz 200,不接流量、不抢 leader 锁。
  * deploy <image>:新镜像装进备用槽 → 等就绪 → 交接后台任务(Redis 活动槽改成新槽,旧槽数秒内放锁)→
    切流(HAProxy 运行时 map,毫秒级、不 reload)→ 等旧槽在飞的流式响应排空 → 旧槽按它原来的镜像重建成
    干净的备用槽(保留上一版本 = 回滚点)。
  * rollback:纯切流到备用槽(它装着上一版本),秒级;switch <a|b> 同理但不看版本。
  * 每一步都先写进 deploy/state/operation.json;中途断了 `resume` 从断点继续,绝不半吊子。
  * 没有灰度/两槽同时接流。要验证备用槽,直接打它的容器端口(docker compose exec manager-b …)。
  * runner(托管 codexs 实例)不分槽,`runner <image>` 单独滚动(实例会重启一次,由后台任务拉回)。

日常用法(在 compose 目录执行;命令实际由 deployment 容器执行,CLI 只是客户端):
  python3 deploy/abctl.py status
  python3 deploy/abctl.py releases
  python3 deploy/abctl.py deploy latest | <短 sha> | ghcr.io/meglinge/codexs-poolmanager:sha-<sha>
  python3 deploy/abctl.py rollback
  python3 deploy/abctl.py switch b
  python3 deploy/abctl.py resume
  python3 deploy/abctl.py runner latest | <短 sha> | <镜像>
  加 --direct 可不经 deployment 容器、在宿主机直接执行(需要 docker CLI 与 HAProxy 管理端口)。

状态文件(deploy/state,必须在持久盘上,永远不要删掉来「重置」):
  active.map      HAProxy 读的映射(main → manager_a | manager_b),也是「活动槽」的唯一真身
  images.json     两槽 + runner 各自的镜像
  images.env      同上,给手工 `docker compose --env-file .env --env-file deploy/state/images.env` 用
  operation.json  进行中的操作(kind/stage/…),stage=idle 表示没有未完成操作
  history.json    最近的发布/切换记录
  panel-job.json  最近一次后台任务的错误(面板显示)
  releases-cache.json  每个不可变标签的镜像元数据(构建时间、提交说明)
  deploy.lock     flock,保证同一时刻只有一个发布操作
"""
import argparse
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "deploy" / "state"
ENV_FILE = ROOT / ".env"
SLOTS = ("a", "b")
HAPROXY_MAP = "/etc/haproxy/state/active.map"
MAP_KEY = "main"
REDIS_PREFIX = "pm:"
STAGES = ("idle", "preparing", "quiescing", "cutover", "retiring")
# CI 每次 push main 都发 sha-<sha7> 不可变标签(manager 与 runner 用同一个镜像)
IMAGE_REPO = os.environ.get("IMAGE_REPO") or "ghcr.io/meglinge/codexs-poolmanager"
TAG_PREFIX = "sha-"
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
IDLE_OP = {"stage": "idle"}


class DeployError(RuntimeError):
    """业务层拒绝/失败:信息可以直接给操作者看(不含 Docker 输出、环境值)。"""


def other(slot):
    return "b" if slot == "a" else "a"


def durable_write(path, text):
    """先写临时文件 → fsync → rename → fsync 目录:断电也只会看到旧内容或新内容。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


IMAGE_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,200}(:[A-Za-z0-9._-]{1,128}|@sha256:[0-9a-f]{64})$")
MUTABLE_TAGS = {"latest", "main", "master", "edge", "nightly", "dev"}


def validate_image(image):
    """镜像必须是不可变标签(sha-<sha> / vX.Y.Z / @sha256:…);latest 之类一律拒绝,否则「回滚点」没有意义。"""
    if not isinstance(image, str) or not IMAGE_RE.match(image):
        raise ValueError("镜像必须形如 registry/repo:tag 或 repo@sha256:…")
    if ":" in image.rsplit("/", 1)[-1] and "@" not in image:
        tag = image.rsplit(":", 1)[-1]
        if tag.lower() in MUTABLE_TAGS:
            raise ValueError(f"拒绝可变标签 :{tag} —— 请用不可变的版本标签(如 sha-<sha>)")
    return image


def read_env_file():
    env = {}
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


# ---------------------------------------------------------------------------
# 进程锁
# ---------------------------------------------------------------------------

try:
    import fcntl  # type: ignore
except ImportError:  # Windows 开发机:退化成线程锁(生产只在 Linux 容器里跑)
    fcntl = None
_thread_lock = threading.Lock()


class locked:
    """独占 deploy/state/deploy.lock;拿不到立即抛 DeployError(不排队,让操作者自己决定)。"""

    def __init__(self):
        self.fd = None
        self.held_thread_lock = False

    def __enter__(self):
        STATE.mkdir(parents=True, exist_ok=True)
        if fcntl is None:
            if not _thread_lock.acquire(blocking=False):
                raise DeployError("另一个发布操作正在进行")
            self.held_thread_lock = True
            return self
        lock_path = str(STATE / "deploy.lock")
        try:
            self.fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        except PermissionError:
            self.fd = os.open(lock_path, os.O_RDONLY)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd)
            self.fd = None
            raise DeployError("另一个发布操作正在进行")
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
        if self.held_thread_lock:
            _thread_lock.release()
            self.held_thread_lock = False
        return False


def lock_busy():
    try:
        with locked():
            return False
    except DeployError:
        return True


# ---------------------------------------------------------------------------
# 版本检测:直接问镜像仓库(ghcr)有哪些 sha-<sha> 标签,按镜像构建时间排序;
# 元数据(构建时间、提交说明)来自镜像标签(CI 写入),缺提交说明且配了 GITHUB_TOKEN 时再问 GitHub。
# 标签不可变,所以每个标签的元数据只抓一次,持久缓存在 deploy/state/releases-cache.json。
# ---------------------------------------------------------------------------

def image_sha(image):
    """从 repo:sha-<sha> 里取出短 sha;不是 CI 标签返回 None。"""
    if not image or ":" not in image.rsplit("/", 1)[-1]:
        return None
    tag = image.rsplit(":", 1)[-1]
    if tag.startswith(TAG_PREFIX) and SHA_RE.match(tag[len(TAG_PREFIX):]):
        return tag[len(TAG_PREFIX):]
    return None


class Releases:
    MANIFEST_ACCEPT = ", ".join([
        "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"])

    def __init__(self, repo=None, fetch=None, github_token=None, docker_config=None, log=None):
        self.repo = repo or IMAGE_REPO
        self.host, _, self.path = self.repo.partition("/")
        self.fetch = fetch or self._fetch
        self.github_token = github_token if github_token is not None else os.environ.get("GITHUB_TOKEN", "")
        self.docker_config = docker_config or os.environ.get("DOCKER_CONFIG_FILE") or os.path.expanduser("~/.docker/config.json")
        self.log = log or (lambda m: None)
        self._token = None

    @staticmethod
    def _fetch(url, headers=None, timeout=20):
        req = urllib.request.Request(url, headers={"User-Agent": "poolmanager-deploy", **(headers or {})})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()

    def _json(self, url, headers=None):
        _, _, body = self.fetch(url, headers)
        return json.loads(body.decode() or "{}")

    def registry_token(self):
        if self._token:
            return self._token
        basic = ""
        try:
            auths = json.loads(Path(self.docker_config).read_text(encoding="utf-8")).get("auths", {})
            basic = (auths.get(self.host) or auths.get("https://" + self.host) or {}).get("auth", "")
        except (OSError, ValueError):
            pass
        headers = {"Authorization": "Basic " + basic} if basic else {}
        q = urllib.parse.urlencode({"scope": f"repository:{self.path}:pull", "service": self.host})
        self._token = self._json(f"https://{self.host}/token?{q}", headers).get("token", "")
        return self._token

    def _reg(self, path, accept=None):
        headers = {"Authorization": "Bearer " + self.registry_token()}
        if accept:
            headers["Accept"] = accept
        return self._json(f"https://{self.host}/v2/{self.path}/{path}", headers)

    def tags(self):
        out, url = [], "tags/list?n=1000"
        for _ in range(10):
            d = self._reg(url)
            out.extend(d.get("tags") or [])
            if not d.get("next"):
                break
            url = d["next"]
        return set(out)

    def image_meta(self, tag):
        """{created, revision, message?, author?}:构建时间与完整 commit sha 来自 OCI 标签,提交说明来自 CI 写的 pm.commit.*。"""
        m = self._reg(f"manifests/{tag}", self.MANIFEST_ACCEPT)
        if "manifests" in m:  # 多架构 index:挑真正的平台清单(provenance 附件 os=unknown)
            child = next((x for x in m["manifests"] if (x.get("platform") or {}).get("os") not in (None, "unknown")), None)
            if not child:
                return {}
            m = self._reg(f"manifests/{child['digest']}", self.MANIFEST_ACCEPT)
        cfg = (m.get("config") or {}).get("digest")
        if not cfg:
            return {}
        c = self._reg(f"blobs/{cfg}")
        labels = (c.get("config") or {}).get("Labels") or {}
        meta = {"created": labels.get("org.opencontainers.image.created") or c.get("created"),
                "revision": labels.get("org.opencontainers.image.revision")}
        if labels.get("pm.commit.subject"):
            meta["message"] = labels["pm.commit.subject"][:200]
            meta["author"] = labels.get("pm.commit.author") or None
        return meta

    def github_commit(self, full_sha):
        if not self.github_token or not full_sha or "/" not in self.path:
            return None
        try:
            d = self._json(f"https://api.github.com/repos/{self.path}/commits/{full_sha}",
                           {"Authorization": "Bearer " + self.github_token, "Accept": "application/vnd.github+json"})
        except (urllib.error.URLError, ValueError, OSError):
            return None
        commit = d.get("commit") or {}
        return {"message": (commit.get("message") or "").split("\n", 1)[0][:200],
                "author": (commit.get("author") or {}).get("name")}

    def load_cache(self):
        return read_json(STATE / "releases-cache.json", {})

    def save_cache(self, cache):
        durable_write(STATE / "releases-cache.json", json.dumps(cache, ensure_ascii=False))

    def collect(self, running):
        tags = self.tags()
        shas = sorted(t[len(TAG_PREFIX):] for t in tags if t.startswith(TAG_PREFIX) and SHA_RE.match(t[len(TAG_PREFIX):]))
        cache = self.load_cache()
        missing = [sha for sha in shas if sha not in cache or (self.github_token and "message" not in cache[sha])]

        def fill(sha):
            entry = dict(cache.get(sha) or {})
            if "created" not in entry:
                try:
                    entry.update(self.image_meta(TAG_PREFIX + sha))
                except (urllib.error.URLError, ValueError, OSError, KeyError) as e:
                    self.log(f"读取镜像元数据失败 {sha}: {e}")
                    return sha, None
            if self.github_token and "message" not in entry:
                gc = self.github_commit(entry.get("revision") or sha)
                if gc:
                    entry.update(gc)
            return sha, entry

        if missing:
            self.log(f"抓取 {len(missing)} 个版本的元数据")
            with ThreadPoolExecutor(max_workers=8) as ex:
                for sha, entry in ex.map(fill, missing):
                    if entry:
                        cache[sha] = entry
            self.save_cache(cache)

        where = {}
        for k, v in (running or {}).items():
            if v and k != "active":
                where.setdefault(v, []).append(k)
        rels = []
        for sha in shas:
            e = cache.get(sha) or {}
            rels.append({"sha": sha, "fullSha": e.get("revision"), "createdAt": e.get("created"),
                         "image": f"{self.repo}:{TAG_PREFIX}{sha}",
                         "message": e.get("message"), "author": e.get("author"), "runningIn": sorted(where.get(sha, []))})
        rels.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
        latest = rels[0] if rels else None
        return {"githubCommits": bool(self.github_token) or any(r.get("message") for r in rels[:15]),
                "checkedAt": time.time(), "error": None,
                "running": running, "latest": latest,
                "updateAvailable": bool(latest and running.get("active") and latest["sha"] != running.get("active")),
                "releases": rels[:15]}


# ---------------------------------------------------------------------------
# 控制器
# ---------------------------------------------------------------------------

class Controller:
    """所有真正的动作都在这里;外部依赖(子进程、sleep、HAProxy socket)可注入,便于测试。"""

    def __init__(self, run=None, sleep=time.sleep, timeout=600, drain_wait=1800, quiesce_wait=120,
                 haproxy_addr=None, hap=None, log=None):
        self.run = run or self._run
        self.sleep = sleep
        self.timeout = timeout
        self.drain_wait = drain_wait
        self.quiesce_wait = quiesce_wait
        self.haproxy_addr = haproxy_addr or os.environ.get("HAPROXY_ADMIN") or "haproxy:9999"
        self._hap = hap
        self.log = log or (lambda msg: print(msg, flush=True))

    @staticmethod
    def _run(argv, env=None, check=True):
        full = dict(os.environ)
        if env:
            full.update(env)
        r = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=full)
        if check and r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip().splitlines()[-8:]
            raise DeployError(f"命令失败({r.returncode}):{shlex.join(argv)}\n" + "\n".join(tail))
        return r.stdout

    def compose(self, *args, check=True):
        return self.run(["docker", "compose", *args], env=self.compose_env(), check=check)

    def compose_env(self):
        """images.json 是镜像的唯一真身;以环境变量喂给 compose,优先级高于 .env。"""
        images = self.read_images()
        env = {}
        for s in SLOTS:
            if images.get(s):
                env[f"SLOT_{s.upper()}_IMAGE"] = images[s]
        if images.get("runner"):
            env["RUNNER_IMAGE"] = images["runner"]
        return env

    # ---- 状态文件 ----
    def read_images(self):
        return read_json(STATE / "images.json", {})

    def write_images(self, images):
        durable_write(STATE / "images.json", json.dumps(images, ensure_ascii=False, indent=2))
        lines = [f"SLOT_{s.upper()}_IMAGE={images[s]}" for s in SLOTS if images.get(s)]
        if images.get("runner"):
            lines.append(f"RUNNER_IMAGE={images['runner']}")
        durable_write(STATE / "images.env", "\n".join(lines) + "\n")

    def read_active(self):
        """active.map 里记录的活动槽;文件缺失或值不合法返回 None。"""
        try:
            for line in (STATE / "active.map").read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[0] == MAP_KEY and parts[1].startswith("manager_"):
                    slot = parts[1][len("manager_"):]
                    return slot if slot in SLOTS else None
        except OSError:
            return None
        return None

    def persist_active(self, slot):
        durable_write(STATE / "active.map", f"{MAP_KEY} manager_{slot}\n")

    def read_operation(self):
        op = read_json(STATE / "operation.json", dict(IDLE_OP))
        if op.get("stage") not in STAGES:
            op["stage"] = "idle"
        return op

    def journal(self, **values):
        op = self.read_operation() if values.get("stage") != "idle" or "kind" not in values else {}
        if "stage" in values and "error" not in values:
            op["error"] = None  # 阶段推进 = 上一次的错误已经过去
        op.update(values)
        op["updatedAt"] = time.time()
        op.setdefault("startedAt", op["updatedAt"])
        durable_write(STATE / "operation.json", json.dumps(op, ensure_ascii=False, indent=2))
        stage = op.get("stage")
        if stage and stage != "idle":
            self.log(f"[{op.get('kind', '?')}] 阶段 → {stage}")
        return op

    def record_history(self, kind, ok, error=None, **extra):
        hist = read_json(STATE / "history.json", [])
        hist.append({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "ok": ok, "error": error, **extra})
        durable_write(STATE / "history.json", json.dumps(hist[-50:], ensure_ascii=False, indent=2))

    def finish(self, kind, ok, error=None, **extra):
        """槽操作收尾:记历史 + 清 journal。runner 滚动不走这里(它不拥有 journal)。"""
        self.record_history(kind, ok, error, **extra)
        durable_write(STATE / "operation.json", json.dumps({"stage": "idle", "updatedAt": time.time()}))

    # ---- HAProxy ----
    def hap(self, command):
        if self._hap:
            return self._hap(command)
        host, _, port = self.haproxy_addr.rpartition(":")
        with socket.create_connection((host or "127.0.0.1", int(port or 9999)), timeout=5) as s:
            s.sendall((command + "\n").encode())
            s.shutdown(socket.SHUT_WR)
            buf = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        return buf.decode(errors="replace").strip()

    def hap_set_map(self, backend):
        out = self.hap(f"set map {HAPROXY_MAP} {MAP_KEY} {backend}")
        if "not found" in out.lower() or "unknown" in out.lower():
            out = self.hap(f"add map {HAPROXY_MAP} {MAP_KEY} {backend}")
        if out and ("error" in out.lower() or "unknown" in out.lower()):
            raise DeployError(f"HAProxy set map 失败:{out}")

    def runtime_active(self):
        """HAProxy 内存里的 map(切流的实际目标);读不到或值不合法返回 None。"""
        try:
            raw = self.hap(f"show map {HAPROXY_MAP}")
        except OSError:
            return None
        for line in raw.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1] == MAP_KEY and parts[2].startswith("manager_"):
                slot = parts[2][len("manager_"):]
                return slot if slot in SLOTS else None
        return None

    def backend_stats(self):
        """{backend: {"servers": [(name, status, weight)], "scur": n, "qcur": n, "up": n}}"""
        raw = self.hap("show stat")
        out = {}
        for line in raw.splitlines():
            if not line or line.startswith("#"):
                continue
            cols = line.split(",")
            if len(cols) < 19:
                continue
            px, sv = cols[0], cols[1]
            b = out.setdefault(px, {"servers": [], "scur": 0, "qcur": 0, "up": 0})
            if sv == "BACKEND":
                b["scur"] = int(cols[4] or 0)
                b["qcur"] = int(cols[2] or 0)
            elif sv != "FRONTEND":
                b["servers"].append((sv, cols[17], cols[18]))
                if cols[17].startswith("UP"):
                    b["up"] += 1
        return out

    # ---- Redis(经 compose exec redis-cli)----
    def redis_get(self, key):
        out = self.compose("exec", "-T", "redis", "redis-cli", "GET", key, check=False)
        out = (out or "").strip()
        return out or None

    def set_active_redis(self, slot):
        """进程眼里的活动槽:manager 的后台循环只在本槽活动时抢 leader 锁,切走后数秒内放锁。"""
        self.compose("exec", "-T", "redis", "redis-cli", "SET", f"{REDIS_PREFIX}deploy:active", slot)
        self.compose("exec", "-T", "redis", "redis-cli", "PUBLISH", f"{REDIS_PREFIX}chan:deploy", slot, check=False)

    def leader_slot(self):
        """当前持有后台任务 leader 锁的槽(holder 形如 `a-<pid>`);没人持有返回 None。"""
        v = self.redis_get(f"{REDIS_PREFIX}leader")
        if not v:
            return None
        slot = v.split("-", 1)[0]
        return slot if slot in SLOTS else None

    # ---- 容器 ----
    def containers(self):
        out = self.compose("ps", "-a", "--format", "json", check=False) or ""
        items = []
        text = out.strip()
        if text.startswith("["):
            try:
                items = json.loads(text)
            except ValueError:
                items = []
        else:
            for line in text.splitlines():
                line = line.strip()
                if line.startswith("{"):
                    try:
                        items.append(json.loads(line))
                    except ValueError:
                        pass
        return [{"name": j.get("Name"), "service": j.get("Service"), "state": j.get("State"),
                 "health": j.get("Health") or "", "image": j.get("Image") or ""} for j in items]

    @staticmethod
    def slot_service(slot):
        return f"manager-{slot}"

    def slot_containers(self, slot, ps):
        return [c for c in ps if c["service"] == self.slot_service(slot)]

    def slot_image(self, slot, ps=None):
        """该槽应当运行的镜像:images.json 优先,没有记录就用容器实际镜像(接管旧部署时)。"""
        img = self.read_images().get(slot)
        if img:
            return img
        for c in self.slot_containers(slot, ps if ps is not None else self.containers()):
            if c["image"]:
                return c["image"]
        return None

    def slot_ready(self, slot, ps=None, stats=None):
        ps = ps if ps is not None else self.containers()
        cs = self.slot_containers(slot, ps)
        if not cs or any(c["state"] != "running" or c["health"] not in ("healthy", "") for c in cs):
            return False
        try:
            stats = stats if stats is not None else self.backend_stats()
        except OSError:
            return False
        return stats.get(f"manager_{slot}", {}).get("up", 0) >= 1

    # ---- 等待 ----
    def wait(self, predicate, description, timeout):
        deadline = time.monotonic() + timeout
        while True:
            try:
                if predicate():
                    return
            except (OSError, DeployError):
                pass
            if time.monotonic() >= deadline:
                raise DeployError(f"等待超时({timeout}s):{description}")
            self.sleep(3)

    def pull_image(self, image):
        """registry 镜像拉取;本机构建的镜像(名字里没有 registry 主机,且本地存在)直接用。"""
        first = image.split("/", 1)[0]
        has_registry = "." in first or ":" in first or first == "localhost"
        if not has_registry:
            local = subprocess.run(["docker", "image", "inspect", image], capture_output=True)
            if local.returncode == 0:
                self.log(f"本地镜像 {image},不拉取")
                return
        self.log(f"拉取镜像 {image}")
        self.run(["docker", "pull", image])

    # ---- 原子步骤 ----
    def prepare(self, candidate, image):
        """把 image 装进 candidate 槽并等它就绪(不接流)。"""
        self.journal(stage="preparing", candidate=candidate, image=image)
        self.pull_image(image)
        images = self.read_images()
        images[candidate] = image
        self.write_images(images)
        self.log(f"重建槽 {candidate} 容器(备用,不接流)")
        self.compose("up", "-d", "--force-recreate", "--no-deps", self.slot_service(candidate))
        self.wait(lambda: self.slot_ready(candidate), f"槽 {candidate} 就绪(容器 healthy + HAProxy 后端 UP)", self.timeout)

    def handoff(self, active, candidate):
        """交接后台任务 + 切流:先让旧槽放掉 leader 锁,再改 HAProxy map,再等旧槽连接排空。"""
        self.journal(stage="quiescing", active=active, candidate=candidate)
        self.set_active_redis(candidate)

        def quiesced():
            holder = self.leader_slot()
            if holder == active:
                self.log(f"槽 {active} 仍持有后台任务 leader 锁")
            return holder != active
        self.wait(quiesced, f"槽 {active} 释放 leader 锁", self.quiesce_wait)

        self.journal(stage="cutover")
        self.persist_active(candidate)
        self.hap_set_map(f"manager_{candidate}")
        self.wait(lambda: self.runtime_active() == candidate, f"HAProxy 运行时 map 指向槽 {candidate}", 30)
        self.log(f"已切流到槽 {candidate};等待槽 {active} 在飞连接排空")
        self.wait_drained(active)

    def wait_drained(self, slot):
        def drained():
            st = self.backend_stats().get(f"manager_{slot}", {})
            n = st.get("scur", 0) + st.get("qcur", 0)
            if n:
                self.log(f"槽 {slot} 仍有 {n} 条连接")
            return n == 0
        self.wait(drained, f"槽 {slot} 连接归零(超时不会强杀;稍后 resume 会继续等)", self.drain_wait)

    def retire(self, old, image):
        """旧槽按指定镜像重建成干净的备用槽(保留回滚点)。"""
        self.journal(stage="retiring", retireImage=image)
        images = self.read_images()
        if image:
            images[old] = image
            self.write_images(images)
        self.log(f"重建槽 {old} 为备用(镜像 {image or '(沿用)'})")
        self.compose("up", "-d", "--force-recreate", "--no-deps", self.slot_service(old))
        self.wait(lambda: self.slot_ready(old), f"备用槽 {old} 就绪", self.timeout)

    # ---- 对外操作 ----
    def require_idle(self):
        op = self.read_operation()
        if op.get("stage") != "idle":
            raise DeployError(f"有未完成的操作({op.get('kind')} / {op.get('stage')}),先 resume")

    def deploy(self, image):
        validate_image(image)
        self.require_idle()
        active = self.read_active()
        if active is None:
            return self.initialize(image)
        candidate = other(active)
        retire_image = self.slot_image(active)
        self.journal(kind="deploy", stage="preparing", active=active, candidate=candidate, image=image,
                     retireImage=retire_image, error=None)
        self._run_from("preparing")

    def initialize(self, image):
        """首次部署:两槽都装 image,槽 A 活动。"""
        self.journal(kind="init", stage="preparing", active=None, candidate="a", image=image, retireImage=image, error=None)
        self._run_from("preparing")

    def switch(self, target, expected_active, kind="switch"):
        if target not in SLOTS:
            raise ValueError("target 必须是 a 或 b")
        self.require_idle()
        active = self.read_active()
        if active is None:
            raise DeployError("当前没有活动槽记录,请先 deploy")
        if expected_active != active:
            raise DeployError(f"活动槽已变为 {active},请刷新后重试")
        if target == active:
            raise DeployError(f"槽 {target} 已经是活动槽")
        ps = self.containers()
        stats = self.backend_stats()
        if not self.slot_ready(target, ps, stats):
            raise DeployError(f"备用槽 {target} 未就绪,拒绝切流")
        st = stats.get(f"manager_{target}", {})
        if st.get("scur", 0) or st.get("qcur", 0):
            raise DeployError(f"备用槽 {target} 上仍有连接,拒绝切流")
        self.journal(kind=kind, stage="quiescing", active=active, candidate=target,
                     image=self.slot_image(target, ps), retireImage=self.slot_image(active, ps), error=None)
        self._run_from("quiescing")

    def rollback(self, expected_active):
        active = self.read_active()
        if active is None:
            raise DeployError("当前没有活动槽记录")
        self.switch(other(active), expected_active, kind="rollback")

    def runner(self, image):
        """滚动 runner:它托管的 codexs 实例会重启一次,由活动槽的后台任务拉回。"""
        validate_image(image)
        self.pull_image(image)
        images = self.read_images()
        images["runner"] = image
        self.write_images(images)
        self.compose("up", "-d", "--force-recreate", "--no-deps", "runner")

        def healthy():
            cs = [c for c in self.containers() if c["service"] == "runner"]
            return bool(cs) and all(c["state"] == "running" and c["health"] in ("healthy", "") for c in cs)
        try:
            self.wait(healthy, "runner 容器 healthy", self.timeout)
        except DeployError as e:
            self.record_history("runner", False, str(e), image=image)
            raise
        self.record_history("runner", True, image=image)

    def resume(self):
        op = self.read_operation()
        if op.get("stage") == "idle":
            raise DeployError("没有可继续的操作")
        self.log(f"从阶段 {op['stage']} 继续 {op.get('kind')}")
        self._run_from(op["stage"])

    def _run_from(self, stage):
        op = self.read_operation()
        kind, active, candidate = op.get("kind"), op.get("active"), op.get("candidate")
        image, retire_image = op.get("image"), op.get("retireImage")
        try:
            if kind == "init":
                if stage == "preparing":
                    self.prepare("a", image)
                    stage = "cutover"
                if stage in ("quiescing", "cutover"):
                    self.journal(stage="cutover")
                    self.set_active_redis("a")
                    self.persist_active("a")
                    self.hap_set_map("manager_a")
                    self.wait(lambda: self.runtime_active() == "a", "HAProxy 运行时 map 指向槽 a", 30)
                    stage = "retiring"
                if stage == "retiring":
                    self.retire("b", image)
                self.finish(kind, True, **{"from": None, "to": "a", "image": image})
                self.log("初始化完成:槽 a 活动,槽 b 备用")
                return
            if stage == "preparing":
                self.prepare(candidate, image)
                stage = "quiescing"
            if stage == "quiescing":
                self.handoff(active, candidate)
                stage = "retiring"
            elif stage == "cutover":
                # 上次在等旧槽排空时中断:map 可能已改也可能没改,重做切流是幂等的
                self.journal(stage="cutover")
                self.set_active_redis(candidate)
                self.persist_active(candidate)
                self.hap_set_map(f"manager_{candidate}")
                self.wait(lambda: self.runtime_active() == candidate, f"HAProxy 运行时 map 指向槽 {candidate}", 30)
                self.wait_drained(active)
                stage = "retiring"
            if stage == "retiring":
                self.retire(active, retire_image)
            self.finish(kind, True, **{"from": active, "to": candidate, "image": image})
            self.log(f"{kind} 完成:槽 {candidate} 活动(镜像 {image}),槽 {active} 备用(镜像 {retire_image})")
        except Exception as e:  # 记录到 journal,stage 保持原地,resume 从这里继续
            self.journal(error=str(e) if isinstance(e, DeployError) else "操作失败,详见控制服务日志")
            raise

    # ---- 版本 ----
    def running_versions(self, ps=None):
        """各处正在跑的短 sha:{a, b, runner, active}。"""
        ps = ps if ps is not None else self.containers()
        images = self.read_images()
        out = {}
        for s in SLOTS:
            out[s] = image_sha(images.get(s) or self.slot_image(s, ps))
        rn = [c for c in ps if c["service"] == "runner"]
        out["runner"] = image_sha(images.get("runner") or (rn[0]["image"] if rn else None))
        active = self.read_active()
        out["active"] = out.get(active) if active else None
        return out

    def releases(self):
        running = self.running_versions()
        rel = Releases(log=self.log)
        try:
            return rel.collect(running)
        except (urllib.error.URLError, ValueError, OSError, KeyError) as e:
            return {"githubCommits": bool(rel.github_token), "checkedAt": time.time(), "error": f"版本检测失败:{e}",
                    "running": running, "latest": None, "updateAvailable": False, "releases": []}

    def resolve_image(self, spec):
        """latest → 最新可用版本;短 sha → 拼标签;完整镜像名原样返回。"""
        if spec == "latest":
            rel = self.releases()
            if rel.get("error") or not rel.get("latest"):
                raise DeployError(rel.get("error") or "没有可用版本")
            return rel["latest"]["image"]
        if SHA_RE.match(spec):
            return f"{IMAGE_REPO}:{TAG_PREFIX}{spec}"
        if spec.startswith(TAG_PREFIX) and SHA_RE.match(spec[len(TAG_PREFIX):]):
            return f"{IMAGE_REPO}:{spec}"
        return spec

    # ---- 状态 ----
    def status(self):
        st = {"enabled": True, "busy": lock_busy(), "slots": {}, "history": read_json(STATE / "history.json", [])[-20:]}
        op = self.read_operation()
        st["operation"] = op
        st["active"] = self.read_active()
        st["lastError"] = (read_json(STATE / "panel-job.json", {}) or {}).get("error")
        errors = []
        try:
            ps = self.containers()
        except DeployError as e:
            ps, errors = [], [f"docker compose ps 失败:{e}"]
        try:
            stats = self.backend_stats()
            st["runtimeActive"] = self.runtime_active()
        except OSError as e:
            stats, st["runtimeActive"] = {}, None
            errors.append(f"HAProxy 管理 socket 不可达:{e}")
        try:
            leader = self.leader_slot()
            st["redisActive"] = self.redis_get(f"{REDIS_PREFIX}deploy:active")
        except DeployError as e:
            leader, st["redisActive"] = None, None
            errors.append(f"Redis 不可达:{e}")
        images = self.read_images()
        for s in SLOTS:
            cs = self.slot_containers(s, ps)
            running = sorted({c["image"] for c in cs if c["image"]})
            stat = stats.get(f"manager_{s}", {})
            slot = {
                "image": images.get(s) or (running[0] if running else None),
                "runningImage": running[0] if len(running) == 1 else (", ".join(running) if running else None),
                "role": "unknown" if st["active"] is None else ("active" if st["active"] == s else "standby"),
                "ready": self.slot_ready(s, ps, stats) if stats else False,
                "containers": [{"name": c["name"], "service": c["service"], "state": c["state"], "health": c["health"]} for c in cs],
                "connections": stat.get("scur"),
                "queued": stat.get("qcur"),
                "leader": leader == s,
            }
            if len(running) > 1:
                slot["error"] = "槽内容器镜像不一致"
            st["slots"][s] = slot
        rn = [c for c in ps if c["service"] == "runner"]
        st["runner"] = {"image": images.get("runner") or (rn[0]["image"] if rn else None),
                        "runningImage": rn[0]["image"] if rn else None,
                        "state": rn[0]["state"] if rn else None, "health": rn[0]["health"] if rn else None}
        if errors:
            st["error"] = ";".join(errors)
        return st


# ---------------------------------------------------------------------------
# CLI:默认作为部署控制服务的客户端;--direct 在本机直接执行
# ---------------------------------------------------------------------------

def server_url():
    return os.environ.get("ABCTL_SERVER") or f"http://127.0.0.1:{read_env_file().get('PM_DEPLOY_PORT', '16828')}"


def server_token():
    tok = os.environ.get("DEPLOY_TOKEN") or read_env_file().get("PM_DEPLOY_TOKEN")
    if not tok:
        raise SystemExit("缺少令牌:设置环境变量 DEPLOY_TOKEN 或 .env 里的 PM_DEPLOY_TOKEN")
    return tok


def api(method, path, body=None):
    req = urllib.request.Request(server_url() + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {server_token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {"error": e.reason}
    except urllib.error.URLError as e:
        raise SystemExit(f"控制服务不可达({server_url()}):{e.reason};是否已 `docker compose up -d deployment`?加 --direct 可在本机直接执行")


def print_status(st):
    if not st.get("enabled", True):
        print("A/B 控制服务未启用")
        return
    op = st.get("operation") or {}
    print(f"活动槽(记录): {st.get('active') or '-'}   HAProxy 实际: {st.get('runtimeActive') or '-'}   "
          f"Redis: {st.get('redisActive') or '-'}   操作: {op.get('kind') or '-'}/{op.get('stage')}   busy={st.get('busy')}")
    if st.get("error"):
        print(f"!! {st['error']}")
    if st.get("lastError"):
        print(f"!! 最近失败: {st['lastError']}")
    if op.get("error"):
        print(f"!! 操作错误: {op['error']}")
    for s in SLOTS:
        sl = (st.get("slots") or {}).get(s) or {}
        flag = "★" if st.get("runtimeActive") == s else " "
        print(f"\n{flag} 槽 {s} [{sl.get('role')}] ready={sl.get('ready')} leader={sl.get('leader')} image={sl.get('image') or '-'}"
              + (f" (实际 {sl.get('runningImage')})" if sl.get("runningImage") and sl.get("runningImage") != sl.get("image") else ""))
        print(f"    连接={sl.get('connections')} 排队={sl.get('queued')}")
        for c in sl.get("containers") or []:
            print(f"    {c['service']:12s} {c['name']:34s} {c['state']:10s} {c.get('health') or ''}")
        if sl.get("error"):
            print(f"    !! {sl['error']}")
    rn = st.get("runner") or {}
    print(f"\nrunner: image={rn.get('image') or '-'} state={rn.get('state')} health={rn.get('health')}")
    if st.get("history"):
        print("\n最近记录:")
        for h in st["history"][-5:]:
            print(f"  {h.get('at')} {h.get('kind'):9s} {h.get('from') or '-'}→{h.get('to') or '-'} {h.get('image') or ''} {'OK' if h.get('ok') else 'FAIL ' + str(h.get('error'))}")


def print_releases(rel):
    run = rel.get("running") or {}
    print(f"正在跑: 槽a={run.get('a') or '-'} 槽b={run.get('b') or '-'} runner={run.get('runner') or '-'} 活动={run.get('active') or '-'}"
          + ("   (镜像无提交说明,可配 PM_GITHUB_TOKEN)" if not rel.get("githubCommits") else ""))
    if rel.get("error"):
        print(f"!! {rel['error']}")
    lat = rel.get("latest") or {}
    print(f"最新可用: {lat.get('sha') or '-'} {lat.get('createdAt') or ''}  {'有新版本' if rel.get('updateAvailable') else '已是最新'}")
    for r in rel.get("releases") or []:
        mark = "★" if r["sha"] == run.get("active") else " "
        where = ",".join(r.get("runningIn") or [])
        print(f"{mark} {r['sha']}  {(r.get('createdAt') or '')[:19]:19s}  {where:12s} {r.get('message') or ''}")


def follow(action):
    """POST 后轮询状态,直到操作结束;返回 exit code。"""
    last = None
    while True:
        time.sleep(2)
        code, st = api("GET", "/status")
        if code != 200:
            print(f"状态查询失败 {code}: {st}")
            return 1
        op = st.get("operation") or {}
        key = (op.get("kind"), op.get("stage"), st.get("busy"))
        if key != last:
            print(f"  … {op.get('kind') or action}/{op.get('stage')} busy={st.get('busy')}", flush=True)
            last = key
        if not st.get("busy") and op.get("stage") == "idle":
            if st.get("lastError"):
                print(f"!! {st['lastError']}")
                return 1
            print_status(st)
            return 0
        if not st.get("busy") and op.get("stage") != "idle":
            print(f"!! 操作在阶段 {op.get('stage')} 停下:{op.get('error') or st.get('lastError')};修好后 `abctl.py resume`")
            return 1


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--direct", action="store_true", help="不经控制服务,在本机直接执行(需 docker CLI + HAProxy 管理端口)")
    p.add_argument("--timeout", type=int, default=int(os.environ.get("DEPLOY_TIMEOUT", "600")), help="等槽就绪的秒数(--direct)")
    p.add_argument("--drain-wait", type=int, default=int(os.environ.get("DEPLOY_DRAIN_WAIT", "1800")), help="等旧槽连接排空的秒数(--direct)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("releases", help="列出仓库里可用的版本(按镜像构建时间)与各处正在跑的版本")
    d = sub.add_parser("deploy"); d.add_argument("image", help="完整镜像名 / 短 sha / latest")
    s = sub.add_parser("switch"); s.add_argument("slot", choices=SLOTS)
    sub.add_parser("rollback")
    sub.add_parser("resume")
    w = sub.add_parser("runner"); w.add_argument("image", help="完整镜像名 / 短 sha / latest")
    a = p.parse_args(argv)
    os.chdir(ROOT)

    if a.direct:
        env = read_env_file()
        hap_addr = os.environ.get("HAPROXY_ADMIN") or f"127.0.0.1:{env.get('PM_HAPROXY_ADMIN_PORT', '8405')}"
        c = Controller(timeout=a.timeout, drain_wait=a.drain_wait, haproxy_addr=hap_addr)
        try:
            if a.cmd == "status":
                print_status(c.status())
                return 0
            if a.cmd == "releases":
                print_releases(c.releases())
                return 0
            with locked():
                if a.cmd == "deploy":
                    c.deploy(c.resolve_image(a.image))
                elif a.cmd == "switch":
                    c.switch(a.slot, c.read_active())
                elif a.cmd == "rollback":
                    c.rollback(c.read_active())
                elif a.cmd == "resume":
                    c.resume()
                elif a.cmd == "runner":
                    c.runner(c.resolve_image(a.image))
            return 0
        except (DeployError, ValueError) as e:
            print(f"!! {e}", file=sys.stderr)
            return 1

    if a.cmd == "status":
        code, st = api("GET", "/status")
        if code != 200:
            print(f"!! {code}: {st.get('error') or st}")
            return 1
        print_status(st)
        return 0
    if a.cmd == "releases":
        code, rel = api("GET", "/releases?refresh=1")
        if code != 200:
            print(f"!! {code}: {rel.get('error') or rel}")
            return 1
        print_releases(rel)
        return 0

    def resolve(spec):
        if spec == "latest":
            _, rel = api("GET", "/releases?refresh=1")
            if rel.get("error") or not rel.get("latest"):
                raise SystemExit(f"!! {rel.get('error') or '没有可用版本'}")
            return rel["latest"]["image"]
        if SHA_RE.match(spec):
            return f"{IMAGE_REPO}:{TAG_PREFIX}{spec}"
        if spec.startswith(TAG_PREFIX) and SHA_RE.match(spec[len(TAG_PREFIX):]):
            return f"{IMAGE_REPO}:{spec}"
        return spec

    if a.cmd == "deploy":
        body, path = {"image": resolve(a.image)}, "/deploy"
    elif a.cmd == "switch":
        _, st = api("GET", "/status")
        body, path = {"target": a.slot, "expectedActive": st.get("active")}, "/switch"
    elif a.cmd == "rollback":
        _, st = api("GET", "/status")
        body, path = {"expectedActive": st.get("active")}, "/rollback"
    elif a.cmd == "resume":
        body, path = {}, "/resume"
    else:
        body, path = {"image": resolve(a.image)}, "/runner"
    print(f"→ POST {path} {json.dumps(body, ensure_ascii=False)}")
    code, resp = api("POST", path, body)
    if code != 202:
        print(f"!! {code}: {resp.get('error') or resp}", file=sys.stderr)
        return 1
    print(f"已受理 {a.cmd},跟踪进度…(Ctrl-C 只是停止跟踪,操作会继续;随时 `abctl.py status`)")
    return follow(a.cmd)


if __name__ == "__main__":
    sys.exit(main())
