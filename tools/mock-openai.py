"""Mock OpenAI-compatible server (LM Studio / llama.cpp shaped) for verification."""
import asyncio
import json

from aiohttp import web

CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"}

CHUNKS = [
    "스트리밍 응답은 첫 토큰까지의 시간이 짧습니다. ",
    "배치는 총 처리량이 높지만 빈 화면을 오래 보게 됩니다. ",
    "채팅 UI라면 스트리밍이 맞습니다.\n\n",
    "- 첫 토큰: 스트리밍\n",
    "- 총 비용: 배치\n",
    "- 복구: 스트리밍\n",
]


async def models(request):
    return web.json_response({"data": [
        {"id": "gpt-5-codex", "owned_by": "openai"},
        {"id": "claude-sonnet-4-5", "owned_by": "anthropic"},
        {"id": "llama-3.3-70b-instruct", "owned_by": "local"},
    ]}, headers=CORS)


async def options(request):
    return web.Response(status=204, headers=CORS)


async def chat(request):
    body = await request.json()
    resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", **CORS})
    await resp.prepare(request)
    for chunk in CHUNKS:
        frame = {"choices": [{"delta": {"content": chunk}}]}
        await resp.write(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode())
        await asyncio.sleep(0.12)
    await resp.write(b': ping\n\n')
    await resp.write(f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 41, 'completion_tokens': 57}})}\n\n".encode())
    await resp.write(b"data: [DONE]\n\n")
    await resp.write_eof()
    print("chat completions served for model", body.get("model"), flush=True)
    return resp


async def main():
    app = web.Application()
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/chat/completions", chat)
    app.router.add_route("OPTIONS", "/{tail:.*}", options)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 1234).start()
    print("mock openai on http://127.0.0.1:1234", flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
