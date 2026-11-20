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

## 하위 호환

- `supported[]`가 없는 데몬(0.8.0 이하): 협상 요청을 보내지 않고, `capabilities`를 전부 `false`로 읽는다. 연결 카드는 `0/6 capabilities`라고 적고, 카드에 유실 고지를 못 붙인다는 사실을 숨기지 않는다.
- `idempotencyKey`는 모르는 파라미터라 구버전 데몬이 무시한다 → 키 없이 보낸 것과 같다.
- `replay: true` 프레임은 렌더하지 않는다. 이건 v2 이전에도 오던 프레임이라, 재구독 시 이력이 두 번 그려지던 경로가 함께 정리됐다.
- 데모/OpenAI 전송 계층은 이 계층을 타지 않는다. `connection.protocol`은 `daemon`일 때만 채워진다.

## 의도적으로 하지 않은 것

- **턴 원장(`turnLedger`) 직접 읽기**: 원장은 데몬이 부팅 때 `interrupted`로 수렴시키고 트랜스크립트에 `error` 행을 남긴다. 데스크는 그 행을 `session.messages`로 이미 받으므로 별도 verb가 없다.
- **`session.restart` 자동 호출**: `-32001`은 resume으로 회복된다. restart는 진행 중인 턴을 죽이는 동작이라 자동화하지 않는다.
- **감시 중인 세션의 실시간 렌더**: `session.watch`는 커서 기준점을 얻는 데만 쓴다. 다른 서피스의 턴을 이 화면에 그리는 일은 별도 작업이다.
