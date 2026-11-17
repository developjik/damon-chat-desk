"""
Mock damon-agent-core daemon for end-to-end verification.

Speaks the real surface of developjik/damon-agent-core (src/api.rs +
docs/protocol-v2.md):
  GET  /health          -> {status, version, backends[]}
  POST /v1/ws_ticket    -> {ticket}
  POST /v1/pair         -> {deviceId, token, status}
  POST /v1/pair/status  -> {status}
  GET  /ws?ticket=...   -> JSON-RPC v2: hello, session.list, session.create,
                           session.messages, session.fork, session.rename,
                           session.set_archived, session.delete,
                           session.export, catalog.models,
                           memory.list, memory.usage, memory.write,
                           memory.remove, memory.approve, memory.reject,
                           memory.pending,
                           turn.start (streams session.event), turn.steer,
                           turn.cancel,
                           plan.list, plan.respond, permission.respond

It is a test double: replies are canned, but the frames and the error
codes are shaped exactly like the real daemon's. A turn streams text,
runs two tool calls (one shell pass, one edit with a diff), and — for a
design ask — parks a `kind: plan` review that stays blocked until
`plan.respond` decides it, the same way the daemon gates ExitPlanMode.
"""
import asyncio
import json
import time

from aiohttp import web

TICKETS = set()
NOW = int(time.time() * 1000)
SESSIONS = [
    {"sessionId": "sess-a1b2c3", "createdAt": NOW - 90 * 60 * 1000, "backend": "claude",
     "title": "damon-agent-core API 리뷰", "cwd": "/home/dev/damon", "tags": [], "pinned": True, "archived": False},
    {"sessionId": "sess-d4e5f6", "createdAt": NOW - 220 * 60 * 1000, "backend": "codex",
     "title": "assignment-map 수집기 복구", "cwd": "/home/dev/assignment-map", "tags": [], "pinned": False, "archived": False},
    {"sessionId": "sess-g7h8i9", "createdAt": NOW - 26 * 60 * 60 * 1000, "backend": "qwen",
     "title": "qwen CLI 설치 메모", "cwd": "/home/dev/qwen", "tags": [], "pinned": False, "archived": True},
]
MESSAGES = {
    "sess-a1b2c3": [
        {"id": 1, "role": "user", "ts": NOW - 100 * 60 * 1000, "data": {"content": "세션 목록 API에서 archived 처리는 어떻게 하지?"}},
        {"id": 2, "role": "assistant", "ts": NOW - 99 * 60 * 1000,
         "data": {"content": "`session.list`는 `includeArchived`가 없으면 archived를 숨깁니다. 보관은 삭제가 아니므로 행은 남고, retention sweep에서도 살아남습니다."}},
    ],
    "sess-d4e5f6": [],
}

# The memory ledgers: one per (scope, owner). Chars counts ACTIVE only.
MEMORY_LIMIT = 8000
MEMORY = [
    {"id": "m1", "scope": "user", "owner": None, "status": "active", "source": "daemon",
     "content": "WS 티켓은 1회용, 60초 만료. 재사용하면 401.",
     "createdAt": NOW - 40 * 60 * 1000, "updatedAt": NOW - 40 * 60 * 1000},
    {"id": "m2", "scope": "user", "owner": None, "status": "active", "source": "daemon",
     "content": "선호 스택: Vite + React, 1px 보더 다크 UI.",
     "createdAt": NOW - 30 * 60 * 1000, "updatedAt": NOW - 30 * 60 * 1000},
    {"id": "m3", "scope": "user", "owner": None, "status": "pending", "source": "agent",
     "content": "릴리스마다 CHANGELOG.md 갱신",
     "createdAt": NOW - 12 * 60 * 1000, "updatedAt": NOW - 12 * 60 * 1000},
    {"id": "m5", "scope": "user", "owner": None, "status": "pending", "source": "agent",
     "content": "리뷰 코멘트 순서: 재현 → 기대 → 실제",
     "createdAt": NOW - 4 * 60 * 1000, "updatedAt": NOW - 4 * 60 * 1000},
    {"id": "m4", "scope": "bot", "owner": "scribe", "status": "active", "source": "daemon",
     "content": "릴리스 노트는 날짜 → 변경 → 근거 순서로 적는다.",
     "createdAt": NOW - 6 * 60 * 60 * 1000, "updatedAt": NOW - 6 * 60 * 60 * 1000},
]

