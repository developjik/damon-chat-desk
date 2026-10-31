# damon-chat-desk

Damon core의 첫 서피스. 데몬의 단일 API 위에 얹는, 얇은 채팅 클라이언트.

그냥 채팅 UI가 아니다. 프로바이더 라우팅이 눈에 보이는, Damon이라서 되는 채팅 데스크.

## 구조

```
[damon-chat-desk]  정적 SPA (GitHub Pages)
        |
  단일 API (localhost:PORT/v1/*)   ← OpenAI 호환 스키마
        |
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

## MVP

- [ ] Step 1: 데몬 최소 API — `/v1/models` + `/v1/chat/completions` 스트리밍 (damon-agent-core Phase 1)
- [ ] Step 2: 채팅 UI 1판 — 스트리밍 렌더, 모델 드롭다운, 대화 목록(데몬 저장)
- [ ] Step 3: 비교 모드 + 메모리 토글

## 스택

- Vite + React (쉼표 스택 재활용)
- 다크 터미널 미학 (JetBrains Mono, 고밀도 데이터 뷰)
- GitHub Pages 서빙 (MVP 릴리즈 시 배포 예정)

## 게이트 확정 (이 레포가 증명하는 것)

- Damon 첫 서피스 = 웹 (이 레포)
- provider 층위 = LLM API 수준 (채팅은 harness 없이 순수 LLM API)
