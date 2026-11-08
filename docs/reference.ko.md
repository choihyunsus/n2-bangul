[쉬운 시작 안내로 돌아가기](../README.ko.md)

# N2 Bangul · 방울

AI 텍스트 작업을 예약 실행하고, 결과와 전달 기록을 Soul 공통 DB에 보관하는 모듈입니다.

[English documentation](reference.md)

방울은 지정 시각, 일정 간격, cron 표현식에 따라 모델에 텍스트 요청을 보냅니다. 연결하는 앱이 모델 제공자, 작업 정책과 전달 대상을 등록합니다. 실행 결과·이력·다음 예약 시각을 함께 저장하고, 각 전달 채널은 별도의 처리 기록으로 관리합니다.

## 설치

Node.js 22 이상이 필요합니다. 이 버전은 GitHub Releases로 배포합니다.

```sh
npm install https://github.com/choihyunsus/n2-bangul/releases/download/v1.0.0/n2-bangul-1.0.0.tgz
```

Gumiho 1.0.1과 Mimir 3.0.3은 공개 GitHub 배포 파일에 고정되어 있습니다. SQLite는 `better-sqlite3`를 사용하며, 호환되는 Mimir Rust 바인딩도 지원합니다. 플랫폼에 따라 SQLite 네이티브 빌드 도구가 필요할 수 있습니다.

## 라이브러리 사용

```js
import { Bangul, ollamaChat } from 'n2-bangul';

const scheduler = new Bangul({
  dbPath: './data/mimir.db',
  project: 'personal-assistant',
  agent: 'scheduler',
  provider: ollamaChat({ id: 'local', model: process.env.N2_MODEL }),
});

try {
  const job = scheduler.create(
    {
      name: '하루 계획 질문',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      time_zone: 'Asia/Seoul',
      user_message: '하루 계획을 세우는 데 도움이 되는 짧은 질문 하나를 작성하세요.',
      max_output_tokens: 128,
    },
    'daily-note',
  );

  const result = await scheduler.trigger(job.id, 'manual-preview-001');
  console.log(result.status, result.content);
} finally {
  await scheduler.close();
}
```

이 예시는 예약을 등록한 뒤 즉시 수동 요청 한 번을 실행합니다. 실행 중인 앱에서 `start()`를 호출하거나 CLI의 `run` 명령을 사용하면 예약 타이머가 동작합니다. 인스턴스를 생성한 직후 타이머는 정지 상태이며, 예약 실행을 시작하려면 모델 제공자가 등록되어 있어야 합니다. 예제 실행 전 `N2_MODEL`에 설치된 Ollama 모델 이름을 지정합니다.

제공자는 구미호의 `ModelProvider` 인터페이스를 구현합니다. `openAIResponses`, `anthropicMessages`, `geminiInteractions`, `ollamaChat`, `openAICompatible` 팩토리도 함께 내보냅니다. 기본 제공자는 `provider`로 지정하고, 추가 `providers`는 작업의 `provider_id`로 선택합니다. 인증 정보는 호스트의 함수 클로저나 환경변수에서 관리합니다.

예약 요청의 도구 목록은 비어 있습니다. `tools_json`은 `null` 또는 `[]`를 받습니다. 모델의 도구 호출, 미완료 응답과 잘못된 텍스트는 오류로 기록합니다. 정상 완료된 빈 문자열은 유효한 결과입니다. 모델의 요청 거절과 호스트 정책 차단은 `blocked` 상태로 기록합니다.

## 예약 방식

| 항목                      | 의미                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `at`                      | 오프셋이 포함된 미래 RFC3339 시각, 또는 `time_zone`에서 모호하지 않은 현지 시각 |
| `every`                   | 완료 시점부터 1~31,536,000초 간격                                               |
| `cron`                    | Croner 11의 5·6·7개 필드 표현식, 별칭과 선택적 연도                             |
| `time_zone`               | 작업을 만들 때 확정하여 저장하는 IANA 시간대                                    |
| `retry_max`               | 오류 발생 시 추가 재시도 횟수, 기본 3, 범위 0~10                                |
| `retry_backoff_base_secs` | 지수형 재시도 대기시간의 기준, 기본 30초, 최대 대기 3,600초                     |