INVISIBLE = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"]


def ledger(scope, owner):
    if scope == "bot":
        return [row for row in MEMORY if row["scope"] == "bot" and (row.get("owner") or "") == (owner or "")]
    return [row for row in MEMORY if row["scope"] == "user"]


def ledger_chars(scope, owner):
    return sum(len(row["content"]) for row in ledger(scope, owner) if row["status"] == "active")


def memory_gate(content, scope, owner):
    """One gate chain: empty/scoping → invisible → secret → injection → cap."""
    if not content or scope not in ("user", "bot") or (scope == "bot" and not owner):
        return {"code": -32602, "message": "memory.write needs content and a valid scope/owner"}
    if any(char in content for char in INVISIBLE):
        return {"code": -32011, "message": "memory rejected: invisible characters", "data": {"kind": "invisible"}}
    if any(marker in content for marker in ("sk-", "AKIA", "ghp_", "PRIVATE KEY")):
        return {"code": -32011, "message": "memory rejected: secret", "data": {"kind": "secret"}}
    lowered = content.lower()
    if any(marker in lowered for marker in ("ignore previous", "ignore all previous", "system prompt", "이전 지시")):
        return {"code": -32011, "message": "memory rejected: prompt injection", "data": {"kind": "prompt_injection"}}
    current = ledger_chars(scope, owner)
    if current + len(content) > MEMORY_LIMIT:
        return {"code": -32011, "message": "memory rejected: capacity",
                "data": {"kind": "capacity", "limit": MEMORY_LIMIT, "current": current, "attempted": len(content)}}
    return None

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

PLAN_TEXT = """## 데몬 이벤트 렌더러 구현 계획

1. **이벤트 계약 고정** — session.event의 StreamEvent 타입을 먼저 못 박습니다.
2. **얇은 경로** — turn.start → session.event → 렌더 한 줄기만 연결합니다.
3. **상태 이전** — 세션·메모리를 데몬에 두고 UI는 렌더만 합니다.

변경 예상 파일: `src/lib/daemon.ts`, `src/lib/desk.ts`, `src/components/Transcript.tsx`

리스크: 세션 상태를 UI에 두면 두 번째 서피스가 다른 진실을 그립니다.
"""

COUNTER = {"n": 1}
# requestId -> {"sessionId", "rid", "planId", "revision", "waiter", "decision", "feedback"}
PENDING = {}
STEERS = []


