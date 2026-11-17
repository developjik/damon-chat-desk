"""
Mock damon-agent-core daemon for end-to-end verification.

Speaks the real surface of developjik/damon-agent-core (src/api.rs +
docs/protocol-v2.md):
  GET  /health          -> {status, version, backends[]}
  POST /v1/ws_ticket    -> {ticket}
  POST /v1/pair         -> {deviceId, token, status}
  POST /v1/pair/status  -> {status}
  GET  /ws?ticket=...   -> JSON-RPC v2: hello, session.list, session.create,
                           session.messages, catalog.models, memory.list,
                           memory.usage, turn.start (streams session.event)

It is a test double: replies are canned, but the frames and the error
codes are shaped exactly like the real daemon's.
"""
import asyncio
import json

from aiohttp import web

TICKETS = set()
SESSIONS = [
    {"sessionId": "sess-a1b2c3", "createdAt": 1763000000000, "backend": "claude",
     "title": "damon-agent-core API 리뷰", "cwd": "/home/dev/damon", "tags": [], "pinned": True, "archived": False},
    {"sessionId": "sess-d4e5f6", "createdAt": 1762900000000, "backend": "codex",
     "title": "assignment-map 수집기 복구", "cwd": "/home/dev/assignment-map", "tags": [], "pinned": False, "archived": False},
]
MESSAGES = {
    "sess-a1b2c3": [
        {"id": 1, "role": "user", "ts": 1763000000000, "data": {"content": "세션 목록 API에서 archived 처리는 어떻게 하지?"}},
        {"id": 2, "role": "assistant", "ts": 1763000001000,
         "data": {"content": "`session.list`는 `includeArchived`가 없으면 archived를 숨깁니다. 보관은 삭제가 아니므로 행은 남고, retention sweep에서도 살아남습니다."}},
    ],
    "sess-d4e5f6": [],
}

DELTAS = [
    "데몬 쪽 이벤트를 그대로 렌더하는 게 핵심입니다. ",
    "`turn.start`는 턴이 끝날 때 응답하고, ",
    "스트리밍은 `session.event` 푸시로 옵니다.\n\n",
    "1. 티켓을 받아 `/ws`에 붙는다\n",
    "2. `session.list`로 사이드바를 채운다\n",
    "3. `turn.start` 후 `timeline/assistant_message`를 이어 붙인다\n\n",
    "```ts\nsocket.send(JSON.stringify({ id: 7, method: 'turn.start', params: { sessionId, prompt } }));\n```\n\n",
    "이 순서면 UI에 프로바이더 분기가 생기지 않습니다.",
]

COUNTER = {"n": 1}


async def health(request):
    return web.json_response({"status": "ok", "version": "0.7.2", "backends": ["claude", "codex"]})


async def ws_ticket(request):
    body = await request.json() if request.can_read_body else {}
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") and not body.get("deviceToken"):
        # loopback + no configured token is open in the real daemon
        pass
    ticket = f"tkt-{COUNTER['n']}"
    COUNTER["n"] += 1
    TICKETS.add(ticket)
    return web.json_response({"ticket": ticket})


async def pair(request):
    body = await request.json()
    if body.get("pairingKey") != "AB12CD34":
        return web.json_response({"error": "invalid pairing key"}, status=401)
    return web.json_response({"deviceId": "dev-77", "token": "tok-xyz", "status": "pending"})


async def pair_status(request):
    return web.json_response({"status": "approved"})


