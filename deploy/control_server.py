#!/usr/bin/env python3
"""poolmanager A/B 部署控制服务:固定用途的私有 HTTP API,跑在 deployment 容器里。

它持有 docker.sock(等同宿主机 root),所以:
  * 只监听 compose 内网 + 宿主机 127.0.0.1(见 docker-compose.yml),绝不对外发布;
  * 只认 Bearer DEPLOY_TOKEN(常量时间比较);
  * 只有固定几个动作,参数严格校验,不接受任意 compose 参数;
  * 错误信息只给业务层描述,不把 Docker 输出、环境变量回给浏览器。

路由:
  GET  /status            当前状态(缓存 2s)
  GET  /releases[?refresh=1]  仓库里可用的版本(缓存 60s)
  POST /deploy            {"image": "..."}                      新版本装进备用槽并切流
  POST /switch            {"target": "a|b", "expectedActive": "a|b"}  纯切流
  POST /rollback          {"expectedActive": "a|b"}             切回备用槽(上一版本)
  POST /resume            {}                                    继续未完成的操作
  POST /runner            {"image": "..."}                      滚动 runner
POST 一律 202 立即返回,进度看 /status(operation.stage / busy / lastError)。
"""
import hmac
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from abctl import STATE, SLOTS, Controller, DeployError, durable_write, locked, validate_image

MAX_BODY = 4096
STATUS_CACHE_TTL = 2.0
RELEASES_CACHE_TTL = 60.0
ACTIONS = ("deploy", "switch", "rollback", "resume", "runner")


class ControlService:
    def __init__(self, controller=None):
        self.controller = controller or Controller(
            timeout=int(os.environ.get("DEPLOY_TIMEOUT", "600")),
            drain_wait=int(os.environ.get("DEPLOY_DRAIN_WAIT", "1800")),
            log=lambda m: logging.info("%s", m))
        self._cache = (0.0, None)
        self._cache_lock = threading.Lock()
        self._job = None
        self._rel = (0.0, None)
        self._rel_lock = threading.Lock()

    def status(self):
        with self._cache_lock:
            at, cached = self._cache
            if cached is not None and time.monotonic() - at < STATUS_CACHE_TTL:
                return cached
        st = self.controller.status()
        job = self._job
        st["busy"] = bool(st.get("busy")) or bool(job and job.is_alive())
        with self._cache_lock:
            self._cache = (time.monotonic(), st)
        return st

    def releases(self, refresh=False):
        with self._rel_lock:
            at, cached = self._rel
            if not refresh and cached is not None and time.monotonic() - at < RELEASES_CACHE_TTL:
                return cached
            rel = self.controller.releases()
            if rel.get("error") and cached is not None:  # 检测失败时保留上次结果,只更新错误
                rel = {**cached, "error": rel["error"], "checkedAt": rel["checkedAt"]}
            self._rel = (time.monotonic(), rel)
            return rel

    def start(self, action, body):
        """校验参数、拿 OS 锁、起后台线程。锁在线程结束时释放,HTTP 客户端走了也不影响。"""
        c = self.controller
        if action in ("deploy", "runner"):
            if set(body) != {"image"}:
                raise ValueError(f"{action} 只接受 image 参数")
            validate_image(body["image"])
        elif action == "switch":
            if set(body) != {"target", "expectedActive"}:
                raise ValueError("switch 参数不完整")
            if body["target"] not in SLOTS or body["expectedActive"] not in SLOTS:
                raise ValueError("槽位必须是 a 或 b")
        elif action == "rollback":
            if set(body) != {"expectedActive"} or body["expectedActive"] not in SLOTS:
                raise ValueError("rollback 参数不完整")
        elif action == "resume":
            if body:
                raise ValueError("resume 不接受参数")
            if c.read_operation().get("stage") == "idle":
                raise DeployError("没有可继续的操作")
        else:
            raise ValueError("不支持的操作")

        lease = locked()
        lease.__enter__()
        try:
            # runner 不分槽,不受未完成的槽操作阻塞(只要拿到锁);其余动作必须先 resume 收尾
            if action not in ("resume", "runner") and c.read_operation().get("stage") != "idle":
                raise DeployError("有未完成的操作,先「继续未完成操作」")
            durable_write(STATE / "panel-job.json", json.dumps({"error": None, "action": action, "startedAt": time.time()}))
            self._job = threading.Thread(target=self._run, args=(action, body, lease), daemon=True)
            self._job.start()
        except Exception:
            lease.__exit__(None, None, None)
            raise

    def _run(self, action, body, lease):
        c = self.controller
        try:
            if action == "deploy":
                c.deploy(body["image"])
            elif action == "switch":
                c.switch(body["target"], body["expectedActive"])
            elif action == "rollback":
                c.rollback(body["expectedActive"])
            elif action == "resume":
                c.resume()
            elif action == "runner":
                c.runner(body["image"])
            durable_write(STATE / "panel-job.json", json.dumps({"error": None, "action": action, "finishedAt": time.time()}))
        except Exception as e:
            logging.exception("A/B 操作 %s 中断;看 operation.json 后 resume", action)
            msg = str(e) if isinstance(e, DeployError) else "操作未完成;不会强杀旧连接。请看控制服务日志与槽位状态,再继续未完成操作。"
            durable_write(STATE / "panel-job.json", json.dumps({"error": msg, "action": action, "finishedAt": time.time()}))
        finally:
            with self._cache_lock:
                self._cache = (0.0, None)
            lease.__exit__(None, None, None)


