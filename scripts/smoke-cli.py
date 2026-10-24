#!/usr/bin/env python3
"""Run the packaged Linux executable, optionally under qemu-aarch64. No account needed."""
import argparse
import json
import os
import re
import secrets
import selectors
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


def read_line(stream, timeout=20):
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise TimeoutError("Timed out waiting for CLI output")
    value = stream.readline()
    if not value:
        raise RuntimeError("CLI closed its output unexpectedly")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--runner")
    parser.add_argument("--live", action="store_true", help="Also query the public Bilibili hot list")
    args = parser.parse_args()
    prefix = ([args.runner] if args.runner else []) + [str(args.binary.resolve())]
    env = os.environ.copy()
    for name in ["WEIYU_COOKIE_FILE", "WEIYU_MCP_TOKEN_FILE", "WEIYU_ALLOWED_HOSTS", "WEIYU_ALLOWED_ORIGINS"]:
        env.pop(name, None)
    token = secrets.token_hex(32)
    env["WEIYU_MCP_TOKEN"] = token
    env["WEIYU_RATE_LIMIT"] = "0"
    version = subprocess.check_output(prefix + ["--version"], env=env, timeout=20).decode().strip()
    catalog = json.loads(subprocess.check_output(prefix + ["tools"], env=env, timeout=20))
    assert len(catalog["tools"]) == 35
    parsed = json.loads(subprocess.check_output(prefix + ["call", "parse_url", "--args", '{"url":"BV17x411w7KC"}'], env=env, timeout=20))
    assert parsed["aid"] == 170001

    def message(identifier, method, params=None):
        value = {"jsonrpc": "2.0", "id": identifier, "method": method}
        if params is not None:
            value["params"] = params
        return value

    init = message(1, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "artifact-smoke", "version": "1"}})
    stdio = subprocess.Popen(prefix + ["mcp"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        def stdio_rpc(value):
            stdio.stdin.write(json.dumps(value).encode() + b"\n")
            stdio.stdin.flush()
            return json.loads(read_line(stdio.stdout))
        assert stdio_rpc(init)["result"]["serverInfo"]["name"] == "weiyu-cli"
        stdio.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        result = stdio_rpc(message(2, "tools/call", {"name": "parse_url", "arguments": {"url": "BV17x411w7KC"}}))
        assert result["result"]["structuredContent"]["aid"] == 170001
        stdio.stdin.close()
        assert stdio.wait(timeout=10) == 0
        assert stdio.stdout.read() == b""
    finally:
        if stdio.poll() is None:
            stdio.kill()
            stdio.wait()

    server = subprocess.Popen(prefix + ["serve", "--listen", "127.0.0.1:0"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 20
        while True:
            line = read_line(server.stderr).decode()
            match = re.search(r"http://(127\.0\.0\.1:\d+)/mcp", line)
            if match:
                base = "http://" + match.group(1)
                break
            if time.monotonic() > deadline:
                raise TimeoutError("HTTP server did not start")
        # This opener is only used for the loopback server under test.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        assert json.loads(opener.open(base + "/healthz", timeout=10).read())["status"] == "ok"
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26"}
        try:
            opener.open(urllib.request.Request(base + "/mcp", data=json.dumps(init).encode(), headers=headers), timeout=10)
            raise AssertionError("Unauthenticated MCP request was accepted")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        headers["Authorization"] = "Bearer " + token

        def http_rpc(value):
            req = urllib.request.Request(base + "/mcp", data=json.dumps(value).encode(), headers=headers)
            return json.loads(opener.open(req, timeout=60).read())
        assert http_rpc(init)["result"]["serverInfo"]["name"] == "weiyu-cli"
        assert len(http_rpc(message(2, "tools/list"))["result"]["tools"]) == 35
        value = http_rpc(message(3, "tools/call", {"name": "parse_url", "arguments": {"url": "BV17x411w7KC"}}))
        assert value["result"]["structuredContent"]["aid"] == 170001
        value = http_rpc(message(4, "tools/call", {"name": "search_videos", "arguments": {"keyword": "test"}}))
        assert value["result"]["isError"] is True
        assert value["result"]["structuredContent"]["error"]["code"] == "AUTH_REQUIRED"
        if args.live:
            value = http_rpc(message(5, "tools/call", {"name": "get_hot_search", "arguments": {"limit": 3}}))
            assert value["result"]["isError"] is False, value["result"]
            assert len(value["result"]["structuredContent"]["data"]) == 3
        server.terminate()
        assert server.wait(timeout=15) == 0
        print(json.dumps({"binary": str(args.binary), "version": version, "runner": args.runner, "tools": 35, "stdio": "passed", "http": "passed", "sigterm": "passed", "live_bilibili": args.live}))
    finally:
        if server.poll() is None:
            server.kill()
            server.wait()


if __name__ == "__main__":
    main()
