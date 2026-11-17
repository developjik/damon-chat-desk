# damon-chat-desk

Damon core의 첫 서피스. 데몬의 단일 API 위에 얹는, 얇은 채팅 클라이언트.

그냥 채팅 UI가 아니다. 프로바이더 라우팅이 눈에 보이는, Damon이라서 되는 채팅 데스크.

![기본 채팅 — 라우팅 배지가 붙은 응답](https://raw.githubusercontent.com/developjik/damon-chat-desk/main/docs/chat.png)

## 구조

```
[damon-chat-desk]  정적 SPA (Vite + React, GitHub Pages)
        |
  단일 API (데몬 HTTP/WS)          ← damon-agent-core: /health, /v1/ws_ticket, /ws(JSON-RPC v2)
        |                            (또는 OpenAI 호환 /v1/models + /v1/chat/completions SSE)
  Damon core (local daemon)         ← github.com/developjik/damon-agent-core
        ├─ provider 어댑터
        ├─ 세션 / 메모리 저장소
        └─ 툴 시스템
```

브라우저가 로컬 데몬을 직접 호출한다. 중간 서버 없음, 서버 비용 0.

## 원칙

1. UI는 얇다. 상태(세션·메모리)는 데몬에, UI는 렌더만.
2. OpenAI 호환 스키마만 말한다. 데몬이 바뀌어도 UI는 안 바뀐다.
3. 로컬 데몬 직접 호출. 브라우저 → localhost. 배포는 정적 파일이면 충분하다.

## 차별 기능 3개

1. **프로바이더 스위처**: 메시지 단위로 모델 변경. 싼 모델로 잡담, 깊은 모델로 결론. 라우팅이 UI에 보인다.
2. **사이드바이드 비교 모드**: 같은 프롬프트를 2개 프로바이더에 동시 발사(fan-out), 나란히 렌더.
3. **데몬 세션/메모리**: 대화 목록과 메모리가 브라우저가 아니라 데몬에 저장된다. 나중에 Telegram·CLI에서 같은 대화를 이어간다. "하나의 코어, 모든 서피스"의 체감 지점.

![사이드바이드 비교 — 같은 프롬프트, 두 라우트](https://raw.githubusercontent.com/developjik/damon-chat-desk/main/docs/compare.png)

## 지금 되는 것 (Step 2 MVP)

- **전송 계층 3개, UI는 하나.** 같은 이벤트로 수렴한다.
  - `daemon` — `damon-agent-core` 실제 표면. `GET /health` → `POST /v1/ws_ticket` → `GET /ws`(JSON-RPC v2). `session.list`/`session.create`/`session.messages`, `turn.start` + `session.event` 스트리밍, `memory.list`/`memory.usage`, `permission.respond`.
  - `openai` — OpenAI 호환 `/v1/models`, `/v1/chat/completions`(SSE). LM Studio·llama.cpp·LiteLLM·게이트웨이.
  - `demo` — 시뮬레이션된 데몬. 네트워크도 키도 없이 GitHub Pages 방문자가 바로 체험. 4개 프로바이더(Claude Code · Codex CLI · Qwen Code · OpenCode)가 서로 다른 속도·말투·단가로 스트리밍한다.
- **프로바이더 스위처**: 응답 카드 헤더에 `프로바이더 / 모델`, 푸터에 TTFT·총 시간·토큰·토큰/초·비용·컨텍스트 사용량.
- **비교 모드**: `split` 칩 → A/B 라우트 선택 → 같은 프롬프트를 동시에. 카드마다 독립 취소·재시도.
- **세션/메모리 사이드바**: 데몬 세션 목록(`session.list`), 데몬 세션 가져오기(`session.messages`), 메모리 원장(`memory.list`)과 주입 토글 — 주입 시 실제로 프롬프트 앞에 `<memory>` 블록이 붙고, 무엇이 붙는지 사이드바에서 그대로 확인할 수 있다.
- **승인 카드**: 데몬이 `permission_requested`를 보내면 카드에 액션 버튼이 뜨고 `permission.respond`로 응답한다.
- 단위 테스트 76개(SSE 파서·OpenAI 스트림 매핑·JSON-RPC 클라이언트·데몬 이벤트 매핑·데모 시뮬레이터·라우팅/포맷·마크다운 렌더·컨트롤러).

## 실행

```bash
npm install
npm run dev        # http://127.0.0.1:5173/damon-chat-desk/
npm test           # vitest
npm run build      # dist/ (base: /damon-chat-desk/)
```

### 데몬에 붙이기

데몬은 기본적으로 `127.0.0.1:9470`에 바인드한다.

```bash
damond                                     # 데몬 실행 (백엔드 CLI는 각자 로그인)
npm run dev                                # 데스크 실행
```

설정(⚙) → **Damon daemon** → `로컬 프록시 /dm` 버튼. `npm run dev`가 여는 `/dm` 프록시가
`http://127.0.0.1:9470`으로 넘긴다.

![데몬 연결 — 세션 목록·메모리·라우팅 메트릭](https://raw.githubusercontent.com/developjik/damon-chat-desk/main/docs/daemon.png)

**왜 프록시인가**: 데몬은 CORS 헤더를 보내지 않는다(자기 UI를 `/ui`로 직접 서빙하는 설계).
다른 오리진의 페이지에서 `fetch`로 직접 부르면 브라우저가 막는다. 그래서
- 개발/프리뷰에서는 `/dm` 프록시로 **같은 오리진**을 만든다,
- 배포된 GitHub Pages 빌드에서는 **demo 모드로 먼저 체험**하고,
- 원격 데몬은 페어링(`POST /v1/pair` → 승인 → `deviceToken`) 후 같은 오리진 경로로 붙인다.
  페어링 흐름은 설정 패널에 구현되어 있다(8자리 `device.pairing_key` → `pair` → `pair/status` 확인 → 토큰 저장).

### OpenAI 호환 서버에 붙이기

```bash
# LM Studio(1234), llama.cpp(8080) 등 — CORS를 허용하는 서버
```
설정 → **OpenAI 호환** → base URL 입력. 모델 목록은 `/v1/models`에서 가져와 벤더별로 묶는다.

## 배포

빌드 산출물은 `dist/`이고 `base`가 `/damon-chat-desk/`라 프로젝트 페이지에 그대로 맞는다.
자동 배포 워크플로는 [`docs/deploy.workflow.yml`](docs/deploy.workflow.yml)에 있다 —
`.github/workflows/deploy.yml`로 복사하고 Settings → Pages → Source를 **GitHub Actions**로
한 번 지정하면 `main` 푸시마다 테스트·빌드·배포가 돈다.

지금 이 PR에는 워크플로 파일을 넣지 않았다: 푸시 주체(GitHub App)에 `workflows` 스코프가 없어
`.github/workflows/` 경로의 푸시가 거부되기 때문이다. 파일을 옮기는 것만으로 동작한다.

수동 배포는 `npm run build` 후 `dist/`를 Pages에 올리면 된다.

## 데몬 표면과의 정렬

이 클라이언트는 `damon-agent-core`의 실제 구현을 기준으로 맞췄다(`src/api.rs`, `docs/protocol-v2.md`).

| 표면 | 쓰임 |
| --- | --- |
| `GET /health` | 프로브. `{status, version, backends[]}` (non-loopback은 roster를 숨긴다) |
| `POST /v1/ws_ticket` | 마스터 `Authorization: Bearer` 또는 `{deviceToken}` → 1회용 티켓(60s) |
| `GET /ws?ticket=…` | JSON-RPC v2. `hello` → `session.*` / `turn.*` / `memory.*` / `catalog.models` |
| `POST /v1/pair`, `/v1/pair/status` | 기기 페어링(pending → approved → revoked) |
| `session.event` 푸시 | `turn_started`, `timeline`(assistant_message·tool_call), `turn_completed`(usage), `turn_failed`, `permission_requested` |

주의: 업스트림에서 OpenAI 호환 `/v1/chat/completions`·`/v1/models`는 **제거**되었다(에이전트가 답하는 구조로 전환).
그래서 데스크는 `/health`의 응답 모양으로 표면을 판별하고(`backends[]` → daemon, 아니면 `/v1/models` → openai),
두 경우 모두 같은 UI 이벤트로 정규화한다. 위 README의 "OpenAI 호환 스키마만 말한다" 원칙은
*UI 계약*으로 유지되고, 데몬 연동은 데몬의 실제 프로토콜을 따른다.

## 스택

- Vite 6 + React 19 + TypeScript (strict)
- 의존성은 react/react-dom 뿐. 마크다운 렌더러·SSE 파서·JSON-RPC 클라이언트·데모 시뮬레이터는 직접 구현
- 다크 터미널 미학 (JetBrains Mono 계열 모노스페이스, 1px 보더, 고밀도 데이터 뷰)
- 1440px 데스크톱 / 390px 모바일 모두 동작 (사이드바 드로어, 비교 모드 세로 스택)

## 게이트 확정 (이 레포가 증명하는 것)

- Damon 첫 서피스 = 웹 (이 레포)
- provider 층위 = LLM API 수준 (채팅은 harness 없이 순수 LLM API)
- 데몬 표면은 바뀌어도 UI 계약은 유지된다 — 실제로 업스트림 `/v1` 제거를 흡수했다