def plan_intent(prompt):
    # The `<memory>` block is data, not instructions — the daemon's real
    # gate looks at the user's words, so strip it before matching.
    body = prompt.split("</memory>", 1)[-1] if "<memory>" in prompt else prompt
    return any(word in body for word in ("계획", "순서", "설계", "plan", "roadmap"))


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

    async def stream_events(session_id, prompt):
        await asyncio.sleep(0.05)
        await send_event(session_id, {"turn_id": "t1", "type": "turn_started"})
        for index, delta in enumerate(DELTAS):
            await asyncio.sleep(0.05)
            if STEERS:
                for steered in STEERS:
                    await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "assistant_message",
                                                  "text": f"\n\n> {steered} — 반영했습니다.\n\n"})
                STEERS.clear()
            await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "assistant_message", "text": delta})
            if index == 2:
                await run_shell_tool(session_id)
            if index == 4:
                await run_edit_tool(session_id)

    async def complete_turn(session_id, rid):
        await send_event(session_id, {"turn_id": "t1", "type": "turn_completed",
                                      "usage": {"input_tokens": 128, "output_tokens": 96, "cost_usd": 0.0021,
                                                "context_used": 3120, "context_window": 200000}})
        await ws.send_str(json.dumps({"id": rid, "result": {"turnId": "t1", "stopReason": "completed",
                                                             "usage": {"input_tokens": 128, "output_tokens": 96,
                                                                       "cost_usd": 0.0021}}}))
        MESSAGES.setdefault(session_id, []).append({"id": 90, "role": "assistant", "ts": NOW,
                                                    "data": {"content": "".join(DELTAS)}})

    async def run_shell_tool(session_id):
        call_id = f"call-{COUNTER['n']}"
        COUNTER["n"] += 1
        await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "tool_call",
                                      "call_id": call_id, "name": "Bash", "status": "running",
                                      "detail": {"type": "shell", "command": "npm test -- --run"}})
        await asyncio.sleep(0.2)
        await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "tool_call",
                                      "call_id": call_id, "name": "Bash", "status": "completed",
                                      "detail": {"type": "shell", "command": "npm test -- --run",
                                                 "output": " ✓ src/lib/rpc.test.ts (9 tests)\n ✓ src/lib/desk.test.ts (18 tests)\n\n Tests  27 passed (27)",
                                                 "exit_code": 0}})

    async def run_edit_tool(session_id):
        call_id = f"call-{COUNTER['n']}"
        COUNTER["n"] += 1
        await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "tool_call",
                                      "call_id": call_id, "name": "Edit", "status": "running",
                                      "detail": {"type": "edit", "path": "src/lib/daemon.ts"}})
        await asyncio.sleep(0.25)
        await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "tool_call",
                                      "call_id": call_id, "name": "Edit", "status": "completed",
                                      "detail": {"type": "edit", "path": "src/lib/daemon.ts",
                                                 "unified_diff": "--- a/src/lib/daemon.ts\n+++ b/src/lib/daemon.ts\n@@ -196,3 +196,7 @@\n-  async *streamTurn(sessionId: string, prompt: string) {\n+  async *streamTurn(sessionId: string, prompt: string) {\n+    // steer arrives on the same socket, mid-turn\n"}})

    async def run_turn(session_id, prompt, rid):
        await stream_events(session_id, prompt)
        if not plan_intent(prompt):
            await complete_turn(session_id, rid)
            return

        # A design ask parks a durable review; the turn stays open until a
        # decision reaches plan.respond through this or another surface.
        COUNTER["n"] += 1
        plan_id = f"plan-{COUNTER['n']}"
        request_id = f"req-plan-{COUNTER['n']}"
        PENDING[request_id] = {"sessionId": session_id, "rid": rid, "planId": plan_id, "revision": 1,
                               "waiter": asyncio.Event(), "decision": None, "feedback": None}
        await send_event(session_id, {"turn_id": "t1", "type": "permission_requested",
                                      "id": request_id, "kind": "plan", "name": "ExitPlanMode",
                                      "title": "데몬 이벤트 렌더러 구현 계획", "input": {"plan": PLAN_TEXT},
                                      "detail": {"type": "plan", "text": PLAN_TEXT},
                                      "actions": [{"id": "allow", "label": "Allow", "behavior": "allow", "variant": "primary"},
                                                  {"id": "deny", "label": "Deny", "behavior": "deny"}]})
        await PENDING[request_id]["waiter"].wait()
        entry = PENDING.pop(request_id)
        await send_event(session_id, {"turn_id": "t1", "type": "permission_resolved", "request_id": request_id})
        if entry["decision"] == "approve":
            await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "assistant_message",
                                          "text": "\n\n승인됨 — 계획대로 구현을 시작합니다."})
        elif entry["decision"] == "request_changes":
            await send_event(session_id, {"turn_id": "t1", "type": "timeline", "kind": "assistant_message",
                                          "text": f"\n\n수정 요청 접수: {entry['feedback']}"})
        await complete_turn(session_id, rid)

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
            rows = [row for row in SESSIONS
                    if params.get("includeArchived") or not row.get("archived")]
            if params.get("backend"):
                rows = [row for row in rows if row["backend"] == params["backend"]]
            limit = params.get("limit")
            if isinstance(limit, int):
                rows = rows[:limit]
            await ws.send_str(json.dumps({"id": rid, "result": {"sessions": rows}}))
        elif method == "session.rename":
            row = next((row for row in SESSIONS if row["sessionId"] == params.get("sessionId")), None)
            title = (params.get("title") or "").strip()
            if row is None or not title:
                await ws.send_str(json.dumps({"id": rid, "error": {"code": -32602, "message": "session.rename needs sessionId and title"}}))
            else:
                row["title"] = title
                await ws.send_str(json.dumps({"id": rid, "result": {"renamed": True}}))
        elif method == "session.set_archived":
            row = next((row for row in SESSIONS if row["sessionId"] == params.get("sessionId")), None)
            if row is None:
                await ws.send_str(json.dumps({"id": rid, "result": {"updated": False}}))
            else:
                row["archived"] = bool(params.get("archived"))
                await ws.send_str(json.dumps({"id": rid, "result": {"updated": True}}))
        elif method == "session.delete":
            session_id = params.get("sessionId")
            before = len(SESSIONS)
            SESSIONS[:] = [row for row in SESSIONS if row["sessionId"] != session_id]
            MESSAGES.pop(session_id, None)
            await ws.send_str(json.dumps({"id": rid, "result": {"deleted": len(SESSIONS) != before}}))
        elif method == "session.export":
            session_id = params.get("sessionId")
            row = next((row for row in SESSIONS if row["sessionId"] == session_id), None)
            if row is None:
                await ws.send_str(json.dumps({"id": rid, "error": {"code": -32602, "message": "unknown session"}}))
            else:
                await ws.send_str(json.dumps({"id": rid, "result": {
                    "session": row,
                    "messages": MESSAGES.get(session_id, []),
                    "usage": {"contextUsed": 3120, "contextSize": 200000, "costUsd": 0.0021, "turns": 1}}}))
        elif method == "session.create":
            sid = "sess-new-" + str(COUNTER["n"])
            COUNTER["n"] += 1
            SESSIONS.insert(0, {"sessionId": sid, "createdAt": NOW, "backend": params.get("backend", "claude"),
                                "title": None, "cwd": None, "tags": [], "pinned": False, "archived": False})
            await ws.send_str(json.dumps({"id": rid, "result": {"sessionId": sid, "backend": params.get("backend", "claude"), "replayed": 0}}))
        elif method == "session.messages":
            await ws.send_str(json.dumps({"id": rid, "result": {"messages": MESSAGES.get(params.get("sessionId"), [])}}))
        elif method == "session.fork":
            source = params.get("sessionId")
            sid = "sess-fork-" + str(COUNTER["n"])
            COUNTER["n"] += 1
            existing = next((row for row in SESSIONS if row["sessionId"] == source), None)
            SESSIONS.insert(0, {"sessionId": sid, "createdAt": NOW,
                                "backend": (existing or {}).get("backend", "claude"),
                                "title": ((existing or {}).get("title") or "세션") + " (fork)",
                                "cwd": (existing or {}).get("cwd"), "tags": [], "pinned": False, "archived": False})
            MESSAGES[sid] = list(MESSAGES.get(source, []))
            await ws.send_str(json.dumps({"id": rid, "result": {"sessionId": sid, "backend": (existing or {}).get("backend", "claude"), "replayed": 0}}))
        elif method == "catalog.models":
            backend = params.get("backend")
            models = {
                "claude": [{"id": "claude-sonnet-4-5", "name": "Sonnet 4.5", "selectable": True}],
                "codex": [{"id": "gpt-5-codex", "name": "GPT-5 Codex", "selectable": True}],
            }.get(backend, [])
            await ws.send_str(json.dumps({"id": rid, "result": {"models": models, "modes": []}}))
        elif method == "memory.list":
            scope = params.get("scope", "user")
            owner = params.get("owner")
            entries = [dict(row) for row in ledger(scope, owner)
                       if params.get("includePending") or row["status"] == "active"]
            await ws.send_str(json.dumps({"id": rid, "result": {"entries": entries}}))
        elif method == "memory.pending":
            await ws.send_str(json.dumps({"id": rid, "result": {"entries": [dict(row) for row in MEMORY if row["status"] == "pending"]}}))
        elif method == "memory.usage":
            scope = params.get("scope", "user")
            owner = params.get("owner")
            await ws.send_str(json.dumps({"id": rid, "result": {"scope": scope, "owner": owner,
                                                               "chars": ledger_chars(scope, owner), "limit": MEMORY_LIMIT}}))
        elif method == "memory.write":
            scope = params.get("scope", "user")
            owner = params.get("owner")
            content = (params.get("content") or "").strip()
            refusal = memory_gate(content, scope, owner)
            if refusal is not None:
                await ws.send_str(json.dumps({"id": rid, "error": refusal}))
            else:
                COUNTER["n"] += 1
                entry = {"id": f"m{COUNTER['n']}", "scope": scope,
                         "owner": owner if scope == "bot" else None,
                         "content": content, "source": params.get("source") or "desk",
                         "status": "pending" if scope == "bot" else "active",
                         "createdAt": NOW, "updatedAt": NOW}
                MEMORY.insert(0, entry)
                await ws.send_str(json.dumps({"id": rid, "result": {"id": entry["id"], "status": entry["status"]}}))
        elif method == "memory.remove":
            before = len(MEMORY)
            MEMORY[:] = [row for row in MEMORY if row["id"] != params.get("id")]
            await ws.send_str(json.dumps({"id": rid, "result": {"removed": len(MEMORY) != before}}))
        elif method == "memory.approve":
            row = next((row for row in MEMORY if row["id"] == params.get("id")), None)
            approved = row is not None and row["status"] == "pending"
            if approved:
                row["status"] = "active"
            await ws.send_str(json.dumps({"id": rid, "result": {"approved": approved}}))
        elif method == "memory.reject":
            row = next((row for row in MEMORY if row["id"] == params.get("id")), None)
            rejected = row is not None and row["status"] == "pending"
            if rejected:
                MEMORY.remove(row)
            await ws.send_str(json.dumps({"id": rid, "result": {"rejected": rejected}}))
        elif method == "turn.start":
            asyncio.create_task(run_turn(params.get("sessionId"), params.get("prompt", ""), rid))
        elif method == "turn.steer":
            STEERS.append(params.get("prompt", ""))
            await ws.send_str(json.dumps({"id": rid, "result": {"result": "steering the running turn"}}))
        elif method == "turn.cancel":
            await ws.send_str(json.dumps({"id": rid, "result": {"cancelled": True}}))
        elif method == "plan.list":
            session_id = params.get("sessionId")
            plans = [{"planId": entry["planId"], "sessionId": session_id, "requestId": request_id,
                      "revision": entry["revision"], "title": "데몬 이벤트 렌더러 구현 계획",
                      "content": PLAN_TEXT, "complete": True, "status": "awaiting_review"}
                     for request_id, entry in PENDING.items() if entry["sessionId"] == session_id]
            await ws.send_str(json.dumps({"id": rid, "result": {"plans": plans}}))
        elif method == "plan.respond":
            entry = next((row for row in PENDING.values() if row["planId"] == params.get("planId")), None)
            if entry is None:
                await ws.send_str(json.dumps({"id": rid, "error": {"code": -32009, "message": "plan conflict: stale revision or closed plan"}}))
            elif params.get("expectedRevision") != entry["revision"]:
                await ws.send_str(json.dumps({"id": rid, "error": {"code": -32009, "message": "plan conflict: expectedRevision stale"}}))
            elif params.get("decision") == "request_changes" and not params.get("feedback"):
                await ws.send_str(json.dumps({"id": rid, "error": {"code": -32602, "message": "feedback required"}}))
            else:
                decision = params.get("decision")
                entry["decision"] = "approve" if decision == "approve" else decision
                entry["feedback"] = params.get("feedback")
                status = {"approve": "approved", "request_changes": "changes_requested", "defer": "deferred"}[decision]
                if decision == "request_changes":
                    entry["revision"] += 1
                entry["waiter"].set()
                await ws.send_str(json.dumps({"id": rid, "result": {
                    "recorded": True, "status": status, "applied": decision != "defer",
                    "planId": entry["planId"], "revision": entry["revision"]}}))
        elif method == "permission.respond":
            entry = PENDING.get(params.get("requestId"))
            if entry is None:
                await ws.send_str(json.dumps({"id": rid, "error": {"code": -32008, "message": "ask not found"}}))
            else:
                behavior = (params.get("response") or {}).get("behavior", "deny")
                entry["decision"] = "approve" if behavior == "allow" else "request_changes"
                entry["feedback"] = (params.get("response") or {}).get("message")
                entry["waiter"].set()
                await ws.send_str(json.dumps({"id": rid, "result": {"responded": True}}))
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
