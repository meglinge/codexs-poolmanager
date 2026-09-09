#!/usr/bin/env python3
"""abctl 控制器单元测试:用假的子进程/HAProxy/时钟,验证 deploy / switch / rollback / resume 的阶段顺序与安全闸门。

运行:python3 deploy/test_abctl.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import abctl  # noqa: E402
from abctl import Controller, DeployError, Releases, image_sha, validate_image  # noqa: E402


def other(s):
    return "b" if s == "a" else "a"


class FakeWorld:
    """模拟 docker compose / HAProxy / Redis 的最小世界。"""

    def __init__(self):
        self.images = {"a": "repo:sha-aaaaaaa", "b": "repo:sha-aaaaaaa", "runner": "repo:sha-aaaaaaa"}
        self.running = {"a": "repo:sha-aaaaaaa", "b": "repo:sha-aaaaaaa"}
        self.map = {"main": "manager_a"}
        self.redis = {"pm:deploy:active": "a", "pm:leader": "a-100"}
        self.conns = {"a": 3, "b": 0}
        self.commands = []
        self.drain_ticks = 2
        self.quiesce_ticks = 1
        self.fail_on = None
        self._pending_release = None

    def run(self, argv, env=None, check=True):
        cmd = " ".join(argv)
        self.commands.append(cmd)
        if self.fail_on and self.fail_on in cmd:
            raise DeployError(f"模拟失败: {cmd}")
        if argv[:2] == ["docker", "pull"]:
            return ""
        if argv[:2] == ["docker", "compose"]:
            sub = argv[2:]
            if sub[:1] == ["ps"]:
                rows = [{"Name": f"pm-manager-{s}-1", "Service": f"manager-{s}", "State": "running", "Health": "healthy", "Image": self.running[s]}
                        for s in ("a", "b")]
                rows.append({"Name": "pm-runner-1", "Service": "runner", "State": "running", "Health": "healthy", "Image": self.images["runner"]})
                return json.dumps(rows)
            if sub[:1] == ["up"]:
                for svc in sub:
                    if svc.startswith("manager-"):
                        slot = svc.split("-")[1]
                        self.running[slot] = (env or {}).get(f"SLOT_{slot.upper()}_IMAGE", self.running[slot])
                        self.conns[slot] = 0
                        if self.redis.get("pm:leader", "").startswith(slot):
                            self.redis.pop("pm:leader")
                    if svc == "runner":
                        self.images["runner"] = (env or {}).get("RUNNER_IMAGE", self.images["runner"])
                return ""
            if sub[:3] == ["exec", "-T", "redis"]:
                rc = sub[4:]
                if rc[:1] == ["GET"]:
                    return self.redis.get(rc[1]) or ""
                if rc[:1] == ["SET"]:
                    self.redis[rc[1]] = rc[2]
                    self._pending_release = other(rc[2])
                    return "OK"
                if rc[:1] == ["PUBLISH"]:
                    return "1"
        raise AssertionError(f"未预期的命令: {cmd}")

    def hap(self, command):
        if command.startswith("set map"):
            _, _, _, key, val = command.split()
            self.map[key] = val
            return ""
        if command.startswith("show map"):
            return "\n".join(f"0x{i} {k} {v}" for i, (k, v) in enumerate(self.map.items()))
        if command == "show stat":
            lines = ["# pxname,svname,qcur,qmax,scur,...,status,weight"]
            for s in ("a", "b"):
                lines.append(",".join([f"manager_{s}", "manager"] + [""] * 15 + ["UP", "1"]))
                lines.append(",".join([f"manager_{s}", "BACKEND", "0", "0", str(self.conns[s])] + [""] * 12 + ["UP", "1"]))
            return "\n".join(lines)
        raise AssertionError(command)

    def sleep(self, _):
        if self._pending_release and self.quiesce_ticks <= 0:
            if self.redis.get("pm:leader", "").startswith(self._pending_release):
                self.redis.pop("pm:leader")
            self._pending_release = None
        self.quiesce_ticks -= 1
        for s in ("a", "b"):
            if self.map["main"] != f"manager_{s}" and self.conns[s]:
                self.drain_ticks -= 1
                if self.drain_ticks <= 0:
                    self.conns[s] = 0


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        abctl.STATE = Path(self.tmp.name) / "state"
        abctl.STATE.mkdir()
        self.w = FakeWorld()
        (abctl.STATE / "active.map").write_text("main manager_a\n")
        (abctl.STATE / "images.json").write_text(json.dumps(self.w.images))
        self.c = Controller(run=self.w.run, sleep=self.w.sleep, hap=self.w.hap, log=lambda m: None,
                            timeout=60, drain_wait=60, quiesce_wait=60)

    def tearDown(self):
        self.tmp.cleanup()

    def test_deploy_moves_traffic_and_keeps_old_version_as_standby(self):
        self.c.deploy("repo:sha-bbbbbbb")
        self.assertEqual(self.w.map["main"], "manager_b")
        self.assertEqual(self.c.read_active(), "b")
        self.assertEqual(self.w.redis["pm:deploy:active"], "b")
        self.assertEqual(self.w.running, {"a": "repo:sha-aaaaaaa", "b": "repo:sha-bbbbbbb"})
        self.assertEqual(self.c.read_images()["a"], "repo:sha-aaaaaaa")   # 回滚点
        self.assertEqual(self.c.read_operation()["stage"], "idle")
        # 顺序:先装 b、再切流、再重建 a
        ups = [i for i, c in enumerate(self.w.commands) if c.startswith("docker compose up")]
        self.assertEqual(len(ups), 2)
        self.assertIn("manager-b", self.w.commands[ups[0]])
        self.assertIn("manager-a", self.w.commands[ups[1]])
        hist = self.c.status()["history"][-1]
        self.assertEqual((hist["kind"], hist["from"], hist["to"], hist["ok"]), ("deploy", "a", "b", True))

    def test_rollback_is_pure_switch_back(self):
        self.c.deploy("repo:sha-bbbbbbb")
        self.w.conns["b"] = 2
        self.w.quiesce_ticks = 1
        self.c.rollback("b")
        self.assertEqual(self.w.map["main"], "manager_a")
        self.assertEqual(self.w.running["a"], "repo:sha-aaaaaaa")
        self.assertEqual(self.w.running["b"], "repo:sha-bbbbbbb")
        self.assertFalse(any(c.startswith("docker pull") for c in self.w.commands[-6:]))

    def test_switch_refuses_stale_expected_active(self):
        with self.assertRaises(DeployError):
            self.c.switch("b", "b")

    def test_switch_refuses_standby_with_connections(self):
        self.w.conns["b"] = 1
        with self.assertRaises(DeployError):
            self.c.switch("b", "a")

    def test_rejects_mutable_tags_and_pending_operation(self):
        with self.assertRaises(ValueError):
            validate_image("repo:latest")
        with self.assertRaises(ValueError):
            validate_image("repo")
        validate_image("repo:sha-abcdef0")
        validate_image("repo:v1.2.3")
        validate_image("repo@sha256:" + "0" * 64)
        self.c.journal(kind="deploy", stage="cutover", active="a", candidate="b", image="repo:sha-bbbbbbb")
        with self.assertRaises(DeployError):
            self.c.deploy("repo:sha-ccccccc")

    def test_interrupted_retire_resumes_from_journal(self):
        self.w.fail_on = "up -d --force-recreate --no-deps manager-a"
        with self.assertRaises(DeployError):
            self.c.deploy("repo:sha-bbbbbbb")
        op = self.c.read_operation()
        self.assertEqual(op["stage"], "retiring")
        self.assertEqual(self.w.map["main"], "manager_b")     # 流量已经在新槽
        self.w.fail_on = None
        self.c.resume()
        self.assertEqual(self.c.read_operation()["stage"], "idle")
        self.assertEqual(self.w.running["a"], "repo:sha-aaaaaaa")

    def test_interrupted_prepare_resumes_without_switching_early(self):
        self.w.fail_on = "docker pull"
        with self.assertRaises(DeployError):
            self.c.deploy("repo:sha-bbbbbbb")
        self.assertEqual(self.c.read_operation()["stage"], "preparing")
        self.assertEqual(self.w.map["main"], "manager_a")     # 没切流
        self.w.fail_on = None
        self.c.resume()
        self.assertEqual(self.w.map["main"], "manager_b")
        self.assertEqual(self.c.read_operation()["stage"], "idle")

    def test_initialize_when_no_active_map(self):
        (abctl.STATE / "active.map").unlink()
        self.c.deploy("repo:sha-bbbbbbb")
        self.assertEqual(self.c.read_active(), "a")
        self.assertEqual(self.w.running, {"a": "repo:sha-bbbbbbb", "b": "repo:sha-bbbbbbb"})
        self.assertEqual(self.w.redis["pm:deploy:active"], "a")

    def test_status_reports_leader_and_connections(self):
        st = self.c.status()
        self.assertEqual(st["active"], "a")
        self.assertEqual(st["runtimeActive"], "a")
        self.assertTrue(st["slots"]["a"]["leader"])
        self.assertFalse(st["slots"]["b"]["leader"])
        self.assertEqual(st["slots"]["a"]["connections"], 3)
        self.assertEqual(st["slots"]["a"]["role"], "active")
        self.assertEqual(st["slots"]["b"]["role"], "standby")
        self.assertEqual(st["runner"]["image"], "repo:sha-aaaaaaa")

    def test_runner_roll_keeps_pending_slot_operation(self):
        self.c.journal(kind="deploy", stage="cutover", active="a", candidate="b", image="repo:sha-bbbbbbb", retireImage="repo:sha-aaaaaaa")
        self.c.runner("repo:sha-ccccccc")
        op = self.c.read_operation()
        self.assertEqual((op["stage"], op["kind"], op["retireImage"]), ("cutover", "deploy", "repo:sha-aaaaaaa"))
        self.assertEqual(self.w.images["runner"], "repo:sha-ccccccc")
        self.assertEqual(self.c.status()["history"][-1]["kind"], "runner")


class FakeRegistry:
    """假 ghcr:标签列表 + 每个标签的 manifest/config;GitHub 提交接口按需返回。"""

    def __init__(self, shas, created, github=False):
        self.shas, self.created, self.github = shas, created, github
        self.calls = []

    def fetch(self, url, headers=None, timeout=20):
        self.calls.append(url)
        if "/token?" in url:
            return 200, {}, json.dumps({"token": "t"}).encode()
        if url.endswith("tags/list?n=1000"):
            tags = [f"sha-{s}" for s in self.shas] + ["latest", "v0.1.0", "sha-notasha"]
            return 200, {}, json.dumps({"tags": tags}).encode()
        if "/manifests/sha-" in url:
            sha = url.rsplit("sha-", 1)[1]
            return 200, {}, json.dumps({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                                        "config": {"digest": f"sha256:cfg{sha}"}}).encode()
        if "/blobs/sha256:cfg" in url:
            sha = url.rsplit("cfg", 1)[1]
            labels = {"org.opencontainers.image.revision": sha * 5}
            if sha == "bbbbbbb":
                labels.update({"pm.commit.subject": "fix: labelled build", "pm.commit.author": "ci"})
            return 200, {}, json.dumps({"created": self.created[sha] + ".000Z", "config": {"Labels": labels}}).encode()
        if "api.github.com" in url:
            assert headers and headers["Authorization"] == "Bearer gh"
            sha = url.rsplit("/", 1)[1][:7]
            return 200, {}, json.dumps({"commit": {"message": f"feat: {sha}\n\nbody", "author": {"name": "dev"}}}).encode()
        raise AssertionError(url)


class ReleasesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        abctl.STATE = Path(self.tmp.name) / "state"
        abctl.STATE.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_sha(self):
        self.assertEqual(image_sha("ghcr.io/x/y:sha-131305d"), "131305d")
        self.assertIsNone(image_sha("ghcr.io/x/y:latest"))
        self.assertIsNone(image_sha("ghcr.io/x/y:v1.0.0"))
        self.assertIsNone(image_sha(None))

    def test_collect_orders_by_build_time_and_marks_running(self):
        reg = FakeRegistry(["aaaaaaa", "bbbbbbb", "ccccccc"],
                           {"aaaaaaa": "2026-09-01T00:00:00", "bbbbbbb": "2026-09-03T00:00:00", "ccccccc": "2026-09-02T00:00:00"})
        rel = Releases(repo="ghcr.io/me/pm", fetch=reg.fetch, github_token="", docker_config="/nonexistent")
        out = rel.collect({"a": "aaaaaaa", "b": "ccccccc", "runner": "aaaaaaa", "active": "aaaaaaa"})
        self.assertEqual([r["sha"] for r in out["releases"]], ["bbbbbbb", "ccccccc", "aaaaaaa"])
        self.assertEqual(out["latest"]["sha"], "bbbbbbb")
        self.assertTrue(out["updateAvailable"])
        self.assertEqual(out["releases"][2]["runningIn"], ["a", "runner"])
        self.assertEqual(out["releases"][1]["runningIn"], ["b"])
        self.assertEqual(out["latest"]["image"], "ghcr.io/me/pm:sha-bbbbbbb")
        self.assertEqual(out["latest"]["message"], "fix: labelled build")   # 来自镜像标签
        self.assertTrue(out["githubCommits"])
        # 第二次只用缓存,不再抓 manifest
        n = len(reg.calls)
        rel.collect({"a": "aaaaaaa", "b": "ccccccc", "runner": "aaaaaaa", "active": "aaaaaaa"})
        self.assertEqual(len([u for u in reg.calls[n:] if "/manifests/" in u]), 0)

    def test_collect_with_github_token_adds_commit_subjects(self):
        reg = FakeRegistry(["aaaaaaa"], {"aaaaaaa": "2026-09-01T00:00:00"}, github=True)
        rel = Releases(repo="ghcr.io/me/pm", fetch=reg.fetch, github_token="gh", docker_config="/nonexistent")
        out = rel.collect({"a": None, "b": None, "runner": None, "active": None})
        self.assertEqual(out["releases"][0]["message"], "feat: aaaaaaa")
        self.assertEqual(out["releases"][0]["author"], "dev")
        self.assertFalse(out["updateAvailable"])


if __name__ == "__main__":
    unittest.main()
