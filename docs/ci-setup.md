# 테스트 CI (`.github/workflows/ci.yml`)

이 리포는 `main`에 푸시될 때 [`deploy.yml`](../.github/workflows/deploy.yml)이 테스트·빌드·배포를
한 번에 돌린다. 그래서 "깨진 채로 머지"는 막히지만, **PR 단계에서는 아무것도 돌지 않는다** —
머지하고 나서야 빨간불을 본다.

`docs/ci.workflow.yml`은 그 빈칸을 채우는 워크플로다. PR마다 타입체크·테스트·빌드를 돌리고,
Pages base(`/damon-chat-desk/`)로 한 번 더 빌드해 배포에서만 터지는 asset 경로 문제까지 미리 잡는다.

## 왜 `.github/workflows/`에 바로 없나

이 리포에 푸시하는 주체(개발용 GitHub App)에는 `workflows` 스코프가 없다. `.github/workflows/`
아래 파일을 만드는 푸시는 GitHub이 거부한다(`refusing to allow a GitHub App to create or update
workflow`). 그래서 원본은 `docs/ci.workflow.yml`에 두고, 아래 방법 중 하나로 한 번 옮긴다.
한 번 옮겨 두면 그 뒤로는 GitHub 웹 에디터나 workflows 스코프가 있는 계정으로 고칠 수 있다.

## 옮기는 방법

**1) 웹 에디터 (가장 간단)**

1. <https://github.com/developjik/damon-chat-desk/new/main/.github/workflows> 로 이동한다.
2. 파일 이름 `ci.yml`, 내용은 `docs/ci.workflow.yml`을 그대로 복사해 붙여넣는다.
3. `Commit changes` → `main`에 커밋한다.

**2) `workflows` 스코프가 있는 토큰으로 한 번 올리기**

```bash
# GITHUB_TOKEN 은 workflows:write 스코프를 가진 classic PAT 또는 fine-grained PAT
mkdir -p .github/workflows
cp docs/ci.workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: PR 타입체크·테스트·빌드 워크플로 추가"
git push        # 이 푸시는 workflows 스코프가 있는 자격증명이어야 통과한다
```

옮긴 뒤에는 `docs/ci.workflow.yml`을 지워도 되고, 참고용 사본으로 남겨도 된다
(`docs/deploy.workflow.yml`이 같은 방식의 사본이다).

## 워크플로가 하는 일

| 단계 | 명령 | 보는 것 |
| --- | --- | --- |
| Install | `npm ci` | lockfile 그대로 설치(로컬과 같은 트리) |
| Typecheck | `npx tsc --noEmit` | 앱·테스트의 타입 (strict) |
| Test | `npm test` | vitest — SSE/JSON-RPC 파서, 데모 시뮬레이터, 인스펙터 렌더·델타 그룹핑, 시나리오 |
| Build | `npm run build` | 기본 base(`/`) 프로덕션 빌드 |
| Build (Pages base) | `VITE_BASE_PATH=/damon-chat-desk/ npm run build` | 프로젝트 페이지 asset 경로 |

트리거는 `push`(main) · `pull_request` · `workflow_dispatch`이고, 같은 브랜치에서 새 커밋이 오면
이전 실행은 취소된다(`concurrency.cancel-in-progress`). Node는 워크플로에서 **22**, `npm ci`를 쓰므로
`package-lock.json`이 바뀐 PR은 lockfile도 함께 커밋해야 한다.

## 로컬에서 같은 검사

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
VITE_BASE_PATH=/damon-chat-desk/ npm run build
```

## 참고

- `deploy.yml`은 지금 Node 20으로 돈다. ci.yml은 22를 쓴다 — 둘을 같은 버전으로 맞추고 싶으면
  `deploy.yml`의 `node-version`만 고치면 된다(이 파일은 그 경로를 건드리지 않는다).
- 배포 워크플로 사본(`docs/deploy.workflow.yml`)과 같은 이유로, 이 리포에서 워크플로 파일은
  코드 PR과 분리해 다루는 편이 안전하다.