실행 시각은 UTC 밀리초로 저장합니다. 서머타임으로 존재하지 않거나 두 번 나타나는 현지 `at` 시각은 오프셋을 명시해야 합니다. cron은 Croner의 전환 규칙을 따릅니다. 고정 시각 표현식은 반복 시각의 첫 번째를 선택하고, 사라진 시각은 그날 처음 유효한 시각으로 이동합니다. 간격 표현식은 반복 구간의 두 시각을 모두 선택할 수 있으며 사라진 구간을 건너뜁니다.

일회성 작업과 마지막 실행이 끝난 유한 cron 작업은 결과 저장 후 비활성화됩니다. 완료된 일회성 작업을 다시 예약하려면 미래 시각으로 정의를 수정합니다. 시작 시 밀린 작업은 최대 5개까지 순서대로 처리하며, 기본 간격은 5초입니다. 이후 일반 주기 확인으로 전환합니다. 밀린 작업 하나는 한 번의 배정에서 요청 하나를 만듭니다.

`configure()`는 해당 프로젝트·에이전트 범위의 설정 전체를 교체합니다.

| 설정                  | 기본값 | 범위     |
| --------------------- | ------ | -------- |
| `max_concurrent_jobs` | 3      | 1~8      |
| `tick_interval_secs`  | 15     | 1~3,600  |
| `job_timeout_secs`    | 300    | 1~3,600  |
| `catchup_stagger_ms`  | 5,000  | 0~60,000 |

수동 실행, 시작 시 밀린 작업 처리, 일반 예약 실행은 같은 DB 동시 실행 한도를 사용합니다. 작업마다 실행 중이거나 결과를 확인해야 하는 요청 하나를 유지합니다. 타이머 소유권도 프로젝트·에이전트 범위로 관리합니다. 소유권은 프로세스 ID와 임의 식별자를 포함하며 30초 동안 유효하고 10초마다 갱신합니다. 이 방식은 한 컴퓨터의 여러 프로세스가 같은 로컬 DB를 사용하는 환경을 전제로 합니다.

## API와 복구

| 메서드                                                     | 기능                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `create(input, id?)`, `get(id)`, `list(limit?, offset?)`   | 작업 등록과 조회                                         |
| `update(id, input, expectedRevision)`                      | 현재 버전을 확인하고 정의 교체                           |
| `setEnabled(id, enabled)`, `remove(id, expectedRevision)`  | 예약 활성화·일시정지 또는 논리적 삭제                    |
| `trigger(jobId, runId?)`                                   | 현재 인스턴스의 실행과 전달 시도 완료까지 대기           |
| `submit(jobId, runId?)`                                    | 시작 기록을 저장한 뒤 실행 ID를 즉시 반환                |
| `start()`, `stop()`, `tick()`                              | 타이머 제어 또는 현재 기한이 된 작업 배정                |
| `history(limit?, offset?, jobId?)`, `getRun(id)`           | 영속 실행 이력 조회                                      |
| `getDeliveries(id)`, `deliver(id)`                         | 전달 기록 조회와 대기 중인 채널 처리                     |
| `recover()`, `reconcileRun(id, outcome, evidence)`         | 중단된 소유권 복구와 불명확한 결과 확정                  |
| `resolveDelivery(id, channel, action, evidence)`           | 확인 근거에 따라 전달을 `retry`, `sent`, `skip`으로 처리 |
| `settings()`, `configure(settings)`, `status()`, `close()` | 설정과 인스턴스 관리                                     |

고정 작업 ID에 같은 정의로 생성 요청을 반복하면 기존 작업을 반환합니다. 고정 실행 ID는 해당 작업과 실행 방식의 과거 결과를 가리킵니다. 작업을 수정한 뒤 새로 실행할 때도 새로운 실행 ID를 사용합니다. 완료된 실행 ID를 다시 요청하면 저장된 결과가 반환되며, 대기 중인 전달은 `deliver()`로 명시적으로 처리합니다.