def make_handler(service, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = "poolmanager-deploy/1"

        def log_message(self, fmt, *args):  # 不把 Authorization 头等写进日志
            logging.info("%s %s -> %s", self.command, self.path, args[1] if len(args) > 1 else "")

        def _json(self, code, obj):
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authed(self):
            auth = self.headers.get("Authorization", "")
            got = auth[7:] if auth.startswith("Bearer ") else ""
            if not got or not hmac.compare_digest(got.encode(), token.encode()):
                self._json(401, {"error": "unauthorized"})
                return False
            return True

        def do_GET(self):
            if not self._authed():
                return
            path, _, query = self.path.partition("?")
            if path == "/status":
                try:
                    return self._json(200, service.status())
                except Exception:
                    logging.exception("status 失败")
                    return self._json(500, {"enabled": True, "error": "读取状态失败,见控制服务日志"})
            if path == "/releases":
                refresh = "refresh=1" in query.split("&")
                try:
                    return self._json(200, {"enabled": True, **service.releases(refresh)})
                except Exception:
                    logging.exception("releases 失败")
                    return self._json(500, {"enabled": True, "error": "版本检测失败,见控制服务日志"})
            return self._json(404, {"error": "not found"})

        def do_POST(self):
            if not self._authed():
                return
            action = self.path.split("?", 1)[0].strip("/")
            if action not in ACTIONS:
                return self._json(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._json(400, {"error": "bad length"})
            if n > MAX_BODY:
                return self._json(413, {"error": "请求体过大"})
            raw = self.rfile.read(n) if n else b"{}"
            try:
                body = json.loads(raw or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"error": "请求体必须是 JSON 对象"})
            try:
                service.start(action, body)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except DeployError as e:
                return self._json(409, {"error": str(e)})
            except Exception:
                logging.exception("start %s 失败", action)
                return self._json(500, {"error": "启动操作失败,见控制服务日志"})
            return self._json(202, {"accepted": True, "action": action})

    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("DEPLOY_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("DEPLOY_TOKEN 必须设置且不短于 16 字符(它等同宿主机 root)")
    port = int(os.environ.get("DEPLOY_PORT", "16828"))
    STATE.mkdir(parents=True, exist_ok=True)
    service = ControlService()
    httpd = ThreadingHTTPServer(("0.0.0.0", port), make_handler(service, token))
    logging.info("poolmanager deployment control service listening on :%d (root=%s)", port, os.getcwd())
    httpd.serve_forever()


if __name__ == "__main__":
    main()