async def ws_handler(request):
    ticket = request.query.get("ticket", "")
    if ticket not in TICKETS:
        return web.Response(status=401, text="bad ticket")
    TICKETS.discard(ticket)

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    await ws.send_str(json.dumps({"hello": {"protocol": 2, "daemon": "damond", "version": "0.7.2",
                                            "backends": ["claude", "codex"], "permissionTimeoutSecs": 300}}))

    async def send_event(session_id, payload):
        await ws.send_str(json.dumps({"event": "session.event", "sessionId": session_id, "data": payload}))

    async def run_turn(session_id, prompt, rid):
        await asyncio.sleep(0.05)
        await send_event(session_id, {"turn_id": "t1", "type": "turn_started"})
        for delta in DELTAS:
            await asyncio.sleep(0.05)
            await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "assistant_message", "text": delta})
        await send_event(session_id, {"turn_id": "t1", "type": "turn_completed",
                                      "usage": {"input_tokens": 128, "output_tokens": 96, "cost_usd": 0.0021,
                                                "context_used": 3120, "context_window": 200000}})
        await ws.send_str(json.dumps({"id": rid, "result": {"turnId": "t1", "stopReason": "completed",
                                                                     "usage": {"input_tokens": 128, "output_tokens": 96,
                                                                               "cost_usd": 0.0021}}}))
        MESSAGES.setdefault(session_id, []).append({"id": 90, "role": "assistant", "ts": 1763000009000,
                                                    "data": {"content": "".join(DELTAS)}})

    async for msg in ws:
        if msg.type != web.WSMsgType.TEXT:
            continue
        frame = json.loads(msg.data)
        method = frame.get("method")
        params = frame.get("params") or {}
        rid = frame.get("id")

        if method == "hello":
            await ws.send_str(json.dumps({"id": rid, "result": {"protocol": 2, "daemon": "damond", "version": "0.7.2",
                                                                "backends": ["claude", "codex"]}}))
        elif method == "session.list":
            await ws.send_str(json.dumps({"id": rid, "result": {"sessions": SESSIONS}}))
        elif method == "session.create":
            sid = "sess-new-" + str(COUNTER["n"])
            COUNTER["n"] += 1
            SESSIONS.insert(0, {"sessionId": sid, "createdAt": 1763000500000, "backend": params.get("backend", "claude"),
                                "title": None, "cwd": None, "tags": [], "pinned": False, "archived": False})
            await ws.send_str(json.dumps({"id": rid, "result": {"sessionId": sid, "backend": params.get("backend", "claude"), "replayed": 0}}))
        elif method == "session.messages":
            await ws.send_str(json.dumps({"id": rid, "result": {"messages": MESSAGES.get(params.get("sessionId"), [])}}))
        elif method == "catalog.models":
            backend = params.get("backend")
            models = {
                "claude": [{"id": "claude-sonnet-4-5", "name": "Sonnet 4.5", "selectable": True}],
                "codex": [{"id": "gpt-5-codex", "name": "GPT-5 Codex", "selectable": True}],
            }.get(backend, [])
            await ws.send_str(json.dumps({"id": rid, "result": {"models": models, "modes": []}}))
        elif method == "memory.list":
            await ws.send_str(json.dumps({"id": rid, "result": {"entries": [
                {"id": "m1", "scope": "user", "content": "WS 티켓은 1회용, 60초 만료. 재사용하면 401.", "status": "active", "source": "daemon"},
                {"id": "m2", "scope": "user", "content": "선호 스택: Vite + React, 1px 보더 다크 UI.", "status": "active", "source": "daemon"},
            ]}}))
        elif method == "memory.usage":
            await ws.send_str(json.dumps({"id": rid, "result": {"scope": "user", "chars": 96, "limit": 8000}}))
        elif method == "turn.start":
            asyncio.create_task(run_turn(params.get("sessionId"), params.get("prompt"), rid))
        elif method == "turn.cancel":
            await ws.send_str(json.dumps({"id": rid, "result": {"cancelled": True}}))
        else:
            await ws.send_str(json.dumps({"id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}}))
    return ws


async def main():
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_post("/v1/ws_ticket", ws_ticket)
    app.router.add_post("/v1/pair", pair)
    app.router.add_post("/v1/pair/status", pair_status)
    app.router.add_get("/ws", ws_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 9470)
    await site.start()
    print("mock daemon on http://127.0.0.1:9470", flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