인스턴스를 열면 만료되었거나 종료된 소유권을 복구합니다. 중단된 모델 요청은 `unknown`으로 기록하고 작업을 일시정지합니다. 외부 요청의 실제 결과를 확인한 뒤 결과와 근거를 `reconcileRun()`에 전달합니다. 같은 확정 요청의 반복은 저장된 결과를 반환합니다. 작업의 재활성화는 별도로 지정합니다.

실행 중인 요청은 처음 저장한 작업·제공자·정책 정의를 사용합니다. 완료 시 정의 버전이 여전히 같을 때 다음 예약 상태를 갱신합니다. 일시정지는 이후 자동 배정에 적용합니다. 작업 삭제는 진행 중인 요청을 취소하고 대기 중인 전달을 건너뛰게 합니다. `stop()`은 이후 타이머 배정을 중단하고 이미 시작한 밀린 작업 처리를 기다립니다. `close()`는 자신이 소유한 실행을 취소하고 기록 저장을 기다립니다.

제한시간과 취소는 `AbortSignal`로 전달하고, 늦게 도착한 콜백 결과는 버립니다. 취소를 무시하는 콜백은 호스트 프로세스에서 계속 실행될 수 있습니다. 강제 종료가 필요한 콜백은 호스트가 소유한 별도 작업 프로세스에 격리해야 합니다. 실패한 요청도 제공자 토큰을 소비했을 수 있으므로 재시도 설정과 과금 정책을 함께 고려해야 합니다.

## 전달과 기억 저장

작업의 `delivery.log`, `delivery.broadcast`, 선택적 `delivery.webhook` ID로 전달 방식을 지정합니다. 로그와 방송은 기본적으로 활성화됩니다. 방송 구독자가 등록되지 않은 경우 실시간 알림은 건너뜁니다. 지정한 웹훅은 모델 요청을 시작하기 전에 호스트에 등록되어 있어야 합니다.

기억 로그는 같은 트랜잭션 안에서 Mimir 경험 하나와 전달 완료 기록을 저장합니다. JSON에는 요청, 응답, 제공자, 결과 해시와 `verified: false`가 포함됩니다. 생성된 텍스트는 검증 전 모델 응답으로 보관합니다. 로그 저장 실패는 전달 단계에서 별도로 재시도할 수 있습니다.

사용자 정의 전달 대상은 `{ id, version, send(event, context) }` 형식입니다. 취소 신호와 고정 멱등성 키를 받습니다. 완료 응답을 받지 못하면 전달 상태를 `unknown`으로 기록합니다. 수신 측을 확인하고 근거를 남긴 뒤 상태를 확정합니다. 네트워크 결과가 모호한 상황의 중복 억제는 수신 측 멱등성 처리에 달려 있습니다. 대상 버전은 실행 시점의 저장된 정의와 대조합니다.

`httpWebhook({ id, version, url, headers? })`는 고정 HTTPS 목적지를 등록합니다. 로컬 연결에는 루프백 HTTP를 지원합니다. URL 인증 정보, 프래그먼트, 리디렉션, 헤더 주입과 관리 대상 헤더의 덮어쓰기를 차단합니다. 목적지와 인증 헤더는 운영자가 관리하며, 연결 앱이 대상 신뢰와 네트워크 접근 정책을 책임집니다. 외부 전달 한 번의 제한시간은 10초입니다.

## CLI와 MCP

```sh
n2-bangul create --db ./data/mimir.db --project demo --agent scheduler --id daily-note < examples/daily-note.json
n2-bangul trigger --db ./data/mimir.db --project demo --agent scheduler --id daily-note --run-id preview-001 --adapter ./examples/ollama-host.cjs
n2-bangul run --db ./data/mimir.db --project demo --agent scheduler --adapter ./examples/ollama-host.cjs
n2-bangul mcp --db ./data/mimir.db --project demo --agent scheduler --adapter ./examples/ollama-host.cjs
```

