# 테스트 CI (`.github/workflows/ci.yml`)

이 리포에는 워크플로가 둘 있다.

| 파일 | 언제 | 하는 일 |
| --- | --- | --- |
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | `pull_request` · `push`(main) · `workflow_dispatch` | 타입체크·테스트·빌드 — 머지 전에 빨간불을 본다 |
| [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | `push`(main) · `workflow_dispatch` | 같은 검사를 돌린 뒤 GitHub Pages로 배포 |

`ci.yml`은 PR마다 타입체크·테스트·빌드를 돌리고, Pages base(`/damon-chat-desk/`)로 한 번 더 빌드해
배포에서만 터지는 asset 경로 문제까지 미리 잡는다. `main`에 머지되면 `deploy.yml`이 같은 검사를 다시
돌리므로, PR이 초록불일 때 머지하면 배포에서 처음 깨지는 일이 없다.

## 파일 위치와 사본

실제로 도는 파일은 `.github/workflows/ci.yml`이다. 같은 워크플로를 옮겨 둔 [`ci.workflow.yml`](ci.workflow.yml)은
문서에서 바로 읽어 보라고 둔 사본이며 복사해서 쓰는 파일이 아니다 — 고칠 때는 두 파일을 같이 고친다
(`deploy.yml`과 [`deploy.workflow.yml`](deploy.workflow.yml)이 같은 관계다).

`.github/workflows/` 아래 파일을 만드는 푸시는 푸시 주체에 `workflows` 스코프가 없으면 GitHub이 거부한다
(`refusing to allow a GitHub App to create or update workflow …`). 이 리포의 두 워크플로도 그래서 **웹
에디터로 한 번 올렸고**, 이후 수정은 웹 에디터나 `workflows` 스코프가 있는 자격증명으로 한다. 코드 PR에
워크플로 변경을 섞으면 그 PR의 푸시 자체가 거부되므로, 워크플로는 코드 PR과 분리해 다룬다.

## 워크플로가 하는 일

| 단계 | 명령 | 보는 것 |
| --- | --- | --- |
| Install | `npm ci` | lockfile 그대로 설치(로컬과 같은 트리) |
| Typecheck | `npx tsc --noEmit` | 앱·테스트의 타입 (strict) |
| Test | `npm test` | vitest — SSE/JSON-RPC 파서, 데모 시뮬레이터, 인스펙터 렌더·델타 그룹핑, 시나리오 |
| Build | `npm run build` | 기본 base(`/`) 프로덕션 빌드 |
| Build (Pages base) | `VITE_BASE_PATH=/damon-chat-desk/ npm run build` | 프로젝트 페이지 asset 경로 |

트리거는 `push`(main) · `pull_request` · `workflow_dispatch`이고, 같은 브랜치에서 새 커밋이 오면
이전 실행은 취소된다(`concurrency.cancel-in-progress`). 두 워크플로 모두 Node **22**를 쓰고,
`npm ci`를 쓰므로 `package-lock.json`이 바뀐 PR은 lockfile도 함께 커밋해야 한다.

## 로컬에서 같은 검사

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
VITE_BASE_PATH=/damon-chat-desk/ npm run build
```

## 액션 버전

모든 액션은 Node 24 런타임을 쓰는 메이저로 고정돼 있다 — CI 로그의 `Node.js 20 is deprecated`
경고(2025-09 공지)를 없애기 위해서다.

| 액션 | 버전 |
| --- | --- |
| [`actions/checkout`](https://github.com/actions/checkout) | `v7` |
| [`actions/setup-node`](https://github.com/actions/setup-node) | `v7` |
| [`actions/configure-pages`](https://github.com/actions/configure-pages) | `v6` |
| [`actions/upload-pages-artifact`](https://github.com/actions/upload-pages-artifact) | `v5` (내부 `upload-artifact` v7) |
| [`actions/deploy-pages`](https://github.com/actions/deploy-pages) | `v5` |

## 참고

- 워크플로 파일은 `.github/workflows/`와 `docs/` 사본 두 곳을 항상 같이 고친다. 이 리포에서
  워크플로 수정은 웹 에디터(또는 `workflows` 스코프가 있는 자격증명)로 한다.
