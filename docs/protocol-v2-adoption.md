# 프로토콜 v2 계약 채택

`damon-agent-core` PR [#49](https://github.com/developjik/damon-agent-core/pull/49)가 머지한 프로토콜 v2 개선사항을 이 클라이언트가 실제로 **소비**하는 방식. 계약의 원본은
[`docs/protocol-v2.md`](https://github.com/developjik/damon-agent-core/blob/main/docs/protocol-v2.md)이고, 이 문서는 "그래서 데스크가 무엇을 하고, 어디까지 믿는가"만 적는다.

전부 additive다. 이 데스크는 프로토콜 번호를 2 그대로 두고, 기능은 `hello.capabilities`로만 판단한다 — 데몬이 어떤 키를 안 보내면 그 약속은 없는 것으로 읽는다(`capabilitiesOf`).

| 계약 | 데몬이 보내는 것 | 데스크가 하는 일 | 코드 |
| --- | --- | --- | --- |
| 버전 협상 | `hello.minProtocol` · `supported[]` · `capabilities` | `supported[]`가 오면 `hello`를 **요청**으로 한 번 더 보내 `{protocolVersion: 2, client}`를 확인한다. `-32012`면 `data.supported[]`를 담아 연결을 거부하고, 그 데몬이 말하는 버전을 화면에 남긴다. `-32601`(요청 형식이 없는 구버전)이면 push hello로 진행한다. `supported[]`가 아예 없으면 요청 자체를 보내지 않는다 — 구버전 경로는 바이트 그대로다. | `rpc.ts` `connect` · `daemon.ts` `protocol` |
| 이벤트 커서 | `session.event.seq` — 세션 스코프 단조 증가 | `DeliveryTracker`가 프레임마다 `seq`를 접어 **끊긴 번호를 직접 센다**. 데몬의 고지가 유실돼도 구멍이 드러난다. | `delivery.ts` |
| 재동기화 트리거 | `session.snapshot_required {cursor, reason}` | `snapshot_required` 스트림 이벤트로 올리고, 턴이 끝난 뒤 `session.messages`를 다시 읽어 **저장본이 더 길 때만** 본문을 채운다. 카드에는 `resynced`/`stale`로 표시. 저장본이 아직 짧으면 화면의 글자를 지우지 않고 "일부가 빠졌을 수 있습니다"로 남긴다. | `desk.ts` `resyncSlot` |
| 드롭 경고 | `session.gap {dropped, cursor}` | `gap` 이벤트로 올려 카드 헤더 아래에 `이 연결이 놓친 이벤트 N개 (session.gap)`를 남긴다. `admit()`이 cursor를 흡수해 다음 프레임을 두 번 세지 않는다. | `delivery.ts` · `Transcript.tsx` |
| 커서 기준점 | `session.create` · `resume` · `watch` · `restart` 응답의 `cursor` | 세션별로 기억해 다음 `turn.start`의 `baseline`으로 넘긴다. 대화를 다시 열 때는 `session.watch`로 그 세션의 현재 cursor를 받아 둔다. | `desk.ts` `sessionCursors` · `watchSession` |
| 멱등 턴 | `turn.start` · `turn.steer`의 `idempotencyKey`, 응답의 `{duplicate, inProgress}` | 슬롯마다 턴 키를 하나 두고, **전송 실패로 끝난 재시도는 같은 키**를 다시 쓴다(데몬이 그 시도를 재생). `turnId`가 이미 온 턴의 재시도는 새 키를 발급한다("다시 실행"). `{duplicate, inProgress}`면 새 턴을 만들지 않고 **그 턴의 스트림을 계속 읽는다**. | `desk.ts` `eventsFor`·`retrySlot` · `daemon.ts` `streamTurn` |
| 죽은 세션 복구 | `-32001` (session not live) | `session.resume` 후 **같은 키로 한 번 더** `turn.start`. 데몬이 키를 기억하면 재생, 아니면 한 번만 실행된다. 무한 루프는 없다(1회). | `daemon.ts` `streamTurn` |
| 스티어 재전송 | `turn.steer`의 `idempotencyKey` | ack를 잃은 스티어는 같은 키로 1회 재전송한다. 재전송이 `-32006`이면 "그 배달이 아직 진행 중"이므로 배달된 것으로 본다. | `desk.ts` `steerOnce` |
| 세션 상태 | `session.status`의 `phase` · `turnId?` · `pendingAsk?`, 응답의 `recovered[]`, `hello.capabilities.sessionPhase` | 사이드바 행과 헤더에 `busy` / `waiting`(+ ask kind·label) 칩을 붙이고, 이전 데몬이 턴 도중 남긴 세션은 상단 배너로 알린다. `session.resume`이 성공하면 그 표시를 즉시 지운다. 자세히: [세션 상태](#세션-상태-sessionstatus) | `phases.ts` · `desk.ts` `refreshSessionStatus` · `SessionPhase.tsx` |

## 세션 상태 (`session.status`)

데몬은 "지금 어떤 세션이 무엇을 하고 있는지"를 `session.status`로 답한다
(`damon-agent-core` PR [#50](https://github.com/developjik/damon-agent-core/pull/50)). 와이어에서 읽는 것은 셋이다.

| 필드 | 의미 | 데스크가 하는 일 |
| --- | --- | --- |
| `phase` (`idle` \| `busy` \| `awaiting_input`) | 세션의 현재 단계. `awaiting_input`은 턴이 사용자의 답에 멈춰 있다는 뜻이고, 그때도 `busy`는 `true`다(회수 대상이 아니다) | 행 칩: `busy` / `waiting`. `idle`은 칩을 그리지 않는다 — 조용한 세션이 기본값이고, 전부 `idle`인 목록은 소음이다 |
| `pendingAsk?` `{requestId, kind, label?, askedAtMs}` | 멈춰 있는 턴이 기다리는 요청. `label`은 툴 이름이거나 ask 제목이고 **없을 수도 있다** | `waiting · plan` + 라벨. 좁은 사이드바 행은 라벨을 줄이고(`compact`) `title`에 전문을 남기며, 헤더는 라벨까지 보여준다 |
| `turnId?` | 백엔드가 보고한 턴 id. **클레임 직후에는 비어 있다** | 없으면 없는 대로 둔다. 빈 문자열·`null`을 `turnId`로 만들지 않는다 |
| `recovered[]` `{sessionId, backend, phase, sinceMs, turnId?}` | 이전 데몬이 턴 도중/답 대기 중에 죽어 남긴 세션. 부팅이 `idle`로 수렴시키면서 이 표시를 붙인다 | 본문 위 앰버 배너: 세션 id·백엔드·"턴 실행 중이던 · 9분 전"·`이어받기`(`session.resume`). resume·prune으로 사라진다 |

**왜 이벤트가 아니라 폴링인가.** 위상 변화에는 `session.event`가 없다 — 다른 연결이 시작한 턴,
권한 대기, 회수된 세션은 어느 프레임에도 실리지 않는다. 그래서 데몬 연결 중에는
`session.status`를 4초(`STATUS_POLL_MS`)마다 다시 읽고, 턴 시작·종료·중단·승인 응답·resume
같은"이 방금 바꿨다" 지점에서는 즉시 한 번 더 읽는다(`refreshStatusSoon`). 폴링은
`unref()`로 프로세스를 붙잡지 않고, 데모/OpenAI로 전환하면 타이머와 원장을 함께 비운다.

**두 출처의 우선순위.** 같은 세션을 데몬 원장과 이 탭의 스트림이 모두 말할 때는
*이 탭이 실제로 돌리는 세션*에 한해 스트림이 이긴다(폴링은 최대 한 주기 늦다).
반대로 이 탭의 `idle`이 데몬의 `busy`를 덮지는 않는다 — 다른 서피스가 돌리는 턴을
숨기면 안 되기 때문이다(`mergeSessionPhases`). 로컬 위상은 `busy`/`awaiting_input`만
행으로 올리고 `idle`은 올리지 않는다.

**하위 호환.** `capabilities.sessionPhase`가 없는 데몬에는 `session.status`를 **보내지 않는다**.
그래도 목록은 이 탭이 스트리밍 중인 세션(`source: 'local'`)만큼은 칩을 그린다 —
대화 슬롯이 이미 알고 있는 사실이라 추가 호출이 없다. 기능을 알리는데 `-32601`을
답하는 어중간한 업그레이드는 "미지원"으로 읽고 상태 줄을 깨지 않는다.

## 하위 호환

- `supported[]`가 없는 데몬(0.8.0 이하): 협상 요청을 보내지 않고, `capabilities`를 전부 `false`로 읽는다. 연결 카드는 `0/7 capabilities`라고 적고, 카드에 유실 고지를 못 붙인다는 사실을 숨기지 않는다.
- `idempotencyKey`는 모르는 파라미터라 구버전 데몬이 무시한다 → 키 없이 보낸 것과 같다.
- `replay: true` 프레임은 렌더하지 않는다. 이건 v2 이전에도 오던 프레임이라, 재구독 시 이력이 두 번 그려지던 경로가 함께 정리됐다.
- 데모/OpenAI 전송 계층은 이 계층을 타지 않는다. `connection.protocol`은 `daemon`일 때만 채워진다.

## 의도적으로 하지 않은 것

- **턴 원장(`turnLedger`) 직접 읽기**: 원장은 데몬이 부팅 때 `interrupted`로 수렴시키고 트랜스크립트에 `error` 행을 남긴다. 데스크는 그 행을 `session.messages`로 이미 받으므로 별도 verb가 없다.
- **`session.restart` 자동 호출**: `-32001`은 resume으로 회복된다. restart는 진행 중인 턴을 죽이는 동작이라 자동화하지 않는다.
- **감시 중인 세션의 실시간 렌더**: `session.watch`는 커서 기준점을 얻는 데만 쓴다. 다른 서피스의 턴을 이 화면에 그리는 일은 별도 작업이다.
- **위상 변화의 낙관적 갱신**: 남의 세션이 `busy`가 된 것을 이벤트로 추정하지 않는다. 폴링이 답할 때까지는 마지막으로 들은 사실을 그대로 보여준다.