위 셸 예시는 표준입력 리디렉션을 사용합니다. 설정 명령은 `--input` JSON도 받습니다. 예제 어댑터 사용 전 `N2_MODEL`에 설치된 Ollama 모델 이름을 지정합니다. `N2_OLLAMA_URL`을 지정할 때는 `/api/chat`을 포함한 전체 API 주소를 사용합니다. `.cjs`, `.mjs`, `.js` 어댑터는 모델 제공자, 정책, 전달 대상과 선택적 설정을 내보냅니다. 어댑터를 불러오면 운영자가 선택한 JavaScript가 호스트 권한으로 실행됩니다.

전체 명령은 `n2-bangul --help`에서 확인합니다. CLI `trigger` 종료 코드는 성공 0, 비성공 결과 2, 명령·저장 오류 1입니다. MCP는 작업 관리, 예약, 제한된 결과 읽기와 명시적 복구를 위한 도구 16개를 제공합니다. `bangul_trigger`는 시작 기록을 저장한 뒤 즉시 응답하며, 결과는 `bangul_history`와 `bangul_read`에서 확인합니다. MCP 초기화 후 `bangul_start`를 호출하면 타이머가 시작됩니다.

## Soul DB와 실행 한도

`dbPath`에는 Soul·Mimir가 사용하는 SQLite 파일을 지정합니다. 공통 기억 테이블은 Mimir 3.0.3의 필드 계약을 따릅니다. 추가 테이블은 `bangul_settings`, `bangul_jobs`, `bangul_history`, `bangul_deliveries`, `bangul_leases`이며 `meta.bangul_schema_version = 1`로 관리합니다. 모든 모듈 행은 `project`와 `agent`에 속합니다. 원래 대붕이의 버전 없는 방울 테이블을 사용할 때는 명시적 이전 절차가 필요합니다.

범위당 현재 작업은 최대 1,024개, 등록 제공자 16개, 웹훅 대상 32개, 동시 전달 시도 16개, 한 인스턴스가 보유하는 실행 작업 16개입니다. 요청·시스템 지침·결과는 각각 최대 64·32·128 KiB의 유효한 UTF-8 텍스트를 받습니다. 목록과 이력은 페이지당 최대 100개입니다. MCP 응답은 60,000바이트로 제한하며 텍스트 미리보기나 결과 조각을 제공합니다.

전체 실행 이력과 결과는 운영자가 보관 정리를 할 때까지 DB에 남습니다. `close()`는 활성 자원을 해제하고 기록은 다시 열어 사용할 수 있게 보관합니다. API 인증 정보는 호스트 클로저에서 관리하며, 작업 프롬프트와 모델 출력은 보관 대상 데이터입니다.

## 검증과 라이선스

```sh
npm ci
npm test
npm run typecheck
npm audit --omit=dev
```

테스트는 실제 타이머, CLI, stdio MCP, 상태를 가진 클래스 콜백, 두 인스턴스의 소유권, 종료된 자식 프로세스의 복구, 늦은 트랜잭션 실패, 멱등 재실행, 웹훅, UTF-8 한도와 서머타임 전환을 확인합니다. CI는 Windows·Linux·macOS 소스 검증 후 배포 파일 하나를 만들고, 그 파일을 세 운영체제에 설치하여 기능과 엄격한 TypeScript 소비자 검사를 수행하도록 구성되어 있습니다.

제공자 프로토콜 검증은 결정적인 호스트 어댑터와 로컬 HTTP 테스트 서버를 사용합니다. 이 검증은 실행 계약을 확인합니다. 모델 품질, 클라우드 인증과 전달 목적지의 가용성은 실제 사용 환경에서 별도로 확인해야 합니다.

방울 소스는 MIT입니다. Mimir와 간접 의존성 Clotho에는 기존 비상업·상업용 라이선스 조건이 적용됩니다. 함께 배포할 때는 `LICENSE-N2-MIMIR`, `LICENSE-N2-CLOTHO`, `LICENSE-APACHE`, `THIRD-PARTY-NOTICES`를 확인합니다.
